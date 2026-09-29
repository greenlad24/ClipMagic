/**
 * AI News Stream — client for the app's server functions (/api/news/<fn>).
 *
 * `collectNews` and `buildDeckFromStories` stream their progress: iterate the
 * returned object for each progress chunk, then await `.result`.
 */

export interface BlogSource { company: string; url: string; title: string; isOfficial: boolean }
export interface ArticleSource { outlet: string; url: string; title: string }

export interface Story {
  id: string;
  headline: string;
  status: string;
  compositeScore: number;
  majorOutletCount: number;
  sourceCount: number;
  firstSeenAt: string;
  summary: string;
  hasOfficialBlog: boolean;
  blogSources: BlogSource[];
  articleSources: ArticleSource[];
  addedToDeck: boolean;
  deckDate: string;
  /** What kind of story: "Model release", "Robotics", "Drama & rumors"… Empty on stories collected before topics existed. */
  category: string;
}

export interface StoriesMeta {
  total: number;
  verified: number;
  likely: number;
  unconfirmed: number;
  addedToDeck: number;
  deckDate: string;
}

export interface GetStoriesOutputType { stories: Story[]; meta: StoriesMeta }

export interface Deck {
  id: string;
  deckDate?: string;
  totalSlides?: number;
  presentedAt?: string;
  totalDurationSeconds?: number;
}

export interface Slide {
  id: string;
  deck?: string;
  story?: string;
  topicLabel?: string;
  position?: number;
  sourcesCount?: number;
  bestSourceType?: string;
  bestSourceName?: string;
  bestSourceHandle?: string;
  bestSourceUrl?: string;
  publishedAt?: string;
  heroImageUrl?: string;
  fullContentHtml?: string;
  embedHtml?: string;
  allSourcesJson?: string;
  avgRelevanceScore?: number;
  whyItMatters?: string;
  keyPoints?: string;
  talkingAngle?: string;
  suggestedTimeSeconds?: number;
  teleprompterScript?: string;
  favorited?: boolean;
  deleted?: boolean;
  notesEditedAt?: string;
}

export interface GetSlidesOutputType { deck: Deck | null; slides: Slide[] }

export interface LiveSession {
  id: string;
  deck?: string;
  startedAt?: string;
  endedAt?: string;
  currentSlideIndex?: number;
  blackout?: boolean;
  tpRevision?: number;
  tpActorId?: string;
  tpScrollPct?: number;
  tpSpeed?: number;
  tpPaused?: boolean;
  tpUpdatedAt?: string;
  tpFontSize?: number;
  tpLineHeight?: number;
  tpWidth?: string;
  tpCountdown?: number;
  tpAutoscroll?: boolean;
  tpAnchorAt?: number;
  tpControllerId?: string;
}

export interface UpdateSessionInput {
  sessionId: string;
  deviceId?: string;
  currentSlideIndex?: number;
  blackout?: boolean;
  tpScrollPct?: number;
  tpSpeed?: number;
  tpPaused?: boolean;
  tpFontSize?: number;
  tpLineHeight?: number;
  tpWidth?: string;
  tpCountdown?: number;
  tpAutoscroll?: boolean;
  tpControllerId?: string;
}

async function call<T>(fn: string, input: unknown): Promise<T> {
  const res = await fetch(`/api/news/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input ?? {}),
    credentials: 'include',
  });
  if (res.status === 401) {
    window.location.href = '/auth/google';
    throw new Error('Sign-in required');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `${fn} failed (${res.status})`);
  return data as T;
}

/** A progress stream: `for await (const chunk of s)`, then `await s.result`. */
export interface ProgressStream<R> extends AsyncIterable<string> {
  result: Promise<R>;
}

function streamingCall<R>(fn: string, input: unknown): ProgressStream<R> {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let resolveResult!: (r: R) => void;
  let rejectResult!: (e: Error) => void;
  const result = new Promise<R>((res, rej) => { resolveResult = res; rejectResult = rej; });
  result.catch(() => {}); // surfaced through iteration too; never unhandled

  const push = (c: string) => { queue.push(c); wake?.(); };
  const finish = () => { finished = true; wake?.(); };

  (async () => {
    try {
      const res = await fetch(`/api/news/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input ?? {}),
        credentials: 'include',
      });
      if (res.status === 401) { window.location.href = '/auth/google'; throw new Error('Sign-in required'); }
      if (!res.ok || !res.body) throw new Error(`${fn} failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let settled = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (typeof msg.chunk === 'string') push(msg.chunk);
          else if ('result' in msg) { settled = true; resolveResult(msg.result as R); }
          else if ('error' in msg) { settled = true; throw new Error(String(msg.error)); }
        }
      }
      if (!settled) throw new Error(`${fn} ended without a result`);
    } catch (e) {
      rejectResult(e instanceof Error ? e : new Error(String(e)));
    } finally {
      finish();
    }
  })();

  return {
    result,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (finished) break;
        await new Promise<void>((r) => { wake = r; });
        wake = null;
      }
      await result; // rethrows a failure inside the caller's for-await
    },
  };
}

export const getStories = (input: { date?: string }) => call<GetStoriesOutputType>('getStories', input);
/** What the teleprompter opens with next show — the last show's settings, kept until changed. */
export const getTeleprompterSettings = (input: Record<string, never>) =>
  call<{ fontSize: number; lineHeight: number; width: string; speed: number }>('getTeleprompterSettings', input);
export const toggleStoryInDeck = (input: { storyId: string; addedToDeck: boolean }) =>
  call<{ success: boolean; storyId: string; addedToDeck: boolean }>('toggleStoryInDeck', input);
export const clearCache = (input: Record<string, never>) => call<{ success: boolean; cleared: number }>('clearCache', input);
export const collectNews = (input: Record<string, never>) =>
  streamingCall<{ success: boolean; storiesFound: number; message: string }>('collectNews', input);
export const buildDeckFromStories = (input: Record<string, never>) =>
  streamingCall<{ success: boolean; slidesCreated: number; deckId: string; message: string }>('buildDeckFromStories', input);
export const getSlides = (input: { deckId?: string }) => call<GetSlidesOutputType>('getSlides', input);
export const updateSlide = (input: {
  slideId: string;
  favorited?: boolean;
  deleted?: boolean;
  whyItMatters?: string;
  keyPoints?: string;
  talkingAngle?: string;
  suggestedTimeSeconds?: number;
  position?: number;
}) => call<{ success: boolean }>('updateSlide', input);
export const reorderSlides = (input: { slideIds: string[] }) => call<{ success: boolean }>('reorderSlides', input);
export const startSession = (input: { deckId: string; controllerId?: string }) =>
  call<{ sessionId: string; isNew: boolean; serverTime: number }>('startSession', input);
export const getSession = (input: { sessionId?: string; deckId?: string }) =>
  call<{ session: LiveSession | null; serverTime: number }>('getSession', input);
export const updateSession = (input: UpdateSessionInput) =>
  call<{ success: boolean; seq?: number; serverTime: number }>('updateSession', input);
export const endSession = (input: { sessionId: string; totalDurationSeconds: number }) =>
  call<{ success: boolean }>('endSession', input);
export const logSlideStats = (input: { sessionId: string; slideId: string; timeSpentSeconds: number; navigationOrder: number }) =>
  call<{ success: boolean }>('logSlideStats', input);

/** What the show is wired to right now, read from the server (presence only). */
export interface NewsConnection { name: string; configured: boolean; detail: string }
export const getConnections = () => call<{ connections: NewsConnection[] }>('getConnections', {});
