/**
 * The Daily Show deck's design template (Jake, 2026-10-06: "the deck itself
 * will look like the deep dive presentation, with all of the templates that I
 * can choose"). It IS the Deep Dive's template set (deepdive/templates.ts),
 * stored per deck (`news_decks.template`, '' = Jake's brand) and picked on the
 * dashboard's Go-live card.
 *
 * Design only, so a pick re-skins every open screen at once, no rebuild:
 *  - same browser (dashboard + audience/display windows): a BroadcastChannel
 *    message, instant;
 *  - any other machine: the screens re-read it every few seconds.
 */
import { useEffect, useState } from 'react';
import { getDeckTemplate } from '../../api';

const CHANNEL = 'ng-deck-template';
const POLL_MS = 4000;

interface Msg { deckId: string | null; template: string }

/** Tell this browser's open screens about a new pick (the dashboard calls it after saving). */
export function announceDeckTemplate(deckId: string | null | undefined, template: string): void {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ deckId: deckId ?? null, template } satisfies Msg);
    ch.close();
  } catch { /* no BroadcastChannel: the poll picks it up */ }
}

/**
 * The template id of deck `deckId` (undefined/null = today's deck), live.
 * `initial` is what the page already knows (e.g. from getSlides) so the first
 * paint is right. Returns '' for "Jake's brand".
 */
export function useDeckTemplate(deckId: string | null | undefined, initial = ''): string {
  const [template, setTemplate] = useState(initial);
  useEffect(() => { setTemplate(initial); }, [initial]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      getDeckTemplate({ deckId: deckId || undefined })
        .then((r) => { if (alive) setTemplate(r.template || ''); })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, POLL_MS);
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = (e) => {
        const m = e.data as Msg;
        if (!m || typeof m.template !== 'string') return;
        // A message for another deck (an old tab) is not ours; no id = today's.
        if (deckId && m.deckId && m.deckId !== deckId) return;
        setTemplate(m.template);
      };
    } catch { /* poll only */ }
    return () => { alive = false; clearInterval(t); ch?.close(); };
  }, [deckId]);
  return template;
}
