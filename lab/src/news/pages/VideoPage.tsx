/**
 * The story video on its own page — where the presenter's SOURCE TAB goes when
 * the slide switches from the article to the video (Jake 2026-10-01: "the video
 * should auto play on full screen"). The tab used to be sent to the raw video
 * URL: a bare file opened in the browser's own viewer (paused, letterboxed,
 * with controls) and a bare embed page did the same. This page instead fills
 * the whole window, black, muted, looping, no controls, and starts on its own.
 *
 * Query: ?kind=youtube|vimeo|file&key=<media key>&src=<url>
 */
import { useEffect, useMemo } from 'react';
import VideoEmbed from '../components/VideoEmbed';
import type { SlideMedia } from '../api';

/** Link for the source tab to show this slide's video full window. */
export function videoPageUrl(m: SlideMedia): string {
  const q = new URLSearchParams({ kind: m.kind, key: m.key, src: m.src });
  return `${window.location.origin}/news-gatherer/present/video?${q.toString()}`;
}

export default function VideoPage() {
  const media = useMemo<SlideMedia | null>(() => {
    const q = new URLSearchParams(window.location.search);
    const kind = q.get('kind');
    const key = q.get('key') || '';
    const src = q.get('src') || '';
    if ((kind !== 'youtube' && kind !== 'vimeo' && kind !== 'file') || !src) return null;
    return { kind, key: key || `${kind}:${src}`, src };
  }, []);

  useEffect(() => {
    const prev = { bg: document.body.style.background, overflow: document.body.style.overflow };
    document.body.style.background = '#000';
    document.body.style.overflow = 'hidden';
    document.title = 'Story video';
    return () => { document.body.style.background = prev.bg; document.body.style.overflow = prev.overflow; };
  }, []);

  // A click (or F) puts the tab into true full screen; Esc leaves it.
  useEffect(() => {
    const go = () => { if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {}); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'f' || e.key === 'F') go(); };
    window.addEventListener('click', go);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', go); window.removeEventListener('keydown', onKey); };
  }, []);

  if (!media) return <div style={{ position: 'fixed', inset: 0, background: '#000' }} />;
  return <VideoEmbed media={media} active />;
}
