/**
 * The audit's AI passes.
 *
 * Split by what each pass actually is, because that decides the model:
 *
 *   LOOKING  — reading what is in a thumbnail. Mechanical extraction, run on
 *              every image in the catalogue and the market's. FAST tier.
 *   THINKING — naming the market, grouping topics. RESEARCH tier.
 *   WRITING  — the renames and the verdicts, which are the deliverable and the
 *              only place judgement is on show. DIRECTOR tier.
 *
 * Running vision on ~800 thumbnails at director rates costs more than the whole
 * rest of the audit; at fast-tier rates it is about a dollar and a half. The
 * correlation between what the images contain and how the videos performed is
 * then plain arithmetic (see analysis.ts) — no expensive model needs to look at
 * a picture to compute a median.
 */
import { claudeJSONForPurpose, claudeVisionLabeledJSON } from "../ai/claude.js";
import { modelForTier } from "../ai/config.js";
import type {
  AuditChannel,
  AuditVideo,
  MarketProposal,
  ProposedCompetitor,
  RenameProposal,
  ThumbnailAttributes,
  AuditFindings,
  ContentFindings,
  GrowthArea,
} from "./types.js";

/** Parse JSON that a model produced, never throwing into the caller's face. */
function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * Today's date, and the channel's recent publishing, stated as fact.
 *
 * A model has no idea what day it is. Left to infer, one reported that the
 * channel had not posted in 30 days — while a video had gone up that morning.
 * That is the kind of wrong that destroys trust in everything around it, and it
 * is free to prevent: say the date, say when the last upload was, and count the
 * recent ones so nothing has to be deduced from a list of timestamps.
 */
export function whenBlock(videos: AuditVideo[], now = Date.now()): string {
  const today = new Date(now).toISOString().slice(0, 10);
  const sorted = [...videos].sort((a, b) => b.publishedAt - a.publishedAt);
  const last = sorted[0];
  const days = (t: number) => Math.floor((now - t) / 86_400_000);
  const in30 = sorted.filter((v) => days(v.publishedAt) <= 30).length;
  const in90 = sorted.filter((v) => days(v.publishedAt) <= 90).length;
  if (!last) return `TODAY IS ${today}. This channel has no uploads.`;
  return `TODAY IS ${today}.
MOST RECENT UPLOAD: ${new Date(last.publishedAt).toISOString().slice(0, 10)} — ${days(last.publishedAt)} day(s) ago — "${clip(last.title, 70)}".
UPLOADS IN THE LAST 30 DAYS: ${in30}. IN THE LAST 90: ${in90}.
Do not infer dates or publishing frequency from anything else; these are the facts.`;
}

/** The operator's own framing, when they gave one. Their read of their channel beats ours. */
export function angleBlock(angle?: string): string {
  return angle && angle.trim()
    ? `\n\nTHE CREATOR'S OWN FRAMING OF THIS CHANNEL — treat this as authoritative about intent, and weight the analysis toward it:\n"${angle.trim()}"\n`
    : "";
}

// ── 1. What market is this channel in, and who is in it with it ─────────────

const MARKET_SYSTEM = `You identify the real market a YouTube channel competes in, and the searches that would find its competitors.

You will be given a channel and a sample of its catalogue with view counts. Work out what it is ACTUALLY about — not what its bio claims, and not the broadest category it could belong to. "AI automation tutorials for solo operators" is a market; "technology" is not.

DO NOT NAME COMPETITOR CHANNELS. You do not reliably know which channels exist, and a name you half-remember becomes a wrong comparison in someone's report. Instead give the SEARCH QUERIES that would surface them — the phrases a viewer of this channel would actually type. Those searches are run against YouTube and the real channels that rank are collected for you to judge afterwards.

Return JSON:
{
  "niche": "short label",
  "nicheDescription": "one or two sentences on what this market is",
  "subjectSummary": "what THIS channel is about, in one or two sentences",
  "audience": "who watches this",
  "searchQueries": ["5 to 6 phrases a viewer would search for this kind of video"]
}

Make the queries specific enough to find this market and general enough to have competition — "make.com lead scraping tutorial" not "how to use make.com scenario router with webhooks".`;

