/**
 * Deal Organizer — the one Gmail sync, shared by every page.
 *
 * Gmail scanning is a single SERVER job (thread index → email bodies → brand
 * extraction → AI deal scan) that runs twice a day with the agent, or on
 * demand through `runSyncNow`. Nothing in the browser starts a scan or an AI
 * extraction by itself any more; pages:
 *   • show <SyncIndicator/> ("Last synced 14:02 · next 20:00 (Bangkok)"),
 *   • offer <SyncNowButton/> (live progress while it runs),
 *   • reload their own data when a run finishes — `useSyncRefresh(load)`.
 *
 * A run started elsewhere (the schedule, another tab) is noticed by polling
 * `getSyncStatus`, and also triggers the reload.
 *
 * If the server doesn't have these endpoints yet (404), `available` is false:
 * the indicator hides and "Sync now" says so instead of failing noisily.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { getSyncStatus, runSyncNow, syncSteps, type SyncRun, type SyncStatus, type ScanGmailOutputType } from '@/deals/api';

export type SyncLogEntry = ScanGmailOutputType['logs'][number];

interface SyncContextType {
  /** null = not known yet; false = the server has no sync endpoints. */
  available: boolean | null;
  status: SyncStatus | null;
  /** A run is in progress (started here, by the schedule, or elsewhere). */
  running: boolean;
  /** Latest progress line of a run started from this tab. */
  progress: string | null;
  /** Progress lines of the latest run started from this tab (for the Logs panel). */
  log: SyncLogEntry[];
  /** Bumps each time a run finishes — pages reload on it. */
  version: number;
  runSync: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  clearLog: () => void;
}

const SyncContext = createContext<SyncContextType>({
  available: null, status: null, running: false, progress: null, log: [], version: 0,
  runSync: async () => {}, refreshStatus: async () => {}, clearLog: () => {},
});

const LOG_KEY = 'deal-organizer-sync-log';
const IDLE_POLL_MS = 60_000;
const BUSY_POLL_MS = 5_000;

function isMissingEndpoint(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /unknown function|\(404\)/i.test(m);
}

function levelFor(text: string): SyncLogEntry['level'] {
  if (/\b(fail(ed)?|error)\b/i.test(text)) return 'error';
  if (/\b(warn|skipp?ed|retry)\b/i.test(text)) return 'warn';
  if (/\b(done|finished|complete|ok)\b/i.test(text)) return 'success';
  return 'info';
}

function loadLog(): SyncLogEntry[] {
  try { const r = localStorage.getItem(LOG_KEY); return r ? JSON.parse(r) : []; } catch { return []; }
}
function saveLog(log: SyncLogEntry[]) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-1000))); } catch { /* private mode */ }
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [localRun, setLocalRun] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [log, setLog] = useState<SyncLogEntry[]>(loadLog);
  const [version, setVersion] = useState(0);
  const serverRunning = useRef(false);
  const localRunRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getSyncStatus();
      setAvailable(true);
      setStatus(s);
      // A run we didn't start (schedule / another tab) just finished → reload pages.
      if (serverRunning.current && !s.running && !localRunRef.current) setVersion(v => v + 1);
      serverRunning.current = !!s.running;
    } catch (e) {
      if (isMissingEndpoint(e)) setAvailable(false);
    }
  }, []);

  // Poll: every minute, every 5 s while a run is going.
  const running = localRun || !!status?.running;
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    if (available === false) return;
    const id = window.setInterval(refreshStatus, running ? BUSY_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(id);
  }, [available, running, refreshStatus]);

  const runSync = useCallback(async () => {
    if (localRunRef.current) return;
    if (available === false) {
      toast('Sync isn’t available on the server yet', { description: 'The scheduled sync will pick new email up.' });
      return;
    }
    localRunRef.current = true;
    setLocalRun(true);
    setProgress('Starting…');
    const lines: SyncLogEntry[] = [];
    const push = (step: string, message: string, level?: SyncLogEntry['level']) => {
      lines.push({ ts: new Date().toISOString(), step: step || 'sync', message, level: level ?? levelFor(message) });
      setLog([...lines]);
    };
    push('sync', 'Sync started from the Deal Organizer', 'info');
    let finishedOk = false;
    try {
      const s = runSyncNow();
      for await (const chunk of s) {
        const step = (chunk && typeof chunk === 'object' && 'step' in chunk) ? String(chunk.step) : 'sync';
        const message = (chunk && typeof chunk === 'object' && 'message' in chunk) ? String(chunk.message) : String(chunk);
        setProgress(step ? `${step}: ${message}` : message);
        push(step, message);
      }
      const result = await s.result;
      const run: SyncRun | null = result && 'last' in result ? result.last : (result as SyncRun);
      for (const st of syncSteps(run)) {
        const counts = st.counts ? Object.entries(st.counts).map(([k, v]) => `${v} ${k}`).join(', ') : '';
        const secs = typeof st.ms === 'number' ? ` (${Math.round(st.ms / 100) / 10}s)` : '';
        push(st.step, st.ok === false ? `failed: ${st.error ?? st.message ?? 'unknown error'}` : `${st.message || 'ok'}${counts ? ` — ${counts}` : ''}${secs}`, st.ok === false ? 'error' : 'success');
      }
      finishedOk = run ? run.ok !== false : true;
      if (finishedOk) toast.success('Gmail sync finished', { description: run?.summary || undefined, duration: 6000 });
      else toast.error('Gmail sync finished with errors', { description: run?.summary || 'See Logs on the Deals page.', duration: 10000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMissingEndpoint(e)) {
        setAvailable(false);
        toast('Sync isn’t available on the server yet', { description: 'The scheduled sync will pick new email up.' });
      } else if (/already running|busy/i.test(msg)) {
        toast('A sync is already running', { description: 'This page will refresh when it finishes.' });
        serverRunning.current = true;
      } else {
        push('sync', `failed: ${msg}`, 'error');
        toast.error('Gmail sync failed', { description: msg, duration: 10000 });
      }
    } finally {
      saveLog(lines.length > 1 ? lines : loadLog());
      localRunRef.current = false;
      setLocalRun(false);
      setProgress(null);
      const busy = serverRunning.current && lines.length <= 1; // someone else's run: let polling reload
      serverRunning.current = busy;
      await refreshStatus();
      if (lines.length > 1) setVersion(v => v + 1);
    }
  }, [available, refreshStatus]);

  const clearLog = useCallback(() => { setLog([]); saveLog([]); }, []);

  return (
    <SyncContext.Provider value={{ available, status, running, progress, log, version, runSync, refreshStatus, clearLog }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  return useContext(SyncContext);
}

/** Calls `reload` after every finished sync (not on mount). */
export function useSyncRefresh(reload: () => void) {
  const { version } = useSync();
  const first = useRef(true);
  const fn = useRef(reload);
  fn.current = reload;
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    fn.current();
  }, [version]);
}
