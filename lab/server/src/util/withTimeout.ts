/**
 * Bound a promise with a timeout so a hung step (a stalled network call, an
 * ffmpeg pass that never returns) can never freeze a background job forever.
 *
 * Resolves with the inner promise's value if it settles within `ms`; otherwise
 * rejects with a `TimeoutError` carrying a clear, user-surfaceable message. The
 * inner promise is NOT cancelled (JS can't), but the caller stops waiting on it,
 * which is exactly what we need to keep the job's stage machine moving.
 *
 * Pure + dependency-free so it is unit-testable with fake timers / short delays.
 */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms)}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = ms;
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise; // 0/∞ = no bound
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    // Don't keep the event loop alive solely for this timer.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
