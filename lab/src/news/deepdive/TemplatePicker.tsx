/**
 * The template picker (Jake, 2026-10-06): every template as a REAL rendered
 * mini preview — the show's own components drawn in that template — not a
 * name in a list. In the editor the previews are this dive's own title and
 * first content chapter/slide; on the list page (nothing built yet) a sample.
 */
import { useMemo, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { Section } from './api';
import { SceneThumb } from './Scene';
import { ChapterThumb } from './v2/Show';
import { beatCount, type Chapter } from './v2/types';
import { TEMPLATES, templateFor, type DeckTemplate, type TemplateId } from './templates';

const SAMPLE_CHAPTERS: Chapter[] = [
  {
    id: 'sample-title', position: 1, kind: 'title', eyebrow: '', heading: 'The AI that *never sleeps*', island: null, script: '',
    data: { lede: 'What it does, what it costs, and who should care.', agenda: ['The demo', 'Why it matters', 'The catch'] },
  },
  {
    id: 'sample-list', position: 2, kind: 'list', eyebrow: 'Chapter 2 · Why it matters', heading: 'Three things it *changes*', script: '',
    island: { q: 'Worth it?', a: 'Yes' },
    data: { items: ['It works while you sleep', 'It books, buys and replies', 'It asks before it pays'] },
  },
  {
    id: 'sample-list-2', position: 3, kind: 'list', eyebrow: 'Chapter 3 · The catch', heading: 'What it *won’t* do', script: '',
    island: { q: 'Free?', a: 'No' },
    data: { items: ['Pay without asking you', 'Work on every website', 'Replace a real assistant'] },
  },
];

const sampleSection = (over: Partial<Section>): Section => ({
  id: 'sample', position: 1, kind: 'bullets', eyebrow: '', heading: '', data: {}, script: '',
  videoId: null, videoKind: null, videoUrl: null, videoTitle: '', videoChannel: '', videoReason: '', visual: null, ...over,
});
const SAMPLE_SECTIONS: Section[] = [
  sampleSection({ id: 'sample-title', kind: 'title', heading: 'The AI that never sleeps', data: { kicker: 'AI Deep Dive', subtitle: 'What it does, what it costs, and who should care.' } }),
  sampleSection({ id: 'sample-bullets', kind: 'bullets', eyebrow: 'Why it matters', heading: 'Three things it changes', data: { points: ['It works while you sleep', 'It books, buys and replies', 'It asks before it pays'] } }),
  sampleSection({ id: 'sample-stats', kind: 'stats', eyebrow: 'The numbers', heading: 'How big this is', data: { stats: [{ value: 24, display: '', prefix: '', suffix: 'h', decimals: 0, label: 'working every day' }, { value: 4000, display: '', prefix: '', suffix: '', decimals: 0, label: 'tasks a month' }] } }),
];

/** One template drawn with the show's own components: a content screen + the title inset. */
function Preview({ t, format, chapters, sections, diveId, title }: {
  t: DeckTemplate; format: 'v1' | 'v2'; chapters: Chapter[]; sections: Section[]; diveId: string; title: string;
}) {
  if (format === 'v2') {
    // Show the template's light surface when it has one (chapter 3 sits on paper when the template alternates).
    const content = chapters.length > 2 ? 2 : Math.min(1, chapters.length - 1);
    const beat = chapters[content] ? beatCount(chapters[content]) - 1 : 0;
    return (
      <div className="relative">
        <ChapterThumb chapters={chapters} index={content} diveId={diveId} beat={beat} template={t} />
        <div className="absolute bottom-1.5 right-1.5 w-[38%] overflow-hidden rounded shadow-lg ring-1 ring-black/40">
          <ChapterThumb chapters={chapters} index={0} diveId={diveId} template={t} />
        </div>
      </div>
    );
  }
  const content = sections.length > 1 ? 1 : 0;
  return (
    <div className="relative">
      <SceneThumb section={sections[content]} index={content} total={sections.length} title={title} template={t} className="rounded-md" />
      <div className="absolute bottom-1.5 right-1.5 w-[38%] overflow-hidden rounded shadow-lg ring-1 ring-black/40">
        <SceneThumb section={sections[0]} index={0} total={sections.length} title={title} template={t} />
      </div>
    </div>
  );
}

export default function TemplatePicker({ value, onChange, format, chapters, sections, diveId = '', title = '', disabled = false, footer }: {
  /** The chosen template id ('' = the format's default). */
  value: string;
  onChange: (id: TemplateId) => void;
  format: 'v1' | 'v2';
  /** This dive's chapters/sections, to preview the real content (else a sample). */
  chapters?: Chapter[];
  sections?: Section[];
  diveId?: string;
  title?: string;
  disabled?: boolean;
  footer?: ReactNode;
}) {
  const current = templateFor(value, format).id;
  const ch = useMemo(() => {
    const own = (chapters ?? []).filter((c) => c.kind !== 'title');
    const t = (chapters ?? []).find((c) => c.kind === 'title');
    return own.length && t ? [t, ...own.slice(0, 2)] : SAMPLE_CHAPTERS;
  }, [chapters]);
  const secs = useMemo(() => {
    const list = sections ?? [];
    const content = list.find((s) => s.kind !== 'title' && s.kind !== 'media');
    return list.length && content ? [list.find((s) => s.kind === 'title') ?? list[0], content] : SAMPLE_SECTIONS;
  }, [sections]);
  return (
    <div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TEMPLATES.map((t) => {
          const on = t.id === current;
          return (
            <button key={t.id} type="button" disabled={disabled} onClick={() => onChange(t.id)}
              className={`group rounded-lg border p-2 text-left transition-colors disabled:opacity-50 ${on ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-muted-foreground/50'}`}>
              <div className="pointer-events-none overflow-hidden rounded-md">
                <Preview t={t} format={format} chapters={ch} sections={secs} diveId={diveId} title={title || 'The AI that never sleeps'} />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="flex shrink-0 gap-0.5" aria-hidden>
                  {[t.ink, t.paper, t.accent, t.accent2].map((c, i) => <span key={i} className="h-3 w-3 rounded-full ring-1 ring-black/20" style={{ background: c }} />)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.name}{t.id === 'jake' ? ' (default)' : ''}</span>
                {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{t.blurb}</p>
            </button>
          );
        })}
      </div>
      {footer}
    </div>
  );
}
