/**
 * Engagement Manager — in-memory monitor status snapshot.
 *
 * A single ephemeral object (not per-job like keyword/run.ts, since the monitor
 * is one always-on loop). Rebuilt fresh on boot; all durable data lives in
 * SQLite, so losing this on restart only resets the "last cycle" display — the
 * inbox itself is intact.
 */

export interface EngageRegistry {
  /** Last successful cycle completion (epoch-ms), null until the first runs. */
  lastPollAt: number | null;
  /** Whether a cycle is currently in flight (the overlap guard reads this). */
  polling: boolean;
  /** Non-fatal last-cycle error surfaced to the UI, or null when the last cycle was clean. */
  lastError: string | null;
}

const state: EngageRegistry = {
  lastPollAt: null,
  polling: false,
  lastError: null,
};

export function getRegistry(): EngageRegistry {
  return { ...state };
}

export function isPolling(): boolean {
  return state.polling;
}

export function setPolling(polling: boolean): void {
  state.polling = polling;
}

export function markPollSuccess(at: number = Date.now()): void {
  state.lastPollAt = at;
  state.lastError = null;
}

export function setLastError(error: string | null): void {
  state.lastError = error;
}
