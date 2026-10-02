/**
 * Twice-a-day scheduler (#16): 08:00 and 20:00 Asia/Bangkok by default.
 *
 * A one-minute `setInterval(...).unref()` (same style as engage/monitor.ts)
 * checks whether a configured Bangkok time has passed since the last scheduled
 * run. The last fired slot is PERSISTED, so a restart never double-fires; after
 * downtime only the latest missed slot fires (once). The very first start just
 * records the latest passed slot — it doesn't fire on deploy.
 *
 * Not started here — the integrator calls startDealsAgentScheduler().
 */
import { getSettings, getRaw, setRaw } from "./settings.js";
import { runAgent, isRunning, runPreRunSteps, registerPreRunStep as register } from "./run.js";
import { bangkokParts, bangkokToUtc, errMsg } from "./util.js";

export const registerPreRunStep = register;

const SLOT_KEY = "lastScheduledSlot";
let timer: NodeJS.Timeout | null = null;

/** The most recent configured slot (ISO instant) at or before `now`, within the last 48h. */
export function latestPassedSlot(times: string[], now = new Date()): Date | null {
  const today = bangkokParts(now).iso;
  const yesterday = bangkokParts(new Date(now.getTime() - 86_400_000)).iso;
  const slots = [yesterday, today].flatMap((d) => times.map((t) => bangkokToUtc(d, t))).filter((s) => s.getTime() <= now.getTime());
  return slots.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}

/** The next configured slot after `now`. */
export function nextSlot(times: string[], now = new Date()): Date | null {
  const days = [0, 1, 2].map((k) => bangkokParts(new Date(now.getTime() + k * 86_400_000)).iso);
  const slots = days.flatMap((d) => times.map((t) => bangkokToUtc(d, t))).filter((s) => s.getTime() > now.getTime());
  return slots.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

export async function tick(): Promise<void> {
  try {
    const s = getSettings();
    const slot = latestPassedSlot(s.times);
    if (!slot) return;
    const last = getRaw(SLOT_KEY);
    if (!last) { setRaw(SLOT_KEY, slot.toISOString()); return; } // first start: don't fire on deploy
    if (Date.parse(last) >= slot.getTime()) return;
    if (!s.enabled) {
      // Agent off: still run the centralized Gmail sync at every slot so the
      // dashboard pages stay current (Jake, 2026-09-30) — just no agent run.
      setRaw(SLOT_KEY, slot.toISOString());
      console.log(`[deals-agent] slot ${slot.toISOString()}: agent disabled — running the Gmail sync only`);
      await runPreRunSteps((m) => console.log(`[deals-sync] ${m}`));
      return;
    }
    if (isRunning()) return; // try again next minute
    setRaw(SLOT_KEY, slot.toISOString()); // persist BEFORE running — a crash mid-run never re-fires the slot
    console.log(`[deals-agent] scheduled run for slot ${slot.toISOString()}`);
    const r = await runAgent({ trigger: "schedule", onProgress: (m) => console.log(`[deals-agent] ${m}`) });
    console.log(`[deals-agent] run ${r.id} ${r.status}: ${JSON.stringify(r.counts)}${r.error ? ` — ${r.error}` : ""}`);
  } catch (e) {
    console.warn(`[deals-agent] scheduler tick failed: ${errMsg(e)}`);
  }
}

/** Start the scheduler (idempotent). */
export function startDealsAgentScheduler(): void {
  if (timer) return;
  const s = getSettings();
  console.log(`[deals-agent] scheduler started — runs at ${s.times.join(", ")} Asia/Bangkok (enabled=${s.enabled}, saveToGmail=${s.saveToGmail}, postToSlack=${s.postToSlack})`);
  setTimeout(() => void tick(), 20_000).unref?.();
  timer = setInterval(() => void tick(), 60_000);
  if (typeof timer.unref === "function") timer.unref();
}
