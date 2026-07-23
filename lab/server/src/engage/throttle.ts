/**
 * Engagement Manager — throttle, pacing and active hours (Phase 3).
 *
 * This is the layer that keeps an autonomous replier from looking (or behaving)
 * like a bot: fixed-window per-platform caps, randomized human delays, and a
 * local-time active-hours window so replies don't appear at 4am in a steady
 * drip. It is deliberately separate from the sender so the limits can be
 * reasoned about — and tested — without a browser.
 *
 * Every gate here is a REFUSAL, never a queue-forever: when a cap is hit the
 * decision is recorded with a reason and the item is left for the next window,
 * rather than piling up an unbounded backlog that floods a platform the moment
 * the window rolls over.
 */
import { bumpRateCounter, sentInWindow } from "./db.js";
import type { EngageSettings, Pacing, Platform, RateCaps } from "./types.js";

/**
 * Default caps per platform when settings don't specify one. Deliberately
 * conservative — these are "a busy person answering comments" numbers, not
 * throughput targets.
 */
const DEFAULT_REPLY_CAPS: Record<Platform, RateCaps> = {
  // YouTube is monitor-only (make.com owns replies there); 0 = never send.
  youtube: { hour: 0, day: 0 },
  instagram: { hour: 6, day: 30 },
  facebook: { hour: 6, day: 30 },
  tiktok: { hour: 6, day: 30 },
};

/** The IANA timezone active-hours are evaluated in (the operator's local time). */
function timezone(): string {
  return process.env.ENGAGE_TIMEZONE || "UTC";
}

/**
 * Local hour (0-23) in the configured timezone. Uses Intl rather than a
 * fixed offset so DST is handled without a dependency; falls back to UTC if
 * the timezone name is bad.
 */
export function localHour(at: number = Date.now()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone(),
      hour: "numeric",
      hour12: false,
    });
    const h = Number.parseInt(fmt.format(new Date(at)), 10);
    return Number.isFinite(h) ? h % 24 : new Date(at).getUTCHours();
  } catch {
    return new Date(at).getUTCHours();
  }
}

/** Start of the containing hour/day window (epoch-ms), used as the counter key. */
export function windowStart(kind: "hour" | "day", at: number = Date.now()): number {
  const ms = kind === "hour" ? 3_600_000 : 86_400_000;
  return Math.floor(at / ms) * ms;
}

/** Resolve the caps for a platform: settings first, then the safe defaults. */
export function capsFor(settings: EngageSettings, platform: Platform): RateCaps {
  const configured = settings.caps?.[platform];
  if (configured && typeof configured.hour === "number" && typeof configured.day === "number") {
    return configured;
  }
  return DEFAULT_REPLY_CAPS[platform] ?? { hour: 0, day: 0 };
}

/**
 * Is the given moment inside the active-hours window? Windows are inclusive of
 * the start hour and exclusive of the end, and a window that wraps midnight
 * (e.g. [22, 6]) is supported.
 */
export function withinActiveHours(pacing: Pacing, at: number = Date.now()): boolean {
  const [start, end] = pacing.activeHours;
  const h = localHour(at);
  if (start === end) return true; // degenerate window = always on
  if (start < end) return h >= start && h < end;
  return h >= start || h < end; // wraps midnight
}

/** Milliseconds until the next active-hours window opens (0 if already open). */
export function msUntilActive(pacing: Pacing, at: number = Date.now()): number {
  if (withinActiveHours(pacing, at)) return 0;
  // Step forward in 15-minute increments — cheap, and correct across DST since
  // withinActiveHours re-evaluates local time each step.
  const step = 15 * 60_000;
  for (let i = 1; i <= 4 * 24; i++) {
    const t = at + i * step;
    if (withinActiveHours(pacing, t)) return t - at;
  }
  return 0;
}

/** A randomized human delay from the pacing config, in milliseconds. */
export function humanDelayMs(pacing: Pacing): number {
  const min = Math.max(0, Math.floor(pacing.minDelaySec));
  const max = Math.max(min, Math.floor(pacing.maxDelaySec));
  const sec = min + Math.floor(Math.random() * (max - min + 1));
  return sec * 1_000;
}

/**
 * When should a reply drafted now actually be sent? A random delay after now,
 * pushed into the next active-hours window if that lands outside it.
 */
export function scheduleAt(pacing: Pacing, from: number = Date.now()): number {
  const target = from + humanDelayMs(pacing);
  const wait = msUntilActive(pacing, target);
  return target + wait;
}

export interface ThrottleVerdict {
  allowed: boolean;
  /** Populated when not allowed — shown in the queue and stored on the reply. */
  reason: string;
}

/**
 * The full send-time gate. Checked immediately BEFORE dispatch (not at draft
 * time) so a reply queued an hour ago can't slip past a cap that has since
 * filled, or go out after the kill-switch was armed.
 */
export function canSend(settings: EngageSettings, platform: Platform, at: number = Date.now()): ThrottleVerdict {
  if (settings.killSwitch) {
    return { allowed: false, reason: "Kill-switch is armed — autonomy is paused." };
  }
  if (!settings.globalAutoreply) {
    return { allowed: false, reason: "Global autoreply is off." };
  }
  const caps = capsFor(settings, platform);
  if (caps.hour <= 0 || caps.day <= 0) {
    return { allowed: false, reason: `Replies are disabled for ${platform} (cap is zero).` };
  }
  if (!withinActiveHours(settings.pacing, at)) {
    const [s, e] = settings.pacing.activeHours;
    return { allowed: false, reason: `Outside active hours (${s}:00–${e}:00 ${timezone()}).` };
  }
  const hourUsed = sentInWindow(platform, "hour", windowStart("hour", at));
  if (hourUsed >= caps.hour) {
    return { allowed: false, reason: `Hourly cap reached for ${platform} (${hourUsed}/${caps.hour}).` };
  }
  const dayUsed = sentInWindow(platform, "day", windowStart("day", at));
  if (dayUsed >= caps.day) {
    return { allowed: false, reason: `Daily cap reached for ${platform} (${dayUsed}/${caps.day}).` };
  }
  return { allowed: true, reason: "" };
}

/** Book a successful send against both windows. Call ONLY after a real send. */
export function recordSend(platform: Platform, at: number = Date.now()): void {
  bumpRateCounter(platform, "hour", windowStart("hour", at));
  bumpRateCounter(platform, "day", windowStart("day", at));
}

/** Current usage for the UI: how much of each window is spent. */
export function usage(
  settings: EngageSettings,
  platform: Platform,
  at: number = Date.now(),
): { hour: { used: number; cap: number }; day: { used: number; cap: number } } {
  const caps = capsFor(settings, platform);
  return {
    hour: { used: sentInWindow(platform, "hour", windowStart("hour", at)), cap: caps.hour },
    day: { used: sentInWindow(platform, "day", windowStart("day", at)), cap: caps.day },
  };
}
