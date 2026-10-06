/**
 * The presenter's camera BUBBLE (Jake, 2026-10-06): "in presentations the
 * presenter bubble sits in the bottom-left corner by default and covers text
 * and other slide content".
 *
 * Two layers of defence, both here:
 *  1. SAFE FRAME — every slide layout keeps the bubble's corner clear
 *     (`bubbleRootProps` → `data-bubble` + `--bub` on the show's root; the
 *     rules are in v2/show.css and deepdive.css). This is what protects the
 *     bubble a recorder/stream puts on top of the screen, which this page
 *     cannot move.
 *  2. AUTO-MOVE — with "Show my camera" on, the stage draws the bubble itself
 *     (the webcam, in a circle) and, when content is behind it anyway, glides
 *     it to the clearest corner, then home again. The guide (G) outlines the
 *     corner and turns red when anything sits behind it — the way to check a
 *     recorder's bubble lines up.
 *
 * The settings are per machine (the screen that records), kept in
 * localStorage and shared live between the editor and an open stage window.
 * Stage keys: B = next corner, C = camera on/off, G = guide on/off.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

export type BubbleCorner = 'bl' | 'br' | 'tl' | 'tr' | 'off';
export type BubbleSize = 's' | 'm' | 'l';
export interface BubbleSettings { corner: BubbleCorner; size: BubbleSize; camera: boolean; guide: boolean }

export const DEFAULT_BUBBLE: BubbleSettings = { corner: 'bl', size: 'm', camera: false, guide: false };
export const CORNER_LABEL: Record<BubbleCorner, string> = { bl: 'Bottom-left', br: 'Bottom-right', tl: 'Top-left', tr: 'Top-right', off: 'None' };
export const SIZE_LABEL: Record<BubbleSize, string> = { s: 'S', m: 'M', l: 'L' };
const CYCLE: BubbleCorner[] = ['bl', 'br', 'tr', 'tl', 'off'];

/** The bubble's diameter as a share of the frame's HEIGHT. */
const DIAMETER: Record<BubbleSize, number> = { s: 0.24, m: 0.3, l: 0.38 };
/** Gap from the frame edge, and clearance kept around the bubble, in --u. */
const EDGE_U = 1.8;
const CLEAR_U = 2;
/** A 16:9 frame is 100u wide and 56.25u tall. */
const FRAME_H_U = 56.25;

export const bubbleDiameterU = (size: BubbleSize) => DIAMETER[size] * FRAME_H_U;
/** Width (= height) of the corner the slides keep clear, in --u. */
export const bubbleZoneU = (size: BubbleSize) => Math.round((EDGE_U + bubbleDiameterU(size) + CLEAR_U) * 10) / 10;

const KEY = 'dd-bubble';
function read(): BubbleSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && typeof v === 'object') return { ...DEFAULT_BUBBLE, ...v };
  } catch { /* private window / blocked storage */ }
  return DEFAULT_BUBBLE;
}

/** The bubble settings, live across tabs (the editor and the stage window). */
export function useBubbleSettings(): [BubbleSettings, (patch: Partial<BubbleSettings>) => void] {
  const [s, setS] = useState<BubbleSettings>(read);
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === KEY) setS(read()); };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  const set = useCallback((patch: Partial<BubbleSettings>) => {
    setS((cur) => {
      const next = { ...cur, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not saved — still applies here */ }
      return next;
    });
  }, []);
  return [s, set];
}

/** Stage keys B / C / G. Returns true when the key was a bubble key. */
export function bubbleKey(e: KeyboardEvent, s: BubbleSettings, set: (p: Partial<BubbleSettings>) => void): boolean {
  switch (e.key) {
    case 'b': case 'B': set({ corner: CYCLE[(CYCLE.indexOf(s.corner) + 1) % CYCLE.length] }); return true;
    case 'c': case 'C': set({ camera: !s.camera }); return true;
    case 'g': case 'G': set({ guide: !s.guide }); return true;
  }
  return false;
}

/** Spread onto the show's root (`.dd2` or `.dd-stage`): turns the safe frame on. */
export function bubbleRootProps(s: BubbleSettings | null | undefined): { 'data-bubble'?: string; style?: CSSProperties } {
  if (!s || s.corner === 'off') return {};
  return { 'data-bubble': s.corner, style: { ['--bub' as string]: bubbleZoneU(s.size) } as CSSProperties };
}

/* ── content-behind-the-bubble check ─────────────────────────────────────── */

/** The bubble as a circle in page px (it is round: a rectangle's corner would flag content that isn't behind it). */
type Circle = { cx: number; cy: number; r: number };

function bubbleCircle(frame: DOMRect, corner: Exclude<BubbleCorner, 'off'>, size: BubbleSize): Circle {
  const u = Math.min(frame.width / 100, frame.height / FRAME_H_U);
  const rad = (bubbleDiameterU(size) / 2) * u;
  const off = EDGE_U * u + rad;
  const left = corner === 'bl' || corner === 'tl';
  const top = corner === 'tl' || corner === 'tr';
  return { cx: left ? frame.left + off : frame.right - off, cy: top ? frame.top + off : frame.bottom - off, r: rad + 0.6 * u };
}

const PAINT_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'svg', 'SVG']);

