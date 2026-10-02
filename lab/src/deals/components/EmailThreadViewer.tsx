/**
 * Emails — the thread viewer (redesign 2026-09-30).
 *
 * Data comes from getInboxThread (local rows; one repair fetch at most for a
 * thread whose copy is incomplete). Shows: the deal pill (live stage labels —
 * the old pill looked up the wrong value and never showed) with a link to the
 * deal, or "Link to deal" / "Create deal"; the email agent's item for this
 * thread (its draft, checks and reason) and any open question to Jake; "No
 * reply needed" (moves the thread to Done); the messages; and the composer:
 * "AI Draft" = the agent's own drafter (Opus 5.5 + rulebook + checks, only on
 * click, ~$0.15), "Send" = sendReply mode "send" (a manual send Jake clicks —
 * allowed; two clicks to confirm) and "Save as draft" = sendReply (a Gmail
 * draft). An agent draft already saved in Gmail can be sent from here too
 * (sendGmailDraft — sends exactly what is in Gmail).
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from '@/deals/ui/motion';
import { ExternalLink, ChevronDown, ChevronLeft, Sparkles, KanbanSquare,
  FileText, Image, File, Paperclip, Loader2, HelpCircle, CheckCircle2, Undo2, Link2, Plus, Search } from 'lucide-react';
import { ScrollArea } from '@/deals/ui/scroll-area';
import { Skeleton } from '@/deals/ui/skeleton';
import { toast } from 'sonner';
import { GetThreadOutputType, getEmailAttachment, sendReply, sendGmailDraft } from '@/deals/api';
import { markInboxDone, linkThreadToDeal, type InboxThreadDetail } from '@/deals/apiInbox';
import { toastDraftSaved, toastSent } from '@/deals/lib/draftToast';
import ConfirmSendButton from '@/deals/components/ConfirmSendButton';
import { Deal, apiCreateDeal } from '@/deals/lib/supabase';
import DealDrawer from '@/deals/components/DealDrawer';
import AgentDraftCard from '@/deals/components/thread/AgentDraftCard';
import { StageChip } from '@/deals/components/EmailThreadList';
import { E, domainColor } from '@/deals/lib/emailTheme';
import { LinkedText } from '@/deals/signature';

type ThreadDetail = GetThreadOutputType;
type Message = ThreadDetail['messages'][number];
type Attachment = Message['attachments'][number];

function formatDate(ds: string) {
  try {
    return new Date(ds).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ds; }
}

function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<a /gi, '<a target="_blank" rel="noopener noreferrer" ');
}

function splitHtmlBody(html: string): { main: string; quote: string | null } {
  // Gmail quote div
  const gqMatch = html.match(/<div[^>]*class="[^"]*gmail_quote[^"]*"/i);
  if (gqMatch && gqMatch.index !== undefined && gqMatch.index > 100) {
    return { main: html.slice(0, gqMatch.index), quote: html.slice(gqMatch.index) };
  }
  // Generic blockquote not at the very start
  const bqIdx = html.indexOf('<blockquote');
  if (bqIdx > 100) {
    return { main: html.slice(0, bqIdx), quote: html.slice(bqIdx) };
  }
  // "On ... wrote:" pattern inside HTML (plain text fallback embedded in HTML)
  const onWroteMatch = html.match(/On [A-Z][a-z]{2},?\s[\s\S]{5,200}wrote:/);
  if (onWroteMatch && onWroteMatch.index !== undefined && onWroteMatch.index > 100) {
    return { main: html.slice(0, onWroteMatch.index), quote: html.slice(onWroteMatch.index) };
  }
  return { main: html, quote: null };
}

function linkifyText(text: string): string {
  return text.replace(
    /(https?:\/\/[^\s<>"')\]]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#ff7420;word-break:break-all;">$1</a>'
  );
}

function splitBody(body: string): { main: string; quote: string | null } {
  // "On Mon, ..." possibly multi-line before "wrote:"
  const onWroteRx = /\r?\nOn [A-Z][a-z]{2}[\s\S]{5,300}?wrote:\s*\r?\n/;
  const dividerRx = /\n---+\n/;
  const qm = body.match(onWroteRx);
  const dm = body.match(dividerRx);
  let idx = -1;
  if (qm?.index !== undefined) idx = qm.index;
  if (dm?.index !== undefined && (idx < 0 || dm.index < idx)) idx = dm.index;
  if (idx < 0) return { main: body, quote: null };
  return { main: body.slice(0, idx).trimEnd(), quote: body.slice(idx).trimStart() };
}

function AttachmentIcon({ mimeType }: { mimeType: string }) {
  const m = mimeType.toLowerCase();
  if (m.includes('pdf')) return <FileText size={13} style={{ color: '#ef4444', flexShrink: 0 }} />;
  if (m.startsWith('image/')) return <Image size={13} style={{ color: '#3b82f6', flexShrink: 0 }} />;
  if (m.includes('word') || m.includes('document') || m.includes('openxmlformats')) return <FileText size={13} style={{ color: '#3b82f6', flexShrink: 0 }} />;
  return <File size={13} style={{ color: E.textMuted, flexShrink: 0 }} />;
}

function AttachmentChip({
  att, messageId, accountEmail,
}: { att: Attachment; messageId: string; accountEmail: string }) {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await getEmailAttachment({ messageId, attachmentId: att.attachmentId, accountEmail });
      const bytes = atob(res.data);
      const buffer = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
      const mimeType = att.mimeType || 'application/octet-stream';
      const blob = new Blob([buffer], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.name;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    } catch { toast.error(`Failed to download ${att.name}`); }
    finally { setLoading(false); }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 10px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer',
        border: `1px solid ${E.border}`, background: loading ? E.accentLight : 'transparent',
        color: E.textSecondary, fontSize: 12, fontFamily: 'inherit',
        transition: 'background 0.12s, border-color 0.12s', maxWidth: 200,
        opacity: loading ? 0.7 : 1,
      }}
      title={att.name}
    >
      <AttachmentIcon mimeType={att.mimeType} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
        {att.name}
      </span>
      {att.size > 0 && (
        <span style={{ color: E.textMuted, flexShrink: 0, fontSize: 11 }}>{formatBytes(att.size)}</span>
      )}
    </button>
  );
}

function MessageCard({
  msg, expanded, onToggle, accountEmail,
}: {
  msg: Message;
  expanded: boolean;
  onToggle: () => void;
  accountEmail: string;
}) {
  const [quoteOpen, setQuoteOpen] = useState(false);
  const domain = msg.fromEmail?.split('@')[1] ?? msg.fromName;
  const cardBg = msg.isFromMe ? E.cardBgMe : E.cardBg;
  const hasHtml = !!(msg.bodyHtml && msg.bodyHtml.trim().length > 20);
  const { main: htmlMain, quote: htmlQuote } = hasHtml ? splitHtmlBody(sanitizeHtml(msg.bodyHtml)) : { main: '', quote: null };
  const { main: textMain, quote: textQuote } = hasHtml ? { main: '', quote: null } : splitBody(msg.body || '');

  return (
    <div className="mx-3 sm:mx-5 my-2" style={{ background: cardBg, border: `1px solid ${E.borderLight}`, borderRadius: 12, overflow: 'hidden', minWidth: 0 }}>
      {/* Header */}
      <div
        onClick={onToggle}
        style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', borderBottom: expanded ? `1px solid ${E.border}` : 'none', transition: 'background 0.12s' }}
      >
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: domainColor(domain), flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: '#fff' }}>
          {(msg.fromName.charAt(0) || '?').toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: E.textPrimary }}>{msg.fromName}</span>
            {msg.isFromMe && (
              <span style={{ fontSize: 11, background: 'var(--pill-green-bg)', color: 'var(--pill-green-text)', padding: '1px 7px', borderRadius: 4, fontWeight: 600 }}>You</span>
            )}
            {!msg.isRead && !msg.isFromMe && (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: E.accent, flexShrink: 0 }} />
            )}
          </div>
          {!expanded && (
            <span style={{ fontSize: 13, color: E.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth: 400 }}>
              {(msg.body || '').slice(0, 80)}
            </span>
          )}
          {expanded && (
            <span style={{ fontSize: 13, color: E.textSecondary }}>{msg.fromEmail || msg.fromName}</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 13, color: E.textMuted }}>{formatDate(msg.date)}</span>
          <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2, ease: 'easeInOut' }}>
            <ChevronDown size={16} style={{ color: E.textMuted }} />
          </motion.div>
        </div>
      </div>

      {/* Body */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ padding: '16px 18px 20px', minWidth: 0, overflow: 'hidden' }}>
              <p style={{ fontSize: 12, color: E.textMuted, marginBottom: 14, overflowWrap: 'break-word' }}>To: {msg.to || '—'}</p>

              {/* HTML body */}
              {hasHtml ? (
                <>
                  <div
                    className="email-html-body"
                    dangerouslySetInnerHTML={{ __html: htmlMain }}
                    style={{
                      fontSize: 14, color: E.textBody, lineHeight: 1.7,
                      overflowWrap: 'break-word', wordBreak: 'break-word', minWidth: 0,
                    }}
                  />
                  {htmlQuote && (
                    <div style={{ marginTop: 10 }}>
                      <button
                        onClick={e => { e.stopPropagation(); setQuoteOpen(o => !o); }}
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          height: 22, padding: '0 8px', borderRadius: 4,
                          border: `1px solid ${E.border}`, background: 'transparent',
                          color: E.textMuted, fontSize: 16, lineHeight: 1, cursor: 'pointer',
                          letterSpacing: 1, fontFamily: 'inherit', transition: 'background 0.12s',
                        }}
                        title={quoteOpen ? 'Collapse quoted text' : 'Show quoted text'}
                      >···</button>
                      <AnimatePresence initial={false}>
                        {quoteOpen && (
                          <motion.div key="html-quote" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden' }}>
                            <div
                              className="email-html-body"
                              dangerouslySetInnerHTML={{ __html: htmlQuote }}
                              style={{ fontSize: 13, color: E.textMuted, lineHeight: 1.65, marginTop: 10, padding: '8px 0 8px 14px', borderLeft: `3px solid ${E.border}`, overflowWrap: 'break-word', wordBreak: 'break-word' }}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <pre
                    style={{ fontSize: 14, color: E.textBody, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word', fontFamily: 'inherit', margin: 0, minWidth: 0 }}
                    dangerouslySetInnerHTML={{ __html: linkifyText(textMain || '(empty message)') }}
                  />
                  {textQuote && (
                    <div style={{ marginTop: 10 }}>
                      <button
                        onClick={e => { e.stopPropagation(); setQuoteOpen(o => !o); }}
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          height: 22, padding: '0 8px', borderRadius: 4,
                          border: `1px solid ${E.border}`, background: 'transparent',
                          color: E.textMuted, fontSize: 16, lineHeight: 1, cursor: 'pointer',
                          letterSpacing: 1, fontFamily: 'inherit', transition: 'background 0.12s',
                        }}
                        title={quoteOpen ? 'Collapse quoted text' : 'Show quoted text'}
                      >···</button>
                      <AnimatePresence initial={false}>
                        {quoteOpen && (
                          <motion.div key="text-quote" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden' }}>
                            <pre style={{ fontSize: 13, color: E.textMuted, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word', fontFamily: 'inherit', margin: '10px 0 0', padding: '8px 0 8px 14px', borderLeft: `3px solid ${E.border}` }}>
                              {textQuote}
                            </pre>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </>
              )}

              {/* Attachments */}
              {msg.attachments && msg.attachments.length > 0 && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${E.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <Paperclip size={12} style={{ color: E.textMuted }} />
                    <span style={{ fontSize: 12, color: E.textMuted, fontWeight: 500 }}>
                      {msg.attachments.length} attachment{msg.attachments.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {msg.attachments.map(att => (
                      <AttachmentChip
                        key={att.attachmentId}
                        att={att}
                        messageId={msg.id}
                        accountEmail={accountEmail}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface Props {
  detail: InboxThreadDetail | null;
  loading: boolean;
  deals: Deal[];
  onBack?: () => void;
  /** Something changed (draft saved, marked done, deal linked) — reload the list. */
  onChanged?: () => void;
}

function DealLinker({ threadId, deals, suggestion, onLinked }: {
  threadId: string; deals: Deal[];
  suggestion: { clientName: string; clientEmail: string; projectName: string };
  onLinked: (dealId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? deals.filter(d => `${d.client_name} ${d.project_name ?? ''} ${d.client_email}`.toLowerCase().includes(s)) : deals;
    return list.slice(0, 8);
  }, [q, deals]);

  const link = async (dealId: string) => {
    setBusy(true);
    try { await linkThreadToDeal(threadId, dealId); toast.success('Thread linked to the deal'); onLinked(dealId); setOpen(false); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not link'); }
    finally { setBusy(false); }
  };
  const create = async () => {
    if (!suggestion.clientEmail) { toast.error('No sender address to create the deal from'); return; }
    setBusy(true);
    try {
      const d = await apiCreateDeal({
        client_name: suggestion.clientName || suggestion.clientEmail, client_email: suggestion.clientEmail,
        project_name: suggestion.projectName || null, stage: 'new_requests', source: 'manual', source_thread_id: threadId,
      });
      toast.success(`Deal created in New Requests: ${d.project_name || d.client_name}`);
      onLinked(d.id);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not create the deal'); }
    finally { setBusy(false); }
  };

  return (
    <span style={{ position: 'relative', display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      <button onClick={() => setOpen(o => !o)} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '4px 10px', borderRadius: 20, border: `1px dashed ${E.border}`, background: 'transparent', color: E.textSecondary, cursor: 'pointer' }}>
        <Link2 size={12} /> Link to deal
      </button>
      <button onClick={create} disabled={busy} title={`Creates "${suggestion.projectName || suggestion.clientName}" in New Requests, linked to this thread`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '4px 10px', borderRadius: 20, border: `1px dashed ${E.border}`, background: 'transparent', color: E.textSecondary, cursor: busy ? 'wait' : 'pointer' }}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Create deal
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 30, width: 300, maxWidth: '80vw', background: 'hsl(var(--card))', border: `1px solid ${E.border}`, borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.25)', padding: 8 }}>
          <div style={{ position: 'relative', marginBottom: 6 }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: E.textMuted }} />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Find a deal…"
              style={{ width: '100%', padding: '6px 8px 6px 26px', borderRadius: 6, border: `1px solid ${E.border}`, background: E.outerBg, color: E.textPrimary, fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          {matches.map(d => (
            <button key={d.id} onClick={() => link(d.id)} disabled={busy}
              style={{ width: '100%', textAlign: 'left', display: 'block', padding: '6px 8px', borderRadius: 6, border: 'none', background: 'transparent', color: E.textPrimary, fontSize: 12, cursor: 'pointer' }}>
              <span style={{ fontWeight: 600 }}>{d.project_name || d.client_name}</span>
              <span style={{ color: E.textMuted }}> · {d.client_email}</span>
            </button>
          ))}
          {!matches.length && <p style={{ fontSize: 12, color: E.textMuted, padding: 6 }}>No deal matches.</p>}
        </div>
      )}
    </span>
  );
}

export default function EmailThreadViewer({ detail, loading, deals, onBack, onChanged }: Props) {
  const [reply, setReply] = useState('');
  const [replyFocused, setReplyFocused] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendingAgentDraft, setSendingAgentDraft] = useState(false);
  const [aiDraft, setAiDraft] = useState<{ key: number; instructions: string } | null>(null);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set());
  const [agentOpen, setAgentOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const lastEmailRef = useRef<HTMLDivElement>(null);

  const threadDetail = detail;
  useEffect(() => {
    if (threadDetail) {
      const lastIdx = threadDetail.messages.length - 1;
      setExpandedSet(new Set([lastIdx]));
      setTimeout(() => { lastEmailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 150);
    }
    setReply('');
    setAiDraft(null);
    setSelectedDeal(null);
    setAgentOpen(false);
  }, [threadDetail?.threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMessage = (idx: number) => {
    setExpandedSet(prev => { const next = new Set(prev); if (next.has(idx)) next.delete(idx); else next.add(idx); return next; });
  };

  if (loading) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 24, gap: 12, background: E.panel3, minWidth: 0 }}>
      {onBack && (
        <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: E.textMuted, fontSize: 13, cursor: 'pointer', padding: '4px 0', marginBottom: 4, fontFamily: 'inherit' }}>
          <ChevronLeft size={16} /> Back
        </button>
      )}
      <Skeleton className="h-7 w-3/4" style={{ background: E.cardBg }} />
      <Skeleton className="h-5 w-1/3" style={{ background: E.cardBg }} />
      {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" style={{ background: E.cardBg }} />)}
    </div>
  );

  if (!threadDetail) return (
    <div className="hidden sm:flex" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', background: E.panel3, color: E.textMuted, fontSize: 13 }}>
      Select a thread
    </div>
  );

  const inbox = threadDetail.inbox;
  const accountEmail = threadDetail.accountEmail ?? threadDetail.myEmail ?? '';
  const dealInfo = threadDetail.dealInfo;
  const dealId = dealInfo?.id ?? inbox?.deal?.id ?? null;
  const dealName = dealInfo ? (dealInfo.projectName || dealInfo.clientName) : inbox?.deal?.name ?? '';
  const dealStage = dealInfo ? (dealInfo.stageName || dealInfo.stage) : inbox?.deal?.stage ?? '';
  const fullDeal = dealId ? deals.find(d => d.id === dealId) ?? null : null;
  const gmailUrl = threadDetail.gmailUrl || `https://mail.google.com/mail/u/0/#all/${threadDetail.threadId}`;
  const lastTheirs = [...threadDetail.messages].reverse().find(m => !m.isFromMe && !m.isDraft);
  const replyToName = lastTheirs?.fromName ?? threadDetail.messages.find(m => !m.isFromMe)?.fromName ?? 'sender';
  const toEmail = lastTheirs?.fromEmail || threadDetail.messages[0]?.to || '';
  const firstName = (replyToName || '').split(/\s+/)[0] || 'there';
  const agent = inbox?.agent ?? null;
  const question = inbox?.question ?? null;

  // What Jake typed: "Send" sends it (manual send), "Save as draft" saves a Gmail draft in this thread.
  // The server fills In-Reply-To/References from the thread's latest message.
  const handleDeliver = async (mode: 'draft' | 'send') => {
    const text = reply.trim();
    if (!text || savingDraft || sending) return;
    if (!toEmail) { toast.error('Could not work out who to reply to in this thread'); return; }
    const setBusy = mode === 'send' ? setSending : setSavingDraft;
    setBusy(true);
    try {
      const res = await sendReply({ dealId: dealId ?? '', threadId: threadDetail.threadId, toEmail, lastMessageId: '', lastReferences: '', subject: threadDetail.subject, draftText: text, mode });
      if (mode === 'send') toastSent(`Reply sent to ${firstName}`, res.gmailUrl);
      else toastDraftSaved(`Reply to ${firstName} saved as a Gmail draft`, res.gmailUrl);
      setReply('');
      onChanged?.();
    } catch (e: any) {
      toast.error(`Could not ${mode === 'send' ? 'send the reply' : 'save the draft'}: ${e?.message ?? 'unknown error'}`);
    } finally { setBusy(false); }
  };

  // The agent's draft that is already saved in Gmail: send it as it is there.
  const handleSendAgentDraft = async () => {
    if (!agent?.gmailDraftId || sendingAgentDraft) return;
    setSendingAgentDraft(true);
    try {
      const res = await sendGmailDraft({ threadId: threadDetail.threadId, draftId: agent.gmailDraftId, dealId: dealId ?? undefined });
      toastSent(`The agent's draft was sent to ${firstName}`, res.gmailUrl);
      onChanged?.();
    } catch (e: any) {
      toast.error(`Could not send the draft: ${e?.message ?? 'unknown error'}`);
    } finally { setSendingAgentDraft(false); }
  };

  const toggleDone = async () => {
    if (!inbox) return;
    setMarking(true);
    try {
      await markInboxDone(threadDetail.threadId, !inbox.markedDone);
      toast.success(inbox.markedDone ? 'Moved back to the triage views' : 'Marked no reply needed — moved to Done');
      onChanged?.();
    } catch { toast.error('Could not update the thread'); }
    finally { setMarking(false); }
  };

  const pillBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '4px 10px', borderRadius: 20, border: `1px solid ${E.border}`, background: 'transparent', color: E.textSecondary, cursor: 'pointer', textDecoration: 'none' };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', background: E.panel3 }}>
      {/* Header */}
      <div className="px-4 sm:px-7 pt-5 pb-4" style={{ flexShrink: 0, borderBottom: `1px solid ${E.border}` }}>
        {onBack && (
          <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', color: E.textMuted, fontSize: 13, cursor: 'pointer', padding: '0 0 10px', fontFamily: 'inherit' }}>
            <ChevronLeft size={15} /> Back
          </button>
        )}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <h2 style={{ fontSize: 19, fontWeight: 700, color: E.textPrimary, lineHeight: 1.3, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{threadDetail.subject}</h2>
          <a href={gmailUrl} target="_blank" rel="noopener noreferrer" style={{ ...pillBtn, borderRadius: 8, flexShrink: 0 }} title="View in Gmail">
            <ExternalLink size={12} /> <span className="hidden sm:inline">Gmail</span>
          </a>
        </div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {inbox?.brand && <span style={{ fontSize: 12, color: E.textSecondary, fontWeight: 600 }}>{inbox.brand}{inbox.isAgency ? <span style={{ color: E.textMuted, fontWeight: 400 }}> via {inbox.counterpart.email.split('@')[1]}</span> : null}</span>}
          {dealId ? (
            <>
              <button onClick={() => fullDeal && setSelectedDeal(fullDeal)} disabled={!fullDeal}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 10px', borderRadius: 20, background: E.accentLight, border: `1px solid ${E.accentBorder}`, color: E.accentOrange, cursor: fullDeal ? 'pointer' : 'default', maxWidth: 260 }}
                title="Open the deal here">
                <KanbanSquare size={12} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dealName || 'Deal'}</span>
              </button>
              <StageChip stage={dealStage} />
              <Link to={`/deal-organizer/deals/${dealId}`} style={{ fontSize: 11, color: E.textMuted }}>open on board</Link>
            </>
          ) : (
            <DealLinker
              threadId={threadDetail.threadId}
              deals={deals}
              suggestion={{ clientName: inbox?.counterpart.name || replyToName, clientEmail: inbox?.counterpart.email || toEmail, projectName: inbox?.brand || threadDetail.subject }}
              onLinked={() => onChanged?.()}
            />
          )}
          {inbox && (
            <button onClick={toggleDone} disabled={marking} style={{ ...pillBtn, marginLeft: 'auto' }}
              title={inbox.markedDone ? 'Back to Needs reply' : 'This thread needs no reply — move it to Done (until a new message arrives)'}>
              {marking ? <Loader2 size={12} className="animate-spin" /> : inbox.markedDone ? <Undo2 size={12} /> : <CheckCircle2 size={12} />}
              {inbox.markedDone ? 'Undo done' : 'No reply needed'}
            </button>
          )}
        </div>

        {/* The email agent on this thread */}
        {(agent || question) && (
          <div style={{ marginTop: 12, borderRadius: 10, border: `1px solid ${E.border}`, background: E.outerBg, padding: '8px 12px' }}>
            {question && (
              <p style={{ fontSize: 12, color: E.textPrimary, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <HelpCircle size={13} style={{ color: E.accent, flexShrink: 0, marginTop: 1 }} />
                <span><strong>The agent asked you</strong> ({new Date(question.askedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}): {question.question}
                  {question.slackPermalink && <> · <a href={question.slackPermalink} target="_blank" rel="noopener noreferrer" style={{ color: E.accent }}>answer in Slack</a></>}</span>
              </p>
            )}
            {agent && (
              <div style={{ marginTop: question ? 6 : 0 }}>
                <button onClick={() => setAgentOpen(o => !o)} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, background: 'transparent', border: 'none', padding: 0, color: E.textSecondary, fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>
                  <Sparkles size={13} style={{ color: E.accent, flexShrink: 0, marginTop: 1 }} />
                  <span>
                    <strong style={{ color: E.textPrimary }}>Agent · {agent.decision}{agent.forLatest ? '' : ' (on an earlier message)'}</strong>
                    {agent.gmailDraftId && !agent.sent ? ' — draft saved in Gmail' : ''}{agent.sent ? ' — you have replied since' : ''}
                    {agent.checksOk === false ? ' — checks failed' : ''}: {agent.reason.slice(0, agentOpen ? 2000 : 160)}{!agentOpen && agent.reason.length > 160 ? '…' : ''}
                  </span>
                </button>
                {agentOpen && agent.draftText && (
                  <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: E.textBody, background: E.cardBg, borderRadius: 8, padding: 10, border: `1px solid ${E.borderLight}` }}><LinkedText text={agent.draftText} /></pre>
                )}
                {agentOpen && agent.gmailDraftId && !agent.sent && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                    <ConfirmSendButton onSend={handleSendAgentDraft} busy={sendingAgentDraft} label="Send it now"
                      title="Sends the draft saved in Gmail exactly as it is there (including any edits you made in Gmail) — click twice to confirm"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, background: E.accent, border: 'none', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                      armedStyle={{ boxShadow: '0 0 0 3px rgba(255,116,32,0.30)' }} />
                    <a href={gmailUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: E.accent }}>
                      <ExternalLink size={11} /> Review in Gmail
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Messages */}
      <ScrollArea style={{ flex: 1 }}>
        <style>{`.email-html-body a { color: ${E.accent}; } .email-html-body img { max-width: 100%; height: auto; } .email-html-body li { padding-left: 6px; } .email-html-body ol, .email-html-body ul, .email-html-body menu { padding-left: 16px; }`}</style>
        <div style={{ paddingTop: 8, paddingBottom: 8 }}>
          {threadDetail.messages.map((msg, i) => {
            const isLast = i === threadDetail.messages.length - 1;
            return (
              <div key={`${msg.id}-${i}`} ref={isLast ? lastEmailRef : undefined}>
                <MessageCard msg={msg} expanded={expandedSet.has(i)} onToggle={() => toggleMessage(i)} accountEmail={accountEmail} />
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Composer */}
      <div className="px-3 sm:px-5 pt-3 pb-4" style={{ flexShrink: 0, background: E.replyBg, borderTop: `1px solid ${E.border}`, maxHeight: '60%', overflowY: 'auto' }}>
        {aiDraft ? (
          <AgentDraftCard
            key={aiDraft.key}
            threadId={threadDetail.threadId}
            autoStart
            initialInstructions={aiDraft.instructions}
            onSaved={() => onChanged?.()}
            onClose={() => setAiDraft(null)}
          />
        ) : (
          <>
            <p style={{ fontSize: 12, color: E.textMuted, marginBottom: 8, fontWeight: 500 }}>Reply to {replyToName}</p>
            <textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              onFocus={() => setReplyFocused(true)}
              onBlur={() => setReplyFocused(false)}
              placeholder="Write a reply — or type a direction and press AI Draft…"
              rows={3}
              style={{
                width: '100%', minHeight: 64, padding: '10px 12px', borderRadius: 10, resize: 'vertical',
                background: E.outerBg, border: `1px solid ${replyFocused ? E.accent : E.border}`,
                boxShadow: replyFocused ? `0 0 0 3px rgba(255,116,32,0.10)` : 'none',
                color: E.textPrimary, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button onClick={() => setAiDraft({ key: Date.now(), instructions: reply.trim() })} disabled={savingDraft || sending}
                title={reply.trim() ? "The email agent's drafter writes the reply, using what you typed as direction (~$0.15)" : "The email agent's drafter writes the reply (Opus 5.5 + rulebook + checks, ~$0.15)"}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, background: E.accentLight, border: `1px solid ${E.accentBorder}`, color: E.accentOrange, fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
                <Sparkles size={14} /> AI Draft
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => handleDeliver('draft')} disabled={!reply.trim() || savingDraft || sending}
                  title="Saves a draft in this Gmail thread — nothing is sent"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, background: 'transparent', border: `1px solid ${E.border}`, color: E.textSecondary, fontSize: 13, fontWeight: 500, cursor: savingDraft ? 'wait' : 'pointer', opacity: !reply.trim() || savingDraft || sending ? 0.55 : 1 }}>
                  {savingDraft ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} Save as draft
                </button>
                <ConfirmSendButton onSend={() => handleDeliver('send')} busy={sending} disabled={!reply.trim() || savingDraft} iconSize={14}
                  title={`Sends this reply to ${toEmail || 'the sender'} from the sponsor inbox — click twice to confirm`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 8, background: E.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: sending ? 'wait' : 'pointer', opacity: !reply.trim() || savingDraft ? 0.55 : 1 }}
                  armedStyle={{ boxShadow: '0 0 0 3px rgba(255,116,32,0.30)' }} />
              </div>
            </div>
          </>
        )}
      </div>

      {selectedDeal && (
        <DealDrawer deal={selectedDeal} onClose={() => setSelectedDeal(null)} onUpdated={d => setSelectedDeal(d)} onArchived={() => setSelectedDeal(null)} />
      )}
    </div>
  );
}
