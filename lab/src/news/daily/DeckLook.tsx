/**
 * The deck's LOOK, on the Go-live card (Jake, 2026-10-06: "the deck itself
 * will look like the deep dive presentation, with all of the templates that I
 * can choose"): the Deep Dive's own TemplatePicker — every card is one of
 * today's stories drawn in that template (cover + its first scene) — and the
 * camera-bubble setting the Deep Dive uses (one camera, one machine, so the
 * same setting). Picking re-skins the deck at once; no rebuild.
 */
import { useMemo, useState } from 'react';
import { Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import TemplatePicker from '../deepdive/TemplatePicker';
import { templateFor, type DeckTemplate } from '../deepdive/templates';
import { BubbleControl, useBubbleSettings } from '../deepdive/bubble';
import { beatCount } from '../deepdive/v2/types';
import { StoryThumb } from './stage/StoryShow';
import { storyStage } from './stage/story';
import type { DailyShow } from './useDailyShow';

export default function DeckLook({ show }: { show: DailyShow }) {
  const { deckTemplate, chooseDeckTemplate } = show;
  const [open, setOpen] = useState(false);
  const [bubble, setBubble] = useBubbleSettings();
  const tpl = templateFor(deckTemplate, 'v2');

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-deck-look={tpl.id}>
      <Button variant="outline" size="sm" className="h-8 gap-2" onClick={() => setOpen(true)} title="Pick the deck's design (the Deep Dive templates)">
        <Palette className="h-3.5 w-3.5" />
        <span className="flex gap-0.5" aria-hidden>{[tpl.ink, tpl.paper, tpl.accent].map((c, i) => <span key={i} className="h-2.5 w-2.5 rounded-full ring-1 ring-black/20" style={{ background: c }} />)}</span>
        Template: <span className="font-semibold">{tpl.name}</span>
      </Button>
      <BubbleControl value={bubble} onChange={setBubble} />
      <DeckTemplateDialog show={show} open={open} onOpenChange={setOpen}
        onPick={(t) => { void chooseDeckTemplate(t); setOpen(false); }} />
    </div>
  );
}

/** The template picker for the daily deck — on the Go-live card, and FIRST on every
 *  build (Jake 2026-10-06: "every new deck asks you for the template you want first"). */
export function DeckTemplateDialog({ show, open, onOpenChange, onPick, building = false }: {
  show: DailyShow; open: boolean; onOpenChange: (o: boolean) => void; onPick: (template: string) => void; building?: boolean;
}) {
  const { slides, deckTemplate } = show;

  // The preview story: the first one with built visuals (else the first).
  const sample = useMemo(() => {
    const i = Math.max(0, slides.findIndex((s) => !storyStage(s).fallback));
    const slide = slides[i];
    if (!slide) return null;
    const st = storyStage(slide);
    // The first scene, fully built (it sits on the template's light surface when it has one).
    const sceneBeat = st.scenes[0] ? beatCount(st.scenes[0]) : 0;
    return { slide, number: i + 1, sceneBeat };
  }, [slides]);

  const preview = (t: DeckTemplate) => sample && (
    <div className="relative">
      <StoryThumb slide={sample.slide} beat={sample.sceneBeat} number={sample.number} template={t} />
      {sample.sceneBeat > 0 && (
        <div className="absolute bottom-1.5 right-1.5 w-[38%] overflow-hidden rounded shadow-lg ring-1 ring-black/40">
          <StoryThumb slide={sample.slide} beat={0} number={sample.number} template={t} />
        </div>
      )}
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
            ? 'The same templates as Deep Dive. The deck is built in the one you pick; you can still change it later on the Go-live card without rebuilding.'
            : "The same templates as Deep Dive. Each preview is one of today's stories drawn in that template. Picking one re-skins the audience and display screens, the slide previews and every thumbnail at once — the stories, beats and scripts stay as they are."}
        </p>
        <TemplatePicker value={deckTemplate} format="v2" preview={sample ? preview : undefined} onChange={onPick} />
      </DialogContent>
    </Dialog>
  );
}
