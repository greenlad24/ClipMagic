/**
 * Tell the room which beat is on screen. Within one chapter the teleprompter
 * must not move (Jake, 2026-10-02: "the teleprompter should not jump — only
 * moving between slides, not in the intra-slide animations"), so those moves
 * carry keepScroll and the server leaves the script's anchor alone.
 */
import type { LiveSync } from '../../liveSync';
import type { FlatBeat } from './types';

export function sendBeat(sync: LiveSync | null | undefined, beats: FlatBeat[], from: number, to: number): void {
  if (!sync) return;
  const same = beats[from] && beats[to] && beats[from].chapter === beats[to].chapter;
  if (same) sync.socket.emit('slide-index', { idx: to, keepScroll: true });
  else sync.setSlide(to);
}
