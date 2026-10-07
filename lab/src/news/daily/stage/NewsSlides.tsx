/**
 * AI News story SLIDES v3 (Jake, 2026-10-07: "I would like the presentation
 * slides to be maybe 2 or 3 slides per story (I can skim past them a little
 * bit quicker) and they should be designed really great including animations
 * — just different from the deep dive").
 *
 * Each slide is ONE idea and ONE beat: it arrives whole on one → press and
 * plays its own entrance ONCE (Jake's rule: nothing loops) — staggered
 * reveals, words rising out of a mask, a number counting up, rules drawing.
 * Seven editorial layouts (server news/stage.ts writes them):
 *   number   — one huge number, counted up, an accent rule, what it is
 *   quote    — a pull quote, word by word, on the card tone
 *   meaning  — "what it means": the statement on a full-bleed ACCENT field
 *   compare  — two sides, wiped in from the edges, a "vs" disc between
 *   timeline — a rule drawing left → right, dated moments popping on it
 *   facts    — 2–3 numbered facts, one row each, rules drawing
 *   picture  — the source page's main picture (its capture, cropped), big,
 *              with the headline beside it
 * Deliberately NOT the Deep Dive's vocabulary (no chapter chrome, dot field,
 * italic underline accent, up-sliding chapters): flat colour fields, the
 * broadcast story strip, left-aligned headlines, mask-reveal type.
 *
 * ⚠️ MOTION THAT CANNOT FOOL THE TEXT FITTER (deepdive/fitText.ts measures
 * scrollWidth/Height while a slide is still arriving): only opacity, scale
 * ≤ 1, clip-path, motion from the top/left, or a rise INSIDE an overflow-
 * hidden mask. A child translated down or right would read as overflow and
 * shrink the text for a moment.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useFitText, sizedStyle, ghostStyle, liveStyle, type FitTarget } from '../../deepdive/fitText';
import type { NewsScene, SourceShot } from './story';

const pad2 = (n: number) => String(n).padStart(2, '0');

// Fit floors (Jake, 2026-10-06: "readable and big, but not overlap") — a nudge, not a shrink.
const SLIDE_FIT: FitTarget[] = [
  { sel: '.nx-h', min: 0.9 },
  { sel: '.nx-body', min: 0.85 },
  // the giant number gives way before anything else is shrunk
  { sel: '.nx-num', min: 0.55, last: true, axis: 'x' },
];

export function Strip({ number, label }: { number: number; label: string }) {
  return (
    <div className="nw-strip">
      <span className="no">{pad2(number)}</span>
      {label && <span className="lb">{label}</span>}
    </div>
  );
}

/**
 * Kinetic type: every word rises out of its own mask, one after another
 * (`--i` = its order). `*accent*` phrases are kept as ONE unit so a block
 * accent stays one block.
 */
export function Kinetic({ text, start = 0, step = 0.045 }: { text: string; start?: number; step?: number }) {
  // One unit per word; text glued to a word with no space ("*Rohit Prasad*, new boss") joins that
  // word's unit, so the comma can never wrap onto the next line on its own.
  const units: { t: string; acc: boolean }[][] = [];
  let spaced = true;
  const add = (t: string, acc: boolean) => {
    if (!spaced && units.length) units[units.length - 1].push({ t, acc });
    else units.push([{ t, acc }]);
    spaced = false;
  };
  text.split(/\*([^*]+)\*/).forEach((part, i) => {
    if (i % 2 === 1) { if (part.trim()) add(part.trim(), true); return; }
    for (const w of part.split(/(\s+)/)) {
      if (!w) continue;
      if (/^\s+$/.test(w)) { spaced = true; continue; }
      add(w, false);
    }
  });
  return (
    <>
      {units.map((u, i) => (
        <span key={i}>
          {i > 0 && ' '}
          <span className="kw"><span className="kw-i" style={{ '--d': `${(start + i * step).toFixed(3)}s` } as CSSProperties}>
            {u.map((p, k) => (p.acc ? <span key={k} className="nw-acc">{p.t}</span> : <span key={k}>{p.t}</span>))}
          </span></span>
        </span>
      ))}
    </>
  );
}

/* ── the giant number ── */

const decimalsOf = (v: number) => { const s = String(v); const i = s.indexOf('.'); return i < 0 ? 0 : Math.min(2, s.length - i - 1); };
const fmtNum = (v: number, dec: number) => v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

