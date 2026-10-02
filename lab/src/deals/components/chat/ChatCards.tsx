/**
 * The chat's tool cards. Every write is a button Jake presses:
 *   draft        → AgentDraftCard (Save as Gmail draft = sendReply; drafts only)
 *   followups    → FollowUpPanel (Save as Gmail draft = sendFollowUp; suggested stage = a button)
 *   queue        → follow-up debt + "Draft follow-ups" (getFollowUpDrafts for those deals)
 *   deal_update  → Confirm → updateDeal (nothing changes before the click)
 *   thread / threads / fit / deals → read-only, with links
 * Thread links open the thread in the chat's side panel (ChatThreadPanel) —
 * read it, AI-draft and send the reply without leaving the chat.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ExternalLink, Loader2, Mail, Sparkles, X, KanbanSquare, Globe, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { updateDeal } from '@/deals/api';
import { getFollowUpDraftsFor, type DraftReplyResult, type FollowUpDeal } from '@/deals/apiInbox';
import AgentDraftCard from '@/deals/components/thread/AgentDraftCard';
import FollowUpPanel from '@/deals/components/FollowUpPanel';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { citationHref } from './CitedMarkdown';
import { ThreadLink, useOpenThread } from './ChatThreadPanel';

const box = 'border border-border rounded-xl bg-card p-3.5 text-sm w-full min-w-0';
const ago = (iso?: string | null) => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

function StagePill({ stage }: { stage: string }) {
  const { resolveStageKey, getStageLabel, getStageColor } = useStageLabels();
  const key = resolveStageKey(stage);
  const label = key ? getStageLabel(key, stage) : stage;
  const color = key ? getStageColor(key) : 'hsl(var(--muted-foreground))';
  return (
    <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap max-w-[180px] truncate"
      style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>{label}</span>
  );
}

/* ── draft ─────────────────────────────────────────────────────────────── */

export function DraftCard({ data }: { data: DraftReplyResult }) {
  return (
    <div className="space-y-1.5 w-full min-w-0">
      <AgentDraftCard threadId={data.threadId} initial={data} />
      <ThreadLink threadId={data.threadId} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary">
        <Mail size={11} /> Open the whole thread
      </ThreadLink>
    </div>
  );
}

/* ── follow-ups ────────────────────────────────────────────────────────── */

export function FollowUpsCard({ data }: { data: { deals: FollowUpDeal[] } }) {
  return <FollowUpPanel deals={data.deals ?? []} />;
}

