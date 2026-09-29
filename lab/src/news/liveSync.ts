/**
 * AI News Stream — the teleprompter's client half of the live sync.
 *
 * The server holds one anchor per session; this solves it. See
 * `server/src/news/liveSync.ts` for why it is an anchor and not a position.
 *
 * ⚠️ THE CLOCK IS THE WHOLE TRICK. The anchor is "position P at server time T",
 * so a screen whose clock is three seconds out renders three seconds of script
 * away from everyone else — confidently, with no error anywhere. `syncClock`
 * keeps the sample with the LOWEST round trip, because the error in the offset
 * is bounded by half the round trip and the fastest exchange is the most
 * trustworthy one, not the most recent.
 */
import { io, type Socket } from 'socket.io-client';

export interface SyncSnapshot {
  idx: number;
  /** Fraction of the script (0–1) at `anchorTime`. */
  position: number;
  anchorTime: number;
  isPlaying: boolean;
  /** Fraction per millisecond. */
  rate: number;
  scrollSpeed: number;
}

export interface LiveSync {
  socket: Socket;
  /** Where the script should be RIGHT NOW, as a fraction. */
  positionNow(): number;
  /** The last authoritative snapshot. */
  state(): SyncSnapshot;
  playPause(next: boolean): void;
  seek(fraction: number): void;
  setSpeed(scrollSpeed: number, rate: number): void;
  setSlide(idx: number): void;
  /** Appearance — shared, because both screens must read the same layout. */
  setTextSize(px: number): void;
  setLineHeight(v: number): void;
  setTextWidth(w: string): void;
  onSync(fn: (s: SyncSnapshot) => void): void;
  onAppearance(fn: (a: { textSize?: number; lineHeight?: number; textWidth?: string }) => void): void;
  close(): void;
}

const EMPTY: SyncSnapshot = { idx: 0, position: 0, anchorTime: 0, isPlaying: false, rate: 0, scrollSpeed: 2.5 };

export function connectLiveSync(sessionId: string): LiveSync {
  const socket = io('/news-tp', {
    path: '/news-tp/socket.io',
    query: { session: sessionId },
    transports: ['websocket', 'polling'],
  });

  let snapshot: SyncSnapshot = { ...EMPTY };
  let serverOffset = 0;
  let bestRtt = Infinity;
  const syncHandlers: ((s: SyncSnapshot) => void)[] = [];
  const appearanceHandlers: ((a: any) => void)[] = [];

  const syncClock = () => socket.emit('time-ping', Date.now());
  const burstSyncClock = () => {
    // A fresh burst must be allowed to beat the old best sample: after a
    // reconnect or a laptop waking, the previous "best" was measured against a
    // clock that no longer applies.
    bestRtt = Infinity;
    for (let i = 0; i < 5; i++) setTimeout(syncClock, i * 200);
  };

  socket.on('time-pong', ({ clientSendTime, serverTime }: { clientSendTime: number; serverTime: number }) => {
    const rtt = Date.now() - clientSendTime;
    if (rtt <= bestRtt) {
      bestRtt = rtt;
      serverOffset = serverTime + rtt / 2 - Date.now();
    }
  });

  socket.on('connect', () => {
    burstSyncClock();                      // lock the clock before trusting any anchor
    socket.emit('request-current-state');
  });

  const apply = (s: SyncSnapshot) => {
    snapshot = { ...snapshot, ...s };
    for (const fn of syncHandlers) fn(snapshot);
  };
  socket.on('scroll-sync', apply);
  socket.on('current-state', (s: any) => {
    apply(s);
    for (const fn of appearanceHandlers) {
      fn({ textSize: s.textSize, lineHeight: s.lineHeight, textWidth: s.textWidth });
    }
  });
  socket.on('text-size', (v: number) => appearanceHandlers.forEach((fn) => fn({ textSize: v })));
  socket.on('line-height', (v: number) => appearanceHandlers.forEach((fn) => fn({ lineHeight: v })));
  socket.on('text-width', (v: string) => appearanceHandlers.forEach((fn) => fn({ textWidth: v })));

  const clockSyncTimer = setInterval(burstSyncClock, 15000);

  // A seek while dragging can fire every frame; the socket does not need that,
  // but the FINAL resting position must always be sent or the screens part.
  let seekTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSeek: number | null = null;

  const api = {
    socket,
    positionNow() {
      if (!snapshot.isPlaying) return snapshot.position;
      const serverNow = Date.now() + serverOffset;
      return Math.min(1, snapshot.position + snapshot.rate * (serverNow - snapshot.anchorTime));
    },
    state: () => snapshot,
    playPause(next) {
      socket.emit('play-pause', next);
    },
    seek(fraction) {
      pendingSeek = Math.min(1, Math.max(0, fraction));
      if (seekTimer) return;
      seekTimer = setTimeout(() => {
        seekTimer = null;
        if (pendingSeek !== null) socket.emit('scroll-position', pendingSeek);
        pendingSeek = null;
      }, 120);
    },
    setSpeed(scrollSpeed, rate) {
      socket.emit('scroll-speed', { scrollSpeed, rate });
    },
    setSlide(idx) {
      socket.emit('slide-index', idx);
    },
    // ⚠️ APPEARANCE IS SHARED STATE, NOT A LOCAL PREFERENCE. Width and size
    // change where every line breaks; if one screen is narrow and the other
    // wide they are showing different text on the same anchor. (Mirror is the
    // exception and is deliberately NOT here — it is per tab.)
    setTextSize(px) {
      socket.emit('text-size', px);
    },
    setLineHeight(v) {
      socket.emit('line-height', v);
    },
    setTextWidth(w) {
      socket.emit('text-width', w);
    },
    onSync(fn) {
      syncHandlers.push(fn);
    },
    onAppearance(fn) {
      appearanceHandlers.push(fn);
    },
    close() {
      clearInterval(clockSyncTimer);
      if (seekTimer) clearTimeout(seekTimer);
      socket.close();
    },
  };
  // A live handle for diagnosing a show that is not syncing. Read-only in
  // practice, and worth having: everything here is invisible otherwise.
  (window as any).__newsSync = api;
  return api;
}
