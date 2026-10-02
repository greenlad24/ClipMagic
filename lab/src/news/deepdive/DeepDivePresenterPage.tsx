/**
 * Deep Dive — the presenter's screen (/news-gatherer/deep-dive/:id/presenter).
 *
 * ⚠️ IT LOOKS LIKE THE DAILY SHOW'S /present/notes TELEPROMPTER ON PURPOSE
 * (Jake, 2026-10-01): same dark palette, same header bar (‹ n/N › · topic ·
 * controls · red End), same script column and font, same bottom controls bar
 * (Play/Pause · Speed · Size · Narrow/Medium/Wide). No monitor panel — the
 * presentation screen is the monitor. NotesPage itself is off-limits for
 * edits, so its look is copied here rather than shared.
 *
 * Keys (Jake's rule for both screens):
 *   ← / → (and a clicker's PageUp / PageDown)  previous / next section
 *   ↑ / ↓                                      nudge the script
 *   Space                                      play / pause the scroll
 *   1–9                                        jump to a section
 *   E                                          end
 *
 * ⚠️ THE SCROLL IS THE SAME ANCHOR PROTOCOL AS THE DAILY SHOW (../liveSync):
 * the server holds `position at time T + rate`, every screen solves it. The
 * rate is a fraction of THIS section's script per ms, so it is re-sent after
 * every section change and every layout change — a stale rate would scroll a
 * short script at a long script's pace.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useNewsTheme } from '../useNewsTheme';
import { useAuth } from '../auth';
import { startSession, getSession, endSession } from '../api';
import { connectLiveSync, type LiveSync } from '../liveSync';
import { getDeepDive, editorPath, stagePath, KIND_LABEL, type DeepDive, type Section } from './api';
import { flatten, firstBeatOf, scriptParts, beatCount } from './v2/types';
import { sectionsToChapters, CHAPTER_LABEL } from './v2/adapt';
import { sendBeat } from './v2/beatSync';

/** The /notes palette, verbatim. */
const D = {
  bg: '#0a0a0a', panel: '#111', card: '#1c1c1c', border: '#2a2a2a',
  text: '#f0f0f0', muted: '#777', faint: '#3a3a3a',
  blue: '#60a5fa', red: '#ef4444', orange: '#f97316', green: '#22c55e',
};
const SCRIPT_FONT = "'NewsScript', Arial, Helvetica, sans-serif";
type Width = 'narrow' | 'medium' | 'wide';
const WIDTH_PX: Record<Width, number> = { narrow: 420, medium: 660, wide: 960 };

const DEVICE_KEY = 'tp2-device-id';
const deviceId = (() => {
  try {
    let v = localStorage.getItem(DEVICE_KEY);
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, v); }
    return v;
  } catch { return undefined; }
})();

const btn: CSSProperties = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 4, padding: '2px 9px', fontSize: 11, cursor: 'pointer', color: D.muted, whiteSpace: 'nowrap' };

