/**
 * The Channel Audit orchestrator.
 *
 *   ingest → propose the market → [PAUSE for approval] → scan → analyse →
 *   rename → report
 *
 * The pause is the important part of the design. Everything after it is
 * expensive — competitor catalogues cost quota, thumbnails cost vision calls,
 * renames cost director-tier tokens — and all of it is worthless if the market
 * was misidentified. The cheapest moment to catch "these aren't my competitors"
 * is before the scan, not in the finished report.
 *
 * A run that fails partway still keeps everything it had computed. An audit is
 * a day's quota; losing the ingest because the report call timed out would be
 * an unkind way to spend it.
 */
import { nanoid } from "nanoid";
import { ingestChannel, ingestCompetitors, ChannelNotFoundError } from "./ingest.js";
import { discoverCompetitors } from "./discover.js";
import { fetchPaidViews, ytAnalyticsConnected } from "./analytics.js";
import { gatherContent, readContent, summariseContent, transcriptsAvailable } from "./content.js";
import { getMarket } from "../db/auditMarkets.js";
import { fetchThumbnails } from "./images.js";
import { proposeMarket, pickCompetitors, readThumbnails, clusterTopics, proposeRenames, writeReport, writeActionPlan, confirmMarketFit, THUMBNAIL_BATCH } from "./ai.js";
import { addGap, gapFor, inferFailedStage, isFatal, rankMarketFallbacks, skipPlan, withoutSubject, STAGE_META } from "./recovery.js";
import { listMarkets } from "../db/auditMarkets.js";
import {
  titleFeatures,
  titlePatternPerformance,
  marketTitlePatterns,
  outlierThumbnailProfile,
  titleStructureCorrelations,
  thumbnailCorrelations,
  splitWinnersLosers,
  renamePriority,
  marketRanks,
  evidencePool,
} from "./analysis.js";
import { ageCurve, outliers } from "./baseline.js";
import { createRun, updateRun, getRun } from "../db/auditRuns.js";
import {
  withUsageScope,
  currentUsageScope,
  totalCost,
  costByLabel,
  hasUnpriced,
  type ScopedCall,
  type UsageScope,
} from "../ai/usageScope.js";
import type {
  AuditCallUsage,
  AuditChannel,
  AuditFindings,
  AuditGap,
  AuditInput,
  AuditJobSnapshot,
  AuditStage,
  AuditVideo,
  MarketProposal,
  ThumbnailAttributes,
} from "./types.js";

/** Videos to retitle per director-tier call. */
const RENAME_BATCH = 15;

/** Competitor videos ingested each — enough for outliers without paging forever. */
const COMPETITOR_MAX_VIDEOS = 300;

/** How many videos get their transcript and comments read, per side. */
const CONTENT_MARKET = 30;
const CONTENT_OWN = 10;

const live = new Map<string, AuditJobSnapshot>();

/**
 * A usage scope for one audit, persisting the bill as it grows.
 *
 * Flushing on every call rather than at the end is the point: an audit spends
 * real money across several minutes, and a run that dies in the rename stage
 * should still be able to tell you what the thumbnails cost. A total that only
 * appears on success is exactly the total you don't get when you need it.
 *
 * `seed` carries the calls already on the row, so an approval pause — which ends
 * one async entry point and starts another — continues the same bill instead of
 * restarting it at zero.
 */
function auditScope(runId: string, seed: AuditCallUsage[]): UsageScope {
  const calls: ScopedCall[] = seed.map((c) => ({
    label: c.label,
    model: c.model ?? "unknown",
    input: c.input,
    output: c.output,
    cacheWrite: c.cacheWrite,
    cacheRead: c.cacheRead,
    costUsd: c.costUsd,
    ms: c.ms ?? 0,
    ...(c.unpriced ? { unpriced: true as const } : {}),
  }));
  return {
    calls,
    onCall: (_call, all) => {
      // Never let a bookkeeping write sink a run that is otherwise fine.
      try {
        updateRun(runId, { calls: all, costUsd: totalCost(all) });
      } catch (err: any) {
        console.warn(`[audit] ${runId}: could not persist usage:`, err?.message || err);
      }
    },
  };
}

export function auditJobStatus(runId: string): AuditJobSnapshot | null {
  const l = live.get(runId);
  if (l) return l;
  const run = getRun(runId);
  if (!run) return null;
  return {
    runId,
    status: run.status,
    stage: run.status === "completed" ? "Done" : run.status === "failed" ? "Failed" : "",
    progress: run.status === "completed" ? 1 : 0,
    error: run.error,
  };
}

