/**
 * The presenter's chrome — ONE set of controls for every show Jake presents
 * from: the Daily Show's /present/notes (pages/NotesPage.tsx) and the Deep
 * Dive presenter (deepdive/DeepDivePresenterPage.tsx).
 *
 * Jake, 2026-10-06: the deep dive presenter "should look like the AI news
 * presenter", follower link and all. These pieces were lifted out of NotesPage
 * VERBATIM (same markup, same inline styles), so the Daily Show looks and
 * behaves exactly as it did, and the Deep Dive cannot drift from it: a change
 * here changes both.
 *
 * Only presentational pieces live here. What a button DOES (navigate a deck,
 * step a beat, publish a speed over the socket) stays with each page, because
 * the two shows have different state.
 */
import type { CSSProperties, ReactNode } from 'react';
import { toast } from 'sonner';

/** The presenter palette (dark, whatever the rest of the app is doing). */
export const D = {
  bg: '#0a0a0a', panel: '#111', card: '#1c1c1c', border: '#2a2a2a',
  text: '#f0f0f0', muted: '#777', faint: '#3a3a3a',
  blue: '#60a5fa', red: '#ef4444', orange: '#f97316', green: '#22c55e',
};

/**
 * The script face — ⚠️ SHARED WITH THE PUBLIC FOLLOWER PAGE
 * (server/src/news/followerPage.ts) and the standalone teleprompter. A
 * different font or letter-spacing wraps the same script at different words,
 * so two screens show different lines while their scroll positions agree.
 */
export const SCRIPT_FONT = "'NewsScript', Arial, Helvetica, sans-serif";

export type TpWidth = 'wide' | 'medium' | 'narrow';
export const WIDTH_PX: Record<TpWidth, number> = { narrow: 420, medium: 660, wide: 960 };

/**
 * The public follower link for a live session — the SAME page for both shows.
 * The session id is the credential (see server/src/news/routes.ts
 * `followerRouter`), so this link is what a phone needs and all it gets.
 */
export const followerUrl = (sessionId: string): string =>
  `${window.location.origin}/news-gatherer/present/teleprompter?follow=1&session=${sessionId}`;

/** A thin vertical rule between groups. `spaced` = the bottom bar's variant. */
export function Divider({ spaced = false }: { spaced?: boolean }) {
  return <div style={{ width: 1, height: 14, background: D.border, ...(spaced ? { margin: '0 4px' } : {}) }} />;
}

