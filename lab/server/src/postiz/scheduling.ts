/**
 * Best-times scheduling engine for the Bulk Scheduler — PURE and deterministic.
 *
 * Given a set of items (file × platform), the target audience timezone, an
 * optional intent hint, and a fixed `now`, it returns ONE scheduled UTC instant
 * per item, such that:
 *   - each instant falls inside a research-based optimal posting window for that
 *     platform in the audience's LOCAL time (DST-correct);
 *   - no two posts on the SAME channel land on the same minute (collision-free);
 *   - posts spread across upcoming days rather than dumping on day one;
 *   - everything is in the FUTURE relative to `now`;
 *   - results are deterministic for a fixed `now` (no Math.random / Date.now).
 *
 * Timezone correctness is done with Intl (no deps): we pick a desired LOCAL
 * wall-clock time in the target zone and resolve it to the exact UTC instant,
 * accounting for that zone's offset at that date (so EDT vs EST is automatic).
 *
 * `refineWithAnalytics` is the seam to later nudge windows using real Postiz
 * analytics; for v1 it's the identity function (documented TODO).
 */
import type { ShortPlatform } from "./providerSettings.js";
import { mulberry32 } from "./dropSequencing.js";

// ── Optimal posting windows (US / America/New_York audience) ─────────────────
// Local-time hour ranges, by platform, ranked best-first. These encode commonly
// cited 2024–2025 best-time research; they're a TUNABLE table, not gospel —
// refineWithAnalytics() is where live data should eventually override them.
//
// Sources (general best-time guidance, US audiences):
//   - Sprout Social "Best times to post on social media" (TikTok/IG/YouTube).
//   - Hootsuite / Buffer best-time-to-post studies (Shorts/Reels weekday AM+PM).
// Windows are weekday-biased; weekends get a lighter, late-morning slot.
export interface PostingWindow {
  /** 0=Sun … 6=Sat. */
  days: number[];
  /** Local start/end hour (24h). Posts land at `startHour:startMinute` onward. */
  startHour: number;
  endHour: number;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

/** Per-platform ranked windows (local time, target audience zone). */
export const PLATFORM_WINDOWS: Record<ShortPlatform, PostingWindow[]> = {
  // TikTok: strong weekday morning + early-afternoon engagement; Tue–Thu peak.
  tiktok: [
    { days: [2, 3, 4], startHour: 9, endHour: 11 }, // Tue–Thu mid-morning (top)
    { days: WEEKDAYS, startHour: 13, endHour: 15 }, // weekday early afternoon
    { days: WEEKDAYS, startHour: 19, endHour: 21 }, // weekday evening scroll
    { days: WEEKEND, startHour: 10, endHour: 12 }, // weekend late morning
  ],
  // Instagram Reels: late-morning weekday + lunch; Mon–Fri.
  instagram: [
    { days: WEEKDAYS, startHour: 11, endHour: 13 }, // weekday late-morning/lunch (top)
    { days: [1, 2, 3], startHour: 9, endHour: 10 }, // early-week AM
    { days: WEEKDAYS, startHour: 19, endHour: 21 }, // weekday evening
    { days: WEEKEND, startHour: 10, endHour: 11 },
  ],
  // YouTube Shorts: discovery skews afternoon/evening; weekday + weekend.
  youtube: [
    { days: WEEKDAYS, startHour: 15, endHour: 17 }, // weekday after-school/work (top)
    { days: WEEKDAYS, startHour: 12, endHour: 13 }, // weekday lunch
    { days: WEEKEND, startHour: 9, endHour: 11 }, // weekend morning (high watch-time)
    { days: WEEKDAYS, startHour: 20, endHour: 22 }, // weekday prime
  ],
};

// ── Intent hints: override the FIRST-choice window with an intentional slot ───
// An intent biases the local hour the user is targeting (e.g. catching the
// morning commute). It's applied across all platforms when set.
export type Intent = "commute" | "lunch" | "evening" | "none";

const INTENT_WINDOWS: Record<Exclude<Intent, "none">, { startHour: number; endHour: number; days: number[] }> = {
  // Weekday commute — EST mornings ~7–9am.
  commute: { startHour: 7, endHour: 9, days: WEEKDAYS },
  // Lunch break scroll.
  lunch: { startHour: 12, endHour: 13, days: WEEKDAYS },
  // After-dinner evening scroll.
  evening: { startHour: 19, endHour: 21, days: [0, 1, 2, 3, 4, 5, 6] },
};

export interface ScheduleItemInput {
  /** Stable id for the (file × channel) pair — echoed back on the result. */
  key: string;
  /** Selects the optimal posting WINDOWS (peak hours per platform). */
  platform: ShortPlatform | "generic";
  /**
   * The CHANNEL this post targets. Cap, continuity, and collision-avoidance are
   * all keyed by this (each channel is its own queue), while `platform` only
   * picks the time windows. Defaults to `platform` when omitted (back-compat with
   * the old per-platform behavior + the existing unit tests).
   */
  channelId?: string;
  /**
   * PINNED local day ("YYYY-MM-DD", audience timezone) this item must schedule on
   * — set by the drop sequencer so every channel of one video ("drop") lands on
   * the SAME local day (same 24h across accounts). The engine starts its day-walk
   * here (never before today) and only rolls forward if that day is genuinely
   * full/ineligible. Omitted → the old "earliest eligible day" behavior.
   */
  pinnedLocalDay?: string;
}

export interface ScheduleResult {
  key: string;
  /** ISO-8601 UTC instant for Postiz's `date`. */
  scheduledAt: string;
  /** Human-readable reasoning shown in the review UI. */
  reason: string;
}

/**
 * Per-channel STARTING STATE, derived by the caller from the persistent ledger
 * (bulkScheduler reads it; the engine stays pure). Lets a new batch CONTINUE the
 * channel's existing queue rather than restart from `now`:
 *   - `furthestLocalDay` ("YYYY-MM-DD") = the last local day the channel already
 *     has a post on; scheduling for that channel starts no earlier than this day,
 *     so it tops up a partially-filled last day before rolling forward.
 *   - `countsByLocalDay` pre-seeds the per-day fill so the cap is honored ACROSS
 *     runs (e.g. last day already has 1 post, cap 2 → add exactly 1 more there).
 *   - `occupiedInstants` pre-seeds the collision set so a new post never lands on
 *     an already-scheduled minute.
 */
export interface ChannelStartState {
  furthestLocalDay?: string | null;
  countsByLocalDay?: Record<string, number>;
  occupiedInstants?: string[];
}

export interface ScheduleOptions {
  /** IANA tz of the target audience. Default America/New_York ("US"). */
  timezone?: string;
  intent?: Intent;
  /** Fixed reference instant. Pure: callers pass this; tests fix it. */
  now: Date;
  /** First posting day = today (if a window is still ahead) or tomorrow. */
  startTomorrow?: boolean;
  /** Max posts per channel per day before rolling to the next day. Default 2. */
  maxPerChannelPerDay?: number;
  /**
   * Per-channel continuity seed (from the ledger), keyed by channelId. Channels
   * absent here simply start from `now` with an empty queue.
   */
  channelStartStates?: Record<string, ChannelStartState>;
  /**
   * When set, the exact posting MINUTE inside each window is jittered
   * deterministically from this seed + the item key, so posts don't all sit at
   * the window's :00. Omitted → the legacy behavior (window start, then +5min
   * steps only to dodge collisions). The jitter never leaves the window.
   */
  seed?: number;
}

// Generic window for platforms we don't have tuned rules for.
const GENERIC_WINDOWS: PostingWindow[] = [
  { days: WEEKDAYS, startHour: 11, endHour: 13 },
  { days: WEEKDAYS, startHour: 17, endHour: 19 },
  { days: WEEKEND, startHour: 10, endHour: 12 },
];

function windowsFor(platform: ShortPlatform | "generic"): PostingWindow[] {
  return platform === "generic" ? GENERIC_WINDOWS : PLATFORM_WINDOWS[platform];
}

// ── Timezone math (DST-correct, no deps) ─────────────────────────────────────
/**
 * Offset (minutes EAST of UTC) of `timeZone` at instant `date`. Computed by
 * formatting `date` AS that zone's wall-clock and diffing from the same fields
 * read as UTC. Positive for zones ahead of UTC; negative for the Americas.
 */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  // The wall-clock components, interpreted as if they were UTC.
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  // Difference between that and the true instant = the zone's offset.
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Resolve a desired LOCAL wall-clock (y/m/d h:m in `timeZone`) to the exact UTC
 * Date. Handles DST by computing the offset AT that local time (two-pass: guess
 * with a provisional offset, then correct using the offset at the guessed
 * instant — converges in one correction for all real zones).
 */
function localWallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): Date {
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  // First guess: subtract the offset at the naive instant.
  let offset = tzOffsetMinutes(new Date(naiveUtc), timeZone);
  let instant = naiveUtc - offset * 60000;
  // Correct once using the offset at the guessed instant (fixes DST edges).
  const offset2 = tzOffsetMinutes(new Date(instant), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    instant = naiveUtc - offset * 60000;
  }
  return new Date(instant);
}

