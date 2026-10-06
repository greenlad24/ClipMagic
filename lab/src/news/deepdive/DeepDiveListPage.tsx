/**
 * Deep Dive — /news-gatherer/deep-dive: start a new one (typed topic, or a
 * story from the Daily Show via ?story=<id>) and see the existing ones.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Telescope, Trash2, Sparkles, Newspaper, X, Palette, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import NewsShell from '../shell/NewsShell';
import { useAuth } from '../auth';
import { getStories, type Story } from '../api';
import { listDeepDives, createDeepDive, deleteDeepDive, editorPath, type DeepDive } from './api';
import TemplatePicker from './TemplatePicker';
import { DEFAULT_TEMPLATE, TEMPLATES, templateFor, type TemplateId } from './templates';

export default function DeepDiveListPage() {
  return (
    <NewsShell title="Deep Dive">
      <DeepDiveList />
    </NewsShell>
  );
}

export const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft:      { label: 'Not generated', cls: 'border-border text-muted-foreground' },
  generating: { label: 'Generating…',   cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
  ready:      { label: 'Ready',         cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  error:      { label: 'Failed',        cls: 'border-rose-500/30 bg-rose-500/10 text-rose-300' },
};

function ago(ts: number | string | null): string {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function DeepDiveList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const storyId = params.get('story') || '';

  const [dives, setDives] = useState<DeepDive[] | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [topic, setTopic] = useState('');
  const [angle, setAngle] = useState('');
  const [creating, setCreating] = useState(false);
  // v2 = the chapter show built around real demos (Jake, 2026-10-02); v1 stays available.
  const [format, setFormat] = useState<'v1' | 'v2'>('v2');
  const [demoAgent, setDemoAgent] = useState(false);
  const [demoUrl, setDemoUrl] = useState('');
  // The design it's built in (Jake, 2026-10-06) — his brand unless he picks another.
  const [template, setTemplate] = useState<TemplateId>(DEFAULT_TEMPLATE);
  const [showTemplates, setShowTemplates] = useState(false);

  const load = () => listDeepDives().then((r) => setDives(r.deepDives)).catch((e) => toast.error(String(e?.message ?? e)));
  useEffect(() => { if (user) void load(); }, [user]);

  // Started from a Daily Show story: prefill from it.
  useEffect(() => {
    if (!user || !storyId) { setStory(null); return; }
    getStories({}).then((r) => {
      const s = r.stories.find((x) => x.id === storyId) ?? null;
      setStory(s);
      if (s) setTopic((t) => t || s.headline);
    }).catch(() => {});
  }, [user, storyId]);

  const clearStory = () => { const p = new URLSearchParams(params); p.delete('story'); setParams(p, { replace: true }); };

  const create = async () => {
    if (!topic.trim() && !story) return;
    setCreating(true);
    try {
      const { deepDive } = await createDeepDive({ topic: topic.trim(), angle: angle.trim(), storyId: story?.id, format, demoAgent: format === 'v2' && demoAgent, demoUrl: demoUrl.trim(), template });
      navigate(`${editorPath(deepDive.id)}?generate=1`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const remove = async (d: DeepDive) => {
    if (!window.confirm(`Delete "${d.title || d.topic}"? This can't be undone.`)) return;
    try { await deleteDeepDive(d.id); setDives((list) => list?.filter((x) => x.id !== d.id) ?? null); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="mx-auto max-w-5xl px-3 py-5 sm:px-5">
      <div className="mb-4 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">Deep Dive</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">One topic → researched → a ~10-minute animated segment you present live</span>
      </div>

      {/* New */}
      <div className="mb-6 rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-primary" /> New deep dive</div>
        {story && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
            <Newspaper className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              From today's story: <span className="font-medium text-foreground">{story.headline}</span>
              <span className="text-muted-foreground"> · its {story.blogSources.length + story.articleSources.length} sources seed the research</span>
            </span>
            <button onClick={clearStory} className="text-muted-foreground hover:text-foreground" title="Don't use this story"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
        <div className="grid gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="dd-topic">Topic</label>
            <Input id="dd-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Why everyone is suddenly talking about AI agents"
              onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="dd-angle">Angle <span className="font-normal">(optional — what to focus on, what to skip)</span></label>
            <Textarea id="dd-angle" value={angle} onChange={(e) => setAngle(e.target.value)} rows={2}
              placeholder="e.g. Focus on what it means for people who use ChatGPT for school and work. Skip the stock price." />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex overflow-hidden rounded-md border border-border">
              {([['v2', 'Demo show (new)'], ['v1', 'Classic slides']] as const).map(([f, label]) => (
                <button key={f} type="button" onClick={() => setFormat(f)}
                  className={`px-2.5 py-1 ${format === f ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{label}</button>
              ))}
            </div>
            {format === 'v2' && (
              <>
                <button type="button" role="switch" aria-checked={demoAgent} onClick={() => setDemoAgent((v) => !v)}
                  className={`relative ml-2 h-5 w-9 shrink-0 rounded-full transition-colors ${demoAgent ? 'bg-primary' : 'bg-muted-foreground/30'}`} title="Demo agent on/off">
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition-all ${demoAgent ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
                <span className="text-muted-foreground">Demo agent{demoAgent ? ': an AI uses the real product and records it' : ' (off)'}</span>
                {demoAgent && <Input value={demoUrl} onChange={(e) => setDemoUrl(e.target.value)} placeholder="Product URL (optional)" className="h-7 max-w-[220px] text-xs" />}
              </>
            )}
          </div>
          <div className="rounded-md border border-border bg-muted/20 p-2">
            <button type="button" onClick={() => setShowTemplates((v) => !v)} className="flex w-full items-center gap-2 text-left text-xs">
              <Palette className="h-3.5 w-3.5 text-primary" />
              <span className="text-muted-foreground">Template</span>
              <span className="flex gap-0.5" aria-hidden>{(() => { const t = templateFor(template); return [t.ink, t.paper, t.accent, t.accent2]; })().map((c, i) => <span key={i} className="h-3 w-3 rounded-full ring-1 ring-black/20" style={{ background: c }} />)}</span>
              <span className="font-semibold text-foreground">{templateFor(template).name}</span>
              <span className="ml-auto flex items-center gap-1 text-muted-foreground">{showTemplates ? 'Hide' : `Choose from ${TEMPLATES.length}`}{showTemplates ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</span>
            </button>
            {showTemplates && (
              <div className="mt-3">
                <TemplatePicker value={template} format={format} onChange={(t) => setTemplate(t)} />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={create} disabled={creating || (!topic.trim() && !story)} className="gap-1.5">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Telescope className="h-4 w-4" />}
              Create & generate
            </Button>
            <span className="text-xs text-muted-foreground">{format === 'v2' ? 'Research + the official video cut into clips + the official post + screenshot walkthroughs + script. Takes several minutes — you can leave the page.' : 'Web research + outline + script + videos. Takes several minutes — you can leave the page.'}</span>
          </div>
        </div>
      </div>

      {/* Existing */}
      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Your deep dives</h2>
      {dives === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : dives.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          None yet. Type a topic above, or press <span className="font-medium text-foreground">Deep dive</span> on a story in the Daily Show.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2">
          {dives.map((d) => {
            const badge = STATUS_BADGE[d.status] ?? STATUS_BADGE.draft;
            return (
              <li key={d.id} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-muted-foreground/30">
                <Link to={editorPath(d.id)} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
                    {d.storyId && <span className="text-[11px] text-muted-foreground">from a Daily Show story</span>}
                    <span className="text-[11px] text-muted-foreground">· {ago(d.updatedAt || d.createdAt)}</span>
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold">{d.title || d.topic}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {d.sectionCount ? `${d.sectionCount} sections` : 'No sections yet'}
                    {d.title && d.title !== d.topic ? ` · ${d.topic}` : ''}
                  </p>
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
