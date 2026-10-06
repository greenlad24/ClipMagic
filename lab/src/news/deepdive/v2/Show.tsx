/**
 * Deep Dive v2 — the whole show: every chapter full screen, stacked, and the
 * active one slid into view (one chapter = one screen, Jake 2026-10-02).
 *
 * `flat` is the sync index: a beat number across the whole show (types.ts
 * `flatten`). The host page owns it; this only draws.
 */
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { ChapterView, isPaper } from './Chapter';
import { flatten, firstBeatOf, type Chapter } from './types';
import { templateStyle, type DeckTemplate } from '../templates';
import { BubbleLayer, bubbleRootProps, type BubbleSettings } from '../bubble';

/** The root props a template + the bubble's safe frame put on a `.dd2`. */
export function dd2RootProps(template?: DeckTemplate | null, bubble?: BubbleSettings | null): { style: CSSProperties; 'data-deco'?: string; 'data-bubble'?: string } {
  const b = bubbleRootProps(bubble);
  return {
    style: { ...(template ? templateStyle(template, 'v2') : {}), ...(b.style ?? {}) },
    ...(template ? { 'data-deco': template.deco } : {}),
    ...(b['data-bubble'] ? { 'data-bubble': b['data-bubble'] } : {}),
  };
}

export interface ShowProps {
  chapters: Chapter[];
  diveId: string;
  flat: number;
  onFlat?: (n: number) => void;
  still?: boolean;
  /** No slide transition (first paint, jumps). */
  instant?: boolean;
  /** Drawn over the show, inside its brand container (the live demo). */
  overlay?: ReactNode;
  /** Shows "Run it live" on demo chapters (stage only). */
  onRunLive?: () => void;
  /** The dive's design (templates.ts). Absent = Jake's brand. */
  template?: DeckTemplate | null;
  /** The presenter's camera bubble: keeps its corner clear (and draws it, if on). */
  bubble?: BubbleSettings | null;
}

export default function Show({ chapters, diveId, flat, onFlat, still = false, instant = false, overlay, onRunLive, template, bubble }: ShowProps) {
  const beats = useMemo(() => flatten(chapters), [chapters]);
  const at = beats[Math.max(0, Math.min(beats.length - 1, flat))] ?? { chapter: 0, beat: 0 };
  return (
    <div className={`dd2 ${instant ? 'instant' : ''}`} {...dd2RootProps(template, bubble)}>
      <div className="dd2-track" style={{ transform: `translateY(${-at.chapter * 100}cqh)` }}>
        {chapters.map((c, i) => {
          // Only the chapters next to the current one are live; the rest draw still.
          const near = Math.abs(i - at.chapter) <= 1;
          // A chapter we've passed shows its last beat; one ahead shows its first.
          const beat = i === at.chapter ? at.beat : i < at.chapter ? Number.MAX_SAFE_INTEGER : 0;
          return (
            <ChapterView
              key={c.id}
              chapter={c}
              index={i}
              beat={Math.min(beat, Math.max(0, beats.filter((b) => b.chapter === i).length - 1))}
              diveId={diveId}
              active={!still && i === at.chapter}
              still={still || !near}
              paper={isPaper(chapters, i, template ?? undefined)}
              onBeat={onFlat ? (b) => onFlat(firstBeatOf(chapters, i) + b) : undefined}
              onRunLive={onRunLive}
            />
          );
        })}
      </div>
      {overlay}
      {bubble && !still && <BubbleLayer settings={bubble} scope=".dd2-ch.on" trigger={flat} />}
    </div>
  );
}

/** One chapter as a still 16:9 thumbnail (editor, presenter monitor). */
export function ChapterThumb({ chapters, index, diveId, beat = 0, live = false, template, bubble }: { chapters: Chapter[]; index: number; diveId: string; beat?: number; live?: boolean; template?: DeckTemplate | null; bubble?: BubbleSettings | null }) {
  const c = chapters[index];
  if (!c) return null;
  const root = dd2RootProps(template, bubble);
  return (
    <div style={{ position: 'relative', aspectRatio: '16 / 9', width: '100%', overflow: 'hidden', borderRadius: 8, background: '#000' }}>
      <div className="dd2" {...root} style={{ ...root.style, position: 'absolute', inset: 0 }}>
        <ChapterView chapter={c} index={index} beat={beat} diveId={diveId} active={live} still={!live} paper={isPaper(chapters, index, template ?? undefined)} />
      </div>
    </div>
  );
}
