/**
 * Daily Show — one story on the audience screen, in the Deep Dive's style
 * (Jake, 2026-10-06). The cover, then each scene, stacked full screen and slid
 * into view like the Deep Dive's chapters (`.dd2-track`); a scene is drawn by
 * the Deep Dive's own ChapterView, so its micro-interactions — cards that
 * reveal, numbers that count up, steps that light — are the same components.
 *
 * The host page owns the beat (keys, live sync); this only draws. The story's
 * video is NOT part of this: it is its own full-screen layer (VideoEmbed),
 * opened with Shift, and no beat ever shows it.
 *
 * TEMPLATES (Jake, 2026-10-06): the deck is drawn in one of the Deep Dive's
 * templates (deepdive/templates.ts, stored per deck — deckTemplate.ts). The
 * root gets exactly the variables, pattern layer and paper/dark rhythm a Deep
 * Dive stage gets (`dd2RootProps`, `paperFor`), and the presenter-bubble safe
 * frame (deepdive/bubble.tsx) — nothing here is forked from the Deep Dive.
 */
import { useEffect, useMemo, useState } from 'react';
import { Accent, ChapterView, DotField } from '../../deepdive/v2/Chapter';
import { dd2RootProps } from '../../deepdive/v2/Show';
import type { Slide } from '../../api';
import { beatCount } from '../../deepdive/v2/types';
import { paperFor, templateFor, type DeckTemplate } from '../../deepdive/templates';
import { BubbleLayer, type BubbleSettings } from '../../deepdive/bubble';
import { locateBeat, storyStage, beatOfScene, type StoryStage } from './story';
import './story.css';

export interface StoryShowProps {
  slide: Slide;
  /** Story beat: 0 = cover. */
  beat: number;
  /** Story number in the show (1-based) — the scenes' number badge. */
  number: number;
  /** Final state, no motion, no video (thumbnails, previews). */
  still?: boolean;
  /** Clicking a step/card on the stage jumps to it (the presenter's screens). */
  onBeat?: (beat: number) => void;
  /** Pre-parsed stage, when the host already has it. */
  stage?: StoryStage;
  /** The deck's design (deepdive/templates.ts). Absent = Jake's brand. */
  template?: DeckTemplate | null;
  /** The presenter's camera bubble: its corner is kept clear (safe frame). */
  bubble?: BubbleSettings | null;
  /** The real audience screen: also draw the bubble guide / camera (B · C · G). */
  bubbleLayer?: boolean;
}

const ytThumb = (s: Slide): string => (s.videoId && (s.videoKind || 'youtube') === 'youtube' ? `https://i.ytimg.com/vi/${s.videoId}/maxresdefault.jpg` : '');

function Cover({ slide, st, on, still }: { slide: Slide; st: StoryStage; on: boolean; still: boolean }) {
  const c = st.cover;
  const [bg, setBg] = useState(() => slide.heroImageUrl || ytThumb(slide));
  useEffect(() => { setBg(slide.heroImageUrl || ytThumb(slide)); }, [slide.id, slide.heroImageUrl, slide.videoId]);
  const plain = c.heading.replace(/\*/g, '');
  const size = plain.length > 70 ? 'xl' : plain.length > 42 ? 'l' : '';
  return (
    <section className={`dd2-ch k-title ns-cover ${on ? 'on' : ''} ${still ? 'still' : ''}`}>
      <div className="ns-cover-bg" aria-hidden>
        {bg && (
          <img src={bg} alt="" referrerPolicy="strict-origin-when-cross-origin"
            // maxres is missing on some YouTube uploads; hq always exists.
            onError={() => setBg((cur) => (cur.includes('maxresdefault') ? cur.replace('maxresdefault', 'hqdefault') : ''))} />
        )}
        <i className="ns-glow" />
        {/* the Deep Dive title's dot field, in the template's colours */}
        <DotField still={still || !on} />
      </div>
      <div className="dd2-wrap dd2-title ns-cover-wrap">
        <div><span className="dd2-chip"><span className="av">JD</span>Jake Dawson<span>· AI News</span></span></div>
        {c.eyebrow && <div className="dd2-eyebrow ns-cover-eyebrow">{c.eyebrow}</div>}
        <h1 className={`dd2-h1 ns-h1 ${size}`}><Accent text={c.heading} /><span className="full">.</span></h1>
        {c.lede && <p className="dd2-lede ns-lede">{c.lede}</p>}
        {(c.source || c.host) && (
          <div className="ns-src">
            <span>via</span> <b>{c.source || c.host}</b>
            {c.host && c.source && <span> · {c.host}</span>}
            {c.outlets > 1 && <em>{c.outlets} sources</em>}
          </div>
        )}
      </div>
    </section>
  );
}

export default function StoryShow({ slide, beat, number, still = false, onBeat, stage, template, bubble, bubbleLayer = false }: StoryShowProps) {
  const st = useMemo(() => stage ?? storyStage(slide), [stage, slide]);
  const t = template ?? templateFor(null, 'v2');
  const at = locateBeat(st, beat);
  // First paint of a story lands without the slide transition.
  const [instant, setInstant] = useState(true);
  useEffect(() => {
    setInstant(true);
    const t = setTimeout(() => setInstant(false), 60);
    return () => clearTimeout(t);
  }, [slide.id]);

  return (
    <div className={`dd2 ns-story ${instant || still ? 'instant' : ''}`} {...dd2RootProps(t, bubble)}>
      <div className="dd2-track" style={{ transform: `translateY(${-at.screen * 100}cqh)` }}>
        <Cover slide={slide} st={st} on={!still && at.screen === 0} still={still} />
        {st.scenes.map((c, i) => {
          const screen = i + 1;
          const near = Math.abs(screen - at.screen) <= 1;
          // A scene already passed shows its last beat; one ahead shows its first.
          const b = screen === at.screen ? at.sceneBeat : screen < at.screen ? beatCount(c) - 1 : 0;
          return (
            <ChapterView
              key={c.id}
              chapter={c}
              index={number}
              beat={b}
              diveId=""
              active={!still && screen === at.screen}
              still={still || !near}
              // The template's rhythm. Jake's brand alternates: cover black → first scene
              // on paper → second black; all-dark / all-light templates stay so.
              paper={paperFor(t, i, false)}
              onBeat={onBeat ? (sb) => onBeat(beatOfScene(st, i, sb)) : undefined}
            />
          );
        })}
      </div>
      {bubbleLayer && bubble && !still && <BubbleLayer settings={bubble} scope=".dd2-ch.on" trigger={`${slide.id}:${beat}`} />}
    </div>
  );
}

/** One story as a still 16:9 thumbnail at a given beat (presenter monitor, dashboard). */
export function StoryThumb({ slide, beat, number, live = false, template, bubble }: { slide: Slide; beat: number; number: number; live?: boolean; template?: DeckTemplate | null; bubble?: BubbleSettings | null }) {
  return (
    <div style={{ position: 'relative', aspectRatio: '16 / 9', width: '100%', overflow: 'hidden', borderRadius: 8, background: '#000' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <StoryShow slide={slide} beat={beat} number={number} still={!live} template={template} bubble={bubble} />
      </div>
    </div>
  );
}
