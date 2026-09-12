/**
 * What an audit does when a stage fails.
 *
 * The orchestrator used to treat every error the same way: stop, mark the run
 * failed, keep what was computed. That is right for the channel ingest — with
 * no catalogue there is nothing to analyse — and wrong for everything after it.
 * A run that has already read 2,000 videos and 2,200 thumbnails should not die
 * because the market search hit a daily cap; it should say what it could not
 * get and finish the parts that do not depend on it.
 *
 * So every stage after the ingest is SKIPPABLE. Skipping one records a gap: the
 * stage, why, and — the part that matters — what the report loses because of
 * it. A missing section that says nothing is indistinguishable from a section
 * with nothing to say, and the second is a finding while the first is an
 * outage.
 *
 * This module is pure: what is fatal, where a failed run picks up again, and
 * which saved market could stand in for a discovery that could not run. The
 * pipeline calls it; the tests exercise it without spending a cent.
 */
import type { AuditGap, AuditRunResult, AuditStage, MarketProposal, ProposedCompetitor, SavedMarket } from "./types.js";

/** Pipeline order. Everything except `ingest` can be skipped. */
export const STAGE_ORDER: AuditStage[] = [
  "ingest",
  "market",
  "thumbnails",
  "content",
  "topics",
  "renames",
  "report",
  "plan",
];

/**
 * What each stage is, and what its absence costs the report.
 *
 * `consequence` is written for the operator, and is also handed to the model
 * writing the report — a model told "there is no market data" says so, where a
 * model handed an empty array quietly writes around it and, on the evidence of
 * this tool's own history, eventually writes something confident and wrong.
 */
export const STAGE_META: Record<AuditStage, { label: string; consequence: string; fatal: boolean }> = {
  ingest: {
    label: "Reading the channel",
    consequence: "There is no catalogue, so nothing can be analysed.",
    fatal: true,
  },
  market: {
    label: "The competitor market",
    consequence:
      "Nothing is compared against the market: no competitor title patterns, no ranking, no market gaps. Everything measured on this channel's own catalogue — the era curve, its title patterns, its thumbnails, its topics — is unaffected.",
    fatal: false,
  },
  thumbnails: {
    label: "Reading the thumbnails",
    consequence:
      "No thumbnail correlations, and no thumbnail attributes on any video. Titles, topics, the growth curve and the ranking are unaffected.",
    fatal: false,
  },
  content: {
    label: "The winners' transcripts and comments",
    consequence:
      "No read on why viewers stay, and none of what the audience asked for and did not get. Packaging analysis is unaffected.",
    fatal: false,
  },
  topics: {
    label: "Grouping the catalogue into topics",
    consequence: "No topic breakdown and no list of market gaps.",
    fatal: false,
  },
  renames: {
    label: "Writing the new titles",
    consequence: "No proposed title for any video. The analysis a rename would have been based on is still in the report.",
    fatal: false,
  },
  report: {
    label: "Writing the report",
    consequence:
      "The charts, patterns, ranks and numbers are all here; the written verdicts, strengths, weaknesses and summary are not.",
    fatal: false,
  },
  plan: {
    label: "The action plan",
    consequence: "No ordered plan. The findings and the growth areas are still here.",
    fatal: false,
  },
};

export function isFatal(stage: AuditStage): boolean {
  return STAGE_META[stage].fatal;
}

/** A gap record for one skipped stage. */
export function gapFor(stage: AuditStage, reason: string, automatic: boolean, at = Date.now()): AuditGap {
  const meta = STAGE_META[stage];
  return {
    stage,
    label: meta.label,
    reason: (reason || "").slice(0, 500),
    consequence: meta.consequence,
    automatic,
    at,
  };
}

/**
 * Add a gap, keeping ONE per stage.
 *
 * A stage that is retried and fails again is still one hole in the report, and
 * a list that grows a duplicate every retry reads like a worse outage than it
 * is. The newest record wins because it carries the newest reason.
 */
