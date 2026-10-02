/**
 * AI News Stream — live teleprompter sync over WebSockets.
 *
 * Ported from Jake's standalone teleprompter (tele.jakedaw.com), whose design
 * is the reason it holds two screens together where polling could not:
 *
 * ⚠️ THE SERVER BROADCASTS AN ANCHOR, NOT A POSITION. It holds
 * `{position, anchorTime, speed, isPlaying}` and every screen computes its own
 * scroll from `position + (speed/500) * (now - anchorTime)`. Streaming the
 * controller's live position instead — which is what the polling version did at
 * 4 updates a second — means every screen is always a fraction behind by
 * however long its own network takes, and the lag differs per device. With an
 * anchor, a screen that joins late or reconnects lands on the exact same spot
 * as everyone else, because it is solving the same equation.
 *
 * ⚠️ WHICH ONLY WORKS IF THE CLOCKS AGREE, so `time-ping`/`time-pong` measures
 * the offset and the client keeps the sample with the LOWEST round trip (least
 * error), re-sampling periodically for drift. Without that the anchor equation
 * is evaluated against a clock that may be seconds out, and the screens sit at
 * confidently different places.
 *
 * ⚠️ EVERY CONTROL IS SYMMETRIC — PLAY AND PAUSE COME FROM EITHER SCREEN. There
 * is no controller/follower split in this protocol: whoever acts re-anchors the
 * shared state and the broadcast goes to EVERYONE INCLUDING THE SENDER, so the
 * sender's own view is confirmed by the same event that moves the others rather
 * than by a local guess that can disagree.
 *
 * ⚠️ THE FOLLOWER LINK IS THE KEY, AND THAT IS ALREADY THE APP'S MODEL. A phone
 * joining the show has no Google session (see the public `/news-follow` route),
 * so this namespace authenticates by live-session id and serves exactly one
 * session's state. Nothing here can enumerate sessions, read a deck it was not
 * given the id for, or reach any other part of the Lab.
 */
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { sessions } from "./db.js";

/** The shared state of one live session, as every screen sees it. */
interface SyncState {
  /** Which slide is on screen. The news app is slide-based; the source app was one long script. */
  idx: number;
  /**
   * Scroll anchor at `anchorTime`, as a FRACTION of the script (0–1).
   *
   * ⚠️ NOT PIXELS, and that is the one change from the source app. There both
   * screens ran the same page at the same width, so pixels meant the same
   * thing on each. Here the monitor and a phone have wildly different scroll
   * heights, and a shared pixel offset puts them on different sentences.
   * A fraction keeps every screen on the same WORDS, which is the thing that
   * actually has to match.
   */
  position: number;
  /** Server clock (epoch ms) the anchor was taken at. */
  anchorTime: number;
  isPlaying: boolean;
  /** Fraction of the script per millisecond — the anchor's slope. */
  rate: number;
  /** The presenter's speed setting, shared so every screen shows the same number. */
  scrollSpeed: number;
  textSize: number;
  lineHeight: number;
  textWidth: string;
  /**
   * What the audience screen shows for the current slide: the article, then
   * (on a slide that has one) the official release video. ⚠️ Deliberately NOT
   * part of the scroll anchor and never sent in `scroll-sync`: switching it
   * must not move, pause or re-anchor the teleprompter on any screen.
   */
  media: "article" | "video";
}

const DEFAULTS: Omit<SyncState, "anchorTime"> = {
  idx: 0,
  position: 0,
  isPlaying: false,
  rate: 0,
  scrollSpeed: 2.5, // the same default a new session row gets in routes.ts
  textSize: 32,
  lineHeight: 1.9,
  textWidth: "medium",
  media: "article",
};

/**
 * In-memory per session. The DB row stays the durable record (a restart must
 * not lose which slide the show is on), but the anchor itself is live state —
 * persisting a timestamp that is only meaningful against a running clock would
 * mean a restarted server hands screens an anchor from minutes ago and every
 * one of them jumps forward together.
 */
const live = new Map<string, SyncState>();

/** How often every room is re-anchored, so a drifting screen is pulled back. */
const HEARTBEAT_MS = 5000;

