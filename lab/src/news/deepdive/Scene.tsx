/**
 * Deep Dive — renders ONE section full-bleed inside a `.dd-stage`.
 *
 * Used three ways: the live stage (animated, plays the video), the presenter's
 * "on screen now" monitor, and the editor's thumbnails (`still` — final state,
 * no motion, a still image instead of a video player).
 *
 * Animation is CSS (deepdive.css): every element carries `.dd-in` and a `--d`
 * delay in ms, so a section builds itself in order when it mounts. Re-keying
 * the scene replays it.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { youtubeEmbedUrl } from '../api';
import { sectionMedia, visualStill, NO_VISUAL, type Section, type Stat, type Visual } from './api';
import './deepdive.css';

/**
 * Kept as a hook so the pages' calls stay put. The deck uses Inter, which the
 * Lab's index.css already loads — Jake did not want Space Grotesk.
 */
export function useDeepDiveFont(): void {}

const d = (ms: number): CSSProperties => ({ ['--d' as string]: ms } as CSSProperties);

/**
 * Words that rise in one after another, starting at `start` ms.
 *
 * ⚠️ GRADIENT TEXT GOES ON EACH WORD (`wordClass="dd-grad"`), NEVER ON THE
 * PARENT. background-clip:text does not reach children that animate on their
 * own layer (transform + filter), so a gradient h1 over animated words
 * rendered the title slide's heading fully invisible on the first live run.
 */
function Words({ text, start = 0, step = 55, wordClass = '' }: { text: string; start?: number; step?: number; wordClass?: string }) {
  const words = text.split(/(\s+)/).filter((w) => w.length > 0);
  let n = 0;
  return (
    <>
      {words.map((w, i) => (/^\s+$/.test(w)
        ? <span key={i}>{w}</span>
        : <span key={i} className={`dd-word dd-in ${wordClass}`} style={d(start + step * n++)}>{w}</span>))}
    </>
  );
}

/** Statement text with the highlight phrases marked (case-insensitive). */
function Highlighted({ text, phrases, start }: { text: string; phrases: string[]; start: number }) {
  const parts: { t: string; mark: boolean }[] = [];
  const lower = text.toLowerCase();
  const hits: [number, number][] = [];
  for (const p of phrases) {
    const at = p ? lower.indexOf(p.toLowerCase()) : -1;
    if (at >= 0 && !hits.some(([a, b]) => at < b && at + p.length > a)) hits.push([at, at + p.length]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [a, b] of hits) {
    if (a > pos) parts.push({ t: text.slice(pos, a), mark: false });
    parts.push({ t: text.slice(a, b), mark: true });
    pos = b;
  }
  if (pos < text.length) parts.push({ t: text.slice(pos), mark: false });

  let wordIdx = 0;
  const step = 60;
  const totalWords = text.split(/\s+/).filter(Boolean).length;
  return (
    <>
      {parts.map((p, i) => {
        const startAt = start + step * wordIdx;
        wordIdx += p.t.split(/\s+/).filter(Boolean).length;
        return p.mark
          ? <span key={i} className="dd-mark" style={d(start + step * totalWords + 150)}><Words text={p.t} start={startAt} step={step} /></span>
          : <Words key={i} text={p.t} start={startAt} step={step} />;
      })}
    </>
  );
}

function formatNum(v: number, decimals: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** A number that counts up from 0 (ease-out), after `delay` ms. */
function CountUp({ value, decimals, delay, still }: { value: number; decimals: number; delay: number; still: boolean }) {
  const [shown, setShown] = useState(still ? value : 0);
  useEffect(() => {
    if (still) { setShown(value); return; }
    let raf = 0;
    const dur = 1600;
    const t0 = performance.now() + delay;
    const tick = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - t0) / dur));
      const eased = 1 - Math.pow(1 - p, 4);
      setShown(value * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, delay, still]);
  return <>{formatNum(shown, decimals)}</>;
}

function StatValue({ stat, delay, still }: { stat: Stat; delay: number; still: boolean }) {
  if (stat.value === null) return <>{stat.display || '—'}</>;
  return (
    <>
      {stat.prefix}
      <CountUp value={stat.value} decimals={stat.decimals} delay={delay} still={still} />
      {stat.suffix && <small>{stat.suffix}</small>}
    </>
  );
}