export function addGap(gaps: AuditGap[], gap: AuditGap): AuditGap[] {
  return [...gaps.filter((g) => g.stage !== gap.stage), gap].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
  );
}

/**
 * Which stage a failed run died in, when the run itself did not record one.
 *
 * Runs that failed before failures were recorded still deserve the skip button,
 * and their row says plenty: no subject means the ingest died, no competitors
 * with a market wanted means the market did, and so on down the pipeline. It is
 * a guess, but a guess from the artefacts rather than from the error text —
 * which for a quota error is identical whichever stage raised it.
 */
export function inferFailedStage(
  run: Pick<AuditRunResult, "subject" | "videos" | "competitors" | "findings"> & { gaps?: AuditGap[] },
): AuditStage {
  // A stage already recorded as a gap cannot be the one that just died — it was
  // skipped, and the run carried on past it. Without this, a run that lost its
  // market and then failed later would keep pointing at the market.
  const skipped = new Set((run.gaps ?? []).map((g) => g.stage));
  const next = (stage: AuditStage, missing: boolean) => missing && !skipped.has(stage);

  if (!run.subject || !run.videos.length) return "ingest";
  // No competitor was ingested, whatever the proposal says. The market stage
  // covers discovery AND the scan, and a discovery that died leaves an empty
  // competitor list on a proposal that never got one either — the state the run
  // this was written for was in.
  if (next("market", !run.competitors.length)) return "market";
  if (next("thumbnails", !run.videos.some((v) => v.thumbnail))) return "thumbnails";
  if (next("report", !run.findings)) return "report";
  return "plan";
}

/**
 * Reasons that will still be true in five minutes.
 *
 * The difference between "retry it" and "give up on it" is entirely this: a
 * server restart or a model that returned nonsense is worth another attempt; a
 * daily quota cap is not, and retrying it just fails the run a second time
 * while the operator watches. Anything not recognised here is treated as
 * transient — the optimistic guess is the cheap one, because a retry that fails
 * is recorded as a gap and the run carries on regardless.
 */
const RECURRING = [/quota/i, /exhausted/i, /not configured/i, /api key/i, /billing/i, /credit/i];

export function willRecurToday(reason: string): boolean {
  return RECURRING.some((re) => re.test(reason || ""));
}

export interface SkipPlan {
  /** The stage that failed. */
  stage: AuditStage;
  /**
   * What to do about it. `retry` runs the stage again; `skip` does not attempt
   * it at all, because its reason will still be true today. Either way the run
   * finishes — a retry that fails again is recorded as a gap by the pipeline.
   */
  action: "retry" | "skip";
  /** Thumbnail attributes are already on the row — never pay for them twice. */
  reuseThumbnails: boolean;
  /** Same for the renames, which are the most expensive tokens in the run. */
  reuseRenames: boolean;
  /** The market to run with, or null when the market itself is what is skipped. */
  market: MarketProposal | null;
}

/**
 * Work out how to carry on from a failed run — or why it cannot.
 *
 * The stage that died is either retried or skipped, decided by whether its
 * reason will still be true today (willRecurToday). That is the whole of the
 * "decide for me" behaviour: a restart is retried, a daily cap is not.
 *
 * Everything cheap is recomputed rather than resumed mid-flight. That is a
 * deliberate trade: the competitor catalogues are re-scanned (about a hundred
 * quota units) because only their OUTLIERS are persisted, and computing market
 * title patterns or a rank from an outliers-only sample is the exact mistake
 * this tool has already shipped once — a ">=1.5x by construction" median
 * presented as a finding. Re-scanning is cheaper than being confidently wrong.
 *
 * What is NOT recomputed is what was expensive in dollars: thumbnail attributes
 * and proposed titles are reused straight off the row.
 */