/** Counts 0 → value ONCE when the slide arrives. The final value is laid out (invisible) under it, so the box never changes size. */
function CountUp({ value, display, prefix, suffix, on, still }: { value: number | null; display: string; prefix: string; suffix: string; on: boolean; still: boolean }) {
  const dec = value === null ? 0 : decimalsOf(value);
  const final = value === null ? display : fmtNum(value, dec);
  const counts = value !== null && Math.abs(value) >= 2 && !still;
  const [shown, setShown] = useState(final);
  useLayoutEffect(() => {
    if (!counts || !on) { setShown(final); return; }
    setShown(fmtNum(0, dec));
    let raf = 0;
    const t0 = performance.now() + 220;
    const tick = (t: number) => {
      const k = Math.max(0, Math.min(1, (t - t0) / 1150));
      const e = 1 - Math.pow(1 - k, 4);
      setShown(fmtNum(k >= 1 ? value! : value! * e, dec));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on, counts, value, dec, final]);
  const body = (s: string) => <>{prefix && <span className="px">{prefix}</span>}{s}{suffix && <span className="sx">{suffix}</span>}</>;
  return (
    <span style={sizedStyle}>
      <span style={ghostStyle} aria-hidden>{body(final)}</span>
      <span style={liveStyle}>{body(shown)}</span>
    </span>
  );
}

/* ── the picture: the source capture, cropped to the page's main image ── */

function Picture({ shot }: { shot: SourceShot }) {
  // The page's main picture (found at capture time): full-bleed, cropped to fill.
  if (shot.hero) {
    const b = shot.hero;
    return (
      <svg className="nx-pic-img" viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} preserveAspectRatio="xMidYMid slice" aria-hidden>
        <image href={shot.src} x={0} y={0} width={shot.w} height={shot.h} />
      </svg>
    );
  }
  // No picture found (or a capture from before 2026-10-07): the top of the article as a cutting — a page laid on the desk.
  const h = Math.min(shot.h, Math.round(shot.w * 0.9));
  return (
    <div className="nx-clip">
      <svg viewBox={`0 0 ${shot.w} ${h}`} preserveAspectRatio="xMidYMin meet" aria-hidden>
        <image href={shot.src} x={0} y={0} width={shot.w} height={shot.h} />
      </svg>
    </div>
  );
}

/* ── one slide ── */

