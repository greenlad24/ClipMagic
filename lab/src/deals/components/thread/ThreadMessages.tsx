import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from '@/deals/ui/motion';
import { ChevronDown, Paperclip, FileText, Image, File, PenLine } from 'lucide-react';
import { Skeleton } from '@/deals/ui/skeleton';
import { ScrollArea } from '@/deals/ui/scroll-area';
import { getThread, GetThreadOutputType } from '@/deals/api';
import { E, domainColor } from '@/deals/lib/emailTheme';

type ThreadDetail = GetThreadOutputType;
type Msg = ThreadDetail['messages'][number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ds: string) {
  try { return new Date(ds).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ds; }
}

function sanitizeHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<a /gi, '<a target="_blank" rel="noopener noreferrer" ');
}

function splitHtmlBody(html: string): { main: string; quote: string | null } {
  const gqMatch = html.match(/<div[^>]*class="[^"]*gmail_quote[^"]*"/i);
  if (gqMatch && gqMatch.index !== undefined && gqMatch.index > 100)
    return { main: html.slice(0, gqMatch.index), quote: html.slice(gqMatch.index) };
  const bqIdx = html.indexOf('<blockquote');
  if (bqIdx > 100) return { main: html.slice(0, bqIdx), quote: html.slice(bqIdx) };
  return { main: html, quote: null };
}

function splitBody(body: string): { main: string; quote: string | null } {
  const onWroteRx = /\r?\nOn [A-Z][a-z]{2}[\s\S]{5,300}?wrote:\s*\r?\n/;
  const idx = body.search(onWroteRx);
  if (idx < 0) return { main: body, quote: null };
  return { main: body.slice(0, idx).trimEnd(), quote: body.slice(idx).trimStart() };
}

