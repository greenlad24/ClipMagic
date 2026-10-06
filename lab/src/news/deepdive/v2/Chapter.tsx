/**
 * Deep Dive v2 — renders ONE chapter at a given beat.
 *
 * The page that hosts it owns the beat (keys, live sync); this only draws.
 * `still` = final state with no motion and no video playing (thumbnails,
 * the presenter's monitor).
 *
 * ⚠️ SCREENSHOTS MUST STAY SHARP (Jake, 2026-10-02). Zooming by scaling a
 * screen-sized image UP blurs it. The demo camera lays the image out Z× larger
 * and scales it DOWN, and never zooms past the image's own pixels for this
 * screen (`zoomCap`). The article sheet is the same idea: 2× tiles, scaled down.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { assetUrl, type ArticleData, type Chapter, type ClipItem, type DemoTab, type StatItem } from './types';
import { paperFor, type DeckTemplate } from '../templates';
import './show.css';

/* ── helpers ─────────────────────────────────────────────────────────────── */

const UNDERLINE = 'M4 14 C 80 4, 160 18, 296 8';

/** A heading with its one *accent* phrase in italic serif + yellow underline. */
export function Accent({ text }: { text: string }) {
  const parts = text.split(/\*([^*]+)\*/);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1
        ? <span key={i} className="dd2-it">{p}<svg viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden><path d={UNDERLINE} /></svg></span>
        : <span key={i}>{p}</span>))}
    </>
  );
}

