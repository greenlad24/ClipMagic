/**
 * The ChatGPT research pack — research done OUTSIDE this server, imported in.
 *
 * Jake runs the research half of the methodology (UI check in a real browser,
 * the newest tutorials, web research, fact sheet, outline) in his own ChatGPT
 * account through the `clipmagic-research-pack` skill. It hands back one
 * markdown file. This module turns that file into the exact stage values a run
 * would have produced itself, so the pipeline's own `if (!stages.x)` guards skip
 * every stage the pack already covers and the run starts at the hooks.
 *
 * Pure: no I/O and no model calls. Unit-tested in scripts/researchPack.test.ts.
 *
 * The format is line markers, `<<<NAME>>>`, rather than markdown headings: every
 * section's BODY is itself markdown full of `##` headings (the fact sheet and the
 * outline both are), so a heading can't also be the delimiter.
 */

import type { ScriptSource, VideoSourceRef, VideoType } from "./types.js";
import { parseOutlineSections, ON_SCREEN_RE } from "./edits.js";

export const PACK_VERSION = "1";

/** Every section a v1 pack may carry. Anything else is reported, not guessed at. */
const SECTIONS = [
  "SETUP",
  "UI_VERIFICATION",
  "VIDEO_SOURCES",
  "VIDEO_WORKFLOWS",
  "RESEARCH",
  "SOURCES",
  "FACT_SHEET",
  "OUTLINE",
] as const;
type SectionName = (typeof SECTIONS)[number];

/**
 * A marker line. Tolerant of what a chat UI does to a line on its way out —
 * backticks, bold, a stray bullet, lower case, spaces for underscores — because
 * a pack that fails to parse over formatting is a pack Jake re-pays ChatGPT for.
 */
const MARKER_RE = /^\s*(?:[-*]\s*)?[`*]*\s*<<<\s*([A-Za-z][A-Za-z _-]*?)\s*(?:v(\d+))?\s*>>>\s*[`*]*\s*$/;

/** The shortest body that can plausibly be the real thing rather than a stub. */
const MIN_CHARS: Partial<Record<SectionName, number>> = {
  RESEARCH: 800,
  FACT_SHEET: 300,
  OUTLINE: 600,
};

/** A pack researched more than this long ago gets a warning, never a refusal. */
const STALE_DAYS = 14;

export interface PackSetup {
  title: string;
  videoType: VideoType;
  /** What the pack said, verbatim — shown at the checkpoint as the "detected" type. */
  videoTypeRaw: string;
  coreTopic: string;
  specificFocus: string;
  itemCount: number | null;
  /** YYYY-MM-DD as the pack states it, or null. */
  researchedOn: string | null;
}

export interface ParsedPack {
  setup: PackSetup;
  research: string;
  factSheet: string;
  outline: string;
  /** Null when the pack carried no UI check (e.g. the product needed a login). */
  uiVerification: string | null;
  /** Null when the pack found no recent tutorials. */
  videoWorkflows: string | null;
  videoSources: VideoSourceRef[];
  sources: ScriptSource[];
  version: string;
  /** Things worth knowing that do not stop the import. */
  warnings: string[];
}

export type PackResult = { ok: true; pack: ParsedPack } | { ok: false; errors: string[]; warnings: string[] };

const VIDEO_TYPES: VideoType[] = ["Tutorial", "List/Roundup", "Tool Review", "Business Guide", "Opinion"];

/** Same mapping run.ts applies to Stage 0's output, so a pack and a run agree. */
export function coercePackVideoType(v: string): VideoType {
  const s = v.trim();
  const exact = VIDEO_TYPES.find((t) => t.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const l = s.toLowerCase();
  if (l.includes("list") || l.includes("round")) return "List/Roundup";
  if (l.includes("review")) return "Tool Review";
  if (l.includes("business") || l.includes("guide")) return "Business Guide";
  if (l.includes("opinion") || l.includes("comment")) return "Opinion";
  return "Tutorial";
}

function canonicalName(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/** Split the file into its marked sections. Text outside any section is dropped. */
export function splitPack(text: string): {
  sections: Map<string, string>;
  version: string | null;
  sawHeader: boolean;
  duplicates: string[];
} {
  const sections = new Map<string, string>();
  const duplicates: string[] = [];
  let version: string | null = null;
  let sawHeader = false;
  let current: string | null = null;
  let buf: string[] = [];

  const close = () => {
    if (current === null) return;
    const body = stripWrappingFence(buf.join("\n")).trim();
    if (sections.has(current)) {
      duplicates.push(current);
      // The later copy wins: a model that repeats a section is usually correcting it.
    }
    sections.set(current, body);
    current = null;
    buf = [];
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = MARKER_RE.exec(line);
    if (!m) {
      if (current !== null) buf.push(line);
      continue;
    }
    const name = canonicalName(m[1]);
    if (name === "CLIPMAGIC_RESEARCH_PACK") {
      close();
      sawHeader = true;
      version = m[2] ?? version;
      continue;
    }
    close();
    if (name === "END") continue;
    current = name;
  }
  close();
  return { sections, version, sawHeader, duplicates };
}

/**
 * A section body wrapped in ```markdown … ``` by the chat UI. Only an outer fence
 * that wraps the WHOLE body is removed — a fence inside it (a prompt the video
 * shows) is content.
 */
function stripWrappingFence(body: string): string {
  const t = body.trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*)\n```$/.exec(t);
  if (!m) return body;
  // An inner fence would leave an odd number of fences once the outer pair is
  // gone — then the "outer" pair was really two separate blocks. Leave it be.
  const inner = m[1];
  return (inner.match(/^```/gm) ?? []).length % 2 === 0 ? inner : body;
}

