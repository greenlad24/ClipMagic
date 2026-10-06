/**
 * Deep Dive — client for its server functions (see server/src/news/deepDive.ts).
 */
import { call, streamingCall, youtubeEmbedUrl, vimeoBackgroundUrl, type SlideMedia } from '../api';

export type SectionKind =
  | 'title' | 'statement' | 'stats' | 'bullets' | 'timeline'
  | 'compare' | 'bars' | 'quote' | 'media' | 'takeaways';

export interface Stat { value: number | null; display: string; prefix: string; suffix: string; decimals: number; label: string }
export interface TimelineEvent { date: string; label: string; detail: string }
export interface CompareRow { label: string; values: string[] }
export interface Bar { label: string; value: number; display: string }

/** The on-screen content of a section, by kind (normalised by the server). */
export interface SectionData {
  subtitle?: string;
  kicker?: string;
  text?: string;
  highlight?: string[];
  stats?: Stat[];
  points?: string[];
  events?: TimelineEvent[];
  columns?: string[];
  rows?: CompareRow[];
  winner?: number | null;
  unit?: string;
  bars?: Bar[];
  quote?: string;
  who?: string;
  role?: string;
  caption?: string;
  videoQuery?: string;
  source?: { outlet: string; title: string; url: string };
}

/** A real screenshot / GIF / video file / moment of the company's video, gathered in research. */
export interface Visual {
  id: string;
  kind: 'image' | 'gif' | 'video' | 'clip';
  /** Served URL of the stored file (image/gif/video); "" for a clip. */
  src: string;
  videoId?: string;
  start?: number;
  width?: number;
  height?: number;
  description: string;
  credit: string;
  sourceUrl: string;
}

/** Kinds whose layout has no room for a visual beside it (mirrors the server). */
export const NO_VISUAL = new Set<SectionKind>(['title', 'takeaways', 'media', 'compare', 'timeline']);

