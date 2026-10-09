/**
 * The Auto Editor's LIVE ETA: the server's timing model (lab/server/src/aieditor/eta.ts) gives
 * a prior per stage; while a stage runs, its reported fraction pulls the estimate toward the
 * observed rate, so the ETA converges as the stage runs. blendLive/timeShare MIRROR the server's
 * functions of the same name (the web cannot import server code) — keep them identical; the
 * server's backtest measures exactly this code.
 *
 * Display (Jake 2026-10-09, "can the ETA be accurate every time?"): a range when uncertain
 * ("~25–35 min"), one value when confident ("~31 min").
 */
import type { AutoPred } from 'zite-endpoints-sdk';

const GRID_N = 21; // frac 0, 0.05 … 1 — as the server's GRID

/** share of the stage's time gone by at fraction f (linear without a learned curve) */
export function timeShare(curve: number[] | null | undefined, f: number): number {
  if (!curve || curve.length !== GRID_N) return f;
  const x = Math.max(0, Math.min(1, f)) * 20;
  const i = Math.min(19, Math.floor(x + 1e-9));
  return curve[i] + (curve[i + 1] - curve[i]) * (x - i);
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Predicted REMAINING seconds of a running stage (+ range). `reachedAt` = seconds since the stage
 * started when it first reported its current fraction (a stage sitting at 75 % does not look
 * slower on paper every second it sits there).
 */
export function blendLive(prior: AutoPred | null, elapsed: number, frac: number | null, reachedAt: number = elapsed): AutoPred | null {
  const f = frac !== null && Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  const share = timeShare(prior?.curve, f);
  const at = Math.max(0, Math.min(elapsed, reachedAt));
  const observed = share >= 0.02 && f > 0 && at >= 3 ? at / share : null;
  if (!prior && observed === null) return null;
  const tail = (total: number) => Math.max(total - elapsed, 0.05 * Math.max(total, elapsed));
  if (!prior) {
    const rem = tail(observed!);
    const rel = Math.max(0.1, 0.6 * (1 - share));
    return { sec: round1(rem), lo: round1(rem * (1 - rel)), hi: round1(rem * (1 + rel)), n: 0, confident: share >= 0.5, scaled: false, unit: 'fixed' };
  }
  const relP = prior.sec > 0 ? (prior.hi - prior.sec) / prior.sec : 0.3;
  if (observed === null) {
    const rem = tail(prior.sec);
    const rel = Math.max(relP, elapsed > prior.sec ? 0.5 : 0);
    return { ...prior, sec: round1(rem), lo: round1(rem * (1 - Math.min(0.9, rel))), hi: round1(rem * (1 + rel)) };
  }
  const w = share;
  const total = (1 - w) * prior.sec + w * observed;
  const rem = tail(total);
  const rel = Math.max(0.05, (relP + 0.1) * (1 - share));
  return { ...prior, sec: round1(rem), lo: round1(rem * (1 - rel)), hi: round1(rem * (1 + rel)), confident: prior.confident || share >= 0.6 };
}

/** Add estimates: half-widths combine between independent (RSS) and fully correlated (sum). */
export function sumPreds(ps: (AutoPred | null | undefined)[]): AutoPred | null {
  const xs = ps.filter((p): p is AutoPred => !!p);
  if (!xs.length) return null;
  const sec = xs.reduce((a, p) => a + p.sec, 0);
  const up = xs.map((p) => Math.max(0, p.hi - p.sec));
  const dn = xs.map((p) => Math.max(0, p.sec - p.lo));
  const hw = (up.reduce((a, x) => a + x, 0) + Math.sqrt(up.reduce((a, x) => a + x * x, 0))) / 2;
  const hwLo = (dn.reduce((a, x) => a + x, 0) + Math.sqrt(dn.reduce((a, x) => a + x * x, 0))) / 2;
  return {
    sec: round1(sec), lo: round1(Math.max(0, sec - hwLo)), hi: round1(sec + hw),
    n: Math.min(...xs.map((p) => p.n)),
    confident: sec > 0 && hw / sec <= 0.15 && xs.every((p) => p.confident || p.sec < 30),
    scaled: xs.some((p) => p.scaled),
    unit: 'fixed',
  };
}

/** "45s", "4m 10s", "31 min", "1h 05m" */
export function durShort(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** minutes-or-hours range end, rounded so a range reads cleanly: "25–35 min", "1h 10m–1h 40m" */
function rangeText(lo: number, hi: number): string {
  if (hi < 60) return `${Math.max(1, Math.round(lo))}–${Math.round(hi)}s`;
  if (hi < 3600) {
    const step = hi >= 1200 ? 5 : 1;
    const a = Math.max(step === 5 ? 0 : 1, Math.floor(lo / 60 / step) * step);
    const b = Math.max(a + step, Math.ceil(hi / 60 / step) * step);
    return `${a}–${b} min`;
  }
  return `${durShort(lo)}–${durShort(hi)}`;
}

/**
 * One estimate as text: "~31 min" when confident or tight (±12 %), else "~25–35 min".
 */
export function etaText(p: AutoPred | null): string | null {
  if (!p) return null;
  const tight = p.sec > 0 && (p.hi - p.lo) / 2 / p.sec <= 0.12;
  if (p.confident || tight || p.sec < 20) return `~${durShort(p.sec)}`;
  return `~${rangeText(p.lo, p.hi)}`;
}
