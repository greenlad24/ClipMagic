/**
 * Settings → "Screencast logins" (Jake 2026-10-08: "how can I log in? Add a UI to the settings page").
 *
 * The UX Scout and the Auto Editor's screencast recorder work inside these accounts, in the
 * server's own browser. Each app has its own saved session; this lists them and opens the
 * existing live login console (ScoutLoginDialog) for any of them — including the
 * "paste your session" fallback for sites that block the server's sign-in.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { CheckCircle2, CircleDashed, LogIn, MonitorPlay, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import ScoutLoginDialog from './ScoutLoginDialog';
import { listTools, type ScoutTool } from './api';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function ScreencastLogins() {
  const [tools, setTools] = useState<ScoutTool[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setTools((await listTools()).tools); } catch { setTools([]); }
  }, []);
  useEffect(() => { if (expanded && tools === null) void load(); }, [expanded, tools, load]);

  const openFor = (s: string | null) => { setSlug(s); setOpen(true); };

  // Collapsed by default and placed at the bottom of Settings (Jake: "so it's not easy to find").
  if (!expanded) {
    return (
      <button type="button" onClick={() => setExpanded(true)}
        className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground focus-visible:outline-none focus-visible:underline">
        <ChevronRight className="h-3 w-3" /> Screencast logins
      </button>
    );
  }

  return (
    <section className="mb-6 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <MonitorPlay className="h-4 w-4 text-muted-foreground" /> Screencast logins
          </h2>
          <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
            The Auto Editor records its screencasts — and the UX Scout explores — inside these accounts, in the
            server's own browser. Log in once per app; the session is kept for every later recording. If a site
            refuses the server's sign-in, use <strong className="text-foreground">Can't log in here? Paste your session</strong> in the login window.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openFor(null)}>
            <Plus className="h-3.5 w-3.5" /> Add an app
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>Hide</Button>
        </div>
      </div>

      <div className="mt-4 divide-y divide-border">
        {tools === null ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : tools.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No apps yet — add the first one.</p>
        ) : (
          tools.map((t) => (
            <div key={t.slug} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{t.name}</p>
                <p className="truncate text-xs text-muted-foreground">{t.homeUrl}</p>
                <p className="mt-1 flex items-center gap-1.5 text-xs">
                  {t.loggedInAt ? (
                    <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      <span className="text-muted-foreground">Logged in · last confirmed {fmtDate(t.loggedInAt)}</span></>
                  ) : (
                    <><CircleDashed className="h-3.5 w-3.5 text-amber-500" />
                      <span className="text-muted-foreground">Not logged in</span></>
                  )}
                </p>
              </div>
              <Button size="sm" variant={t.loggedInAt ? 'outline' : 'default'} className="shrink-0 gap-1.5" onClick={() => openFor(t.slug)}>
                <LogIn className="h-3.5 w-3.5" /> {t.loggedInAt ? 'Log in again / switch account' : 'Log in'}
              </Button>
            </div>
          ))
        )}
      </div>

      <ScoutLoginDialog
        open={open}
        onOpenChange={(o) => { setOpen(o); if (!o) void load(); }}
        onToolsChanged={(ts) => setTools(ts)}
        initialSlug={slug}
      />
    </section>
  );
}
