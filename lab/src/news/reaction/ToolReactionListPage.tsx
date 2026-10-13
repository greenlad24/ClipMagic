/**
 * Tool Reaction — /news-gatherer/tool-reaction, the AI News Stream's third show
 * (Jake 2026-10-13). A short hook presentation (Jake's camera in a frame on the
 * left, OBS fills it), then Jake goes live into the tool on his own screen and
 * tests its most interesting features, with a script and per-step notes built
 * from a UX Scout run made while preparing (server news/toolReaction.ts).
 *
 * A reaction is stored as a v2 Deep Dive (show_kind "reaction"), so it opens in
 * the Deep Dive editor, presenter and stage — this page only starts and lists them.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clapperboard, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import NewsShell from '../shell/NewsShell';
import { useAuth } from '../auth';
import { listDeepDives, createDeepDive, deleteDeepDive, editorPath, type DeepDive } from '../deepdive/api';
import { STATUS_BADGE } from '../deepdive/DeepDiveListPage';

export default function ToolReactionListPage() {
  return (
    <NewsShell title="Tool Reaction">
      <ReactionList />
    </NewsShell>
  );
}

const ago = (ts: number | string | null) => {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return m < 1 ? 'just now' : `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

function ReactionList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<DeepDive[] | null>(null);
  const [tool, setTool] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [creating, setCreating] = useState(false);

  const load = () => listDeepDives('reaction').then((r) => setItems(r.deepDives)).catch((e) => toast.error(String(e?.message ?? e)));
  useEffect(() => { if (user) void load(); }, [user]);

  const validUrl = /^https?:\/\/\S+\.\S+/.test(url.trim());
  const create = async () => {
    if (!tool.trim() || !validUrl) return;
    setCreating(true);
    try {
      const { deepDive } = await createDeepDive({ topic: tool.trim(), angle: notes.trim(), demoUrl: url.trim(), format: 'v2', showKind: 'reaction' });
      navigate(`${editorPath(deepDive.id)}?generate=1`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const remove = async (d: DeepDive) => {
    if (!window.confirm(`Delete "${d.title || d.topic}"? This can't be undone.`)) return;
    try { await deleteDeepDive(d.id); setItems((list) => list?.filter((x) => x.id !== d.id) ?? null); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="mx-auto max-w-5xl px-3 py-5 sm:px-5">
      <div className="mb-4 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">Tool Reaction</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">A short hook, then you go live into the tool — script and step notes from a UX Scout test</span>
      </div>

      <div className="mb-6 rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-primary" /> New tool reaction</div>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="rx-tool">Tool, feature or product</label>
              <Input id="rx-tool" value={tool} onChange={(e) => setTool(e.target.value)} placeholder="e.g. Grok Bots, Claude's Chrome extension" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="rx-url">Where it lives <span className="font-normal">(the UX Scout tests it here)</span></label>
              <Input id="rx-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://grok.com" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="rx-notes">What to test <span className="font-normal">(optional — the features you want, the angle, what to skip)</span></label>
            <Textarea id="rx-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              placeholder="e.g. The new bots — create one, put it in a group chat, see if it replies on its own. Skip the API." />
          </div>
          <div className="rounded-md border border-border bg-muted/20 p-2 text-xs text-muted-foreground">
            <b className="text-foreground">How it runs:</b> the UX Scout signs in and tests the tool's newest features in the Lab's browser (about 20–40 min — sign in to the tool first under the Script Generator's UX Scout → Tool logins), while the research runs. Then the hook slides, one live chapter per feature (your step notes + its screenshots as the stage's backup) and a verdict are written.
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={create} disabled={creating || !tool.trim() || !validUrl} className="gap-1.5">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
              Create & prepare
            </Button>
            {url.trim() && !validUrl && <span className="text-xs text-destructive">Give the full address, starting with https://</span>}
          </div>
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Your tool reactions</h2>
      {items === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">None yet. Name a tool above.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2">
          {items.map((d) => {
            const badge = d.status === 'generating' ? { label: 'Preparing…', cls: STATUS_BADGE.generating.cls } : STATUS_BADGE[d.status] ?? STATUS_BADGE.draft;
            return (
              <li key={d.id} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-muted-foreground/30">
                <Link to={editorPath(d.id)} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
                    <span className="text-[11px] text-muted-foreground">{d.demoUrl?.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')} · {ago(d.updatedAt || d.createdAt)}</span>
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold">{d.title || d.topic}</p>
                  <p className="truncate text-xs text-muted-foreground">{d.status === 'generating' ? d.progressMessage : d.sectionCount ? `${d.sectionCount} chapters` : 'Not prepared yet'}</p>
                </Link>
                <button onClick={() => remove(d)} disabled={d.status === 'generating'} title="Delete"
                  className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-40">
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