export async function proposeMarket(
  channel: AuditChannel,
  videos: AuditVideo[],
  angle?: string,
): Promise<{ market: MarketProposal; searchQueries: string[] }> {
  // The best and worst performers say far more about a market than the newest
  // ones do, so the sample is drawn from both ends rather than the top of the list.
  const judged = videos.filter((v) => v.judged && v.format === "long");
  const sorted = [...judged].sort((a, b) => b.eraMultiple - a.eraMultiple);
  const sample = [...sorted.slice(0, 25), ...sorted.slice(-15)];

  const lines = sample
    .map((v) => `${v.eraMultiple.toFixed(1)}x  ${v.views.toLocaleString()} views  ${clip(v.title, 90)}`)
    .join("\n");

  const raw = await claudeJSONForPurpose({
    tier: "research",
    purpose: "audit-market",
    system: MARKET_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Channel: ${channel.title}${channel.handle ? ` (@${channel.handle})` : ""}
Subscribers: ${channel.subscriberCount?.toLocaleString() ?? "unknown"}
Videos: ${channel.videoCount ?? videos.length}

${whenBlock(videos)}${angleBlock(angle)}

Catalogue sample — "Nx" is how the video did against others published around the same time, so 1.0x is par for its moment:

${lines}`,
      },
    ],
  });

  const got = parse<Partial<MarketProposal> & { searchQueries?: any[] }>(raw, {});

  return {
    market: {
      niche: String(got.niche ?? "Unknown niche"),
      nicheDescription: String(got.nicheDescription ?? ""),
      subjectSummary: String(got.subjectSummary ?? ""),
      audience: String(got.audience ?? ""),
      competitors: [], // filled in from real search results, never from memory
    },
    searchQueries: (Array.isArray(got.searchQueries) ? got.searchQueries : []).map(String).filter(Boolean),
  };
}

const PICK_SYSTEM = `You choose which of these REAL YouTube channels are genuine competitors to a subject channel.

Every channel listed was found by searching YouTube for what the subject's videos are about, so they all exist and all rank for something relevant. Your job is to separate real competitors from coincidental matches: a channel that ranked once for a phrase but serves a different audience is not a competitor, and neither is a general-interest channel that happens to have covered the topic.

Return JSON:
{ "competitors": [ { "channelId": "the id exactly as given", "reason": "why this is a genuine competitor, one line" } ] }

Pick 6 to 8. Prefer channels that ranked for several different searches and serve the same audience at a comparable size. If fewer than six are genuinely comparable, return fewer — a padded list makes the market analysis worse, not more thorough.`;

/** Choose the real competitors from what the searches actually turned up. */
export async function pickCompetitors(
  subject: AuditChannel,
  niche: string,
  discovered: {
    channelId: string;
    title: string;
    subscriberCount: number | null;
    appearances: number;
    rankingTitles: string[];
  }[],
): Promise<ProposedCompetitor[]> {
  if (!discovered.length) return [];

  const list = discovered
    .map(
      (d) =>
        `${d.channelId} | ${d.title} | ${d.subscriberCount?.toLocaleString() ?? "hidden"} subs | ranked in ${d.appearances} search(es)\n     e.g. ${d.rankingTitles.slice(0, 2).map((t) => clip(t, 70)).join(" / ")}`,
    )
    .join("\n");

  const raw = await claudeJSONForPurpose({
    tier: "research",
    purpose: "audit-market",
    system: PICK_SYSTEM,
    messages: [
      {
        role: "user",
        content: `SUBJECT: ${subject.title} — ${subject.subscriberCount?.toLocaleString() ?? "?"} subscribers\nMARKET: ${niche}\n\nCHANNELS FOUND BY SEARCH:\n${list}`,
      },
    ],
  });

  const got = parse<{ competitors?: any[] }>(raw, {});
  const byId = new Map(discovered.map((d) => [d.channelId, d]));
  const out: ProposedCompetitor[] = [];
  for (const c of got.competitors ?? []) {
    const d = byId.get(String(c?.channelId ?? ""));
    if (!d) continue; // only ever a channel we actually found
    out.push({
      channelId: d.channelId,
      handle: null,
      title: d.title,
      reason: String(c?.reason ?? ""),
      subscriberCount: d.subscriberCount,
      include: true,
    });
  }
  return out;
}

// ── 2. What is actually in the thumbnails ───────────────────────────────────

const THUMB_SYSTEM = `You report what is visibly in YouTube thumbnails. You are a pair of eyes, not a critic: describe, do not advise, do not guess at quality.

For each image, in the order given, return one object:
{
  "face": "none" | "small" | "medium" | "dominant",
  "expression": "one or two words, or null if no face",
  "textWordCount": integer count of words burned into the image (0 if none),
  "textContent": "the largest text as written, or null",
  "colourEnergy": "muted" | "moderate" | "vivid",
  "clutter": "clean" | "moderate" | "busy",
  "subject": "what the image is mainly showing, 1-4 words",
  "notes": "anything else doing visual work, or omit"
}

Return {"thumbnails": [ ... ]} with exactly one object per image, in order. If an image is unreadable, still emit an object with "face":"none" and "subject":"unreadable" so the positions stay aligned.`;

/** How many images go in one vision call. Big enough to be cheap, small enough that one bad image does not cost the batch. */
export const THUMBNAIL_BATCH = 8;

/**
 * Read a batch of thumbnails.
 *
 * Positional: the Nth result belongs to the Nth video. A model that returns the
 * wrong number of objects would otherwise silently shift every attribute onto
 * the wrong video and quietly corrupt every correlation downstream — so a
 * length mismatch drops the batch instead.
 */
export async function readThumbnails(
  images: { videoId: string; data: string; mediaType: string }[],
): Promise<Map<string, ThumbnailAttributes>> {
  const out = new Map<string, ThumbnailAttributes>();
  if (!images.length) return out;

  const raw = await claudeVisionLabeledJSON({
    system: THUMB_SYSTEM,
    userText: `Describe these ${images.length} thumbnails, one object each, in order.`,
    images: images.map((im, i) => ({
      label: `Thumbnail ${i + 1}:`,
      data: im.data,
      mediaType: im.mediaType as any,
    })),
    purpose: "audit-thumbnail",
    // Looking, not thinking — this is what keeps vision-on-everything affordable.
    model: modelForTier("fast"),
  });

  const got = parse<{ thumbnails?: any[] }>(raw, {});
  const rows = Array.isArray(got.thumbnails) ? got.thumbnails : [];
  if (rows.length !== images.length) return out; // misaligned: trust none of it

  rows.forEach((r, i) => {
    out.set(images[i].videoId, {
      face: ["none", "small", "medium", "dominant"].includes(r?.face) ? r.face : "none",
      expression: typeof r?.expression === "string" ? r.expression : null,
      textWordCount: Number.isFinite(Number(r?.textWordCount)) ? Math.max(0, Number(r.textWordCount)) : 0,
      textContent: typeof r?.textContent === "string" ? r.textContent : null,
      colourEnergy: ["muted", "moderate", "vivid"].includes(r?.colourEnergy) ? r.colourEnergy : "moderate",
      clutter: ["clean", "moderate", "busy"].includes(r?.clutter) ? r.clutter : "moderate",
      subject: typeof r?.subject === "string" ? r.subject : "unknown",
      notes: typeof r?.notes === "string" ? r.notes : undefined,
    });
  });
  return out;
}

// ── 3. Topics, and what the market rewards that this channel does not ───────

const TOPICS_SYSTEM = `You group a YouTube catalogue into topics and find what is missing.

You get the subject channel's videos with their performance, then the market's best-performing videos from competing channels. "Nx" means how a video did against others published around the same time on its own channel — 1.0x is par, so 4x is a genuine hit rather than just a big channel.

Return JSON:
{
  "topics": [ { "topic": "short label", "videoIds": ["..."], "marketVideoIds": ["..."], "note": "one line on how this topic does" } ],
  "gaps": [ { "topic": "label", "evidence": "why the market shows appetite for this", "marketExamples": ["competitor video titles that prove it"] } ]
}

Assign the MARKET videos to the same topics too, by id, in "marketVideoIds". This is what makes it possible to say where the channel owns a subject and where the market is winning one it barely touches — a topic with no market videos assigned cannot be compared, so do assign them wherever they genuinely fit. A market video that fits no topic is simply left out.

Rules that matter:
- A gap must be something the MARKET rewards and this channel barely touches. A topic nobody is winning with is not a gap, it is an empty room.
- Ground every gap in named competitor videos that actually did well. No evidence, no gap.
- Do not invent topics to be comprehensive. Six to twelve real topics beats twenty thin ones.`;

export async function clusterTopics(
  subject: AuditChannel,
  videos: AuditVideo[],
  marketVideos: AuditVideo[],
  competitorNames: Map<string, string>,
  angle?: string,
): Promise<{
  topics: { topic: string; videoIds: string[]; marketVideoIds: string[]; note: string }[];
  gaps: ContentFindings["gaps"];
}> {
  const own = videos
    .filter((v) => v.format === "long")
    .map((v) => `${v.videoId} | ${v.eraMultiple.toFixed(1)}x | ${clip(v.title, 90)}`)
    .join("\n");
  const market = marketVideos
    .slice(0, 120)
    .map((v) => `${v.videoId} | ${v.eraMultiple.toFixed(1)}x | ${v.views.toLocaleString()} views | ${competitorNames.get(v.channelId) ?? "competitor"} | ${clip(v.title, 90)}`)
    .join("\n");

  const raw = await claudeJSONForPurpose({
    tier: "research",
    purpose: "audit-topics",
    system: TOPICS_SYSTEM,
    messages: [
      {
        role: "user",
        content: `SUBJECT CHANNEL: ${subject.title}\n\n${whenBlock(videos)}${angleBlock(angle)}\n\nIts catalogue:\n${own}\n\nTHE MARKET'S BEST PERFORMERS:\n${market}`,
      },
    ],
  });

  const got = parse<{ topics?: any[]; gaps?: any[] }>(raw, {});
  return {
    topics: (got.topics ?? []).map((t: any) => ({
      topic: String(t?.topic ?? "Unlabelled"),
      videoIds: Array.isArray(t?.videoIds) ? t.videoIds.map(String) : [],
      marketVideoIds: Array.isArray(t?.marketVideoIds) ? t.marketVideoIds.map(String) : [],
      note: String(t?.note ?? ""),
    })),
    gaps: (got.gaps ?? []).map((g: any) => ({
      topic: String(g?.topic ?? ""),
      evidence: String(g?.evidence ?? ""),
      marketExamples: Array.isArray(g?.marketExamples) ? g.marketExamples.map(String) : [],
    })),
  };
}