/** A still for a visual: the file itself, or the clip's YouTube frame. */
export const visualStill = (v: Visual): string =>
  v.kind === 'clip' ? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg` : v.src;

export interface Section {
  id: string;
  position: number;
  kind: SectionKind;
  eyebrow: string;
  heading: string;
  data: SectionData;
  script: string;
  videoId: string | null;
  videoKind: string | null;
  videoUrl: string | null;
  videoTitle: string;
  videoChannel: string;
  videoReason: string;
  visual: Visual | null;
}

export type DeepDiveStatus = 'draft' | 'generating' | 'ready' | 'error';

export interface DeepDiveSource { title: string; url: string; outlet: string; official?: boolean }

export interface DeepDive {
  id: string;
  topic: string;
  angle: string;
  storyId: string | null;
  title: string;
  subtitle: string;
  status: DeepDiveStatus;
  progressMessage: string;
  progressPercent: number;
  error: string;
  sources: DeepDiveSource[];
  visuals: Visual[];
  generatedAt: string | null;
  updatedAt: string | null;
  createdAt: number;
  sectionCount?: number;
  /** 'v2' = the chapter show (Jake, 2026-10-02); absent/'v1' = the slide deck. */
  format?: 'v1' | 'v2';
  /** v2: run the demo agent on the real product while building. */
  demoAgent?: boolean;
  /** v2: the product URL the demo agent opens (optional). */
  demoUrl?: string;
  /** The design (templates.ts TemplateId); empty = the format's default look. */
  template?: string;
}

export const listDeepDives = () => call<{ deepDives: DeepDive[] }>('listDeepDives', {});
export interface DemoJobInfo { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; error: string | null; finishedAt: string | null }
export const getDeepDive = (id: string) =>
  call<{ deepDive: DeepDive; sections: Section[]; running: boolean; demoJob?: DemoJobInfo | null }>('getDeepDive', { id });
/** v2: what the editor's pickers choose from, and one edit to a chapter's material. */
export interface MediaChoices {
  video: { title: string; channel: string } | null;
  clips: { id: string; start: number; end: number; kind: string; score: number; description: string }[];
  blocks: { block: number; tag: string; text: string }[];
}
export const getDeepDiveMedia = (id: string) => call<MediaChoices>('getDeepDiveMedia', { id });
export type ChapterEdit =
  | { op: 'caption'; path: string; caption: string }
  | { op: 'swapClip'; index: number; clip: string }
  | { op: 'highlights'; items: { block: number; caption: string }[] };
export const editDeepDiveChapter = (sectionId: string, edit: ChapterEdit) => call<{ section: Section }>('editDeepDiveChapter', { sectionId, edit });
/** v2 demo agent. */
export const recordDeepDiveDemo = (id: string) => call<{ jobId: string }>('recordDeepDiveDemo', { id });
export const attachDeepDiveDemo = (id: string) => call<{ attached: boolean; reason?: string }>('attachDeepDiveDemo', { id });
export const startLiveDeepDiveDemo = (id: string) => call<{ jobId: string }>('startLiveDeepDiveDemo', { id });
export interface LiveDemoState { status: DemoJobInfo['status']; error: string | null; shot: string | null; click: [number, number] | null; caption: string; w: number; h: number; steps: number }
export const getLiveDeepDiveDemo = (jobId: string) => call<LiveDemoState>('getLiveDeepDiveDemo', { jobId });
export const createDeepDive = (input: { topic?: string; angle?: string; storyId?: string; format?: 'v1' | 'v2'; demoAgent?: boolean; demoUrl?: string; template?: string }) =>
  call<{ deepDive: DeepDive }>('createDeepDive', input);
export const updateDeepDive = (input: { id: string; title?: string; subtitle?: string; topic?: string; angle?: string; format?: 'v1' | 'v2'; demoAgent?: boolean; demoUrl?: string; template?: string }) =>
  call<{ success: boolean }>('updateDeepDive', input);
export const deleteDeepDive = (id: string) => call<{ success: boolean }>('deleteDeepDive', { id });
/** `fresh` = search the web again even if this topic was researched in the last 12 hours. */
export const generateDeepDive = (id: string, fresh = false) =>
  streamingCall<{ success: boolean; sections: number; message: string }>('generateDeepDive', { id, fresh });
export const updateSection = (input: { sectionId: string; heading?: string; eyebrow?: string; script?: string; data?: SectionData; visualId?: string }) =>
  call<{ section: Section }>('updateDeepDiveSection', input);
export const deleteSection = (sectionId: string) => call<{ success: boolean }>('deleteDeepDiveSection', { sectionId });
export const reorderSections = (sectionIds: string[]) => call<{ success: boolean }>('reorderDeepDiveSections', { sectionIds });
export const setSectionVideo = (sectionId: string, video: string | null) =>
  call<{ section: Section | null }>('setDeepDiveSectionVideo', { sectionId, video });

/** What a media section plays, in the shape `VideoEmbed` takes — or null. */
export function sectionMedia(s: Section | null | undefined): SlideMedia | null {
  if (!s) return null;
  const kind = s.videoKind || (s.videoId ? 'youtube' : '');
  if (kind === 'youtube' && s.videoId) return { kind, key: `yt:${s.videoId}`, src: youtubeEmbedUrl(s.videoId) };
  if (kind === 'vimeo' && s.videoUrl) return { kind, key: `vimeo:${s.videoUrl}`, src: vimeoBackgroundUrl(s.videoUrl) };
  if (kind === 'file' && s.videoUrl) return { kind, key: `file:${s.videoUrl}`, src: s.videoUrl };
  return null;
}

export const wordCount = (t: string): number => t.split(/\s+/).filter(Boolean).length;
/** Jake reads at about 150 words a minute. */
export const secondsFor = (t: string): number => Math.round((wordCount(t) / 150) * 60);

export function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export const KIND_LABEL: Record<SectionKind, string> = {
  title: 'Title', statement: 'Big statement', stats: 'Numbers', bullets: 'Key points', timeline: 'Timeline',
  compare: 'Comparison', bars: 'Bar chart', quote: 'Quote', media: 'Video', takeaways: 'Takeaways',
};

export const DEEP_DIVE_PATH = '/news-gatherer/deep-dive';
export const editorPath = (id: string) => `${DEEP_DIVE_PATH}/${id}`;
export const stagePath = (id: string, sessionId?: string) =>
  `${DEEP_DIVE_PATH}/${id}/present${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`;
export const presenterPath = (id: string) => `${DEEP_DIVE_PATH}/${id}/presenter`;