/** ‹ label › — the header's stepper. */
export function NavStepper({ label, onPrev, onNext, prevDisabled, nextDisabled, prevTitle, nextTitle }: {
  label: ReactNode;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  prevTitle?: string;
  nextTitle?: string;
}) {
  const arrow = (disabled: boolean): CSSProperties => ({
    background: D.card, border: `1px solid ${D.border}`, color: disabled ? D.faint : D.text, borderRadius: 5,
    padding: '4px 10px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13,
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <button onClick={onPrev} disabled={prevDisabled} title={prevTitle} style={arrow(prevDisabled)}>‹
      </button>
      <span style={{ fontSize: 13, fontWeight: 600, color: D.text, whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <button onClick={onNext} disabled={nextDisabled} title={nextTitle} style={arrow(nextDisabled)}>›
      </button>
    </div>
  );
}

/** "— topic" — the header's middle, truncating. */
export function TopicLabel({ children }: { children: ReactNode }) {
  return (
    <p style={{ flex: 1, fontSize: 12, color: D.muted, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
      — {children}
    </p>
  );
}

export type ViewMode = 'notes' | 'teleprompter';

/** Notes | Teleprompter. */
export function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const isTeleprompter = mode === 'teleprompter';
  return (
    <div style={{ display: 'flex', border: `1px solid ${D.border}`, borderRadius: 4, overflow: 'hidden', fontSize: 11 }}>
      <button
        onClick={() => onChange('notes')}
        style={{ padding: '2px 10px', background: !isTeleprompter ? D.card : 'transparent', color: !isTeleprompter ? D.text : D.muted, cursor: 'pointer', border: 'none' }}>
        Notes
      </button>
      <button
        onClick={() => onChange('teleprompter')}
        style={{ padding: '2px 10px', background: isTeleprompter ? 'rgba(96,165,250,0.12)' : 'transparent', color: isTeleprompter ? D.blue : D.muted, cursor: 'pointer', border: 'none', borderLeft: `1px solid ${D.border}` }}>
        Teleprompter
      </button>
    </div>
  );
}

/**
 * 📱 Follower link — copies the public follower URL for this session.
 * `synced` flashes "⟳ Synced" when another device just moved the show.
 * `getSessionId` is read at click time (the session can arrive after render).
 */
export function FollowerLinkButton({ getSessionId, synced = false }: { getSessionId: () => string | null | undefined; synced?: boolean }) {
  return (
    <button
      data-follower-link
      onClick={() => {
        const sid = getSessionId();
        const url = sid ? followerUrl(sid) : window.location.href;
        navigator.clipboard.writeText(url).then(() => {
          toast.success('Follower link copied! Open it on your phone or iPad.');
        }, () => {
          // No clipboard (an insecure origin or a denied permission): show the
          // link instead of failing silently.
          toast.message('Follower link', { description: url, duration: 20000 });
        });
      }}
      title="Copy a follower link — read-only, follows this monitor"
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        background: synced ? 'rgba(96,165,250,0.12)' : D.card,
        border: `1px solid ${synced ? 'rgba(96,165,250,0.4)' : D.border}`,
        borderRadius: 4, padding: '2px 9px', fontSize: 11, cursor: 'pointer',
        color: synced ? D.blue : D.muted, whiteSpace: 'nowrap',
        transition: 'all 0.3s',
      }}>
      <span style={{ fontSize: 10 }}>{synced ? '⟳' : '📱'}</span>
      {synced ? 'Synced' : 'Follower link'}
    </button>
  );
}

/** ↗ Source — latched: while on, the source tab follows the show. */
export function SourceButton({ enabled, blocked, onClick }: { enabled: boolean; blocked: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={enabled ? 'Source tab is following — click to turn off' : 'Open source article in a controlled tab'}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        background: blocked ? 'rgba(239,68,68,0.08)' : enabled ? 'rgba(96,165,250,0.08)' : D.card,
        border: `1px solid ${blocked ? 'rgba(239,68,68,0.35)' : enabled ? 'rgba(96,165,250,0.35)' : D.border}`,
        borderRadius: 4, padding: '2px 9px', fontSize: 11, cursor: 'pointer',
        color: blocked ? D.red : enabled ? D.blue : D.muted, whiteSpace: 'nowrap',
      }}>
      <span style={{ fontSize: 7 }}>{'●'}</span>
      {blocked ? 'Source blocked' : enabled ? 'Source following' : '↗ Source'}
    </button>
  );
}

/** "↗ Screen" — opens the presentation screen (the audience view) in its own window. */
export function ScreenButton({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} title="Open the presentation screen (the audience view) in its own window"
      style={{ background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.35)', borderRadius: 4, padding: '2px 9px',
        fontSize: 11, cursor: disabled ? 'default' : 'pointer', color: D.blue, whiteSpace: 'nowrap', opacity: disabled ? 0.5 : 1 }}>
      ↗ Screen
    </button>
  );
}

/** The red "E End". */
export function EndButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ background: '#7f1d1d', border: '1px solid #991b1b', color: '#fecaca', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
      E End
    </button>
  );
}

/** The sticky "⏸ Paused / ▶ Scrolling" pill at the top of the script. */
export function ScrollPill({ paused }: { paused: boolean }) {
  return (
    <div style={{ position: 'sticky', top: 10, zIndex: 10, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{
        background: 'rgba(17,17,17,0.85)', border: `1px solid ${paused ? D.border : 'rgba(96,165,250,0.35)'}`,
        borderRadius: 20, padding: '3px 14px', fontSize: 11,
        color: paused ? D.muted : D.blue,
        transition: 'all 0.2s',
      }}>
        {paused ? '⏸ Paused' : '▶ Scrolling'}
      </div>
    </div>
  );
}

/** The bottom bar's container. */
export function ControlsBar({ children }: { children: ReactNode }) {
  return (
    <div style={{ background: D.panel, borderTop: `1px solid ${D.border}`, flexShrink: 0, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
      {children}
    </div>
  );
}

/** ▶ Play / ⏸ Pause. ONE path for play/pause per page — the space bar calls the same handler. */
export function PlayButton({ paused, onClick }: { paused: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0,
        background: paused ? 'rgba(96,165,250,0.15)' : 'rgba(34,197,94,0.12)',
        border: `1px solid ${paused ? 'rgba(96,165,250,0.4)' : 'rgba(34,197,94,0.35)'}`,
        borderRadius: 6, padding: '4px 14px', cursor: 'pointer',
        color: paused ? D.blue : D.green,
        fontSize: 13, fontWeight: 600, letterSpacing: '0.02em',
        transition: 'all 0.15s',
      }}
    >
      <span style={{ fontSize: 15 }}>{paused ? '▶' : '⏸'}</span>
      {paused ? 'Play' : 'Pause'}
    </button>
  );
}

/** Speed slider (0.5–6×). */
export function SpeedControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <>
      <span style={{ fontSize: 11, color: D.faint, marginRight: 4 }}>Speed</span>
      <input type="range" min={0.5} max={6} step={0.5} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: 70, accentColor: D.blue }} />
      <span style={{ fontSize: 11, color: D.text, fontFamily: 'monospace', minWidth: 30 }}>{value.toFixed(1)}×</span>
    </>
  );
}