// ── 4. The renames ──────────────────────────────────────────────────────────

const RENAME_SYSTEM = `You rewrite YouTube titles for videos that under-performed, and you justify every one with evidence.

You get: what wins and loses on this channel (measured, with sample sizes), real outlier titles from the market, and a batch of videos to retitle. "Nx" is performance against videos published around the same time — 1.0x is par.

For each video return:
{
  "videoId": "...",
  "proposed": "the new title",
  "rationale": "one sentence: what was wrong and what this fixes",
  "modelledOnTitle": "the market outlier this borrows from, or null",
  "keywords": ["the search terms this targets"],
  "changeLevel": "minor" | "moderate" | "rewrite"
}

Rules:
- THE VIDEO'S CONTENT IS FIXED. A title that promises something the video does not contain is worse than the original — it converts a click into a bounce and teaches the algorithm the video disappoints. Retitle what the video IS.
- Borrow STRUCTURE from outliers, never their words. Copying a competitor's title verbatim is theft and it will not fit this video anyway.
- Respect what the measurements say about this channel. If numbered lists under-perform here, do not propose one because they usually work elsewhere.
- Keep it under about 70 characters or YouTube truncates it in most surfaces.
- No clickbait that the video cannot cash. No ALL CAPS unless this channel's own data shows shouted words work.
- If the existing title is genuinely fine and the video under-performed for other reasons, say so: return the original as "proposed" with changeLevel "minor" and a rationale explaining that the title is not the problem.

Return {"renames": [ ... ]} with one object per video given, in order.`;

