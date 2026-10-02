/**
 * Deep Dive v2 — change a chapter's real material without regenerating:
 * captions (demo steps, clips, post highlights), which moment of the official
 * video a clip plays, and which lines of the official post are highlighted.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { editDeepDiveChapter, type ChapterEdit, type MediaChoices, type Section } from '../api';
import type { Chapter } from './types';

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

export default function MaterialEditor({ chapter: c, choices, onSaved }: { chapter: Chapter; choices: MediaChoices | null; onSaved: (s: Section) => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (edit: ChapterEdit, ok?: string) => {
    setBusy(true);
    try { const r = await editDeepDiveChapter(c.id, edit); onSaved(r.section); if (ok) toast.success(ok); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const cap = (path: string, value: string) => (
    <Input key={`${path}:${value}`} defaultValue={value} className="h-7 text-xs" placeholder="Caption on screen"
      onBlur={(e) => { const v = e.target.value.trim(); if (v !== value) void run({ op: 'caption', path, caption: v }); }} />
  );

  let body: React.ReactNode = null;
  if (c.kind === 'demo') {
    body = (c.data.tabs ?? []).map((t, ti) => (
      <div key={ti} className="space-y-1">
        <p className="text-[11px] font-medium text-muted-foreground">{t.name}{t.source === 'agent' ? ' · recorded by the demo agent' : ''}</p>
        {t.steps.map((st, si) => (
          <div key={si} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{si + 1}</span>
            {cap(`tabs.${ti}.steps.${si}`, st.caption)}
            <span className="shrink-0 text-[10px] text-muted-foreground">{st.box ? 'zoom ✓' : 'no zoom'}</span>
          </div>
        ))}
      </div>
    ));
  } else if (c.kind === 'clip') {
    body = (c.data.clips ?? []).map((cl, i) => (
      <div key={i} className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {cap(`clips.${i}`, cl.caption)}
        <select className="h-7 rounded-md border border-input bg-background px-2 text-xs" disabled={busy || !choices?.clips.length} defaultValue=""
          onChange={(e) => { if (e.target.value) void run({ op: 'swapClip', index: i, clip: e.target.value }, 'Clip swapped — the new moment is cut.'); e.target.value = ''; }}>
          <option value="">Swap for another moment…</option>
          {(choices?.clips ?? []).map((m) => (
            <option key={m.id} value={m.id}>{mmss(m.start)}–{mmss(m.end)} · {m.kind} · {m.description.slice(0, 70)}</option>
          ))}
        </select>
      </div>
    ));
  } else if (c.kind === 'article' && c.data.article) {
    body = <HighlightPicker chapter={c} choices={choices} busy={busy} onSave={(items) => run({ op: 'highlights', items }, 'Highlights saved.')} />;
  }
  if (!body) return null;
  return (
    <details className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        Material on screen {busy && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
      </summary>
      <div className="mt-2 space-y-2">{body}</div>
    </details>
  );
}

function HighlightPicker({ chapter: c, choices, busy, onSave }: { chapter: Chapter; choices: MediaChoices | null; busy: boolean; onSave: (items: { block: number; caption: string }[]) => void }) {
  const start = (c.data.article?.highlights ?? []).filter((h) => typeof h.block === 'number').map((h) => ({ block: h.block as number, caption: h.caption }));
  const [items, setItems] = useState(start);
  const text = (b: number) => choices?.blocks.find((x) => x.block === b)?.text ?? `Block ${b}`;
  const dirty = JSON.stringify(items) !== JSON.stringify(start);
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={it.block} className="rounded border border-border p-1.5">
          <p className="mb-1 line-clamp-2 text-[11px] text-muted-foreground">“{text(it.block)}”</p>
          <div className="flex gap-1">
            <Input value={it.caption} onChange={(e) => setItems((l) => l.map((x, k) => (k === i ? { ...x, caption: e.target.value } : x)))} className="h-7 text-xs" placeholder="Caption on screen" />
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setItems((l) => l.filter((_, k) => k !== i))}>Remove</Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        <select className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs" defaultValue="" disabled={!choices?.blocks.length || items.length >= 6}
          onChange={(e) => { const b = Number(e.target.value); if (e.target.value && !items.some((x) => x.block === b)) setItems((l) => [...l, { block: b, caption: '' }]); e.target.value = ''; }}>
          <option value="">Highlight another line of the post…</option>
          {(choices?.blocks ?? []).map((b) => <option key={b.block} value={b.block}>[{b.tag}] {b.text.slice(0, 90)}</option>)}
        </select>
        <Button size="sm" className="h-7 text-xs" disabled={busy || !dirty || !items.length} onClick={() => onSave(items)}>Save highlights</Button>
      </div>
    </div>
  );
}
