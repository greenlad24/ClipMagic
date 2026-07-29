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
import { fetchThumbnails } from "./images.js";
import { proposeMarket, pickCompetitors, readThumbnails, clusterTopics, proposeRenames, writeReport, THUMBNAIL_BATCH } from "./ai.js";
import {
  titleFeatures,
  titlePatternPerformance,
  titleStructureCorrelations,
  thumbnailCorrelations,
  splitWinnersLosers,
  renamePriority,
  marketRanks,
  evidencePool,
} from "./analysis.js";
import { ageCurve, outliers } from "./baseline.js";
import { createRun, updateRun, getRun } from "../db/auditRuns.js";
import type {
  AuditChannel,
  AuditFindings,
  AuditInput,
  AuditJobSnapshot,
  AuditVideo,
  MarketProposal,
} from "./types.js";

/** Videos to retitle per director-tier call. */
const RENAME_BATCH = 15;

/** Competitor videos ingested each — enough for outliers without paging forever. */
const COMPETITOR_MAX_VIDEOS = 300;

const live = new Map<string, AuditJobSnapshot>();

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

function setStage(runId: string, status: AuditJobSnapshot["status"], stage: string, progress: number) {
  live.set(runId, { runId, status, stage, progress, error: null });
}

/** Start an audit. Returns immediately; work continues in the background. */
export function startAudit(input: AuditInput): { runId: string } {
  const runId = nanoid();
  createRun(runId, input);
  setStage(runId, "ingesting", "Reading the channel", 0.02);

  void (async () => {
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

      // ── propose the market ────────────────────────────────────────────────
      setStage(runId, "proposing", "Working out the market", 0.12);
      updateRun(runId, { status: "proposing" });
      const { market: proposal, searchQueries } = await proposeMarket(channel, withFeatures);
      updateRun(runId, { proposal });

      // Find the competitors by SEARCHING YouTube rather than by asking the
      // model to remember them. Asking produced two different sets on two runs
      // of the same channel, six of eight of them fabricated — and a fabricated
      // handle resolves through search to some unrelated 26-subscriber channel,
      // which is worse than nothing because it silently becomes market data.
      setStage(runId, "proposing", "Searching for who else ranks for this", 0.15);
      const { channels: discovered, quotaUnits: searchUnits } = await discoverCompetitors(searchQueries, channel);
      const picked = await pickCompetitors(channel, proposal.niche, discovered);
      proposal.competitors = picked;
      console.log(
        `[audit] ${runId}: ${searchQueries.length} searches found ${discovered.length} candidates, kept ${picked.length}`,
      );
      updateRun(runId, { proposal, quotaUnits: quotaUnits + searchUnits });

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
  })();

  return { runId };
}

/** Continue a paused run with the market the operator actually approved. */
export function resumeAudit(runId: string, approved: MarketProposal): { ok: boolean } {
  const run = getRun(runId);
  if (!run || run.status !== "awaiting-approval") return { ok: false };
  updateRun(runId, { approved, status: "scanning" });
  void runRest(runId, approved).catch((err) => fail(runId, err));
  return { ok: true };
}

