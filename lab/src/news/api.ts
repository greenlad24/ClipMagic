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
  /** Design template id (deepdive/templates.ts); empty/unset = Jake's brand. */
  template?: string;
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
  /** YouTube id when the slide's video is on YouTube. Use `slideMedia()` rather than reading these directly. */
  videoId?: string;
  /** "youtube" | "vimeo" | "file" — unset = no video. */
  videoKind?: string;
  /** Vimeo player URL (with its hash) or the direct file URL. */
  videoUrl?: string;
  /** "official" (the launch video for this news) | "product" (the company's own demo of the product) | "manual". */
  videoTier?: string;
  /** File whose host blocks hotlinking — played through the Lab's proxy. */
  videoProxy?: boolean;
  videoTitle?: string;
  videoChannel?: string;
  /** Why this video, or why none. */
  videoReason?: string;
  videoCheckedAt?: string;
  /** The story's on-screen stage as JSON (server stage.ts) — read it with `daily/stage/story.ts`. Unset on older decks. */
  stageJson?: string;
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
  /** What the audience screen shows for the current slide. Unset = 'article'. */
  mediaView?: string;
  /** Beat of the current story on the audience screen (0 = its cover). */
  currentBeat?: number;
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
  mediaView?: 'article' | 'video';
  currentBeat?: number;
}

export async function call<T>(fn: string, input: unknown): Promise<T> {
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

export function streamingCall<R>(fn: string, input: unknown): ProgressStream<R> {
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
/** The deck's design template (the Deep Dive's templates; '' = Jake's brand). No deckId = today's deck. */
export const getDeckTemplate = (input: { deckId?: string }) => call<{ deckId: string | null; template: string }>('getDeckTemplate', input);
export const setDeckTemplate = (input: { deckId?: string; template: string }) => call<{ deckId: string; template: string }>('setDeckTemplate', input);
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

/** Official release video: re-run the search for one slide / a whole deck, or set/clear it by hand. */
export interface VideoCandidate { key: string; kind: string; tier: string; title: string; channel: string; seconds: number; publishedAt: string; source: string }
export const findSlideVideo = (input: { slideId: string }) =>
  call<{ slide: Slide; videoId: string | null; kind: string | null; tier: string | null; reason: string; checked: boolean; candidates: VideoCandidate[]; quotaUnits: number }>('findSlideVideo', input);
export const findDeckVideos = (input: { deckId?: string }) =>
  call<{ found: number; checked: number; units: number }>('findDeckVideos', input);
/** `videoId`: a YouTube id/link, a Vimeo link or a direct .mp4/.webm link; null removes the video. */
export const setSlideVideo = (input: { slideId: string; videoId: string | null }) =>
  call<{ success: boolean; slide: Slide }>('setSlideVideo', input);

/** Make the on-screen stage for slides that have none (older decks); `force` redoes all. Scripts are untouched. */
export const buildSlideStages = (input: { deckId?: string; force?: boolean }) =>
  call<{ built: number; failed: number; skipped: number }>('buildSlideStages', input);

/** YouTube embed for the audience screens: muted, looping, autoplay, as little chrome as YouTube allows. */
export function youtubeEmbedUrl(videoId: string, opts: { autoplay?: boolean; jsApi?: boolean } = {}): string {
  const q = new URLSearchParams({
    autoplay: opts.autoplay === false ? '0' : '1',
    mute: '1',
    controls: '0',
    loop: '1',
    playlist: videoId, // loop=1 only loops a playlist; a one-video playlist is the documented way
    modestbranding: '1',
    rel: '0',
    playsinline: '1',
    iv_load_policy: '3',
    cc_load_policy: '0', // no captions (Jake); VideoEmbed also unloads the captions module
    disablekb: '1',
    fs: '0',
  });
  if (opts.jsApi) { q.set('enablejsapi', '1'); q.set('origin', window.location.origin); }
  return `https://www.youtube-nocookie.com/embed/${videoId}?${q}`;
}

/** Vimeo's background player: autoplay, muted, looping, no controls or title. */
export function vimeoBackgroundUrl(playerUrl: string): string {
  const u = new URL(playerUrl);
  for (const [k, v] of Object.entries({ background: '1', autoplay: '1', loop: '1', muted: '1', autopause: '0', dnt: '1' })) u.searchParams.set(k, v);
  return u.toString();
}

/** What a slide's second screen plays, whatever kind it is — or null when the slide has no video. */
export interface SlideMedia { kind: 'youtube' | 'vimeo' | 'file'; key: string; src: string }
export function slideMedia(s: Slide | null | undefined): SlideMedia | null {
  if (!s) return null;
  const kind = s.videoKind || (s.videoId ? 'youtube' : '');
  if (kind === 'youtube' && s.videoId) return { kind, key: `yt:${s.videoId}`, src: youtubeEmbedUrl(s.videoId) };
  if (kind === 'vimeo' && s.videoUrl) return { kind, key: `vimeo:${s.videoUrl}`, src: vimeoBackgroundUrl(s.videoUrl) };
  if (kind === 'file' && s.videoUrl) return { kind, key: `file:${s.videoUrl}`, src: s.videoProxy ? `${window.location.origin}/api/news/video-file/${encodeURIComponent(s.id)}` : s.videoUrl };
  return null;
}
export const slideHasVideo = (s: Slide | null | undefined): boolean => slideMedia(s) !== null;

/** What the show is wired to right now, read from the server (presence only). */
export interface NewsConnection { name: string; configured: boolean; detail: string }
export const getConnections = () => call<{ connections: NewsConnection[] }>('getConnections', {});
