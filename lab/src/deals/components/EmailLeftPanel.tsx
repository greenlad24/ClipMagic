/**
 * Emails — left rail (redesign 2026-09-30): triage views with counts, then
 * Brands / All mail, the connected inbox, and the light-refresh status.
 * Every count comes from one SQL read (listInbox) — no Gmail, no AI.
 */
import React from 'react';
import { Inbox, Sparkles, HelpCircle, Clock, CheckCircle2, Building2, Mail, Plus, RefreshCw, Loader2 } from 'lucide-react';
import { GMAIL_CONNECT_URL } from '@/deals/api';
import type { InboxView, InboxStatus } from '@/deals/apiInbox';
import { E } from '@/deals/lib/emailTheme';

export type EmailView = InboxView;

export const FOLDERS: Array<{ value: EmailView; icon: typeof Inbox; label: string; hint: string; secondary?: boolean }> = [
  { value: 'needs_reply',   icon: Inbox,        label: 'Needs reply',     hint: 'They wrote last — no draft yet, not spam, deal still open' },
  { value: 'agent_drafted', icon: Sparkles,     label: 'Agent drafted',   hint: 'The email agent saved a Gmail draft' },
  { value: 'asked',         icon: HelpCircle,   label: 'Asked Jake',      hint: 'The agent asked you on Slack and is waiting' },
  { value: 'waiting',       icon: Clock,        label: 'Waiting on them', hint: 'You wrote last ≥ 3 days ago on an open deal' },
  { value: 'done',          icon: CheckCircle2, label: 'Done',            hint: 'Deal lost/completed, or no reply needed' },
  { value: 'brands',        icon: Building2,    label: 'Brands',          hint: 'Threads grouped by brand', secondary: true },
  { value: 'all',           icon: Mail,         label: 'All mail',        hint: 'Everything, newest first — search here', secondary: true },
];

const sectionLabel: React.CSSProperties = {
  fontSize: 10, color: E.textMuted, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 600, display: 'block',
};

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "Inbox refreshed 3 min ago" + a manual light refresh (history only — no AI). */
export function InboxRefreshIndicator({ status, refreshing, onRefresh, compact = false }: { status: InboxStatus | null; refreshing: boolean; onRefresh: () => void; compact?: boolean }) {
  if (!status) return null;
  const last = status.lastOk;
  const failed = status.lastAttempt && status.lastAttempt.ok === false && status.lastAttempt.error;
  const title = [
    last ? `Last light refresh: ${new Date(last.startedAt).toLocaleString()} — ${last.counts.fetched ?? 0} new message(s), ${last.counts.labelChanges ?? 0} label change(s), ${last.counts.gmailCalls ?? 0} Gmail call(s)` : 'No light refresh yet',
    `Runs every ${status.everyMinutes} min (history only, no AI). ${status.gmailCallsToday} Gmail calls in the last 24 h.`,
    status.lastAttempt?.skipped ? `Last attempt skipped: ${status.lastAttempt.skipped}` : '',
    failed ? `Last attempt failed: ${status.lastAttempt!.error}` : '',
  ].filter(Boolean).join('\n');
  return (
    <span className="inline-flex items-center gap-1 min-w-0" title={title} style={{ fontSize: 11, color: failed ? 'hsl(var(--destructive))' : E.textMuted }}>
      <span className="truncate">{compact ? '' : 'Inbox refreshed '}{timeAgo(last?.finishedAt ?? last?.startedAt)}</span>
      <button onClick={onRefresh} disabled={refreshing} title="Check Gmail for new mail now (no AI)"
        style={{ background: 'transparent', border: 'none', padding: 2, cursor: refreshing ? 'wait' : 'pointer', color: E.textMuted, display: 'inline-flex' }}>
        {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
      </button>
    </span>
  );
}

interface Props {
  view: EmailView;
  onViewChange: (v: EmailView) => void;
  counts: Partial<Record<EmailView, number>>;
  myEmail: string;
  status: InboxStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
}

export default function EmailLeftPanel({ view, onViewChange, counts, myEmail, status, refreshing, onRefresh }: Props) {
  const item = ({ value: v, icon: Icon, label, hint }: typeof FOLDERS[number]) => {
    const active = view === v;
    const n = counts[v];
    return (
      <button
        key={v}
        onClick={() => onViewChange(v)}
        title={hint}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', margin: '1px 0', cursor: 'pointer',
          borderRadius: active ? '0 8px 8px 0' : 8, borderTop: 'none', borderRight: 'none', borderBottom: 'none',
          borderLeft: active ? `2px solid ${E.accent}` : '2px solid transparent',
          background: active ? E.accentLight : 'transparent', color: active ? E.textPrimary : E.textSecondary,
          fontSize: 14, textAlign: 'left', fontWeight: active ? 600 : 400, transition: 'background 0.12s, color 0.12s',
        }}
      >
        <Icon size={16} style={{ color: active ? E.accent : E.textMuted, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {typeof n === 'number' && n > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: v === 'needs_reply' || v === 'asked' ? E.accent : E.textMuted }}>{n}</span>
        )}
      </button>
    );
  };

  return (
    <div className="email-nav-panel hidden sm:flex" style={{
      background: E.panel1, borderRight: `1px solid ${E.border}`, width: 210, flexShrink: 0, flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <span style={{ ...sectionLabel, padding: '16px 16px 6px' }}>Triage</span>
        <nav style={{ padding: '0 8px' }}>{FOLDERS.filter(f => !f.secondary).map(item)}</nav>
        <span style={{ ...sectionLabel, padding: '14px 16px 6px' }}>Browse</span>
        <nav style={{ padding: '0 8px' }}>{FOLDERS.filter(f => f.secondary).map(item)}</nav>
      </div>
      <div style={{ borderTop: `1px solid ${E.border}`, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 11, color: E.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={myEmail}>{myEmail || 'Gmail not connected'}</span>
        <button
          onClick={() => { window.location.href = GMAIL_CONNECT_URL; }}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: 0, border: 'none', background: 'transparent', color: E.textMuted, fontSize: 11, cursor: 'pointer' }}
        >
          <Plus size={11} /> {myEmail ? 'Change inbox' : 'Connect Gmail'}
        </button>
      </div>
    </div>
  );
}
