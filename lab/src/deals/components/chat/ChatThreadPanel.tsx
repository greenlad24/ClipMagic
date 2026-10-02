/**
 * The chat's thread panel (Jake 2026-10-02: "open a thread from the AI chat
 * and draft the response there instead of going to the Emails page").
 *
 * Thread links in the chat — citation chips, thread / threads / queue cards,
 * the draft card — open the thread HERE, beside the conversation, using the
 * Emails page's own viewer: the messages, the agent's item, and the composer
 * (AI Draft, Send, Save as draft). On a phone it covers the chat; Back closes
 * it. The open thread is kept in the URL (?thread=) so a reload keeps it.
 *
 * Cmd/Ctrl-click on a link still opens the Emails page in a new tab.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import { getInboxThread, type InboxThreadDetail } from '@/deals/apiInbox';
import { fetchDeals, type Deal } from '@/deals/lib/supabase';
import EmailThreadViewer from '@/deals/components/EmailThreadViewer';
import { E } from '@/deals/lib/emailTheme';

const emailsHref = (threadId: string) => `/deal-organizer/emails?thread=${threadId}`;

/* ── context: who can open a thread in the panel ───────────────────────── */

const ChatThreadContext = createContext<((threadId: string) => void) | null>(null);
export const ChatThreadProvider = ChatThreadContext.Provider;
export function useOpenThread() { return useContext(ChatThreadContext); }

/** A link to a thread: opens the chat's panel when there is one, else the Emails page. */
export function ThreadLink({ threadId, className, title, children }: { threadId: string; className?: string; title?: string; children: ReactNode }) {
  const open = useOpenThread();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!open || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    open(threadId);
  };
  return <Link to={emailsHref(threadId)} onClick={onClick} className={className} title={title ?? 'Open the thread'}>{children}</Link>;
}

/* ── the panel ─────────────────────────────────────────────────────────── */

export default function ChatThreadPanel({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<InboxThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [deals, setDeals] = useState<Deal[]>([]);
  const seq = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const my = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const d = await getInboxThread(threadId);
      if (my === seq.current) setDetail(d);
    } catch (e) {
      if (my === seq.current && !quiet) { toast.error(`Could not open the thread: ${e instanceof Error ? e.message : 'error'}`); onClose(); }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { fetchDeals().then(setDeals).catch(() => {}); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('textarea, input')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      id="chat-thread-panel"
      className="fixed inset-0 z-40 flex flex-col lg:static lg:z-auto lg:w-[min(48%,700px)] lg:flex-shrink-0 lg:border-l border-border min-h-0"
      style={{ background: E.panel3 }}
    >
      <div className="hidden lg:flex items-center justify-between gap-2 px-4 py-2 border-b border-border flex-shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Thread</span>
        <div className="flex items-center gap-3">
          <Link to={emailsHref(threadId)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" title="Open it on the Emails page instead">
            <ExternalLink size={12} /> Emails page
          </Link>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" title="Close (Esc)"><X size={15} /></button>
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <EmailThreadViewer
          detail={detail}
          loading={loading}
          deals={deals}
          onBack={onClose}
          onChanged={() => void load(true)}
        />
      </div>
    </aside>
  );
}
