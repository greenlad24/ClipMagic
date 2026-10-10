import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Download, Link2, Loader2, Ban } from 'lucide-react';
import type { AutoHandoffPackage, AutoHandoffShare } from 'zite-endpoints-sdk';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Auto Editor — one finished editor hand-off package on the job page: download it, and make a PUBLIC share link
 * for the editor (signed, expiring, revocable — lab/server/src/aieditor/share.ts). The link opens a small page
 * with the preview, the brief and a resumable download, with no sign-in.
 */

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function call(url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = '/auth/google';
    throw new Error('Sign-in required.');
  }
  const doc = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(doc?.error || `HTTP ${res.status}`);
  return doc;
}

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Link copied — send it to your editor');
  } catch {
    toast.error('Could not copy — select the link and copy it');
  }
}

export function HandoffShare({ jobId, pkg, onChange }: { jobId: string; pkg: AutoHandoffPackage; onChange?: () => void }) {
  const name = pkg.pkg ?? pkg.zip.replace(/\.zip$/, '');
  const [links, setLinks] = useState<AutoHandoffShare[]>(pkg.shares ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const shown = links.filter((l) => l.pkg === name);
  const sc = pkg.slotCount;

  const create = async () => {
    setBusy('create');
    try {
      const { link } = await call(`/api/aieditor/share/${jobId}`, { pkg: name, days: 14 });
      setLinks((ls) => [link, ...ls]);
      await copy(location.origin + link.path);
      onChange?.();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (id: string) => {
    if (!confirm('Revoke this link? Anyone who has it can no longer open or download the package.')) return;
    setBusy(id);
    try {
      const { link } = await call(`/api/aieditor/share/${jobId}/revoke`, { id });
      setLinks((ls) => ls.map((l) => (l.id === id ? link : l)));
      onChange?.();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          Hand-off package ready · {pkg.slots.length} screencast slot{pkg.slots.length === 1 ? '' : 's'} for the editor
          {sc && sc.planned !== sc.final ? ` (from ${sc.planned} planned${sc.screen_ref_added ? ` + ${sc.screen_ref_added} screen references` : ''}, merged)` : ''} ·{' '}
          {(pkg.bytes / 1e9).toFixed(2)} GB · the video below shows a card in every slot
        </span>
        <Button asChild size="sm" variant="ghost" className="h-7 gap-1.5 text-xs">
          <a href={`/api/aieditor/files/${jobId}/${pkg.zip}`} download>
            <Download className="h-3.5 w-3.5" /> Download
          </a>
        </Button>
        <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={create} disabled={busy !== null}>
          {busy === 'create' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />} Create share link
        </Button>
      </div>
      {shown.length > 0 && (
        <ul className="space-y-1">
          {shown.map((l) => {
            const url = location.origin + l.path;
            return (
              <li key={l.id} className={cn('flex flex-wrap items-center gap-2 rounded bg-background/40 px-2 py-1', !l.active && 'opacity-60')}>
                <code className="min-w-0 flex-1 truncate text-[11px] text-foreground" title={url}>
                  {url}
                </code>
                <span className="text-[11px] text-muted-foreground">
                  {l.revoked ? 'revoked' : l.active ? `expires ${when(l.expiresAt)}` : `expired ${when(l.expiresAt)}`}
                </span>
                {l.active && (
                  <>
                    <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[11px]" onClick={() => copy(url)}>
                      <Copy className="h-3 w-3" /> Copy
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[11px] text-red-400" onClick={() => revoke(l.id)} disabled={busy !== null}>
                      {busy === l.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />} Revoke
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
