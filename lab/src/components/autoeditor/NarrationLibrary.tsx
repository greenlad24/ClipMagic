import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Film, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { autoEditorUploadRemove, type AutoNarration } from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';
import { fmtBytes } from './useSourceUpload';

/**
 * The narration library (lab/server/src/aieditor/library.ts): every finished upload, kept for
 * reuse, newest first. Used by the New edit flow's "Previously uploaded" source (pickable) and
 * by Stored files (manage only).
 *
 * Delete is an in-page confirmation (never window.confirm) with two choices, because the
 * library file and the jobs' source.mp4 are HARD LINKS — space only comes back with the last
 * link: "Delete narration only" (the jobs keep their copy) or "Delete narration and everything
 * made from it" (the jobs too). Each shows what it really frees.
 */

function mmss(sec: number | null | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
function res(w: number | null, h: number | null): string {
  if (!w || !h) return '';
  return Math.min(w, h) >= 2160 ? `${w}×${h} (4K)` : `${w}×${h}`;
}
function day(t: number | null): string {
  if (!t) return '';
  return new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function freesText(n: number): string {
  return n > 0 ? `frees ${fmtBytes(n)}` : 'frees 0 B';
}

export function NarrationLibrary({
  items,
  error,
  selected,
  onPick,
  onChanged,
}: {
  items: AutoNarration[] | null;
  error: string | null;
  selected?: string | null;
  /** pickable (the New edit flow); omitted = manage only */
  onPick?: (n: AutoNarration) => void;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!items) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your narrations…
      </p>
    );
  }
  if (!items.length) {
    return (
      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        No uploaded narrations yet — every video you upload is kept here for reuse.
      </p>
    );
  }

  const remove = async (n: AutoNarration, mode: 'narration' | 'all') => {
    setBusy(true);
    try {
      const r = await autoEditorUploadRemove({ key: n.key, mode });
      toast.success(
        mode === 'all'
          ? `Deleted the narration and ${r.removedJobs.length} edit${r.removedJobs.length === 1 ? '' : 's'} — ${freesText(r.freed)}.`
          : `Removed from the library — ${freesText(r.freed)}.`,
      );
      setConfirming(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-h-[30rem] space-y-2 overflow-y-auto pr-1">
      {items.map((n) => {
        const isSel = selected === n.key;
        const vertical = (n.height ?? 0) > (n.width ?? 0);
        const open = confirming === n.key;
        const body = (
          <>
            <span
              className={cn(
                'flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground',
                vertical ? 'h-16 w-9' : 'h-12 w-20 sm:h-14 sm:w-24',
              )}
            >
              {n.poster ? (
                <video src={n.poster} preload="metadata" muted playsInline className="h-full w-full object-cover" />
              ) : (
                <Film className="h-4 w-4" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{n.name}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {[day(n.uploadedAt), mmss(n.duration), res(n.width, n.height), fmtBytes(n.bytes)].filter(Boolean).join(' · ')}
              </span>
              {n.usedBy.length > 0 && (
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">
                  Used by {n.usedBy.length} edit{n.usedBy.length === 1 ? '' : 's'}
                </span>
              )}
            </span>
          </>
        );
        return (
          <div
            key={n.key}
            className={cn(
              'rounded-xl border transition-all',
              isSel ? 'border-primary bg-primary/10 ring-1 ring-primary/40' : 'border-border',
            )}
          >
            <div className="flex items-center gap-1 p-2.5">
              {onPick ? (
                <button type="button" onClick={() => onPick(n)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  {body}
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                      isSel ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                    )}
                  >
                    {isSel && <Check className="h-3 w-3" />}
                  </span>
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
              )}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title="Remove from library"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-400"
                onClick={() => setConfirming(open ? null : n.key)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {open && (
              <div className="space-y-2 border-t border-border/60 px-3 py-2.5 text-xs">
                {n.usedBy.length > 0 ? (
                  <div className="text-muted-foreground">
                    <p>Still used by:</p>
                    <ul className="mt-1 space-y-0.5">
                      {n.usedBy.map((u) => (
                        <li key={u.id} className="truncate">
                          <a href={`/auto-editor/${u.id}`} className="text-foreground hover:underline">{u.title}</a>
                          {u.busy ? <span className="text-amber-400"> · {u.busy}</span> : null}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1">These edits share the same file on disk, so deleting only the narration frees space they no longer hold.</p>
                  </div>
                ) : (
                  <p className="text-muted-foreground">No edit uses it.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={busy || !!n.blocked}
                    title={n.blocked ?? undefined}
                    onClick={() => void remove(n, 'narration')}
                  >
                    Delete narration only · {freesText(n.frees)}
                  </Button>
                  {n.usedBy.length > 0 && (
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-8 text-xs"
                      disabled={busy || !!n.blockedAll}
                      title={n.blockedAll ?? undefined}
                      onClick={() => void remove(n, 'all')}
                    >
                      Delete narration and everything made from it · {freesText(n.freesAll)}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={busy} onClick={() => setConfirming(null)}>
                    Keep it
                  </Button>
                </div>
                {(n.blocked || n.blockedAll) && (
                  <p className="text-amber-400">Can’t delete now: {n.blocked ?? n.blockedAll}.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
