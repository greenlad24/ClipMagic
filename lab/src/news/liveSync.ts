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
  /**
   * Which script the scroll belongs to (server liveSync.ts `epoch`): bumped by
   * every change that resets the scroll. Seeks carry it, so one made on the
   * previous script is dropped by the server however late it lands.
   */
  epoch?: number;
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
  /** `beat` (Daily Show): land on that beat of the new slide instead of its cover. */
  setSlide(idx: number, beat?: number): void;
  /** Appearance — shared, because both screens must read the same layout. */
  setTextSize(px: number): void;
  setLineHeight(v: number): void;
  setTextWidth(w: string): void;
  onSync(fn: (s: SyncSnapshot) => void): void;
  onAppearance(fn: (a: { textSize?: number; lineHeight?: number; textWidth?: string }) => void): void;
  /**
   * Article ↔ official video on slide `idx`. Its own event, never part of the
   * scroll anchor, so it cannot move any screen's teleprompter.
   */
  setMedia(idx: number, media: MediaView): void;
  onMedia(fn: (m: { idx: number; media: MediaView }) => void): void;
  /**
   * Daily Show: the beat (micro-interaction) of story `idx` — 0 is its cover.
   * Its own event like media-view, so stepping never moves a teleprompter.
   */
  setBeat(idx: number, beat: number): void;
  onBeat(fn: (b: { idx: number; beat: number }) => void): void;
  /**
   * Daily Show source beat: how far down the source page the show screens are
   * (fraction of the image height at the screen's top edge). Its own event —
   * never touches the teleprompter. Sends are throttled (the last one always
   * goes out); this screen's own echoes are filtered out.
   */
  setSourceScroll(idx: number, y: number): void;
  onSourceScroll(fn: (s: { idx: number; y: number; from?: string }) => void): void;
  close(): void;
}

export type MediaView = 'article' | 'video';

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
  const mediaHandlers: ((m: { idx: number; media: MediaView }) => void)[] = [];
  const beatHandlers: ((b: { idx: number; beat: number }) => void)[] = [];
  const srcHandlers: ((s: { idx: number; y: number; from?: string }) => void)[] = [];

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
    if (s.media === 'article' || s.media === 'video') {
      for (const fn of mediaHandlers) fn({ idx: s.idx, media: s.media });
    }
    if (typeof s.beat === 'number') {
      for (const fn of beatHandlers) fn({ idx: s.idx, beat: s.beat });
    }
    if (typeof s.srcY === 'number') {
      for (const fn of srcHandlers) fn({ idx: s.idx, y: s.srcY });
    }
    for (const fn of appearanceHandlers) {
      fn({ textSize: s.textSize, lineHeight: s.lineHeight, textWidth: s.textWidth });
    }
  });
  socket.on('text-size', (v: number) => appearanceHandlers.forEach((fn) => fn({ textSize: v })));
  socket.on('line-height', (v: number) => appearanceHandlers.forEach((fn) => fn({ lineHeight: v })));
  socket.on('text-width', (v: string) => appearanceHandlers.forEach((fn) => fn({ textWidth: v })));
  socket.on('media-view', (m: { idx: number; media: MediaView }) => mediaHandlers.forEach((fn) => fn(m)));
  socket.on('beat', (b: { idx: number; beat: number }) => beatHandlers.forEach((fn) => fn(b)));
  socket.on('source-scroll', (m: { idx: number; y: number; from?: string }) => {
    if (m.from && m.from === socket.id) return; // our own, already shown here
    srcHandlers.forEach((fn) => fn({ idx: m.idx, y: m.y, from: m.from }));
  });

  const clockSyncTimer = setInterval(burstSyncClock, 15000);

  // A seek while dragging can fire every frame; the socket does not need that,
  // but the FINAL resting position must always be sent or the screens part.
  let seekTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSeek: number | null = null;
  let pendingSeekIdx = 0;   // the slide the scrub was made on — the server drops it once the room has moved on
  let pendingSeekEpoch: number | undefined;   // …and the script (epoch) it was made on: the exact rule
  // Source scroll: a wheel fires ~60×/s; ~16 sends a second is plenty (each screen eases between them).
  let srcTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSrc: { idx: number; y: number } | null = null;

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
      pendingSeekIdx = snapshot.idx;
      pendingSeekEpoch = snapshot.epoch;
      if (seekTimer) return;
      seekTimer = setTimeout(() => {
        seekTimer = null;
        if (pendingSeek !== null) {
          socket.emit('scroll-position', typeof pendingSeekEpoch === 'number'
            ? { pos: pendingSeek, idx: pendingSeekIdx, epoch: pendingSeekEpoch }
            : { pos: pendingSeek, idx: pendingSeekIdx });
        }
        pendingSeek = null;
      }, 120);
    },
    setSpeed(scrollSpeed, rate) {
      socket.emit('scroll-speed', { scrollSpeed, rate });
    },
    setSlide(idx, beat) {
      // A scrub still waiting to go out belongs to the slide being left (bottom of the old script).
      if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; }
      pendingSeek = null;
      // ⚠️ LAND ON THE TOP NOW, NOT ONE ROUND TRIP LATER. Until the room's answer comes
      // back this screen's render loop would otherwise keep solving the OLD script's
      // anchor (0.97 of the way down, say) against the NEW script — the next story
      // flashed up at its bottom. The answer replaces this, epoch and all.
      snapshot = { ...snapshot, idx, position: 0, anchorTime: Date.now() + serverOffset };
      socket.emit('slide-index', typeof beat === 'number' ? { idx, beat } : idx);
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
    setMedia(idx, media) {
      socket.emit('media-view', { idx, media });
    },
    onMedia(fn) {
      mediaHandlers.push(fn);
    },
    setBeat(idx, beat) {
      socket.emit('beat', { idx, beat });
    },
    onBeat(fn) {
      beatHandlers.push(fn);
    },
    setSourceScroll(idx, y) {
      pendingSrc = { idx, y: Math.min(1, Math.max(0, y)) };
      if (srcTimer) return;
      socket.emit('source-scroll', pendingSrc);
      pendingSrc = null;
      srcTimer = setTimeout(function flush() {
        srcTimer = null;
        if (pendingSrc) { socket.emit('source-scroll', pendingSrc); pendingSrc = null; srcTimer = setTimeout(flush, 60); }
      }, 60);
    },
    onSourceScroll(fn) {
      srcHandlers.push(fn);
    },
    close() {
      clearInterval(clockSyncTimer);
      if (srcTimer) clearTimeout(srcTimer);
      if (seekTimer) clearTimeout(seekTimer);
      socket.close();
    },
  };
  // A live handle for diagnosing a show that is not syncing. Read-only in
  // practice, and worth having: everything here is invisible otherwise.
  (window as any).__newsSync = api;
  return api;
}
