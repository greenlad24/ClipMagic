/**
 * "How did we answer this before" (rules #7, #10): the 939-thread library in
 * INBOX-HISTORY.jsonl, plus Jake's own words from the imported mailbox.
 *
 * Retrieval is lexical and cheap: stage overlap, same brand/domain, and word
 * overlap between the current email's goal/edge case/subject and the past
 * thread's edge case/what they asked. The library's PRICES are historical
 * ($5,500 / $5,000 era) — every caller is told never to copy them.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../../db/index.js";
import { SPEC_DIR } from "./rulebook.js";
import { clip, stripQuoted } from "./util.js";

export interface PastThread {
  threadId: string;
  brand: string | null;
  product: string | null;
  stages: string[];
  edgeCase: string | null;
  theyAsked: string | null;
  jakeAnswered: string | null;
  outcome: string | null;
  rulesApplied: string[];
  offRulebook: string[];
  reusablePhrases: string[];
  slackWorthy: string | null;
}

let lib: { mtimeMs: number; rows: PastThread[]; tokens: Set<string>[] } | null = null;

const STOP = new Set("the a an and or of to in on for with is are was were be been this that it its as at by from we you they our your their jake brand wants want asked about not no yes if but so into than then can could would should will just also more very".split(" "));
function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function load(): typeof lib {
  const file = path.join(SPEC_DIR(), "INBOX-HISTORY.jsonl");
  try {
    const st = fs.statSync(file);
    if (lib && lib.mtimeMs === st.mtimeMs) return lib;
    const rows: PastThread[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        rows.push({
          threadId: r.threadId, brand: r.brand ?? null, product: r.product ?? null, stages: r.stages ?? [], edgeCase: r.edgeCase ?? null,
          theyAsked: r.theyAsked ?? null, jakeAnswered: r.jakeAnswered ?? null, outcome: r.outcome ?? null, rulesApplied: r.rulesApplied ?? [],
          offRulebook: r.offRulebook ?? [], reusablePhrases: r.reusablePhrases ?? [], slackWorthy: r.slackWorthy ?? null,
        });
      } catch { /* skip a bad line */ }
    }
    lib = { mtimeMs: st.mtimeMs, rows, tokens: rows.map((r) => tokens(`${r.edgeCase ?? ""} ${r.theyAsked ?? ""} ${r.product ?? ""}`)) };
    return lib;
  } catch {
    return null;
  }
}

/** The ~n most similar past threads (never the current thread itself). */
export function similarThreads(q: { threadId: string; stage: string; edgeCase: string | null; goal: string; brand: string | null; domain: string | null; subject: string }, n = 6): PastThread[] {
  const L = load();
  if (!L) return [];
  const qt = tokens(`${q.edgeCase ?? ""} ${q.goal} ${q.subject}`);
  const brand = (q.brand ?? "").toLowerCase().trim();
  const dom = (q.domain ?? "").split(".")[0];
  const scored: Array<{ s: number; r: PastThread }> = [];
  L.rows.forEach((r, i) => {
    if (r.threadId === q.threadId) return;
    let s = 0;
    if (r.stages.includes(q.stage)) s += 3;
    const rb = (r.brand ?? "").toLowerCase();
    if (brand && brand.length > 2 && rb.includes(brand)) s += 8;
    else if (dom && dom.length > 3 && rb.includes(dom)) s += 6;
    let overlap = 0;
    for (const w of qt) if (L.tokens[i].has(w)) overlap++;
    s += Math.min(8, overlap * 1.2);
    if (r.jakeAnswered) s += 0.5;
    if (q.edgeCase && r.edgeCase) s += 0.5;
    if (s > 2) scored.push({ s, r });
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.r);
}

export function formatPastThreads(rows: PastThread[]): string {
  if (!rows.length) return "(no similar past threads found)";
  return rows.map((r, i) => [
    `${i + 1}. ${r.brand ?? "?"}${r.product ? ` — ${r.product}` : ""} [${r.stages.join(", ")}] outcome: ${r.outcome ?? "?"}`,
    r.edgeCase ? `   edge case: ${r.edgeCase}` : "",
    r.theyAsked ? `   they asked: ${r.theyAsked}` : "",
    r.jakeAnswered ? `   Jake answered: ${r.jakeAnswered}` : "",
    r.rulesApplied.length ? `   rules applied: ${r.rulesApplied.join("; ")}` : "",
    r.offRulebook.length ? `   (off-rulebook then — do NOT repeat: ${r.offRulebook.join("; ")})` : "",
    ((ph) => ph.length ? `   reusable phrases: ${ph.map((p) => `"${p}"`).join(" | ")}` : "")(r.reusablePhrases.filter((p) => !/\$|floor|lowest|minimum|integration/i.test(p))),
  ].filter(Boolean).join("\n")).join("\n");
}

/**
 * A few of Jake's real sent replies (voice reference), newest first. Drawn
 * from the similar threads when possible, else his latest sponsor replies.
 */
export function jakeVoiceSamples(threadIds: string[], n = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pick = (rows: { thread_id: string; body_text: string }[]) => {
    for (const r of rows) {
      if (out.length >= n || seen.has(r.thread_id)) continue;
      const t = stripQuoted(r.body_text ?? "");
      if (t.length < 200 || t.length > 2200) continue;
      seen.add(r.thread_id);
      out.push(t);
    }
  };
  try {
    if (threadIds.length) {
      const rows = db.prepare(
        `SELECT thread_id, body_text FROM deals_emails WHERE is_from_me = 1 AND thread_id IN (${threadIds.map(() => "?").join(",")}) ORDER BY date_iso DESC`,
      ).all(...threadIds) as any[];
      pick(rows);
    }
    if (out.length < n) {
      pick(db.prepare(`SELECT thread_id, body_text FROM deals_emails WHERE is_from_me = 1 AND date_iso >= '2026-09-01' ORDER BY date_iso DESC LIMIT 60`).all() as any[]);
    }
  } catch { /* history is optional */ }
  return out.map((t) => clip(t, 1800));
}