/** `key: value` lines, keys normalised to snake_case. Markdown decoration tolerated. */
function parseSetupBlock(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").trim();
    const m = /^([A-Za-z][A-Za-z _-]*?)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/[\s-]+/g, "_");
    const val = m[2].trim();
    if (val) out.set(key, val);
  }
  return out;
}

const NONE_RE = /^(?:none|n\/a|null|-|—|not item[- ]based)$/i;

function isNone(s: string): boolean {
  return NONE_RE.test(s.trim()) || /^\(none/i.test(s.trim());
}

const URL_RE = /https?:\/\/[^\s)>\]|`"']+/;

/** One URL per line, with whatever title the line gives it. Deduped by URL. */
export function parseSourceLines(body: string): ScriptSource[] {
  const out: ScriptSource[] = [];
  const seen = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
    const u = URL_RE.exec(line);
    if (!u) continue;
    const url = u[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    const md = /\[([^\]]+)\]\(\s*https?:\/\//.exec(line);
    let title = md
      ? md[1]
      : line
          .replace(URL_RE, "")
          .split("|")
          .map((p) => p.trim())
          .find((p) => p.length > 0) ?? "";
    title = title.replace(/[—–-]\s*$/, "").replace(/\*\*/g, "").trim();
    out.push({ url, title: title || url });
  }
  return out;
}

/** `- Title | Channel | URL | YYYY-MM-DD | views` — the order the skill asks for. */
export function parseVideoSourceLines(body: string): VideoSourceRef[] {
  const out: VideoSourceRef[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
    const u = URL_RE.exec(line);
    if (!u) continue;
    const parts = line.split("|").map((p) => p.trim());
    const urlIdx = parts.findIndex((p) => URL_RE.test(p));
    const rest = parts.filter((_, i) => i !== urlIdx);
    const date = rest.find((p) => /^\d{4}-\d{2}-\d{2}/.test(p)) ?? "";
    const viewsPart = rest.find((p) => /^[\d,._ ]+(?:\s*views?)?$/i.test(p) && !/^\d{4}-\d{2}/.test(p));
    const words = rest.filter((p) => p !== date && p !== viewsPart && p.length > 0);
    out.push({
      title: (words[0] ?? u[0]).replace(/\*\*/g, ""),
      channel: words[1] ?? "",
      url: u[0],
      publishedAt: date.slice(0, 10),
      views: viewsPart ? Number(viewsPart.replace(/[^\d]/g, "")) || 0 : 0,
    });
  }
  return out;
}

function daysBetween(isoDate: string, now: Date): number | null {
  const t = Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/**
 * Parse and validate a pack. Errors are the things that would make the run
 * re-buy research or write from nothing; warnings are the things Jake should
 * see before paying for the script.
 */
export function parseResearchPack(text: string, now: Date = new Date()): PackResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!text || !text.trim()) {
    return { ok: false, errors: ["The pack is empty."], warnings };
  }

  const { sections, version, sawHeader, duplicates } = splitPack(text);
  if (sections.size === 0) {
    return {
      ok: false,
      errors: [
        "No <<<SECTION>>> markers found. This doesn't look like a research pack — upload the .md file the ChatGPT skill produced, not a copy of the chat.",
      ],
      warnings,
    };
  }
  if (!sawHeader) warnings.push("The <<<CLIPMAGIC_RESEARCH_PACK v1>>> header line is missing; parsed it anyway.");
  if (version && version !== PACK_VERSION) {
    warnings.push(`Pack says v${version}; this importer reads v${PACK_VERSION}. Parsed it anyway — check the sections below.`);
  }
  for (const d of new Set(duplicates)) warnings.push(`${d} appeared more than once; the last copy was used.`);
  const unknown = [...sections.keys()].filter((k) => !(SECTIONS as readonly string[]).includes(k));
  if (unknown.length) warnings.push(`Ignored unknown section(s): ${unknown.join(", ")}.`);

  const get = (n: SectionName): string => (sections.get(n) ?? "").trim();
  const present = (n: SectionName): boolean => {
    const b = get(n);
    return b.length > 0 && !isNone(b);
  };

  // ── Setup ──
  const kv = parseSetupBlock(get("SETUP"));
  const title = (kv.get("title") ?? "").replace(/^["“]|["”]$/g, "").trim();
  if (!title) errors.push("SETUP has no `title:` line.");
  const videoTypeRaw = kv.get("video_type") ?? kv.get("type") ?? "";
  if (!videoTypeRaw) warnings.push("SETUP has no `video_type:`; defaulted to Tutorial.");
  const coreTopic = kv.get("core_topic") ?? kv.get("topic") ?? "";
  if (!coreTopic) errors.push("SETUP has no `core_topic:` line.");
  const itemRaw = kv.get("item_count") ?? "";
  const itemNum = Number.parseInt(itemRaw, 10);
  const itemCount = !isNone(itemRaw) && Number.isFinite(itemNum) && itemNum >= 3 ? itemNum : null;
  const researchedRaw = kv.get("researched_on") ?? kv.get("date") ?? "";
  const researchedOn = /^\d{4}-\d{2}-\d{2}/.test(researchedRaw) ? researchedRaw.slice(0, 10) : null;

  // ── The three sections the run cannot proceed without ──
  // A missing one here isn't a thin script, it's a run that silently re-buys the
  // stage — the guards read "empty" as "never ran".
  for (const n of ["RESEARCH", "FACT_SHEET", "OUTLINE"] as const) {
    const b = get(n);
    if (!b) errors.push(`${n} section is missing.`);
    else if (b.length < (MIN_CHARS[n] ?? 0)) {
      errors.push(`${n} is only ${b.length} characters — that's a stub, not the stage. Ask ChatGPT to finish it.`);
    }
  }

  const outline = get("OUTLINE");
  if (outline) {
    const secs = parseOutlineSections(outline);
    if (secs.length < 2) {
      errors.push(
        "The outline has fewer than two content sections the writer can find. Sections must be `##`–`####` headings (the stage 2 template's `#### ⏱️ SECTION (timestamp)` format).",
      );
    } else {
      const noScreen = secs.filter((s) => !ON_SCREEN_RE.test(s.text)).length;
      if (noScreen > 0) {
        warnings.push(
          `${noScreen} of ${secs.length} outline section(s) have no ON SCREEN line; the writer's on-screen pass will add them (a few cents).`,
        );
      }
    }
  }

  const factSheet = get("FACT_SHEET");
  if (factSheet && !/DO NOT CLAIM/i.test(factSheet)) {
    warnings.push("The fact sheet has no DO NOT CLAIM section, so nothing is fenced off from the writer.");
  }
  const research = get("RESEARCH");
  if (research && !/WHAT CHANGED RECENTLY/i.test(research)) {
    warnings.push("The research has no WHAT CHANGED RECENTLY section, so the script may miss what's new.");
  }

  const uiVerification = present("UI_VERIFICATION") ? get("UI_VERIFICATION") : null;
  if (!uiVerification) {
    warnings.push("No UI verification in the pack. Screenshots you add at the checkpoint will be read instead.");
  }
  const videoWorkflows = present("VIDEO_WORKFLOWS") ? get("VIDEO_WORKFLOWS") : null;
  const videoSources = parseVideoSourceLines(get("VIDEO_SOURCES"));
  if (!videoWorkflows) {
    warnings.push("No tutorial workflow sheet, so the click paths rest on the UI check and the written research.");
  } else if (videoSources.length === 0) {
    warnings.push("Workflow sheet present but VIDEO_SOURCES lists no video URLs; the [V1 @ …] citations can't be traced.");
  }

  const sources = parseSourceLines(get("SOURCES"));
  if (sources.length === 0) warnings.push("SOURCES lists no URLs, so the vendor-vs-review-site audit can't run.");

  if (researchedOn) {
    const age = daysBetween(researchedOn, now);
    if (age !== null && age > STALE_DAYS) {
      warnings.push(`Researched on ${researchedOn} — ${age} days ago. Prices and UI may have moved since.`);
    } else if (age !== null && age < -1) {
      warnings.push(`researched_on (${researchedOn}) is in the future; check the pack's date.`);
    }
  } else {
    warnings.push("SETUP has no `researched_on:` date, so the pack's age can't be checked.");
  }

  if (errors.length) return { ok: false, errors, warnings };

  return {
    ok: true,
    pack: {
      setup: {
        title,
        videoType: coercePackVideoType(videoTypeRaw || "Tutorial"),
        videoTypeRaw: videoTypeRaw || "Tutorial",
        coreTopic,
        specificFocus: kv.get("specific_focus") ?? kv.get("focus") ?? "",
        itemCount,
        researchedOn,
      },
      research,
      factSheet,
      outline,
      uiVerification,
      videoWorkflows,
      videoSources,
      sources,
      version: version ?? PACK_VERSION,
      warnings,
    },
  };
}