/** Local Y/M/D + weekday for an instant in a zone. */
function localDateParts(date: Date, timeZone: string): { y: number; mo: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: Number(get("year")), mo: Number(get("month")), d: Number(get("day")), weekday: wdMap[get("weekday")] ?? 0 };
}

/** Add `n` calendar days to a local date, returning fresh parts (DST-safe via UTC math on the date only). */
function addLocalDays(parts: { y: number; mo: number; d: number }, n: number): { y: number; mo: number; d: number; weekday: number } {
  const base = Date.UTC(parts.y, parts.mo - 1, parts.d);
  const next = new Date(base + n * 86400000);
  return {
    y: next.getUTCFullYear(),
    mo: next.getUTCMonth() + 1,
    d: next.getUTCDate(),
    weekday: next.getUTCDay(),
  };
}

/** Local "YYYY-MM-DD" key for a local date — matches the ledger's day keys. */
function localDayKeyOf(parts: { y: number; mo: number; d: number }): string {
  return `${parts.y}-${String(parts.mo).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
}

/** Whole calendar days from `fromKey` to `toKey` (both "YYYY-MM-DD"); ≥0 when toKey ≥ fromKey. */
function daysBetweenLocal(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

const WD_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtLocalTime(h: number, mi: number): string {
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mi).padStart(2, "0")}${ampm}`;
}

