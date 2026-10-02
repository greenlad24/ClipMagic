/**
 * Deadline editor — FREE TEXT, inline and quick like the original Zite pill
 * (Jake, 2026-09-30: no date picker). Type anything ("mid Oct", "Oct 15 go-live",
 * "late Nov or early Dec"); Enter or clicking away saves, Esc cancels, an empty
 * box removes the deadline. The text is saved exactly as typed; the server parses
 * it into `deadline_date` (rules first, AI when ambiguous). While typing, a small
 * chip previews the date the rules read ("→ Wed 15 Oct").
 */
import { useEffect, useRef, useState } from 'react';
import { parseDeadlineText, formatDeadlineChip } from '@/deals/lib/deadline';

interface Props {
  value: string | null | undefined;
  onSave: (next: string | null) => void | Promise<void>;
  onCancel: () => void;
  className?: string;
}

export default function DeadlineEditor({ value, onSave, onCancel, className }: Props) {
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const save = () => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (next === (value ?? '').trim()) { onCancel(); return; }
    void onSave(next || null);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const preview = draft.trim() ? parseDeadlineText(draft) : null;

  return (
    <div className={className} onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        }}
        placeholder="e.g. mid Oct, Oct 15, late Nov"
        aria-label="Deadline"
        style={{
          fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
          color: 'var(--pill-orange-text)', background: 'var(--pill-orange-bg)',
          border: '1.5px solid color-mix(in srgb, var(--pill-orange-text) 55%, transparent)', borderRadius: 20,
          padding: '4px 12px', outline: 'none', width: 220, maxWidth: '100%', minWidth: 0,
        }}
      />
      {draft.trim() && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {preview ? `→ ${formatDeadlineChip(preview)}` : 'date read after saving'}
        </span>
      )}
    </div>
  );
}
