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
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen, Check, ChevronRight, Cookie, ExternalLink, Loader2, MousePointer,
  RefreshCw, Save, Trash2, X,
} from 'lucide-react';
import {
  skoolStatus,
  skoolCheckLogin,
  skoolImportCookies,
  skoolSaveSettings,
  skoolConsoleFrame,
  skoolConsoleNavigate,
  skoolConsoleHover,
  skoolConsoleClick,
  skoolConsoleType,
  skoolConsoleKey,
  skoolConsoleScroll,
  skoolConsoleClearField,
  skoolSaveRecipe,
  skoolListRecipes,
  skoolDeleteRecipe,
  type SkoolStatus,
  type SkoolConsoleFrame,
  type SkoolRecipe,
  type SkoolRecipeStep,
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
              ? "Skool's editing controls can't be found by reading the page — they're plain divs that don't exist until you hover them. So show it once: click through an action below and it records what you clicked."
              : 'Connect Skool above first. The console drives the same logged-in browser, so there is nothing to show until a session exists.'}
          </p>
          {connected && <TeachConsole />}
          <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
            <ChevronRight className="h-3.5 w-3.5" />
            Recording only watches what you do. Nothing is written to Skool except the clicks you make yourself.
          </div>
        </section>
      </div>
    </Layout>
  );
}

/**
 * Shortcuts worth a button. Labelled with ⌘ because that is the key the
 * operator presses; the server sends Control, since the remote browser is
 * Linux and Meta does nothing there.
 */
const COMBOS: [string, string[]][] = [
  ['⌘A', ['cmd', 'a']],
  ['⌘C', ['cmd', 'c']],
  ['⌘X', ['cmd', 'x']],
  ['⌘V', ['cmd', 'v']],
  ['⌘Z', ['cmd', 'z']],
];

/**
 * The teach console.
 *
 * A live view of the server's Skool browser. The operator performs an action
 * once; each click is recorded as an element DESCRIPTOR — what was clicked,
 * not where — because coordinates stop being true the moment a card moves or
 * a list grows.
 *
 * Positions are sent as FRACTIONS of the displayed image so the panel can be
 * any size; the server scales them to the real viewport.
 */