const PLATFORM_LABEL: Record<ShortPlatform | "generic", string> = {
  tiktok: "TikTok",
  instagram: "Reels",
  youtube: "Shorts",
  generic: "post",
};

/**
 * Build the schedule. Items are processed in order; per item we pick its
 * platform's best window on the earliest eligible day, then place it at a free
 * minute ON ITS CHANNEL (spacing successive posts on the same channel by a few
 * minutes so they never collide and don't all fire at :00).
 *
 * Cap, continuity, and collision-avoidance are keyed by CHANNEL (each channel is
 * its own queue); the posting WINDOWS are still chosen by platform. Per-channel
 * continuity seeds (furthest day + per-day counts + occupied instants) come from
 * the caller (the ledger) so a new batch continues AFTER a channel's existing
 * queue without exceeding the daily cap or colliding with an occupied minute.
 */
export function buildSchedule(items: ScheduleItemInput[], options: ScheduleOptions): ScheduleResult[] {
  const timezone = options.timezone || "America/New_York";
  const intent: Intent = options.intent ?? "none";
  const maxPerDay = Math.max(1, options.maxPerChannelPerDay ?? 2);
  const now = options.now;
  const startStates = options.channelStartStates ?? {};
  const seed = options.seed;

  // Deterministic minute-within-window offset for an item (0..1), stable no matter
  // how many windows we try, so the jitter is reproducible from (seed, key).
  const jitterFor = (key: string): number => {
    if (seed === undefined) return 0;
    return mulberry32((hashStr(key) ^ (seed >>> 0)) >>> 0)();
  };

  // Per-CHANNEL state: the minute-slots already taken (as ISO strings) so we
  // never double-book the same minute, and how many posts land on each LOCAL day
  // (keyed by "YYYY-MM-DD" so the ledger's seed lines up across runs).
  const takenByChannel = new Map<string, Set<string>>();
  const placedByChannelDay = new Map<string, number>(); // `${channelId}|${localDay}`

  const today = localDateParts(now, timezone);
  const todayKey = localDayKeyOf(today);
  const baseStartOffset = options.startTomorrow ? 1 : 0;

  // The channel-state key: an explicit channelId (each channel its own queue) or
  // the platform when omitted (back-compat with the old per-platform behavior).
  const channelKeyOf = (item: ScheduleItemInput): string => item.channelId ?? item.platform;

  // Seed per-channel collision sets + per-day counts from the ledger ONCE.
  const seeded = new Set<string>();
  function seedChannel(channelId: string): void {
    if (seeded.has(channelId)) return;
    seeded.add(channelId);
    const state = startStates[channelId];
    if (!state) return;
    if (state.occupiedInstants?.length) {
      const taken = takenByChannel.get(channelId) ?? new Set<string>();
      for (const iso of state.occupiedInstants) {
        const t = Date.parse(iso);
        if (!Number.isNaN(t)) taken.add(new Date(t).toISOString());
      }
      takenByChannel.set(channelId, taken);
    }
    if (state.countsByLocalDay) {
      for (const [day, n] of Object.entries(state.countsByLocalDay)) {
        placedByChannelDay.set(`${channelId}|${day}`, n);
      }
    }
  }

  const results: ScheduleResult[] = [];

  for (const item of items) {
    const channelId = channelKeyOf(item);
    seedChannel(channelId);
    const windows = windowsFor(item.platform);
    const taken = takenByChannel.get(channelId) ?? new Set<string>();
    takenByChannel.set(channelId, taken);

    // A PINNED day (from the drop sequencer) wins: every channel of one drop must
    // land on that exact local day (same 24h across accounts), never before today.
    // Otherwise fall back to continuity: start no earlier than the channel's
    // furthest already-scheduled local day (top up a partial last day first).
    const furthest = startStates[channelId]?.furthestLocalDay ?? null;
    const pinned = item.pinnedLocalDay ?? null;
    const channelStartKey = pinned
      ? pinned > todayKey
        ? pinned
        : todayKey
      : furthest && furthest > todayKey
        ? furthest
        : todayKey;
    const startOffsetDays = baseStartOffset + daysBetweenLocal(todayKey, channelStartKey);

    let placed: ScheduleResult | null = null;

    // Walk forward day by day until we find an eligible window with a free slot.
    for (let dayOffset = startOffsetDays; dayOffset < startOffsetDays + 365 && !placed; dayOffset++) {
      const day = addLocalDays(today, dayOffset);
      const dayKey = `${channelId}|${localDayKeyOf(day)}`;
      const placedToday = placedByChannelDay.get(dayKey) ?? 0;
      if (placedToday >= maxPerDay) continue;

      // Candidate windows for this weekday, best-first. Intent (when set) takes
      // precedence as the FIRST choice if it applies to this weekday.
      const candidates: PostingWindow[] = [];
      if (intent !== "none") {
        const iw = INTENT_WINDOWS[intent];
        if (iw.days.includes(day.weekday)) {
          candidates.push({ days: [day.weekday], startHour: iw.startHour, endHour: iw.endHour });
        }
      }
      for (const w of windows) {
        if (w.days.includes(day.weekday)) candidates.push(w);
      }
      if (candidates.length === 0) continue;

      for (const w of candidates) {
        // Place inside the window on a 5-minute grid. With a seed we START from a
        // jittered slot (so posts aren't all at :00) and WRAP through the window;
        // without one we start at the window's :00 (legacy). Either way we step
        // through every slot to dodge collisions and spread same-channel posts.
        const slots = Math.max(1, Math.floor(((w.endHour - w.startHour) * 60) / 5));
        const base = Math.floor(jitterFor(item.key) * slots);
        for (let k = 0; k < slots; k++) {
          const slotIdx = (base + k) % slots;
          const minuteStep = slotIdx * 5;
          const h = w.startHour + Math.floor(minuteStep / 60);
          const mi = minuteStep % 60;
          if (h >= w.endHour) break;
          const utc = localWallClockToUtc(day.y, day.mo, day.d, h, mi, timezone);
          if (utc.getTime() <= now.getTime()) continue; // must be in the future
          const iso = utc.toISOString();
          if (taken.has(iso)) continue;

          taken.add(iso);
          placedByChannelDay.set(dayKey, placedToday + 1);
          const intentNote =
            intent !== "none" && candidates[0]?.startHour === w.startHour ? `${intentLabel(intent)} ` : "";
          placed = {
            key: item.key,
            scheduledAt: iso,
            reason: `${WD_NAMES[day.weekday]} ${fmtLocalTime(h, mi)} ${tzAbbrev(timezone)} — ${intentNote}peak ${PLATFORM_LABEL[item.platform]} window`,
          };
          break;
        }
        if (placed) break;
      }
    }

    // Fallback (extremely unlikely): if 60 days yielded nothing, place 1h ahead.
    if (!placed) {
      let iso = new Date(now.getTime() + 3600000).toISOString();
      while (taken.has(iso)) iso = new Date(new Date(iso).getTime() + 60000).toISOString();
      taken.add(iso);
      placed = { key: item.key, scheduledAt: iso, reason: "Next available slot" };
    }
    results.push(placed);
  }

  return results;
}

/** Stable 32-bit FNV-1a hash of a string (for deterministic per-item jitter). */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function intentLabel(intent: Exclude<Intent, "none">): string {
  return intent === "commute" ? "weekday commute," : intent === "lunch" ? "lunch break," : "evening scroll,";
}

/** Short tz label for the reasoning string (best-effort; falls back to the IANA name). */
function tzAbbrev(timeZone: string): string {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).format(new Date());
    const m = s.match(/[A-Z]{2,5}$/);
    return m ? m[0] : timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * SEAM for blending real Postiz analytics into a schedule. v1 = identity.
 *
 * TODO(live): use per-channel analytics (best-performing posting hours derived
 * from the engagement series) to nudge each scheduledAt toward the channel's
 * empirically best window, then re-run collision avoidance. Implemented as a
 * pure transform so it stays unit-testable.
 */
export function refineWithAnalytics(
  schedule: ScheduleResult[],
  _analyticsByChannel: Record<string, unknown>,
): ScheduleResult[] {
  return schedule;
}
