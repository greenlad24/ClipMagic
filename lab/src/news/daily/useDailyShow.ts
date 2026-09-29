/**
 * Daily Show — every piece of state and every server call the dashboard makes.
 *
 * The components under src/news/daily/ are presentational; they get what they
 * need from this hook. Behaviour is the original dashboard's, moved here
 * unchanged (same endpoints, same streamed logs, same toasts), plus:
 *   - moveSlide(): reorder by one step, for touch screens where HTML5
 *     drag-and-drop does not fire (iPad);
 *   - an Undo on "Slide removed" (updateSlide deleted:false).
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  getStories, toggleStoryInDeck, collectNews, clearCache,
  buildDeckFromStories, getSlides, updateSlide, reorderSlides, startSession,
  type GetStoriesOutputType, type GetSlidesOutputType,
} from '../api';
import type { LogEntry } from './RunLog';

export type Story = GetStoriesOutputType['stories'][0];
export type Meta = GetStoriesOutputType['meta'];
export type Slide = GetSlidesOutputType['slides'][0];
export type Deck = GetSlidesOutputType['deck'];

export type StoryFilter = 'All' | 'Verified' | 'Likely' | 'Unconfirmed' | 'Selected';

export const PRESENTER_PATH = '/news-gatherer/present/notes';

export function matchesFilter(s: Story, f: StoryFilter): boolean {
  if (f === 'All') return true;
  if (f === 'Verified') return s.status === 'Verified';
  if (f === 'Likely') return s.status === 'Likely';
  if (f === 'Unconfirmed') return s.status === 'Unconfirmed' || s.status === 'Single Source';
  if (f === 'Selected') return s.addedToDeck;
  return true;
}

function useRunLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const add = useCallback((message: string, percent: number, isError = false) =>
    setLogs(prev => [...prev, { id: prev.length, ts: new Date(), message, percent, isError }]), []);
  return { logs, setLogs, open, setOpen, add, clear: () => setLogs([]), toggle: () => setOpen(v => !v) };
}

export function useDailyShow(enabled: boolean) {
  // Stories
  const [stories, setStories] = useState<Story[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [storiesLoading, setStoriesLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Collection
  const [refreshing, setRefreshing] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const collectLog = useRunLog();

  // Deck build
  const [building, setBuilding] = useState(false);
  const buildLog = useRunLog();

  // Slides
  const [slides, setSlides] = useState<Slide[]>([]);
  const [deck, setDeck] = useState<Deck>(null);
  const [slidesLoading, setSlidesLoading] = useState(true);

  const loadStories = useCallback(async () => {
    try {
      const data = await getStories({});
      setStories(data.stories);
      setMeta(data.meta);
    } catch { toast.error('Failed to load stories'); }
    finally { setStoriesLoading(false); }
  }, []);

  const loadSlides = useCallback(async () => {
    try {
      const data = await getSlides({});
      setDeck(data.deck);
      setSlides(data.slides);
    } catch { toast.error('Failed to load presentation'); }
    finally { setSlidesLoading(false); }
  }, []);

  useEffect(() => { if (!enabled) return; loadStories(); loadSlides(); }, [enabled, loadStories, loadSlides]);

  const collect = async () => {
    setRefreshing(true);
    collectLog.setOpen(true);
    collectLog.add('Starting collection pipeline…', 0);
    try {
      const stream = collectNews({});
      for await (const chunk of stream) {
        try { const u = JSON.parse(chunk) as { message: string; percent: number }; collectLog.add(u.message, u.percent); }
        catch { collectLog.add(chunk, 0); }
      }
      const result = await stream.result;
      if (result.storiesFound > 0) {
        collectLog.add(`✓ Done — ${result.storiesFound} stories found`, 100);
        toast.success(`${result.storiesFound} stories ready`);
        await loadStories();
      } else {
        collectLog.add(`⚠ ${result.message || 'No new items found'}`, 100);
        toast.info(result.message || 'No new items found');
      }
    } catch (err: any) {
      collectLog.add(`✗ Collection failed: ${err?.message || 'Unknown error'}`, 0, true);
      toast.error('Collection failed');
    } finally { setRefreshing(false); }
  };

  const clearAndCollect = async () => {
    setClearingCache(true);
    collectLog.setOpen(true);
    collectLog.add('Clearing source cache…', 0);
    try {
      const result = await clearCache({});
      collectLog.add(`Cache cleared — ${result.cleared} records deleted. Starting fresh collection…`, 3);
    } catch { collectLog.add('Cache clear failed, continuing…', 3); }
    finally { setClearingCache(false); }
    await collect();
  };

  const toggleStory = async (storyId: string, addedToDeck: boolean) => {
    setTogglingId(storyId);
    try {
      await toggleStoryInDeck({ storyId, addedToDeck });
      setStories(prev => prev.map(s => s.id === storyId ? { ...s, addedToDeck } : s));
      setMeta(m => m ? { ...m, addedToDeck: m.addedToDeck + (addedToDeck ? 1 : -1) } : m);
    } catch { toast.error('Failed to update story'); }
    finally { setTogglingId(null); }
  };

  /** Resolves true when slides were created. */
  const buildDeck = async (): Promise<boolean> => {
    if ((meta?.addedToDeck ?? 0) === 0) {
      toast.info('Select at least one story before building.');
      return false;
    }
    setBuilding(true);
    buildLog.setOpen(true);
    buildLog.setLogs([]);
    buildLog.add('Building deck from selected stories…', 0);
    try {
      const stream = buildDeckFromStories({});
      for await (const chunk of stream) {
        try { const u = JSON.parse(chunk) as { message: string; percent: number }; buildLog.add(u.message, u.percent); }
        catch { buildLog.add(chunk, 0); }
      }
      const result = await stream.result;
      if (result.slidesCreated > 0) {
        buildLog.add(`✓ Done — ${result.slidesCreated} slides created`, 100);
        toast.success(`Presentation ready: ${result.slidesCreated} slides`);
        await loadSlides();
        return true;
      }
      buildLog.add(`⚠ ${result.message}`, 100);
      toast.info(result.message || 'No stories selected yet');
    } catch (err: any) {
      buildLog.add(`✗ Build failed: ${err?.message || 'Unknown error'}`, 0, true);
      toast.error('Build failed — check the build log');
    } finally { setBuilding(false); }
    return false;
  };

  const starSlide = async (id: string, val: boolean) => {
    setSlides(s => s.map(sl => sl.id === id ? { ...sl, favorited: val } : sl));
    await updateSlide({ slideId: id, favorited: val });
  };

  const deleteSlide = async (id: string) => {
    setSlides(s => s.filter(sl => sl.id !== id));
    await updateSlide({ slideId: id, deleted: true });
    toast.success('Slide removed', {
      action: {
        label: 'Undo',
        onClick: async () => {
          try { await updateSlide({ slideId: id, deleted: false }); await loadSlides(); }
          catch { toast.error('Could not restore the slide'); }
        },
      },
    });
  };

  const persistOrder = async (next: Slide[]) => {
    setSlides(next);
    try { await reorderSlides({ slideIds: next.map(s => s.id) }); }
    catch { toast.error('Failed to save order'); }
  };

  const moveSlideTo = async (from: number, to: number) => {
    if (from === to || to < 0 || to >= slides.length) return;
    const next = [...slides];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await persistOrder(next);
  };

  const startShow = () => {
    if (!deck) return toast.error('No deck loaded');
    window.open(PRESENTER_PATH, '_blank');
    startSession({ deckId: deck.id }).catch(() => {});
  };

  const selectedCount = meta?.addedToDeck ?? 0;
  const estMins = Math.round(slides.reduce((acc, s) => acc + (s.suggestedTimeSeconds || 90), 0) / 60);
  const deckDateLabel = meta?.deckDate
    ? new Date(meta.deckDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'Today';

  return {
    stories, meta, storiesLoading, togglingId, toggleStory,
    refreshing, clearingCache, collect, clearAndCollect, collectLog,
    building, buildDeck, buildLog,
    slides, deck, slidesLoading, loadSlides, starSlide, deleteSlide, moveSlideTo, startShow,
    selectedCount, estMins, deckDateLabel,
  };
}

export type DailyShow = ReturnType<typeof useDailyShow>;
