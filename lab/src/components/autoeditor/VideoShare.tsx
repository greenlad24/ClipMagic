import { useState } from 'react';
import { toast } from 'sonner';
import { Link2, Loader2 } from 'lucide-react';
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
