import { useNewsTheme } from '../useNewsTheme';
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../auth';
import { GetSlidesOutputType } from '../api';
import TweetView from '../components/TweetView';
import ArticleView from '../components/ArticleView';

type SlideType = GetSlidesOutputType['slides'][0];

type BCMsg =
  | { type: 'slide'; slide: SlideType; idx: number; total: number }
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
  const [total, setTotal] = useState(0);
  const [blackout, setBlackout] = useState(false);
  const [ended, setEnded] = useState(false);
  const [bgColor] = useState(() => localStorage.getItem(BG_KEY) || '#ffffff');
  const channelRef = useRef<BroadcastChannel | null>(null);

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
        setTotal(msg.total);
        setBlackout(false);
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

  const isTweet = slide.bestSourceType?.toLowerCase() === 'tweet';
  const content = (slide.fullContentHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const sourceHost = slide.bestSourceUrl
    ? (() => { try { return new URL(slide.bestSourceUrl).hostname.replace('www.', ''); } catch { return ''; } })()
    : '';

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ backgroundColor: bgColor }}>
      {/* Source bar */}
      <div
        className="flex items-center gap-3 px-10 py-4"
        style={{ borderBottom: '1px solid rgba(128,128,128,0.15)' }}
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: 'rgba(128,128,128,0.15)', color: subColor }}
        >
          {(slide.bestSourceName || '?').charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <span className="text-sm font-semibold" style={{ color: textColor }}>{slide.bestSourceName}</span>
          {sourceHost && (
            <span className="text-xs ml-2" style={{ color: subColor }}>via {sourceHost}</span>
          )}
        </div>
        {/* Slide counter — unobtrusive */}
        <div className="ml-auto flex items-center gap-3">
          {total > 0 && (
            <span className="text-xs tabular-nums" style={{ color: subColor }}>{idx + 1} / {total}</span>
          )}
          {slide.bestSourceUrl && (
            <a
              href={slide.bestSourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs"
              style={{ color: '#60a5fa' }}
            >
              Open source ↗
            </a>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="absolute left-0 right-0 bottom-0 overflow-y-auto" style={{ top: '4rem' }}>
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
    </div>
  );
}
