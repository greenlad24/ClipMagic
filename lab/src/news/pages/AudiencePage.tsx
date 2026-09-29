import { useNewsTheme } from '../useNewsTheme';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../auth';
import { getSession, getSlides, GetSlidesOutputType } from '../api';
import TweetView from '../components/TweetView';
import ArticleView from '../components/ArticleView';

type SlideType = GetSlidesOutputType['slides'][0];

const BG_KEY = 'ng-audience-bg';

export default function AudiencePage() {
  useNewsTheme();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();
  const [slides, setSlides] = useState<SlideType[]>([]);
  const [deckId, setDeckId] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [blackout, setBlackout] = useState(false);
  const [ended, setEnded] = useState(false);
  const [ready, setReady] = useState(false);
  const [bgColor, setBgColor] = useState(() => localStorage.getItem(BG_KEY) || '#ffffff');
  const [scrollPct, setScrollPct] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
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
          setScrollPct(0);
          contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        }
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
        const data = await getSlides({});
        if (data.deck && data.slides.length > 0) {
          setSlides(data.slides);
          setDeckId(data.deck.id);
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
      const idx = session.currentSlideIndex ?? 0;
      if (idx !== prevIdxRef.current) {
        prevIdxRef.current = idx;
        setCurrentIdx(idx);
        setScrollPct(0);
        contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch {}
  }, [deckId]);

  useEffect(() => {
    if (!ready) return;
    poll();
    pollRef.current = setInterval(poll, 300);
    return () => clearInterval(pollRef.current);
  }, [ready, poll]);

  // Track scroll progress
  const handleScroll = () => {
    const el = contentRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollPct(max > 0 ? el.scrollTop / max : 0);
  };

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

  const isTweet = slide.bestSourceType?.toLowerCase() === 'tweet';
  const content = (slide.fullContentHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ backgroundColor: bgColor }}>
      {/* Source bar — minimal */}
      <div className="px-10 py-4 flex items-center gap-3" style={{ borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-bold text-muted-foreground">
          {(slide.bestSourceName || '?').charAt(0).toUpperCase()}
        </div>
        <div>
          <span className="text-sm font-semibold" style={{ color: bgColor === '#ffffff' || bgColor === '#f5f5f0' ? '#111' : '#eee' }}>
            {slide.bestSourceName}
          </span>
          <span className="text-xs ml-2" style={{ color: bgColor === '#ffffff' || bgColor === '#f5f5f0' ? '#666' : '#aaa' }}>
            via {isTweet ? 'Twitter/X' : slide.bestSourceName}
          </span>
        </div>
      </div>

      {/* Content area */}
      <div
        ref={contentRef}
        className="absolute top-16 bottom-0 left-0 right-2 overflow-y-auto"
        onScroll={handleScroll}
        style={{ paddingBottom: '2rem' }}
      >
        <div className="flex justify-center px-10 py-10">
          {isTweet ? (
            <TweetView
              sourceName={slide.bestSourceName || ''}
              sourceHandle={slide.bestSourceHandle}
              publishedAt={slide.publishedAt}
              content={content}
              heroImageUrl={slide.heroImageUrl}
              large
            />
          ) : (
            <ArticleView
              sourceName={slide.bestSourceName || ''}
              sourceUrl={slide.bestSourceUrl}
              publishedAt={slide.publishedAt}
              topicLabel={slide.topicLabel || ''}
              content={content}
              heroImageUrl={slide.heroImageUrl}
              large
            />
          )}
        </div>
      </div>

      {/* Scroll progress — right edge */}
      <div className="absolute top-16 right-0 bottom-0 w-1.5" style={{ backgroundColor: 'rgba(128,128,128,0.15)' }}>
        <div
          className="w-full rounded-full transition-all duration-200"
          style={{ height: `${scrollPct * 100}%`, backgroundColor: 'rgba(128,128,128,0.5)' }}
        />
      </div>
    </div>
  );
}