interface QueueItem { dealId: string; dealName: string; stage: string; threadId: string; subject: string | null; lastAt: string | null; daysSilent: number | null }
export function QueueCard({ data }: { data: { counts: Record<string, number>; minDays: number; waitingOnThem: QueueItem[]; owedReply: QueueItem[] } }) {
  const [tab, setTab] = useState<'waiting' | 'owed'>(data.counts.owedReply && !data.counts.waitingOnThem ? 'owed' : 'waiting');
  const [showAll, setShowAll] = useState(false);
  const [drafts, setDrafts] = useState<FollowUpDeal[] | null>(null);
  const [loading, setLoading] = useState(false);
  const list = tab === 'waiting' ? data.waitingOnThem : data.owedReply;
  const shown = showAll ? list : list.slice(0, 8);

  const draftFollowUps = async () => {
    setLoading(true);
    try {
      const r = await getFollowUpDraftsFor(data.waitingOnThem.slice(0, 25).map(x => x.dealId));
      setDrafts(r.deals);
      if (!r.deals.length) toast('No follow-up drafts', { description: `Checked ${r.scanned} — drafts already waiting, replies since, or not appropriate.` });
    } catch (e) {
      toast.error(`Could not write follow-ups: ${e instanceof Error ? e.message : 'error'}`);
    } finally { setLoading(false); }
  };

  return (
    <div className={`${box} space-y-3`}>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ['Waiting on them', data.counts.waitingOnThem, `you wrote last ≥ ${data.minDays}d`],
          ['You owe a reply', data.counts.owedReply, 'they wrote last'],
          ['Deals checked', data.counts.dealsConsidered, `${data.counts.noEmailsSynced ?? 0} without synced mail`],
        ].map(([label, n, sub]) => (
          <div key={String(label)} className="rounded-lg bg-muted/60 px-2 py-2">
            <div className="text-lg font-bold text-foreground leading-tight">{n}</div>
            <div className="text-[11px] font-medium text-foreground">{label}</div>
            <div className="text-[10px] text-muted-foreground">{sub}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 text-xs">
        {(['waiting', 'owed'] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setShowAll(false); }}
            className={`px-2.5 py-1 rounded-md font-medium ${tab === t ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'waiting' ? `Waiting on them (${data.counts.waitingOnThem ?? data.waitingOnThem.length})` : `Owe a reply (${data.counts.owedReply ?? data.owedReply.length})`}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-border">
        {shown.map(x => (
          <li key={`${x.dealId}-${x.threadId}`} className="flex items-center gap-2 py-1.5 min-w-0">
            <Link to={citationHref('deal', x.dealId)} className="text-xs font-medium text-foreground hover:text-primary truncate min-w-0 flex-1">{x.dealName}</Link>
            <StagePill stage={x.stage} />
            <span className="text-[11px] text-muted-foreground whitespace-nowrap w-14 text-right">{x.daysSilent ?? '—'}d</span>
            <ThreadLink threadId={x.threadId} className="text-muted-foreground hover:text-primary"><Mail size={12} /></ThreadLink>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {list.length > 8 && (
          <button onClick={() => setShowAll(s => !s)} className="text-xs text-muted-foreground hover:text-foreground">{showAll ? 'Show fewer' : (() => { const total = (tab === 'waiting' ? data.counts.waitingOnThem : data.counts.owedReply) ?? list.length; return total > list.length ? `Show the ${list.length} oldest of ${total}` : `Show all ${list.length}`; })()}</button>
        )}
        {tab === 'waiting' && data.waitingOnThem.length > 0 && !drafts && (
          <button onClick={draftFollowUps} disabled={loading}
            className="ml-auto flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-60">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {loading ? 'Reading threads…' : `Draft follow-ups for the ${Math.min(25, data.waitingOnThem.length)} oldest`}
          </button>
        )}
      </div>
      {drafts && <FollowUpPanel deals={drafts} />}
    </div>
  );
}

/* ── threads ───────────────────────────────────────────────────────────── */

interface ThreadLite {
  threadId: string; subject: string; with: string; brand: string | null; lastAt: string | null; lastFrom: 'Jake' | 'them';
  daysSinceLast: number | null; messages: number; hasPendingDraft: boolean; deal: { id: string; name: string; stage: string } | null;
  agent: { decision: string; reason: string } | null;
}
export function ThreadsCard({ data }: { data: { q: string; threads: ThreadLite[] } }) {
  const [all, setAll] = useState(false);
  const list = all ? data.threads : data.threads.slice(0, 6);
  return (
    <div className={`${box} p-0 overflow-hidden`}>
      <ul className="divide-y divide-border">
        {list.map(t => (
          <li key={t.threadId} className="px-3.5 py-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <ThreadLink threadId={t.threadId} className="text-xs font-semibold text-foreground hover:text-primary truncate flex-1 min-w-0">{t.brand ? `${t.brand} — ` : ''}{t.subject}</ThreadLink>
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">{ago(t.lastAt)}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-[11px] text-muted-foreground">
              <span className="truncate min-w-0">{t.with}</span>
              <span className="whitespace-nowrap">· {t.lastFrom === 'Jake' ? 'you wrote last' : 'they wrote last'}</span>
              {t.hasPendingDraft && <span className="whitespace-nowrap text-primary">· draft waiting</span>}
              {t.deal && <StagePill stage={t.deal.stage} />}
            </div>
          </li>
        ))}
      </ul>
      {data.threads.length > 6 && (
        <button onClick={() => setAll(a => !a)} className="w-full text-xs text-muted-foreground hover:text-foreground py-1.5 border-t border-border">
          {all ? 'Show fewer' : `Show all ${data.threads.length}`}
        </button>
      )}
    </div>
  );
}

export function ThreadCard({ data }: { data: { threadId: string; subject: string; gmailUrl: string; totalMessages: number; deal: { id: string; name: string; stage: string } | null; messages: { from: string; isFromMe: boolean; date: string; text: string }[]; agent: { decision: string; reason: string } | null; question: { question: string } | null } }) {
  const [drafting, setDrafting] = useState(false);
  const [open, setOpen] = useState(false);
  const openThread = useOpenThread();
  return (
    <div className={`${box} space-y-2.5`}>
      <div className="flex items-start gap-2 min-w-0">
        <Mail size={14} className="text-primary mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground break-words">{data.subject}</p>
          <p className="text-[11px] text-muted-foreground">{data.totalMessages} message{data.totalMessages === 1 ? '' : 's'}</p>
        </div>
        {data.deal && (
          <Link to={citationHref('deal', data.deal.id)} className="flex items-center gap-1 text-[11px] text-primary hover:underline whitespace-nowrap"><KanbanSquare size={11} /> Deal</Link>
        )}
      </div>
      {data.deal && <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0"><span className="truncate">{data.deal.name}</span><StagePill stage={data.deal.stage} /></div>}
      {data.agent && <p className="text-[11px] text-muted-foreground"><span className="font-medium text-foreground">Agent:</span> {data.agent.decision} — {data.agent.reason}</p>}
      {data.question && <p className="text-[11px] text-amber-700 [.dealorg-dark_&]:text-amber-300"><span className="font-medium">Asked you:</span> {data.question.question}</p>}
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Last {data.messages.length} message{data.messages.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="space-y-2">
          {data.messages.map((m, i) => (
            <div key={i} className={`rounded-lg p-2 text-xs ${m.isFromMe ? 'bg-primary/5 border border-primary/15' : 'bg-muted/60'}`}>
              <p className="text-[10px] text-muted-foreground mb-1">{m.from} · {m.date ? new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}</p>
              <p className="whitespace-pre-wrap break-words text-foreground">{m.text}</p>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {openThread ? (
          <button onClick={() => openThread(data.threadId)} className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg bg-primary text-primary-foreground" title="Read the whole thread beside the chat and reply there">
            <Mail size={11} /> Open thread
          </button>
        ) : (
          <Link to={citationHref('thread', data.threadId)} className="text-xs font-medium px-2.5 py-1 rounded-lg border border-border text-foreground hover:bg-muted">Open in Emails</Link>
        )}
        <a href={data.gmailUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg border border-border text-foreground hover:bg-muted"><ExternalLink size={11} /> Gmail</a>
        {!drafting && (
          <button onClick={() => setDrafting(true)} className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg bg-primary/10 text-primary hover:bg-primary/15" title="The email agent's drafter (Opus 5.5 + rulebook + checks), ~$0.15">
            <Sparkles size={11} /> AI Draft
          </button>
        )}
      </div>
      {drafting && <AgentDraftCard threadId={data.threadId} autoStart onClose={() => setDrafting(false)} />}
    </div>
  );
}

/* ── fit ───────────────────────────────────────────────────────────────── */

export function FitCard({ data }: { data: { brand: string; domain: string | null; verdict: 'fit' | 'partial' | 'none'; angle: string | null; notes: string; sources: string[]; cached: boolean; pastDeals: { id: string; name: string; stage: string }[] } }) {
  const tone = data.verdict === 'fit' ? 'text-emerald-600 [.dealorg-dark_&]:text-emerald-400 bg-emerald-500/10' : data.verdict === 'partial' ? 'text-amber-700 [.dealorg-dark_&]:text-amber-300 bg-amber-500/10' : 'text-destructive bg-destructive/10';
  return (
    <div className={`${box} space-y-2`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Globe size={13} className="text-muted-foreground" />
        <span className="text-xs font-semibold text-foreground">{data.brand}</span>
        {data.domain && <a href={`https://${data.domain}`} target="_blank" rel="noopener noreferrer" className="text-[11px] text-muted-foreground hover:underline">{data.domain}</a>}
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${tone}`}>{data.verdict === 'fit' ? 'Fit' : data.verdict === 'partial' ? 'Partial fit' : 'No fit'}</span>
        {data.cached && <span className="text-[10px] text-muted-foreground">cached · no new lookup</span>}
      </div>
      {data.angle && <p className="text-xs text-foreground"><span className="font-medium">Angle we need:</span> {data.angle}</p>}
      <p className="text-xs text-muted-foreground">{data.notes}</p>
      {data.pastDeals?.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-muted-foreground">
          Past deals:
          {data.pastDeals.map(d => <Link key={d.id} to={citationHref('deal', d.id)} className="inline-flex items-center gap-1 hover:text-primary">{d.name} <StagePill stage={d.stage} /></Link>)}
        </div>
      )}
      {data.sources?.length > 0 && <p className="text-[10px] text-muted-foreground truncate">Sources: {data.sources.join(' · ')}</p>}
    </div>
  );
}

/* ── deals list ────────────────────────────────────────────────────────── */

export function DealsCard({ data }: { data: { total: number; deals: { id: string; name: string; client: string; stage: string; lastEmailAt: string | null; lastEmailFrom: string | null }[] } }) {
  const [all, setAll] = useState(false);
  const list = all ? data.deals : data.deals.slice(0, 5);
  if (!data.deals.length) return null;
  return (
    <div className={`${box} p-0 overflow-hidden`}>
      <ul className="divide-y divide-border">
        {list.map(d => (
          <li key={d.id} className="flex items-center gap-2 px-3.5 py-1.5 min-w-0">
            <Link to={citationHref('deal', d.id)} className="text-xs font-medium text-foreground hover:text-primary truncate flex-1 min-w-0">{d.name || d.client}</Link>
            <StagePill stage={d.stage} />
            <span className="text-[10px] text-muted-foreground whitespace-nowrap w-16 text-right">{d.lastEmailAt ? `${ago(d.lastEmailAt)}` : '—'}</span>
          </li>
        ))}
      </ul>
      {(data.deals.length > 5 || data.total > data.deals.length) && (
        <button onClick={() => setAll(a => !a)} className="w-full text-xs text-muted-foreground hover:text-foreground py-1.5 border-t border-border">
          {all ? 'Show fewer' : `Show ${data.deals.length}${data.total > data.deals.length ? ` of ${data.total}` : ''}`}
        </button>
      )}
    </div>
  );
}

/* ── proposed deal change ──────────────────────────────────────────────── */

const FIELD_LABEL: Record<string, string> = {
  stage: 'Stage', estimated_value: 'Value', deadline: 'Deadline', next_steps: 'Next steps', agreed_price: 'Agreed price',
  slot_month: 'Slot month', lost_reason: 'Lost reason', deal_type: 'Deal type', in_production: 'In production',
};

export function DealUpdateCard({ data }: { data: { dealId: string; dealName: string; current: Record<string, unknown>; updates: Record<string, unknown>; proposedStageName: string | null; reason: string; warnings: string[] } }) {
  const { getStageLabel } = useStageLabels();
  const [state, setState] = useState<'pending' | 'saving' | 'done' | 'dismissed'>('pending');
  const confirm = async () => {
    setState('saving');
    try {
      await updateDeal({ id: data.dealId, updates: data.updates as any });
      setState('done');
      toast.success(`${data.dealName} updated`);
    } catch (e) {
      setState('pending');
      toast.error(`Update failed: ${e instanceof Error ? e.message : 'error'}`);
    }
  };
  const show = (k: string, v: unknown) => (k === 'stage' && typeof v === 'string' ? getStageLabel(v, data.proposedStageName ?? v) : v === null || v === undefined || v === '' ? '—' : String(v));
  return (
    <div className={`${box} space-y-2.5 ${state === 'dismissed' ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 min-w-0">
        <KanbanSquare size={13} className="text-primary flex-shrink-0" />
        <Link to={citationHref('deal', data.dealId)} className="text-xs font-semibold text-foreground hover:text-primary truncate">{data.dealName}</Link>
        <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap">proposed — not applied</span>
      </div>
      <table className="w-full text-xs">
        <tbody>
          {Object.entries(data.updates).filter(([k]) => k !== 'in_production').map(([k, v]) => (
            <tr key={k} className="border-t border-border first:border-t-0">
              <td className="py-1 pr-2 text-muted-foreground whitespace-nowrap">{FIELD_LABEL[k] ?? k}</td>
              <td className="py-1 pr-2 text-muted-foreground line-through break-words">{k === 'stage' ? String(data.current.stage ?? '—') : show(k, data.current[k])}</td>
              <td className="py-1 font-medium text-foreground break-words">{show(k, v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.reason && <p className="text-[11px] text-muted-foreground">{data.reason}</p>}
      {data.warnings?.map((w, i) => <p key={i} className="flex items-start gap-1 text-[11px] text-amber-700 [.dealorg-dark_&]:text-amber-300"><AlertTriangle size={11} className="mt-0.5" />{w}</p>)}
      {state === 'done' ? (
        <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 [.dealorg-dark_&]:text-emerald-400"><Check size={12} /> Updated on the board</p>
      ) : state !== 'dismissed' && (
        <div className="flex items-center gap-2">
          <button onClick={confirm} disabled={state === 'saving'} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-60">
            {state === 'saving' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Confirm change
          </button>
          <button onClick={() => setState('dismissed')} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground">
            <X size={12} /> Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatCard({ kind, data }: { kind: string; data: any }) {
  switch (kind) {
    case 'draft': return <DraftCard data={data} />;
    case 'followups': return <FollowUpsCard data={data} />;
    case 'queue': return <QueueCard data={data} />;
    case 'threads': return <ThreadsCard data={data} />;
    case 'thread': return <ThreadCard data={data} />;
    case 'fit': return <FitCard data={data} />;
    case 'deals': return <DealsCard data={data} />;
    case 'deal_update': return <DealUpdateCard data={data} />;
    default: return null;
  }
}
