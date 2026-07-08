/**
 * Claude helpers for the Keyword Research tool. Every call is guarded by
 * anthropicConfigured() and has a sensible non-AI fallback, so the tool still
 * runs (on free signals + simple heuristics) when no Anthropic credentials are
 * set. High-volume expansion uses the fast (Haiku) tier; the market read +
 * clustering use the research (Sonnet) tier.
 */
import { anthropicConfigured, claudeJSONForPurpose } from "../ai/claude.js";
import {
  normalizeKeyword,
  type InsightsReport,
  type KeywordCluster,
  type KeywordMetrics,
  type MarketAnalysis,
} from "./types.js";

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

/**
 * Expand a niche/topic description into a handful of seed keywords a creator
 * would actually search for on YouTube. Fast tier. Falls back to the raw topic
 * when AI is unavailable.
 */
export async function expandSeedsFromTopic(topic: string): Promise<string[]> {
  const t = topic.trim();
  if (!t) return [];
  if (!anthropicConfigured()) return [t];
  try {
    const raw = await claudeJSONForPurpose({
      tier: "fast",
      purpose: "keyword-expand",
      system:
        "You expand a YouTube niche/topic into concrete SEED keywords for keyword research. " +
        "Return 8–15 short, distinct search phrases a real viewer would type — mix head terms and " +
        'specific sub-topics. Respond as JSON: {"seeds": ["...", "..."]}.',
      messages: [{ role: "user", content: `Topic/niche: ${t}` }],
    });
    const seeds = asStringArray((JSON.parse(raw) as { seeds?: unknown }).seeds);
    return seeds.length ? seeds : [t];
  } catch {
    return [t];
  }
}

/**
 * Infer the market from free text: the niche overview, target audience, top
 * competitors, content angles, AND a set of seed keywords + competitor names to
 * mine. Research tier. Falls back to a minimal market (built from the free text)
 * when AI is unavailable.
 */
export async function inferMarket(
  freeText: string,
): Promise<{ market: MarketAnalysis; seeds: string[]; competitors: string[] }> {
  const text = freeText.trim();
  const fallback = {
    market: {
      overview: text,
      audience: "",
      topCompetitors: [] as { name: string; note: string }[],
      contentAngles: [] as string[],
    },
    seeds: text ? [text] : [],
    competitors: [] as string[],
  };
  if (!text || !anthropicConfigured()) return fallback;
  try {
    const raw = await claudeJSONForPurpose({
      tier: "research",
      purpose: "keyword-market",
      system:
        "You are a YouTube market analyst. From the user's free-text description, infer the niche and " +
        "return STRICT JSON with this shape: {" +
        '"overview": string, "audience": string, ' +
        '"topCompetitors": [{"name": string, "note": string}], ' +
        '"contentAngles": [string], ' +
        '"seeds": [string], ' +
        '"competitors": [string]' +
        "}. `seeds` are 8–15 concrete search keywords to research. `competitors` are channel names/handles " +
        "worth mining. Keep every string concise.",
      messages: [{ role: "user", content: text }],
    });
    const parsed = JSON.parse(raw) as {
      overview?: unknown;
      audience?: unknown;
      topCompetitors?: unknown;
      contentAngles?: unknown;
      seeds?: unknown;
      competitors?: unknown;
    };
    const topCompetitors = Array.isArray(parsed.topCompetitors)
      ? parsed.topCompetitors
          .map((c: any) => ({ name: String(c?.name ?? "").trim(), note: String(c?.note ?? "").trim() }))
          .filter((c) => c.name)
      : [];
    const market: MarketAnalysis = {
      overview: typeof parsed.overview === "string" && parsed.overview.trim() ? parsed.overview.trim() : text,
      audience: typeof parsed.audience === "string" ? parsed.audience.trim() : "",
      topCompetitors,
      contentAngles: asStringArray(parsed.contentAngles),
    };
    const seeds = asStringArray(parsed.seeds);
    return {
      market,
      seeds: seeds.length ? seeds : [text],
      competitors: asStringArray(parsed.competitors),
    };
  } catch {
    return fallback;
  }
}

/**
 * Group keywords into named topic clusters. Research tier. Falls back to a single
 * "All" cluster when AI is unavailable or fails (still a valid, usable grouping).
 */