function linkify(text: string) {
  return text.replace(/(https?:\/\/[^\s<>"')]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#ff7420;word-break:break-all;">$1</a>');
}

function AttachIcon({ mimeType }: { mimeType: string }) {
  const m = mimeType.toLowerCase();
  if (m.includes('pdf')) return <FileText size={12} style={{ color: '#ef4444' }} />;
  if (m.startsWith('image/')) return <Image size={12} style={{ color: '#3b82f6' }} />;
  return <File size={12} style={{ color: E.textMuted }} />;
}

// ─── MessageCard ─────────────────────────────────────────────────────────────

function MessageCard({ msg, expanded, onToggle }: { msg: Msg; expanded: boolean; onToggle: () => void }) {
  const [quoteOpen, setQuoteOpen] = useState(false);
  const domain = msg.fromEmail?.split('@')[1] ?? msg.fromName;
  const hasHtml = !!(msg.bodyHtml && msg.bodyHtml.trim().length > 20);
  const { main: htmlMain, quote: htmlQuote } = hasHtml ? splitHtmlBody(sanitizeHtml(msg.bodyHtml)) : { main: '', quote: null };
  const { main: textMain, quote: textQuote } = hasHtml ? { main: '', quote: null } : splitBody(msg.body || '');

  const isDraft = msg.isDraft;
  const cardBg = isDraft
    ? 'color-mix(in srgb, var(--color-amber-50, #fffbeb) 60%, transparent)'
    : msg.isFromMe ? E.cardBgMe : E.cardBg;
  const borderColor = isDraft ? 'rgba(217, 119, 6, 0.35)' : E.borderLight;

  return (
    <div style={{ margin: '6px 12px', background: cardBg, border: `1px solid ${borderColor}`, borderRadius: 10, overflow: 'hidden' }}>
      {/* Draft banner */}
      {isDraft && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 14px', background: 'rgba(217, 119, 6, 0.12)', borderBottom: '1px solid rgba(217, 119, 6, 0.2)' }}>
          <PenLine size={11} style={{ color: 'rgba(180, 83, 9, 0.9)' }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(180, 83, 9, 0.9)', letterSpacing: '0.02em' }}>Draft — not sent</span>
        </div>
      )}
      {/* Header */}
      <div onClick={onToggle} style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', borderBottom: expanded ? `1px solid ${E.border}` : 'none', opacity: isDraft ? 0.85 : 1 }}>
        <div style={{ width: 34, height: 34, borderRadius: '50%', background: isDraft ? 'rgba(217, 119, 6, 0.5)' : domainColor(domain), flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff' }}>
          {isDraft ? <PenLine size={15} /> : (msg.fromName.charAt(0) || '?').toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: isDraft ? 'rgba(180, 83, 9, 0.9)' : E.textPrimary }}>{msg.fromName}</span>
            {msg.isFromMe && !isDraft && (
              <span style={{ fontSize: 10, background: 'var(--pill-green-bg)', color: 'var(--pill-green-text)', padding: '1px 6px', borderRadius: 4, fontWeight: 600 }}>You</span>
            )}
            {isDraft && (
              <span style={{ fontSize: 10, background: 'rgba(217, 119, 6, 0.15)', color: 'rgba(180, 83, 9, 0.9)', padding: '1px 6px', borderRadius: 4, fontWeight: 600, border: '1px solid rgba(217, 119, 6, 0.3)' }}>Draft</span>
            )}
          </div>
          {!expanded && (
            <span style={{ fontSize: 12, color: E.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth: 320 }}>
              {(msg.body || '').slice(0, 80)}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: E.textMuted }}>{formatDate(msg.date)}</span>
          <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.18 }}>
            <ChevronDown size={14} style={{ color: E.textMuted }} />
          </motion.div>
        </div>
      </div>

      {/* Body */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden' }}>
            <div style={{ padding: '14px 14px 16px' }}>
              <p style={{ fontSize: 11, color: E.textMuted, marginBottom: 10 }}>To: {msg.to || '—'}</p>

              {hasHtml ? (
                <>
                  <div className="email-html-body" dangerouslySetInnerHTML={{ __html: htmlMain }}
                    style={{ fontSize: 13, color: E.textBody, lineHeight: 1.65, overflowWrap: 'break-word', wordBreak: 'break-word' }} />
                  {htmlQuote && (
                    <div style={{ marginTop: 8 }}>
                      <button onClick={e => { e.stopPropagation(); setQuoteOpen(o => !o); }}
                        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 20, padding: '0 7px', borderRadius: 4, border: `1px solid ${E.border}`, background: 'transparent', color: E.textMuted, fontSize: 14, letterSpacing: 1, cursor: 'pointer', fontFamily: 'inherit' }}
                      >···</button>
                      <AnimatePresence initial={false}>
                        {quoteOpen && (
                          <motion.div key="q" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} style={{ overflow: 'hidden' }}>
                            <div className="email-html-body" dangerouslySetInnerHTML={{ __html: htmlQuote }}
                              style={{ fontSize: 12, color: E.textMuted, lineHeight: 1.6, marginTop: 8, paddingLeft: 12, borderLeft: `3px solid ${E.border}`, overflowWrap: 'break-word' }} />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <pre style={{ fontSize: 13, color: E.textBody, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}
                    dangerouslySetInnerHTML={{ __html: linkify(textMain || '(empty message)') }} />
                  {textQuote && (
                    <div style={{ marginTop: 8 }}>
                      <button onClick={e => { e.stopPropagation(); setQuoteOpen(o => !o); }}
                        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 20, padding: '0 7px', borderRadius: 4, border: `1px solid ${E.border}`, background: 'transparent', color: E.textMuted, fontSize: 14, letterSpacing: 1, cursor: 'pointer', fontFamily: 'inherit' }}
                      >···</button>
                      <AnimatePresence initial={false}>
                        {quoteOpen && (
                          <motion.div key="tq" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} style={{ overflow: 'hidden' }}>
                            <pre style={{ fontSize: 12, color: E.textMuted, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: '8px 0 0', paddingLeft: 12, borderLeft: `3px solid ${E.border}` }}>{textQuote}</pre>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </>
              )}

              {msg.attachments && msg.attachments.length > 0 && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${E.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
                    <Paperclip size={11} style={{ color: E.textMuted }} />
                    <span style={{ fontSize: 11, color: E.textMuted, fontWeight: 500 }}>{msg.attachments.length} attachment{msg.attachments.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {msg.attachments.map(att => (
                      <span key={att.attachmentId} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 5, border: `1px solid ${E.border}`, color: E.textSecondary, fontSize: 11 }}>
                        <AttachIcon mimeType={att.mimeType} /> {att.name}
                      </span>
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

// ─── ThreadMessages ───────────────────────────────────────────────────────────

interface Props {
  threadId: string;
}

export default function ThreadMessages({ threadId }: Props) {
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set());

  useEffect(() => {
    setLoading(true);
    setThread(null);
    getThread({ threadId }).then(data => {
      setThread(data);
      // Expand last message by default
      if (data.messages.length > 0) {
        setExpandedSet(new Set([data.messages.length - 1]));
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [threadId]);

  const toggle = (i: number) => setExpandedSet(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  if (loading) return (
    <div className="space-y-2 py-1">
      {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" style={{ background: E.cardBg }} />)}
    </div>
  );

  if (!thread || thread.messages.length === 0) return (
    <p style={{ fontSize: 12, color: E.textMuted, padding: '8px 12px' }}>No messages found for this thread.</p>
  );

  return (
    <div style={{ background: E.panel3, borderRadius: 8, overflow: 'hidden', border: `1px solid ${E.border}` }}>
      <style>{`.email-html-body a { color: ${E.accent}; } .email-html-body img { max-width: 100%; height: auto; }`}</style>
      <div style={{ padding: '8px 0', maxHeight: 460, overflowY: 'auto' }}>
        {thread.messages.map((msg, i) => (
          <MessageCard key={`${msg.id}-${i}`} msg={msg} expanded={expandedSet.has(i)} onToggle={() => toggle(i)} />
        ))}
      </div>
    </div>
  );
}