export async function proposeRenames(
  batch: AuditVideo[],
  context: {
    channelTitle: string;
    niche: string;
    winning: { pattern: string; medianMultiple: number; sampleSize: number }[];
    losing: { pattern: string; medianMultiple: number; sampleSize: number }[];
    outlierTitles: { title: string; channelTitle: string; eraMultiple: number }[];
  },
): Promise<Map<string, RenameProposal>> {
  const out = new Map<string, RenameProposal>();
  if (!batch.length) return out;

  const evidence = [
    context.winning.length
      ? `Patterns that WIN on this channel:\n${context.winning.map((w) => `  ${w.medianMultiple.toFixed(2)}x  ${w.pattern}  (n=${w.sampleSize})`).join("\n")}`
      : "No title pattern has enough data to call a winner on this channel.",
    context.losing.length
      ? `Patterns that LOSE here:\n${context.losing.map((w) => `  ${w.medianMultiple.toFixed(2)}x  ${w.pattern}  (n=${w.sampleSize})`).join("\n")}`
      : "",
    context.outlierTitles.length
      ? `Market outliers worth borrowing STRUCTURE from:\n${context.outlierTitles.slice(0, 25).map((o) => `  ${o.eraMultiple.toFixed(1)}x  [${o.channelTitle}]  ${clip(o.title, 90)}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const videos = batch
    .map((v) => `${v.videoId} | ${v.eraMultiple.toFixed(2)}x | ${v.views.toLocaleString()} views | ${clip(v.title, 110)}`)
    .join("\n");

  const raw = await claudeJSONForPurpose({
    tier: "director",
    purpose: "audit-rename",
    system: RENAME_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Channel: ${context.channelTitle}\nMarket: ${context.niche}\n\n${evidence}\n\nRETITLE THESE ${batch.length} VIDEOS:\n${videos}`,
      },
    ],
  });

  const got = parse<{ renames?: any[] }>(raw, {});
  const byId = new Map(batch.map((v) => [v.videoId, v]));

  for (const r of got.renames ?? []) {
    const id = String(r?.videoId ?? "");
    const video = byId.get(id);
    if (!video || typeof r?.proposed !== "string" || !r.proposed.trim()) continue;

    const modelTitle = typeof r?.modelledOnTitle === "string" ? r.modelledOnTitle : null;
    const matched = modelTitle
      ? context.outlierTitles.find((o) => o.title.toLowerCase().includes(modelTitle.toLowerCase().slice(0, 25)))
      : undefined;

    out.set(id, {
      proposed: r.proposed.trim(),
      rationale: String(r?.rationale ?? ""),
      modelledOn: matched
        ? { videoId: "", title: matched.title, channelTitle: matched.channelTitle, eraMultiple: matched.eraMultiple }
        : null,
      keywords: (Array.isArray(r?.keywords) ? r.keywords : []).map((k: any) => ({
        text: String(k),
        searchVolume: null, // filled in later when a volume source is available
      })),
      changeLevel: ["minor", "moderate", "rewrite"].includes(r?.changeLevel) ? r.changeLevel : "moderate",
      priority: 0, // set by the caller from analysis.renamePriority
    });
  }
  return out;
}

// ── 5. The verdicts ─────────────────────────────────────────────────────────

const REPORT_SYSTEM = `You write the conclusions of a YouTube channel audit, over measurements that have already been made.

You will be given computed findings: title pattern performance, thumbnail attribute correlations, topic performance, market gaps, and where this channel ranks. Your job is to say what they MEAN, not to invent new facts.

Return JSON:
{
  "titlesVerdict": "...",
  "thumbnailsVerdict": "...",
  "contentVerdict": "...",
  "positionVerdict": "...",
  "strengths": ["..."],
  "weaknesses": ["..."],
  "growth": [ { "title": "...", "action": "what to do, concretely", "evidence": "the measurement this rests on", "effort": "low|medium|high", "confidence": "low|medium|high" } ],
  "summary": "the whole audit in one short paragraph"
}

Rules:
- CITE THE NUMBERS YOU WERE GIVEN. "Numbered lists do 1.8x here across 11 videos" is useful; "listicles perform well" is filler.
- Where a sample is small, say so and mark the confidence low. A finding from five videos is a hint, not a fact.
- If the data does not support a conclusion, say there is not enough evidence. An honest gap is worth more than a confident guess, and the operator is going to act on this.
- Growth areas must follow from the evidence given, not from general YouTube advice. Four good ones beat ten generic ones.
- Write plainly. No hype, no "leverage", no "unlock".\n- NEVER state or imply a date, an upload gap or a posting frequency that is not in the facts you were given.`;

export async function writeReport(input: {
  channel: AuditChannel;
  niche: string;
  mode: "own" | "teardown";
  computed: Omit<AuditFindings, "summary" | "growth" | "actionPlan"> & { growthHints?: string[] };
  videos?: AuditVideo[];
  angle?: string;
}): Promise<{
  verdicts: { titles: string; thumbnails: string; content: string; position: string };
  strengths: string[];
  weaknesses: string[];
  growth: GrowthArea[];
  summary: string;
}> {
  const c = input.computed;
  const raw = await claudeJSONForPurpose({
    tier: "director",
    purpose: "audit-report",
    system: REPORT_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Channel: ${input.channel.title} (${input.channel.subscriberCount?.toLocaleString() ?? "?"} subs)
Market: ${input.niche}
${input.videos ? whenBlock(input.videos) : ""}${angleBlock(input.angle)}
This report is written ${input.mode === "own" ? "FOR the channel's owner, who will act on it" : "ABOUT a competitor, as a diagnosis"}.

TITLE PATTERNS (median multiple, sample size):
winning: ${JSON.stringify(c.titles.winning)}
losing: ${JSON.stringify(c.titles.losing)}

THUMBNAIL CORRELATIONS (with vs without):
${JSON.stringify(c.thumbnails.correlations)}

TOPICS:
${JSON.stringify(c.content.topics)}

MARKET GAPS:
${JSON.stringify(c.content.gaps)}

POSITION: rank ${c.position.subscriberRank} of ${c.position.competitorCount + 1} by subscribers, rank ${c.position.medianViewsRank} by median views.

GROWTH SHAPE (median views by age):
${JSON.stringify(c.ageCurve)}`,
      },
    ],
  });

  const got = parse<any>(raw, {});
  return {
    verdicts: {
      titles: String(got?.titlesVerdict ?? ""),
      thumbnails: String(got?.thumbnailsVerdict ?? ""),
      content: String(got?.contentVerdict ?? ""),
      position: String(got?.positionVerdict ?? ""),
    },
    strengths: Array.isArray(got?.strengths) ? got.strengths.map(String) : [],
    weaknesses: Array.isArray(got?.weaknesses) ? got.weaknesses.map(String) : [],
    growth: (Array.isArray(got?.growth) ? got.growth : []).map((g: any) => ({
      title: String(g?.title ?? ""),
      action: String(g?.action ?? ""),
      evidence: String(g?.evidence ?? ""),
      effort: ["low", "medium", "high"].includes(g?.effort) ? g.effort : "medium",
      confidence: ["low", "medium", "high"].includes(g?.confidence) ? g.confidence : "medium",
    })),
    summary: String(got?.summary ?? ""),
  };
}


