/**
 * Chat answer text with citations. The assistant writes [[deal:ID]] and
 * [[thread:ID]]; they become chips linking to the deal workspace
 * (/deal-organizer/deals/:id) or the thread on the Emails page, labelled from
 * the tool refs. In-app links navigate without a page reload; in the chat,
 * a thread chip opens the thread in the panel beside it (ChatThreadPanel).
 */
import { useMemo, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Markdown } from '@/deals/ui/markdown';
import type { ChatRef } from '@/deals/apiInbox';
import { useOpenThread } from './ChatThreadPanel';

const CITE = /\[\[(deal|thread):([A-Za-z0-9-]+)\]\]/g;

export function citationHref(type: 'deal' | 'thread', id: string): string {
  return type === 'deal' ? `/deal-organizer/deals/${id}` : `/deal-organizer/emails?thread=${id}`;
}

export default function CitedMarkdown({ text, refs }: { text: string; refs: Map<string, ChatRef> }) {
  const navigate = useNavigate();
  const openThread = useOpenThread();
  const md = useMemo(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://lab.jakedaw.com';
    return text.replace(CITE, (_m, type: 'deal' | 'thread', id: string) => {
      const ref = refs.get(`${type}:${id}`);
      const label = (ref?.label || (type === 'deal' ? 'deal' : 'thread')).replace(/[[\]()]/g, '').slice(0, 48);
      return `[${type === 'deal' ? '◆' : '✉'} ${label}](${origin}${citationHref(type, id)})`;
    });
  }, [text, refs]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    const origin = window.location.origin;
    if (href.startsWith(`${origin}/deal-organizer/`) && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const thread = openThread && href.match(/\/deal-organizer\/emails\?thread=([A-Za-z0-9-]+)/);
      if (thread) openThread(thread[1]);
      else navigate(href.slice(origin.length));
    }
  };

  return (
    <div onClick={onClick} className="chat-cited">
      <style>{`
        .chat-cited a[href*="/deal-organizer/"] {
          display: inline-flex; align-items: center; gap: 3px; padding: 0 7px; margin: 0 1px; border-radius: 999px;
          font-size: 12px; line-height: 20px; text-decoration: none !important; white-space: nowrap; max-width: 100%;
          overflow: hidden; text-overflow: ellipsis; vertical-align: baseline;
          background: hsl(var(--primary) / 0.12); color: hsl(var(--primary)) !important; border: 1px solid hsl(var(--primary) / 0.25);
        }
        .chat-cited a[href*="/deal-organizer/emails"] { background: hsl(217 91% 60% / 0.12); color: hsl(217 91% 55%) !important; border-color: hsl(217 91% 60% / 0.3); }
        .chat-cited a[href*="/deal-organizer/"]:hover { filter: brightness(1.1); }
        .chat-cited table { display: block; overflow-x: auto; max-width: 100%; }
      `}</style>
      <div className="prose prose-sm max-w-none [.dealorg-dark_&]:prose-invert prose-p:my-1 prose-ul:my-1 prose-li:my-0.5">
        <Markdown>{md}</Markdown>
      </div>
    </div>
  );
}
