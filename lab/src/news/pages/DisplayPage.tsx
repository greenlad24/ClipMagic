import { useNewsTheme } from '../useNewsTheme';
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../auth';
import { GetSlidesOutputType } from '../api';
import StoryShow from '../daily/stage/StoryShow';
import { useDeckTemplate } from '../daily/stage/deckTemplate';
import { newsTemplateFor } from '../daily/stage/newsTemplates';
import { bubbleKey, useBubbleSettings } from '../deepdive/bubble';
import VideoEmbed from '../components/VideoEmbed';
import { slideMedia } from '../api';

type SlideType = GetSlidesOutputType['slides'][0];

type BCMsg =
  | { type: 'slide'; slide: SlideType; idx: number; total: number; media?: 'article' | 'video'; beat?: number }
  | { type: 'media'; idx: number; view: 'article' | 'video' }
  | { type: 'beat'; idx: number; beat: number }
  | { type: 'blackout'; value: boolean }
  | { type: 'end' }
  | { type: 'ping' }
  | { type: 'pong' };

const CHANNEL = 'ng-presenter';
const BG_KEY = 'ng-audience-bg';

export default function DisplayPage() {
  useNewsTheme();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();
  const [slide, setSlide] = useState<SlideType | null>(null);
  const [idx, setIdx] = useState(0);
  // The story's beat (cover, then each micro-interaction), from the presenter.
  const [beat, setBeat] = useState(0);
  const [blackout, setBlackout] = useState(false);
  const [ended, setEnded] = useState(false);
  // Article, then (on a slide that has one) the official video — driven by the presenter.
  const [mediaView, setMediaView] = useState<'article' | 'video'>('article');
  const idxRef = useRef(0);
  const [bgColor] = useState(() => localStorage.getItem(BG_KEY) || '#ffffff');
  const channelRef = useRef<BroadcastChannel | null>(null);
  // The deck's design (an AI News template, picked on the dashboard; live).
  const deckTemplate = useDeckTemplate(slide?.deck ?? null);
  // The camera-bubble safe frame (deepdive/bubble.tsx) — B / C / G on this screen.
  const [bubble, setBubble] = useBubbleSettings();
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) bubbleKey(e, bubbleRef.current, setBubble); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setBubble]);

  useEffect(() => {
    if (!authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [authLoading, user, loginWithRedirect]);

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL);
    channelRef.current = ch;

    ch.onmessage = (e) => {
      const msg: BCMsg = e.data;
      if (msg.type === 'ping') {
        ch.postMessage({ type: 'pong' } satisfies BCMsg);
      } else if (msg.type === 'slide') {
        setSlide(msg.slide);
        setIdx(msg.idx);
        idxRef.current = msg.idx;
        setBeat(typeof msg.beat === 'number' ? msg.beat : 0);
        setBlackout(false);
        setMediaView(msg.media === 'video' ? 'video' : 'article');
      } else if (msg.type === 'beat') {
        if (msg.idx === idxRef.current) setBeat(msg.beat);
      } else if (msg.type === 'media') {
        if (msg.idx === idxRef.current) setMediaView(msg.view === 'video' ? 'video' : 'article');
      } else if (msg.type === 'blackout') {
        setBlackout(msg.value);
      } else if (msg.type === 'end') {
        setEnded(true);
      }
    };

    return () => ch.close();
  }, []);

  const isDark = bgColor !== '#ffffff' && bgColor !== '#f5f5f0' && bgColor !== '#fafafa';
  const textColor = isDark ? '#eee' : '#111';
  const subColor = isDark ? '#aaa' : '#666';

  if (authLoading || !user) {
    return <div className="fixed inset-0" style={{ backgroundColor: bgColor }} />;
  }

  if (ended) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: bgColor }}>
        <p className="text-2xl font-semibold" style={{ color: textColor }}>End of today's news</p>
      </div>
    );
  }

  if (blackout) return <div className="fixed inset-0 bg-black" />;

  if (!slide) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3" style={{ backgroundColor: bgColor }}>
        <p className="text-lg font-medium" style={{ color: textColor }}>Waiting for presenter…</p>
        <p className="text-sm" style={{ color: subColor }}>Keep this tab open. Content will appear when the presenter advances slides.</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ backgroundColor: '#000' }}>
      {/* The story: source → info slides, beat by beat (daily/stage); Shift = its video. */}
      <StoryShow slide={slide} beat={beat} number={idx + 1} template={newsTemplateFor(deckTemplate)} bubble={bubble} bubbleLayer />

      {/* The story's video: loaded behind the story, full screen on Shift over ANY beat (it is not a beat). */}
      {(() => {
        const m = slideMedia(slide);
        return m ? <VideoEmbed key={m.key} media={m} active={mediaView === 'video'} /> : null;
      })()}
    </div>
  );
}
