/**
 * Daily Show — one story on the show screens (Jake, 2026-10-07):
 *   SOURCE (the real article, full screen — a still image Jake scrolls
 *   himself, synced to every screen) → 2–3 SLIDES, one idea and one beat each,
 *   each with its own entrance animation (NewsSlides.tsx; older v2 stages still
 *   draw their item-per-beat slides here). See story.ts for the beat model and
 *   how every beat gets its cue in the script.
 *
 * Drawn in the AI News templates (newsTemplates.ts + story.css) — NOT the Deep
 * Dive's components or look, so the Deep Dive at the end of the show stays the
 * special one. The host page owns the beat (keys, live sync); this only draws.
 *
 * THE VIDEO is not drawn here and is not a beat: the audience/display pages
 * keep the story's one VideoEmbed loaded behind the story and Shift puts it
 * full screen over whatever beat is showing (media-view), so toggling back
 * lands on the same beat.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFitText, type FitTarget } from '../../deepdive/fitText';
import type { Slide } from '../../api';
import { BubbleLayer, type BubbleSettings } from '../../deepdive/bubble';
import { beatAtIndex, beatFor, storyStage, type NewsScene, type SourceShot, type StoryStage } from './story';
import { newsTemplateFor, newsTemplateStyle, type NewsTemplate } from './newsTemplates';
import { NewsSlide, Strip } from './NewsSlides';
import { clampSrcY, srcWheelPx } from './sourceScroll';
import './story.css';

export interface StoryShowProps {
  slide: Slide;
  /** Story beat: 0 = the source. */
  beat: number;
  /** Story number in the show (1-based) — the strip's number. */
  number: number;
  /** Final state, no motion (thumbnails, previews). */
  still?: boolean;
  /** Clicking an item on the stage jumps to it (the presenter's screens). */
  onBeat?: (beat: number) => void;
  /** Pre-parsed stage, when the host already has it. */
  stage?: StoryStage;
  /** The deck's AI News template. Absent = the default. */
  template?: NewsTemplate | null;
  /** The presenter's camera bubble (B · C · G overlay on the real audience screen). */
  bubble?: BubbleSettings | null;
  bubbleLayer?: boolean;
  /** Draw the opener as the title card even when a source page exists (the template picker's inset). */
  titleCard?: boolean;
  /**
   * The source page's scroll (fraction of the image height at the screen's top
   * edge; sourceScroll.ts). The host holds it and syncs it to the other screens;
   * each screen eases to it and clamps it to its own shape. Default: the top.
   */
  srcY?: number;
  /** Jake scrolled the source on THIS screen (wheel / drag) — the host publishes it. Absent = not scrollable here. */
  onSrcScroll?: (y: number) => void;
}

// Fit floors (Jake, 2026-10-06: "readable and big, but not overlap") — a nudge, not a shrink.
const NEWS_FIT: FitTarget[] = [
  { sel: '.nw-title-h', within: '.nw-title', min: 0.75 },
  { sel: '.nw-title', min: 0.85, last: true },
  { sel: '.nw-h', min: 0.9 },
  { sel: '.nw-body', min: 0.85 },
  { sel: '.nw-cards', items: '.nw-card', min: 0.85 },
];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `*accent*` → the template's accent (colour or block — never the Deep Dive's italic underline). */
function Accent({ text }: { text: string }) {
  const parts = text.split(/\*([^*]+)\*/);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <span key={i} className="nw-acc">{p}</span> : <span key={i}>{p}</span>))}</>;
}

/* ── SOURCE ── */

/**
 * The source page — a still image (Jake, 2026-10-07: "instead of auto
 * scrolling — let me scroll my self — I love that it's an image and nothing
 * pops up"). It sits where the host says (`y`), easing there smoothly; with
 * `onScroll` the wheel / trackpad / a drag on it scroll it and report the new
 * spot (the host syncs it to the other screens). A new page opens at its top.
 */