function stateFor(sessionId: string): SyncState {
  const existing = live.get(sessionId);
  if (existing) return existing;
  // Seed from the durable session so a reconnect after a server restart opens
  // on the slide the show is actually on, paused.
  const row = sessions.get(sessionId);
  const fresh: SyncState = {
    ...DEFAULTS,
    idx: typeof (row as any)?.currentSlideIndex === "number" ? (row as any).currentSlideIndex : 0,
    textSize: typeof (row as any)?.tpFontSize === "number" ? (row as any).tpFontSize : DEFAULTS.textSize,
    lineHeight: typeof (row as any)?.tpLineHeight === "number" ? (row as any).tpLineHeight : DEFAULTS.lineHeight,
    textWidth: typeof (row as any)?.tpWidth === "string" ? (row as any).tpWidth : DEFAULTS.textWidth,
    // ⚠️ The row's field is `tpSpeed`. This read `tpScrollSpeed`, which does
    // not exist, so every show's live state started at 12 — and the first
    // scroll broadcast that 12 to every screen, snapping the presenter's speed
    // meter to 12× (and saving it) the moment Jake touched the script.
    scrollSpeed: typeof (row as any)?.tpSpeed === "number" ? (row as any).tpSpeed : DEFAULTS.scrollSpeed,
    media: (row as any)?.mediaView === "video" ? "video" : "article",
    anchorTime: Date.now(),
  };
  live.set(sessionId, fresh);
  return fresh;
}

/** Where the scroll is right now — the same equation the clients run. */
function positionNow(s: SyncState): number {
  if (!s.isPlaying) return s.position;
  // Clamped: a long pause with a stale anchor must not resolve to a position
  // past the end of the script, which reads as "the follower jumped to black".
  return Math.min(1, s.position + s.rate * (Date.now() - s.anchorTime));
}

/**
 * Freeze the current position into the anchor before changing anything that
 * affects the equation.
 *
 * ⚠️ RE-ANCHOR FIRST OR THE SHOW JUMPS. Changing speed without this leaves the
 * old anchorTime in place, so the new speed is applied retroactively to every
 * second since the anchor was set and every screen leaps to a position nobody
 * scrolled to.
 */
function reanchor(s: SyncState): void {
  s.position = positionNow(s);
  s.anchorTime = Date.now();
}

