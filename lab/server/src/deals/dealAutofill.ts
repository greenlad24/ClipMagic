/**
 * Deal Organizer — the deal CARD fills itself from the email thread(s)
 * (Jake, 2026-09-30: "I never want to manually add details to cards — all of it
 * should be automatic based on the email thread").
 *
 * The analytics extraction in dealFields.ts already reads each queued deal's
 * thread with one Sonnet call. That SAME call now also returns the card
 * (`card` in its JSON — the prompt section below), so a deal costs one call:
 *
 *   deadline (free text + deadline_date: the agreed publish / delivery date)
 *   next_steps · key_details · contact_info (everyone involved: name, role,
 *   company, email) · opportunity / about (only when empty) · currency +
 *   estimated_value (agreed, else latest quoted/offered) · the to-do list.
 *
 * When it runs: every deal with fields_dirty = 1 in the central sync (capped per
 * run, dealFields.ts). Besides the stage trigger (db.ts), `markThreadActivityDirty`
 * — called at the start of every fillDealFields — queues each deal whose threads
 * received an email since its last extraction.
 *
 * Human edits win: a card field Jake saves through updateDeal is marked "human"
 * in `fields_source` and is never written by the AI again (clearing it counts).
 * A to-do's status Jake set is never changed; to-dos he added are never removed.
 *
 * To-dos written here carry deals_deal_actions.source = 'auto'. They are written
 * with the db.ts table helper (like the scanner's), NOT through the addAction /
 * updateActionStatus endpoints: those stamp human_touched_at, which would make
 * the scanner treat every auto-updated deal as hand-curated.
 */
import { threadIdsForDeal } from "./matching.js";
import { db } from "../db/index.js";
import { dealActions } from "./db.js";
import { isYmd, todayBangkok, refreshDeadlineDate } from "./deadlineParse.js";

/* ── additive migration ──────────────────────────────────────────────────── */