// ── 6. The action plan ──────────────────────────────────────────────────────

const PLAN_SYSTEM = `You write the action plan at the end of a YouTube channel audit: how this channel becomes the best in each category it competes in.

You get the measured findings — which title constructions win here and by how much, which thumbnail attributes correlate with performance, how each topic performs, where the market is rewarded for things this channel barely covers, and the market's actual outlier titles.

For each category, say what "best in this category" looks like and how to get there. Be specific enough to act on today.

Return JSON:
{
  "categories": [
    {
      "name": "the category or topic",
      "standing": "where this channel stands in it now, citing a number from the findings",
      "target": "what being the best in it looks like, concretely",
      "titleFormulas": ["a reusable formula with a filled-in example, e.g. 'How to X in N minutes (no Y)' — \"How to Scrape 10k Leads in 9 Minutes (No Code)\""],
      "thumbnails": ["a concrete design rule tied to a measured correlation"],
      "topics": ["a specific video to make, not a subject area"],
      "firstThree": ["the next three videos to publish, in order"]
    }
  ],
  "ninetyDays": ["ordered steps for the next 90 days"],
  "stopDoing": ["things the data says are not working, with the number"]
}

Rules that decide whether this is worth reading:
- EVERY claim cites a measurement you were given. "Numbered lists do 1.9x here across 14 videos, so lead with a number" is useful. "Use compelling titles" is filler and worse than nothing.
- Title formulas must be FORMULAS — a reusable shape plus one filled-in example. Not a list of titles, not vague advice.
- Thumbnail rules must come from the correlations. If the correlations are empty, say there is not enough evidence to advise on thumbnails rather than repeating general YouTube lore.
- Topics must be specific videos someone could film this week.
- Where the evidence is thin, say so and mark it. A confident plan built on five videos is how people waste a quarter.
- Three to six categories. Cover what matters, not everything.
- No hype. No "leverage", "unlock", "crush it".`;