/**
 * The run's own record of what it could not do.
 *
 * `step` is the whole point: a stage that throws no longer takes the audit with
 * it. It records what failed, what that costs the report (recovery.ts owns the
 * wording), and hands back a fallback so the pipeline carries on. The gap is
 * persisted the moment it happens, for the same reason the bill is — a run that
 * dies later must still be able to say what it had already lost.
 *
 * The ingest is the exception and rethrows: with no catalogue there is nothing
 * for the remaining stages to be about.
 */
function gapRecorder(runId: string, initial: AuditGap[]) {
  let list = initial;
  const persist = () => {
    try {
      updateRun(runId, { gaps: list });
    } catch (err: any) {
      console.warn(`[audit] ${runId}: could not persist gaps:`, err?.message || err);
    }
  };
  return {
    get list(): AuditGap[] {
      return list;
    },
    has(stage: AuditStage): boolean {
      return list.some((g) => g.stage === stage);
    },
    add(stage: AuditStage, reason: string, automatic = true): void {
      list = addGap(list, gapFor(stage, reason, automatic));
      console.warn(`[audit] ${runId}: skipping ${stage} — ${reason}`);
      persist();
    },
    async step<T>(stage: AuditStage, fallback: T, fn: () => Promise<T>): Promise<T> {
      try {
        return await fn();
      } catch (err: any) {
        if (isFatal(stage)) throw err;
        this.add(stage, String(err?.message || err));
        return fallback;
      }
    },
  };
}

type RunGaps = ReturnType<typeof gapRecorder>;

interface RunRestOptions {
  /** Stages not to attempt at all — what the operator pressed Skip on. */
  skip?: AuditStage[];
  /** Thumbnail attributes already on the row: read only what is missing. */
  reuseThumbnails?: boolean;
  /** Proposed titles already on the row — the most expensive tokens in a run. */
  reuseRenames?: boolean;
}

function setStage(runId: string, status: AuditJobSnapshot["status"], stage: string, progress: number) {
  live.set(runId, { runId, status, stage, progress, error: null });
}

/**
 * Bill every Claude call made inside `fn` to this audit's row.
 *
 * For work that happens AFTER a run finishes — the report chat, a refocus, a
 * section the operator asked for later. Those are real spend against the same
 * report, and a bill that stopped at "completed" would understate what the
 * audit cost the moment anyone talked to it.
 */
export function withAuditUsage<T>(runId: string, seed: AuditCallUsage[], fn: () => Promise<T>): Promise<T> {
  return withUsageScope(auditScope(runId, seed), fn);
}