export function NewsSlide({ sc, number, on, still, shot, source }: {
  sc: NewsScene; number: number; on: boolean; still: boolean; shot: SourceShot | null; source: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFitText(ref, SLIDE_FIT, [sc, still, on]);
  const d = sc.data || {};
  const eyebrow = sc.eyebrow || DEFAULT_EYEBROW[sc.kind] || '';
  const heading = sc.heading;
  const H = heading ? <h2 className="nw-h nx-h"><Kinetic text={heading} start={0.12} /></h2> : null;

  const body = useMemo(() => {
    switch (sc.kind) {
      case 'number': {
        const value = typeof d.value === 'number' ? d.value : null;
        const shown = `${d.prefix ?? ''}${value === null ? d.display ?? '' : fmtNum(value, decimalsOf(value))}${d.suffix ?? ''}`;
        // A short number ("722", "2×", "#1") stands beside its words; a long one ("$50,000+") sits above them.
        return (
          <div className={`nx-body nx-num-wrap ${shown.length <= 4 ? 'side' : 'stack'}`}>
            <div className="nx-num"><CountUp value={value} display={String(d.display ?? '')} prefix={String(d.prefix ?? '')} suffix={String(d.suffix ?? '')} on={on} still={still} /></div>
            <div className="nx-num-text">
              <div className="nx-rule" />
              <div className="nx-num-label"><Kinetic text={String(d.label ?? '')} start={0.42} step={0.035} /></div>
              {d.context && <div className="nx-num-ctx">{String(d.context)}</div>}
            </div>
          </div>
        );
      }
      case 'quote': {
        const words = String(d.quote ?? '').split(/\s+/).filter(Boolean);
        const step = Math.min(0.05, 0.9 / Math.max(1, words.length));
        return (
          <figure className="nx-body nx-quote-fig">
            <div className="nx-q-in">
              <div className="nx-qmark" aria-hidden>“</div>
              <blockquote className="nx-q">
                {words.map((w, i) => <span key={i}>{i > 0 && ' '}<span className="qw" style={{ '--d': `${(0.25 + i * step).toFixed(3)}s` } as CSSProperties}>{w}</span></span>)}
              </blockquote>
              {(d.who || d.role) && (
                <figcaption className="nx-who" style={{ '--d': `${(0.45 + words.length * step).toFixed(3)}s` } as CSSProperties}>
                  <i className="nx-who-rule" /><b>{String(d.who ?? '')}</b>{d.role && <span>{String(d.role)}</span>}
                </figcaption>
              )}
            </div>
          </figure>
        );
      }
      case 'meaning':
        return (
          <div className="nx-body nx-mean">
            <h2 className="nx-mean-h"><Kinetic text={heading} start={0.32} step={0.05} /></h2>
            {d.text && <p className="nx-mean-t"><span className="ar" aria-hidden>→</span><span>{String(d.text)}</span></p>}
          </div>
        );
      case 'compare': {
        const sides: any[] = Array.isArray(d.sides) ? d.sides.slice(0, 2) : [];
        return (
          <div className="nx-body nx-cmp">
            {sides.map((x, i) => (
              <div key={i} className={`nx-side ${i ? 'b' : 'a'}`}>
                <div className="nm">{String(x.name ?? '')}</div>
                {x.big && <div className="big">{String(x.big)}</div>}
                {x.line && <div className="ln">{String(x.line)}</div>}
              </div>
            ))}
            {sides.length === 2 && <div className="nx-vs" aria-hidden><span>vs</span></div>}
          </div>
        );
      }
      case 'timeline': {
        const ev: any[] = Array.isArray(d.events) ? d.events.slice(0, 4) : [];
        return (
          <div className="nx-body nx-tl">
            <div className="nx-tl-row" style={{ '--n': ev.length } as CSSProperties}>
              <div className="nx-tl-line"><i /></div>
              {ev.map((e, i) => (
                <div key={i} className={`nx-ev ${e.soon ? 'soon' : ''}`} style={{ '--d': `${(0.35 + i * (0.7 / Math.max(1, ev.length - 1))).toFixed(3)}s` } as CSSProperties}>
                  <i className="dot" />
                  <div className="dt">{String(e.date ?? '')}{e.soon && <span className="soon-tag">coming</span>}</div>
                  <div className="lb">{String(e.label ?? '')}</div>
                </div>
              ))}
            </div>
          </div>
        );
      }
      case 'facts': {
        const items: string[] = Array.isArray(d.items) ? d.items.slice(0, 3).map(String) : [];
        return (
          <ol className="nx-body nx-factlist">
            {items.map((x, i) => (
              <li key={i} style={{ '--d': `${(0.3 + i * 0.16).toFixed(2)}s` } as CSSProperties}>
                <span className="n">{pad2(i + 1)}</span><span className="t">{x}</span>
              </li>
            ))}
          </ol>
        );
      }
      case 'picture':
        return (
          <div className="nx-body nx-pic-text">
            {H}
            {d.caption && <p className="nx-cap">{String(d.caption)}</p>}
            {source && <div className="nx-via"><i />{source}</div>}
          </div>
        );
      default:
        return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sc, on, still, source]);

  if (sc.kind === 'picture') {
    return (
      <div className={`nx nx-picture ${shot ? 'has-pic' : 'no-pic'}`} ref={ref}>
        {shot && <div className={`nx-pic ${shot.hero ? 'hero' : 'cut'}`}><Picture shot={shot} /></div>}
        <div className="nx-pic-side">
          <Strip number={number} label={eyebrow} />
          {body}
        </div>
      </div>
    );
  }
  return (
    <div className={`nx nw-pad nx-${sc.kind}`} ref={ref}>
      <Strip number={number} label={eyebrow} />
      {sc.kind !== 'meaning' && sc.kind !== 'number' && sc.kind !== 'quote' && H}
      {body}
    </div>
  );
}

const DEFAULT_EYEBROW: Partial<Record<NewsScene['kind'], string>> = {
  number: 'By the numbers',
  quote: 'In their words',
  meaning: 'What it means',
  compare: 'Side by side',
  timeline: 'How it played out',
  facts: 'What to know',
  picture: 'Take a look',
};