/** Turn the findings into what to actually do, per category. */
export async function writeActionPlan(input: {
  channel: AuditChannel;
  niche: string;
  findings: AuditFindings;
  marketOutliers: { title: string; channelTitle: string; views: number }[];
  videos: AuditVideo[];
  angle?: string;
}): Promise<AuditFindings["actionPlan"]> {
  const f = input.findings;
  const raw = await claudeJSONForPurpose({
    tier: "director",
    purpose: "audit-plan",
    system: PLAN_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Channel: ${input.channel.title} — ${input.channel.subscriberCount?.toLocaleString() ?? "?"} subscribers
Market: ${input.niche}
${whenBlock(input.videos)}${angleBlock(input.angle)}

WHAT THE AUDIT MEASURED

Title patterns that win: ${JSON.stringify(f.titles.winning)}
Title patterns that lose: ${JSON.stringify(f.titles.losing)}
Thumbnail correlations (with vs without): ${JSON.stringify(f.thumbnails.correlations)}
Topics (yours vs the market's coverage of the same topic): ${JSON.stringify(f.content.topics)}
Market gaps: ${JSON.stringify(f.content.gaps)}
Position: rank ${f.position.subscriberRank} of ${f.position.competitorCount + 1} by subscribers, ${f.position.medianViewsRank} by median views
Strengths: ${JSON.stringify(f.position.strengths)}
Weaknesses: ${JSON.stringify(f.position.weaknesses)}
Growth areas already identified: ${JSON.stringify(f.growth)}

THE MARKET'S OUTLIER TITLES (borrow structure, never words):
${input.marketOutliers.slice(0, 25).map((o) => `  ${o.views.toLocaleString()} | ${o.channelTitle} | ${clip(o.title, 90)}`).join("\n")}`,
      },
    ],
  });

  const got = parse<any>(raw, {});
  const arr = (v: any) => (Array.isArray(v) ? v.map(String) : []);
  return {
    categories: (Array.isArray(got?.categories) ? got.categories : []).map((c: any) => ({
      name: String(c?.name ?? ""),
      standing: String(c?.standing ?? ""),
      target: String(c?.target ?? ""),
      titleFormulas: arr(c?.titleFormulas),
      thumbnails: arr(c?.thumbnails),
      topics: arr(c?.topics),
      firstThree: arr(c?.firstThree),
    })),
    ninetyDays: arr(got?.ninetyDays),
    stopDoing: arr(got?.stopDoing),
  };
}
