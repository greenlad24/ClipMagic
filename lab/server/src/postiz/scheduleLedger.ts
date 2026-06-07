/**
 * Persistent per-channel scheduling LEDGER for the Bulk Scheduler.
 *
 * The pure scheduling engine (scheduling.ts) has no memory: every run starts
 * from `now`, so large batches scheduled across multiple runs collide, ignore
 * the per-channel daily cap, and re-schedule the same video. This ledger gives
 * the orchestrator (bulkScheduler.ts) that memory by recording — per CHANNEL —
 * every post THIS TOOL has actually scheduled:
 *
 *   - the scheduled instants (ISO-UTC), enough to derive, in any timezone, the
 *     per-local-day counts and the furthest/last scheduled local day; and
 *   - the set of `fileId`s already scheduled to that channel, for de-dupe.
 *
 * It is NOT secret (unlike postizSecrets) — it just persists in the lab's own
 * (git-ignored) data dir. Persistence mirrors the postizSecrets pattern: a JSON
 * file under config.dataDir, with reads/writes that NEVER throw — a missing or
 * corrupt file degrades to empty state, a read-only dir never crashes scheduling.
 *
 * The engine stays PURE: bulkScheduler reads this ledger and passes the derived
 * per-channel starting state INTO buildSchedule; the ledger never reaches the
 * pure engine itself.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** The on-disk shape: per channel, the scheduled instants + scheduled fileIds. */
interface ChannelLedgerEntry {
  /** ISO-UTC instants we've scheduled to this channel (sorted ascending). */
  scheduledAt: string[];
  /** fileIds ("<kind>:<ref>") already scheduled to this channel (de-dupe set). */
  fileIds: string[];
}
type LedgerFile = Record<string, ChannelLedgerEntry>;

/** In-memory channel state handed to callers (Set for O(1) de-dupe checks). */
export interface ChannelState {
  scheduledAt: string[];
  fileIds: Set<string>;
}

/**
 * Resolve the ledger path lazily so a test can point it at a throwaway file via
 * BULK_SCHEDULE_LEDGER_PATH without re-importing config; otherwise it lives in
 * the lab's (git-ignored) data dir.
 */
function ledgerPath(): string {
  return process.env.BULK_SCHEDULE_LEDGER_PATH || path.join(config.dataDir, "bulk-schedule-ledger.json");
}

// ── Persistence (resilient: never throws on read; best-effort on write) ───────
function readLedger(): LedgerFile {
  try {
    const raw = fs.readFileSync(ledgerPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: LedgerFile = {};
    for (const [channelId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { scheduledAt?: unknown; fileIds?: unknown };
      const scheduledAt = Array.isArray(e.scheduledAt)
        ? e.scheduledAt.filter((s): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s)))
        : [];
      const fileIds = Array.isArray(e.fileIds)
        ? e.fileIds.filter((s): s is string => typeof s === "string" && s.length > 0)
        : [];
      out[channelId] = { scheduledAt, fileIds };
    }
    return out;
  } catch {
    /* missing or corrupt → empty state */
    return {};
  }
}

function writeLedger(ledger: LedgerFile): void {
  try {
    const p = ledgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(ledger, null, 2));
  } catch {
    /* best-effort: a read-only data dir must never crash scheduling */
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
/** Current state for a channel (empty when nothing has been scheduled to it). */
export function getChannelState(channelId: string): ChannelState {
  const entry = readLedger()[channelId];
  if (!entry) return { scheduledAt: [], fileIds: new Set() };
  return {
    scheduledAt: [...entry.scheduledAt].sort(),
    fileIds: new Set(entry.fileIds),
  };
}

/**
 * Record one SUCCESSFULLY scheduled post. Idempotent on the (channel, instant)
 * pair and the (channel, fileId) pair so a retry can't double-count. Callers
 * MUST only call this for posts that actually went out, so continuity advances
 * for real posts only.
 */
export function recordScheduled(channelId: string, fileId: string, scheduledAtIso: string): void {
  const iso = new Date(scheduledAtIso).toISOString(); // normalize
  const ledger = readLedger();
  const entry = ledger[channelId] ?? { scheduledAt: [], fileIds: [] };
  if (!entry.scheduledAt.includes(iso)) entry.scheduledAt.push(iso);
  entry.scheduledAt.sort();
  if (!entry.fileIds.includes(fileId)) entry.fileIds.push(fileId);
  ledger[channelId] = entry;
  writeLedger(ledger);
}

/**
 * Derive, for a given timezone, the per-local-day post counts and the FURTHEST
 * (last) local day this channel already has a post on. Keys are local
 * "YYYY-MM-DD" strings so the engine can pre-seed a partially-filled last day
 * and continue after it.
 *
 *   - `countsByLocalDay[day]` = how many posts already land on that local day;
 *   - `furthestLocalDay` = the max local day, or null when the channel is empty.
 */
export function deriveChannelTimeline(
  scheduledAt: string[],
  timezone: string,
): { furthestLocalDay: string | null; countsByLocalDay: Record<string, number> } {
  const countsByLocalDay: Record<string, number> = {};
  let furthestLocalDay: string | null = null;
  for (const iso of scheduledAt) {
    const day = localDayKey(new Date(iso), timezone);
    if (!day) continue;
    countsByLocalDay[day] = (countsByLocalDay[day] ?? 0) + 1;
    if (furthestLocalDay === null || day > furthestLocalDay) furthestLocalDay = day;
  }
  return { furthestLocalDay, countsByLocalDay };
}

/** Local "YYYY-MM-DD" for an instant in a zone (null on a bad date). */
function localDayKey(date: Date, timeZone: string): string | null {
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  return y && mo && d ? `${y}-${mo}-${d}` : null;
}
