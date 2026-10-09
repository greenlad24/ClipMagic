import { ShieldAlert } from 'lucide-react';
import type { AutoHeld, AutoHeldFailure } from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';

/**
 * A HELD edit (architecture recommendation §4): it failed the ship rule or a quality gate, so it was not
 * shipped. The list says why, one line per failure (rubric dimension, the beat, the output second, what
 * was tried). Nothing here is a finished edit, and no notes are sent anywhere: the automatic remedies
 * already ran; what is left is listed.
 */
const DIM_LABEL: Record<string, string> = {
  D1: 'Content', D2: 'Sync', D3: 'Clean screen', D4: 'Waits', D5: 'Framing', D6: 'Motion', D7: 'Structure',
  D8: 'Transitions', D9: 'Narration', D10: 'Overlays', held: 'Stopped', ship: 'Ship rule', privacy: 'Privacy',
  critical: 'Critical',
};

export function heldLabel(f: AutoHeldFailure): string {
  return DIM_LABEL[f.dim] ?? f.dim;
}

function mmss(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function HeldPanel({ held }: { held: AutoHeld }) {
  const scores = held.scores.find((s) => s && Object.keys(s.dims ?? {}).length);
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />
        <p className="text-xs font-medium text-amber-300">
          Held — not shipped. {held.failures.length} failure{held.failures.length === 1 ? '' : 's'} against the references.
        </p>
      </div>
      {scores && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(scores.dims).map(([d, v]) => (
            <span
              key={d}
              title={DIM_LABEL[d] ?? d}
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-[10px]',
                v === null || v === undefined ? 'bg-muted text-muted-foreground' : v >= 80 ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400',
              )}
            >
              {d} {v === null || v === undefined ? '—' : Math.round(v)}
            </span>
          ))}
        </div>
      )}
      <ul className="max-h-64 space-y-1 overflow-auto">
        {held.failures.map((f, n) => (
          <li key={n} className="flex gap-2 text-[11px] leading-snug">
            <span className="w-20 shrink-0 font-medium text-amber-300">{heldLabel(f)}</span>
            <span className="w-12 shrink-0 font-mono text-muted-foreground">{f.t !== null ? mmss(f.t) : ''}</span>
            <span className="min-w-0 flex-1 text-foreground/90">
              {f.why}
              {f.beat ? <span className="text-muted-foreground"> · beat {f.beat}</span> : null}
              {f.remedies_tried.length ? (
                <span className="text-muted-foreground"> · tried {f.remedies_tried.join(' → ')}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
