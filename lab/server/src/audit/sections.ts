/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CUSTOM REPORT SECTIONS — the operator asks, the report grows a part.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A fixed report answers the questions its author thought of. The person who
 * made the videos has better questions, and they arrive after they have read
 * it: "which of my Shorts actually travelled?", "am I posting less than the
 * people beating me?". This turns any of those into a real section of the
 * report — prose, charts and all — without anyone editing this file.
 *
 * THREE RULES, and they are what separate this from a chatbot that draws.
 *
 * 1. TWO PASSES, NOT ONE. The model first designs the section — a title and a
 *    handful of QUERIES. The server computes those queries. Only then does the
 *    model write, with the real figures in front of it. A single pass would
 *    have it writing prose and inventing the numbers to match, and the prose
 *    would always agree with the chart because both came out of the same guess.
 *
 * 2. IT NEVER SUPPLIES A NUMBER. Every figure in a section comes from
 *    series.ts, computed from the run's stored data. The model chooses what to
 *    measure and what it means; it cannot choose what the measurement says.
 *
 * 3. IT CAN GO AND GET MORE. If answering needs data the run doesn't have —
 *    thumbnails the vision pass never read, transcripts nobody fetched — it
 *    says so, the server gathers it, and the gathering is written into the
 *    section so the reader knows what the answer cost and what it rests on.
 *
 * Sections are additive and never touch the findings. A refocus rewrites the
 * report; this only ever appends to it.
 */
import { nanoid } from "nanoid";
import { claudeJSONWithModel } from "../ai/claude.js";
import { CHAT_MODEL } from "./chat.js";
import { fetchThumbnails } from "./images.js";
import { readThumbnails, THUMBNAIL_BATCH } from "./ai.js";
import { gatherContent, readContent, transcriptsAvailable } from "./content.js";
import { outliers } from "./baseline.js";
import {
  buildSeries,
  describeAvailableData,
  formFor,
  SERIES_DIMENSIONS,
  SERIES_MEASURES,
  SERIES_SCOPES,
  type AuditSeriesQuery,
  type SeriesContext,
  type SeriesDimension,
  type SeriesMeasure,
  type SeriesScope,
} from "./series.js";

import type {
  AuditChartData,
  AuditChartSpec,
  AuditReportSection,
  AuditRunResult,
  AuditVideo,
} from "./types.js";

// The form a chart takes is derived from its query, so it lives with the query
// logic in series.ts. Re-exported here because this is where callers look.
export { formFor, type ChartForm } from "./series.js";

/** How many charts a section may carry. More than three stops being a section. */
const MAX_CHARTS = 3;

/** Market videos read for content when a section asks for it. */
const CONTENT_TOP_UP = 12;

/* ── what the section writer is allowed to go and fetch ──────────────────── */

export const DATA_NEEDS = ["thumbnails", "content"] as const;
export type DataNeed = (typeof DATA_NEEDS)[number];

const NEED_DESCRIPTION: Record<DataNeed, string> = {
  thumbnails:
    "thumbnails — run the vision pass over any thumbnail on this run that has not been read yet, " +
    "so questions about faces, on-image text, colour and clutter can be answered across the whole set. " +
    "Costs a cheap vision call per batch of images and no YouTube quota.",
  content:
    "content — fetch transcripts and top comments for market outliers nobody has read yet, " +
    "so questions about how the winners open, what they deliver and what their viewers asked for " +
    "can be answered. Costs about one YouTube quota unit per video.",
};

/* ── the plan ─────────────────────────────────────────────────────────────── */

