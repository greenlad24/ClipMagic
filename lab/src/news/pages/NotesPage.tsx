import { useNewsTheme } from '../useNewsTheme';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { getSlides, startSession, updateSession, endSession, logSlideStats, getSession, GetSlidesOutputType } from '../api';
import { connectLiveSync, type LiveSync, type MediaView } from '../liveSync';
import { slideMedia, slideHasVideo } from '../api';
import { videoPageUrl } from './VideoPage';
import { storyStage, storyBeats, beatLabel } from '../daily/stage/story';
import { findCues, markCues } from '../daily/stage/cues';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  D, NoteCard, NavStepper, TopicLabel, ViewToggle, Divider, FollowerLinkButton, SourceButton, EndButton,
  ScrollPill, ControlsBar, PlayButton, SpeedControl, SizeControl, WidthToggle, BeatDots,
} from '../presenter/chrome';

type SlideType = GetSlidesOutputType['slides'][0];

type BCMsg =
  | { type: 'slide'; slide: SlideType; idx: number; total: number; media?: MediaView; beat?: number }
  | { type: 'media'; idx: number; view: MediaView }
  | { type: 'beat'; idx: number; beat: number }
  | { type: 'blackout'; value: boolean }
  | { type: 'end' }
  | { type: 'ping' }
  | { type: 'pong' };

const CHANNEL = 'ng-presenter';


// The palette and the chrome below are shared with the Deep Dive presenter
// (../presenter/chrome.tsx), lifted out of this file verbatim.