/** Start an audit. Returns immediately; work continues in the background. */
export function startAudit(input: AuditInput): { runId: string } {
  const runId = nanoid();
  createRun(runId, input);
  setStage(runId, "ingesting", "Reading the channel", 0.02);

  // One scope over the WHOLE background job, including the auto-approve path
  // into runRest. Nested scopes would shadow each other and split the bill, so
  // runRest never opens its own — resumeAudit opens the second one, and only
  // because the approval pause genuinely ends this async context.
  void withUsageScope(auditScope(runId, []), async () => {
    try {
      // ── ingest ────────────────────────────────────────────────────────────
      // Paid views, when a channel is connected. Only ever available for the
      // one channel that granted consent, so this is silently absent for every
      // teardown — and the audit then scores on total views and says so.
      let paidByVideo: Map<string, number> | undefined;
      if (input.mode === "own" && ytAnalyticsConnected()) {
        try {
          setStage(runId, "ingesting", "Reading your analytics (paid vs organic)", 0.05);
          const paid = await fetchPaidViews();
          paidByVideo = paid.paidByVideo;
          console.log(`[audit] ${runId}: ${paid.totalPaid.toLocaleString()} advertised views across ${paid.paidByVideo.size} video(s)`);
        } catch (err: any) {
          // A revoked or expired grant must degrade to a normal audit rather
          // than sink it — the report simply notes the split is unavailable.
          console.warn(`[audit] ${runId}: analytics unavailable:`, err?.message || err);
        }
      }

      const { channel, videos, quotaUnits } = await ingestChannel(input.channel, { paidByVideo });
      const withFeatures = videos.map((v) => ({ ...v, titleFeatures: titleFeatures(v.title) }));
      updateRun(runId, { subject: channel, videos: withFeatures, quotaUnits, title: input.title || channel.title });

      // ── a saved market skips discovery entirely ───────────────────────────
      // A market is a named set of competitors, reusable across runs and across
      // channels. Reusing one costs no search quota, needs no approval, and
      // keeps two runs comparable because the comparison set did not move.
      if (input.marketId) {
        const saved = getMarket(input.marketId);
        if (saved) {
          const proposal = {
            niche: saved.niche,
            nicheDescription: saved.nicheDescription ?? "",
            subjectSummary: "",
            audience: saved.audience ?? "",
            competitors: saved.competitors,
          };
          updateRun(runId, { proposal, approved: proposal, status: "scanning" });
          console.log(`[audit] ${runId}: using saved market "${saved.name}" (${saved.competitors.length} competitors)`);
          await runRest(runId, proposal);
          return;
        }
        console.warn(`[audit] ${runId}: saved market ${input.marketId} is gone — discovering instead`);
      }

      // ── propose the market ────────────────────────────────────────────────
      setStage(runId, "proposing", "Working out the market", 0.12);
      updateRun(runId, { status: "proposing" });
      const { market: proposal, searchQueries } = await proposeMarket(channel, withFeatures, input.angle);
      updateRun(runId, { proposal });

      // Find the competitors by SEARCHING YouTube rather than by asking the
      // model to remember them. Asking produced two different sets on two runs
      // of the same channel, six of eight of them fabricated — and a fabricated
      // handle resolves through search to some unrelated 26-subscriber channel,
      // which is worse than nothing because it silently becomes market data.
      //
      // Search is also the ONE call that a daily cap takes away first (it costs
      // 100 units where everything else costs 1), so this is where a run is
      // most likely to die with the whole catalogue already read. It no longer
      // does: a saved market can stand in, and failing that the audit finishes
      // on the channel's own catalogue and says the market is missing.
      try {
        setStage(runId, "proposing", "Searching for who else ranks for this", 0.15);
        const { channels: discovered, quotaUnits: searchUnits } = await discoverCompetitors(searchQueries, channel);
        const picked = await pickCompetitors(channel, proposal.niche, discovered);
        proposal.competitors = picked;
        console.log(
          `[audit] ${runId}: ${searchQueries.length} searches found ${discovered.length} candidates, kept ${picked.length}`,
        );
        updateRun(runId, { proposal, quotaUnits: quotaUnits + searchUnits });
      } catch (err: any) {
        const why = String(err?.message || err);
        console.warn(`[audit] ${runId}: competitor discovery failed:`, why);
        const substitute = await substituteMarket(runId, channel, proposal, why);
        if (!substitute) {
          // No stand-in, so there is nothing for the operator to approve and
          // nothing gained by waiting for them. Finish what does not need a
          // market rather than throwing away an ingested catalogue.
          gapRecorder(runId, getRun(runId)?.gaps ?? []).add("market", `Could not find competitors: ${why}`);
          await runRest(runId, null, { skip: ["market"] });
          return;
        }
        proposal.competitors = substitute.competitors;
        proposal.substitutionNote = substitute.substitutionNote;
        updateRun(runId, { proposal });
      }

      if (!input.autoApprove) {
        // Stop here. resumeAudit() picks it up once the operator has confirmed
        // or edited the competitor set.
        setStage(runId, "awaiting-approval", "Waiting for you to confirm the market", 0.18);
        updateRun(runId, { status: "awaiting-approval" });
        return;
      }
      await runRest(runId, proposal);
    } catch (err: any) {
      fail(runId, err);
    }
  });

  return { runId };
}

/** Continue a paused run with the market the operator actually approved. */
export function resumeAudit(runId: string, approved: MarketProposal): { ok: boolean } {
  const run = getRun(runId);
  if (!run || run.status !== "awaiting-approval") return { ok: false };
  updateRun(runId, { approved, status: "scanning" });
  // Seeded from what the pre-approval half already spent, so the bill continues.
  void withUsageScope(auditScope(runId, run.calls), () => runRest(runId, approved)).catch((err) =>
    fail(runId, err),
  );
  return { ok: true };
}

/**
 * A saved market to stand in for a discovery that could not run.
 *
 * Two gates, and both must pass. Word overlap picks the shortlist, which is
 * arithmetic and cannot be trusted with the decision; the model then judges
 * whether it is genuinely the same market, and is told that refusing is the
 * safe answer. A wrong substitution is the worst outcome available here — every
 * comparison in the report would be against channels playing a different game,
 * stated with exactly the confidence of a real one.
 *
 * The subject is dropped from whatever comes back. The saved market that this
 * path first ran against contained the very channel being audited, which would
 * have scored it against a baseline it was itself inflating.
 */
