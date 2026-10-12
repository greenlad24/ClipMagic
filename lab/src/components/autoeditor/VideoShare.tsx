import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Link2, Loader2 } from 'lucide-react';
import type { AutoHandoffShare } from 'zite-endpoints-sdk';
import { Button } from '@/components/ui/button';

/**
 * Auto Editor — a PUBLIC link to one result video (final/edit/draft/preview-NN.mp4) that opens with no sign-in:
 * a page with the video and a Download button (lab/server/src/aieditor/share.ts). Signed, expires in 30 days,
 * revocable from the share admin API. Jake 2026-10-12: "send these links (of the lab results) without a sign in".
 */
export function VideoShare({ jobId, file, className }: { jobId: string; file: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/aieditor/share/${jobId}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pkg: file, days: 30 }),
      });
      if (res.status === 401) {
        location.href = '/auth/google';
        return;
      }
      const doc = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(doc?.error || `HTTP ${res.status}`);
      const url = location.origin + doc.link.path;
      try {
        await navigator.clipboard.writeText(url);
        toast.success('Share link copied — opens without sign-in, valid 30 days');
      } catch {
        prompt('Share link (opens without sign-in, valid 30 days):', url);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="ghost" className={className ?? 'h-7 gap-1.5 text-xs'} onClick={create} disabled={busy}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />} Share link
    </Button>
  );
}

const KIND: Record<string, string> = { final: 'Final', edit: 'Edit', draft: 'Draft', preview: 'Preview' };

/** The job's no-sign-in video links (made automatically when the job finishes) — Copy, with the expiry. */
export function JobShareLinks({ links }: { links: AutoHandoffShare[] }) {
  const live = links.filter((l) => l.active);
  if (!live.length) return null;
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied — opens without sign-in');
    } catch {
      prompt('Share link (opens without sign-in):', url);
    }
  };
  return (
    <div className="space-y-1 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
      <p>No-sign-in links</p>
      <ul className="space-y-1">
        {live.map((l) => {
          const url = location.origin + l.path;
          const m = /^(\w+)-(\d{2})\.mp4$/.exec(l.pkg);
          return (
            <li key={l.id} className="flex flex-wrap items-center gap-2 rounded bg-background/40 px-2 py-1">
              <span className="text-foreground">{m ? `${KIND[m[1]] ?? m[1]} ${Number(m[2])}` : l.pkg}</span>
              <code className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={url}>{url}</code>
              <span className="text-[11px] text-muted-foreground">
                expires {new Date(l.expiresAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
              </span>
              <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[11px]" onClick={() => copy(url)}>
                <Copy className="h-3 w-3" /> Copy
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
