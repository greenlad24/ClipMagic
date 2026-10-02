/**
 * Agent settings — one key/value table, read fresh on every run (so flipping
 * saveToGmail / postToSlack applies to the very next run, no restart).
 *
 * SAFE DEFAULTS: enabled, but saveToGmail=false and postToSlack=false → every
 * run is a PREVIEW that stores its drafts/questions in the Lab only.
 */
import { db } from "../../db/index.js";

db.exec(`
CREATE TABLE IF NOT EXISTS deals_agent_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
`);

export interface AgentSettings {
  enabled: boolean;
  saveToGmail: boolean;
  postToSlack: boolean;
  times: string[];
  signature: string;
  maxThreadsPerRun: number;
}

const DEFAULTS: Omit<AgentSettings, "signature"> = {
  enabled: true,
  saveToGmail: false,
  postToSlack: false,
  times: ["08:00", "20:00"],
  maxThreadsPerRun: 25,
};

/** The full signature Jake uses most on sponsor emails (fallback if the history can't be read). */
export const FALLBACK_SIGNATURE = [
  "Best regards,",
  "Jake Dawson",
  "Website <https://jakedaw.com/>",
  "Email <jakedawsonbusiness@gmail.com>",
  "YouTube <https://www.youtube.com/@Jake.Dawson>",
  "Partner <http://www.jakedaw.com/partners>",
].join("\n");