function TeachConsole() {
  const [frame, setFrame] = useState<SkoolConsoleFrame | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'browse' | 'record'>('browse');
  // Hover is its own action in Skool: the per-card menus do not exist in the
  // page until the pointer is over the card, so a recipe has to be able to say
  // "hover this first".
  const [tool, setTool] = useState<'click' | 'hover'>('click');
  const [steps, setSteps] = useState<SkoolRecipeStep[]>([]);
  const [recipeName, setRecipeName] = useState('');
  const [recipes, setRecipes] = useState<SkoolRecipe[]>([]);
  const [typing, setTyping] = useState('');
  const [chord, setChord] = useState('');
  const [clearNote, setClearNote] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  // Keystrokes are queued rather than fired in parallel. Each one returns a
  // frame, and two in flight at once come back in whatever order the server
  // finishes them — which shows the operator a stale picture of their own
  // typing.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [url, setUrl] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFrame((await skoolConsoleFrame()).frame);
    } catch {
      /* keep the last frame — a dropped poll is not worth blanking the view */
    }
  }, []);

  const loadRecipes = useCallback(async () => {
    try {
      setRecipes((await skoolListRecipes()).recipes);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadRecipes();
  }, [refresh, loadRecipes]);

  async function act(fn: () => Promise<{ frame: SkoolConsoleFrame }>) {
    setBusy(true);
    try {
      setFrame((await fn()).frame);
    } catch {
      /* leave the previous frame up */
    } finally {
      setBusy(false);
    }
  }

  /**
   * Forward a real keystroke to the remote browser.
   *
   * Everything goes through here — printable characters, Backspace, Delete,
   * arrows, and chords — because the alternative is a button per key, and the
   * keys an operator actually needs while editing a lesson are the ones nobody
   * thinks to add a button for.
   */
  const sendKey = (e: React.KeyboardEvent) => {
    if (!capturing) return;
    // The browser's own shortcuts must not also fire: ⌘A here should select
    // inside the remote page, not this one.
    e.preventDefault();
    e.stopPropagation();

    const key = e.key;
    if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') return;

    const mods: string[] = [];
    if (e.metaKey || e.ctrlKey) mods.push('cmd');
    if (e.altKey) mods.push('alt');
    // Shift is already reflected in `key` for printable characters ("A" not
    // "a"), so adding it there would send Shift+A and produce nothing.
    if (e.shiftKey && key.length > 1) mods.push('shift');

    const combo = [...mods, key];
    const label = combo.join('+');
    queue.current = queue.current
      .then(async () => {
        const out = await skoolConsoleKey(mods.length ? { combo } : { key });
        setFrame(out.frame);
        if (mode === 'record') {
          setSteps((s) => [...s, { kind: 'key', label, value: label }]);
        }
      })
      .catch(() => undefined);
  };

  const onImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current || busy) return;
    const rect = imgRef.current.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const yFrac = (e.clientY - rect.top) / rect.height;

    if (tool === 'hover') {
      await act(() => skoolConsoleHover({ xFrac, yFrac }));
      if (mode === 'record') {
        setSteps((s) => [...s, { kind: 'hover', label: 'Hover', target: undefined }]);
      }
      return;
    }

    setBusy(true);
    try {
      const out = await skoolConsoleClick({ xFrac, yFrac, describe: mode === 'record' });
      setFrame(out.frame);
      if (mode === 'record') {
        // A click whose target could not be described is recorded WITHOUT a
        // target rather than dropped — a silently missing step would replay as
        // a recipe that skips an action and looks like it worked.
        setSteps((s) => [
          ...s,
          {
            kind: 'click',
            label: out.descriptor?.text || out.descriptor?.ariaLabel || out.descriptor?.tag || 'Click',
            target: out.descriptor ?? undefined,
          },
        ]);
      }
    } catch {
      /* leave the frame */
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const name = recipeName.trim();
    if (!name || steps.length === 0) return;
    try {
      await skoolSaveRecipe({ name, steps });
      setSteps([]);
      setRecipeName('');
      await loadRecipes();
    } catch {
      /* the button stays available to retry */
    }
  };

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim()) void act(() => skoolConsoleNavigate({ url: url.trim() }));
          }}
          placeholder="https://www.skool.com/…  (Enter to go)"
          className="min-w-[18rem] flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
        <button onClick={() => void refresh()} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
          <RefreshCw className="mr-1 inline h-3 w-3" />Refresh
        </button>
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          {(['browse', 'record'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-1 ${mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {m === 'browse' ? 'Browse' : 'Record'}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          {(['click', 'hover'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTool(t)}
              className={`px-2 py-1 ${tool === t ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {t === 'click' ? 'Click' : 'Hover'}
            </button>
          ))}
        </div>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <span className="ml-auto max-w-[40%] truncate text-xs text-muted-foreground">{frame?.url ?? ''}</span>
      </div>

      <div
        tabIndex={0}
        onKeyDown={sendKey}
        onFocus={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        className={`overflow-auto rounded-lg border bg-black/40 p-2 outline-none ${
          capturing ? 'border-primary ring-1 ring-primary' : 'border-border'
        }`}
      >
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          {capturing ? (
            <span className="text-primary">
              Keyboard connected — everything you type goes to Skool, including Backspace, Delete and ⌘ shortcuts.
            </span>
          ) : (
            <span>Click the picture to connect your keyboard to it.</span>
          )}
        </div>
        {frame?.image ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame.image}`}
            onClick={onImageClick}
            onDragStart={(e) => e.preventDefault()}
            alt="Skool browser"
            className="mx-auto max-w-full cursor-crosshair select-none rounded-md"
          />
        ) : (
          <div className="grid h-64 place-items-center text-sm text-muted-foreground">
            {frame?.error ?? 'Waiting for the browser…'}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typing) {
              const text = typing;
              void act(() => skoolConsoleType({ text })).then(() => {
                if (mode === 'record') {
                  setSteps((s) => [...s, { kind: 'type', label: `Type "${text}"`, text }]);
                }
                setTyping('');
              });
            }
          }}
          placeholder="Click a field above, then type here and press Enter"
          className="min-w-[16rem] flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
        {(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete'] as const).map((k) => (
          <button
            key={k}
            onClick={() => {
              void act(() => skoolConsoleKey({ key: k }));
              if (mode === 'record') setSteps((s) => [...s, { kind: 'key', label: k, value: k }]);
            }}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            {k}
          </button>
        ))}
        {/* ⌘ is shown because that is what the operator presses; Control is
            what gets sent, because the remote browser is Linux. */}
        {COMBOS.map(([label, combo]) => (
          <button
            key={label}
            onClick={() => {
              void act(() => skoolConsoleKey({ combo }));
              if (mode === 'record') {
                setSteps((s) => [...s, { kind: 'key', label, value: combo.join('+') }]);
              }
            }}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            {label}
          </button>
        ))}
        <input
          value={chord}
          onChange={(e) => setChord(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && chord.trim()) {
              const combo = chord.split('+').map((p) => p.trim()).filter(Boolean);
              void act(() => skoolConsoleKey({ combo })).then(() => {
                if (mode === 'record') {
                  setSteps((s) => [...s, { kind: 'key', label: chord, value: combo.join('+') }]);
                }
                setChord('');
              });
            }
          }}
          placeholder="any chord, e.g. cmd+shift+z"
          className="w-40 rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
        <button
          onClick={async () => {
            setBusy(true);
            try {
              const out = await skoolConsoleClearField();
              setFrame(out.frame);
              if (out.cleared && mode === 'record') {
                setSteps((s) => [...s, { kind: 'key', label: 'Clear field', value: 'clearField' }]);
              }
              if (!out.cleared) setClearNote(out.reason);
              else setClearNote(null);
            } catch {
              /* leave the frame */
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          Clear field
        </button>
        <button onClick={() => void act(() => skoolConsoleScroll({ dy: -400 }))} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
          Scroll ↑
        </button>
        <button onClick={() => void act(() => skoolConsoleScroll({ dy: 400 }))} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
          Scroll ↓
        </button>
      </div>

      {clearNote && <div className="text-xs text-destructive">{clearNote}</div>}

      {mode === 'record' && (
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center gap-2">
            <MousePointer className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">Recording — {steps.length} step{steps.length === 1 ? '' : 's'}</span>
            <input
              value={recipeName}
              onChange={(e) => setRecipeName(e.target.value)}
              placeholder="name this action, e.g. newCourse"
              className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs"
            />
            <button
              onClick={() => void save()}
              disabled={!recipeName.trim() || steps.length === 0}
              className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-40"
            >
              <Save className="mr-1 inline h-3 w-3" />Save
            </button>
            <button onClick={() => setSteps([])} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
              Clear
            </button>
          </div>
          <ol className="space-y-1 text-xs text-muted-foreground">
            {steps.map((st, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-5 text-right">{i + 1}.</span>
                <span className="rounded bg-muted px-1.5 py-0.5">{st.kind}</span>
                <span className="truncate">{st.label}</span>
                {/* The handle a step will replay on. A step with only a class
                    is a step about to break when Skool redeploys. */}
                {st.target && (
                  <span className="ml-auto shrink-0 text-[10px] opacity-60">
                    {st.target.testId
                      ? `testid=${st.target.testId}`
                      : st.target.text
                        ? 'by text'
                        : st.target.classes[0]
                          ? `class=${st.target.classes[0]}`
                          : 'by position — fragile'}
                  </span>
                )}
              </li>
            ))}
            {steps.length === 0 && <li className="pl-7">Click something in the view above to record a step.</li>}
          </ol>
        </div>
      )}

      {recipes.length > 0 && (
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 text-xs font-semibold">Taught actions</div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {recipes.map((r) => (
              <li key={r.name} className="flex items-center gap-2">
                <Check className="h-3 w-3 text-[hsl(var(--chart-3))]" />
                <span className="font-mono">{r.name}</span>
                <span className="opacity-60">{r.steps.length} steps</span>
                <button
                  onClick={async () => {
                    await skoolDeleteRecipe({ name: r.name }).catch(() => undefined);
                    await loadRecipes();
                  }}
                  className="ml-auto opacity-60 hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
