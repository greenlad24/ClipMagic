import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  tutorialStudioAccounts,
  tutorialStudioPost,
  type StudioChannel,
  type TutorialBatchItem,
} from 'zite-endpoints-sdk';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, Send, ShieldCheck } from 'lucide-react';

/**
 * Posting a batch's finished reels — to Tutorial Studio's OWN accounts.
 *
 * These channels come from a second Postiz account with its own API key, so
 * the accounts the Bulk Scheduler posts to are not merely filtered out of this
 * list: this page is authenticated as a different identity and cannot reach
 * them. With no studio key set there is nothing to post to, by design.
 */
export default function StudioPoster({
  items,
  onPosted,
}: {
  /** Batch items whose reel has finished rendering. */
  items: TutorialBatchItem[];
  onPosted?: () => void;
}) {
  const [configured, setConfigured] = useState(true);
  const [channels, setChannels] = useState<StudioChannel[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [posting, setPosting] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await tutorialStudioAccounts({});
      setConfigured(res.configured);
      setChannels(res.channels);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the studio accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const targets = Object.entries(selected)
    .filter(([, on]) => on)
    .map(([id]) => id);

  function defaultCaption(item: TutorialBatchItem): string {
    const s = item.script || {};
    const title = [s.title_small, s.title_main].filter(Boolean).join(' ');
    return [title, s.cta].filter(Boolean).join('\n\n');
  }

  async function post(item: TutorialBatchItem) {
    if (!targets.length) {
      toast.error('Pick at least one channel.');
      return;
    }
    setPosting(item.id);
    try {
      await tutorialStudioPost({
        jobId: item.jobId,
        channelIds: targets,
        content: captions[item.id] ?? defaultCaption(item),
        title: String(item.script?.title_main || item.topic).slice(0, 100),
      });
      toast.success('Sent to the studio accounts.');
      onPosted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Posting failed.');
    } finally {
      setPosting('');
    }
  }

  if (loading) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Send className="h-4 w-4 text-green-400" />
        <span className="font-medium">4. Post</span>
        <Badge variant="outline" className="gap-1">
          <ShieldCheck className="h-3 w-3" /> separate accounts
        </Badge>
      </div>

      {!configured ? (
        <p className="text-sm text-muted-foreground">
          No Studio Postiz key yet. Add one under <strong>Settings → Tutorial Studio accounts</strong>{' '}
          — a second Postiz account with only this group's socials connected. Until then this
          batch has nowhere to post, and it will never fall back to your other accounts.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {channels.length === 0 && (
              <p className="text-sm text-muted-foreground">
                That Postiz account has no channels connected yet.
              </p>
            )}
            {channels.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={!c.postable}
                onClick={() => setSelected((s) => ({ ...s, [c.id]: !s[c.id] }))}
                title={
                  c.postable
                    ? undefined
                    : 'PostPeer needs a public media URL, which these reels do not have yet.'
                }
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs disabled:opacity-40 ${
                  selected[c.id] ? 'border-primary bg-primary/10' : 'border-border'
                }`}
              >
                {c.picture && <img src={c.picture} alt="" className="h-5 w-5 rounded-full" />}
                <span className="max-w-[10rem] truncate">{c.name}</span>
                <span className="text-muted-foreground">{c.platform}</span>
              </button>
            ))}
          </div>

          <div className="space-y-3">
            {items.map((i) => (
              <div key={i.id} className="rounded-md border border-border/60 p-3">
                <div className="mb-2 truncate text-sm font-medium">{i.topic}</div>
                <Textarea
                  rows={3}
                  className="text-xs"
                  value={captions[i.id] ?? defaultCaption(i)}
                  onChange={(e) => setCaptions((c) => ({ ...c, [i.id]: e.target.value }))}
                />
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" onClick={() => post(i)} disabled={posting === i.id || !targets.length}>
                    {posting === i.id ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="mr-2 h-3.5 w-3.5" />
                    )}
                    Post to {targets.length || 'no'} channel{targets.length === 1 ? '' : 's'}
                  </Button>
                  <a
                    className="text-xs underline"
                    href={`/api/tutorial/reel/${i.jobId}.mp4`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    watch
                  </a>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
