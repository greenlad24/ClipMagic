import { useNewsTheme } from '../useNewsTheme';
import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { useAuth } from '../auth';
import { getSlides, startSession, getSession, updateSession, GetSlidesOutputType } from '../api';

type SlideType = GetSlidesOutputType['slides'][0];
type TextWidth = 'wide' | 'medium' | 'narrow';

const WIDTH_PX: Record<TextWidth, number> = { wide: 960, medium: 660, narrow: 420 };

/**
 * ⚠️ NEVER `system-ui` FOR THE SCRIPT — IT IS A DIFFERENT PHYSICAL FONT ON
 * EVERY PLATFORM. It resolves to San Francisco on a Mac or iPhone, Segoe UI on
 * Windows, Roboto on Android, and something else again on Linux. Different
 * glyph widths mean the same script wraps at different words, so the monitor
 * and the phone show different lines even when their scroll positions agree
 * perfectly — which reads as "the sync is broken" when the sync is fine.
 *
 * Arial is the same stack Jake's standalone teleprompter uses, and the
 * text-size-adjust pin stops iOS Safari inflating the text on its own.
 */
export const SCRIPT_FONT = "'NewsScript', Arial, Helvetica, sans-serif";
const PARA_SPLIT = /\n\s*\n/;

const D = {
  bg: '#080808', text: '#ffffff', muted: '#555', faint: '#1e1e1e',
  border: '#252525', panel: '#0e0e0e', card: '#161616',
  blue: '#60a5fa', orange: '#f97316', green: '#22c55e',
};

function getDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  let id = window.localStorage.getItem('tp2-device-id');
  if (!id) { id = crypto.randomUUID(); window.localStorage.setItem('tp2-device-id', id); }
  return id;
}
const DEVICE_ID = getDeviceId();

function clampIndex(idx: number, total: number) {
  return total <= 0 ? 0 : Math.max(0, Math.min(total - 1, idx));
}

// ── Small UI helpers ───────────────────────────────────────────────────────
function SettingRow({ label, tag, children }: { label: string; tag?: string; children: ReactNode }) {
  return (
    <div>
      <p style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 7, fontWeight: 600 }}>
        {label}
        {tag && (
          <span style={{ marginLeft: 6, fontSize: 9, color: tag === 'local' ? D.orange : D.blue, fontWeight: 400, textTransform: 'lowercase', letterSpacing: 0 }}>
            ({tag})
          </span>
        )}
      </p>
      {children}
    </div>
  );
}

