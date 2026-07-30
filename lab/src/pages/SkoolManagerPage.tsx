/**
 * Skool Manager — setup.
 *
 * Skool has no public API, so this tool works by driving a real logged-in
 * browser on the server. That makes the first screen unusual for a Lab tool:
 * before it can read a single course it needs a session, and the honest way to
 * get one is to carry over a session minted on the operator's own machine.
 *
 * The onboarding is therefore the product for now. Everything downstream — the
 * classroom read, the course plan, the writing, the approval gate — is built on
 * whatever this establishes, and building any of it before a real session
 * exists would mean guessing at Skool's DOM.
 */
import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Check, ChevronRight, Cookie, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import {
  skoolStatus,
  skoolCheckLogin,
  skoolImportCookies,
  skoolSaveSettings,
  type SkoolStatus,
} from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';

const DEFAULT_COMMUNITY = 'https://www.skool.com/ai-automations-for-sales';

export default function SkoolManagerPage() {
  const [status, setStatus] = useState<SkoolStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [cookies, setCookies] = useState('');
  const [community, setCommunity] = useState('');
  const [roadmap, setRoadmap] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await skoolStatus();
      setStatus(s);
      if (!dirty) {
        setCommunity(s.settings.communityUrl || DEFAULT_COMMUNITY);
        setRoadmap(s.settings.roadmapMd || '');
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }, [dirty]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }

  const connected = !!status?.loggedIn;

  return (
    <Layout breadcrumb="Skool Manager">
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <BookOpen className="h-6 w-6 text-primary" />
            Skool Manager
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Builds and rearranges your classroom — courses, lessons and the videos that sit in them. Skool has no
            API, so it works by driving a real logged-in browser on this server.
          </p>
        </header>

        {err && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{err}</span>
          </div>
        )}
        {note && (
          <div className="flex items-start gap-2 rounded-lg border border-[hsl(var(--chart-3))]/40 bg-[hsl(var(--chart-3))]/10 p-3 text-sm">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" />
            <span>{note}</span>
          </div>
        )}

        {/* ── Step 1: the session ─────────────────────────────────────────── */}
        <section className="rounded-lg border p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs">1</span>
              Connect Skool
            </h2>
            <StatusChip status={status} />
          </div>

          {status && !status.browserAvailable ? (
            <p className="mt-3 text-sm text-muted-foreground">
              There's no headless browser on this server, so Skool can't be driven at all. That's an environment
              problem, not a setup step.
            </p>
          ) : connected ? (
            <div className="mt-3 space-y-3">
              <p className="text-sm">
                Signed in{status?.account ? <> as <span className="font-medium">{status.account}</span></> : ''}. The
                session lives in its own browser profile on this server and survives redeploys — you shouldn't have
                to do this again unless Skool signs you out.
              </p>
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  run('recheck', async () => {
                    const s = await skoolCheckLogin();
                    setStatus(s);
                    setNote(s.loggedIn ? 'Session is still good.' : 'That session is no longer valid — import again.');
                  })
                }
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
              >
                {busy === 'recheck' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Re-check the session
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <p className="text-sm text-muted-foreground">
                Sign-in is by <span className="font-medium text-foreground">carrying over a session you already
                have</span>, rather than logging in from here. This server has a datacenter IP and a headless
                browser, which is the shape sites challenge hardest — and if your Skool account is linked to Google,
                a login attempt has to clear Google's risk checks too. TikTok refused every interactive attempt for
                two days and accepted an imported session immediately.
              </p>

              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>
                  Install the <span className="font-medium text-foreground">Cookie-Editor</span> browser extension.
                </li>
                <li>
                  Open{' '}
                  <a
                    href={community || DEFAULT_COMMUNITY}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 underline"
                  >
                    your Skool community <ExternalLink className="h-3 w-3" />
                  </a>{' '}
                  in that browser, signed in as normal.
                </li>
                <li>
                  Open Cookie-Editor on that tab and hit <span className="font-medium text-foreground">Export → JSON</span>.
                </li>
                <li>Paste the result below.</li>
              </ol>

              <textarea
                value={cookies}
                onChange={(e) => setCookies(e.target.value)}
                rows={5}
                spellCheck={false}
                placeholder='[{"name":"...","value":"...","domain":".skool.com", ...}]'
                className="w-full rounded-md border bg-background p-2 font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Only cookies for <span className="font-mono">skool.com</span> are kept — anything else in the export
                is dropped before it reaches the browser profile.
              </p>

              <button
                type="button"
                disabled={!!busy || !cookies.trim()}
                onClick={() =>
                  run('import', async () => {
                    const s = await skoolImportCookies({ cookies });
                    setStatus(s);
                    if (s.loggedIn) {
                      setCookies('');
                      setNote(
                        `Connected${s.account ? ` as ${s.account}` : ''} — kept ${s.kept} of ${s.total} cookies.`,
                      );
                    } else {
                      setErr(
                        s.error ||
                          `Imported ${s.kept} of ${s.total} cookies but Skool still says signed out — the session may have expired. Re-export and try again.`,
                      );
                    }
                  })
                }
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cookie className="h-3.5 w-3.5" />}
                Import session
              </button>
            </div>
          )}
        </section>

        {/* ── Step 2: which community, and the roadmap ────────────────────── */}
        <section className="rounded-lg border p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs">2</span>
            The community and the roadmap
          </h2>

          <label className="mb-1 block text-xs font-medium text-muted-foreground">Community URL</label>
          <input
            value={community}
            onChange={(e) => {
              setCommunity(e.target.value);
              setDirty(true);
            }}
            placeholder={DEFAULT_COMMUNITY}
            className="mb-4 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />

          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Roadmap — what should a member move through, and in what order?
          </label>
          <p className="mb-2 text-xs text-muted-foreground">
            Free text. This is the input the course planner works from: it decides which courses exist and how they
            sequence, not just what they're called. Write it the way you'd explain the journey to a new member.
          </p>
          <textarea
            value={roadmap}
            onChange={(e) => {
              setRoadmap(e.target.value);
              setDirty(true);
            }}
            rows={12}
            placeholder={
              'e.g.\n\nStage 1 — they have never used AI. Get them to a first win with ChatGPT in under an hour.\nStage 2 — ...'
            }
            className="w-full rounded-md border bg-background p-2 text-sm"
          />

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              disabled={!!busy || !dirty}
              onClick={() =>
                run('save', async () => {
                  const { settings } = await skoolSaveSettings({ communityUrl: community.trim(), roadmapMd: roadmap });
                  setStatus((s) => (s ? { ...s, settings } : s));
                  setDirty(false);
                  setNote('Saved.');
                })
              }
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save
            </button>
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          </div>
        </section>

        {/* ── What comes next ─────────────────────────────────────────────── */}
        <section className="rounded-lg border border-dashed p-5">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs">3</span>
            Build the classroom
          </h2>
          <p className="text-sm text-muted-foreground">
            {connected
              ? "Not built yet. Now that there's a live session, the next step is reading your real classroom — its courses, lessons and ordering — so the planner works against what's actually there rather than an assumed shape."
              : 'Connect Skool above first. The classroom reader, the course planner and the writing pass all depend on a live session, and building them against a guessed page structure would mean rewriting them.'}
          </p>
          <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
            <ChevronRight className="h-3.5 w-3.5" />
            Nothing here writes to Skool. When it does, it'll show you the plan first.
          </div>
        </section>
      </div>
    </Layout>
  );
}

function StatusChip({ status }: { status: SkoolStatus | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">Checking…</span>;
  if (!status.browserAvailable) {
    return <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">No browser</span>;
  }
  if (status.loggedIn) {
    return (
      <span className="rounded-full bg-[hsl(var(--chart-3))]/15 px-2 py-0.5 text-xs text-[hsl(var(--chart-3))]">
        Connected
      </span>
    );
  }
  return <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Not connected</span>;
}