const PLAN_SYSTEM = `You are designing ONE new section for a finished YouTube channel audit, for the person whose channel it is.

You do not write the section yet. You decide what it should MEASURE. The server computes every number and hands the results back to you afterwards to write from — so ask for the right measurements and nothing else.

Return JSON:
{
  "title": "the section's heading, plain and specific",
  "gather": [],
  "charts": [
    { "workingTitle": "what this chart shows", "query": { ... } }
  ],
  "decline": null
}

A query is:
{
  "scope": "own" | "market" | "compare",
  "groupBy": <dimension>,
  "measure": <measure>,
  "filter": { "format": "long" | "short" | null, "judgedOnly": true, "sinceDays": null, "topics": null },
  "limit": 12,
  "minSampleSize": 3
}

Rules:
- One to three charts. Every section must have at least one. A section with no chart is not a section.
- Only use a dimension or measure from the lists below, spelled exactly.
- Only group by something the DATA AVAILABLE block says exists. If it says no topic membership is recorded, do not group by topic.
- "compare" puts this channel and the market side by side on the same measure. Use it for "am I behind on X" questions.
- THE MARKET SET IS ONLY THE COMPETITORS' OVER-PERFORMERS, not their whole catalogues. So "medianEraMultiple" is REFUSED for the market and compare scopes — those videos were selected for having a high era multiple, so measuring it there measures the selection. Compare on medianViews instead, and keep medianEraMultiple for this channel alone.
- Prefer judgedOnly true. A video too young to judge is not evidence.
- Keep minSampleSize at 3 or more unless grouping by video. A median over two videos is not a finding.
- Ask to "gather" only when the section genuinely cannot be answered without it. It costs the operator money and time.
- If the request cannot be answered from this audit at all, set "decline" to one plain sentence saying why, and return no charts. Do not invent a way to almost answer it.`;

interface SectionPlan {
  title: string;
  gather: DataNeed[];
  charts: { workingTitle: string; query: AuditSeriesQuery }[];
  decline: string | null;
}

const asOneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(String(value) as T) ? (String(value) as T) : fallback;

function coerceQuery(raw: any): AuditSeriesQuery {
  const filter = raw?.filter ?? {};
  const sinceDays = Number(filter?.sinceDays);
  return {
    scope: asOneOf<SeriesScope>(raw?.scope, SERIES_SCOPES, "own"),
    groupBy: asOneOf<SeriesDimension>(raw?.groupBy, SERIES_DIMENSIONS, "topic"),
    measure: asOneOf<SeriesMeasure>(raw?.measure, SERIES_MEASURES, "medianEraMultiple"),
    filter: {
      format: filter?.format === "short" || filter?.format === "long" ? filter.format : null,
      judgedOnly: filter?.judgedOnly !== false,
      sinceDays: Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : null,
      topics: Array.isArray(filter?.topics) && filter.topics.length ? filter.topics.map(String) : null,
    },
    limit: Number.isFinite(Number(raw?.limit)) ? Math.max(1, Math.min(30, Number(raw.limit))) : 12,
    minSampleSize: Number.isFinite(Number(raw?.minSampleSize)) ? Math.max(1, Number(raw.minSampleSize)) : 3,
  };
}