/** Text size slider (18–56px). */
export function SizeControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <>
      <span style={{ fontSize: 11, color: D.faint, marginRight: 4 }}>Size</span>
      <input type="range" min={18} max={56} step={2} value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        style={{ width: 70, accentColor: D.blue }} />
      <span style={{ fontSize: 11, color: D.text, fontFamily: 'monospace', minWidth: 30 }}>{value}px</span>
    </>
  );
}

/** Narrow | Medium | Wide. */
export function WidthToggle({ value, onChange }: { value: TpWidth; onChange: (w: TpWidth) => void }) {
  return (
    <div style={{ display: 'flex', border: `1px solid ${D.border}`, borderRadius: 4, overflow: 'hidden', fontSize: 10 }}>
      {(['narrow', 'medium', 'wide'] as const).map(w => (
        <button key={w} onClick={() => onChange(w)} style={{
          padding: '2px 8px', border: 'none', cursor: 'pointer',
          background: value === w ? 'rgba(96,165,250,0.15)' : 'transparent',
          color: value === w ? D.blue : D.muted,
          borderLeft: w !== 'narrow' ? `1px solid ${D.border}` : 'none',
        }}>{w[0].toUpperCase() + w.slice(1)}</button>
      ))}
    </div>
  );
}

/**
 * The beat pills + "next <label>". `next` is what the following → shows
 * (already worded: a beat's label, "story 4", "section 5"); null = the last beat.
 */
export function BeatDots({ cur, total, next, title }: { cur: number; total: number; next: ReactNode | null; title?: string }) {
  return (
    <div data-beats={`${cur}/${total}`} title={title}
      style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
        {Array.from({ length: total }, (_, b) => (
          <span key={b} style={{ width: b === cur ? 14 : 6, height: 6, borderRadius: 3, transition: 'all .2s', background: b === cur ? '#ffd21e' : b < cur ? '#8a7a2a' : D.faint }} />
        ))}
      </div>
      <span style={{ fontSize: 11, color: D.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {next !== null ? <>next <span style={{ color: D.text }}>{next}</span></> : 'last beat'}
      </span>
    </div>
  );
}

/** A card in the Notes view: a paragraph, or a bullet list when `keyPoints` is given. */
export function NoteCard({ title, text, keyPoints, current }: { title: string; text?: string | null; keyPoints?: string[]; current?: number }) {
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '12px 14px', overflow: 'auto' }}>
      <p style={{ fontSize: 10, fontWeight: 700, color: D.muted, marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>{title}</p>
      {keyPoints !== undefined ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' as const, gap: 7 }}>
          {keyPoints.map((pt, i) => (
            <li key={i} style={{ fontSize: 14, lineHeight: 1.5, color: current === undefined || i <= current ? D.text : D.muted, paddingLeft: 14, position: 'relative' as const }}>
              <span style={{ position: 'absolute' as const, left: 0, color: i === current ? '#ffd21e' : D.blue }}>•</span>{pt}
            </li>
          ))}
          {!keyPoints.length && <li style={{ fontSize: 13, color: D.faint }}>—</li>}
        </ul>
      ) : (
        <p style={{ fontSize: 14, lineHeight: 1.65, color: D.text, margin: 0 }}>{text || '—'}</p>
      )}
    </div>
  );
}