function Head({ section, start = 0 }: { section: Section; start?: number }) {
  return (
    <>
      {section.eyebrow && <div className="dd-eyebrow dd-in" style={d(start)}>{section.eyebrow}</div>}
      {section.heading && <h2 className="dd-h"><Words text={section.heading} start={start + 120} /></h2>}
    </>
  );
}

function SceneBody({ section, still, active }: { section: Section; still: boolean; active: boolean }) {
  const x = section.data;
  switch (section.kind) {
    case 'title':
      return (
        <div className="dd-scene-inner dd-title" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="dd-ring dd-in" style={d(0)} />
          <div className="dd-ring r2 dd-in" style={d(200)} />
          {x.kicker && <div><span className="dd-kicker dd-in" style={d(100)}>{x.kicker}</span></div>}
          <h1 className="dd-h"><Words text={section.heading} start={250} step={90} wordClass="dd-grad" /></h1>
          {x.subtitle && <p className="dd-sub dd-in" style={d(500 + 90 * section.heading.split(/\s+/).length)}>{x.subtitle}</p>}
        </div>
      );

    case 'statement':
      return (
        <div className="dd-statement">
          {(section.eyebrow || section.heading) && <div className="dd-eyebrow dd-in" style={d(0)}>{section.eyebrow || section.heading}</div>}
          <p className="dd-big"><Highlighted text={x.text || section.heading} phrases={x.highlight ?? []} start={150} /></p>
        </div>
      );

    case 'stats': {
      const stats = x.stats ?? [];
      const n = Math.max(1, stats.length);
      return (
        <div>
          <Head section={section} />
          <div className={`dd-stats n${n}`} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
            {stats.map((st, i) => {
              const delay = 500 + i * 220;
              return (
                <div key={i} className="dd-stat dd-in" style={d(delay)}>
                  <div className="dd-num dd-grad"><StatValue stat={st} delay={delay + 150} still={still} /></div>
                  <div className="dd-stat-label">{st.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    case 'bullets':
      return (
        <div>
          <Head section={section} />
          <div className="dd-points">
            {(x.points ?? []).map((p, i) => (
              <div key={i} className="dd-point dd-in" style={d(550 + i * 260)}>
                <span className="dd-point-n">{String(i + 1).padStart(2, '0')}</span>
                <span>{p}</span>
              </div>
            ))}
          </div>
        </div>
      );

    case 'takeaways': {
      const pts = x.points ?? [];
      return (
        <div className="dd-takeaways">
          <Head section={section} />
          <div className="dd-points" style={{ ['--cols' as string]: Math.min(4, Math.max(1, pts.length)) } as CSSProperties}>
            {pts.map((p, i) => (
              <div key={i} className="dd-point dd-pop" style={d(550 + i * 240)}>
                <span className="dd-point-n">{i + 1}</span>
                <span>{p}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'timeline': {
      const ev = x.events ?? [];
      const n = ev.length;
      return (
        <div>
          <Head section={section} />
          <div className="dd-tl">
            <div className="dd-tl-line" />
            {ev.map((e, i) => {
              // Evenly spaced, inset from the ends so the outer labels fit.
              const left = n === 1 ? 50 : 8 + (84 * i) / (n - 1);
              const delay = 450 + i * (1300 / Math.max(1, n));
              return (
                <div key={i} className={`dd-tl-ev ${i % 2 === 0 ? 'up' : 'down'}`} style={{ left: `${left}%` }}>
                  <div className="dd-tl-dot dd-pop" style={d(delay)} />
                  <div className="dd-tl-card dd-in" style={d(delay + 120)}>
                    <div className="dd-tl-date">{e.date}</div>
                    <div className="dd-tl-label">{e.label}</div>
                    {e.detail && <div className="dd-tl-detail">{e.detail}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    case 'compare': {
      const cols = x.columns ?? [];
      const win = typeof x.winner === 'number' ? x.winner : -1;
      return (
        <div>
          <Head section={section} />
          <div className="dd-cmp dd-in" style={{ ...d(450), gridTemplateColumns: `minmax(0, 0.8fr) repeat(${cols.length}, minmax(0, 1fr))` }}>
            <div className="dd-cmp-row dd-cmp-head">
              <div className="dd-cmp-cell" />
              {cols.map((c, i) => <div key={i} className={`dd-cmp-cell ${i === win ? 'win' : ''}`}>{c}</div>)}
            </div>
            {(x.rows ?? []).map((r, ri) => (
              <div key={ri} className="dd-cmp-row">
                <div className="dd-cmp-cell dd-cmp-label"><span className="dd-in" style={d(650 + ri * 200)}>{r.label}</span></div>
                {r.values.map((v, ci) => (
                  <div key={ci} className={`dd-cmp-cell ${ci === win ? 'win' : ''}`}>
                    <span className="dd-in" style={d(700 + ri * 200 + ci * 90)}>{v}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'bars': {
      const bars = x.bars ?? [];
      const max = Math.max(1, ...bars.map((b) => Math.abs(b.value)));
      const hl = typeof x.highlight === 'number' ? x.highlight : -1;
      return (
        <div>
          <Head section={section} />
          <div className="dd-bars">
            {bars.map((b, i) => {
              const delay = 500 + i * 180;
              const w = `${Math.max(1, (Math.abs(b.value) / max) * 78)}%`;
              return (
                <div key={i} className={`dd-bar ${i === hl ? 'hl' : ''}`}>
                  <div className="dd-bar-label dd-in" style={d(delay - 100)}>{b.label}</div>
                  <div className="dd-bar-track" style={{ ['--w' as string]: w } as CSSProperties}>
                    <div className="dd-bar-fill" style={d(delay)} />
                    <div className="dd-bar-val dd-in" style={d(delay + 700)}>
                      {b.display || <><CountUp value={b.value} decimals={Number.isInteger(b.value) ? 0 : 1} delay={delay} still={still} />{x.unit}</>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    case 'quote':
      return (
        <div>
          {section.eyebrow && <div className="dd-eyebrow dd-in" style={d(0)}>{section.eyebrow}</div>}
          <div className="dd-quote-mark dd-pop" style={d(100)}>“</div>
          <p className="dd-quote-text"><Words text={x.quote || section.heading} start={300} step={45} /></p>
          {(x.who || x.role) && (
            <div className="dd-quote-who dd-in" style={d(600 + 45 * (x.quote || '').split(/\s+/).length)}>
              <b>{x.who}</b>{x.role && <span>{x.role}</span>}
            </div>
          )}
        </div>
      );

    case 'media': {
      const media = sectionMedia(section);
      if (media) {
        // Live: the stage page owns the players (so the next one is already
        // loaded) and this scene is just the caption over it. Still or off-air:
        // the YouTube thumbnail.
        return (
          <>
            {(still || !active) && (
              <div className="dd-thumb" style={{ backgroundImage: section.videoId ? `url(https://i.ytimg.com/vi/${section.videoId}/hqdefault.jpg)` : undefined, backgroundColor: '#000' }}><div className="dd-play" /></div>
            )}
            <div className="dd-lower dd-in" style={d(still ? 0 : 900)}>
              {section.eyebrow && <div className="dd-eyebrow">{section.eyebrow}</div>}
              <div className="dd-lower-cap">{x.caption || section.heading}</div>
              {section.videoChannel && <div className="dd-lower-ch">▶ {section.videoChannel}</div>}
            </div>
          </>
        );
      }
      // No company video: show the best article instead.
      return (
        <div>
          <Head section={section} />
          {x.source?.title && (
            <div className="dd-article dd-in" style={d(600)}>
              <div className="dd-article-outlet">{x.source.outlet || 'Source'}</div>
              <div className="dd-article-title">{x.source.title}</div>
            </div>
          )}
        </div>
      );
    }
  }
}

/**
 * The section's real visual — screenshot, GIF, video file or a moment of the
 * company's video — in a window frame beside the text. Still (thumbnails,
 * off-air): the image / the clip's YouTube frame, nothing playing.
 */
function VisualFrame({ v, still }: { v: Visual; still: boolean }) {
  const clipSrc = v.kind === 'clip' && v.videoId ? `${youtubeEmbedUrl(v.videoId, { autoplay: true })}&start=${v.start ?? 0}` : '';
  return (
    <figure className="dd-vis dd-in" style={d(still ? 0 : 450)}>
      <div className={`dd-vis-frame ${v.kind === 'clip' ? 'clip' : ''}`}>
        {v.kind !== 'clip' && <div className="dd-vis-bar"><i /><i /><i /></div>}
        {v.kind === 'video'
          ? (still ? <video src={`${v.src}#t=1`} preload="metadata" muted playsInline /> : <video src={v.src} autoPlay muted loop playsInline />)
          : v.kind === 'clip'
            ? (still
              ? <img src={visualStill(v)} alt="" />
              // Same referrer rule as VideoEmbed: YouTube refuses an embed with no Referer.
              : <iframe src={clipSrc} title="Demo clip" allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" />)
            : <img src={v.src} alt="" className={v.kind === 'image' && !still ? 'dd-kb' : ''} />}
      </div>
      {v.credit && <figcaption>Source: {v.credit}</figcaption>}
    </figure>
  );
}

interface SceneProps {
  section: Section;
  index: number;
  total: number;
  /** The deep dive's title, for the footer. */
  title: string;
  /** Final state, no motion, no video player — thumbnails and monitors. */
  still?: boolean;
  /** Live on the stage, where the page plays the video behind this scene. False = show the thumbnail. */
  active?: boolean;
  /** Entering from the next section (moving backwards): animate downwards. */
  back?: boolean;
  /** Leaving: plays the exit animation. */
  leaving?: 'up' | 'down';
}

/** One section, with its chrome (counter, eyebrow line, footer). */
export function Scene({ section, index, total, title, still = false, active = true, back = false, leaving }: SceneProps) {
  const isMedia = section.kind === 'media' && !!sectionMedia(section);
  const vis = section.visual && !NO_VISUAL.has(section.kind) ? section.visual : null;
  return (
    <div className={`dd-scene ${back ? 'back' : ''} ${leaving ? `out-${leaving}` : ''}`} style={isMedia ? { padding: 0 } : undefined}>
      {!isMedia && section.kind !== 'title' && (
        // No "05 / 11" counter (Jake, 2026-10-01) — just the dive's title.
        <div className="dd-chrome-top dd-in" style={d(0)}>
          <span className="dd-chrome-dash" />
          <span>{title}</span>
        </div>
      )}
      {vis ? (
        <div className="dd-split">
          <div className="dd-split-text"><SceneBody section={section} still={still} active={active} /></div>
          <VisualFrame v={vis} still={still || !active} />
        </div>
      ) : <SceneBody section={section} still={still} active={active} />}
    </div>
  );
}

/** The animated background + progress rail around the scenes. */
export function StageFrame({ index, total, hue, still = false, children, footer }: {
  index: number; total: number; hue?: number; still?: boolean; children: ReactNode; footer?: ReactNode;
}) {
  // Each section nudges the aurora's colour a little, so the room changes as
  // the story moves without ever leaving the palette.
  const h = hue ?? ((index * 38) % 160) - 40;
  return (
    <div className={`dd-stage ${still ? 'dd-static' : ''}`}>
      <div className="dd-canvas">
        <div className="dd-bg" style={{ filter: `hue-rotate(${h}deg)` }}>
          <div className="dd-blob b1" />
          <div className="dd-blob b2" />
          <div className="dd-blob b3" />
          <div className="dd-grid" />
          <div className="dd-vignette" />
        </div>
        {children}
        {total > 1 && (
          <div className="dd-rail" aria-hidden>
            {Array.from({ length: total }).map((_, i) => <i key={i} className={i === index ? 'on' : i < index ? 'done' : ''} />)}
          </div>
        )}
        {footer && <div className="dd-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** A still 16:9 thumbnail of one section. */
export function SceneThumb({ section, index, total, title, className = '' }: { section: Section; index: number; total: number; title: string; className?: string }) {
  return (
    <div className={`relative aspect-video overflow-hidden rounded-md bg-black ${className}`}>
      <StageFrame index={index} total={total} still>
        <Scene section={section} index={index} total={total} title={title} still active={false} />
      </StageFrame>
    </div>
  );
}
