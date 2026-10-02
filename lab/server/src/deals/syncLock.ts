/**
 * Deal Organizer — the one process-wide Gmail lock.
 *
 * Everything that walks the mailbox and writes the deals_* tables in bulk (the
 * centralized sync pipeline in scheduledSync.ts, and a stand-alone scanGmail
 * call) runs inside `withSyncLock`, one at a time, in call order. The pipeline
 * adds "attach to the running one" on top (see runSync); a stand-alone
 * scanGmail simply waits its turn.
 */
let chain: Promise<unknown> = Promise.resolve();
let holders = 0;

export function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  holders++;
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined).finally(() => { holders--; });
  return run;
}

/** True while anything holds (or waits for) the lock. */
export function syncLockBusy(): boolean {
  return holders > 0;
}
