/**
 * The deck's LOOK, on the Go-live card — the AI NEWS templates (Jake,
 * 2026-10-07: "the AI news presentation templates should have different
 * templates — minimalistic, beautiful but different templates from the deep
 * dives"; stage/newsTemplates.ts). Same picker UX as before: every card is a
 * REAL render — one of today's stories' info slides drawn in that template,
 * with its title card inset — and the build asks for the template first.
 * Picking re-skins the deck at once; no rebuild. The camera-bubble setting is
 * the same one the Deep Dive uses (one camera, one machine).
 */
import { useMemo, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { BubbleControl, useBubbleSettings } from '../deepdive/bubble';
import { StoryThumb } from './stage/StoryShow';
import { storyStage } from './stage/story';
import { NEWS_TEMPLATES, newsTemplateFor, type NewsTemplate, type NewsTemplateId } from './stage/newsTemplates';
import type { DailyShow, Slide } from './useDailyShow';

export default function DeckLook({ show }: { show: DailyShow }) {
  const { deckTemplate, chooseDeckTemplate } = show;
  const [open, setOpen] = useState(false);
  const [bubble, setBubble] = useBubbleSettings();
  const tpl = newsTemplateFor(deckTemplate);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-deck-look={tpl.id}>
      <Button variant="outline" size="sm" className="h-8 gap-2" onClick={() => setOpen(true)} title="Pick the deck's design (the AI News templates)">
        <Palette className="h-3.5 w-3.5" />
        <span className="flex gap-0.5" aria-hidden>{[tpl.bg, tpl.ink, tpl.accent].map((c, i) => <span key={i} className="h-2.5 w-2.5 rounded-full ring-1 ring-black/20" style={{ background: c }} />)}</span>
        Template: <span className="font-semibold">{tpl.name}</span>
      </Button>
      <BubbleControl value={bubble} onChange={setBubble} />
      <DeckTemplateDialog show={show} open={open} onOpenChange={setOpen}
        onPick={(t) => { void chooseDeckTemplate(t); setOpen(false); }} />
    </div>
  );
}

/** A story to preview when the deck has none yet (the build asks for a template before it exists). */
const SAMPLE: Slide = {
  id: 'sample',
  topicLabel: 'A new AI model you can download for free',
  teleprompterScript: 'A company just released a new AI model. You can download it for free. It runs on your own computer. It beats some bigger models on tests. And it costs nothing to try.',
  bestSourceName: 'TechCrunch',
  bestSourceUrl: 'https://techcrunch.com/',
  stageJson: JSON.stringify({
    v: 3,
    cover: { eyebrow: 'Model release', heading: 'A free AI model you can *download*', lede: 'It runs on your own computer, and it costs nothing to try.' },
    scenes: [
      { kind: 'number', eyebrow: 'By the numbers', heading: 'Free to try', data: { value: 0, display: '', prefix: '$', suffix: '', label: 'to download it and run it at home', context: 'No account, no monthly plan' }, cue: 'You can download it' },
      { kind: 'meaning', eyebrow: 'What it means', heading: 'Strong AI is now *free* to run yourself', data: { text: 'You can try it tonight on your own laptop' }, cue: 'And it costs nothing' },
    ],
  }),
} as Slide;

/** The template picker for the daily deck — on the Go-live card, and FIRST on every
 *  build (Jake 2026-10-06: "every new deck asks you for the template you want first"). */
export function DeckTemplateDialog({ show, open, onOpenChange, onPick, building = false }: {
  show: DailyShow; open: boolean; onOpenChange: (o: boolean) => void; onPick: (template: string) => void; building?: boolean;
}) {
  const { slides, deckTemplate } = show;
  const current = newsTemplateFor(deckTemplate).id;

  // The preview story: the first one with built visuals (else a sample).
  const sample = useMemo(() => {
    const i = slides.findIndex((s) => !storyStage(s).fallback);
    const slide = i >= 0 ? slides[i] : SAMPLE;
    const st = storyStage(slide);
    // Its first slide (fully revealed).
    const first = st.screens.findIndex((x) => x.kind === 'scene');
    let beat = 0;
    st.beats.forEach((b, k) => { if (b.screen === first) beat = k; });
    return { slide, number: i >= 0 ? i + 1 : 1, beat };
  }, [slides]);

  const preview = (t: NewsTemplate) => (
    <div className="relative">
      <StoryThumb slide={sample.slide} beat={sample.beat} number={sample.number} template={t} />
      <div className="absolute bottom-1.5 right-1.5 w-[38%] overflow-hidden rounded shadow-lg ring-1 ring-black/40">
        <StoryThumb slide={sample.slide} beat={0} number={sample.number} template={t} titleCard />
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto p-4">
        <DialogTitle className="text-sm">
          {building ? 'Pick the template for this deck — the build starts when you choose' : "Template — the design today's whole deck is shown in"}
        </DialogTitle>
        <p className="-mt-1 text-xs text-muted-foreground">
          {building
            ? 'The AI News templates — their own look, different from the Deep Dive, so the Deep Dive stays the special one. You can still change it later on the Go-live card without rebuilding.'
            : "The AI News templates. Each preview is one of today's stories (an info slide + its title card) drawn in that template. Picking one re-skins the audience and display screens, the slide previews and every thumbnail at once — the stories, beats and scripts stay as they are. Each story opens on its source page either way; Shift shows its video."}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-news-picker>
          {NEWS_TEMPLATES.map((t) => {
            const on = t.id === current;
            return (
              <button key={t.id} type="button" onClick={() => onPick(t.id as NewsTemplateId)} data-template-card={t.id}
                className={`group rounded-lg border p-2 text-left transition-colors ${on ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-muted-foreground/50'}`}>
                <div className="pointer-events-none overflow-hidden rounded-md">{preview(t)}</div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="flex shrink-0 gap-0.5" aria-hidden>
                    {[t.bg, t.ink, t.accent].map((c, i) => <span key={i} className="h-3 w-3 rounded-full ring-1 ring-black/20" style={{ background: c }} />)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.name}{t.id === 'studio' ? ' (default)' : ''}</span>
                  {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{t.blurb}</p>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
