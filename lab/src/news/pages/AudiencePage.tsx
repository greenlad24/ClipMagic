import { useNewsTheme } from '../useNewsTheme';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../auth';
import { getSession, getSlides, GetSlidesOutputType } from '../api';
import VideoEmbed from '../components/VideoEmbed';
import { slideMedia } from '../api';
import { connectLiveSync, type LiveSync } from '../liveSync';
import StoryShow from '../daily/stage/StoryShow';
import { useDeckTemplate } from '../daily/stage/deckTemplate';
import { newsTemplateFor } from '../daily/stage/newsTemplates';
import { bubbleKey, useBubbleSettings } from '../deepdive/bubble';

type SlideType = GetSlidesOutputType['slides'][0];

const BG_KEY = 'ng-audience-bg';

export default function AudiencePage() {
  useNewsTheme();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();
  const [slides, setSlides] = useState<SlideType[]>([]);
  const [deckId, setDeckId] = useState<string | null>(null);
  // The deck's design (an AI News template, picked on the dashboard; live).
  const [deckTpl0, setDeckTpl0] = useState('');
  const deckTemplate = useDeckTemplate(deckId, deckTpl0);
  // The camera-bubble safe frame (deepdive/bubble.tsx) — B / C / G on this screen.
  const [bubble, setBubble] = useBubbleSettings();
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) bubbleKey(e, bubbleRef.current, setBubble); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setBubble]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [blackout, setBlackout] = useState(false);
  const [ended, setEnded] = useState(false);
  const [ready, setReady] = useState(false);
  const [bgColor, setBgColor] = useState(() => localStorage.getItem(BG_KEY) || '#ffffff');
  // Article, then (on a slide that has one) the official video — from the live session.
  const [mediaView, setMediaView] = useState<'article' | 'video'>('article');
  // A same-browser presenter message is newer than any poll still in flight.
  const lastBcMediaRef = useRef(0);
  // The story's beat (cover, then each micro-interaction) — kept with its
  // slide index so a beat never lands on the wrong story. From the presenter's
  // BroadcastChannel (same browser), the live socket, and the 300ms poll.
  const [beatAt, setBeatAt] = useState<{ idx: number; beat: number }>({ idx: 0, beat: 0 });
  const lastPushBeatRef = useRef(0);
  const syncRef = useRef<LiveSync | null>(null);
  const syncSessionRef = useRef('');
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const prevIdxRef = useRef(0);

  useEffect(() => {
    if (!authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [authLoading, user, loginWithRedirect]);

  // Listen for bg color changes from settings
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === BG_KEY && e.newValue) setBgColor(e.newValue);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // BroadcastChannel — instant updates when presenter is in the same browser
  useEffect(() => {
    const ch = new BroadcastChannel('ng-presenter');
    ch.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'slide') {
        const idx = msg.idx as number;
        if (idx !== prevIdxRef.current) {
          prevIdxRef.current = idx;
          setCurrentIdx(idx);
        }
        lastPushBeatRef.current = Date.now();
        setBeatAt({ idx, beat: typeof msg.beat === 'number' ? msg.beat : 0 });
        setMediaView(msg.media === 'video' ? 'video' : 'article');
      } else if (msg.type === 'beat') {
        lastPushBeatRef.current = Date.now();
        setBeatAt({ idx: msg.idx, beat: msg.beat });
      } else if (msg.type === 'media') {
        if (msg.idx === prevIdxRef.current) { lastBcMediaRef.current = Date.now(); setMediaView(msg.view === 'video' ? 'video' : 'article'); }
      } else if (msg.type === 'blackout') {
        setBlackout(!!msg.value);
      } else if (msg.type === 'end') {
        setEnded(true);
      }
    };
    return () => ch.close();
  }, []);

  // Load today's deck slides once — only after auth confirmed
  useEffect(() => {
    if (!user) return;
    const load = async () => {
      try {
        // ?deck=<id> (opened from the presenter): that deck — "today's" is empty after Bangkok midnight.
        const deckParam = new URLSearchParams(window.location.search).get('deck');
        const data = await getSlides(deckParam ? { deckId: deckParam } : {});
        if (data.deck && data.slides.length > 0) {
          setSlides(data.slides);
          setDeckId(data.deck.id);
          setDeckTpl0(data.deck.template ?? '');
        }
      } finally { setReady(true); }
    };
    load();
  }, [user]);

  // Poll session every 300ms
  const poll = useCallback(async () => {
    try {
      const { session } = await getSession({ deckId: deckId || undefined });
      if (!session) return;
      if (session.endedAt) { setEnded(true); clearInterval(pollRef.current); return; }
      setBlackout(!!session.blackout);
      // The live socket for this session: beats and the video arrive the
      // moment the presenter presses, not on the next poll.
      if (session.id && syncSessionRef.current !== session.id) {
        syncRef.current?.close();
        syncSessionRef.current = session.id;
        const sync = connectLiveSync(session.id);
        syncRef.current = sync;
        sync.onBeat((b) => {
          if (typeof b.idx !== 'number' || typeof b.beat !== 'number') return;
          lastPushBeatRef.current = Date.now();
          setBeatAt({ idx: b.idx, beat: b.beat });
          if (b.idx !== prevIdxRef.current) { prevIdxRef.current = b.idx; setCurrentIdx(b.idx); }
        });
        sync.onMedia((m) => {
          if (m.idx !== prevIdxRef.current) return;
          lastBcMediaRef.current = Date.now();
          setMediaView(m.media === 'video' ? 'video' : 'article');
        });
      }
      const idx = session.currentSlideIndex ?? 0;
      const fresh = Date.now() - lastPushBeatRef.current > 1500;
      if (idx !== prevIdxRef.current && fresh) {
        prevIdxRef.current = idx;
        setCurrentIdx(idx);
      }
      if (fresh) {
        const b = typeof session.currentBeat === 'number' ? Math.max(0, Math.round(session.currentBeat)) : 0;
        setBeatAt((p) => (p.idx === idx && p.beat === b ? p : { idx, beat: b }));
      }
      if (Date.now() - lastBcMediaRef.current > 1500) setMediaView(session.mediaView === 'video' ? 'video' : 'article');
    } catch {}
  }, [deckId]);

  useEffect(() => {
    if (!ready) return;
    poll();
    pollRef.current = setInterval(poll, 300);
    return () => clearInterval(pollRef.current);
  }, [ready, poll]);

  useEffect(() => () => { syncRef.current?.close(); syncRef.current = null; }, []);

  // This screen is on camera: hide a resting cursor.
  const [cursorHidden, setCursorHidden] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const move = () => { setCursorHidden(false); clearTimeout(t); t = setTimeout(() => setCursorHidden(true), 2000); };
    move();
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mousemove', move); clearTimeout(t); };
  }, []);

  if (ended) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: bgColor }}>
        <p className="text-2xl font-semibold" style={{ color: bgColor === '#ffffff' || bgColor === '#f5f5f0' ? '#111' : '#fff' }}>
          End of today's news
        </p>
      </div>
    );
  }

  if (blackout) {
    return <div className="fixed inset-0 bg-black" />;
  }

  if (authLoading || !user || !ready) return <div className="fixed inset-0" style={{ backgroundColor: bgColor }} />;

  const slide = slides[currentIdx];
  if (!slide) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: bgColor }}>
        <p className="text-lg text-muted-foreground">Waiting for stream to start…</p>
      </div>
    );
  }

  // The story: source → info slides, beat by beat (daily/stage); Shift = its video.
  const beat = beatAt.idx === currentIdx ? beatAt.beat : 0;

  return (
    <div className="fixed inset-0 overflow-hidden select-none" style={{ backgroundColor: '#000', cursor: cursorHidden ? 'none' : 'default' }}>
      <StoryShow slide={slide} beat={beat} number={currentIdx + 1} template={newsTemplateFor(deckTemplate)} bubble={bubble} bubbleLayer />

      {/* The story's video: loaded behind the story, full screen on Shift over ANY beat (it is not a beat). */}
      {(() => {
        const m = slideMedia(slide);
        return m ? <VideoEmbed key={m.key} media={m} active={mediaView === 'video'} /> : null;
      })()}
    </div>
  );
}
