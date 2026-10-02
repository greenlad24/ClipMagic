/**
 * Jake's own rules for the email agent (Jake 2026-10-02: "I want to add a
 * conversation between me and my partner and have the agent understand the new
 * rule" — from Slack AND from the Lab).
 *
 * A rule is stored as Jake confirmed it (the agent's understanding, which he can
 * edit), with the raw conversation it came from. Active rules are appended to
 * the rulebook text by `loadRulebook()`, so triage, drafting, the pre-save
 * checks, fit and focus all see them, and they OVERRIDE the numbered rulebook
 * where the two disagree. Learned lessons (deals_agent_lessons) stay separate:
 * those are inferred, these are Jake's word.
 */
import { randomUUID } from "node:crypto";
import { db } from "../../db/index.js";

db.exec(`
CREATE TABLE IF NOT EXISTS deals_agent_rules (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'general',   -- general | brand | stage
  brand TEXT,
  stage TEXT,
  overrides TEXT,                            -- which rulebook rule it changes, as the agent understood it
  source TEXT NOT NULL,                      -- lab | slack
  raw TEXT,                                  -- the conversation / note it came from
  slack_channel TEXT,
  slack_ts TEXT,                             -- the Slack message that taught it (corrections come as replies)
  status TEXT NOT NULL DEFAULT 'active',     -- active | retired
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_agent_rules_slack ON deals_agent_rules (slack_ts);
`);

export interface HouseRule {
  id: string; rule: string; scope: "general" | "brand" | "stage"; brand: string | null; stage: string | null;
  overrides: string | null; source: "lab" | "slack"; raw: string | null; slackChannel: string | null; slackTs: string | null;
  status: "active" | "retired"; createdAt: string; updatedAt: string;
}

const now = () => new Date().toISOString();
const toRule = (r: any): HouseRule => ({
  id: r.id, rule: r.rule, scope: r.scope, brand: r.brand ?? null, stage: r.stage ?? null, overrides: r.overrides ?? null,
  source: r.source, raw: r.raw ?? null, slackChannel: r.slack_channel ?? null, slackTs: r.slack_ts ?? null,
  status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});

export interface NewRule { rule: string; scope?: string; brand?: string | null; stage?: string | null; overrides?: string | null }

export function insertRules(rules: NewRule[], meta: { source: "lab" | "slack"; raw?: string; slackChannel?: string; slackTs?: string }): HouseRule[] {
  const ins = db.prepare(`INSERT INTO deals_agent_rules (id, rule, scope, brand, stage, overrides, source, raw, slack_channel, slack_ts, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`);
  const out: HouseRule[] = [];
  for (const r of rules) {
    const text = String(r.rule ?? "").trim().slice(0, 1200);
    if (text.length < 8) continue;
    const scope = r.scope === "brand" || r.scope === "stage" ? r.scope : "general";
    const id = randomUUID();
    const t = now();
    ins.run(id, text, scope, scope === "brand" ? r.brand ?? null : null, scope === "stage" ? r.stage ?? null : null, r.overrides ?? null,
      meta.source, meta.raw?.slice(0, 40_000) ?? null, meta.slackChannel ?? null, meta.slackTs ?? null, t, t);
    out.push(getRule(id)!);
  }
  return out;
}

export function getRule(id: string): HouseRule | null {
  const r = db.prepare(`SELECT * FROM deals_agent_rules WHERE id = ?`).get(id);
  return r ? toRule(r) : null;
}

export function listRules(includeRetired = false): HouseRule[] {
  return (db.prepare(`SELECT * FROM deals_agent_rules ${includeRetired ? "" : "WHERE status = 'active'"} ORDER BY created_at DESC`).all() as any[]).map(toRule);
}

export function rulesForSlackTs(ts: string): HouseRule[] {
  return (db.prepare(`SELECT * FROM deals_agent_rules WHERE slack_ts = ? AND status = 'active' ORDER BY created_at`).all(ts) as any[]).map(toRule);
}

export function updateRule(id: string, patch: { rule?: string; scope?: string; brand?: string | null; stage?: string | null }): HouseRule | null {
  const cur = getRule(id);
  if (!cur) return null;
  const rule = patch.rule !== undefined ? String(patch.rule).trim().slice(0, 1200) : cur.rule;
  if (rule.length < 8) throw Object.assign(new Error("A rule needs to be a sentence the agent can follow."), { status: 400 });
  const scope = patch.scope === "brand" || patch.scope === "stage" || patch.scope === "general" ? patch.scope : cur.scope;
  db.prepare(`UPDATE deals_agent_rules SET rule = ?, scope = ?, brand = ?, stage = ?, updated_at = ? WHERE id = ?`)
    .run(rule, scope, scope === "brand" ? (patch.brand !== undefined ? patch.brand : cur.brand) : null, scope === "stage" ? (patch.stage !== undefined ? patch.stage : cur.stage) : null, now(), id);
  return getRule(id);
}

export function retireRule(id: string): void {
  db.prepare(`UPDATE deals_agent_rules SET status = 'retired', updated_at = ? WHERE id = ?`).run(now(), id);
}

export function retireRulesForSlackTs(ts: string): number {
  return db.prepare(`UPDATE deals_agent_rules SET status = 'retired', updated_at = ? WHERE slack_ts = ? AND status = 'active'`).run(now(), ts).changes;
}

/** The block appended to the rulebook. Empty string when there are none (keeps the cached prefix unchanged). */
export function houseRulesBlock(): string {
  const rules = listRules().slice().reverse(); // oldest first, so a later rule reads as the newer word
  if (!rules.length) return "";
  const line = (r: HouseRule, i: number) => {
    const where = r.scope === "brand" && r.brand ? `[only for ${r.brand}] ` : r.scope === "stage" && r.stage ? `[only in stage ${r.stage}] ` : "";
    return `J${i + 1}. ${where}${r.rule}${r.overrides ? ` (changes: ${r.overrides})` : ""}`;
  };
  return [
    "",
    "---",
    "",
    "## JAKE'S NEWER RULES — added by Jake after this rulebook was written",
    "",
    "Jake set these himself (from the Lab or Slack), often from a conversation with his partner. They are his latest word: where one of them disagrees with a numbered rule above, the J-rule wins. Where two J-rules disagree, the later one (higher number) wins.",
    "",
    ...rules.map(line),
  ].join("\n");
}
