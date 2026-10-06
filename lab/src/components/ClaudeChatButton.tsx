/**
 * Floating "Chat" button — sits directly above the Jobs trigger on every Lab
 * page and opens Jake's Claude Code remote-control session (where he talks to
 * Claude to improve the Lab) in a new tab. claude.ai refuses to be framed, so
 * it is a plain link, never an iframe.
 *
 * The URL is NOT in the bundle: it comes from GET /api/claude-chat, which only
 * answers a signed-in, whitelisted session (401 otherwise) and reads the
 * server's CLAUDE_CHAT_URL env var — so a restarted session gets a new link with
 * no code change. No URL (signed out, refused, unset) → the button doesn't render.
 */
import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';

export default function ClaudeChatButton({ aboveJobs = true }: { aboveJobs?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/claude-chat', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { url?: string | null } | null) => {
        if (!cancelled) setUrl(typeof j?.url === 'string' && j.url ? j.url : null);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!url) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with Claude (opens in a new tab)"
      title="Chat with Claude about improving the Lab"
      className={`fixed ${aboveJobs ? 'bottom-[4.5rem]' : 'bottom-5'} right-5 z-40 flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 shadow-lg transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring`}
    >
      <MessageSquare className="w-4 h-4 text-foreground" />
      <span className="text-sm font-medium text-foreground hidden sm:inline">Chat</span>
    </a>
  );
}