function addColumn(table: string, column: string, type: string): void {
  const has = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
/**
 *   deals_deals.card_filled_at     last time the card was auto-filled (NULL = never → backfill)
 *   deals_deals.card_asof          date of the latest email that fill was based on ("from email · <date>")
 *   deals_deal_actions.source      'auto' = written by this module (NULL = scanner / typed / legacy)
 *   deals_deal_actions.status_by   'human' (set in the UI) | 'auto' (set here) | NULL
 */
addColumn("deals_deals", "card_filled_at", "TEXT");
addColumn("deals_deals", "card_asof", "TEXT");
addColumn("deals_deal_actions", "source", "TEXT");
addColumn("deals_deal_actions", "status_by", "TEXT");

/* ── human edits ─────────────────────────────────────────────────────────── */

/** updateDeal keys (frontend names) that are auto-filled card fields. */
export const CARD_KEYS = ["deadline", "next_steps", "key_details", "contact_info", "opportunity", "about", "currency", "estimated_value"] as const;
export type CardKey = (typeof CARD_KEYS)[number];

function readSource(dealId: string): Record<string, string> | null {
  const r = db.prepare(`SELECT fields_source FROM deals_deals WHERE id = ?`).get(dealId) as { fields_source: string | null } | undefined;
  if (!r) return null;
  try { const o = JSON.parse(r.fields_source || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; }
}

/**
 * updateDeal → mark each card key present in `updates` as typed by a human.
 * One exception: the email agent's board move (agent/run.ts) sends
 * `{ stage, estimated_value }` together — a value that arrives WITH a stage is
 * the agent's, not Jake's (the UI saves the value on its own).
 */
export function markHumanCardFields(dealId: string, updates: Record<string, unknown>): void {
  const keys = CARD_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(updates, k) && updates[k] !== undefined)
    .filter((k) => !((k === "estimated_value" || k === "currency") && updates.stage !== undefined));
  if (!keys.length) return;
  const source = readSource(dealId);
  if (!source) return;
  for (const k of keys) source[k] = "human";
  db.prepare(`UPDATE deals_deals SET fields_source = ? WHERE id = ?`).run(JSON.stringify(source), dealId);
}

/** updateActionStatus (the UI) → this to-do's status is Jake's call from now on. */
export function markActionHuman(actionId: string): void {
  dealActions.update(actionId, { statusBy: "human" });
}

/* ── "the thread changed" → queue ────────────────────────────────────────── */

/**
 * Queue (fields_dirty = 1) every live deal whose thread(s) got an email stored
 * after its last extraction. Thread(s) = the deal's source thread + any thread the
 * client's address wrote in (the same set the extraction reads). Uses the local
 * row's created_at — when WE stored it — so an email arriving late with an old
 * Date header still counts. Returns how many deals were queued.
 */
export async function markThreadActivityDirty(threadsFor: (deal: { id: string; source_thread_id: string | null; client_email: string | null }) => string[] = (d) => threadIdsForDeal(d.id)): Promise<number> {
  const deals = db.prepare(`
    SELECT id, source_thread_id, client_email, fields_extracted_at FROM deals_deals
    WHERE (archived IS NULL OR archived = 0) AND merged_into IS NULL
      AND COALESCE(fields_dirty, 0) = 0 AND fields_extracted_at IS NOT NULL`).all() as any[];
  if (!deals.length) return 0;
  // Newest stored email per thread (drafts excluded).
  const newest = new Map<string, string>();
  for (const r of db.prepare(`SELECT thread_id, MAX(created_at) AS at FROM deals_emails WHERE thread_id IS NOT NULL AND (labels IS NULL OR labels NOT LIKE '%"DRAFT"%') GROUP BY thread_id`).all() as { thread_id: string; at: string }[]) newest.set(r.thread_id, r.at);
  // Nothing stored after a deal's extraction anywhere → that deal cannot be dirty
  // (skips the thread resolution for almost every deal on a quiet run).
  let newestAny = "";
  for (const at of newest.values()) if (at > newestAny) newestAny = at;
  const mark = db.prepare(`UPDATE deals_deals SET fields_dirty = 1 WHERE id = ?`);
  let n = 0;
  for (const d of deals) {
    if (!(newestAny > d.fields_extracted_at)) continue;
    // The full thread resolver is ~0.1 s a deal — yield so the server stays responsive.
    await new Promise((r) => setImmediate(r));
    const latest = threadsFor(d).reduce<string>((m, t) => { const at = newest.get(t); return at && at > m ? at : m; }, "");
    if (latest && latest > d.fields_extracted_at) { mark.run(d.id); n++; }
  }
  return n;
}

/** Address → the threads it wrote in (built once per call of defaultThreads' user). */
let addrThreads: { at: number; map: Map<string, string[]> } | null = null;
/** The deal's threads as the extraction reads them: the source thread + threads the client wrote in. */
export function defaultThreads(deal: { source_thread_id: string | null; client_email: string | null }): string[] {
  if (!addrThreads || Date.now() - addrThreads.at > 60_000) {
    const map = new Map<string, string[]>();
    for (const r of db.prepare(`SELECT DISTINCT lower(from_email) AS a, thread_id AS t FROM deals_emails WHERE thread_id IS NOT NULL AND from_email IS NOT NULL`).all() as { a: string; t: string }[]) {
      const l = map.get(r.a); if (l) l.push(r.t); else map.set(r.a, [r.t]);
    }
    addrThreads = { at: Date.now(), map };
  }
  const out = new Set<string>();
  if (deal.source_thread_id) out.add(deal.source_thread_id);
  const e = (deal.client_email ?? "").toLowerCase().trim();
  if (e) for (const t of addrThreads.map.get(e) ?? []) out.add(t);
  return [...out];
}

/* ── the prompt section (appended to dealFields.ts's system prompt) ──────── */

export const CARD_SYSTEM = `

ALSO fill the deal CARD Jake sees on his board — key "card" in the same JSON object. Jake never types these; you keep them current from the thread. Write in plain, short English, from Jake's side. Newest email wins over older ones. You get the CURRENT card values: return a field unchanged when it is still right, rewrite it when the thread moved on, null only when you have nothing (null never erases a value).
"card": {
  "deadline": {"text": "<how Jake would write it, max 40 chars, go-live date first, e.g. 'Oct 15', 'mid October', 'Nov 7 (draft Nov 3)'>", "date": "YYYY-MM-DD"} | null
      — the agreed (or brand-requested) date the video must GO LIVE. "date" is that go-live date whenever one is known; only when no publish date exists at all use the agreed delivery/draft date. A deadline is a "by" date: 'late June' → the last day of June, 'mid July' → the 15th, a bare month → its last day. Keep the current text if the thread does not change it. null if no date was ever discussed.
  "next_steps": "<1-3 short lines: what happens next and who is waiting on whom, based on the LATEST emails>",
  "key_details": "<short lines: deliverables, price & payment terms, contract status (sent / signed by whom), payment status, script/draft/publish dates, usage rights / exclusivity asks>",
  "contact_info": "<one line per person involved (brand + agency, not Jake): Name — role, Company <email>. Skip no-reply addresses.>",
  "opportunity": "<one line: what the brand wants from Jake>",
  "about": "<one line: who the brand is / what the product does>",
  "currency": "<ISO code of the money discussed, e.g. USD, EUR>" | null,
  "estimated_value": <number: the agreed total in that currency; if nothing is agreed yet, the latest amount quoted or offered> | null,
  "todos": {
    "done": ["<id of an OPEN to-do the thread shows already happened>"],
    "remove": ["<id of an open AUTO to-do that no longer applies (the deal moved on, was lost, or it is covered by another)>"],
    "add": ["<new to-do>"]
  }
}
To-dos = what Jake's side must do next, or is waiting for, at this point of the deal — concrete and dated when a date is known, max 70 chars each: e.g. "Send contract", "Wait for signed contract", "Send invoice (50% upfront)", "Wait for payment", "Send script for approval by Oct 3", "Deliver video draft by Oct 17", "Chase feedback on the draft", "Publish video Oct 20", "Send 2nd invoice". Add at most 3, only ones not already on the list (in any wording), and keep at most 4 open to-dos in total. A lost / declined / not-a-sponsorship deal gets no new to-dos, and its open AUTO to-dos are removed. Never mark a to-do done without evidence in the thread. Use only ids from the list you are given.`;

/** The CURRENT card + to-do list, appended to the extraction's user message. */
export function cardContext(dealId: string): string {
  const d = db.prepare(`SELECT deadline, deadline_date, next_steps, key_details, contact_info, opportunity, about, currency, estimated_value, fields_source FROM deals_deals WHERE id = ?`).get(dealId) as any;
  if (!d) return "";
  const source = readSource(dealId) ?? {};
  const clip = (s: unknown, n: number) => (s == null || s === "" ? "(empty)" : String(s).replace(/\s+\n/g, "\n").slice(0, n));
  const human = (k: string) => (source[k] === "human" ? " [typed by Jake — keep]" : "");
  const actions = db.prepare(`SELECT id, content, status, source, status_by FROM deals_deal_actions WHERE deal_id = ? ORDER BY created_at, rowid`).all(dealId) as any[];
  return [
    "",
    "CURRENT CARD:",
    `deadline: ${clip(d.deadline, 80)}${d.deadline_date ? ` (= ${d.deadline_date})` : ""}${human("deadline")}`,
    `next_steps: ${clip(d.next_steps, 500)}${human("next_steps")}`,
    `key_details: ${clip(d.key_details, 900)}${human("key_details")}`,
    `contact_info: ${clip(d.contact_info, 500)}${human("contact_info")}`,
    `opportunity: ${clip(d.opportunity, 300)}`,
    `about: ${clip(d.about, 300)}`,
    `value: ${d.estimated_value ?? "(empty)"} ${d.currency ?? ""}${human("estimated_value")}`,
    "TO-DO LIST (id · status · who added it · text):",
    ...(actions.length
      ? actions.map((a) => `- ${a.id} · ${a.status === "Done" ? "done" : "open"} · ${a.source === "auto" ? "AUTO" : "manual/scan"} · ${String(a.content ?? "").slice(0, 120)}`)
      : ["(none)"]),
  ].join("\n");
}

/* ── applying the AI's card ──────────────────────────────────────────────── */

const LIMITS: Record<string, number> = { next_steps: 700, key_details: 1400, contact_info: 900, opportunity: 400, about: 400 };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface CardResult { saved: string[]; todos: { added: string[]; done: string[]; removed: string[] } }

/**
 * Write the AI's `card` onto the deal: only fields not typed by a human, never
 * erasing a value with null, opportunity/about only when empty. Then the to-dos.
 * `asof` = date of the latest email the answer was based on.
 */
export function applyCardAutofill(dealId: string, card: unknown, meta: { asof: string | null; lost: boolean }): CardResult {
  const res: CardResult = { saved: [], todos: { added: [], done: [], removed: [] } };
  const c = (card && typeof card === "object" ? card : {}) as Record<string, any>;
  const now = new Date().toISOString();

  db.transaction(() => {
    const cur = db.prepare(`SELECT deadline, deadline_date, next_steps, key_details, contact_info, opportunity, about, currency, estimated_value, fields_source FROM deals_deals WHERE id = ?`).get(dealId) as any;
    if (!cur) return;
    const source = readSource(dealId) ?? {};
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: dealId };
    const put = (col: string, key: CardKey, v: unknown) => {
      if (source[key] === "human") return;
      if (v === cur[col]) { if (source[key] !== "ai" && v != null) { source[key] = "ai"; } return; }
      sets.push(`${col} = @${col}`);
      params[col] = v;
      source[key] = "ai";
      if (!res.saved.includes(key)) res.saved.push(key);
    };
    const text = (k: string) => {
      const v = c[k];
      if (typeof v !== "string") return null;
      const t = v.trim();
      return t && !/^\(?(empty|none|n\/a|null)\)?$/i.test(t) ? t.slice(0, LIMITS[k] ?? 600) : null;
    };

    // Deadline: text + date together (the date is the AI's reading of its own text).
    const dl = c.deadline && typeof c.deadline === "object" ? c.deadline : null;
    const dlText = dl && typeof dl.text === "string" ? dl.text.trim().slice(0, 80) : "";
    if (dlText && source.deadline !== "human") {
      const date = isYmd(dl.date) ? dl.date : null;
      if (dlText !== (cur.deadline ?? "") || (date && date !== cur.deadline_date)) {
        put("deadline", "deadline", dlText);
        sets.push("deadline_date = @deadline_date", "deadline_parsed_from = @deadline_parsed_from");
        params.deadline_date = date;
        params.deadline_parsed_from = date ? dlText : null; // no date from the AI → parsed below
        if (!res.saved.includes("deadline")) res.saved.push("deadline");
      }
    }
    for (const k of ["next_steps", "key_details", "contact_info"] as const) {
      const v = text(k);
      if (v) put(k, k, v);
    }
    for (const k of ["opportunity", "about"] as const) {
      const v = text(k);
      if (v && !(cur[k] ?? "").trim()) put(k, k, v);
    }
    const ccy = typeof c.currency === "string" && /^[A-Za-z]{3}$/.test(c.currency.trim()) ? c.currency.trim().toUpperCase() : null;
    const val = typeof c.estimated_value === "number" ? c.estimated_value : typeof c.estimated_value === "string" ? Number(c.estimated_value.replace(/[^0-9.]/g, "")) : NaN;
    // A lost deal keeps the value it was lost at (the AI tends to re-read the floor/quote there).
    if (!meta.lost && Number.isFinite(val) && val > 0 && val <= 500_000 && source.estimated_value !== "human") {
      put("estimated_value", "estimated_value", Math.round(val));
      if (ccy && source.currency !== "human") put("currency", "currency", ccy);
    } else if (!meta.lost && ccy && !cur.currency && source.currency !== "human") put("currency", "currency", ccy);

    sets.push("fields_source = @fields_source", "card_filled_at = @now", "card_asof = @asof");
    params.fields_source = JSON.stringify(source);
    params.now = now;
    params.asof = meta.asof ? String(meta.asof).slice(0, 10) : todayBangkok();
    db.prepare(`UPDATE deals_deals SET ${[...new Set(sets)].join(", ")} WHERE id = @id`).run(params);

    // ── To-dos
    const t = c.todos && typeof c.todos === "object" ? c.todos : {};
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
    const actions = db.prepare(`SELECT id, content, status, source, status_by FROM deals_deal_actions WHERE deal_id = ?`).all(dealId) as any[];
    const byId = new Map(actions.map((a) => [a.id, a]));
    for (const id of ids(t.done)) {
      const a = byId.get(id);
      if (!a || a.status === "Done" || a.status_by === "human") continue;
      dealActions.update(id, { status: "Done", statusBy: "auto" });
      a.status = "Done";
      res.todos.done.push(String(a.content ?? ""));
    }
    const removeIds = new Set(ids(t.remove));
    if (meta.lost) for (const a of actions) if (a.source === "auto" && a.status !== "Done") removeIds.add(a.id);
    for (const id of removeIds) {
      const a = byId.get(id);
      // Only our own, still-open, never-touched to-dos are removed.
      if (!a || a.source !== "auto" || a.status === "Done" || a.status_by === "human") continue;
      dealActions.remove(id);
      byId.delete(id);
      res.todos.removed.push(String(a.content ?? ""));
    }
    if (!meta.lost) {
      const seen = new Set([...byId.values()].map((a) => norm(String(a.content ?? ""))));
      let open = [...byId.values()].filter((a) => a.status !== "Done").length;
      for (const raw of (Array.isArray(t.add) ? t.add : []).slice(0, 3)) {
        if (typeof raw !== "string") continue;
        const content = raw.trim().replace(/\s+/g, " ").slice(0, 120);
        if (content.length < 4 || seen.has(norm(content)) || open >= 6) continue;
        dealActions.insert({ content, status: "Pending", deal: dealId, source: "auto" });
        seen.add(norm(content));
        open++;
        res.todos.added.push(content);
      }
    }
  })();
  // The AI wrote a deadline text without a date → the parser reads it (rules, AI if ambiguous).
  const after = db.prepare(`SELECT deadline, deadline_parsed_from FROM deals_deals WHERE id = ?`).get(dealId) as { deadline: string | null; deadline_parsed_from: string | null } | undefined;
  if (after?.deadline && after.deadline_parsed_from !== after.deadline) refreshDeadlineDate(dealId, { ai: true });
  return res;
}

/** Mark a deal whose extraction found no thread as filled (so the backfill does not retry it forever). */
export function markCardNoThread(dealId: string): void {
  db.prepare(`UPDATE deals_deals SET card_filled_at = ? WHERE id = ?`).run(new Date().toISOString(), dealId);
}
