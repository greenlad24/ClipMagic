/**
 * A story's video, full screen on the audience screens (Display + Audience):
 * muted, looping, no controls, black behind it. Three kinds:
 *   youtube — the nocookie embed (controls=0, loop via playlist=<id>)
 *   vimeo   — Vimeo's background player (?background=1)
 *   file    — a <video autoplay muted loop playsinline>, object-fit cover
 *
 * It is mounted for every slide that HAS a video — hidden while the article is
 * up — so switching to it is instant instead of a black frame while it loads.
 * On reveal it restarts from the top and plays; on hide it pauses (YouTube and
 * Vimeo through their postMessage APIs, a file directly).
 *
 * "Cover" sizing: the 16:9 player is scaled to fill the viewport and cropped
 * at the edges rather than letterboxed, and pointer events are off so a stray
 * mouse never brings up a player's hover chrome.
 */
import { useEffect, useMemo, useRef } from 'react';
import { youtubeEmbedUrl, type SlideMedia } from '../api';

const COVER: React.CSSProperties = {
  position: 'absolute', top: '50%', left: '50%', border: 0, pointerEvents: 'none',
  width: 'max(100vw, 177.78vh)', height: 'max(100vh, 56.25vw)',
  transform: 'translate(-50%, -50%)',
};

export default function VideoEmbed({ media, active }: { media: SlideMedia; active: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Autoplay only if it is on screen the moment it mounts (a screen joining
  // mid-video). Otherwise it waits, loaded, for the reveal.
  const initialActive = useRef(active);
  const activeRef = useRef(active);
  activeRef.current = active;

  const src = useMemo(() => {
    if (media.kind === 'youtube') {
      const id = media.key.slice(3);
      return youtubeEmbedUrl(id, { autoplay: initialActive.current, jsApi: true });
    }
    return media.src;
  }, [media.key, media.kind, media.src]);

  const command = (play: boolean, restart: boolean) => {
    if (media.kind === 'file') {
      const v = videoRef.current;
      if (!v) return;
      if (play) { if (restart) v.currentTime = 0; void v.play().catch(() => {}); } else v.pause();
      return;
    }
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    if (media.kind === 'youtube') {
      const cmd = (func: string, args: unknown[] = []) => win.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
      // Jake: no YouTube subtitles. A muted embed turns captions on by itself and
      // cc_load_policy=0 alone does not always win, so unload the captions module
      // on load (the re-assert timers below) and on every reveal/play.
      cmd('unloadModule', ['captions']);
      cmd('unloadModule', ['cc']);
      if (play) { if (restart) cmd('seekTo', [0, true]); cmd('playVideo'); } else cmd('pauseVideo');
    } else {
      const cmd = (method: string, value?: unknown) => win.postMessage(JSON.stringify(value === undefined ? { method } : { method, value }), 'https://player.vimeo.com');
      if (play) { if (restart) cmd('setCurrentTime', 0); cmd('play'); } else cmd('pause');
    }
  };

  useEffect(() => { command(active, true); }, [active, media.key]);

  // A command sent before an embedded player has initialised is dropped
  // silently, so re-assert the current state a few times after it loads.
  const onFrameLoad = () => {
    for (const ms of [300, 1000, 2500]) setTimeout(() => command(activeRef.current, false), ms);
  };

  return (
    <div
      aria-hidden={!active}
      data-news-video={media.key}
      data-kind={media.kind}
      data-active={active ? '1' : '0'}
      style={{
        position: 'fixed', inset: 0, background: '#000', overflow: 'hidden', zIndex: 50,
        visibility: active ? 'visible' : 'hidden',
      }}
    >
      {media.kind === 'file' ? (
        <video
          ref={videoRef}
          src={src}
          muted
          loop
          playsInline
          autoPlay={initialActive.current}
          preload="auto"
          // <video> has no per-element referrer policy, so a CDN that refuses
          // the Lab as Referer was already routed through the Lab's proxy when
          // the video was found (see server video.ts probeFile) — `src` says so.
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000', pointerEvents: 'none' }}
        />
      ) : (
        <iframe
          ref={frameRef}
          src={src}
          title="Story video"
          onLoad={onFrameLoad}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          // ⚠️ The Lab sends "Referrer-Policy: no-referrer" on every page, and YouTube
          // refuses an embed with no Referer ("Error 153 — video player configuration
          // error"). Send just the origin, for this player only.
          referrerPolicy="strict-origin-when-cross-origin"
          style={COVER}
        />
      )}
    </div>
  );
}