function syncPayload(s: SyncState) {
  return {
    idx: s.idx,
    position: s.position,
    anchorTime: s.anchorTime,
    isPlaying: s.isPlaying,
    rate: s.rate,
    scrollSpeed: s.scrollSpeed,
  };
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Attach the teleprompter namespace to the HTTP server.
 *
 * Deliberately its own namespace (`/news-tp`) rather than the default one, so
 * nothing else the Lab ever puts on this socket shares a room namespace with a
 * public, link-authenticated surface.
 */
export function attachNewsLiveSync(server: HttpServer): Server {
  const io = new Server(server, {
    path: "/news-tp/socket.io",
    // Same-origin only. The follower page is served by this server, so there is
    // no reason for another origin to open a socket here.
    cors: { origin: false },
    serveClient: true,
  });

  const ns = io.of("/news-tp");

  ns.on("connection", (socket: Socket) => {
    const sessionId = String(socket.handshake.query.session || "").trim();
    // No id, no room. The id IS the credential, exactly as it is for the
    // public state read, and an unscoped socket would be a way to listen to
    // whatever happened to be broadcasting.
    if (!sessionId) {
      socket.disconnect(true);
      return;
    }
    const room = `session:${sessionId}`;
    void socket.join(room);

    const broadcast = (): void => {
      ns.to(room).emit("scroll-sync", syncPayload(stateFor(sessionId)));
    };

    // ── Clock sync. Answered with this server's clock and the client's own
    //    send time, so the client can work out the round trip itself.
    socket.on("time-ping", (clientSendTime: number) => {
      socket.emit("time-pong", { clientSendTime, serverTime: Date.now() });
    });

    // ── A screen that just connected (or reconnected) asks for everything.
    socket.on("request-current-state", () => {
      const s = stateFor(sessionId);
      socket.emit("current-state", {
        ...syncPayload(s),
        textSize: s.textSize,
        lineHeight: s.lineHeight,
        textWidth: s.textWidth,
        media: s.media,
      });
    });

    // ── Play/pause, FROM EITHER SCREEN. Re-anchors so the position the show
    //    resumes from is the one it was paused at.
    socket.on("play-pause", (next: boolean) => {
      const s = stateFor(sessionId);
      reanchor(s);
      s.isPlaying = Boolean(next);
      broadcast();
    });

    // ── An absolute scroll position — a drag, a wheel, a seek.
    socket.on("scroll-position", (pos: unknown) => {
      const s = stateFor(sessionId);
      s.position = Math.min(1, Math.max(0, num(pos, s.position)));
      s.anchorTime = Date.now();
      broadcast();
    });

    /**
     * Speed, as the presenter's number AND the slope it implies.
     *
     * The RATE is computed by whoever changed it, from their own script height
     * — a fraction per millisecond is the only form of "speed" that means the
     * same thing on a phone and a monitor.
     */
    socket.on("scroll-speed", (payload: unknown) => {
      const s = stateFor(sessionId);
      reanchor(s); // before the slope changes, never after
      const p = (payload ?? {}) as { scrollSpeed?: unknown; rate?: unknown };
      s.scrollSpeed = Math.max(0, num(p.scrollSpeed, s.scrollSpeed));
      s.rate = Math.max(0, num(p.rate, s.rate));
      broadcast();
      // Same reason as appearance: the poller would otherwise restore the old
      // speed a second after it was changed.
      try {
        sessions.update(sessionId, { tpSpeed: s.scrollSpeed } as any);
      } catch {
        /* best effort */
      }
    });

    // ── Moving to another slide resets the scroll: a new script starts at the
    //    top, and carrying the old offset would open it part-way down.
    // Deep Dive v2 (Jake, 2026-10-02): its index is a BEAT, and stepping
    // between beats of one chapter must NOT move the teleprompter — it sends
    // { idx, keepScroll: true }. The Daily Show sends a bare number, as before.
    socket.on("slide-index", (payload: unknown) => {
      const s = stateFor(sessionId);
      const obj = payload && typeof payload === "object" ? (payload as { idx?: unknown; keepScroll?: unknown }) : null;
      const next = Math.max(0, Math.round(num(obj ? obj.idx : payload, s.idx)));
      if (next === s.idx) return;
      s.idx = next;
      if (obj?.keepScroll === true) {
        broadcast();
        try { sessions.update(sessionId, { currentSlideIndex: next } as any); } catch { /* bookkeeping only */ }
        return;
      }
      s.position = 0;
      s.anchorTime = Date.now();
      // A new slide always opens on its article.
      s.media = "article";
      broadcast();
      ns.to(room).emit("media-view", { idx: s.idx, media: s.media });
      // The slide is the one piece of this worth surviving a restart.
      try {
        sessions.update(sessionId, { currentSlideIndex: next, mediaView: "article" } as any);
      } catch {
        /* the show matters more than the bookkeeping */
      }
    });

    // ── Article ↔ video on the current slide. Its own event, NOT a scroll-sync:
    //    the anchor is untouched, so no screen's teleprompter can move. Persisted
    //    for the same reason as appearance — the presenter's 1.5s poll and the
    //    audience page read the row.
    socket.on("media-view", (payload: unknown) => {
      const s = stateFor(sessionId);
      const p = (payload ?? {}) as { idx?: unknown; media?: unknown };
      // A toggle aimed at a slide this room has already left is stale; drop it.
      if (typeof p.idx === "number" && p.idx !== s.idx) return;
      s.media = p.media === "video" ? "video" : "article";
      ns.to(room).emit("media-view", { idx: s.idx, media: s.media });
      try {
        sessions.update(sessionId, { mediaView: s.media } as any);
      } catch {
        /* best effort */
      }
    });

    // ── Appearance. Shared so both screens read the same thing, but it does
    //    not touch the anchor, so changing it mid-scroll cannot move anyone.
    /**
     * ⚠️ APPEARANCE IS PERSISTED, NOT JUST BROADCAST. The presenter also polls
     * the session row every 1.5s and reapplies what it finds there, so a change
     * that lived only in this process was reverted a second later — the screen
     * visibly snapped back to the old size with nothing to explain it. Writing
     * the row makes the socket and the poll agree, and means a reload opens the
     * show looking the way it was left.
     */
    const persist = (patch: Record<string, unknown>): void => {
      try {
        sessions.update(sessionId, patch as any);
      } catch {
        /* the show matters more than the bookkeeping */
      }
    };

    socket.on("text-size", (v: unknown) => {
      const s = stateFor(sessionId);
      s.textSize = num(v, s.textSize);
      ns.to(room).emit("text-size", s.textSize);
      persist({ tpFontSize: s.textSize });
    });
    socket.on("line-height", (v: unknown) => {
      const s = stateFor(sessionId);
      s.lineHeight = num(v, s.lineHeight);
      ns.to(room).emit("line-height", s.lineHeight);
      persist({ tpLineHeight: s.lineHeight });
    });
    socket.on("text-width", (v: unknown) => {
      const s = stateFor(sessionId);
      if (typeof v === "string" && v) s.textWidth = v;
      ns.to(room).emit("text-width", s.textWidth);
      persist({ tpWidth: s.textWidth });
    });
  });

  /**
   * The heartbeat. Every playing room is re-broadcast on a timer so a screen
   * whose clock has drifted, or which missed an event, is eased back onto the
   * shared position instead of quietly diverging for the rest of the show.
   */
  setInterval(() => {
    for (const [sessionId, s] of live) {
      if (!s.isPlaying) continue;
      ns.to(`session:${sessionId}`).emit("scroll-sync", syncPayload(s));
    }
  }, HEARTBEAT_MS).unref?.();

  return io;
}