async function substituteMarket(
  runId: string,
  channel: AuditChannel,
  proposal: MarketProposal,
  why: string,
): Promise<{ competitors: MarketProposal["competitors"]; substitutionNote: string } | null> {
  const ranked = rankMarketFallbacks(`${proposal.niche} ${proposal.nicheDescription}`, listMarkets());
  if (!ranked.length) {
    console.log(`[audit] ${runId}: no saved market is close enough to stand in`);
    return null;
  }
  let chosenId: string | null = null;
  let reason = "";
  try {
    const fit = await confirmMarketFit({
      channel,
      niche: proposal.niche,
      nicheDescription: proposal.nicheDescription,
      subjectSummary: proposal.subjectSummary,
      candidates: ranked.map((r) => ({
        id: r.market.id,
        name: r.market.name,
        niche: r.market.niche,
        competitorTitles: r.market.competitors.map((c) => c.title),
      })),
    });
    chosenId = fit.marketId;
    reason = fit.reason;
  } catch (err: any) {
    // The judgement is what makes a substitution safe. Without it, don't.
    console.warn(`[audit] ${runId}: could not judge a market substitution:`, err?.message || err);
    return null;
  }
  const chosen = ranked.find((r) => r.market.id === chosenId)?.market;
  if (!chosen) {
    console.log(`[audit] ${runId}: no saved market substituted — ${reason}`);
    return null;
  }
  const competitors = withoutSubject(
    chosen.competitors.filter((c) => c.include !== false),
    { channelId: channel.channelId, handle: channel.handle },
  );
  if (!competitors.length) return null;
  console.log(`[audit] ${runId}: substituted saved market "${chosen.name}" (${competitors.length} competitors) — ${reason}`);
  return {
    competitors,
    substitutionNote:
      `Competitor discovery could not run (${why}). The saved market "${chosen.name}" was substituted because it covers the same ground: ${reason} ` +
      `Check it before approving — every comparison in the report is made against these channels.`,
  };
}