function SourceScroll({ shot, on, still, y, onScroll }: { shot: SourceShot; on: boolean; still: boolean; y: number; onScroll?: (y: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const shown = useRef(0);
  const target = useRef(0);
  const raf = useRef(0);
  const last = useRef(0);
  const [dragging, setDragging] = useState(false);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;

  /** The page's height on this screen, in px. */
  const pageH = () => { const b = box.current; return b ? (shot.h * b.clientWidth) / shot.w : 0; };
  const clampHere = (v: number) => { const b = box.current; return b ? clampSrcY(v, shot, b.clientHeight / Math.max(1, b.clientWidth)) : 0; };
  const paint = () => { if (img.current) img.current.style.transform = `translate3d(0, ${(-shown.current * pageH()).toFixed(2)}px, 0)`; };
  const step = (t: number) => {
    const dt = Math.min(64, t - (last.current || t));
    last.current = t;
    const diff = target.current - shown.current;
    if (Math.abs(diff * pageH()) < 0.4) { shown.current = target.current; raf.current = 0; last.current = 0; paint(); return; }
    shown.current += diff * (1 - Math.exp(-dt / 95));
    paint();
    raf.current = requestAnimationFrame(step);
  };
  const kick = () => { if (!raf.current) raf.current = requestAnimationFrame(step); };

  // A new page opens exactly where the host says (the top) — no glide from the last story's spot.
  useLayoutEffect(() => {
    cancelAnimationFrame(raf.current); raf.current = 0; last.current = 0;
    shown.current = target.current = clampHere(y);
    paint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot.src]);
  // The host moved it (here or on another screen): ease there.
  useEffect(() => {
    target.current = clampHere(y);
    if (still || !on) { cancelAnimationFrame(raf.current); raf.current = 0; shown.current = target.current; paint(); return; }
    kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [y, still, on]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  // Keep the picture in place when the window changes shape.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const ro = new ResizeObserver(() => { target.current = clampHere(target.current); shown.current = clampHere(shown.current); paint(); });
    ro.observe(b);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot.src]);

  // Wheel / trackpad: non-passive, so the page itself never scrolls.
  useEffect(() => {
    const b = box.current;
    if (!b || !onScroll || still) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const h = pageH();
      if (h <= 0) return;
      const next = clampHere(target.current + srcWheelPx(e, b.clientHeight) / h);
      if (next === target.current) return;
      target.current = next;
      kick();
      onScrollRef.current?.(next);
    };
    b.addEventListener('wheel', wheel, { passive: false });
    return () => b.removeEventListener('wheel', wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!onScroll, still, shot.src]);

  // Drag: the page follows the pointer (grab-and-move, like a phone).
  const drag = useRef<{ id: number; y0: number; t0: number } | null>(null);
  const can = !!onScroll && !still;
  return (
    <div className={`nw-src ${can ? 'can-scroll' : ''} ${dragging ? 'dragging' : ''}`} ref={box}
      onPointerDown={can ? (e) => { if (e.button !== 0) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { id: e.pointerId, y0: e.clientY, t0: target.current }; setDragging(true); } : undefined}
      onPointerMove={can ? (e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const h = pageH();
        if (h <= 0) return;
        const next = clampHere(d.t0 - (e.clientY - d.y0) / h);
        if (next === target.current) return;
        target.current = next;
        shown.current = next; // under the finger: no easing lag
        paint();
        onScrollRef.current?.(next);
      } : undefined}
      onPointerUp={can ? () => { drag.current = null; setDragging(false); } : undefined}
      onPointerCancel={can ? () => { drag.current = null; setDragging(false); } : undefined}>
      <img ref={img} src={shot.src} alt="" onLoad={paint} draggable={false} />
      <div className="nw-src-chip"><i />{shot.name || shot.host}{shot.name && shot.host && <span>{shot.host}</span>}</div>
    </div>
  );
}

function TitleCard({ st, number, on, still }: { st: StoryStage; number: number; on: boolean; still: boolean }) {
  const c = st.cover;
  const ref = useRef<HTMLDivElement>(null);
  useFitText(ref, NEWS_FIT, [c.heading, c.lede, still, on]);
  return (
    <div className="nw-pad nw-title" ref={ref}>
      <Strip number={number} label={c.eyebrow || 'Next story'} />
      <h1 className="nw-title-h"><Accent text={c.heading} /></h1>
      {c.lede && <p className="nw-title-lede">{c.lede}</p>}
      {(c.source || c.host) && <div className="nw-via">via <b>{c.source || c.host}</b>{c.host && c.source && <span>· {c.host}</span>}</div>}
    </div>
  );
}

/* ── INFO ── */

const fmt = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US') : String(v ?? ''));

function SceneBody({ sc, upTo, still, onItem }: { sc: NewsScene; upTo: number; still: boolean; onItem?: (i: number) => void }) {
  const d = sc.data || {};
  const it = (i: number, base: string): { className: string; onClick?: () => void } => ({
    className: `${base} nw-it ${i < upTo ? '' : 'hold'} ${i === upTo - 1 ? 'cur' : ''}`,
    onClick: onItem ? () => onItem(i) : undefined,
  });
  switch (sc.kind) {
    case 'list':
      return (
        <div className="nw-list">
          {(d.items ?? []).map((x: string, i: number) => (
            <div key={i} {...it(i, 'row')}><span className="n">{pad2(i + 1)}</span><span className="tx">{x}</span></div>
          ))}
        </div>
      );
    case 'stats': {
      const stats = d.stats ?? [];
      return (
        <div className={`nw-stats n${stats.length}`}>
          {stats.map((x: any, i: number) => (
            <div key={i} {...it(i, 'nw-stat')}>
              <div className="v">{x.prefix}{x.value !== null && x.value !== undefined ? fmt(x.value) : x.display}{x.suffix && <small>{x.suffix}</small>}</div>
              <div className="l">{x.label}</div>
            </div>
          ))}
        </div>
      );
    }
    case 'versus':
      return (
        <div className="nw-cards">
          {(d.options ?? []).map((o: any, i: number) => (
            <div key={i} {...it(i, 'nw-card')}>
              <div className="nm">{o.name}</div>
              <div className="ln">{o.line}</div>
              {o.points?.length > 0 && <ul>{o.points.map((p: string, k: number) => <li key={k}>{p}</li>)}</ul>}
            </div>
          ))}
        </div>
      );
    case 'reveal':
      return (
        <div className="nw-cards">
          {(d.cards ?? []).map((c: any, i: number) => (
            <div key={i} {...it(i, 'nw-card')}>
              <div className="nm">{c.name}</div>
              <div className="big">{c.big || `${c.prefix ?? ''}${fmt(c.countTo)}${c.suffix ?? ''}`}</div>
              {c.small && <div className="sm">{c.small}</div>}
            </div>
          ))}
        </div>
      );
    case 'flow':
      return (
        <div className="nw-flow">
          {(d.steps ?? []).map((x: any, i: number) => (
            <div key={i} {...it(i, 'nw-step')}>
              <span className="dot">{i + 1}</span>
              <div className="lb">{x.label}</div>
              <div className="tx">{x.text}</div>
            </div>
          ))}
        </div>
      );
    case 'timeline':
      return (
        <div className="nw-tl">
          {(d.events ?? []).map((e: any, i: number) => (
            <div key={i} {...it(i, `nw-ev ${e.soon ? 'soon' : ''}`)}>
              <div className="dt">{e.date}</div>
              <div className="lb">{e.label}</div>
              {e.detail && <div className="tx">{e.detail}</div>}
            </div>
          ))}
        </div>
      );
    case 'quote':
      return (
        <div {...it(0, 'nw-quote')}>
          <q>{d.quote}</q>
          {(d.who || d.role) && <div className="who"><b>{d.who}</b>{d.role && ` · ${d.role}`}</div>}
        </div>
      );
    default:
      return null;
  }
}

function SceneScreen({ sc, number, upTo, on, still, onItem }: { sc: NewsScene; number: number; upTo: number; on: boolean; still: boolean; onItem?: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFitText(ref, NEWS_FIT, [sc, still, on]);
  return (
    <div className="nw-pad" ref={ref}>
      <Strip number={number} label={sc.eyebrow} />
      <h2 className="nw-h"><Accent text={sc.heading} /></h2>
      <div className="nw-body"><SceneBody sc={sc} upTo={upTo} still={still} onItem={onItem} /></div>
    </div>
  );
}

export default function StoryShow({ slide, beat, number, still = false, onBeat, stage, template, bubble, bubbleLayer = false, titleCard = false, srcY = 0, onSrcScroll }: StoryShowProps) {
  const st = useMemo(() => stage ?? storyStage(slide), [stage, slide]);
  const t = template ?? newsTemplateFor(null);
  const at = beatAtIndex(st, beat);
  // First paint of a story lands without the slide transition.
  const [instant, setInstant] = useState(true);
  useEffect(() => {
    setInstant(true);
    const id = setTimeout(() => setInstant(false), 60);
    return () => clearTimeout(id);
  }, [slide.id]);

  return (
    <div className={`nw ${instant || still ? 'instant' : ''} ${still ? 'still' : ''}`} data-deco={t.deco} data-mark={t.mark} data-template={t.id} style={newsTemplateStyle(t)}>
      <div className="nw-deck">
        {st.screens.map((sc, i) => {
          const on = i === at.screen;
          const kind = sc.kind === 'scene' ? st.scenes[sc.scene].kind : 'open';
          const cls = `nw-screen k-${sc.kind} ${on ? 'on' : i < at.screen ? 'past' : ''}`;
          let body: ReactNode = null;
          if (sc.kind === 'open') {
            body = st.shot && !titleCard
              ? <SourceScroll shot={st.shot} on={on} still={still} y={srcY} onScroll={onSrcScroll} />
              : <TitleCard st={st} number={number} on={on} still={still} />;
          } else if (st.scenes[sc.scene].v3) {
            // v3: the whole slide is one beat, with its own entrance.
            body = <NewsSlide sc={st.scenes[sc.scene]} number={number} on={on} still={still} shot={st.shot} source={st.shot?.name || st.cover.source || st.shot?.host || st.cover.host} />;
          } else {
            const scene = st.scenes[sc.scene];
            // A slide already passed shows all its items; one ahead shows none yet.
            const upTo = on ? at.upTo : i < at.screen ? 99 : 0;
            body = (
              <SceneScreen sc={scene} number={number} upTo={upTo} on={on} still={still}
                onItem={onBeat ? (k) => onBeat(beatFor(st, i, k + 1)) : undefined} />
            );
          }
          return <section key={i} className={cls} data-screen={sc.kind} data-kind={kind}>{body}</section>;
        })}
      </div>
      {bubbleLayer && bubble && !still && <BubbleLayer settings={bubble} scope=".nw-screen.on" trigger={`${slide.id}:${beat}`} />}
    </div>
  );
}

/** One story as a still 16:9 thumbnail at a given beat (presenter monitor, dashboard). */
export function StoryThumb({ slide, beat, number, live = false, template, titleCard = false }: { slide: Slide; beat: number; number: number; live?: boolean; template?: NewsTemplate | null; titleCard?: boolean }) {
  return (
    <div style={{ position: 'relative', aspectRatio: '16 / 9', width: '100%', overflow: 'hidden', borderRadius: 8, background: '#000' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <StoryShow slide={slide} beat={beat} number={number} still={!live} template={template} titleCard={titleCard} />
      </div>
    </div>
  );
}