/** Does any visible slide content sit behind the bubble `z`? (Backgrounds and big containers don't count.) */
function contentIn(scope: Element, z: Circle, frameArea: number): boolean {
  // How far into the circle something must reach to count (a hairline touch doesn't).
  const reach = z.r * 0.1;
  for (const el of Array.from(scope.querySelectorAll('*'))) {
    if (el.closest('[data-bubble-ignore], .dd2-hero-bg, .dd-bg')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const dx = Math.max(r.left - z.cx, 0, z.cx - r.right);
    const dy = Math.max(r.top - z.cy, 0, z.cy - r.bottom);
    if (Math.hypot(dx, dy) > z.r - reach) continue;
    if (r.width * r.height > frameArea * 0.45) continue; // a panel/background, not content
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.15 || cs.display === 'none') continue;
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim());
    const painted = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    if (ownText || painted || PAINT_TAGS.has(el.tagName)) return true;
  }
  return false;
}

/**
 * The bubble's own layer, drawn INSIDE the show's frame (a child of `.dd2` /
 * `.dd-canvas`, so --u works): the guide outline and/or the camera, which
 * moves out of the way when content is behind it.
 *
 * `scope` = selector of what's on screen now, inside the frame (the active
 * chapter or scene); `trigger` changes on every beat, so the check runs again
 * once the beat's animation has settled.
 */
export function BubbleLayer({ settings, scope, trigger }: { settings: BubbleSettings; scope: string; trigger: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [at, setAt] = useState<Exclude<BubbleCorner, 'off'>>('bl');
  const [blocked, setBlocked] = useState(false);
  const [camErr, setCamErr] = useState('');
  const home = settings.corner === 'off' ? null : settings.corner;

  // The webcam, only while it's on.
  useEffect(() => {
    if (!settings.camera || !home) return;
    let stream: MediaStream | null = null;
    let alive = true;
    setCamErr('');
    navigator.mediaDevices?.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        if (videoRef.current) { videoRef.current.srcObject = s; void videoRef.current.play().catch(() => {}); }
      })
      .catch((e) => alive && setCamErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; stream?.getTracks().forEach((t) => t.stop()); };
  }, [settings.camera, home]);

  // Where it should sit: home, unless content is behind it there.
  useEffect(() => {
    if (!home) return;
    setAt(home);
    if (!settings.camera && !settings.guide) return;
    const check = () => {
      const frameEl = ref.current?.parentElement;
      const sc = frameEl?.querySelector(scope);
      if (!frameEl || !sc) return;
      const f = frameEl.getBoundingClientRect();
      const area = f.width * f.height;
      const busy = (c: Exclude<BubbleCorner, 'off'>) => contentIn(sc, bubbleCircle(f, c, settings.size), area);
      const homeBusy = busy(home);
      setBlocked(homeBusy);
      if (!settings.camera) return;
      if (!homeBusy) { setAt(home); return; }
      const order: Exclude<BubbleCorner, 'off'>[] = home[0] === 'b'
        ? [home === 'bl' ? 'br' : 'bl', home === 'bl' ? 'tr' : 'tl', home === 'bl' ? 'tl' : 'tr']
        : [home === 'tl' ? 'tr' : 'tl', home === 'tl' ? 'bl' : 'br', home === 'tl' ? 'br' : 'bl'];
      const free = order.find((c) => !busy(c));
      setAt(free ?? home);
    };
    const first = setTimeout(check, 1300);
    const every = setInterval(check, 2000);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [home, settings.camera, settings.guide, settings.size, scope, trigger]);

  if (!home || (!settings.camera && !settings.guide)) return null;
  const d = bubbleDiameterU(settings.size);
  const pos = (c: Exclude<BubbleCorner, 'off'>): CSSProperties => ({
    position: 'absolute', width: `calc(var(--u) * ${d})`, height: `calc(var(--u) * ${d})`,
    [c[0] === 'b' ? 'bottom' : 'top']: `calc(var(--u) * ${EDGE_U})`,
    [c[1] === 'l' ? 'left' : 'right']: `calc(var(--u) * ${EDGE_U})`,
  });
  const ring = blocked ? '#ff5a4e' : 'var(--yellow, #ffd21e)';
  return (
    <div ref={ref} data-bubble-ignore style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 80, ['--u' as string]: 'min(1cqw, 1.7778cqh)' } as CSSProperties}>
      {settings.guide && (
        <div style={{ ...pos(home), borderRadius: '50%', border: `2px dashed ${ring}`, display: 'grid', placeItems: 'center', textAlign: 'center', color: ring, font: '600 calc(var(--u) * 1) "JetBrains Mono", monospace', letterSpacing: '.08em', background: blocked ? 'rgba(255,90,78,.12)' : 'transparent' }}>
          {blocked ? 'CONTENT BEHIND THE BUBBLE' : 'CAMERA BUBBLE · CLEAR'}
        </div>
      )}
      {settings.camera && (
        <div style={{ ...pos(at), borderRadius: '50%', overflow: 'hidden', background: '#111', boxShadow: '0 10px 40px rgba(0,0,0,.45)', border: 'calc(var(--u) * .3) solid var(--yellow, #ffd21e)', transition: 'all .9s cubic-bezier(.2,.8,.2,1)' }}>
          <video ref={videoRef} muted playsInline autoPlay style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          {camErr && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: '12%', textAlign: 'center', color: '#fff', font: '500 calc(var(--u) * .9) system-ui' }}>Camera unavailable: {camErr}</div>}
        </div>
      )}
    </div>
  );
}