export default function NotesPage() {
  useNewsTheme();
  const navigate = useNavigate();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();

  // Data
  const [slides, setSlides] = useState<SlideType[]>([]);
  const [loading, setLoading] = useState(true);

  // Presentation state
  const [currentIdx, setCurrentIdx] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [blackout, setBlackout] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ended, setEnded] = useState(false);
  const [gMode, setGMode] = useState(false);
  const [gBuffer, setGBuffer] = useState('');

  // Connection status
  const [displayConnected, setDisplayConnected] = useState(false);

  // Source tab — latched on/off, survives reloads
  const [sourceEnabled, setSourceEnabled] = useState(() => localStorage.getItem('tp2-source-enabled') === 'true');
  const [sourceBlocked, setSourceBlocked] = useState(false);

  // Source tab debug mode
  const [sourceDebug, setSourceDebug] = useState(false);
  const [sourceLog, setSourceLog] = useState<Array<{ time: string; msg: string; type: 'info' | 'error' | 'warn' }>>([]);

  // Teleprompter mode — synced settings come from session, mirror is local-only
  // Presentation opens on the TELEPROMPTER — it is what Jake reads from on
  // air, so landing on notes meant one extra click at the top of every show.
  const [viewMode, setViewMode] = useState<'notes' | 'teleprompter'>('teleprompter');
  const [teleprompterPaused, setTeleprompterPaused] = useState(true);
  // SYNCED settings (populated from session polling)
  const [tpSpeed, setTpSpeed] = useState(2.5);
  const [tpFontSize, setTpFontSize] = useState(32);
  const [tpLineHeight, setTpLineHeight] = useState(1.9);
  const [tpWidth, setTpWidth] = useState<'wide' | 'medium' | 'narrow'>('medium');
  // LOCAL-ONLY setting
  const tpMirror = localStorage.getItem('tp2-mirror') === 'true';

  // Multi-device sync
  const [remoteSynced, setRemoteSynced] = useState(false); // shows "Synced from device" briefly

  // Article → official video, on a slide that has one. Shared with every
  // screen (socket + session row) but deliberately NOT part of the teleprompter
  // state: switching it never touches the script, its scroll or play/pause.
  const [mediaView, setMediaViewState] = useState<MediaView>('article');
  const mediaViewRef = useRef<MediaView>('article');
  const lastLocalMediaTimeRef = useRef(0);
  // A media update for a slide this screen has not switched to yet (a join or
  // a remote slide change racing the media event) — applied when it arrives.
  const pendingMediaRef = useRef<{ idx: number; media: MediaView } | null>(null);
  const applyMediaView = (m: MediaView) => { mediaViewRef.current = m; setMediaViewState(m); };

  // The BEAT of the current story on the audience screen (Daily Show stages,
  // 2026-10-06): 0 = the story's cover, then each scene's micro-interactions.
  // → / ← step beats, then stories. Like the media view it is shared over its
  // own socket event and never touches the teleprompter. Held WITH its slide
  // index, so a beat that arrives before (or after) its slide change can never
  // be shown on the wrong story.
  const [beatAt, setBeatAtState] = useState<{ idx: number; beat: number }>({ idx: 0, beat: 0 });
  const beatAtRef = useRef<{ idx: number; beat: number }>({ idx: 0, beat: 0 });
  const lastLocalBeatTimeRef = useRef(0);
  const applyBeat = (idx: number, beat: number) => { beatAtRef.current = { idx, beat }; setBeatAtState({ idx, beat }); };
  const beatOf = (idx: number) => (beatAtRef.current.idx === idx ? beatAtRef.current.beat : 0);

  // Refs
  const slideStartRef = useRef(Date.now());
  const streamStartRef = useRef(Date.now());
  const navOrderRef = useRef(0);
  const gTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const lastPongRef = useRef(0);
  const lastLocalNavTimeRef = useRef(0); // ms timestamp of last local navigation (used to suppress remote sync noise)
  const channelRef = useRef<BroadcastChannel | null>(null);
  const sourceWindowRef = useRef<Window | null>(null);
  const teleprompterRef = useRef<HTMLDivElement>(null);
  const scrollAnimRef = useRef<number | undefined>();
  const ctxRef = useRef({ currentIdx: 0, slides: [] as SlideType[], sessionId: '', blackout: false });
  // Set around our OWN programmatic scrolls, so the scrub listener can tell a
  // user dragging from the animation loop moving the element itself. Without
  // it every rendered frame looks like a seek and re-anchors the whole room.
  const ignoreScrollUntilRef = useRef(0);
  // ⚠️ THE ONLY RELIABLE WAY TO TELL OUR OWN SCROLL FROM THE USER'S. A time
  // window cannot do it: while playing we write scrollTop every frame, so any
  // drag would land inside the window and be discarded. Comparing against the
  // value we last wrote works in both states.
  const lastProgScrollRef = useRef(-1);

  useEffect(() => {
    ctxRef.current = { currentIdx, slides, sessionId: sessionId || '', blackout };
  }, [currentIdx, slides, sessionId, blackout]);

  useEffect(() => {
    if (!authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [authLoading, user, loginWithRedirect]);

  // Persist source-tab latch
  useEffect(() => { localStorage.setItem('tp2-source-enabled', String(sourceEnabled)); }, [sourceEnabled]);

  // Load slides + start/join session
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const data = await getSlides({});
        if (!data.deck || data.slides.length === 0) { toast.error('No deck found. Build a deck first.'); return; }
        setSlides(data.slides);
        const sess = await startSession({ deckId: data.deck.id, controllerId: window.localStorage.getItem('tp2-device-id') || undefined } as any);
        setSessionId(sess.sessionId);
        // Joining an existing session — sync to wherever the other device is
        if (!sess.isNew) {
          const state = await getSession({ sessionId: sess.sessionId });
          const remoteIdx = typeof state.session?.currentSlideIndex === 'number' ? state.session.currentSlideIndex : 0;
          if (remoteIdx > 0) setCurrentIdx(remoteIdx);
          // Mark as "just synced remotely" so the poller doesn't immediately overwrite
          lastLocalNavTimeRef.current = Date.now() - 5000;
        }
      } catch { toast.error('Failed to load presentation'); }
      finally { setLoading(false); }
    })();
  }, [user]);

  // BroadcastChannel — receive pongs from Display tab
  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL);
    channelRef.current = ch;
    ch.onmessage = (e) => {
      const msg: BCMsg = e.data;
      if (msg.type === 'pong') {
        lastPongRef.current = Date.now();
        setDisplayConnected(true);
        const { slides: sls, currentIdx: ci, blackout: bo } = ctxRef.current;
        if (sls[ci]) ch.postMessage({ type: 'slide', slide: sls[ci], idx: ci, total: sls.length, media: mediaViewRef.current, beat: beatOf(ci) } satisfies BCMsg);
        if (bo) ch.postMessage({ type: 'blackout', value: bo } satisfies BCMsg);
      }
    };
    return () => ch.close();
  }, []);

  // Ping Display tab every 1s
  useEffect(() => {
    const iv = setInterval(() => {
      channelRef.current?.postMessage({ type: 'ping' } satisfies BCMsg);
      setDisplayConnected(Date.now() - lastPongRef.current < 5000);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // Cross-device sync — poll session every 1.5s and apply changes from other devices
  useEffect(() => {
    if (!sessionId) return;
    const iv = setInterval(async () => {
      try {
        const state = await getSession({ sessionId });
        if (!state.session) return;
        const remoteIdx = typeof state.session.currentSlideIndex === 'number' ? state.session.currentSlideIndex : 0;
        const timeSinceLocalNav = Date.now() - lastLocalNavTimeRef.current;
        const localIdx = ctxRef.current.currentIdx;
        // Only apply remote change if this device hasn't navigated in the last 2s
        // (prevents the two devices from fighting each other)
        const remoteBeat = typeof state.session.currentBeat === 'number' ? Math.max(0, Math.round(state.session.currentBeat)) : 0;
        if (remoteIdx !== localIdx && timeSinceLocalNav > 2000) {
          setCurrentIdx(remoteIdx);
          applyBeat(remoteIdx, remoteBeat);
          const sls = ctxRef.current.slides;
          if (channelRef.current && sls[remoteIdx]) {
            channelRef.current.postMessage({ type: 'slide', slide: sls[remoteIdx], idx: remoteIdx, total: sls.length, beat: remoteBeat } satisfies BCMsg);
          }
          setRemoteSynced(true);
          setTimeout(() => setRemoteSynced(false), 2000);
        }
        // The beat of the story both devices are on — unless this device just stepped.
        if (remoteIdx === ctxRef.current.currentIdx && remoteBeat !== beatOf(remoteIdx)
            && Date.now() - lastLocalBeatTimeRef.current > 2000 && timeSinceLocalNav > 2000) {
          applyBeat(remoteIdx, remoteBeat);
          channelRef.current?.postMessage({ type: 'beat', idx: remoteIdx, beat: remoteBeat } satisfies BCMsg);
        }
        // Article/video for the slide both devices are on — unless this device just changed it.
        const remoteMedia: MediaView = state.session.mediaView === 'video' ? 'video' : 'article';
        if (remoteIdx === ctxRef.current.currentIdx && remoteMedia !== mediaViewRef.current
            && Date.now() - lastLocalMediaTimeRef.current > 2000 && timeSinceLocalNav > 2000
            && (remoteMedia === 'article' || slideHasVideo(ctxRef.current.slides[remoteIdx]))) {
          applyMediaView(remoteMedia);
          channelRef.current?.postMessage({ type: 'media', idx: remoteIdx, view: remoteMedia } satisfies BCMsg);
        }
        // Pick up synced teleprompter settings from session
        if (typeof state.session.tpSpeed === 'number') setTpSpeed(state.session.tpSpeed);
        if (typeof state.session.tpFontSize === 'number') setTpFontSize(state.session.tpFontSize);
        if (typeof state.session.tpLineHeight === 'number') setTpLineHeight(state.session.tpLineHeight);
        if (state.session.tpWidth && ['wide', 'medium', 'narrow'].includes(state.session.tpWidth)) setTpWidth(state.session.tpWidth as 'wide' | 'medium' | 'narrow');
      } catch { /* silent — polling failure shouldn't disrupt the show */ }
    }, 1500);
    return () => clearInterval(iv);
  }, [sessionId]);

  // Reset teleprompter scroll on slide change — start paused so presenter controls when scrolling begins
  useEffect(() => {
    if (teleprompterRef.current) teleprompterRef.current.scrollTop = 0;
    setTeleprompterPaused(true);

    // Sync source tab if latched on — navigate the existing tab, never reopen
    if (sourceEnabled) {
      const url = slides[currentIdx]?.bestSourceUrl;
      if (url) {
        const existing = sourceWindowRef.current;
        if (existing && !existing.closed) {
          // Tab is still open — navigate it in place without stealing focus
          try {
            existing.location.href = url;
            logSource(`slide→tab: reused → ${url.slice(0, 60)}`);
          } catch {
            logSource('slide→tab: cross-origin nav failed', 'warn');
          }
          // Keep presenter window focused
          window.focus();
        } else {
          // Tab was closed — turn source off silently, don't pop a new window
          sourceWindowRef.current = null;
          setSourceEnabled(false);
          logSource('slide→tab: tab was closed — source off');
        }
      }
    }
  }, [currentIdx]);

  // Claim teleprompter control when switching to teleprompter tab
  useEffect(() => {
    if (viewMode !== 'teleprompter') return;
    const sid = ctxRef.current.sessionId;
    if (!sid) return;
    const deviceId = window.localStorage.getItem('tp2-device-id') || undefined;
    updateSession({ sessionId: sid, deviceId, tpControllerId: deviceId } as any).catch(() => {});
  }, [viewMode, sessionId]);

  // Teleprompter auto-scroll — uses tp2-* settings from TeleprompterPage
  useEffect(() => {
    if (viewMode !== 'teleprompter') {
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
      return;
    }
    let lastTs: number | null = null;
    let renderPos = teleprompterRef.current ? teleprompterRef.current.scrollTop : 0;

    const tick = (t: number) => {
      const el = teleprompterRef.current;
      const sync = syncRef.current;
      if (el && sync) {
        const max = el.scrollHeight - el.clientHeight;
        tpMaxRef.current = max;
        if (max > 0 && sync.state().isPlaying) {
          const target = sync.positionNow() * max;
          const diff = target - renderPos;
          // A big correction is a join, a seek or a slide change: snap. A small
          // one is drift or a heartbeat: ease, so the pull is invisible.
          if (Math.abs(diff) > 150) {
            renderPos = target;
          } else {
            const dt = lastTs == null ? 16 : Math.min(100, t - lastTs);
            renderPos += diff * (1 - Math.exp(-dt / 120));
          }
          lastProgScrollRef.current = renderPos;
          el.scrollTop = renderPos;
        } else {
          renderPos = el.scrollTop;
        }
      }
      lastTs = t;
      scrollAnimRef.current = requestAnimationFrame(tick);
    };
    scrollAnimRef.current = requestAnimationFrame(tick);
    return () => { if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current); };
  }, [viewMode]);

  // A manual scrub moves EVERY screen — WHILE PLAYING AS WELL AS PAUSED.
  // Dragging one screen and watching the other ignore you is the single most
  // obvious way for a sync to look broken, and "paused only" is an arbitrary
  // line: the presenter nudges the script mid-read.
  // ⚠️ `loading` IS IN THE DEPS BECAUSE THE ELEMENT DOES NOT EXIST YET ON MOUNT.
  // The page renders a loading screen first, so `teleprompterRef.current` is
  // null when this effect first runs; without a dep that changes afterwards the
  // listener is never attached and this screen's scrubs are never published —
  // silently, since everything else about the sync keeps working.
  useEffect(() => {
    if (viewMode !== 'teleprompter' || loading) return;
    const el = teleprompterRef.current;
    if (!el) return;
    const onScroll = () => {
      // Within a couple of pixels of what we last wrote → it was us.
      if (Math.abs(el.scrollTop - lastProgScrollRef.current) <= 2) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      syncRef.current?.seek(Math.max(0, Math.min(1, el.scrollTop / max)));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); };
  }, [viewMode, loading]);

  const logSource = useCallback((msg: string, type: 'info' | 'error' | 'warn' = 'info') => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setSourceLog(prev => [...prev.slice(-4), { time, msg, type }]);
  }, []);

  const navigateTo = useCallback(async (idx: number, beat = 0) => {
    const { currentIdx: cur, slides: sls, sessionId: sid } = ctxRef.current;
    if (idx < 0 || idx >= sls.length) return;
    applyBeat(idx, beat);
    lastLocalNavTimeRef.current = Date.now(); // suppress remote sync for 2s after local nav
    const spent = Math.floor((Date.now() - slideStartRef.current) / 1000);
    if (sid && sls[cur]) {
      navOrderRef.current += 1;
      logSlideStats({ sessionId: sid, slideId: sls[cur].id, timeSpentSeconds: spent, navigationOrder: navOrderRef.current }).catch(() => {});
      const deviceId = window.localStorage.getItem('tp2-device-id') || undefined;
      updateSession({ sessionId: sid, deviceId, currentSlideIndex: idx, currentBeat: beat, tpScrollPct: 0, tpPaused: true, tpAutoscroll: false, mediaView: 'article' } as any).catch(() => {});
      // The socket carries the slide for the live screens; the session write
      // above stays as the durable record the next reload reads.
      syncRef.current?.setSlide(idx, beat);
    }
    slideStartRef.current = Date.now();
    setCurrentIdx(idx);
    if (channelRef.current && sls[idx]) {
      channelRef.current.postMessage({ type: 'slide', slide: sls[idx], idx, total: sls.length, media: 'article', beat } satisfies BCMsg);
    }
    // Source tab auto-navigation is handled by the currentIdx effect
  }, [logSource]);

  const handleOpenSource = useCallback(() => {
    if (sourceEnabled) {
      // Toggle off
      setSourceEnabled(false);
      logSource('source following turned off');
      return;
    }
    // Toggle on — open source for current slide
    const url = ctxRef.current.slides[ctxRef.current.currentIdx]?.bestSourceUrl;
    if (!url) { logSource('button: no URL for this slide', 'warn'); return; }
    const win = window.open(url, 'ng-source-tab');
    if (win) {
      sourceWindowRef.current = win;
      setSourceEnabled(true);
      setSourceBlocked(false);
      logSource(`button: opened ${url.slice(0, 70)}`);
      // Keep presenter window focused
      setTimeout(() => window.focus(), 100);
    } else {
      setSourceBlocked(true);
      logSource('button: window.open blocked — popup blocker?', 'error');
    }
  }, [logSource, sourceEnabled]);

  const toggleBlackout = useCallback(async () => {
    const { sessionId: sid, blackout: bo } = ctxRef.current;
    const next = !bo;
    setBlackout(next);
    if (sid) updateSession({ sessionId: sid, blackout: next }).catch(() => {});
    channelRef.current?.postMessage({ type: 'blackout', value: next } satisfies BCMsg);
  }, []);

  const doEndStream = useCallback(async () => {
    const { sessionId: sid } = ctxRef.current;
    if (sid) await endSession({ sessionId: sid, totalDurationSeconds: Math.floor((Date.now() - streamStartRef.current) / 1000) }).catch(() => {});
    channelRef.current?.postMessage({ type: 'end' } satisfies BCMsg);
    setEnded(true);
    navigate('/news-gatherer/dashboard');
  }, [navigate]);

  // Keyboard shortcuts
  const viewModeRef = useRef(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  // ── Live sync ────────────────────────────────────────────────────────────
  // ⚠️ THE PRESENTER NO LONGER PUBLISHES ITS POSITION — IT SOLVES THE SAME
  // ANCHOR AS EVERY OTHER SCREEN. The old loop scrolled locally and pushed its
  // scrollTop 4×/sec; every follower was therefore always one network hop
  // behind, by a different amount per device. Now whoever presses play sets an
  // anchor and all screens render from it, so "in sync" is a property of the
  // arithmetic rather than something maintained by constant correction.
  const syncRef = useRef<LiveSync | null>(null);
  const tpMaxRef = useRef(0);

  /**
   * The anchor's slope, in fraction-of-script per millisecond.
   *
   * ⚠️ DERIVED FROM THIS SCREEN'S OWN SCROLL HEIGHT. A pixels-per-second speed
   * means something different on a phone than on a monitor; a fraction per
   * millisecond means the same thing everywhere, which is what lets the two
   * screens stay on the same words.
   */
  const rateFor = useCallback((speed: number): number => {
    const el = teleprompterRef.current;
    const max = el ? el.scrollHeight - el.clientHeight : 0;
    if (max <= 0) return 0;
    return (speed * 8) / max / 1000;
  }, []);

  useEffect(() => {
    const sid = sessionId;
    if (!sid) return;
    const sync = connectLiveSync(sid);
    syncRef.current = sync;
    sync.onSync((snap) => {
      // The authoritative event drives the UI, including for the screen that
      // asked for the change — a local guess can disagree with the broadcast.
      setTeleprompterPaused(!snap.isPlaying);
      // ⚠️ A PAUSED SCREEN MUST STILL FOLLOW. The render loop only writes
      // scrollTop while playing, so without this a seek — someone scrubbing the
      // other screen, or a jump to the top — left this one exactly where it was
      // and the two silently parted. Scrolling while paused is the case where
      // that is most obvious: you drag one screen and the other ignores you.
      if (!snap.isPlaying) {
        const el = teleprompterRef.current;
        if (el) {
          const max = el.scrollHeight - el.clientHeight;
          if (max > 0) {
            // Marked as ours, or the scrub listener reads it back as a user
            // drag and echoes it to everyone in a loop.
            lastProgScrollRef.current = snap.position * max;
            el.scrollTop = snap.position * max;
          }
        }
      }
      if (typeof snap.scrollSpeed === 'number') setTpSpeed(snap.scrollSpeed);
      if (typeof snap.idx === 'number' && snap.idx !== ctxRef.current.currentIdx) {
        const n = ctxRef.current.slides.length;
        setCurrentIdx(Math.max(0, Math.min(n > 0 ? n - 1 : 0, snap.idx)));
      }
    });
    // Article/video changed (here or on another screen) — the broadcast is authoritative.
    sync.onMedia((m) => {
      const media: MediaView = m.media === 'video' ? 'video' : 'article';
      if (m.idx !== ctxRef.current.currentIdx) { pendingMediaRef.current = { idx: m.idx, media }; return; }
      if (media === 'video' && !slideHasVideo(ctxRef.current.slides[m.idx])) return;
      if (media !== mediaViewRef.current) {
        applyMediaView(media);
        channelRef.current?.postMessage({ type: 'media', idx: m.idx, view: media } satisfies BCMsg);
      }
    });
    // A beat stepped (here or on another screen). The sender gets its own echo;
    // ignoring echoes for a moment after a local step keeps a fast double-tap
    // from flickering back to the beat in between.
    sync.onBeat((b) => {
      if (typeof b.idx !== 'number' || typeof b.beat !== 'number') return;
      if (b.idx === ctxRef.current.currentIdx && Date.now() - lastLocalBeatTimeRef.current < 800) return;
      if (b.idx === beatAtRef.current.idx && b.beat === beatAtRef.current.beat) return;
      applyBeat(b.idx, b.beat);
      if (b.idx === ctxRef.current.currentIdx) channelRef.current?.postMessage({ type: 'beat', idx: b.idx, beat: b.beat } satisfies BCMsg);
    });
    // Appearance changed on another screen — apply it here.
    sync.onAppearance((a) => {
      if (typeof a.textSize === 'number') setTpFontSize(a.textSize);
      if (typeof a.lineHeight === 'number') setTpLineHeight(a.lineHeight);
      if (a.textWidth && ['wide', 'medium', 'narrow'].includes(a.textWidth)) {
        setTpWidth(a.textWidth as 'wide' | 'medium' | 'narrow');
      }
    });
    return () => { sync.close(); syncRef.current = null; };
  }, [sessionId]);

  const tpPausedRef = useRef(teleprompterPaused);
  useEffect(() => { tpPausedRef.current = teleprompterPaused; }, [teleprompterPaused]);
  const tpSpeedRef = useRef(tpSpeed);
  useEffect(() => { tpSpeedRef.current = tpSpeed; }, [tpSpeed]);
  const tpFontSizeRef = useRef(tpFontSize);
  useEffect(() => { tpFontSizeRef.current = tpFontSize; }, [tpFontSize]);
  const tpLineHeightRef = useRef(tpLineHeight);
  useEffect(() => { tpLineHeightRef.current = tpLineHeight; }, [tpLineHeight]);

  /**
   * ⚠️ ARROW KEYS JUMP THE SCRIPT AND THE JUMP IS PUBLISHED, so both screens
   * land in the same place. Three lines of the CURRENT type size, expressed as
   * a fraction — it feels the same at 18px and 56px, and means the same thing
   * on a phone as on the monitor.
   */
  const nudge = useCallback((direction: 1 | -1) => {
    const el = teleprompterRef.current;
    const sync = syncRef.current;
    if (!el || !sync) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const stepPx = tpFontSizeRef.current * tpLineHeightRef.current * 3;
    sync.seek(Math.max(0, Math.min(1, sync.positionNow() + direction * (stepPx / max))));
  }, []);

  /**
   * Article ↔ official video on the CURRENT slide. Socket only: the server
   * persists it to the session row itself. ⚠️ NOT updateSession — that stamps
   * a new tpRevision, and the legacy follower mode re-applies the row's scroll
   * position on every revision, which would jump the script on a toggle.
   */
  const setMedia = useCallback((next: MediaView) => {
    const { currentIdx: ci, slides: sls } = ctxRef.current;
    if (next === 'video' && !slideHasVideo(sls[ci])) return;
    if (next === mediaViewRef.current) return;
    lastLocalMediaTimeRef.current = Date.now();
    applyMediaView(next);
    syncRef.current?.setMedia(ci, next);
    channelRef.current?.postMessage({ type: 'media', idx: ci, view: next } satisfies BCMsg);
  }, []);

  // A new slide always opens on its article (or on what the room says, when a
  // media update for this slide arrived before the slide did).
  useEffect(() => {
    const p = pendingMediaRef.current;
    pendingMediaRef.current = null;
    const m: MediaView = p && p.idx === currentIdx && p.media === 'video' && slideHasVideo(slides[currentIdx]) ? 'video' : 'article';
    applyMediaView(m);
  }, [currentIdx]);

  // The latched source tab follows the media view too: the video plays in it
  // full window, and going back to the article puts the article back.
  const sourceTabRef = useRef<{ idx: number; url: string }>({ idx: -1, url: '' });
  useEffect(() => {
    // The ref, not the state: on a slide change the reset effect above has
    // already set it to 'article' while this render still holds the old state.
    const media = mediaViewRef.current;
    const sl = slides[currentIdx];
    // Video view: the Lab's full-window player page, not the raw video URL (a bare file opens paused in the browser's viewer).
    const url = sl ? (media === 'video' && slideHasVideo(sl) ? videoPageUrl(slideMedia(sl)!) : sl.bestSourceUrl || '') : '';
    const prev = sourceTabRef.current;
    sourceTabRef.current = { idx: currentIdx, url };
    // A slide change lands on the article, and the currentIdx effect has already navigated the tab there.
    if (prev.idx !== currentIdx && media === 'article') return;
    if (!sourceEnabled || !url || url === prev.url) return;
    const win = sourceWindowRef.current;
    if (!win || win.closed) return;
    try { win.location.href = url; } catch { /* cross-origin nav refused */ }
    window.focus();
  }, [mediaView, currentIdx]);

  const toggleTpPlayPause = useCallback(() => {
    const nextPaused = !tpPausedRef.current;
    const sync = syncRef.current;
    if (!sync) { setTeleprompterPaused(nextPaused); return; }
    // Starting: publish the slope first, computed from THIS screen's geometry,
    // so the anchor the others receive is already complete. Then play — and let
    // the returning broadcast be what flips the UI, here and everywhere else.
    if (!nextPaused) sync.setSpeed(tpSpeedRef.current, rateFor(tpSpeedRef.current));
    sync.playPause(!nextPaused);
  }, [rateFor]);

  /**
   * → / ← (Jake, 2026-10-06): step the story's BEATS — the cover, then each
   * micro-interaction — and past the last beat to the next story; back past
   * the cover to the previous story's LAST beat. Never opens the video (that
   * is Shift). A step while the video is up also closes it: the video was an
   * aside, and the beat being stepped to should be what the audience sees.
   */
  const stepBeat = useCallback((dir: 1 | -1) => {
    const { currentIdx: ci, slides: sls } = ctxRef.current;
    const cur = sls[ci];
    if (!cur) return;
    const n = storyBeats(storyStage(cur));
    const b = beatOf(ci);
    if (mediaViewRef.current === 'video') setMedia('article');
    if (dir > 0 && b < n - 1) {
      lastLocalBeatTimeRef.current = Date.now();
      applyBeat(ci, b + 1);
      syncRef.current?.setBeat(ci, b + 1);
      channelRef.current?.postMessage({ type: 'beat', idx: ci, beat: b + 1 } satisfies BCMsg);
    } else if (dir < 0 && b > 0) {
      lastLocalBeatTimeRef.current = Date.now();
      applyBeat(ci, b - 1);
      syncRef.current?.setBeat(ci, b - 1);
      channelRef.current?.postMessage({ type: 'beat', idx: ci, beat: b - 1 } satisfies BCMsg);
    } else if (dir > 0) {
      navigateTo(ci + 1, 0);
    } else if (ci > 0) {
      navigateTo(ci - 1, storyBeats(storyStage(sls[ci - 1])) - 1);
    }
  }, [navigateTo, setMedia]);

  // Shift ALONE toggles the story video full screen. Alone = released with no
  // other key pressed in between, so Shift+D (debug) and a capital letter
  // never flip the audience screen to the video.
  const shiftAloneRef = useRef(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { currentIdx: ci } = ctxRef.current;
      if (e.key === 'Shift') { if (!e.repeat) shiftAloneRef.current = true; return; }
      shiftAloneRef.current = false;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); stepBeat(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); stepBeat(-1); }
      else if (e.key === 'Escape' && mediaViewRef.current === 'video') { e.preventDefault(); setMedia('article'); }
      // Up/down move through the SCRIPT; left/right move between SLIDES.
      else if (e.key === 'ArrowDown' && viewModeRef.current === 'teleprompter') { e.preventDefault(); nudge(1); }
      else if (e.key === 'ArrowUp' && viewModeRef.current === 'teleprompter') { e.preventDefault(); nudge(-1); }
      else if (e.key === ' ') {
        e.preventDefault();
        if (viewModeRef.current === 'teleprompter') {
          toggleTpPlayPause();
        } else {
          navigateTo(ci + 1);
        }
      }
      else if (e.key === 'e' || e.key === 'E') setConfirmEnd(true);
      else if (e.key === 't' || e.key === 'T') setViewMode(v => v === 'notes' ? 'teleprompter' : 'notes');
      else if (e.key === 'D' && e.shiftKey) { e.preventDefault(); setSourceDebug(d => !d); }
      else if (e.key === 'g' || e.key === 'G') { setGMode(true); setGBuffer(''); }
      else if (gMode && /^\d$/.test(e.key)) {
        const buf = gBuffer + e.key;
        setGBuffer(buf);
        clearTimeout(gTimerRef.current);
        gTimerRef.current = setTimeout(() => { navigateTo(parseInt(buf) - 1); setGMode(false); setGBuffer(''); }, 600);
      } else if (!gMode && /^[1-9]$/.test(e.key)) navigateTo(parseInt(e.key) - 1);
    };
    const upHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || !shiftAloneRef.current) return;
      shiftAloneRef.current = false;
      const { currentIdx: ci, slides: sls } = ctxRef.current;
      if (!slideHasVideo(sls[ci])) return;
      setMedia(mediaViewRef.current === 'video' ? 'article' : 'video');
    };
    const blur = () => { shiftAloneRef.current = false; };
    window.addEventListener('keydown', handler);
    window.addEventListener('keyup', upHandler);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', handler); window.removeEventListener('keyup', upHandler); window.removeEventListener('blur', blur); };
  }, [gMode, gBuffer, navigateTo, toggleBlackout, toggleTpPlayPause, nudge, setMedia, stepBeat]);

  // The current story's stage (cover + scenes) and where its cues sit in the script.
  const curSlide = slides[currentIdx];
  const stage = useMemo(() => storyStage(curSlide), [curSlide]);
  const cueSpans = useMemo(() => findCues(curSlide?.teleprompterScript || '', stage.cues), [curSlide, stage]);

  // ── Guards ─────────────────────────────────────────────────────────────────

  if (authLoading || !user || loading) return (
    <div style={{ height: '100vh', background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: D.muted }}>Loading…</p>
    </div>
  );

  if (ended) return (
    <div style={{ height: '100vh', background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: D.muted }}>Stream ended.</p>
    </div>
  );

  if (blackout) return <div style={{ position: 'fixed', inset: 0, background: '#000' }} />;

  if (slides.length === 0) return (
    <div style={{ height: '100vh', background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: D.muted }}>No slides found. Build a deck first.</p>
    </div>
  );

  // ── Derived ───────────────────────────────────────────────────────────────

  const slide = slides[currentIdx];
  const keyPoints: string[] = (() => { try { return JSON.parse(slide?.keyPoints || '[]'); } catch { return []; } })();
  const sourceUrl = slide?.bestSourceUrl || '';
  const sourceName = slide?.bestSourceName || 'Unknown';
  const sourceHost = sourceUrl ? (() => { try { return new URL(sourceUrl).hostname.replace('www.', ''); } catch { return ''; } })() : '';
  const upNext = slides.slice(currentIdx + 1, currentIdx + 3);
  const totalBeats = storyBeats(stage);
  const curBeat = Math.min(totalBeats - 1, beatAt.idx === currentIdx ? beatAt.beat : 0);
  const isTeleprompter = viewMode === 'teleprompter';

  return (
    <div style={{ height: '100vh', background: D.bg, color: D.text, display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>

      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <header style={{ background: D.panel, borderBottom: `1px solid ${D.border}`, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>

        {/* Nav buttons */}
        <NavStepper
          label={<>
            {currentIdx + 1} / {slides.length}
            {gMode && gBuffer && <span style={{ marginLeft: 6, fontSize: 11, color: D.blue }}>→ {gBuffer}</span>}
          </>}
          onPrev={() => navigateTo(currentIdx - 1)} prevDisabled={currentIdx === 0}
          onNext={() => navigateTo(currentIdx + 1)} nextDisabled={currentIdx === slides.length - 1}
        />

        {/* Topic label */}
        <TopicLabel>{slide?.topicLabel}</TopicLabel>

        {/* Right controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>

          {/* Notes / Teleprompter toggle */}
          <ViewToggle mode={viewMode} onChange={setViewMode} />

          <Divider />

          {/* Mirror on device */}
          <FollowerLinkButton getSessionId={() => ctxRef.current.sessionId} synced={remoteSynced} />

          <Divider />

          {/* Source tab */}
          {sourceUrl && (
            <SourceButton enabled={sourceEnabled} blocked={sourceBlocked} onClick={handleOpenSource} />
          )}

          <EndButton onClick={() => setConfirmEnd(true)} />
        </div>
      </header>

      {/* ── Main content ───────────────────────────────────────────────── */}
      {isTeleprompter ? (
        // ── TELEPROMPTER VIEW ───────────────────────────────────────────
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            ref={teleprompterRef}
            style={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative', scrollbarWidth: 'thin', scrollbarColor: `${D.faint} transparent` }}
          >
            {/* Scroll state indicator */}
            <ScrollPill paused={teleprompterPaused} />

            <div style={{ maxWidth: tpWidth === 'wide' ? 960 : tpWidth === 'narrow' ? 420 : 660, margin: '0 auto', padding: '44px 40px 0', transform: tpMirror ? 'scaleX(-1)' : undefined, position: 'relative' }}>

              {/* Slide label */}
              <p style={{ fontSize: 11, fontWeight: 700, color: D.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 28 }}>
                {currentIdx + 1} / {slides.length} · {sourceName}{sourceHost ? ` · ${sourceHost}` : ''}
              </p>

              {slide?.teleprompterScript ? (
                (() => { let off = 0; const script = slide.teleprompterScript; return script.split('\n\n').map((raw) => {
                  // Where this paragraph starts in the whole script, for the cue marks.
                  const at = script.indexOf(raw, off); off = at + raw.length;
                  return { para: raw, start: at + (raw.length - raw.trimStart().length) };
                }); })().map(({ para, start }, i) =>
                  para.trim() ? (
                    <p key={i} style={{
                      fontSize: tpFontSize,
                      lineHeight: tpLineHeight,
                      color: '#ffffff',
                      fontWeight: 400,
                      margin: `0 0 ${Math.round(tpFontSize * 0.8)}px`,
                      // ⚠️ THESE THREE VALUES ARE SHARED WITH THE FOLLOWER PAGE
                      // AND THE STANDALONE TELEPROMPTER. This is the screen Jake
                      // presents from; the follower is what a second screen sees.
                      // A different font (system-ui resolves per platform) or a
                      // different letter-spacing wraps the same script at
                      // different words, so the two screens show different lines
                      // while their scroll positions agree perfectly.
                      letterSpacing: '0.012em',
                      fontFamily: "'NewsScript', Arial, Helvetica, sans-serif",
                      WebkitTextSizeAdjust: '100%',
                    } as React.CSSProperties}>
                      {markCues(para.trim(), start, cueSpans, curBeat)}
                    </p>
                  ) : null
                )
              ) : (
                <div style={{ textAlign: 'center', marginTop: 60 }}>
                  <p style={{ fontSize: 18, color: D.muted, marginBottom: 8 }}>No script for this slide.</p>
                  <p style={{ fontSize: 13, color: D.faint }}>Rebuild the deck to generate teleprompter scripts.</p>
                </div>
              )}

              {/* Bottom spacer so last line can scroll to top */}
              <div style={{ height: '70vh' }} />
            </div>
          </div>

          {/* ── Teleprompter Controls (simple — configure on standalone page) */}
          <ControlsBar>
            {/* Play / Pause — ONE path: the space bar and this button must not
                be able to disagree about what "playing" means. */}
            <PlayButton paused={teleprompterPaused} onClick={toggleTpPlayPause} />

            <SpeedControl value={tpSpeed} onChange={v => {
              setTpSpeed(v);
              const sid = ctxRef.current.sessionId;
              if (sid) { const deviceId = window.localStorage.getItem('tp2-device-id') || undefined; updateSession({ sessionId: sid, deviceId, tpSpeed: v } as any).catch(() => {}); }
              // Re-anchor at the new slope, or the change applies retroactively.
              syncRef.current?.setSpeed(v, rateFor(v));
            }} />

            <Divider spaced />

            <SizeControl value={tpFontSize} onChange={v => {
              setTpFontSize(v);
              const sid = ctxRef.current.sessionId;
              if (sid) { const deviceId = window.localStorage.getItem('tp2-device-id') || undefined; updateSession({ sessionId: sid, deviceId, tpFontSize: v } as any).catch(() => {}); }
              syncRef.current?.setTextSize(v);
            }} />

            <Divider spaced />

            <WidthToggle value={tpWidth} onChange={w => {
              setTpWidth(w);
              const sid = ctxRef.current.sessionId;
              if (sid) { const deviceId = window.localStorage.getItem('tp2-device-id') || undefined; updateSession({ sessionId: sid, deviceId, tpWidth: w } as any).catch(() => {}); }
              syncRef.current?.setTextWidth(w);
            }} />

            {/* Beats of this story — → / ← step them (then the next / previous story). */}
            <Divider spaced />
            <BeatDots cur={curBeat} total={totalBeats}
              title={stage.fallback ? 'This story has no built visuals yet — showing its key points. Make visuals from the dashboard (Selections).' : '→ / ← step the beats, then the stories'}
              next={curBeat < totalBeats - 1 ? beatLabel(stage, curBeat + 1) : currentIdx < slides.length - 1 ? `story ${currentIdx + 2}` : null} />

            {/* Article / Video — only on a slide that has an official video. Shift toggles it, Esc closes. */}
            {slideHasVideo(slide) && (
              <>
                <div style={{ width: 1, height: 14, background: D.border, margin: '0 4px' }} />
                <div data-media-toggle style={{ display: 'flex', border: `1px solid ${D.border}`, borderRadius: 4, overflow: 'hidden', fontSize: 10 }}
                  title={`${slide!.videoTier === 'product' ? 'Product demo' : 'Launch video'}: ${slide!.videoTitle || ''}${slide!.videoChannel ? ` (${slide!.videoChannel})` : ''} — Shift shows it full screen, Shift or Esc closes`}>
                  {(['article', 'video'] as const).map(m => (
                    <button key={m} data-media={m} onClick={() => setMedia(m)} style={{
                      padding: '2px 8px', border: 'none', cursor: 'pointer',
                      background: mediaView === m ? (m === 'video' ? 'rgba(239,68,68,0.15)' : 'rgba(96,165,250,0.15)') : 'transparent',
                      color: mediaView === m ? (m === 'video' ? '#fca5a5' : D.blue) : D.muted,
                      borderLeft: m === 'video' ? `1px solid ${D.border}` : 'none',
                    }}>{m === 'article' ? 'Slides' : '▶ Video ⇧'}</button>
                  ))}
                </div>
              </>
            )}

            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: D.faint, whiteSpace: 'nowrap' }}>Followers see this tab</span>
          </ControlsBar>
        </div>
      ) : (
        // ── NOTES VIEW ─────────────────────────────────────────────────
        <>
          {/* Title + source */}
          <div style={{ padding: '14px 18px 6px', flexShrink: 0 }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#fff', margin: 0, lineHeight: 1.3 }}>{slide?.topicLabel}</h1>
            <p style={{ fontSize: 12, color: D.muted, margin: '4px 0 0' }}>
              {sourceName}{sourceHost ? ` · ${sourceHost}` : ''}
            </p>
          </div>

          {/* Notes grid */}
          <div style={{ flex: 1, overflow: 'auto', padding: '10px 16px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, alignContent: 'start' }}>
            <NoteCard title="🎯 Why It Matters" text={slide?.whyItMatters} />
            <NoteCard title="🔑 Key Points" keyPoints={keyPoints} />
            <NoteCard title="💡 Talking Angle" text={slide?.talkingAngle} />
          </div>

          {/* Up Next */}
          {upNext.length > 0 && (
            <div style={{ padding: '6px 16px 12px', flexShrink: 0 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: D.muted, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 6px' }}>Up Next</p>
              <div style={{ display: 'flex', gap: 8 }}>
                {upNext.map((s, i) => (
                  <button
                    key={s.id}
                    onClick={() => navigateTo(currentIdx + 1 + i)}
                    style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 6, padding: '7px 11px', flex: 1, textAlign: 'left', cursor: 'pointer', transition: 'border-color 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = D.blue)}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = D.border)}
                  >
                    <p style={{ fontSize: 12, color: D.text, margin: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {currentIdx + 2 + i}. {s.topicLabel}
                    </p>
                    <p style={{ fontSize: 11, color: D.muted, margin: '2px 0 0' }}>
                      {s.bestSourceName}{s.suggestedTimeSeconds ? ` · ${s.suggestedTimeSeconds}s` : ''}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Source Tab Debug Overlay (Shift+D) ────────────────────────── */}
      {sourceDebug && (() => {
        const refExists = !!sourceWindowRef.current;
        const refOpen = refExists && !sourceWindowRef.current!.closed;
        const currentUrl = slides[currentIdx]?.bestSourceUrl || '\u2014';
        return (
          <div style={{
            position: 'fixed', bottom: 60, left: 12, zIndex: 9999,
            background: 'rgba(10,10,10,0.96)', border: `1px solid ${D.blue}`,
            borderRadius: 8, padding: '10px 14px', width: 380,
            fontFamily: 'ui-monospace, monospace', fontSize: 11,
            boxShadow: '0 4px 24px rgba(0,0,0,0.7)',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: D.blue, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{'\u2b1b'} Source Tab Debug</span>
              <span style={{ fontSize: 9, color: D.muted }}>Shift+D to close</span>
            </div>

            {/* Ref status */}
            <div style={{ background: D.card, borderRadius: 5, padding: '6px 8px', marginBottom: 7 }}>
              <div style={{ display: 'flex', gap: 16, marginBottom: 3 }}>
                <span style={{ color: D.muted }}>enabled:</span>
                <span style={{ color: sourceEnabled ? D.green : D.muted }}>{sourceEnabled ? '\u2713 on' : '\u2717 off'}</span>
                <span style={{ color: D.muted }}>ref:</span>
                <span style={{ color: refExists ? D.green : D.red }}>{refExists ? '\u2713 exists' : '\u2717 null'}</span>
                <span style={{ color: D.muted }}>tab:</span>
                <span style={{ color: refOpen ? D.green : D.red }}>{!refExists ? 'n/a' : refOpen ? '\u2713 open' : '\u2717 closed'}</span>
              </div>
              <div style={{ color: D.muted, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                url: <span style={{ color: D.text }}>{currentUrl.length > 55 ? currentUrl.slice(0, 55) + '…' : currentUrl}</span>
              </div>
            </div>

            {/* Action log */}
            <div>
              <p style={{ fontSize: 9, fontWeight: 700, color: D.muted, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 4px' }}>Action Log</p>
              {sourceLog.length === 0
                ? <p style={{ color: D.faint, fontSize: 10, margin: 0 }}>No actions yet — navigate a slide or click Source</p>
                : [...sourceLog].reverse().map((entry, i) => (
                  <div key={i} style={{
                    display: 'flex', gap: 7, marginBottom: 3,
                    opacity: i === 0 ? 1 : 0.55 + (0.15 * (sourceLog.length - 1 - i)),
                  }}>
                    <span style={{ color: D.faint, flexShrink: 0 }}>{entry.time}</span>
                    <span style={{
                      color: entry.type === 'error' ? D.red : entry.type === 'warn' ? D.orange : D.green,
                      flexShrink: 0, fontSize: 10,
                    }}>
                      {entry.type === 'error' ? '✗' : entry.type === 'warn' ? '⚠' : '✓'}
                    </span>
                    <span style={{ color: entry.type === 'error' ? '#fca5a5' : entry.type === 'warn' ? '#fdba74' : D.text, lineHeight: 1.4 }}>
                      {entry.msg}
                    </span>
                  </div>
                ))
              }
            </div>

            {/* Clear button */}
            {sourceLog.length > 0 && (
              <button
                onClick={() => setSourceLog([])}
                style={{ marginTop: 6, fontSize: 9, color: D.muted, background: 'none', border: `1px solid ${D.faint}`, borderRadius: 3, padding: '1px 7px', cursor: 'pointer' }}
              >
                clear log
              </button>
            )}
          </div>
        );
      })()}

      <AlertDialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End the stream?</AlertDialogTitle>
            <AlertDialogDescription>This will archive session stats and end the presentation.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doEndStream}>End stream</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