export default function DeepDivePresenterPage() {
  useNewsTheme(); // loads the NewsScript face, exactly as /notes does
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();

  const [dive, setDive] = useState<DeepDive | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [loadError, setLoadError] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [connected, setConnected] = useState(false);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2.5);
  const [fontSize, setFontSize] = useState(32);
  const [lineHeight, setLineHeight] = useState(1.9);
  const [width, setWidth] = useState<Width>('medium');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [startedAt] = useState(() => Date.now());

  const syncRef = useRef<LiveSync | null>(null);
  const tpRef = useRef<HTMLDivElement>(null);
  const lastProgRef = useRef(-1);
  const ref = useRef({ current: 0, count: 0, playing: false, speed: 2.5, fontSize: 32, lineHeight: 1.9 });
  // v2 (Jake, 2026-10-02): the sync index is a BEAT across the whole show;
  // the script belongs to the beat's chapter and only resets on a new chapter.
  const isV2 = dive?.format === 'v2';
  const chapters = useMemo(() => (isV2 ? sectionsToChapters(sections) : []), [isV2, sections]);
  const beats = useMemo(() => flatten(chapters), [chapters]);
  const count = isV2 ? beats.length : sections.length;
  const chapterIdx = isV2 ? (beats[Math.min(current, beats.length - 1)]?.chapter ?? 0) : current;
  const scrollKey = isV2 ? chapterIdx : current;
  ref.current = { current, count, playing, speed, fontSize, lineHeight };

  useEffect(() => {
    if (!authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [authLoading, user, loginWithRedirect]);

  // Content — refreshed so a script fixed in the editor mid-show shows up here.
  useEffect(() => {
    if (!user || !id) return;
    let alive = true;
    const load = () => getDeepDive(id)
      .then((r) => { if (alive) { setDive(r.deepDive); setSections(r.sections); } })
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [user, id]);

  // Join (or open) this dive's live session; it carries the last show's look.
  useEffect(() => {
    if (!user || !id) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await startSession({ deckId: id, controllerId: deviceId });
        if (cancelled) return;
        const st = await getSession({ sessionId: s.sessionId }).catch(() => null);
        const row = st?.session;
        if (!cancelled && row) {
          if (typeof row.currentSlideIndex === 'number') setCurrent(row.currentSlideIndex);
          if (typeof row.tpFontSize === 'number') setFontSize(row.tpFontSize);
          if (typeof row.tpLineHeight === 'number') setLineHeight(row.tpLineHeight);
          if (typeof row.tpSpeed === 'number') setSpeed(row.tpSpeed);
          if (row.tpWidth === 'narrow' || row.tpWidth === 'medium' || row.tpWidth === 'wide') setWidth(row.tpWidth);
        }
        if (!cancelled) setSessionId(s.sessionId);
      } catch (e) {
        toast.error(`Couldn't start the live session: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [user, id]);

  const rateFor = useCallback((spd: number): number => {
    const el = tpRef.current;
    const max = el ? el.scrollHeight - el.clientHeight : 0;
    return max > 0 ? (spd * 8) / max / 1000 : 0;
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const sync = connectLiveSync(sessionId);
    syncRef.current = sync;
    sync.socket.on('connect', () => setConnected(true));
    sync.socket.on('disconnect', () => setConnected(false));
    sync.onSync((snap) => {
      setPlaying(snap.isPlaying);
      if (typeof snap.scrollSpeed === 'number') setSpeed(snap.scrollSpeed);
      if (typeof snap.idx === 'number' && snap.idx !== ref.current.current) {
        setCurrent(Math.max(0, Math.min(Math.max(0, ref.current.count - 1), snap.idx)));
      }
      // A paused screen still follows a seek from elsewhere.
      if (!snap.isPlaying) {
        const el = tpRef.current;
        if (el) {
          const max = el.scrollHeight - el.clientHeight;
          if (max > 0) { lastProgRef.current = snap.position * max; el.scrollTop = snap.position * max; }
        }
      }
    });
    sync.onAppearance((a) => {
      if (typeof a.textSize === 'number') setFontSize(a.textSize);
      if (typeof a.lineHeight === 'number') setLineHeight(a.lineHeight);
      if (a.textWidth === 'narrow' || a.textWidth === 'medium' || a.textWidth === 'wide') setWidth(a.textWidth);
    });
    return () => { sync.close(); syncRef.current = null; setConnected(false); };
  }, [sessionId]);

  // The render loop: while playing, every frame solves the anchor.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = tpRef.current;
      const sync = syncRef.current;
      if (el && sync && ref.current.playing) {
        const max = el.scrollHeight - el.clientHeight;
        if (max > 0) {
          const top = sync.positionNow() * max;
          lastProgRef.current = top;
          el.scrollTop = top;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Jake scrolling the script himself (wheel / drag) re-anchors every screen.
  const onTpScroll = () => {
    const el = tpRef.current;
    const sync = syncRef.current;
    if (!el || !sync) return;
    if (Math.abs(el.scrollTop - lastProgRef.current) < 3) return; // our own write
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    lastProgRef.current = el.scrollTop;
    sync.seek(el.scrollTop / max);
  };

  // New section: top of its script.
  useEffect(() => {
    const el = tpRef.current;
    if (el) { lastProgRef.current = 0; el.scrollTop = 0; }
  }, [scrollKey]);
  // New section or new layout: a rate for THIS script's length.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (ref.current.playing) syncRef.current?.setSpeed(ref.current.speed, rateFor(ref.current.speed));
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollKey, fontSize, lineHeight, width, rateFor]);

  const go = useCallback((n: number) => {
    const total = ref.current.count;
    if (!total) return;
    const next = Math.max(0, Math.min(total - 1, n));
    const from = ref.current.current;
    if (next === from) return;
    setCurrent(next);
    // v2: a beat inside the same chapter keeps the script where it is.
    if (beatsRef.current.length) sendBeat(syncRef.current, beatsRef.current, from, next);
    else syncRef.current?.setSlide(next);
  }, []);

  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  const togglePlay = useCallback(() => {
    const sync = syncRef.current;
    if (!sync) return;
    const next = !ref.current.playing;
    if (next) sync.setSpeed(ref.current.speed, rateFor(ref.current.speed));
    sync.playPause(next);
  }, [rateFor]);

  const nudge = useCallback((dir: 1 | -1) => {
    const el = tpRef.current;
    const sync = syncRef.current;
    if (!el || !sync) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const step = ref.current.fontSize * ref.current.lineHeight * 3;
    sync.seek(Math.max(0, Math.min(1, sync.positionNow() + (dir * step) / max)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest('input, textarea')) return;
      const c = ref.current.current;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(c + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(c - 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(-1); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'e' || e.key === 'E') setConfirmEnd(true);
      else if (/^[1-9]$/.test(e.key)) go(chaptersRef.current.length ? firstBeatOf(chaptersRef.current, parseInt(e.key, 10) - 1) : parseInt(e.key, 10) - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, nudge, togglePlay]);

  const openScreen = () => {
    const w = window.open(stagePath(id, sessionId || undefined), 'dd-stage');
    if (!w) toast.error('The browser blocked the new window. Allow pop-ups for this site, or open the screen from the editor.');
  };

  const doEnd = async () => {
    if (!sessionId) return;
    try {
      await endSession({ sessionId, totalDurationSeconds: Math.round((Date.now() - startedAt) / 1000) });
      navigate(editorPath(id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const center = (msg: string) => (
    <div style={{ height: '100vh', background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: D.muted }}>{msg}</p>
    </div>
  );
  if (authLoading || !user) return center('Loading…');
  if (loadError) return center(loadError);
  if (!dive) return center('Loading…');
  if (!sections.length) return center('This deep dive has no sections yet. Generate it in the editor first.');

  const sec = sections[Math.min(chapterIdx, sections.length - 1)];
  const next = sections[chapterIdx + 1];
  const chapter = isV2 ? chapters[chapterIdx] : null;
  const beatNow = isV2 ? (beats[Math.min(current, beats.length - 1)]?.beat ?? 0) : 0;
  const parts = chapter ? scriptParts(chapter) : [];
  const kindLabel = (k: string) => (isV2 ? CHAPTER_LABEL[k as keyof typeof CHAPTER_LABEL] : KIND_LABEL[k as keyof typeof KIND_LABEL]) || k;
  const title = dive.title || dive.topic;
  const paragraphs = (sec.script || '').split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const atStart = current === 0;
  const atEnd = current >= count - 1;

  const setLook = (patch: { size?: number; width?: Width }) => {
    if (patch.size !== undefined) { setFontSize(patch.size); syncRef.current?.setTextSize(patch.size); }
    if (patch.width) { setWidth(patch.width); syncRef.current?.setTextWidth(patch.width); }
  };

  return (
    <div style={{ height: '100vh', background: D.bg, color: D.text, display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>

      {/* ── Header bar (as /notes) ─────────────────────────────────────── */}
      <header style={{ background: D.panel, borderBottom: `1px solid ${D.border}`, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button onClick={() => go(current - 1)} disabled={atStart} title="Previous section (←)"
            style={{ background: D.card, border: `1px solid ${D.border}`, color: atStart ? D.faint : D.text, borderRadius: 5, padding: '4px 10px', cursor: atStart ? 'not-allowed' : 'pointer', fontSize: 13 }}>‹
          </button>
          <span style={{ fontSize: 13, fontWeight: 600, color: D.text, whiteSpace: 'nowrap' }}>{isV2 ? `${chapterIdx + 1}.${beatNow + 1}` : current + 1} / {isV2 ? sections.length : sections.length}</span>
          <button onClick={() => go(current + 1)} disabled={atEnd} title="Next section (→)"
            style={{ background: D.card, border: `1px solid ${D.border}`, color: atEnd ? D.faint : D.text, borderRadius: 5, padding: '4px 10px', cursor: atEnd ? 'not-allowed' : 'pointer', fontSize: 13 }}>›
          </button>
        </div>

        <p style={{ flex: 1, fontSize: 12, color: D.muted, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          — {title}
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span title={connected ? 'Live sync connected' : 'Connecting…'}
            style={{ width: 7, height: 7, borderRadius: 99, background: connected ? D.green : D.orange }} />
          <button onClick={openScreen} disabled={!sessionId} title="Open the presentation screen (the audience view) in its own window"
            style={{ ...btn, color: D.blue, background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.35)' }}>
            ↗ Presentation screen
          </button>
          <div style={{ width: 1, height: 14, background: D.border }} />
          <button onClick={() => navigate(editorPath(id))} style={btn}>Editor</button>
          <button onClick={() => setConfirmEnd(true)}
            style={{ background: '#7f1d1d', border: '1px solid #991b1b', color: '#fecaca', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
            E End
          </button>
        </div>
      </header>

      {/* ── Teleprompter (as /notes) ───────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div
          ref={tpRef}
          onScroll={onTpScroll}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative', scrollbarWidth: 'thin', scrollbarColor: `${D.faint} transparent` }}
        >
          <div style={{ position: 'sticky', top: 10, zIndex: 10, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{
              background: 'rgba(17,17,17,0.85)', border: `1px solid ${playing ? 'rgba(96,165,250,0.35)' : D.border}`,
              borderRadius: 20, padding: '3px 14px', fontSize: 11, color: playing ? D.blue : D.muted, transition: 'all 0.2s',
            }}>
              {playing ? '▶ Scrolling' : '⏸ Paused'}
            </div>
          </div>

          <div style={{ maxWidth: WIDTH_PX[width], margin: '0 auto', padding: '44px 40px 0', position: 'relative' }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: D.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 28 }}>
              {chapterIdx + 1} / {sections.length} · {kindLabel(sec.kind)}{sec.heading ? ` · ${sec.heading.replace(/\*/g, '')}` : ''}
              {chapter && beatCount(chapter) > 1 ? ` · beat ${beatNow + 1} of ${beatCount(chapter)}` : ''}
            </p>

            {chapter ? parts.map((part, b) => (
              <div key={`${sec.id}:b${b}`} style={{ opacity: b < beatNow ? 0.35 : 1, transition: 'opacity .3s' }}>
                {b > 0 && (
                  <p style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', color: b === beatNow ? '#ffd21e' : D.faint, margin: `0 0 ${Math.round(fontSize * 0.5)}px`, fontFamily: 'system-ui, sans-serif' }}>
                    ▶ NEXT · BEAT {b + 1}
                  </p>
                )}
                {part.split(/\n+/).map((t) => t.trim()).filter(Boolean).map((para, i) => (
                  <p key={i} style={{
                    fontSize, lineHeight, color: '#ffffff', fontWeight: 400,
                    margin: `0 0 ${Math.round(fontSize * 0.8)}px`,
                    letterSpacing: '0.012em', fontFamily: SCRIPT_FONT, WebkitTextSizeAdjust: '100%',
                  } as CSSProperties}>{para}</p>
                ))}
              </div>
            )) : paragraphs.length ? paragraphs.map((para, i) => (
              <p key={`${sec.id}:${i}`} style={{
                fontSize, lineHeight, color: '#ffffff', fontWeight: 400,
                margin: `0 0 ${Math.round(fontSize * 0.8)}px`,
                letterSpacing: '0.012em', fontFamily: SCRIPT_FONT, WebkitTextSizeAdjust: '100%',
              } as CSSProperties}>
                {para}
              </p>
            )) : (
              <div style={{ textAlign: 'center', marginTop: 60 }}>
                <p style={{ fontSize: 18, color: D.muted, marginBottom: 8 }}>No script for this section.</p>
                <p style={{ fontSize: 13, color: D.faint }}>Write one in the editor.</p>
              </div>
            )}

            <p style={{ fontSize: 11, fontWeight: 700, color: D.faint, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 12 }}>
              {next ? `Next → ${(next.heading || kindLabel(next.kind)).replace(/\*/g, '')}` : 'End of the deep dive'}
            </p>

            {/* Bottom spacer so the last line can scroll to the top */}
            <div style={{ height: '70vh' }} />
          </div>
        </div>

        {/* ── Controls bar (as /notes) ──────────────────────────────────── */}
        <div style={{ background: D.panel, borderTop: `1px solid ${D.border}`, flexShrink: 0, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button onClick={togglePlay} disabled={!sessionId}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0,
              background: playing ? 'rgba(34,197,94,0.12)' : 'rgba(96,165,250,0.15)',
              border: `1px solid ${playing ? 'rgba(34,197,94,0.35)' : 'rgba(96,165,250,0.4)'}`,
              borderRadius: 6, padding: '4px 14px', cursor: 'pointer',
              color: playing ? D.green : D.blue, fontSize: 13, fontWeight: 600, letterSpacing: '0.02em', transition: 'all 0.15s',
            }}>
            <span style={{ fontSize: 15 }}>{playing ? '⏸' : '▶'}</span>
            {playing ? 'Pause' : 'Play'}
          </button>

          <span style={{ fontSize: 11, color: D.faint, marginRight: 4 }}>Speed</span>
          <input type="range" min={0.5} max={6} step={0.5} value={speed}
            onChange={(e) => { const v = parseFloat(e.target.value); setSpeed(v); syncRef.current?.setSpeed(v, rateFor(v)); }}
            style={{ width: 70, accentColor: D.blue }} />
          <span style={{ fontSize: 11, color: D.text, fontFamily: 'monospace', minWidth: 30 }}>{speed.toFixed(1)}×</span>

          <div style={{ width: 1, height: 14, background: D.border, margin: '0 4px' }} />

          <span style={{ fontSize: 11, color: D.faint, marginRight: 4 }}>Size</span>
          <input type="range" min={18} max={56} step={2} value={fontSize}
            onChange={(e) => setLook({ size: parseInt(e.target.value, 10) })}
            style={{ width: 70, accentColor: D.blue }} />
          <span style={{ fontSize: 11, color: D.text, fontFamily: 'monospace', minWidth: 30 }}>{fontSize}px</span>

          <div style={{ width: 1, height: 14, background: D.border, margin: '0 4px' }} />

          <div style={{ display: 'flex', border: `1px solid ${D.border}`, borderRadius: 4, overflow: 'hidden', fontSize: 10 }}>
            {(['narrow', 'medium', 'wide'] as const).map((w) => (
              <button key={w} onClick={() => setLook({ width: w })} style={{
                padding: '2px 8px', border: 'none', cursor: 'pointer',
                background: width === w ? 'rgba(96,165,250,0.15)' : 'transparent',
                color: width === w ? D.blue : D.muted,
                borderLeft: w !== 'narrow' ? `1px solid ${D.border}` : 'none',
              }}>{w[0].toUpperCase() + w.slice(1)}</button>
            ))}
          </div>

          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: D.faint }}>← → sections · ↑ ↓ script · Space scroll</span>
        </div>
      </div>

      <AlertDialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End the deep dive?</AlertDialogTitle>
            <AlertDialogDescription>The next time it opens, it starts again from the first section.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doEnd}>End</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