export function skipPlan(
  run: Pick<
    AuditRunResult,
    "status" | "subject" | "videos" | "competitors" | "approved" | "proposal" | "findings" | "failedStage" | "error"
  > & { gaps?: AuditGap[] },
): { ok: true; plan: SkipPlan } | { ok: false; reason: string } {
  if (run.status !== "failed") {
    return { ok: false, reason: `This run is ${run.status}. There is nothing to skip.` };
  }
  const stage = run.failedStage ?? inferFailedStage(run);
  if (isFatal(stage)) {
    return {
      ok: false,
      reason: "This run never got a catalogue to work from, so there is nothing to carry on with. Start it again.",
    };
  }
  const action = willRecurToday(run.error ?? "") ? "skip" : "retry";
  const market = stage === "market" && action === "skip" ? null : run.approved ?? withIncludedOnly(run.proposal);
  return {
    ok: true,
    plan: {
      stage,
      action,
      reuseThumbnails: run.videos.some((v) => v.thumbnail),
      reuseRenames: run.videos.some((v) => v.rename),
      market,
    },
  };
}

function withIncludedOnly(proposal: MarketProposal | null): MarketProposal | null {
  if (!proposal) return null;
  const competitors = proposal.competitors.filter((c) => c.include);
  return competitors.length ? { ...proposal, competitors } : null;
}

/**
 * Drop the subject from a competitor set.
 *
 * A saved market is a set of channels in a niche, and the channel now being
 * audited may well be one of them — the market this tool substituted on the day
 * it was written contained the very channel it was about. A subject inside its
 * own market baseline is scored against itself: its outliers inflate the median
 * it is then measured against, and its rank is off by one in its own favour.
 */
export function withoutSubject(
  competitors: ProposedCompetitor[],
  subject: { channelId?: string | null; handle?: string | null },
): ProposedCompetitor[] {
  const id = (subject.channelId || "").trim().toLowerCase();
  const handle = (subject.handle || "").replace(/^@/, "").trim().toLowerCase();
  return competitors.filter((c) => {
    const cid = (c.channelId || "").trim().toLowerCase();
    const ch = (c.handle || "").replace(/^@/, "").trim().toLowerCase();
    if (id && cid && cid === id) return false;
    if (handle && ch && ch === handle) return false;
    return true;
  });
}

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","for","from","how","in","into","is","it","its","of","on","or","that",
  "the","their","to","tools","tool","with","you","your","who","what","channel","channels","videos","video","content",
]);

function tokens(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/**
 * How well a saved market matches a niche, 0..1 — the share of the niche's
 * content words the market also uses.
 */
export function marketFitScore(niche: string, market: Pick<SavedMarket, "name" | "niche" | "nicheDescription">): number {
  const want = tokens(niche);
  if (!want.size) return 0;
  const have = tokens(`${market.name} ${market.niche} ${market.nicheDescription ?? ""}`);
  let hits = 0;
  for (const w of want) if (have.has(w)) hits += 1;
  return hits / want.size;
}

/**
 * Saved markets that could stand in for a discovery that could not run,
 * best first.
 *
 * The floor exists because the alternative to a substitute is a report with no
 * market section, and that is FAR better than a report comparing an AI-tools
 * channel to a set of music channels. A weak overlap is not a market; it is a
 * different question with a competitor list attached. Word overlap only decides
 * what is worth ASKING about — the model confirms the fit before anything is
 * scanned (ai.confirmMarketFit).
 */
export const MARKET_FIT_FLOOR = 0.34;

export function rankMarketFallbacks(
  niche: string,
  markets: SavedMarket[],
  { floor = MARKET_FIT_FLOOR, limit = 3 }: { floor?: number; limit?: number } = {},
): { market: SavedMarket; score: number }[] {
  return markets
    .filter((m) => m.competitors.some((c) => c.include !== false))
    .map((market) => ({ market, score: marketFitScore(niche, market) }))
    .filter((c) => c.score >= floor)
    .sort((a, b) => b.score - a.score || b.market.updatedAt - a.market.updatedAt)
    .slice(0, limit);
}
