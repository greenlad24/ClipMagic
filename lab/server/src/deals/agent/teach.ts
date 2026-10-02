/**
 * Teaching the email agent a rule — from a conversation or a note (Jake
 * 2026-10-02: "I want to add a conversation between me and my partner and have
 * the agent understand the new rule", in Slack AND in the Lab).
 *
 *   understandRules(text)   Opus reads the conversation against the current
 *                           rulebook and returns what was DECIDED, as rules,
 *                           plus anything left unclear. Nothing is saved.
 *   Lab                     preview → Jake edits → save (handlers below).
 *   Slack                   a top-level message in the agent's channel that
 *                           starts with "rule:" (or "rules:", "new rule:") is
 *                           read ~90s after Jake's last edit, saved, and the
 *                           understanding is posted in its thread. Replying in
 *                           that thread corrects it: the whole thread is read
 *                           again and replaces the rules it taught.
 *
 * Saved rules live in houseRules.ts and are appended to the rulebook, so every
 * stage of the agent follows them from its next call on.
 */
import { db } from "../../db/index.js";
import { slackChannelHistory, slackPost, slackStatus, slackThread, resolveChannel } from "../integrations/slack.js";
import { getSettings } from "./settings.js";
import { loadRulebook, STAGES } from "./rulebook.js";
import { aiJSON, draftModel, errMsg } from "./util.js";
import { insertRules, retireRulesForSlackTs, type HouseRule, type NewRule } from "./houseRules.js";

export interface Understanding { summary: string; rules: NewRule[]; unclear: string[] }

const SYSTEM = [
  "You maintain the rulebook of Jake Dawson's sponsorship email agent (it triages his sponsor inbox, drafts replies in his voice, asks him on Slack when unsure, follows up and moves deal cards).",
  "Jake gives you either a note or a pasted conversation — usually between him and his business partner (Elad) — where they decided how something should be handled from now on. Turn what they DECIDED into rules the agent can follow.",
  "",
  "How to read it:",
  "- Only what was agreed or decided is a rule. Jake has the final say: if they disagree, Jake's last position wins; if it ends without a decision, put it under `unclear` as a short question, not as a rule.",
  "- A passing remark, an example, a joke or a one-off decision about a single email is NOT a rule. A decision about one brand IS a rule, scoped to that brand.",
  "- Each rule is one or two imperative sentences the agent can act on without the conversation: who/when it applies, what to do, the exact numbers, prices, dates, names and wording they settled on. Never soften or generalise their numbers.",
  "- If a rule changes or contradicts a numbered rule (or a J-rule) in the rulebook below, say which in `overrides` (e.g. \"#19 counter-offer threshold\"). If it adds something new, overrides is null.",
  "- Scope: \"brand\" (give the brand name as they wrote it) when it only applies to one brand/company; \"stage\" (one of: " + STAGES.join(", ") + ") when it only applies to one email stage; otherwise \"general\".",
  "- When the text is a thread where later messages correct earlier ones, the latest correction wins; return the full corrected set of rules (they replace the earlier ones).",
  "- If the latest message asks to drop/cancel the rule(s), return an empty rules list and say so in summary.",
  "- At most 8 rules. Plain English. No markdown.",
  "",
  "Return JSON only: {\"summary\": \"one sentence: what they decided\", \"rules\": [{\"rule\": string, \"scope\": \"general\"|\"brand\"|\"stage\", \"brand\": string|null, \"stage\": string|null, \"overrides\": string|null}], \"unclear\": [string]}",
].join("\n");

