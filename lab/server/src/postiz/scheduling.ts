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
  /** Stable id for the (file × platform) pair — echoed back on the result. */
  key: string;
  platform: ShortPlatform | "generic";
}

export interface ScheduleResult {
  key: string;
  /** ISO-8601 UTC instant for Postiz's `date`. */
  scheduledAt: string;
  /** Human-readable reasoning shown in the review UI. */
  reason: string;
}

export interface ScheduleOptions {
  /** IANA tz of the target audience. Default America/New_York ("US"). */
  timezone?: string;
  intent?: Intent;
  /** Fixed reference instant. Pure: callers pass this; tests fix it. */
  now: Date;
  /** First posting day = today (if a window is still ahead) or tomorrow. */
  startTomorrow?: boolean;
  /** Max posts per channel per day before rolling to the next day. */
  maxPerChannelPerDay?: number;
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
 * minute on that channel (spacing successive posts on the same channel by a few
 * minutes so they never collide and don't all fire at :00).
 */
export function buildSchedule(items: ScheduleItemInput[], options: ScheduleOptions): ScheduleResult[] {
  const timezone = options.timezone || "America/New_York";
  const intent: Intent = options.intent ?? "none";
  const maxPerDay = Math.max(1, options.maxPerChannelPerDay ?? 1);
  const now = options.now;

  // Per-channel (platform) state: how many we've placed, and the minute-slots
  // already taken (as ISO strings) so we never double-book the same minute.
  const takenByPlatform = new Map<string, Set<string>>();
  const placedCountByPlatformDay = new Map<string, number>(); // `${platform}|${dayIndex}`

  const today = localDateParts(now, timezone);
  const startOffsetDays = options.startTomorrow ? 1 : 0;

  const results: ScheduleResult[] = [];

  for (const item of items) {
    const windows = windowsFor(item.platform);
    const taken = takenByPlatform.get(item.platform) ?? new Set<string>();
    takenByPlatform.set(item.platform, taken);

    let placed: ScheduleResult | null = null;

    // Walk forward day by day until we find an eligible window with a free slot.
    for (let dayOffset = startOffsetDays; dayOffset < startOffsetDays + 60 && !placed; dayOffset++) {
      const day = addLocalDays(today, dayOffset);
      const dayKey = `${item.platform}|${dayOffset}`;
      const placedToday = placedCountByPlatformDay.get(dayKey) ?? 0;
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
        // Place at the window start, nudging by minutes to avoid collisions and
        // to spread same-channel posts (5-minute steps inside the window).
        for (let minuteStep = 0; minuteStep <= (w.endHour - w.startHour) * 60 - 1; minuteStep += 5) {
          const h = w.startHour + Math.floor(minuteStep / 60);
          const mi = minuteStep % 60;
          if (h >= w.endHour) break;
          const utc = localWallClockToUtc(day.y, day.mo, day.d, h, mi, timezone);
          if (utc.getTime() <= now.getTime()) continue; // must be in the future
          const iso = utc.toISOString();
          if (taken.has(iso)) continue;

          taken.add(iso);
          placedCountByPlatformDay.set(dayKey, placedToday + 1);
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