/** Element size, kept current. */
function useSize<T extends HTMLElement>(): [React.RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Counts up to `to` when `run` turns true (ease-out). */
function useCount(to: number, run: boolean, still: boolean, ms = 1200): number {
  const [v, setV] = useState(still ? to : 0);
  useEffect(() => {
    if (still || !run) { setV(still ? to : run ? to : 0); return; }
    let raf = 0;
    const t0 = performance.now();
    const f = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(to * (1 - Math.pow(1 - p, 4)));
      if (p < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [to, run, still, ms]);
  return v;
}

/** Big numbers go compact (1.2B, 450M) — "1,200,000,000" doesn't fit a screen. */
const fmt = (v: number, like: number) => {
  const a = Math.abs(like);
  if (a >= 1e9) return `${(v / 1e9).toFixed(v / 1e9 >= 10 ? 0 : 1).replace(/\.0$/, '')}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(v / 1e6 >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e5) return `${Math.round(v / 1e3)}K`;
  const dec = Number.isInteger(like) ? 0 : 1;
  return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
};

/* ── title ───────────────────────────────────────────────────────────────── */

export function DotField({ still }: { still: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let w = 0, h = 0, raf = 0;
    let pts: { x: number; y: number; r: number; v: number; y0: boolean }[] = [];
    const size = () => {
      const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
      w = r.width; h = r.height; cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round((w * h) / 9000);
      pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 2.2 + 0.4, v: Math.random() * 0.25 + 0.05, y0: Math.random() < 0.06 }));
    };
    // The field drifts in, then holds still (Jake 2026-10-06: nothing loops endlessly).
    let t0 = -1;
    const SETTLE_MS = 3500;
    const frame = (t: number) => {
      if (t0 < 0) t0 = t;
      const settled = still || t - t0 > SETTLE_MS;
      if (settled) t = t0 + SETTLE_MS;
      ctx.clearRect(0, 0, w, h);
      // The template's colours (templates.ts) — Jake's yellow + paper by default.
      const cs = getComputedStyle(cv);
      const acc = cs.getPropertyValue('--yellow').trim() || '#ffd21e';
      const fg = cs.getPropertyValue('--fg').trim() || '#f5f5f2';
      for (const p of pts) {
        if (!settled) { p.x += p.v; if (p.x > w + 4) p.x = -4; }
        const tw = 0.45 + 0.55 * Math.sin(t / 900 + p.x * 0.02);
        ctx.beginPath();
        ctx.arc(p.x, p.y + Math.sin(t / 1600 + p.x * 0.01) * 6, p.y0 ? p.r * 2.2 : p.r, 0, 7);
        ctx.globalAlpha = p.y0 ? 0.5 + 0.5 * tw : 0.1 + 0.25 * tw;
        ctx.fillStyle = p.y0 ? acc : fg;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!settled) raf = requestAnimationFrame(frame);
    };
    size();
    // A resize clears the canvas: redraw it (one frame once the field has settled).
    const ro = new ResizeObserver(() => { size(); cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); });
    ro.observe(cv);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [still]);
  return <canvas ref={ref} aria-hidden />;
}

function TitleChapter({ c, diveId, still, active, presenter }: { c: Chapter; diveId: string; still: boolean; active: boolean; presenter: string }) {
  const d = c.data;
  const hero = d.heroClip;
  return (
    <>
      <div className="dd2-hero-bg">
        {hero && (still || !active
          ? <img src={assetUrl(diveId, hero.poster)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.38 }} />
          : <video src={assetUrl(diveId, hero.file)} poster={assetUrl(diveId, hero.poster)} autoPlay muted loop playsInline />)}
        <DotField still={still || !active} />
      </div>
      <div className="dd2-wrap dd2-title" style={{ justifyContent: 'center' }}>
        <div><span className="dd2-chip"><span className="av">JD</span>{presenter}<span>· AI Deep Dive</span></span></div>
        <h1 className="dd2-h1"><Accent text={c.heading} /><span className="full">.</span></h1>
        {d.lede && <p className="dd2-lede">{d.lede}</p>}
        {!!d.agenda?.length && (
          <ol className="dd2-agenda">
            {d.agenda.map((a, i) => <li key={i}><b>{String(i + 1).padStart(2, '0')}</b>{a}</li>)}
          </ol>
        )}
      </div>
    </>
  );
}

/* ── demo player ─────────────────────────────────────────────────────────── */

function DemoPlayer({ tabs, beat, diveId, still, onBeat }: { tabs: DemoTab[]; beat: number; diveId: string; still: boolean; onBeat?: (b: number) => void }) {
  const flat = useMemo(() => tabs.flatMap((t, ti) => t.steps.map((_, si) => [ti, si] as const)), [tabs]);
  const [ti, si] = flat[Math.min(beat, flat.length - 1)] ?? [0, 0];
  const tab = tabs[ti];
  const step = tab?.steps[si];
  const [screenRef, size] = useSize<HTMLDivElement>();
  const rippleRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const r = rippleRef.current;
    if (!r || still) return;
    r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
  }, [beat, still]);

  if (!tab || !step) return null;
  const W = step.w || 1920, H = step.h || 1080;
  const cw = size.w || 1, ch = size.h || 1;
  const dpr = typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 1;
  // Never show the screenshot bigger than its own pixels (Jake: always sharp).
  const zoomCap = Math.max(1, (W * 1.05) / (cw * dpr));
  const [bx, by, bw, bh] = step.box ?? [0, 0, W, H];
  const sc = Math.max(1, Math.min(zoomCap, 2.6, Math.min(W / bw, H / bh) * 0.8));
  const Z = Math.max(1, Math.min(2.6, zoomCap));
  let tx = cw / 2 - ((bx + bw / 2) / W) * cw * sc;
  let ty = ch / 2 - ((by + bh / 2) / H) * ch * sc;
  tx = Math.min(0, Math.max(cw - cw * sc, tx));
  ty = Math.min(0, Math.max(ch - ch * sc, ty));
  const k = Z / sc;
  const camStyle: CSSProperties = { width: cw * Z, height: ch * Z, transform: `translate(${tx}px, ${ty}px) scale(${sc / Z})`, transition: still ? 'none' : undefined };
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  return (
    <div className="dd2-media">
      <div className="dd2-screenbox">
      <div className="dd2-screen" ref={screenRef} style={{ ['--ar' as string]: W / H } as CSSProperties}>
        <div className="dd2-cam" style={camStyle}>
          <img src={assetUrl(diveId, step.image)} alt={step.caption} draggable={false} />
          {step.box && <div className="dd2-spot" style={{ left: pct(bx, W), top: pct(by, H), width: pct(bw, W), height: pct(bh, H), borderWidth: 2 * k, borderRadius: 12 * k }} />}
          {step.click && (
            <div className="dd2-cursor" style={{ left: pct(step.click[0], W), top: pct(step.click[1], H) }}>
              <span ref={rippleRef} className="dd2-ripple" style={{ ['--rs' as string]: k } as CSSProperties} />
              <svg viewBox="0 0 24 24" style={{ transform: `scale(${k})` }}><path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.7 L11 13.4 L17.5 13.4 Z" fill="#fff" stroke="#000" strokeWidth="1.4" strokeLinejoin="round" /></svg>
            </div>
          )}
        </div>
        <span className={`dd2-live ${tab.source === 'agent' ? 'agent' : ''}`}><i />{tab.source === 'agent' ? 'AI AGENT · REAL RUN' : 'DEMO'}</span>
        <div className="dd2-cap"><div key={beat}><small>Step {si + 1} of {tab.steps.length}{step.label ? ` · ${step.label}` : ''}</small>{step.caption}</div></div>
      </div>
      </div>
      <aside>
        <div className="dd2-who"><span className="blob" style={{ background: tab.color }} /><div><b>{tab.name}</b><span>{tab.job}</span></div></div>
        <ol className="dd2-steps">
          {tab.steps.map((s, i) => (
            <li key={i} className={i < si ? 'done' : i === si ? 'on' : ''} onClick={() => onBeat?.(flat.findIndex(([a, b]) => a === ti && b === i))}>
              <b>{i + 1}</b><span>{s.caption}</span>
            </li>
          ))}
        </ol>
        {tab.credit && <div className="dd2-credit">{tab.credit}</div>}
      </aside>
    </div>
  );
}

/* ── clip player ─────────────────────────────────────────────────────────── */

function ClipPlayer({ clips, beat, diveId, still, active, onBeat }: { clips: ClipItem[]; beat: number; diveId: string; still: boolean; active: boolean; onBeat?: (b: number) => void }) {
  const i = Math.min(beat, clips.length - 1);
  const clip = clips[i];
  const vref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = vref.current;
    if (!v) return;
    if (active && !still) { v.currentTime = 0; void v.play().catch(() => {}); } else v.pause();
  }, [i, active, still]);
  if (!clip) return null;
  return (
    <div className="dd2-media">
      <div className="dd2-screenbox">
      <div className="dd2-screen" style={{ ['--ar' as string]: (clip.w || 16) / (clip.h || 9) } as CSSProperties}>
        {still || !active
          ? <img src={assetUrl(diveId, clip.poster)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          : <video key={clip.file} ref={vref} src={assetUrl(diveId, clip.file)} poster={assetUrl(diveId, clip.poster)} muted loop playsInline autoPlay preload="auto" />}
        <span className="dd2-live"><i />OFFICIAL VIDEO</span>
        <div className="dd2-cap"><div key={i}><small>{clip.label || `Clip ${i + 1} of ${clips.length}`}</small>{clip.caption}</div></div>
        {/* the next clip, so stepping never shows a black frame */}
        {!still && active && clips[i + 1] && <link rel="preload" as="video" href={assetUrl(diveId, clips[i + 1].file)} />}
      </div>
      </div>
      <aside>
        <ol className="dd2-steps">
          {clips.map((c, k) => (
            <li key={k} className={k < i ? 'done' : k === i ? 'on' : ''} onClick={() => onBeat?.(k)}><b>{k + 1}</b><span>{c.caption}</span></li>
          ))}
        </ol>
        {clip.credit && <div className="dd2-credit">{clip.credit}</div>}
      </aside>
    </div>
  );
}

/* ── article showcase ────────────────────────────────────────────────────── */

function ArticleShowcase({ a, beat, diveId, still }: { a: ArticleData; beat: number; diveId: string; still: boolean }) {
  const [pageRef, size] = useSize<HTMLDivElement>();
  const hl = a.highlights[Math.min(beat, a.highlights.length - 1)];
  const scale = (size.w || 1) / (a.width || 1280);
  const viewH = size.h || 1;
  let ty = 0;
  if (hl) ty = -(hl.y * scale - viewH * 0.3);
  ty = Math.min(0, Math.max(-(a.height * scale - viewH), ty));
  let host = a.site;
  try { host = new URL(a.url).host.replace(/^www\./, ''); } catch { /* keep site */ }
  return (
    <div className="dd2-browser">
      <div className="dd2-bar"><i /><i /><i /><div className="dd2-url">{host}{(() => { try { return new URL(a.url).pathname; } catch { return ''; } })()}</div></div>
      <div className="dd2-page" ref={pageRef}>
        <div className="dd2-sheet" style={{ width: a.width, height: a.height, transform: `translateY(${ty}px) scale(${scale})`, transition: still ? 'none' : undefined }}>
          {a.tiles.map((t) => <img key={t.file} src={assetUrl(diveId, t.file)} alt="" style={{ top: t.y, height: t.h }} draggable={false} />)}
          {hl && <div className="dd2-hl" style={{ left: hl.x - 8, top: hl.y - 6, width: hl.w + 16, height: hl.h + 12 }} />}
        </div>
        {hl?.caption && <div className="dd2-cap"><div key={beat}><small>{a.site || host} · Official post</small>{hl.caption}</div></div>}
      </div>
    </div>
  );
}

/* ── reveal cards ────────────────────────────────────────────────────────── */

function RevealCard({ card, shown, still }: { card: NonNullable<Chapter['data']['cards']>[number]; shown: boolean; still: boolean }) {
  const isNum = typeof card.countTo === 'number';
  const v = useCount(isNum ? (card.countTo as number) : 0, shown, still);
  const words = !isNum && card.big.length > 8;
  return (
    <div className={`dd2-card t-${card.tone || 'dark'} ${shown ? '' : 'hid'}`}>
      <span className="q">?</span>
      {card.tag && <span className="tag">{card.tag}</span>}
      <div className="name">{card.name}</div>
      {card.note && <div className="note">{card.note}</div>}
      <div className={`big ${words ? 'words' : ''}`}>
        {isNum ? <>{card.prefix}{fmt(v, card.countTo as number)}{card.suffix && <small>{card.suffix}</small>}</> : card.big}
      </div>
      {card.small && <div className="small">{card.small}</div>}
    </div>
  );
}

/* ── stats ───────────────────────────────────────────────────────────────── */

function StatField({ stat, still, active }: { stat: StatItem; still: boolean; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const to = stat.value ?? 0;
  const v = useCount(to, active, still, 1500);
  const frac = to > 0 ? v / to : 1;
  // ⚠️ Re-measure on every draw AND on resize: a size taken before layout
  // settled drew the grid squashed into vertical stripes.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(cv);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    if (r.width < 4 || r.height < 4) return;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    // Square-ish cells whatever the box's shape: ~4,000 dots.
    const cell = Math.sqrt((r.width * r.height) / 4000);
    const cols = Math.max(10, Math.round(r.width / cell)), rows = Math.max(4, Math.round(r.height / cell));
    const gx = r.width / cols, gy = r.height / rows, rad = Math.max(1, Math.min(gx, gy) * 0.28);
    const n = cols * rows;
    const lit = Math.round(n * frac);
    const cs = getComputedStyle(cv);
    const acc = cs.getPropertyValue('--yellow').trim() || '#ffd21e';
    const fg = cs.getPropertyValue('--fg').trim() || '#f5f5f2';
    const off = cs.getPropertyValue('--card-2').trim() || '#222226';
    for (let i = 0; i < n; i++) {
      // a stable scatter order, so the field fills like rain, not like a progress bar
      const k = (i * 7919) % n;
      ctx.beginPath();
      ctx.arc((k % cols + 0.5) * gx, (Math.floor(k / cols) + 0.5) * gy, rad, 0, 7);
      ctx.fillStyle = i < lit ? (k % 97 === 0 ? acc : fg) : off;
      ctx.fill();
    }
  }, [frac, tick]);
  return (
    <div className="dd2-field">
      <canvas ref={ref} aria-hidden />
      <div className="ov"><div>
        <b>{stat.value === null ? stat.display : <>{stat.prefix}{fmt(v, to)}{v >= to ? stat.suffix : ''}</>}</b>
        <span>{stat.label}</span>
      </div></div>
    </div>
  );
}

/* ── the chapter ─────────────────────────────────────────────────────────── */

export interface ChapterProps {
  chapter: Chapter;
  index: number;
  beat: number;
  diveId: string;
  /** The one on screen now: plays video, runs counters. */
  active: boolean;
  still?: boolean;
  /** Whether this chapter sits on paper (alternates by position). */
  paper?: boolean;
  presenter?: string;
  onBeat?: (beat: number) => void;
  /** Stage only: start the demo agent live. */
  onRunLive?: () => void;
}

export function ChapterView({ chapter: c, index, beat, diveId, active, still = false, paper = false, presenter = 'Jake Dawson', onBeat, onRunLive }: ChapterProps) {
  const d = c.data || {};
  const cls = `dd2-ch k-${c.kind} ${paper ? 'paper' : ''} ${active ? 'on' : ''}`;

  if (c.kind === 'title') {
    return <section className={cls}><TitleChapter c={c} diveId={diveId} still={still} active={active} presenter={presenter} /></section>;
  }

  const head = (
    <div className="dd2-head">
      <div className="dd2-num">{String(index).padStart(2, '0')}</div>
      <div>
        {c.eyebrow && <div className="dd2-eyebrow">{c.eyebrow}</div>}
        <h2 className="dd2-h"><Accent text={c.heading} />.</h2>
      </div>
      {c.island && <div className="dd2-island"><span className="q">{c.island.q}</span><span className="d3"><i /><i /><i /></span><span className="a">{c.island.a}</span></div>}
    </div>
  );

  let tabs: ReactNode = null;
  let body: ReactNode = null;

  switch (c.kind) {
    case 'demo': {
      const t = d.tabs ?? [];
      const flat = t.flatMap((x, ti) => x.steps.map(() => ti));
      const cur = flat[Math.min(beat, flat.length - 1)] ?? 0;
      const agent = t.some((x) => x.source === 'agent');
      tabs = (t.length > 1 || (agent && onRunLive && !still)) && (
        <div className="dd2-tabs">
          {t.map((x, i) => (
            <button key={i} className={`dd2-tab ${i === cur ? 'on' : ''}`} onClick={() => onBeat?.(flat.indexOf(i))}>
              <b>{i + 1}</b><span className="dot" style={{ background: x.color }} />{x.name}{x.job ? ` · ${x.job}` : ''}
            </button>
          ))}
          <span className="sp" />
          {agent && onRunLive && !still && (
            <button className="dd2-tab on" style={{ color: 'var(--yellow)' }} onClick={onRunLive} title="The AI agent does it again, live (L)">▶ Run it live <b>L</b></button>
          )}
        </div>
      );
      body = <DemoPlayer tabs={t} beat={beat} diveId={diveId} still={still} onBeat={onBeat} />;
      break;
    }
    case 'clip':
      body = <ClipPlayer clips={d.clips ?? []} beat={beat} diveId={diveId} still={still} active={active} onBeat={onBeat} />;
      break;
    case 'article':
      body = d.article ? <ArticleShowcase a={d.article} beat={beat} diveId={diveId} still={still} /> : null;
      break;
    case 'reveal': {
      const cards = d.cards ?? [];
      const gate = !!(d.good?.length || d.bad?.length);
      const cols = cards.length <= 3 ? cards.length : 2;
      tabs = (
        <div className="dd2-tabs">
          {cards.map((x, i) => <button key={i} className={`dd2-tab ${i === Math.min(beat, cards.length - 1) ? 'on' : ''}`} onClick={() => onBeat?.(i)}><b>{i}</b>{x.name}</button>)}
          {gate && <button className={`dd2-tab ${beat >= cards.length ? 'on' : ''}`} onClick={() => onBeat?.(cards.length)}><b>{cards.length}</b>Who can get it</button>}
          <span className="sp" />
        </div>
      );
      body = (
        <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) auto', height: '100%', minHeight: 0 }}>
          <div className="dd2-cards" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))` }}>
            {cards.map((x, i) => <RevealCard key={i} card={x} shown={still || beat >= i} still={still} />)}
          </div>
          {gate && (
            <div className={`dd2-gate ${still || beat >= cards.length ? 'on' : ''}`}>
              {(d.good ?? []).map((g, i) => <span key={`g${i}`}>✓ {g}</span>)}
              {(d.bad ?? []).map((g, i) => <span key={`b${i}`} className="no">✕ {g}</span>)}
            </div>
          )}
        </div>
      );
      break;
    }
    case 'stats': {
      const stats = d.stats ?? [];
      const i = Math.min(beat, stats.length - 1);
      body = (
        <div className="dd2-statsbody">
          {stats[i] && <StatField key={i} stat={stats[i]} still={still} active={active} />}
          {stats.length > 1 && (
            <div className="dd2-facts" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
              {stats.map((s, k) => (
                <div key={k} className={`dd2-fact ${still || k <= i ? 'on' : ''}`}>
                  <b>{s.value === null ? s.display : `${s.prefix ?? ''}${fmt(s.value, s.value)}${s.suffix ?? ''}`}</b><span>{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
      break;
    }
    case 'versus': {
      const opts = d.options ?? [];
      const i = Math.min(beat, opts.length - 1);
      tabs = (
        <div className="dd2-tabs">
          {opts.map((o, k) => <button key={k} className={`dd2-tab ${k === i ? 'on' : ''}`} onClick={() => onBeat?.(k)}><b>{k}</b>{o.name}</button>)}
          <span className="sp" />
        </div>
      );
      body = (
        <div className="dd2-vs" style={{ gridTemplateColumns: `repeat(${opts.length}, minmax(0, 1fr))` }}>
          {opts.map((o, k) => (
            <div key={k} className={`opt ${still || k === i ? 'on' : ''}`}>
              <b>{o.name}</b><span>{o.line}</span>
              {!!o.points?.length && <ul>{o.points.map((p, j) => <li key={j}>{p}</li>)}</ul>}
            </div>
          ))}
        </div>
      );
      break;
    }
    case 'flow': {
      const steps = d.steps ?? [];
      body = (
        <div className="dd2-flow" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((s, k) => (
            <div key={k} className={`dd2-beat ${still || k <= beat ? 'on' : ''} ${k === beat ? 'cur' : ''}`}>
              <div className="t">{k + 1} · {s.label}</div>
              <div className="big">{s.text}</div>
              <div className="n">{String(k + 1).padStart(2, '0')}</div>
            </div>
          ))}
        </div>
      );
      break;
    }
    case 'timeline': {
      const ev = d.events ?? [];
      const on = still ? ev.length - 1 : beat;
      body = (
        <div className="dd2-tl" style={{ gridTemplateColumns: `repeat(${ev.length}, minmax(0, 1fr))` }}>
          <span className="bar" style={{ width: ev.length > 1 ? `${(Math.max(0, on) / (ev.length - 1)) * 100 * ((ev.length - 1) / ev.length)}%` : '0' }} />
          {ev.map((e, k) => (
            <div key={k} className={`dd2-ev ${k <= on ? 'on' : ''} ${e.soon ? 'soon' : ''}`}>
              <div className="d">{e.date}</div><b>{e.label}</b>{e.detail && <span>{e.detail}</span>}
            </div>
          ))}
        </div>
      );
      break;
    }
    case 'list': {
      const items = d.items ?? [];
      body = (
        <div className={`dd2-list ${d.image ? '' : 'noimg'}`}>
          <ul>
            {items.map((t, k) => (
              <li key={k} className={`${still || k <= beat ? 'on' : ''} ${!still && k === beat ? 'cur' : ''}`} onClick={() => onBeat?.(k)}>
                <b>{String(k + 1).padStart(2, '0')}</b>{t}
              </li>
            ))}
          </ul>
          {d.image && <div className="dd2-pic"><img src={assetUrl(diveId, d.image.file)} alt="" style={{ maxWidth: d.image.w ? d.image.w / Math.min(2, window.devicePixelRatio || 1) : undefined, margin: '0 auto' }} /></div>}
        </div>
      );
      break;
    }
    case 'quote':
      body = (
        <div className="dd2-quote">
          <p>{d.quote}</p>
          {(d.who || d.role) && <div className="who">{d.who}{d.role && <span>{d.role}</span>}</div>}
        </div>
      );
      break;
    case 'takeaways': {
      const pts = d.points ?? [];
      return (
        <section className={cls}>
          <div className="dd2-wrap">
            {head}
            <div className="dd2-takes" style={{ gridTemplateColumns: `repeat(${Math.max(1, pts.length)}, minmax(0, 1fr))` }}>
              {pts.map((p, k) => (
                <div key={k} className={`dd2-take ${still || k <= beat ? 'on' : ''}`} onClick={() => onBeat?.(k)}>
                  <div className="in">
                    <div className="f"><b>{String(k + 1).padStart(2, '0')}</b></div>
                    <div className="b"><span>{String(k + 1).padStart(2, '0')}</span><b>{p}</b></div>
                  </div>
                </div>
              ))}
            </div>
            <div className="dd2-end"><b>Use AI like the pros. <span className="dd2-it">No BS<svg viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden><path d={UNDERLINE} /></svg></span>.</b><a href="https://jakedaw.com" target="_blank" rel="noreferrer">jakedaw.com</a></div>
          </div>
        </section>
      );
    }
  }

  return (
    <section className={cls}>
      <div className="dd2-wrap">
        {head}
        <div className="dd2-stage">
          {tabs}
          <div className="dd2-body">{body}</div>
        </div>
        {d.credit && c.kind !== 'demo' && c.kind !== 'clip' && <div className="dd2-credit">{d.credit}</div>}
      </div>
    </section>
  );
}

/**
 * Paper or black: alternate by position, title always black — or the
 * template's rhythm when one is given (templates.ts: all dark / all light).
 */
export const isPaper = (chapters: Chapter[], i: number, template?: DeckTemplate) =>
  template ? paperFor(template, i, chapters[i]?.kind === 'title') : chapters[i]?.kind !== 'title' && i % 2 === 0;