/** Read a conversation / note and return the rules it decides. Saves nothing. */
export async function understandRules(text: string): Promise<Understanding> {
  const input = String(text ?? "").trim();
  if (input.length < 10) throw Object.assign(new Error("Paste the conversation or write the rule first."), { status: 400 });
  const r = await aiJSON<any>({
    model: draftModel(),
    purpose: "deals-agent-learn",
    system: `${SYSTEM}\n\n# THE CURRENT RULEBOOK (for context and conflicts)\n\n${loadRulebook()}`,
    user: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nWHAT JAKE GAVE YOU:\n"""\n${input.slice(0, 60_000)}\n"""`,
    effort: "medium",
  });
  const rules: NewRule[] = (Array.isArray(r?.rules) ? r.rules : []).slice(0, 8)
    .filter((x: any) => x && typeof x.rule === "string" && x.rule.trim().length >= 8)
    .map((x: any) => ({
      rule: String(x.rule).trim(),
      scope: x.scope === "brand" || x.scope === "stage" ? x.scope : "general",
      brand: x.scope === "brand" ? (x.brand ? String(x.brand) : null) : null,
      stage: x.scope === "stage" ? (x.stage ? String(x.stage) : null) : null,
      overrides: x.overrides ? String(x.overrides).slice(0, 200) : null,
    }));
  return { summary: String(r?.summary ?? "").slice(0, 600), rules, unclear: (Array.isArray(r?.unclear) ? r.unclear : []).map(String).slice(0, 6) };
}

/* ── Slack ─────────────────────────────────────────────────────────────────── */

const TAG = "[deals-teach]";
const TICK_MS = 60_000;
const QUIET_MS = 90_000;
const FOLLOW_DAYS = 14;
const TRIGGER = /^\s*(?:new\s+)?rules?\s*[:\-–—]\s*/i;

db.exec(`
CREATE TABLE IF NOT EXISTS deals_agent_teach_msgs (
  ts TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,          -- waiting | done | failed
  handled_through TEXT,          -- latest human ts (message or reply) already acted on
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deals_agent_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

const kvGet = (k: string): string | null => (db.prepare(`SELECT v FROM deals_agent_kv WHERE k = ?`).get(k) as any)?.v ?? null;
const kvSet = (k: string, v: string) => db.prepare(`INSERT OR REPLACE INTO deals_agent_kv (k, v) VALUES (?, ?)`).run(k, v);

/** Slack escapes &, <, > and wraps links/mentions in <…>. */
function fromSlack(text: string): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<mailto:([^|>]+)\|[^>]+>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const tsMs = (ts: string | null | undefined) => (ts ? Math.round(Number(ts) * 1000) : 0);

function formatUnderstanding(u: Understanding, saved: HouseRule[], updated: boolean): string {
  if (!saved.length) {
    return [
      updated ? "Done — I've dropped the rule(s) from this thread." : "I couldn't find a decided rule in that.",
      u.summary ? `_${u.summary}_` : "",
      ...(u.unclear.length ? ["", "*Still open:*", ...u.unclear.map((q) => `• ${q}`)] : []),
      updated ? "" : "Reply in this thread with the decision and I'll save it.",
    ].filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n");
  }
  return [
    updated ? "Updated — from now on I'll follow:" : "Got it — from now on I'll follow:",
    ...saved.map((r, i) => `${i + 1}. ${r.scope === "brand" && r.brand ? `[${r.brand}] ` : r.scope === "stage" && r.stage ? `[${r.stage}] ` : ""}${r.rule}${r.overrides ? `  _(changes ${r.overrides})_` : ""}`),
    ...(u.unclear.length ? ["", "*Not sure about:*", ...u.unclear.map((q) => `• ${q}`)] : []),
    "",
    "Reply in this thread to correct me. You can also edit these on the Agent page in the Lab.",
  ].join("\n");
}

async function processMessage(channel: string, ts: string, text: string, repliesText: string[], post: boolean): Promise<void> {
  const isCorrection = repliesText.length > 0;
  const conversation = isCorrection
    ? [`ORIGINAL MESSAGE:\n${text}`, ...repliesText.map((r, i) => `CORRECTION ${i + 1} (later — wins over what came before):\n${r}`)].join("\n\n")
    : text;
  const u = await understandRules(conversation);
  if (isCorrection) retireRulesForSlackTs(ts);
  const saved = insertRules(u.rules, { source: "slack", raw: conversation, slackChannel: channel, slackTs: ts });
  console.log(`${TAG} ${isCorrection ? "updated" : "learned"} ${saved.length} rule(s) from Slack ${ts}`);
  if (post) await slackPost(formatUnderstanding(u, saved, isCorrection), ts, channel);
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let pausedUntil = 0;

async function tick(): Promise<void> {
  if (ticking || Date.now() < pausedUntil) return;
  const st = slackStatus();
  if (!st.configured || !st.hasTarget) return;
  ticking = true;
  try {
    const channel = await resolveChannel();
    const post = getSettings().postToSlack;
    const oldest = kvGet("teach_oldest");
    if (!oldest) { kvSet("teach_oldest", String(Date.now() / 1000)); return; } // first start: only messages from now on

    // 1. New "rule:" messages.
    const msgs = await slackChannelHistory(channel, oldest);
    let newest = oldest;
    for (const m of msgs) {
      if (Number(m.ts) > Number(newest)) newest = m.ts;
      if (m.bot || (m.subtype && m.subtype !== "thread_broadcast") || !TRIGGER.test(m.text)) continue;
      db.prepare(`INSERT OR IGNORE INTO deals_agent_teach_msgs (ts, channel, status, created_at) VALUES (?, ?, 'waiting', ?)`).run(m.ts, channel, new Date().toISOString());
    }
    // Keep a 30-minute overlap so an edited message is seen again before it is acted on.
    kvSet("teach_oldest", String(Math.max(Number(oldest), Number(newest) - 1800)));

    // 2. Act on waiting messages once Jake has stopped editing; follow corrections in their threads.
    const rows = db.prepare(`SELECT * FROM deals_agent_teach_msgs WHERE status IN ('waiting','done') AND created_at > ?`)
      .all(new Date(Date.now() - FOLLOW_DAYS * 86_400_000).toISOString()) as any[];
    for (const row of rows) {
      try {
        const { head, replies } = await slackThread(row.channel, row.ts);
        if (!head) { db.prepare(`UPDATE deals_agent_teach_msgs SET status = 'failed' WHERE ts = ?`).run(row.ts); continue; } // deleted
        const text = head.text;
        const editedAt = head.editedTs;
        const body = fromSlack(text.replace(TRIGGER, ""));
        const human = replies.filter((r) => !r.bot);
        const lastHuman = Math.max(tsMs(row.ts), tsMs(editedAt), ...human.map((r) => Math.max(tsMs(r.ts), tsMs(r.editedTs))));
        if (Date.now() - lastHuman < QUIET_MS) continue; // still typing / editing
        if (row.status === "waiting") {
          await processMessage(row.channel, row.ts, body, human.map((r) => fromSlack(r.text)), post);
          db.prepare(`UPDATE deals_agent_teach_msgs SET status = 'done', handled_through = ? WHERE ts = ?`).run(String(lastHuman), row.ts);
        } else if (lastHuman > Number(row.handled_through ?? 0)) {
          await processMessage(row.channel, row.ts, body, human.map((r) => fromSlack(r.text)), post);
          db.prepare(`UPDATE deals_agent_teach_msgs SET handled_through = ? WHERE ts = ?`).run(String(lastHuman), row.ts);
        }
      } catch (e: any) {
        if (e?.retryAfterSec) { pausedUntil = Date.now() + e.retryAfterSec * 1000; return; }
        console.warn(`${TAG} could not handle rule message ${row.ts}: ${errMsg(e)}`);
        if (row.status === "waiting") {
          db.prepare(`UPDATE deals_agent_teach_msgs SET status = 'failed' WHERE ts = ?`).run(row.ts);
          if (post) { try { await slackPost(`Sorry — I couldn't read that rule (${errMsg(e).slice(0, 160)}). Add it on the Agent page in the Lab, or post it again.`, row.ts, row.channel); } catch { /* ignore */ } }
        }
      }
    }
  } catch (e: any) {
    pausedUntil = Date.now() + (e?.retryAfterSec ? e.retryAfterSec * 1000 : 10 * 60_000);
    console.warn(`${TAG} tick failed: ${errMsg(e)}`);
  } finally {
    ticking = false;
  }
}

/** Start the Slack rule watcher (idempotent). */
export function startRuleTeachWatcher(): void {
  if (timer) return;
  console.log(`${TAG} started — "rule: …" messages in the agent's Slack channel become rules (read ${QUIET_MS / 1000}s after the last edit)`);
  setTimeout(() => void tick(), 20_000).unref?.();
  timer = setInterval(() => void tick(), TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}
