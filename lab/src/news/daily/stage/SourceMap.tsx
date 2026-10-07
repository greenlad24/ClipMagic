/**
 * The presenter's view of the SOURCE beat (Jake, 2026-10-07: "let me scroll my
 * self"): a small map of the captured page on the right edge of the presenter,
 * with the frame the show screens are showing right now. Wheel over it to
 * scroll the page on every show screen; click or drag on it to jump there.
 * Shift+↓ / Shift+↑ do the same from the keyboard (NotesPage). Only while the
 * story's source page is on screen.
 *
 * Drawn as an overlay (position: absolute) so it never changes the width of
 * the teleprompter column — the script must wrap exactly as on the follower.
 */
import { useEffect, useRef } from 'react';
import type { SourceShot } from './story';
import { SHOW_ASPECT, clampSrcY, srcWheelPx } from './sourceScroll';

const W = 112;

export default function SourceMap({ shot, y, onY }: { shot: SourceShot; y: number; onY: (y: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const yRef = useRef(y);
  yRef.current = y;
  const onYRef = useRef(onY);
  onYRef.current = onY;
  const mapH = Math.round((shot.h * W) / shot.w);
  const frame = (SHOW_ASPECT * shot.w) / shot.h; // the screen's height as a fraction of the page

  // Wheel: as if over a 1080p show screen (same distance per notch as on the Screen window).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const pagePx = (shot.h * 1920) / shot.w;
      onYRef.current(clampSrcY(yRef.current + srcWheelPx(e, 1080) / pagePx, shot));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [shot]);

  const jump = (clientY: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    onYRef.current(clampSrcY((clientY - r.top) / r.height - frame / 2, shot));
  };
  const dragging = useRef(false);

  return (
    <div data-source-map title="The source page on the show screens — wheel or drag here (or Shift+↑/↓) to scroll it everywhere"
      style={{ position: 'absolute', right: 14, top: 14, zIndex: 5, width: W + 12, padding: 6, borderRadius: 8, background: 'rgba(17,17,20,0.92)', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 6px 24px rgba(0,0,0,0.45)', userSelect: 'none' }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9ca3af', margin: '0 0 5px 1px', display: 'flex', justifyContent: 'space-between' }}>
        <span>Source</span><span style={{ color: '#6b7280' }}>⇧↑↓</span>
      </div>
      <div ref={box}
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); dragging.current = true; jump(e.clientY); }}
        onPointerMove={(e) => { if (dragging.current) jump(e.clientY); }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
        style={{ position: 'relative', width: W, height: Math.min(mapH, 420), overflow: 'hidden', borderRadius: 4, background: '#fff', cursor: 'ns-resize', touchAction: 'none' }}>
        <img src={shot.src} alt="" draggable={false} style={{ display: 'block', width: W, height: mapH, transform: mapH > 420 ? `translateY(${-Math.max(0, Math.min(mapH - 420, y * mapH - 210 + (frame * mapH) / 2))}px)` : undefined, pointerEvents: 'none' }} />
        <div data-source-frame style={{
          position: 'absolute', left: 0, right: 0,
          top: (mapH > 420 ? y * mapH - Math.max(0, Math.min(mapH - 420, y * mapH - 210 + (frame * mapH) / 2)) : y * mapH),
          height: Math.min(1, frame) * mapH,
          border: '2px solid #60a5fa', borderRadius: 3, background: 'rgba(96,165,250,0.12)', boxShadow: '0 0 0 999px rgba(0,0,0,0.35)', transition: 'top 120ms ease-out', pointerEvents: 'none',
        }} />
      </div>
      <div style={{ fontSize: 9, color: '#6b7280', marginTop: 4, textAlign: 'right' }}>{Math.round((y / Math.max(0.0001, 1 - Math.min(1, frame))) * 100) || 0}%</div>
    </div>
  );
}