export function getRaw(key: string): string | null {
  const r = db.prepare(`SELECT value FROM deals_agent_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setRaw(key: string, value: string | null): void {
  db.prepare(
    `INSERT INTO deals_agent_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

function getJson<T>(key: string, fallback: T): T {
  const raw = getRaw(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/**
 * Rule #48: the same full signature on every email. Taken from Jake's own
 * recent SENT mail in the imported history: the most frequent sign-off block
 * that carries the Website/YouTube links. Computed once, then stored as an
 * editable setting.
 */
export function extractSignatureFromHistory(): string | null {
  try {
    const rows = db.prepare(
      `SELECT body_text FROM deals_emails WHERE is_from_me = 1 AND body_text IS NOT NULL ORDER BY date_iso DESC LIMIT 400`,
    ).all() as { body_text: string }[];
    const counts = new Map<string, number>();
    for (const { body_text } of rows) {
      const fresh = body_text.replace(/\r\n/g, "\n").split(/\n\s*On [^\n]{3,200}wrote:/)[0].trim();
      const m = fresh.match(/(Best regards,?\s*\nJake Dawson\s*\n(?:[^\n]*<[^>]+>[^\n]*\n?){2,6})\s*$/);
      if (!m) continue;
      const sig = m[1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
      if (!/jakedaw\.com/i.test(sig)) continue;
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  } catch {
    return null;
  }
}

export function getSettings(): AgentSettings {
  let signature = getRaw("signature");
  if (!signature) {
    signature = extractSignatureFromHistory() ?? FALLBACK_SIGNATURE;
    setRaw("signature", signature);
  }
  const times = getJson<string[]>("times", DEFAULTS.times).filter((t) => /^\d{2}:\d{2}$/.test(t));
  return {
    enabled: getJson("enabled", DEFAULTS.enabled),
    saveToGmail: getJson("saveToGmail", DEFAULTS.saveToGmail),
    postToSlack: getJson("postToSlack", DEFAULTS.postToSlack),
    times: times.length ? times : DEFAULTS.times,
    signature,
    maxThreadsPerRun: Math.max(1, Math.min(100, getJson("maxThreadsPerRun", DEFAULTS.maxThreadsPerRun))),
  };
}

export function updateSettings(patch: Partial<AgentSettings>): AgentSettings {
  if (patch.enabled !== undefined) setRaw("enabled", JSON.stringify(Boolean(patch.enabled)));
  if (patch.saveToGmail !== undefined) setRaw("saveToGmail", JSON.stringify(Boolean(patch.saveToGmail)));
  if (patch.postToSlack !== undefined) setRaw("postToSlack", JSON.stringify(Boolean(patch.postToSlack)));
  if (patch.times !== undefined) {
    const t = [...new Set(patch.times.map((x) => String(x).trim()))];
    const bad = t.filter((x) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x));
    if (bad.length || !t.length) throw Object.assign(new Error(`times must be HH:MM (24h), got: ${bad.join(", ") || "none"}`), { status: 400 });
    setRaw("times", JSON.stringify(t.sort()));
  }
  if (patch.signature !== undefined) {
    const s = String(patch.signature).replace(/\r\n/g, "\n").trim();
    if (!s) throw Object.assign(new Error("signature cannot be empty"), { status: 400 });
    setRaw("signature", s);
  }
  if (patch.maxThreadsPerRun !== undefined) setRaw("maxThreadsPerRun", JSON.stringify(Number(patch.maxThreadsPerRun) || 25));
  return getSettings();
}

/* ── follow-up cadence + auto-close (agent/followups.ts, 2026-09-30) ──────────
 * One JSON key ("followUps") merged over the defaults, so a new field never
 * needs a migration. Jake approved both switches ON by default.
 */
export interface FollowUpSettings {
  /** Draft follow-ups for silent brands (A: 5/12/21 d, B: 5/12 d, C: 7 d after Jake's last sent email). */
  followUpsEnabled: boolean;
  /** Max follow-up drafts per run (best focus score first). */
  perRunCap: number;
  /** Days after the start of the silence (Jake's first unanswered email) for each follow-up, per focus grade. */
  cadence: { A: number[]; B: number[]; C: number[] };
  /** Move a ghosted deal to "Poor Fit Now" (lost reason "ghosted") once the cadence is used up. */
  autoCloseEnabled: boolean;
  /** Days of silence after the last follow-up before the auto-close. */
  closeAfterDays: number;
  /** A deal silent this many days since Jake's last email is "backlog": A gets one re-engagement, B/C close. */
  backlogDays: number;
  /** Days of silence after the backlog re-engagement before the auto-close. */
  backlogCloseAfterDays: number;
  /** Max auto-closes per run (the backlog is closed gradually so Jake sees it happen). */
  closuresPerRunCap: number;
  /** Max focus-score recomputes per run (only deals whose threads changed are recomputed). */
  focusPerRunCap: number;
}

export const FOLLOW_UP_DEFAULTS: FollowUpSettings = {
  followUpsEnabled: true,
  perRunCap: 8,
  cadence: { A: [5, 12, 21], B: [5, 12], C: [7] },
  autoCloseEnabled: true,
  closeAfterDays: 7,
  backlogDays: 60,
  backlogCloseAfterDays: 10,
  closuresPerRunCap: 30,
  focusPerRunCap: 25,
};

const clampInt = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const cleanCadence = (v: unknown, d: number[]): number[] => {
  if (!Array.isArray(v)) return d;
  const days = [...new Set(v.map((x) => Math.round(Number(x))).filter((x) => Number.isFinite(x) && x >= 1 && x <= 120))].sort((a, b) => a - b).slice(0, 6);
  return days;
};

export function getFollowUpSettings(): FollowUpSettings {
  const raw = getJson<Partial<FollowUpSettings>>("followUps", {});
  const D = FOLLOW_UP_DEFAULTS;
  const c = (raw.cadence ?? {}) as Partial<FollowUpSettings["cadence"]>;
  return {
    followUpsEnabled: typeof raw.followUpsEnabled === "boolean" ? raw.followUpsEnabled : D.followUpsEnabled,
    perRunCap: clampInt(raw.perRunCap, 0, 50, D.perRunCap),
    cadence: { A: cleanCadence(c.A, D.cadence.A), B: cleanCadence(c.B, D.cadence.B), C: cleanCadence(c.C, D.cadence.C) },
    autoCloseEnabled: typeof raw.autoCloseEnabled === "boolean" ? raw.autoCloseEnabled : D.autoCloseEnabled,
    closeAfterDays: clampInt(raw.closeAfterDays, 1, 90, D.closeAfterDays),
    backlogDays: clampInt(raw.backlogDays, 14, 365, D.backlogDays),
    backlogCloseAfterDays: clampInt(raw.backlogCloseAfterDays, 1, 90, D.backlogCloseAfterDays),
    closuresPerRunCap: clampInt(raw.closuresPerRunCap, 0, 200, D.closuresPerRunCap),
    focusPerRunCap: clampInt(raw.focusPerRunCap, 0, 400, D.focusPerRunCap),
  };
}

export function updateFollowUpSettings(patch: Partial<FollowUpSettings>): FollowUpSettings {
  const cur = getFollowUpSettings();
  const next: FollowUpSettings = {
    ...cur,
    ...Object.fromEntries(Object.entries(patch ?? {}).filter(([k, v]) => v !== undefined && k !== "cadence")),
    cadence: { ...cur.cadence, ...((patch?.cadence ?? {}) as Partial<FollowUpSettings["cadence"]>) },
  } as FollowUpSettings;
  setRaw("followUps", JSON.stringify(next));
  return getFollowUpSettings();
}
