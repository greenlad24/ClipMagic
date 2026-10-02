/**
 * Deep Dive v2 — the editor's chapter cards + the big preview.
 * The card: a live thumbnail (click = preview), kind + beats, eyebrow +
 * heading (one *accent*), the script with its [next] beat marks, and what
 * real material the chapter shows (clips / steps / highlights).
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { secondsFor, wordCount, fmtDuration, type MediaChoices, type Section } from '../api';
import MaterialEditor from './MaterialEditor';
import Show, { ChapterThumb } from './Show';
import { CHAPTER_LABEL } from './adapt';
import { beatCount, firstBeatOf, flatten, type Chapter } from './types';

function material(c: Chapter): string {
  const d = c.data;
  switch (c.kind) {
    case 'demo': {
      const tabs = d.tabs ?? [];
      const steps = tabs.reduce((a, t) => a + t.steps.length, 0);
      const located = tabs.reduce((a, t) => a + t.steps.filter((s) => s.box).length, 0);
      const agent = tabs.some((t) => t.source === 'agent');
      return `${tabs.length} walkthrough${tabs.length === 1 ? '' : 's'} · ${steps} steps · ${located}/${steps} zoom targets found${agent ? ' · recorded by the demo agent' : ''}`;
    }
    case 'clip': return `${d.clips?.length ?? 0} clips cut from the official video`;
    case 'article': return d.article ? `${d.article.highlights.length} highlights in ${d.article.site || 'the official post'}` : 'No post captured';
    case 'title': return d.heroClip ? 'Video loops behind the title' : '';
    case 'list': return d.image ? 'With a screenshot' : '';
    default: return '';
  }
}

export function ChapterCardV2({ chapters, index, diveId, choices, onMaterial, onPreview, onSave, onMove, onDelete }: {
  chapters: Chapter[]; index: number; diveId: string;
  choices: MediaChoices | null;
  onMaterial: (s: Section) => void;
  onPreview: () => void;
  onSave: (patch: { heading?: string; eyebrow?: string; script?: string }) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const c = chapters[index];
  const [script, setScript] = useState(c.script);
  useEffect(() => setScript(c.script), [c.script]);
  const beats = beatCount(c);
  const marks = (script.match(/\[next\]/gi) ?? []).length;
  const spoken = script.replace(/\[next\]/gi, ' ');
  const mat = material(c);
  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 p-3 md:flex-row">
        <div className="w-full shrink-0 md:w-[320px]">
          <button onClick={onPreview} className="block w-full transition-shadow hover:ring-2 hover:ring-primary/50 rounded-lg" title="Preview — ← → step through the beats">
            <ChapterThumb chapters={chapters} index={index} diveId={diveId} beat={beats - 1} />
          </button>
          <div className="mt-2 flex items-center gap-1">
            <span className="mr-auto text-xs tabular-nums text-muted-foreground">#{index + 1} · {CHAPTER_LABEL[c.kind] ?? c.kind} · {beats} beat{beats === 1 ? '' : 's'}</span>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onMove(-1)} disabled={index === 0} title="Move up"><ArrowUp className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onMove(1)} disabled={index === chapters.length - 1} title="Move down"><ArrowDown className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={onDelete} title="Delete chapter"><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
          {mat && <p className="mt-1 text-[11px] text-muted-foreground">{mat}</p>}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
            <Input key={`e:${c.eyebrow}`} defaultValue={c.eyebrow} placeholder="Label" className="h-8 text-xs uppercase tracking-wide"
              onBlur={(e) => { if (e.target.value !== c.eyebrow) onSave({ eyebrow: e.target.value }); }} />
            <Input key={`h:${c.heading}`} defaultValue={c.heading} placeholder="Heading — wrap ONE phrase in *asterisks* for the accent" className="h-8 text-sm font-semibold"
              onBlur={(e) => { if (e.target.value !== c.heading) onSave({ heading: e.target.value }); }} />
          </div>
          <Textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            onBlur={() => { if (script !== c.script) onSave({ script }); }}
            rows={Math.min(16, Math.max(4, Math.ceil(script.length / 95)))}
            className="text-sm leading-relaxed"
            placeholder="What you say. Put [next] where you press → to the next beat."
          />
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {wordCount(spoken)} words · ~{fmtDuration(secondsFor(spoken))} ·{' '}
            <span className={marks === beats - 1 ? '' : 'text-amber-500'}>
              {marks} [next] mark{marks === 1 ? '' : 's'} for {beats} beat{beats === 1 ? '' : 's'}{marks === beats - 1 ? '' : ` (needs ${beats - 1})`}
            </span>
          </p>
          <MaterialEditor chapter={c} choices={choices} onSaved={onMaterial} />
        </div>
      </div>
    </li>
  );
}

/** The show itself, big, in a dialog. ← → step beats exactly as on stage. */
export function PreviewV2({ chapters, diveId, chapter, onClose }: { chapters: Chapter[]; diveId: string; chapter: number | null; onClose: () => void }) {
  const beats = useMemo(() => flatten(chapters), [chapters]);
  const [flat, setFlat] = useState(0);
  useEffect(() => { if (chapter !== null) setFlat(firstBeatOf(chapters, chapter)); }, [chapter, chapters]);
  useEffect(() => {
    if (chapter === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); setFlat((f) => Math.min(beats.length - 1, f + 1)); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setFlat((f) => Math.max(0, f - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chapter, beats.length]);
  const at = beats[flat];
  const c = at ? chapters[at.chapter] : null;
  return (
    <Dialog open={chapter !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl gap-3 p-3">
        <DialogTitle className="text-sm">{c ? `#${at.chapter + 1} · ${c.heading.replace(/\*/g, '')} · beat ${at.beat + 1} of ${beatCount(c)}` : ''}</DialogTitle>
        {chapter !== null && (
          <>
            <div className="relative aspect-video overflow-hidden rounded-md bg-black">
              <Show chapters={chapters} diveId={diveId} flat={flat} onFlat={setFlat} />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setFlat((f) => Math.max(0, f - 1))} disabled={flat === 0}><ChevronLeft className="h-4 w-4" /></Button>
              <Button variant="outline" size="sm" onClick={() => setFlat((f) => Math.min(beats.length - 1, f + 1))} disabled={flat >= beats.length - 1}><ChevronRight className="h-4 w-4" /></Button>
              <span className="ml-auto text-xs text-muted-foreground">← → step beats · {flat + 1} / {beats.length}</span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
