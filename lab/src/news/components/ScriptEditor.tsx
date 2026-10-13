/**
 * ✎ Edit script — the presenter's own correction of a script AFTER it was generated (Jake 2026-10-13: "Add an edit
 * button to the controller script for both Daily Show and Deep Dives in the event I'd like to add/omit something
 * to the script after it's been created. This should affect existing presentations as well.").
 *
 * BEAT BY BEAT (Jake, same day: "Edits should not affect the script's beats. If needed or it helps, a beat can have
 * a separate editable field"): one box per beat, under that beat's ▶ BEAT marker. Words move freely INSIDE a box;
 * the boundaries between boxes are the beats and never change — the caller joins the boxes back (Daily Show:
 * beatEdit.ts locks each beat on its box's first words; Deep Dive: the boxes are re-joined with the same [next]
 * markers). Save writes to the stored presentation, so a deck or dive made before this works the same.
 * The presenter's own keys stop while it is open — every keydown is stopped here — so typing never steps the show.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

export interface EditablePart { mark: string; text: string }

export function ScriptEditor({ title, parts, hint, check, onSave, onClose }: {
  title: string;
  /** the script cut at its beats — one box each */
  parts: EditablePart[];
  /** one line under the title */
  hint?: string;
  /** why these boxes can't be saved as they are (null = fine), rechecked as you type */
  check?: (texts: string[]) => string | null;
  onSave: (texts: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const start = useMemo(() => parts.map((p) => p.text.trim()), [parts]);
  const [texts, setTexts] = useState<string[]>(start);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLTextAreaElement>(null);
  const dirty = texts.some((t, i) => t !== start[i]);
  const problem = useMemo(() => (dirty && check ? check(texts) : null), [texts, dirty, check]);

  useEffect(() => { first.current?.focus(); }, []);

  const close = () => { if (!dirty || window.confirm('Discard your changes to the script?')) onClose(); };
  const save = async () => {
    if (!dirty) { onClose(); return; }
    if (problem) return;
    setSaving(true);
    setError(null);
    try { await onSave(texts); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const words = texts.join(' ').split(/\s+/).filter(Boolean).length;
  return (
    <div
      role="dialog" aria-modal="true"
      // the presenter's keys (→ ← space T E G 1-9 Shift…) must not act while typing here
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
      }}
      onKeyUp={(e) => e.stopPropagation()}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <div style={{ width: 'min(880px, 100%)', maxHeight: '100%', display: 'flex', flexDirection: 'column', gap: 10, background: '#16171b',
        color: '#f2f2f2', border: '1px solid #2c2d33', borderRadius: 12, padding: 18, boxShadow: '0 24px 80px rgba(0,0,0,.5)', font: '14px/1.45 system-ui, sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <b style={{ fontSize: 15 }}>✎ Edit script</b>
          <span style={{ color: '#9a9aa2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{title}</span>
          <span style={{ color: '#9a9aa2', fontSize: 12 }}>{parts.length} beat{parts.length === 1 ? '' : 's'} · {words} words · ~{Math.max(1, Math.round(words / 150 * 60))} s</span>
        </div>
        {hint && <div style={{ color: '#9a9aa2', fontSize: 12 }}>{hint}</div>}
        <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingRight: 4, minHeight: 0 }}>
          {parts.map((p, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#ffd21e', font: '700 11px/1.2 ui-monospace, monospace', letterSpacing: '.08em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.mark}</span>
              <textarea
                ref={i === 0 ? first : undefined}
                value={texts[i]}
                onChange={(e) => { const v = e.target.value; setTexts((t) => t.map((x, j) => (j === i ? v : x))); }}
                spellCheck
                rows={Math.min(10, Math.max(3, Math.ceil(texts[i].length / 80) + (texts[i].match(/\n/g)?.length ?? 0)))}
                style={{ resize: 'vertical', background: '#0d0e11', color: '#f2f2f2', border: `1px solid ${texts[i] !== start[i] ? '#6b5a12' : '#2c2d33'}`,
                  borderRadius: 8, padding: '10px 12px', font: '16px/1.55 system-ui, sans-serif', outline: 'none' }}
              />
            </div>
          ))}
        </div>
        {problem && (
          <div style={{ background: 'rgba(255,170,40,.12)', border: '1px solid rgba(255,170,40,.35)', color: '#ffc46b', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>⚠ {problem}</div>
        )}
        {error && <div style={{ color: '#ff7a70', fontSize: 13 }}>Couldn't save: {error}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#6d6d75', fontSize: 12, flex: 1 }}>Each box is one beat — the beats stay exactly where they are. Ctrl/⌘ + Enter saves · Esc cancels.</span>
          <button onClick={close} disabled={saving}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #3a3b42', background: 'transparent', color: '#d8d8de', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => void save()} disabled={saving || !!problem}
            style={{ padding: '7px 16px', borderRadius: 8, border: 0, background: dirty && !problem ? '#ffd21e' : '#3a3b42', color: dirty && !problem ? '#000' : '#bbb', fontWeight: 700, cursor: problem ? 'not-allowed' : 'pointer' }}>
            {saving ? 'Saving…' : dirty ? 'Save script' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The small "✎ Edit script" button the presenters show next to a script. */
export function EditScriptButton({ onClick, style }: { onClick: () => void; style?: React.CSSProperties }) {
  return (
    <button onClick={onClick} title="Add or cut words in this script (saved to the presentation)"
      style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,.18)', background: 'rgba(255,255,255,.06)',
        color: '#e6e6ea', fontSize: 12, fontWeight: 600, cursor: 'pointer', ...style }}>
      ✎ Edit script
    </button>
  );
}