function reportContext(run: AuditRunResult): string {
  const f = run.findings;
  return [
    `CHANNEL: ${run.subject?.title ?? "?"} — ${run.subject?.subscriberCount?.toLocaleString() ?? "?"} subscribers`,
    `MARKET: ${run.approved?.niche ?? run.proposal?.niche ?? "unknown"}`,
    f?.summary ? `\nWHAT THE REPORT ALREADY CONCLUDED:\n${f.summary}` : "",
    f?.titles.verdict ? `\nON TITLES: ${f.titles.verdict}` : "",
    f?.thumbnails.verdict ? `\nON THUMBNAILS: ${f.thumbnails.verdict}` : "",
    f?.content.verdict ? `\nON TOPICS: ${f.content.verdict}` : "",
    run.sections?.length
      ? `\nSECTIONS ALREADY ADDED (do not repeat these): ${run.sections.map((s) => s.title).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function planSection(run: AuditRunResult, request: string, ctx: SeriesContext): Promise<SectionPlan> {
  const raw = await claudeJSONWithModel({
    model: CHAT_MODEL,
    purpose: "audit-section",
    system: PLAN_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          reportContext(run),
          `\nDATA AVAILABLE:\n${describeAvailableData(ctx)}`,
          `\nDIMENSIONS: ${SERIES_DIMENSIONS.join(", ")}`,
          `MEASURES: ${SERIES_MEASURES.join(", ")}`,
          `\nCAN BE GATHERED IF NEEDED:\n${DATA_NEEDS.map((n) => `- ${NEED_DESCRIPTION[n]}`).join("\n")}`,
          `\nTHE REQUEST: ${request}`,
        ].join("\n"),
      },
    ],
  });

  let got: any = {};
  try {
    got = JSON.parse(raw);
  } catch {
    return { title: "", gather: [], charts: [], decline: "I could not design that section — try asking for it differently." };
  }

  const decline = typeof got?.decline === "string" && got.decline.trim() ? got.decline.trim() : null;
  const charts = (Array.isArray(got?.charts) ? got.charts : []).slice(0, MAX_CHARTS).map((c: any) => ({
    workingTitle: String(c?.workingTitle ?? "").trim() || "Chart",
    query: coerceQuery(c?.query),
  }));

  return {
    title: String(got?.title ?? "").trim() || "New section",
    gather: (Array.isArray(got?.gather) ? got.gather : [])
      .map((g: any) => String(g))
      .filter((g: string): g is DataNeed => (DATA_NEEDS as readonly string[]).includes(g)),
    charts,
    decline: decline ?? (charts.length ? null : "That question cannot be answered from this audit's data."),
  };
}

/* ── going back for more data ─────────────────────────────────────────────── */

export interface GatherOutcome {
  /** One line per source, for the section's provenance list. */
  notes: string[];
  quotaUnits: number;
  /** Replacement videos, when a gatherer enriched them. */
  videos?: AuditVideo[];
  marketVideos?: AuditVideo[];
  /** Prose-only evidence, handed to the writer but not chartable. */
  contentNotes?: string[];
}

/**
 * Read every thumbnail on this run that the vision pass never saw.
 *
 * The main run reads the whole catalogue, so this is usually a no-op — it earns
 * its place on a re-opened old run, or when a batch failed mid-pass and the
 * correlations quietly went on with a hole in them.
 */
async function gatherThumbnails(ctx: SeriesContext): Promise<GatherOutcome> {
  const missing = [...ctx.videos, ...ctx.marketVideos].filter((v) => !v.thumbnail);
  if (!missing.length) {
    return { notes: ["Every thumbnail on this run had already been read — nothing to fetch."], quotaUnits: 0 };
  }
  const images = await fetchThumbnails(missing.map((v) => ({ videoId: v.videoId, thumbnailUrl: v.thumbnailUrl })));
  const attributes = new Map<string, NonNullable<AuditVideo["thumbnail"]>>();
  let failed = 0;
  for (let i = 0; i < images.length; i += THUMBNAIL_BATCH) {
    try {
      for (const [id, attrs] of await readThumbnails(images.slice(i, i + THUMBNAIL_BATCH))) {
        attributes.set(id, attrs);
      }
    } catch {
      failed += 1;
    }
  }
  const fill = (v: AuditVideo): AuditVideo => (v.thumbnail ? v : { ...v, thumbnail: attributes.get(v.videoId) });
  return {
    notes: [
      `Read ${attributes.size} thumbnail${attributes.size === 1 ? "" : "s"} that had not been looked at before` +
        (failed ? `; ${failed} batch(es) failed and those images are still unread.` : "."),
    ],
    quotaUnits: 0,
    videos: ctx.videos.map(fill),
    marketVideos: ctx.marketVideos.map(fill),
  };
}

/**
 * Fetch transcripts + top comments for market outliers nobody has read.
 *
 * Prose evidence only — it makes the writing specific ("three of the five
 * openers state the payoff in the first sentence") rather than adding a chart.
 */
async function gatherContentForSection(ctx: SeriesContext): Promise<GatherOutcome> {
  const names = new Map(ctx.competitors.map((c) => [c.channelId, c.title]));
  const targets = outliers(ctx.marketVideos, "long", 1.5)
    .slice(0, CONTENT_TOP_UP)
    .map((v) => ({
      videoId: v.videoId,
      title: v.title,
      channelTitle: names.get(v.channelId) ?? "market",
      views: v.views,
    }));
  if (!targets.length) {
    return { notes: ["No market outliers were available to read."], quotaUnits: 0 };
  }

  const { items, quotaUnits, transcripts } = await gatherContent(targets);
  const reads = await readContent(items);
  const contentNotes: string[] = [];
  for (const [videoId, read] of reads) {
    const v = targets.find((t) => t.videoId === videoId);
    if (!v) continue;
    contentNotes.push(
      [
        `"${v.title}" (${v.channelTitle}, ${v.views.toLocaleString()} views)`,
        read.hook ? `  opens: ${read.hook}` : "",
        read.payoffAt ? `  delivers the promise: ${read.payoffAt}` : "",
        read.praised?.length ? `  commenters praised: ${read.praised.slice(0, 3).join("; ")}` : "",
        read.viewerAsks?.length ? `  viewers asked for: ${read.viewerAsks.slice(0, 3).join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return {
    notes: [
      `Read ${reads.size} market outlier${reads.size === 1 ? "" : "s"} — ${transcripts} with transcripts` +
        `${transcriptsAvailable() ? "" : " (no transcript source configured, so comments only)"}, ${quotaUnits} quota units.`,
    ],
    quotaUnits,
    contentNotes,
  };
}

export async function gatherFor(needs: DataNeed[], ctx: SeriesContext): Promise<GatherOutcome> {
  const merged: GatherOutcome = { notes: [], quotaUnits: 0, contentNotes: [] };
  for (const need of needs) {
    try {
      const out = need === "thumbnails" ? await gatherThumbnails(ctx) : await gatherContentForSection(ctx);
      merged.notes.push(...out.notes);
      merged.quotaUnits += out.quotaUnits;
      if (out.videos) {
        merged.videos = out.videos;
        ctx = { ...ctx, videos: out.videos };
      }
      if (out.marketVideos) {
        merged.marketVideos = out.marketVideos;
        ctx = { ...ctx, marketVideos: out.marketVideos };
      }
      if (out.contentNotes?.length) merged.contentNotes!.push(...out.contentNotes);
    } catch (err: any) {
      // A gatherer that fails costs the section its depth, not its existence.
      merged.notes.push(`Tried to gather ${need} and could not: ${String(err?.message || err)}.`);
    }
  }
  return merged;
}

/* ── the write-up ─────────────────────────────────────────────────────────── */

const WRITE_SYSTEM = `You are writing ONE section of a YouTube channel audit, for the person whose channel it is. The measurements below have already been computed from their real data. Write the section from them.

Return JSON:
{
  "summary": "two to four sentences of prose",
  "bullets": ["a specific, actionable point", "..."],
  "charts": [{ "title": "final chart title", "caption": "one line saying what this chart shows" }],
  "method": "one or two sentences on how this was measured, in plain language"
}

Rules:
- EVERY NUMBER YOU WRITE MUST APPEAR IN THE DATA BELOW. Do not compute new ones, do not round to something rounder, do not estimate. If you want to say something the data does not show, don't say it.
- Quote sample sizes when you make a claim from a small group. "2.4x across four videos" is honest; "2.4x" alone is not.
- One "charts" entry per chart given, in the same order.
- If a chart came back with nothing, say so plainly in the summary rather than writing around it.
- Say what the operator should DO. A section that only describes is half a section.
- Plain language. No hype, no headings, no markdown.`;

interface SectionWriting {
  summary: string;
  bullets: string[];
  charts: { title: string; caption: string }[];
  method: string;
}

function renderDataForWriter(charts: { workingTitle: string; data: AuditChartData }[]): string {
  return charts
    .map((c, i) => {
      if (c.data.unavailable) {
        return `CHART ${i + 1} — ${c.workingTitle}\n  NO DATA: ${c.data.unavailable}`;
      }
      const rows = c.data.points
        .map(
          (p) =>
            `    ${p.label}: ${p.value}${typeof p.secondary === "number" ? ` (market: ${p.secondary}, n=${p.nSecondary})` : ""} [n=${p.n}]`,
        )
        .join("\n");
      return [
        `CHART ${i + 1} — ${c.workingTitle}`,
        `  measure: ${c.data.measureLabel}`,
        `  grouped by: ${c.data.groupLabel}`,
        `  values:`,
        rows,
        `  how it was counted: ${c.data.note}`,
      ].join("\n");
    })
    .join("\n\n");
}

export async function writeSection(
  run: AuditRunResult,
  request: string,
  title: string,
  charts: { workingTitle: string; data: AuditChartData }[],
  contentNotes: string[],
): Promise<SectionWriting> {
  const raw = await claudeJSONWithModel({
    model: CHAT_MODEL,
    purpose: "audit-section",
    system: WRITE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          reportContext(run),
          `\nTHE REQUEST: ${request}`,
          `SECTION TITLE: ${title}`,
          `\nCOMPUTED MEASUREMENTS:\n${renderDataForWriter(charts)}`,
          contentNotes.length
            ? `\nWHAT THE WINNERS' TRANSCRIPTS AND COMMENTS SAY (evidence for the prose; it has no chart):\n${contentNotes.join("\n\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  let got: any = {};
  try {
    got = JSON.parse(raw);
  } catch {
    got = {};
  }
  const written = Array.isArray(got?.charts) ? got.charts : [];
  return {
    summary: String(got?.summary ?? "").trim(),
    bullets: (Array.isArray(got?.bullets) ? got.bullets : []).map((b: any) => String(b)).filter(Boolean),
    charts: charts.map((c, i) => ({
      title: String(written[i]?.title ?? "").trim() || c.workingTitle,
      caption: String(written[i]?.caption ?? "").trim(),
    })),
    method: String(got?.method ?? "").trim(),
  };
}

/* ── the whole thing ──────────────────────────────────────────────────────── */

export interface BuiltSection {
  section: AuditReportSection | null;
  /** Set instead of a section when the request could not be answered. */
  declined: string | null;
  /** Enriched videos to persist, when a gatherer improved them. */
  videos?: AuditVideo[];
  marketVideos?: AuditVideo[];
}

/**
 * Plan → gather → compute → write. The only entry point worth calling.
 *
 * Charts that came back with no data are DROPPED rather than rendered empty,
 * and the reason travels into the writer so the prose can account for it. A
 * section whose charts all came back empty is refused outright: an audit that
 * answers a question it cannot answer is worse than one that says it can't.
 */
export async function buildSection(run: AuditRunResult, request: string): Promise<BuiltSection> {
  const baseCtx: SeriesContext = {
    subject: run.subject,
    videos: run.videos ?? [],
    marketVideos: run.marketVideos ?? [],
    competitors: run.competitors ?? [],
    topics: run.findings?.content.topics ?? [],
  };

  const plan = await planSection(run, request, baseCtx);
  if (plan.decline || !plan.charts.length) {
    return { section: null, declined: plan.decline ?? "That question cannot be answered from this audit's data." };
  }

  let ctx = baseCtx;
  let gathered: GatherOutcome = { notes: [], quotaUnits: 0, contentNotes: [] };
  if (plan.gather.length) {
    gathered = await gatherFor(plan.gather, ctx);
    if (gathered.videos) ctx = { ...ctx, videos: gathered.videos };
    if (gathered.marketVideos) ctx = { ...ctx, marketVideos: gathered.marketVideos };
  }

  const computed = plan.charts.map((c) => ({ ...c, data: buildSeries(c.query, ctx) }));
  const usable = computed.filter((c) => !c.data.unavailable);
  if (!usable.length) {
    const why = computed[0]?.data.unavailable ?? "the data would not support a chart";
    return {
      section: null,
      declined: `I could not build that section — ${why}`,
      videos: gathered.videos,
      marketVideos: gathered.marketVideos,
    };
  }

  const writing = await writeSection(run, request, plan.title, computed, gathered.contentNotes ?? []);

  // Only usable charts are carried, but the writer saw the empty ones too, so
  // the prose can say what could not be measured instead of silently omitting it.
  const specs: { spec: AuditChartSpec; data: AuditChartData }[] = [];
  computed.forEach((c, i) => {
    if (c.data.unavailable) return;
    specs.push({
      spec: {
        id: nanoid(8),
        form: formFor(c.query, c.data),
        title: writing.charts[i]?.title || c.workingTitle,
        caption: writing.charts[i]?.caption || "",
        query: c.query,
      },
      data: c.data,
    });
  });

  return {
    section: {
      id: nanoid(10),
      title: plan.title,
      request,
      summary: writing.summary,
      bullets: writing.bullets,
      charts: specs,
      gathered: gathered.notes,
      method: writing.method,
      createdAt: Date.now(),
      quotaUnits: gathered.quotaUnits,
    },
    declined: null,
    videos: gathered.videos,
    marketVideos: gathered.marketVideos,
  };
}