async function runRest(runId: string, market: MarketProposal | null, options: RunRestOptions = {}) {
  const { skip = [], reuseThumbnails = false, reuseRenames = false } = options;
  const run = getRun(runId);
  if (!run || !run.subject) throw new Error("Run has no ingested channel");
  const subject = run.subject;
  const videos = run.videos;
  const mode = run.input.mode;
  let quotaUnits = run.quotaUnits;
  const gaps = gapRecorder(runId, run.gaps);

  // ── scan the competitors ────────────────────────────────────────────────
  // Everything here is recomputed rather than resumed, even when a previous
  // attempt already scanned it: only each competitor's OUTLIERS are persisted,
  // and a title pattern or a rank computed from an outliers-only sample is the
  // mistake this tool has already shipped once — a median that was ≥1.5x by
  // construction, presented as a market comparison. Re-scanning costs about a
  // hundred quota units. Being confidently wrong costs the report.
  const wanted = market?.competitors.filter((c) => c.include) ?? [];
  let results: Awaited<ReturnType<typeof ingestCompetitors>>["results"] = [];
  if (!market || !wanted.length) {
    if (!gaps.has("market")) gaps.add("market", "No competitor set to scan.", !skip.includes("market"));
  } else if (skip.includes("market")) {
    if (!gaps.has("market")) gaps.add("market", "You skipped the market scan.", false);
  } else {
    setStage(runId, "scanning", "Scanning the market", 0.25);
    updateRun(runId, { status: "scanning", approved: market });
    const scan = await gaps.step("market", null, () =>
      ingestCompetitors(wanted, { maxVideos: COMPETITOR_MAX_VIDEOS }),
    );
    if (scan) {
      results = scan.results;
      quotaUnits += scan.quotaUnits;
      if (scan.failures.length) {
        console.warn(
          `[audit] ${runId}: dropped ${scan.failures.length} competitor(s):`,
          scan.failures.map((f) => f.title).join(", "),
        );
      }
    }
  }

  const competitors: AuditChannel[] = results.map((r) => r.channel);
  const competitorNames = new Map(competitors.map((c) => [c.channelId, c.title]));
  // Only the market's genuine over-performers are kept. A competitor's average
  // video is not evidence of anything — the outliers are what a rename learns
  // from, and keeping everything would bloat every prompt downstream.
  const marketVideos: AuditVideo[] = results.flatMap((r) =>
    outliers(r.videos, "long", 1.5).slice(0, 30).map((v) => ({ ...v, titleFeatures: titleFeatures(v.title) })),
  );
  // The FULL competitor catalogues, used for the market-wide title analysis and
  // then dropped. Only the outliers are persisted — storing thousands of
  // competitor videos on every run would bloat the row for no later use — but
  // the whole set is what makes a title formula evidence rather than a hunch.
  const marketFull: AuditVideo[] = results.flatMap((r) =>
    r.videos.map((v) => ({ ...v, titleFeatures: titleFeatures(v.title) })),
  );
  const marketPatterns = marketFull.length ? marketTitlePatterns(marketFull) : null;
  if (marketFull.length) {
    console.log(
      `[audit] ${runId}: market title analysis over ${marketFull.length} competitor videos` +
        (marketPatterns ? ` — ${marketPatterns.winning.length} winning pattern(s)` : " — too small to report"),
    );
  }
  updateRun(runId, { competitors, marketVideos, quotaUnits });

  // ── thumbnails ──────────────────────────────────────────────────────────
  // The most expensive stage in the run: one vision call per image, across the
  // whole catalogue and the market's outliers. So attributes already on the row
  // are reused and only the images nobody has looked at are read — a run that
  // is carrying on after a failure never pays for the same picture twice.
  setStage(runId, "analysing", "Looking at the thumbnails", 0.4);
  updateRun(runId, { status: "analysing" });

  const attributes = new Map<string, ThumbnailAttributes>();
  if (reuseThumbnails) {
    for (const v of [...run.videos, ...run.marketVideos]) if (v.thumbnail) attributes.set(v.videoId, v.thumbnail);
    if (attributes.size) console.log(`[audit] ${runId}: reusing ${attributes.size} thumbnail read(s) already on the run`);
  }
  const thumbTargets = [...videos, ...marketVideos].filter((v) => !attributes.has(v.videoId));
  if (skip.includes("thumbnails")) {
    if (!gaps.has("thumbnails")) gaps.add("thumbnails", "You skipped reading the thumbnails.", false);
  } else if (thumbTargets.length) {
    await gaps.step("thumbnails", null, async () => {
      const images = await fetchThumbnails(thumbTargets.map((v) => ({ videoId: v.videoId, thumbnailUrl: v.thumbnailUrl })));
      for (let i = 0; i < images.length; i += THUMBNAIL_BATCH) {
        const batch = images.slice(i, i + THUMBNAIL_BATCH);
        try {
          for (const [id, attrs] of await readThumbnails(batch)) attributes.set(id, attrs);
        } catch (err: any) {
          // One bad batch must not cost the pass; the correlations simply run over
          // fewer videos, and every claim carries its own sample size anyway.
          console.warn(`[audit] ${runId}: thumbnail batch failed:`, err?.message || err);
        }
        setStage(runId, "analysing", `Looking at the thumbnails (${Math.min(i + THUMBNAIL_BATCH, images.length)}/${images.length})`, 0.4 + 0.2 * (i / Math.max(1, images.length)));
      }
      return null;
    });
  }

  const videosWithThumbs: AuditVideo[] = videos.map((v) => ({ ...v, thumbnail: attributes.get(v.videoId) }));
  const marketWithThumbs: AuditVideo[] = marketVideos.map((v) => ({ ...v, thumbnail: attributes.get(v.videoId) }));
  updateRun(runId, { videos: videosWithThumbs, marketVideos: marketWithThumbs });

  // ── what the winners actually do, and what their viewers said ───────────
  // Titles and thumbnails explain the click. This is the only pass that looks
  // at why anyone stays, and at what the audience asked for and did not get.
  let contentPatterns: AuditFindings["contentPatterns"] = null;
  if (skip.includes("content")) {
    if (!gaps.has("content")) gaps.add("content", "You skipped reading transcripts and comments.", false);
  } else {
    await gaps.step("content", null, async () => {
      setStage(runId, "analysing", "Reading the winners' transcripts and comments", 0.55);
      const targets = [
        ...outliers(marketWithThumbs, "long", 1.5).slice(0, CONTENT_MARKET),
        ...outliers(videosWithThumbs, "long", 1.5).slice(0, CONTENT_OWN),
      ].map((v) => ({
        videoId: v.videoId,
        title: v.title,
        channelTitle: competitorNames.get(v.channelId) ?? subject.title,
        views: v.views,
      }));

      if (targets.length) {
        const { items, quotaUnits: cUnits, transcripts } = await gatherContent(targets);
        quotaUnits += cUnits;
        const reads = await readContent(items);
        console.log(
          `[audit] ${runId}: content — ${transcripts}/${targets.length} transcripts` +
            `${transcriptsAvailable() ? "" : " (no Apify token: comments only)"}, ${reads.size} read`,
        );
        if (reads.size) {
          const sum = summariseContent(reads, new Map());
          contentPatterns = { ...sum, verdict: "" };
        }
        updateRun(runId, { quotaUnits });
      }
      return null;
    });
  }

  // ── the computed findings ───────────────────────────────────────────────
  setStage(runId, "analysing", "Working out what wins", 0.62);
  const pool = evidencePool(videosWithThumbs, "long");
  const patterns = titlePatternPerformance(pool);
  const { winning, losing } = splitWinnersLosers(patterns);

  const noTopics = { topics: [] as Awaited<ReturnType<typeof clusterTopics>>["topics"], gaps: [] as AuditFindings["content"]["gaps"] };
  const topics = skip.includes("topics")
    ? (gaps.has("topics") || gaps.add("topics", "You skipped the topic grouping.", false), noTopics)
    : await gaps.step("topics", noTopics, () =>
        clusterTopics(subject, videosWithThumbs, marketWithThumbs, competitorNames, run.input.angle, gaps.list),
      );
  const byId = new Map(videosWithThumbs.map((v) => [v.videoId, v]));
  const marketById = new Map(marketWithThumbs.map((v) => [v.videoId, v]));
  // A rank needs something to rank against. With no market scanned, marketRanks
  // would faithfully report "1 of 1" — a true statement that reads as a finding.
  const ranks = results.length
    ? marketRanks(
        subject,
        videosWithThumbs,
        results.map((r) => ({ channel: r.channel, videos: r.videos })),
      )
    : { subscriberRank: 0, medianViewsRank: 0, competitorCount: 0 };

  const computed: Omit<AuditFindings, "summary" | "growth"> = {
    ageCurve: ageCurve(videosWithThumbs, "long"),
    titles: { winning, losing, market: marketPatterns, verdict: "" },
    thumbnails: {
      correlations: [...thumbnailCorrelations(pool), ...titleStructureCorrelations(pool)],
      // What winning thumbnails look like across BOTH sides — yours and the
      // market's. A share among winners, never presented as a cause.
      outlierProfile: outlierThumbnailProfile([
        ...outliers(videosWithThumbs, "long", 1.5),
        ...marketWithThumbs,
      ]),
      verdict: "",
    },
    content: {
      topics: topics.topics.map((t) => {
        const vids = t.videoIds.map((id) => byId.get(id)).filter((v): v is AuditVideo => !!v && v.judged);
        const mults = vids.map((v) => v.eraMultiple).sort((a, b) => a - b);
        const mkt = (t.marketVideoIds ?? []).map((id) => marketById.get(id)).filter((v): v is AuditVideo => !!v);
        const mktViews = mkt.map((v) => v.views).sort((a, b) => a - b);
        const total = vids.length + mkt.length;
        return {
          topic: t.topic,
          count: vids.length,
          medianMultiple: mults.length ? Math.round(mults[Math.floor(mults.length / 2)] * 100) / 100 : 0,
          examples: vids.slice(0, 3).map((v) => v.title),
          // The membership itself, not just three examples — a topic refocus is
          // built on this, and without it the filter can only see the examples.
          videoIds: vids.map((v) => v.videoId),
          // The market side of the same membership. Aggregates alone answer the
          // questions the report thought to ask; a custom section asking "how do
          // I compare to the market ON THIS TOPIC" needs the videos themselves.
          marketVideoIds: mkt.map((v) => v.videoId),
          // The same topic as the market covers it, so ownership and growth are
          // answerable rather than inferred.
          marketCount: mkt.length,
          marketMedianViews: mktViews.length ? mktViews[Math.floor(mktViews.length / 2)] : 0,
          share: total ? Math.round((vids.length / total) * 100) / 100 : 0,
        };
      }),
      gaps: topics.gaps,
      verdict: "",
    },
    position: { ...ranks, strengths: [], weaknesses: [], verdict: "" },
  };

  // ── renames (own mode only — a teardown has nothing to rename) ───────────
  let renamed = videosWithThumbs;
  const keptRenames = new Map(run.videos.filter((v) => v.rename).map((v) => [v.videoId, v.rename!]));
  if (mode === "own" && skip.includes("renames")) {
    if (!gaps.has("renames")) gaps.add("renames", "You skipped writing the new titles.", false);
  } else if (mode === "own" && reuseRenames && keptRenames.size) {
    // Titles are the run's most expensive tokens. A run carrying on after a
    // later stage failed keeps the ones it already paid for.
    console.log(`[audit] ${runId}: reusing ${keptRenames.size} proposed title(s) already on the run`);
    renamed = videosWithThumbs.map((v) => ({ ...v, rename: keptRenames.get(v.videoId) }));
  } else if (mode === "own") {
    setStage(runId, "renaming", "Writing new titles", 0.7);
    updateRun(runId, { status: "renaming" });

    const outlierTitles = marketWithThumbs
      .slice()
      .sort((a, b) => b.eraMultiple - a.eraMultiple)
      .slice(0, 30)
      .map((v) => ({ title: v.title, channelTitle: competitorNames.get(v.channelId) ?? "market", eraMultiple: v.eraMultiple }));

    // Every video gets a proposal, worst-first so the most valuable ones are
    // written even if a later batch fails.
    const targets = videosWithThumbs
      .filter((v) => v.judged)
      .map((v) => ({ v, priority: renamePriority(v, Date.now()) }))
      .sort((a, b) => b.priority - a.priority);

    const proposals = new Map<string, Awaited<ReturnType<typeof proposeRenames>> extends Map<string, infer T> ? T : never>();
    for (let i = 0; i < targets.length; i += RENAME_BATCH) {
      const batch = targets.slice(i, i + RENAME_BATCH);
      try {
        for (const [id, p] of await proposeRenames(batch.map((t) => t.v), {
          channelTitle: subject.title,
          niche: market?.niche ?? "",
          winning,
          losing,
          marketPatterns,
          outlierTitles,
        })) {
          const pri = batch.find((t) => t.v.videoId === id)?.priority ?? 0;
          proposals.set(id, { ...p, priority: pri });
        }
      } catch (err: any) {
        console.warn(`[audit] ${runId}: rename batch failed:`, err?.message || err);
      }
      setStage(runId, "renaming", `Writing new titles (${Math.min(i + RENAME_BATCH, targets.length)}/${targets.length})`, 0.7 + 0.2 * (i / Math.max(1, targets.length)));
    }
    renamed = videosWithThumbs.map((v) => ({ ...v, rename: proposals.get(v.videoId) }));
    updateRun(runId, { videos: renamed });
  }

  // ── the write-up ────────────────────────────────────────────────────────
  // Even this is skippable. The verdicts are the part a person reads first, but
  // they are written OVER measurements that are already made and already worth
  // having — losing the prose is a bad outcome, losing the charts, the era
  // curve and the ranks with it is a much worse one.
  const noWriteUp = {
    verdicts: { titles: "", thumbnails: "", content: "", position: "" },
    strengths: [] as string[],
    weaknesses: [] as string[],
    growth: [] as AuditFindings["growth"],
    summary: "",
  };
  setStage(runId, "analysing", "Writing the report", 0.92);
  const written = skip.includes("report")
    ? (gaps.has("report") || gaps.add("report", "You skipped the write-up.", false), noWriteUp)
    : await gaps.step("report", noWriteUp, () =>
        writeReport({
          channel: subject,
          niche: market?.niche ?? "",
          mode,
          computed,
          videos: videosWithThumbs,
          angle: run.input.angle,
          gaps: gaps.list,
        }),
      );

  const findings: AuditFindings = {
    ...computed,
    titles: { ...computed.titles, verdict: written.verdicts.titles },
    thumbnails: { ...computed.thumbnails, verdict: written.verdicts.thumbnails },
    content: { ...computed.content, verdict: written.verdicts.content },
    position: {
      ...computed.position,
      strengths: written.strengths,
      weaknesses: written.weaknesses,
      verdict: written.verdicts.position,
    },
    growth: written.growth,
    summary: written.summary,
    contentPatterns,
    actionPlan: null,
  };

  // The plan is written LAST, over the finished findings, because it has to
  // cite them. It is also the part most likely to fail on a malformed answer,
  // so a failure here leaves a complete report rather than losing the run.
  setStage(runId, "analysing", "Writing the action plan", 0.96);
  if (skip.includes("plan")) {
    if (!gaps.has("plan")) gaps.add("plan", "You skipped the action plan.", false);
  } else {
    findings.actionPlan = await gaps.step("plan", null, () =>
      writeActionPlan({
        channel: subject,
        niche: market?.niche ?? "",
        findings,
        marketOutliers: marketWithThumbs
          .slice()
          .sort((a, b) => b.views - a.views)
          .slice(0, 25)
          .map((v) => ({ title: v.title, channelTitle: competitorNames.get(v.channelId) ?? "market", views: v.views })),
        videos: videosWithThumbs,
        angle: run.input.angle,
        gaps: gaps.list,
      }),
    );
  }

  // The first-run analysis is recorded as the BASE at completion, not merely
  // when someone first narrows it. Everything after this — a refocus from the
  // chat, or anything later that rewrites findings — is a view ON this, and the
  // original stays in the database. The first real refocus destroyed a full
  // report because the original only existed in the column being overwritten.
  updateRun(runId, {
    status: "completed",
    findings,
    baseFindings: findings,
    videos: renamed,
    quotaUnits,
    gaps: gaps.list,
    // A run that finished after being carried past a failure is not a failed
    // run any more; leaving the error on the row would keep saying it was.
    failedStage: null,
    error: null,
  });
  live.delete(runId);
  const spent = currentUsageScope()?.calls ?? [];
  console.log(
    `[audit] ${runId} done${gaps.list.length ? ` (skipped: ${gaps.list.map((g) => g.stage).join(", ")})` : ""} — ` +
      `${renamed.length} videos, ${competitors.length} competitors, ` +
      `${quotaUnits} quota units, ${spent.length} AI calls, $${totalCost(spent).toFixed(2)}` +
      (hasUnpriced(spent) ? " (some calls ran on a model with no rate on file)" : ""),
  );
  for (const line of costByLabel(spent)) {
    console.log(`[audit] ${runId}   ${line.label}: $${line.costUsd.toFixed(3)} over ${line.calls} call(s)`);
  }
}

