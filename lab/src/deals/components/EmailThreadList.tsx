/**
 * Emails — the middle list (redesign 2026-09-30). Rows are InboxThread
 * (listInbox): who, subject, age, deal stage (live labels), brand, and what
 * the email agent did. The Brands view lists brand groups; clicking one
 * filters to its threads.
 */
import { useState } from 'react';
import { Search, ArrowLeft, Sparkles, HelpCircle, FileEdit, Loader2, Clock } from 'lucide-react';
import { ScrollArea } from '@/deals/ui/scroll-area';
import { Skeleton } from '@/deals/ui/skeleton';
import type { InboxThread, BrandGroup, InboxView } from '@/deals/apiInbox';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { E, domainColor } from '@/deals/lib/emailTheme';
import { FOLDERS } from '@/deals/components/EmailLeftPanel';

function relDate(ds: string | null) {
  if (!ds) return '';
  try {
    const d = new Date(ds), diff = Date.now() - d.getTime(), m = Math.floor(diff / 60000);
    if (m < 2) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    if (h < 48) return 'Yesterday';
    if (h < 168) return d.toLocaleDateString('en-US', { weekday: 'short' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

export function StageChip({ stage }: { stage: string }) {
  const { resolveStageKey, getStageLabel, getStageColor } = useStageLabels();
  if (!stage) return null;
  const key = resolveStageKey(stage);
  const label = key ? getStageLabel(key, stage) : stage;
  const color = key ? getStageColor(key) : E.textMuted;
  return (
    <span style={{ display: 'inline-block', fontSize: 11, padding: '1px 8px', borderRadius: 20, background: `color-mix(in srgb, ${color} 16%, transparent)`, color, fontWeight: 500, whiteSpace: 'nowrap', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {label}
    </span>
  );
}

function Tag({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'warn'; title?: string }) {
  const style = tone === 'accent' ? { background: E.accentLight, color: E.accentOrange } : tone === 'warn' ? { background: 'var(--pill-red-bg)', color: 'var(--pill-red-text)' } : { background: 'var(--pill-gray-bg)', color: 'var(--pill-gray-text)' };
  return <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px', borderRadius: 20, whiteSpace: 'nowrap', ...style }}>{children}</span>;
}

function ThreadRow({ t, view, isSelected, onSelect }: { t: InboxThread; view: InboxView; isSelected: boolean; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  const domain = t.counterpart.email.split('@')[1] ?? '';
  const name = t.counterpart.name || t.counterpart.email || '(unknown)';
  let bg = 'transparent';
  if (isSelected) bg = E.cardActive; else if (hovered) bg = E.cardHover; else if (t.unread) bg = E.unreadBg;
  const age = view === 'needs_reply' ? t.lastInboundAt : t.lastAt;
  const ageDays = age ? Math.floor((Date.now() - new Date(age).getTime()) / 86400000) : null;

  return (
    <div onClick={onSelect} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ padding: '11px 12px 11px 10px', borderRadius: 10, margin: '2px 8px', background: bg, borderLeft: isSelected ? `3px solid ${E.accent}` : '3px solid transparent', cursor: 'pointer', transition: 'background 0.12s' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: '50%', background: domainColor(domain || name), flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff' }}>
          {(name.charAt(0) || '?').toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: t.unread ? 600 : 500, color: E.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
              {t.brand ? <>{t.brand}<span style={{ color: E.textMuted, fontWeight: 400 }}> · {name}</span></> : name}
            </span>
            {(view === 'needs_reply' || view === 'waiting') && ageDays !== null ? (
              <span style={{ fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap', fontWeight: 600, color: ageDays >= 3 ? 'var(--pill-red-text)' : E.textMuted }} title={view === 'needs_reply' ? 'Days since their last email' : 'Days since your last email'}>
                {ageDays}d
              </span>
            ) : (
              <span style={{ fontSize: 11, color: E.textMuted, flexShrink: 0, whiteSpace: 'nowrap' }}>{relDate(t.lastAt)}</span>
            )}
          </div>
          <p style={{ fontSize: 13, color: E.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '1px 0' }}>{t.subject}</p>
          <p style={{ fontSize: 12, color: E.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.lastFromMe ? 'You: ' : ''}{t.snippet}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
            {t.deal && <StageChip stage={t.deal.stage} />}
            {t.agent?.decision === 'draft' && t.agent.gmailDraftId && <Tag tone="accent" title={t.agent.reason}><Sparkles size={9} /> {t.agent.sent ? 'Agent draft (sent)' : 'Agent draft in Gmail'}</Tag>}
            {t.question && <Tag tone="warn" title={t.question.question}><HelpCircle size={9} /> Asked you</Tag>}
            {t.hasGmailDraft && !(t.agent?.decision === 'draft' && t.agent.gmailDraftId) && <Tag title="An unsent draft is waiting in Gmail"><FileEdit size={9} /> Draft waiting</Tag>}
            {view === 'done' && t.doneReason && <Tag title={t.doneReason}>{t.doneReason.slice(0, 40)}</Tag>}
            {t.isAgency && <Tag title="Sender domain differs from the brand — agency">agency</Tag>}
          </div>
        </div>
      </div>
    </div>
  );
}

function BrandRow({ b, onSelect }: { b: BrandGroup; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div onClick={onSelect} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ padding: '11px 12px', borderRadius: 10, margin: '2px 8px', background: hovered ? E.cardHover : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 34, height: 34, borderRadius: 8, background: domainColor(b.domain || b.brand), flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff' }}>
        {b.brand.charAt(0).toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: E.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{b.brand}</span>
          <span style={{ fontSize: 11, color: E.textMuted, whiteSpace: 'nowrap' }}>{relDate(b.lastAt)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: E.textMuted }}>{b.threadCount} thread{b.threadCount === 1 ? '' : 's'}{b.domain ? ` · ${b.domain}` : ''}</span>
          {b.needsReply > 0 && <Tag tone="warn">{b.needsReply} need reply</Tag>}
          {b.deal && <StageChip stage={b.deal.stage} />}
        </div>
      </div>
    </div>
  );
}

interface Props {
  view: InboxView;
  threads: InboxThread[];
  brands: BrandGroup[];
  total: number;
  olderNeedsReply: number;
  includeOld: boolean;
  onIncludeOld: (v: boolean) => void;
  brandFilter: string | null;
  onClearBrand: () => void;
  onBrandSelect: (brand: string) => void;
  selectedThreadId: string | null;
  loading: boolean;
  search: string;
  onSearchChange: (q: string) => void;
  onThreadSelect: (id: string) => void;
  /** Waiting on them → write follow-ups for the listed deals. */
  onDraftFollowUps?: () => void;
  followUpsLoading?: boolean;
}

export default function EmailThreadList(p: Props) {
  const folder = FOLDERS.find(f => f.value === p.view);
  const title = p.brandFilter ?? folder?.label ?? 'Emails';
  return (
    <div className="email-list-panel w-full sm:w-[380px] sm:min-w-[300px] sm:max-w-[420px]" style={{ background: E.panel2, borderRight: `1px solid ${E.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${E.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minWidth: 0 }}>
          {p.brandFilter && (
            <button onClick={p.onClearBrand} title="Back to brands" style={{ background: 'transparent', border: 'none', color: E.textMuted, cursor: 'pointer', padding: 0, display: 'flex' }}><ArrowLeft size={16} /></button>
          )}
          <h2 style={{ fontSize: 16, fontWeight: 700, color: E.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h2>
          <span style={{ fontSize: 12, color: E.textMuted }}>{p.view === 'brands' && !p.brandFilter ? p.brands.length : p.total}</span>
        </div>
        {folder && !p.brandFilter && <p style={{ fontSize: 11, color: E.textMuted, marginBottom: 8 }}>{folder.hint}</p>}
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: E.textMuted }} />
          <input
            value={p.search}
            onChange={e => p.onSearchChange(e.target.value)}
            placeholder={p.view === 'brands' && !p.brandFilter ? 'Search brands…' : 'Search subject, people, brand, body…'}
            style={{ width: '100%', padding: '8px 10px 8px 32px', borderRadius: 8, border: `1px solid ${E.border}`, background: E.outerBg, color: E.textPrimary, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
        {p.view === 'waiting' && p.onDraftFollowUps && p.threads.length > 0 && (
          <button onClick={p.onDraftFollowUps} disabled={p.followUpsLoading}
            style={{ marginTop: 10, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 10px', borderRadius: 8, border: 'none', background: E.accent, color: '#fff', fontSize: 13, fontWeight: 600, cursor: p.followUpsLoading ? 'wait' : 'pointer', opacity: p.followUpsLoading ? 0.7 : 1 }}
            title="Reads the threads, then writes follow-up drafts for you to review — nothing is saved or moved until you click">
            {p.followUpsLoading ? <Loader2 size={14} className="animate-spin" /> : <Clock size={14} />}
            {p.followUpsLoading ? 'Reading threads…' : `Draft follow-ups (${Math.min(25, p.threads.length)} oldest)`}
          </button>
        )}
      </div>

      <ScrollArea style={{ flex: 1 }}>
        {p.loading ? (
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" style={{ background: E.cardBg }} />)}
          </div>
        ) : p.view === 'brands' && !p.brandFilter ? (
          p.brands.length ? p.brands.map(b => <BrandRow key={b.brand} b={b} onSelect={() => p.onBrandSelect(b.brand)} />)
            : <p style={{ padding: 20, fontSize: 13, color: E.textMuted, textAlign: 'center' }}>No brands yet — brands are extracted by the scheduled sync.</p>
        ) : p.threads.length ? (
          <>
            {p.threads.map(t => <ThreadRow key={t.threadId} t={t} view={p.view} isSelected={p.selectedThreadId === t.threadId} onSelect={() => p.onThreadSelect(t.threadId)} />)}
            {p.view === 'needs_reply' && p.olderNeedsReply > 0 && (
              <button onClick={() => p.onIncludeOld(!p.includeOld)} style={{ display: 'block', margin: '10px auto 16px', background: 'transparent', border: 'none', color: E.textMuted, fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
                {p.includeOld ? 'Hide threads older than 60 days' : `+ ${p.olderNeedsReply} older than 60 days`}
              </button>
            )}
          </>
        ) : (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: E.textMuted }}>{p.search ? 'Nothing matches.' : p.view === 'needs_reply' ? 'Nothing waiting on you. 🎉' : 'Nothing here.'}</p>
            {p.view === 'needs_reply' && p.olderNeedsReply > 0 && !p.includeOld && (
              <button onClick={() => p.onIncludeOld(true)} style={{ marginTop: 8, background: 'transparent', border: 'none', color: E.textMuted, fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
                Show {p.olderNeedsReply} older than 60 days
              </button>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