async function runRest(runId: string, market: MarketProposal) {
  const run = getRun(runId);
  if (!run || !run.subject) throw new Error("Run has no ingested channel");
  const subject = run.subject;
  const videos = run.videos;
  const mode = run.input.mode;
  let quotaUnits = run.quotaUnits;

  // ── scan the competitors ────────────────────────────────────────────────
  setStage(runId, "scanning", "Scanning the market", 0.25);
  updateRun(runId, { status: "scanning", approved: market });

  const wanted = market.competitors.filter((c) => c.include);
  const { results, failures, quotaUnits: scanUnits } = await ingestCompetitors(wanted, {
    maxVideos: COMPETITOR_MAX_VIDEOS,
  });
  quotaUnits += scanUnits;

  const competitors: AuditChannel[] = results.map((r) => r.channel);
  const competitorNames = new Map(competitors.map((c) => [c.channelId, c.title]));
  // Only the market's genuine over-performers are kept. A competitor's average
  // video is not evidence of anything — the outliers are what a rename learns
  // from, and keeping everything would bloat every prompt downstream.
  const marketVideos: AuditVideo[] = results.flatMap((r) =>
    outliers(r.videos, "long", 1.5).slice(0, 30).map((v) => ({ ...v, titleFeatures: titleFeatures(v.title) })),
  );
  updateRun(runId, { competitors, marketVideos, quotaUnits });
  if (failures.length) {
    console.warn(`[audit] ${runId}: dropped ${failures.length} competitor(s):`, failures.map((f) => f.title).join(", "));
  }

  // ── thumbnails ──────────────────────────────────────────────────────────
  setStage(runId, "analysing", "Looking at the thumbnails", 0.4);
  updateRun(runId, { status: "analysing" });

  const thumbTargets = [...videos, ...marketVideos];
  const images = await fetchThumbnails(thumbTargets.map((v) => ({ videoId: v.videoId, thumbnailUrl: v.thumbnailUrl })));
  const attributes = new Map<string, Awaited<ReturnType<typeof readThumbnails>> extends Map<string, infer T> ? T : never>();
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

  const videosWithThumbs: AuditVideo[] = videos.map((v) => ({ ...v, thumbnail: attributes.get(v.videoId) }));
  const marketWithThumbs: AuditVideo[] = marketVideos.map((v) => ({ ...v, thumbnail: attributes.get(v.videoId) }));
  updateRun(runId, { videos: videosWithThumbs, marketVideos: marketWithThumbs });

  // ── the computed findings ───────────────────────────────────────────────
  setStage(runId, "analysing", "Working out what wins", 0.62);
  const pool = evidencePool(videosWithThumbs, "long");
  const patterns = titlePatternPerformance(pool);
  const { winning, losing } = splitWinnersLosers(patterns);

  const topics = await clusterTopics(subject, videosWithThumbs, marketWithThumbs, competitorNames);
  const byId = new Map(videosWithThumbs.map((v) => [v.videoId, v]));
  const ranks = marketRanks(
    subject,
    videosWithThumbs,
    results.map((r) => ({ channel: r.channel, videos: r.videos })),
  );

  const computed: Omit<AuditFindings, "summary" | "growth"> = {
    ageCurve: ageCurve(videosWithThumbs, "long"),
    titles: { winning, losing, verdict: "" },
    thumbnails: {
      correlations: [...thumbnailCorrelations(pool), ...titleStructureCorrelations(pool)],
      verdict: "",
    },
    content: {
      topics: topics.topics.map((t) => {
        const vids = t.videoIds.map((id) => byId.get(id)).filter((v): v is AuditVideo => !!v && v.judged);
        const mults = vids.map((v) => v.eraMultiple).sort((a, b) => a - b);
        return {
          topic: t.topic,
          count: vids.length,
          medianMultiple: mults.length ? Math.round(mults[Math.floor(mults.length / 2)] * 100) / 100 : 0,
          examples: vids.slice(0, 3).map((v) => v.title),
          // The membership itself, not just three examples — a topic refocus is
          // built on this, and without it the filter can only see the examples.
          videoIds: vids.map((v) => v.videoId),
        };
      }),
      gaps: topics.gaps,
      verdict: "",
    },
    position: { ...ranks, strengths: [], weaknesses: [], verdict: "" },
  };

  // ── renames (own mode only — a teardown has nothing to rename) ───────────
  let renamed = videosWithThumbs;
  if (mode === "own") {
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
          niche: market.niche,
          winning,
          losing,
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
  setStage(runId, "analysing", "Writing the report", 0.92);
  const written = await writeReport({ channel: subject, niche: market.niche, mode, computed });

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
  };

  updateRun(runId, { status: "completed", findings, videos: renamed, quotaUnits });
  live.delete(runId);
  console.log(`[audit] ${runId} done — ${renamed.length} videos, ${competitors.length} competitors, ${quotaUnits} quota units`);
}

function fail(runId: string, err: any) {
  const message =
    err instanceof ChannelNotFoundError
      ? err.message
      : err?.name === "YoutubeQuotaError"
        ? "YouTube API quota is exhausted for today. The audit stopped; what it had already gathered is kept."
        : String(err?.message || err);
  updateRun(runId, { status: "failed", error: message });
  live.set(runId, { runId, status: "failed", stage: "Failed", progress: 1, error: message });
  console.error(`[audit] ${runId} failed:`, message);
}
