import { useEffect, useMemo, useState } from 'react';
import { useAuth } from 'zite-auth-sdk';
import {
  getPostizSettings,
  updatePostizSettings,
  restartPostiz,
  type GetPostizSettingsOutputType,
  type PostizKeyState,
} from 'zite-endpoints-sdk';
import { toast } from 'sonner';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CheckCircle2,
  Circle,
  ShieldAlert,
  Eye,
  EyeOff,
  Trash2,
  Save,
  RefreshCw,
  Lock,
} from 'lucide-react';

/**
 * Postiz Settings — write-only key management for the self-hosted social poster.
 *
 * Postiz is a SEPARATE container that reads its config from environment at
 * startup. This page lets the user set the container's core config + per-platform
 * OAuth credentials WITHOUT ever exposing them again: the API only reports
 * "Configured / Not set" per key. Saving rewrites a shared env file that the
 * Postiz container sources on boot, and "Save & restart Postiz" restarts the
 * container (via the Docker socket) so the keys take effect in one click.
 */
export default function PostizSettingsPage() {
  const { user } = useAuth();
  const [data, setData] = useState<GetPostizSettingsOutputType | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const load = () =>
    getPostizSettings({})
      .then(setData)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load Postiz settings'));

  useEffect(() => {
    if (!user) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Group keys by their `group` field, preserving the registry order.
  const groups = useMemo(() => {
    const map = new Map<string, PostizKeyState[]>();
    for (const k of data?.keys ?? []) {
      const list = map.get(k.group) ?? [];
      list.push(k);
      map.set(k.group, list);
    }
    return Array.from(map.entries());
  }, [data]);

  const dirtyKeys = useMemo(
    () => Object.entries(drafts).filter(([, v]) => v.trim().length > 0).map(([k]) => k),
    [drafts],
  );

  const apply = async (restart: boolean) => {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(drafts)) {
      if (v.trim().length > 0) values[k] = v;
    }
    if (Object.keys(values).length === 0) {
      toast.info('Nothing to save — enter a value in at least one field first.');
      return;
    }
    setBusy(true);
    try {
      const res = await updatePostizSettings({ values });
      setData((prev) => (prev ? { ...prev, keys: res.keys, envFileWritable: res.envFileWritable } : prev));
      setDrafts({});
      setReveal({});
      if (res.envWriteError) {
        toast.warning(
          'Saved, but the shared config file is not writable here — Postiz will pick up keys only on the server.',
        );
      } else {
        toast.success('Keys saved.');
      }
      if (restart) await doRestart();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save keys');
    } finally {
      setBusy(false);
    }
  };

  const doRestart = async () => {
    const r = await restartPostiz({});
    if (r.success) toast.success(r.message);
    else toast.error(r.message);
  };

  const remove = async (key: string, label: string) => {
    setBusy(true);
    try {
      const res = await updatePostizSettings({ remove: [key] });
      setData((prev) => (prev ? { ...prev, keys: res.keys, envFileWritable: res.envFileWritable } : prev));
      setDrafts((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      toast.success(`Removed ${label}. Restart Postiz to apply.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove key');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout breadcrumb="Postiz Settings">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">Postiz Settings</h1>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            Configure the self-hosted social poster. Keys are stored on the server and applied to the
            Postiz container — they are <strong className="text-foreground">never shown again</strong>,
            only marked as configured. Enter a value and use{' '}
            <strong className="text-foreground">Save &amp; restart Postiz</strong> to apply.
          </p>
        </header>

        {/* Security + reachability notices */}
        <div className="mb-6 space-y-3">
          <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/30 p-4 text-sm">
            <Lock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-muted-foreground">
              Write-only: the suite never returns saved values. They are persisted{' '}
              <code className="bg-muted px-1 rounded text-xs">0600</code> in the lab data dir and the
              shared Postiz config volume, and are git-ignored.
            </p>
          </div>
          {data && (
            <div
              className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${
                data.dockerSocketAvailable
                  ? 'border-border bg-muted/30'
                  : 'border-yellow-500/30 bg-yellow-500/10'
              }`}
            >
              <ShieldAlert
                className={`h-4 w-4 mt-0.5 shrink-0 ${
                  data.dockerSocketAvailable ? 'text-muted-foreground' : 'text-yellow-500'
                }`}
              />
              <p className="text-muted-foreground">
                {data.dockerSocketAvailable ? (
                  <>
                    One-click restart is enabled via the Docker socket. This is a real privilege — the
                    suite can manage containers (used only to restart Postiz so new keys apply).
                  </>
                ) : (
                  <>
                    The Docker socket isn&apos;t mounted here, so keys can&apos;t auto-apply. Saving still
                    persists them; restart Postiz on the server to pick them up:{' '}
                    <code className="bg-muted px-1 rounded text-xs">
                      docker compose --profile postiz restart postiz
                    </code>
                  </>
                )}
              </p>
            </div>
          )}
        </div>

        {!data ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(([group, keys]) => (
              <section key={group} className="rounded-xl border border-border bg-card p-5">
                <h2 className="text-sm font-semibold text-foreground mb-1">{group}</h2>
                <div className="mt-4 space-y-5">
                  {keys.map((k) => (
                    <KeyRow
                      key={k.key}
                      state={k}
                      draft={drafts[k.key] ?? ''}
                      reveal={!!reveal[k.key]}
                      disabled={busy}
                      onDraft={(v) => setDrafts((d) => ({ ...d, [k.key]: v }))}
                      onToggleReveal={() => setReveal((r) => ({ ...r, [k.key]: !r[k.key] }))}
                      onRemove={() => remove(k.key, k.label)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {/* Sticky action bar */}
      {data && (
        <div className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur">
          <div className="max-w-3xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {dirtyKeys.length > 0
                ? `${dirtyKeys.length} key${dirtyKeys.length === 1 ? '' : 's'} ready to save`
                : 'No pending changes'}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || dirtyKeys.length === 0}
                onClick={() => apply(false)}
              >
                <Save className="h-4 w-4" />
                Save only
              </Button>
              <Button size="sm" disabled={busy || dirtyKeys.length === 0} onClick={() => apply(true)}>
                <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
                Save &amp; restart Postiz
              </Button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

function KeyRow({
  state,
  draft,
  reveal,
  disabled,
  onDraft,
  onToggleReveal,
  onRemove,
}: {
  state: PostizKeyState;
  draft: string;
  reveal: boolean;
  disabled: boolean;
  onDraft: (v: string) => void;
  onToggleReveal: () => void;
  onRemove: () => void;
}) {
  const inputId = `postiz-${state.key}`;
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">
          {state.label}
        </label>
        {state.configured ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
            <CheckCircle2 className="h-3.5 w-3.5" /> Configured
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Circle className="h-3.5 w-3.5" /> Not set
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">{state.connects}</p>
      <div className="mt-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            id={inputId}
            type={reveal ? 'text' : 'password'}
            value={draft}
            disabled={disabled}
            autoComplete="off"
            placeholder={state.configured ? 'Configured — enter a new value to replace' : 'Not set'}
            onChange={(e) => onDraft(e.target.value)}
            className="pr-9 font-mono"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={reveal ? 'Hide value' : 'Show value'}
            onClick={onToggleReveal}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {state.configured && (
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={`Remove ${state.label}`}
            title={`Remove ${state.label}`}
            onClick={onRemove}
            className="text-muted-foreground hover:text-destructive shrink-0"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