function fail(runId: string, err: any) {
  const message =
    err instanceof ChannelNotFoundError
      ? err.message
      : err?.name === "YoutubeQuotaError"
        ? "YouTube API quota is exhausted for today. The audit stopped; what it had already gathered is kept."
        : String(err?.message || err);
  // Which stage died, so "skip it and carry on" knows what it is skipping. Only
  // a failure that gets this far is unrecoverable — every skippable stage has
  // already been given its chance to record a gap and continue.
  const run = getRun(runId);
  const failedStage = run ? inferFailedStage(run) : null;
  updateRun(runId, { status: "failed", error: message, failedStage });
  live.set(runId, { runId, status: "failed", stage: "Failed", progress: 1, error: message });
  console.error(`[audit] ${runId} failed at ${failedStage ?? "?"}:`, message);
}

/**
 * Carry a failed run past the stage that killed it.
 *
 * The operator's one-button answer to "it stopped and I am not there to decide
 * what to do about it". Everything the run already paid for — the catalogue,
 * the thumbnail reads, the proposed titles — is reused; the failed stage is
 * recorded as a gap so the report says what is missing and why; everything else
 * runs. What comes out is a real report with a hole in it, which is worth far
 * more than a failed row that has to be paid for all over again tomorrow.
 */
export function skipAuditStage(runId: string): { ok: boolean; stage?: AuditStage; action?: "retry" | "skip"; reason?: string } {
  const run = getRun(runId);
  if (!run) return { ok: false, reason: "Audit run not found." };
  const decided = skipPlan(run);
  if (!decided.ok) return { ok: false, reason: decided.reason };
  const { stage, action, market, reuseThumbnails, reuseRenames } = decided.plan;

  if (action === "skip") {
    // The gap keeps the ORIGINAL error as its reason — "YouTube API quota is
    // exhausted for today" explains the hole in the report; "you pressed skip"
    // explains nothing.
    gapRecorder(runId, run.gaps).add(stage, run.error || `${STAGE_META[stage].label} failed.`, false);
  }
  updateRun(runId, { status: "scanning", error: null, failedStage: null });
  setStage(
    runId,
    "scanning",
    action === "skip" ? `Carrying on without: ${STAGE_META[stage].label.toLowerCase()}` : `Retrying: ${STAGE_META[stage].label.toLowerCase()}`,
    0.22,
  );

  // A retried stage that fails again is recorded as a gap by the pipeline
  // rather than by this function, so the run finishes either way.
  void withUsageScope(auditScope(runId, run.calls), () =>
    runRest(runId, market, { skip: action === "skip" ? [stage] : [], reuseThumbnails, reuseRenames }),
  ).catch((err) => fail(runId, err));
  return { ok: true, stage, action };
}