export async function clusterKeywords(keywords: string[]): Promise<KeywordCluster[]> {
  const list = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
  if (list.length === 0) return [];
  if (!anthropicConfigured()) return fallbackClusters(list);
  try {
    const raw = await claudeJSONForPurpose({
      tier: "research",
      purpose: "keyword-cluster",
      system:
        "Group the given YouTube keywords into a small number (3–8) of named topic clusters. Every keyword " +
        "must appear in exactly one cluster, using the EXACT input strings. Respond as STRICT JSON: " +
        '{"clusters": [{"name": string, "keywords": [string], "rationale": string}]}.',
      messages: [{ role: "user", content: `Keywords:\n${list.join("\n")}` }],
    });
    const parsed = JSON.parse(raw) as { clusters?: unknown };
    const clusters: KeywordCluster[] = Array.isArray(parsed.clusters)
      ? parsed.clusters
          .map((c: any) => ({
            name: String(c?.name ?? "").trim() || "Cluster",
            keywords: asStringArray(c?.keywords),
            rationale: typeof c?.rationale === "string" ? c.rationale.trim() : undefined,
          }))
          .filter((c) => c.keywords.length > 0)
      : [];

    // Sweep any keyword the model dropped into an "Other" cluster so nothing is
    // lost (clusters must partition the full list).
    const assigned = new Set<string>();
    for (const c of clusters) for (const k of c.keywords) assigned.add(normalizeKeyword(k));
    const missing = list.filter((k) => !assigned.has(normalizeKeyword(k)));
    if (missing.length) clusters.push({ name: "Other", keywords: missing });

    return clusters.length ? clusters : fallbackClusters(list);
  } catch {
    return fallbackClusters(list);
  }
}

/** A single catch-all cluster — the safe grouping when AI is off/unavailable. */
function fallbackClusters(list: string[]): KeywordCluster[] {
  return [{ name: "All keywords", keywords: list }];
}

/**
 * Turn the scored results into an actionable insights report: the opportunity
 * landscape, the best keywords to target (with WHY), concrete video ideas,
 * keywords to avoid, and a series strategy. Research tier. Returns null when AI
 * is unavailable (the UI simply hides the insights panel — the numbers stand on
 * their own). Best-effort: any failure → null.
 */
export async function generateInsights(input: {
  niche: string;
  keywords: KeywordMetrics[];
  clusters: KeywordCluster[];
  market: MarketAnalysis | null;
}): Promise<InsightsReport | null> {
  if (!anthropicConfigured()) return null;
  if (input.keywords.length === 0) return null;

  // Feed a compact, ranked digest (top 30) so the model reasons over real numbers
  // without a huge prompt. Gap flags are spelled out — they're the "why".
  const digest = input.keywords.slice(0, 30).map((k) => {
    const gaps = Object.entries(k.gapFlags)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(",");
    return {
      keyword: k.keyword,
      demand: k.demandScore,
      competition: k.competitionScore,
      opportunity: k.opportunityScore,
      searchVolume: k.searchVolume,
      cluster: k.cluster,
      gaps: gaps || "none",
      topRival: k.topCompetitors[0]?.channelTitle ?? null,
    };
  });

  try {
    const raw = await claudeJSONForPurpose({
      tier: "research",
      purpose: "keyword-insights",
      system:
        "You are a YouTube strategy analyst. Given a niche and its scored keywords (demand/competition/" +
        "opportunity 0–100, optional real monthly searchVolume, gap flags, top rival channel), produce a " +
        "concrete, non-generic strategy. Cite ACTUAL keywords from the data; explain WHY using the scores/gaps " +
        "(e.g. high demand + low competition, small-channel outlier, stale top video). Respond as STRICT JSON: {" +
        '"summary": string, ' +
        '"topOpportunities": [{"keyword": string, "why": string}], ' +
        '"contentIdeas": [{"title": string, "keyword": string, "angle": string}], ' +
        '"avoid": [{"keyword": string, "why": string}], ' +
        '"seriesStrategy": string' +
        "}. 4–6 items in topOpportunities and contentIdeas, up to 4 in avoid. Titles should be real, clickable " +
        "YouTube titles. Keep each string concise.",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            niche: input.niche,
            market: input.market,
            clusters: input.clusters.map((c) => ({ name: c.name, size: c.keywords.length })),
            keywords: digest,
          }),
        },
      ],
    });
    const p = JSON.parse(raw) as Partial<InsightsReport>;
    const pairs = (v: unknown, keys: [string, string]): any[] =>
      Array.isArray(v)
        ? v
            .map((x: any) => ({ [keys[0]]: String(x?.[keys[0]] ?? "").trim(), [keys[1]]: String(x?.[keys[1]] ?? "").trim() }))
            .filter((x: any) => x[keys[0]])
        : [];
    const report: InsightsReport = {
      summary: typeof p.summary === "string" ? p.summary.trim() : "",
      topOpportunities: pairs(p.topOpportunities, ["keyword", "why"]),
      contentIdeas: Array.isArray(p.contentIdeas)
        ? p.contentIdeas
            .map((x: any) => ({
              title: String(x?.title ?? "").trim(),
              keyword: String(x?.keyword ?? "").trim(),
              angle: String(x?.angle ?? "").trim(),
            }))
            .filter((x) => x.title)
        : [],
      avoid: pairs(p.avoid, ["keyword", "why"]),
      seriesStrategy: typeof p.seriesStrategy === "string" ? p.seriesStrategy.trim() : "",
    };
    // Only return if we got something usable.
    if (!report.summary && report.topOpportunities.length === 0 && report.contentIdeas.length === 0) return null;
    return report;
  } catch {
    return null;
  }
}