function NumSlider({ value, min, max, step, unit, onChange }: {
  value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value, 10))}
        style={{ flex: 1, accentColor: D.blue, cursor: 'pointer', height: 4 }} />
      <span style={{ fontSize: 12, color: D.text, fontFamily: 'monospace', minWidth: 44, textAlign: 'right' }}>
        {step < 1 ? value.toFixed(1) : value}{unit}
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function TeleprompterPage() {
  useNewsTheme();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();

  // Role detection from URL
  const searchParams = new URLSearchParams(window.location.search);
  const isFollower = searchParams.get('follow') === '1';
  const sessionParam = searchParams.get('session');

  // State
  const [slides, setSlides] = useState<SlideType[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [isScrolling, setIsScrolling] = useState(false);
  const [autoscroll, setAutoscroll] = useState(false);
  const [speed, setSpeed] = useState(2.5);
  const [fontSize, setFontSize] = useState(32);
  const [lineHeight, setLineHeight] = useState(1.9);
  const [width, setWidth] = useState<TextWidth>('medium');
  const [countdownSetting, setCountdownSetting] = useState(3);
  const [isCountingDown, setIsCountingDown] = useState(false);
  const [countdownValue, setCountdownValue] = useState(3);

  // ⚠️ PER TAB, NOT PER BROWSER. See followerPage.ts: localStorage is shared
  // across every tab on the origin, so a mirrored teleprompter silently
  // mirrored the next follower link opened on the same device.
  const [mirror, setMirror] = useState(() => sessionStorage.getItem('tp2-mirror') === 'true');
  const [hideControls, setHideControls] = useState(() => localStorage.getItem('tp2-hideControls') === 'true');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [followerConnected, setFollowerConnected] = useState(true);
  const [isLockedOut, setIsLockedOut] = useState(false);

  // Refs
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollAnimRef = useRef<number>();
  const followerAnimRef = useRef<number>();
  const publishTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const lastPublishRef = useRef(0);
  const ignoreScrollUntilRef = useRef(0);
  const lastSeqRef = useRef(0);
  const targetPctRef = useRef(0);
  const slidesRef = useRef(slides);
  const currentIdxRef = useRef(currentIdx);
  const sessionIdRef = useRef(sessionId);
  const isScrollingRef = useRef(isScrolling);

  // ── Follower position state ─────────────────────────────────────────────
  // The controller publishes its exact scroll position ~4×/sec. The follower
  // estimates the presenter's velocity and glides at that rate between
  // updates, correcting gently on each arrival.
  const anchorRef = useRef({
    position: 0,    // latest received scroll pct from controller
    velocity: 0,    // estimated pct/ms from successive samples
    receivedAt: 0,  // local timestamp of last received position
    playing: false, // whether the controller is autoscrolling
  });
  const renderPosRef = useRef(0);      // current rendered scroll position (px)
  const lastFrameTsRef = useRef<number | null>(null);

  useEffect(() => { slidesRef.current = slides; }, [slides]);
  useEffect(() => { currentIdxRef.current = currentIdx; }, [currentIdx]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { isScrollingRef.current = isScrolling; }, [isScrolling]);

  // Auth — controllers need sign-in, followers are public (link is the key)
  useEffect(() => {
    if (!isFollower && !authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [isFollower, authLoading, user, loginWithRedirect]);

  // Persist local settings
  useEffect(() => { sessionStorage.setItem('tp2-mirror', String(mirror)); }, [mirror]);
  useEffect(() => { localStorage.setItem('tp2-hideControls', String(hideControls)); }, [hideControls]);

  // ── Helpers ──────────────────────────────────────────────────────────────
  const getScrollPct = useCallback((): number => {
    const el = scrollRef.current;
    if (!el || el.scrollHeight <= el.clientHeight) return 0;
    return Math.max(0, Math.min(1, el.scrollTop / (el.scrollHeight - el.clientHeight)));
  }, []);

  const applyScrollPct = useCallback((pct: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    ignoreScrollUntilRef.current = Date.now() + 100;
    el.scrollTop = Math.max(0, Math.min(max, pct * max));
  }, []);

  const publish = useCallback((patch: Record<string, unknown>) => {
    const sid = sessionIdRef.current;
    if (!sid || isFollower) return;
    updateSession({ sessionId: sid, deviceId: DEVICE_ID, ...patch } as any).catch(() => {});
  }, [isFollower]);

  // Apply session snapshot
  const applySnapshot = useCallback((s: any, slideCount: number, jumpScroll: boolean) => {
    const idx = typeof s.currentSlideIndex === 'number' ? clampIndex(s.currentSlideIndex, slideCount) : 0;
    if (idx !== currentIdxRef.current) setCurrentIdx(idx);
    if (typeof s.tpPaused === 'boolean') setIsScrolling(!s.tpPaused);
    if (typeof s.tpAutoscroll === 'boolean') setAutoscroll(s.tpAutoscroll);
    if (typeof s.tpSpeed === 'number') setSpeed(s.tpSpeed);
    if (typeof s.tpFontSize === 'number') setFontSize(s.tpFontSize);
    if (typeof s.tpLineHeight === 'number') setLineHeight(s.tpLineHeight);
    if (s.tpWidth && ['wide', 'medium', 'narrow'].includes(s.tpWidth)) setWidth(s.tpWidth as TextWidth);
    if (typeof s.tpCountdown === 'number') setCountdownSetting(s.tpCountdown);
    if (typeof s.tpRevision === 'number') lastSeqRef.current = s.tpRevision;
    if (typeof s.tpScrollPct === 'number') {
      targetPctRef.current = s.tpScrollPct;
      if (jumpScroll) requestAnimationFrame(() => applyScrollPct(s.tpScrollPct));
    }
  }, [applyScrollPct]);

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user && !isFollower) return;
    let alive = true;
    (async () => {
      try {
        const data = await getSlides({});
        if (!alive || !data.deck || !data.slides.length) { if (alive) setLoading(false); return; }
        setSlides(data.slides);
        if (isFollower && sessionParam) {
          setSessionId(sessionParam);
          const state = await getSession({ sessionId: sessionParam });
          if (!alive || !state.session) { setLoading(false); return; }
          applySnapshot(state.session, data.slides.length, true);
        } else {
          const sess = await startSession({ deckId: data.deck.id, controllerId: DEVICE_ID } as any);
          if (!alive) return;
          setSessionId(sess.sessionId);
          if (!sess.isNew) {
            const state = await getSession({ sessionId: sess.sessionId });
            if (!alive || !state.session) { setLoading(false); return; }
            applySnapshot(state.session, data.slides.length, true);
            // Detect locked-out state
            const cid = state.session.tpControllerId || '';
            if (cid && cid !== DEVICE_ID) setIsLockedOut(true);
          }
        }
      } catch { /* silent */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [user, isFollower, sessionParam, applySnapshot]);

  // ── Controller: autoscroll rAF (NO periodic publish — anchor-only) ──────
  // The follower interpolates from the anchor, so we only need to publish
  // on play/pause/speed-change/seek, not every 200ms. Continuous publishes
  // reset the follower's anchor and cause visible jitter.
  useEffect(() => {
    if (isFollower || !isScrolling || !autoscroll) {
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
      return;
    }
    let lastTime: number | null = null;
    // Accumulate fractional pixels in a float — scrollTop is integer-rounded
    // by browsers, so += 0.3 each frame would stay at 0 forever without this.
    let accumPx = scrollRef.current ? scrollRef.current.scrollTop : 0;
    const PX_PER_S = speed * 8;
    const tick = (t: number) => {
      const el = scrollRef.current;
      if (!el) { scrollAnimRef.current = requestAnimationFrame(tick); return; }
      if (lastTime === null) { lastTime = t; accumPx = el.scrollTop; scrollAnimRef.current = requestAnimationFrame(tick); return; }
      const dt = (t - lastTime) / 1000;
      lastTime = t;
      ignoreScrollUntilRef.current = Date.now() + 80;
      accumPx += PX_PER_S * dt;
      el.scrollTop = accumPx;
      scrollAnimRef.current = requestAnimationFrame(tick);
    };
    scrollAnimRef.current = requestAnimationFrame(tick);
    return () => { if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current); };
  }, [isFollower, isScrolling, autoscroll, speed]);

  // ── Controller: manual scroll → publish (only when NOT autoscrolling) ───
  useEffect(() => {
    if (isFollower || loading || !slides.length) return;
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (Date.now() < ignoreScrollUntilRef.current) return;
      // During autoscroll the follower interpolates from the anchor — don't
      // publish continuous position updates that would reset it and cause jitter.
      if (isScrollingRef.current) return;
      const now = Date.now();
      if (now - lastPublishRef.current >= 150) {
        lastPublishRef.current = now;
        publish({ tpScrollPct: getScrollPct() });
      } else {
        if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
        publishTimerRef.current = setTimeout(() => {
          lastPublishRef.current = Date.now();
          publish({ tpScrollPct: getScrollPct() });
        }, 150);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (publishTimerRef.current) clearTimeout(publishTimerRef.current); };
  }, [isFollower, loading, slides.length, publish, getScrollPct]);

  // ── Controller: periodic position publish (~4/sec, both states) ─────────
  // Ensures followers can track the monitor whether playing or paused,
  // and during autoscroll (where the scroll event listener is suppressed).
  useEffect(() => {
    if (isFollower || loading || !slides.length || !sessionId) return;
    const iv = setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      const pct = Math.max(0, Math.min(1, el.scrollTop / max));
      publish({ tpScrollPct: pct });
    }, 250);
    return () => clearInterval(iv);
  }, [isFollower, loading, slides.length, sessionId, publish]);

  // ── Follower: polling + position-based sync ─────────────────────────────
  useEffect(() => {
    if (!isFollower || !sessionId) return;
    let alive = true;
    let errors = 0;

    const poll = async () => {
      if (!alive) return;
      try {
        const state = await getSession({ sessionId });
        if (!alive || !state.session) return;
        errors = 0; setFollowerConnected(true);

        const s = state.session;
        const seq = typeof s.tpRevision === 'number' ? s.tpRevision : 0;
        if (seq <= lastSeqRef.current) return;
        lastSeqRef.current = seq;

        // ── Slide change ───────────────────────────────────────────
        const remoteIdx = typeof s.currentSlideIndex === 'number' ? clampIndex(s.currentSlideIndex, slidesRef.current.length) : 0;
        if (remoteIdx !== currentIdxRef.current) {
          setCurrentIdx(remoteIdx);
          anchorRef.current = { position: 0, velocity: 0, receivedAt: Date.now(), playing: false };
          renderPosRef.current = 0;
          requestAnimationFrame(() => applyScrollPct(0));
        }

        // ── Apply settings ─────────────────────────────────────────
        const nowPlaying = typeof s.tpPaused === 'boolean' ? !s.tpPaused : false;
        if (typeof s.tpPaused === 'boolean') setIsScrolling(nowPlaying);
        if (typeof s.tpAutoscroll === 'boolean') setAutoscroll(s.tpAutoscroll);
        if (typeof s.tpSpeed === 'number') setSpeed(s.tpSpeed);
        if (typeof s.tpFontSize === 'number') setFontSize(s.tpFontSize);
        if (typeof s.tpLineHeight === 'number') setLineHeight(s.tpLineHeight);
        if (s.tpWidth && ['wide', 'medium', 'narrow'].includes(s.tpWidth)) setWidth(s.tpWidth as TextWidth);
        if (typeof s.tpCountdown === 'number') setCountdownSetting(s.tpCountdown);

        // ── Update position + estimate velocity for the rAF glide loop ─
        if (typeof s.tpScrollPct === 'number') {
          const now = Date.now();
          const prev = anchorRef.current;
          const dt = now - prev.receivedAt;
          let velocity = 0;
          if (dt > 0 && dt < 2000 && prev.receivedAt > 0) {
            velocity = (s.tpScrollPct - prev.position) / dt;
            // Blend with previous velocity to smooth out measurement noise
            velocity = prev.velocity * 0.3 + velocity * 0.7;
          }
          anchorRef.current = {
            position: s.tpScrollPct,
            velocity: Math.max(0, velocity), // never negative while playing
            receivedAt: now,
            playing: nowPlaying && (typeof s.tpAutoscroll === 'boolean' ? s.tpAutoscroll : false),
          };
        }
      } catch { errors++; if (errors >= 3) setFollowerConnected(false); }
    };
    const iv = setInterval(poll, 200);
    poll();
    return () => { alive = false; clearInterval(iv); };
  }, [isFollower, sessionId, applyScrollPct]);

  // ── Follower: velocity-based glide (rAF loop) ──────────────────────────
  // Between position updates (~4×/sec), the follower keeps moving at the
  // estimated presenter velocity. Each arriving position gently corrects
  // renderPos toward the true value. While playing, the follower only
  // moves forward — late packets can never yank the text backwards.
  useEffect(() => {
    if (!isFollower) return;
    lastFrameTsRef.current = null;

    const tick = (ts: number) => {
      const el = scrollRef.current;
      if (el) {
        const max = el.scrollHeight - el.clientHeight;
        if (max > 0) {
          const a = anchorRef.current;
          const dt = lastFrameTsRef.current == null ? 16 : Math.min(100, ts - lastFrameTsRef.current);

          // Extrapolate where the presenter should be right now
          const timeSinceUpdate = Date.now() - a.receivedAt;
          const extrapolatedPct = a.playing
            ? Math.min(1, a.position + a.velocity * timeSinceUpdate)
            : a.position;

          const targetPx = extrapolatedPct * max;
          const diff = targetPx - renderPosRef.current;

          if (Math.abs(diff) > max * 0.15) {
            // Big jump (slide change, seek): snap immediately
            renderPosRef.current = targetPx;
          } else if (a.playing && diff < 0) {
            // Forward-only while playing — skip backwards corrections
          } else {
            // Smooth exponential ease toward target
            const tau = a.playing ? 300 : 150;
            renderPosRef.current += diff * (1 - Math.exp(-dt / tau));
          }

          el.scrollTop = renderPosRef.current;
        }
      }
      lastFrameTsRef.current = ts;
      followerAnimRef.current = requestAnimationFrame(tick);
    };
    followerAnimRef.current = requestAnimationFrame(tick);
    return () => { if (followerAnimRef.current) cancelAnimationFrame(followerAnimRef.current); };
  }, [isFollower]);

  // ── Follower: resync on wake ─────────────────────────────────────────────
  useEffect(() => {
    if (!isFollower || !sessionId) return;
    const handler = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const state = await getSession({ sessionId });
        if (!state.session) return;
        applySnapshot(state.session, slidesRef.current.length, true);
        const s = state.session;
        anchorRef.current = {
          position: typeof s.tpScrollPct === 'number' ? s.tpScrollPct : 0,
          velocity: 0,
          receivedAt: Date.now(),
          playing: typeof s.tpPaused === 'boolean' ? !s.tpPaused : false,
        };
        renderPosRef.current = (typeof s.tpScrollPct === 'number' ? s.tpScrollPct : 0) * (scrollRef.current ? scrollRef.current.scrollHeight - scrollRef.current.clientHeight : 0);
        lastSeqRef.current = 0; // force next poll to apply
        setFollowerConnected(true);
      } catch { /* silent */ }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [isFollower, sessionId, applySnapshot]);

  // ── Controller: pick up slide-index changes from the Notes page ──────────
  useEffect(() => {
    if (isFollower || !sessionId) return;
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      try {
        const state = await getSession({ sessionId });
        if (!alive || !state.session) return;
        const s = state.session;
        const actor = s.tpActorId || '';
        // Detect locked-out state (another device holds control)
        const cid = s.tpControllerId || '';
        if (cid && cid !== DEVICE_ID) { setIsLockedOut(true); } else { setIsLockedOut(false); }
        if (actor === DEVICE_ID) return;
        const idx = typeof s.currentSlideIndex === 'number' ? clampIndex(s.currentSlideIndex, slidesRef.current.length) : 0;
        if (idx !== currentIdxRef.current) {
          setCurrentIdx(idx);
          setIsScrolling(false); setAutoscroll(false); setIsCountingDown(false);
          if (scrollRef.current) { ignoreScrollUntilRef.current = Date.now() + 120; scrollRef.current.scrollTop = 0; }
        }
      } catch { /* silent */ }
    };
    const iv = setInterval(poll, 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [isFollower, sessionId]);

  // ── Controller: navigate ─────────────────────────────────────────────────
  const navigateSlide = useCallback((idx: number) => {
    if (isFollower || idx < 0 || idx >= slidesRef.current.length) return;
    setCurrentIdx(idx); setIsScrolling(false); setAutoscroll(false); setIsCountingDown(false);
    if (scrollRef.current) { ignoreScrollUntilRef.current = Date.now() + 120; scrollRef.current.scrollTop = 0; }
    publish({ currentSlideIndex: idx, tpScrollPct: 0, tpPaused: true, tpAutoscroll: false });
  }, [isFollower, publish]);

  // ── Controller: play / pause ─────────────────────────────────────────────
  const handlePlay = useCallback(() => {
    if (isFollower) return;
    if (countdownSetting > 0 && !isCountingDown && !isScrolling) { setIsCountingDown(true); setCountdownValue(countdownSetting); return; }
    if (isCountingDown) setIsCountingDown(false);
    setIsScrolling(true); setAutoscroll(true);
    publish({ tpPaused: false, tpAutoscroll: true, tpScrollPct: getScrollPct(), tpSpeed: speed });
  }, [isFollower, countdownSetting, isCountingDown, isScrolling, publish, getScrollPct, speed]);

  const handlePause = useCallback(() => {
    if (isFollower) return;
    setIsScrolling(false); setIsCountingDown(false);
    publish({ tpPaused: true, tpScrollPct: getScrollPct() });
  }, [isFollower, publish, getScrollPct]);

  const togglePlay = useCallback(() => {
    if (isScrolling || isCountingDown) handlePause(); else handlePlay();
  }, [isScrolling, isCountingDown, handlePlay, handlePause]);

  const toggleAutoscroll = useCallback(() => {
    if (isFollower) return;
    const next = !autoscroll;
    setAutoscroll(next);
    if (!next) { setIsScrolling(false); setIsCountingDown(false); publish({ tpAutoscroll: false, tpPaused: true, tpScrollPct: getScrollPct() }); }
    else { publish({ tpAutoscroll: true }); }
  }, [isFollower, autoscroll, publish, getScrollPct]);

  // ── Countdown ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isCountingDown || isFollower) return;
    if (countdownValue <= 0) {
      setIsCountingDown(false); setIsScrolling(true); setAutoscroll(true);
      publish({ tpPaused: false, tpAutoscroll: true, tpScrollPct: getScrollPct(), tpSpeed: speed });
      return;
    }
    const t = setTimeout(() => setCountdownValue(v => v - 1), 1000);
    return () => clearTimeout(t);
  }, [isCountingDown, countdownValue, isFollower, publish, getScrollPct, speed]);

  // ── Setting handlers ─────────────────────────────────────────────────────
  const handleSpeedChange = useCallback((v: number) => { setSpeed(v); publish({ tpSpeed: v, tpScrollPct: getScrollPct() }); }, [publish, getScrollPct]);
  const handleFontSizeChange = useCallback((v: number) => { setFontSize(v); publish({ tpFontSize: v }); }, [publish]);
  const handleLineHeightChange = useCallback((v: number) => { setLineHeight(v); publish({ tpLineHeight: v }); }, [publish]);
  const handleWidthChange = useCallback((w: TextWidth) => { setWidth(w); publish({ tpWidth: w }); }, [publish]);
  const handleCountdownChange = useCallback((v: number) => { setCountdownSetting(v); setCountdownValue(v); publish({ tpCountdown: v }); }, [publish]);

  const handleTakeControl = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid || isFollower) return;
    updateSession({ sessionId: sid, deviceId: DEVICE_ID, tpControllerId: DEVICE_ID } as any)
      .then(r => { if (r.success) setIsLockedOut(false); })
      .catch(() => {});
  }, [isFollower]);

  // ── Cleanup ──────────────────────────────────────────────────────────────
  useEffect(() => () => {
    if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
    if (followerAnimRef.current) cancelAnimationFrame(followerAnimRef.current);
    if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
  }, []);

  // ── Guards ───────────────────────────────────────────────────────────────
  if ((!isFollower && (authLoading || !user)) || loading) {
    return <div style={{ height: '100vh', background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui' }}><p style={{ color: D.muted }}>Loading…</p></div>;
  }
  if (!slides.length) {
    return (
      <div style={{ height: '100vh', background: D.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui', gap: 8 }}>
        <p style={{ color: D.muted, fontSize: 16 }}>No deck found.</p>
        <p style={{ color: D.faint, fontSize: 13 }}>Build a deck first from the Dashboard, then start the show.</p>
      </div>
    );
  }

  // ── Derived ──────────────────────────────────────────────────────────────
  const slide = slides[clampIndex(currentIdx, slides.length)] ?? null;
  const rawScript = typeof slide?.teleprompterScript === 'string' ? slide.teleprompterScript : '';
  const paragraphs = rawScript.split(PARA_SPLIT).map((p: string) => p.trim()).filter(Boolean);
  const sourceName = slide?.bestSourceName || '';

  // ── Shared sub-renders ───────────────────────────────────────────────────
  const renderScript = () => (
    <div style={{ maxWidth: WIDTH_PX[width], margin: '0 auto', padding: '56px 40px 0', transform: mirror ? 'scaleX(-1)' : undefined }}>
      <p style={{ fontSize: 11, color: D.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 36, fontWeight: 700 }}>
        {currentIdx + 1} / {slides.length}{sourceName ? ` \u00b7 ${sourceName}` : ''}
      </p>
      {paragraphs.length > 0 ? paragraphs.map((para: string, i: number) => (
        <p key={i} style={{ fontSize, lineHeight, color: '#ffffff', margin: `0 0 ${Math.round(fontSize * 0.8)}px`, letterSpacing: '0.012em', fontWeight: 400, fontFamily: SCRIPT_FONT, WebkitTextSizeAdjust: '100%', textSizeAdjust: '100%' } as React.CSSProperties}>{para}</p>
      )) : (
        <div style={{ textAlign: 'center', marginTop: 80 }}>
          <p style={{ fontSize: 20, color: D.muted }}>No script for this slide.</p>
          <p style={{ fontSize: 14, color: D.faint, marginTop: 8 }}>Rebuild the deck to generate teleprompter scripts.</p>
        </div>
      )}
      <div style={{ height: '75vh' }} />
    </div>
  );

  const statusPill = (
    <div style={{ position: 'sticky', top: 14, zIndex: 10, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{
        background: 'rgba(8,8,8,0.92)',
        border: `1px solid ${isScrolling ? 'rgba(96,165,250,0.35)' : isCountingDown ? 'rgba(249,115,22,0.4)' : D.border}`,
        borderRadius: 99, padding: '4px 18px', fontSize: 12, fontFamily: 'monospace', fontWeight: 600, letterSpacing: '0.04em',
        color: isScrolling ? D.blue : isCountingDown ? D.orange : D.muted, transition: 'all 0.2s',
      }}>
        {isFollower ? (followerConnected ? '\ud83d\udce1 Following the monitor' : '\u26a0 Reconnecting\u2026')
          : isCountingDown ? '\u23f1 Starting\u2026' : isScrolling ? '\u25b6 Scrolling' : '\u23f8 Paused'}
      </div>
    </div>
  );

  const countdownOverlay = isCountingDown ? (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}>
      <div style={{ fontSize: 96, fontWeight: 800, color: 'rgba(249,115,22,0.15)', fontFamily: 'monospace', lineHeight: 1 }}>{countdownValue}</div>
    </div>
  ) : null;

  // ═══════════════════════════════════════════════════════════════════════════
  // FOLLOWER — read-only
  // ═══════════════════════════════════════════════════════════════════════════
  if (isFollower) {
    return (
      <div style={{ height: '100vh', background: D.bg, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', userSelect: 'none' }}>
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', position: 'relative' }}>
          {statusPill}
          {renderScript()}
        </div>
        {/* Mirror toggle — TAB-local, never published to the session */}
        <button
          onClick={() => setMirror(m => !m)}
          style={{
            position: 'fixed', bottom: 16, right: 16, zIndex: 20,
            display: 'flex', alignItems: 'center', gap: 6,
            background: mirror ? 'rgba(96,165,250,0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${mirror ? 'rgba(96,165,250,0.4)' : 'rgba(255,255,255,0.08)'}`,
            borderRadius: 8, padding: '8px 14px', cursor: 'pointer',
            color: mirror ? D.blue : 'rgba(255,255,255,0.3)',
            fontSize: 12, fontWeight: 600, transition: 'all 0.15s',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <span style={{ fontSize: 14 }}>{'\u21c4'}</span>
          {mirror ? 'Mirrored' : 'Mirror'}
        </button>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTROLLER — hideControls
  // ═══════════════════════════════════════════════════════════════════════════
  if (hideControls) {
    return (
      <div style={{ height: '100vh', background: '#000', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', userSelect: 'none' }}>
        <div ref={scrollRef} onClick={togglePlay} style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', cursor: 'pointer', position: 'relative' }}>
          {statusPill}
          {countdownOverlay}
          {renderScript()}
        </div>
        <button onClick={e => { e.stopPropagation(); togglePlay(); }}
          style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 20, background: isScrolling ? 'rgba(34,197,94,0.12)' : 'rgba(96,165,250,0.15)', border: `1px solid ${isScrolling ? 'rgba(34,197,94,0.3)' : 'rgba(96,165,250,0.35)'}`, borderRadius: 99, padding: '8px 28px', fontSize: 15, cursor: 'pointer', color: isScrolling ? D.green : D.blue, fontWeight: 700, letterSpacing: '0.02em', transition: 'all 0.15s', WebkitTapHighlightColor: 'transparent' }}>
          {isCountingDown ? 'Cancel' : isScrolling ? '\u23f8 Pause' : '\u25b6 Play'}
        </button>
        <button onClick={e => { e.stopPropagation(); setHideControls(false); }}
          style={{ position: 'fixed', top: 12, right: 12, zIndex: 20, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '4px 10px', fontSize: 10, cursor: 'pointer', color: 'rgba(255,255,255,0.2)' }}>
          ⚙
        </button>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTROLLER — full UI
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ height: '100vh', background: D.bg, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', userSelect: 'none' }}>
      {/* ── Top control bar ──────────────────────────────────────────── */}
      <div onClick={e => e.stopPropagation()} style={{ background: D.panel, borderBottom: `1px solid ${D.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '8px 18px', gap: 12 }}>
          {/* Nav */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <button onClick={() => navigateSlide(currentIdx - 1)} disabled={currentIdx === 0}
              style={{ background: D.card, border: `1px solid ${D.border}`, color: currentIdx === 0 ? D.faint : D.text, borderRadius: 5, padding: '4px 10px', cursor: currentIdx === 0 ? 'not-allowed' : 'pointer', fontSize: 13 }}>{'\u2039'}</button>
            <span style={{ fontSize: 13, fontWeight: 600, color: D.text, padding: '0 6px' }}>{currentIdx + 1} / {slides.length}</span>
            <button onClick={() => navigateSlide(currentIdx + 1)} disabled={currentIdx === slides.length - 1}
              style={{ background: D.card, border: `1px solid ${D.border}`, color: currentIdx === slides.length - 1 ? D.faint : D.text, borderRadius: 5, padding: '4px 10px', cursor: currentIdx === slides.length - 1 ? 'not-allowed' : 'pointer', fontSize: 13 }}>{'\u203a'}</button>
          </div>

          {/* Play / Pause */}
          <button onClick={togglePlay} style={{
            display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
            background: isScrolling ? 'rgba(34,197,94,0.12)' : 'rgba(96,165,250,0.15)',
            border: `1px solid ${isScrolling ? 'rgba(34,197,94,0.35)' : 'rgba(96,165,250,0.4)'}`,
            borderRadius: 8, padding: '6px 18px', cursor: 'pointer',
            color: isScrolling ? D.green : D.blue, fontSize: 14, fontWeight: 700, letterSpacing: '0.02em', transition: 'all 0.15s', WebkitTapHighlightColor: 'transparent',
          }}>
            <span style={{ fontSize: 16 }}>{isScrolling ? '\u23f8' : '\u25b6'}</span>
            {isCountingDown ? 'Cancel' : isScrolling ? 'Pause' : 'Play'}
          </button>

          {/* Autoscroll toggle */}
          <button onClick={toggleAutoscroll} style={{
            display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
            background: autoscroll ? 'rgba(96,165,250,0.1)' : 'transparent',
            border: `1px solid ${autoscroll ? 'rgba(96,165,250,0.35)' : D.border}`,
            borderRadius: 6, padding: '5px 12px', cursor: 'pointer',
            color: autoscroll ? D.blue : D.muted, fontSize: 11, fontWeight: 600, transition: 'all 0.15s',
          }}>
            {autoscroll ? '\u25c9' : '\u25cb'} Autoscroll {autoscroll ? 'ON' : 'OFF'}
          </button>

          <span style={{ fontSize: 11, color: D.muted, fontFamily: 'monospace', flexShrink: 0 }}>{speed.toFixed(1)}×</span>
          <div style={{ flex: 1 }} />

          {/* Follower link */}
          {sessionId && (
            <button onClick={() => {
              const url = `${window.location.origin}/news-gatherer/present/teleprompter?follow=1&session=${sessionId}`;
              navigator.clipboard.writeText(url).catch(() => {});
            }} style={{ display: 'flex', alignItems: 'center', gap: 5, background: D.card, border: `1px solid ${D.border}`, borderRadius: 4, padding: '3px 10px', fontSize: 10, cursor: 'pointer', color: D.muted }}>
              📱 Copy follower link
            </button>
          )}

          {/* Take control */}
          {isLockedOut && (
            <button onClick={handleTakeControl} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.35)', borderRadius: 4, padding: '3px 10px', fontSize: 10, cursor: 'pointer', color: D.orange, fontWeight: 600 }}>
              🔒 Take control
            </button>
          )}

          {/* Settings */}
          <div onClick={() => setSettingsOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <span style={{ fontSize: 11, color: D.muted }}>{'\u2699'} Settings</span>
            <span style={{ fontSize: 10, color: D.muted }}>{settingsOpen ? '\u25b2' : '\u25bc'}</span>
          </div>
        </div>

        {settingsOpen && (
          <div style={{ padding: '4px 18px 18px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '16px 28px' }}>
            <SettingRow label="Scroll Speed" tag="synced"><NumSlider value={speed} min={0.1} max={8} step={0.1} unit="×" onChange={handleSpeedChange} /></SettingRow>
            <SettingRow label="Text Size" tag="synced"><NumSlider value={fontSize} min={18} max={60} step={1} unit="px" onChange={handleFontSizeChange} /></SettingRow>
            <SettingRow label="Line Height" tag="synced"><NumSlider value={lineHeight} min={1.2} max={3.5} step={0.1} unit="" onChange={handleLineHeightChange} /></SettingRow>
            <SettingRow label="Text Width" tag="synced">
              <div style={{ display: 'flex', border: `1px solid ${D.border}`, borderRadius: 6, overflow: 'hidden' }}>
                {(['wide', 'medium', 'narrow'] as TextWidth[]).map((w, i) => (
                  <button key={w} onClick={() => handleWidthChange(w)} style={{ flex: 1, padding: '5px 0', fontSize: 11, cursor: 'pointer', border: 'none', background: width === w ? 'rgba(96,165,250,0.15)' : 'transparent', color: width === w ? D.blue : D.muted, borderRight: i < 2 ? `1px solid ${D.border}` : undefined, textTransform: 'capitalize', transition: 'all 0.15s' }}>{w}</button>
                ))}
              </div>
            </SettingRow>
            <SettingRow label="Countdown Timer" tag="synced"><NumSlider value={countdownSetting} min={0} max={10} step={1} unit="s" onChange={handleCountdownChange} /></SettingRow>
            <SettingRow label="Mirror Text" tag="local">
              <button onClick={() => setMirror(m => !m)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', fontSize: 11, cursor: 'pointer', borderRadius: 6, background: mirror ? 'rgba(96,165,250,0.12)' : 'transparent', border: `1px solid ${mirror ? 'rgba(96,165,250,0.4)' : D.border}`, color: mirror ? D.blue : D.muted, transition: 'all 0.15s' }}>
                <span style={{ fontSize: 14, letterSpacing: '-2px' }}>{'\u21c4'}</span>
                {mirror ? 'On \u2014 text is mirrored' : 'Off \u2014 normal text'}
              </button>
            </SettingRow>
            <SettingRow label="Hide Controls" tag="local">
              <button onClick={() => setHideControls(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', fontSize: 11, cursor: 'pointer', borderRadius: 6, background: 'transparent', border: `1px solid ${D.border}`, color: D.muted, transition: 'all 0.15s' }}>
                <span style={{ fontSize: 12 }}>{'\ud83d\udda5'}</span> Enter clean view
              </button>
            </SettingRow>
          </div>
        )}
      </div>

      {/* ── Script area ──────────────────────────────────────────── */}
      {isLockedOut && (
        <div style={{ background: 'rgba(249,115,22,0.08)', borderBottom: `1px solid rgba(249,115,22,0.2)`, padding: '5px 18px', fontSize: 11, color: D.orange, textAlign: 'center', flexShrink: 0 }}>
          Another device holds control — your changes won't reach followers.{' '}
          <span onClick={handleTakeControl} style={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 600 }}>Take control</span>
        </div>
      )}
      <div ref={scrollRef} onClick={togglePlay} style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', cursor: 'pointer', position: 'relative' }}>
        {statusPill}
        {countdownOverlay}
        {renderScript()}
      </div>
    </div>
  );
}
