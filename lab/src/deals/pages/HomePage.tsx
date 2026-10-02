/**
 * Deal Organizer — Home: the AI chat (redesign 2026-09-30).
 *
 * One tool-using assistant (server: deals/chatAgent.ts, Claude Sonnet 4.6)
 * instead of the old regex modes. Real token streaming; the tools it ran are
 * shown inline; results come as cards (drafts, follow-ups, threads, fit
 * checks, proposed deal changes) whose buttons do the only writes — Jake
 * clicks every one. Conversations are kept on the server for 30 days
 * (History), so follow-up questions work and a chat can be reopened.
 *
 * Thread links open the thread in a panel beside the chat (ChatThreadPanel,
 * ?thread=ID) where Jake can read it, AI-draft and send the reply without
 * leaving the chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Send, Sparkles, RotateCcw, Loader2, Check, AlertTriangle, History, Trash2, X, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import {
  chatAgent, getChatSession, listChatSessions, deleteChatSession,
  type ChatPart, type ChatRef, type ChatSessionSummary,
} from '@/deals/apiInbox';
import CitedMarkdown from '@/deals/components/chat/CitedMarkdown';
import { ChatCard } from '@/deals/components/chat/ChatCards';
import { SyncIndicator } from '@/deals/components/SyncControls';
import ChatThreadPanel, { ChatThreadProvider } from '@/deals/components/chat/ChatThreadPanel';

interface UiTurn {
  key: string;
  userText: string;
  parts: ChatPart[];
  refs: ChatRef[];
  costUsd?: number;
  streaming?: boolean;
  error?: string;
}

const SUGGESTIONS = [
  { title: 'Pipeline overview', prompt: "What's my total pipeline value and how many deals are active right now?" },
  { title: 'Follow-ups', prompt: 'Who needs a follow-up? Show me stale deals and generate drafts.' },
  { title: 'Owed replies', prompt: 'Which brands are waiting on a reply from me?' },
  { title: 'Sponsor fit check', prompt: 'Research Otter.ai as a potential sponsor. Would they be a good fit for my audience?' },
  { title: 'Availability', prompt: 'How many sponsor slots do I have left this month and next?' },
  { title: 'Agent today', prompt: 'What did the email agent draft or ask me about in the last 2 days?' },
];

function ToolRow({ tools }: { tools: Extract<ChatPart, { kind: 'tool' }>[] }) {
  return (
    <div className="flex flex-col gap-1">
      {tools.map(t => (
        <div key={t.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
          {t.status === 'running' ? <Loader2 size={11} className="animate-spin flex-shrink-0" />
            : t.status === 'error' ? <AlertTriangle size={11} className="text-destructive flex-shrink-0" />
            : <Check size={11} className="text-emerald-500 flex-shrink-0" />}
          <span className="truncate" title={t.summary ?? t.label}>{t.status === 'done' && t.summary ? t.summary : t.label}{t.status === 'error' && t.summary ? ` — ${t.summary}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function AssistantTurn({ turn }: { turn: UiTurn }) {
  const refs = useMemo(() => new Map(turn.refs.map(r => [`${r.type}:${r.id}`, r])), [turn.refs]);
  // Group consecutive tool parts into one compact row.
  const blocks: Array<{ kind: 'tools'; tools: Extract<ChatPart, { kind: 'tool' }>[] } | ChatPart> = [];
  for (const p of turn.parts) {
    const last = blocks[blocks.length - 1];
    if (p.kind === 'tool') {
      if (last && last.kind === 'tools') last.tools.push(p);
      else blocks.push({ kind: 'tools', tools: [p] });
    } else blocks.push(p);
  }
  const empty = !turn.parts.some(p => p.kind === 'text' && p.text.trim()) && !turn.parts.some(p => p.kind !== 'text');
  return (
    <div className="flex gap-3 justify-start">
      <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: 'hsl(var(--primary) / 0.12)' }}>
        <Sparkles size={13} style={{ color: 'hsl(var(--primary))' }} />
      </div>
      <div className="flex-1 min-w-0 space-y-2.5">
        {blocks.map((b, i) => (
          b.kind === 'tools' ? <ToolRow key={i} tools={b.tools} />
            : b.kind === 'text' ? (b.text.trim() ? (
              <div key={i} className="glass-card rounded-2xl px-4 py-3 text-sm leading-relaxed text-foreground min-w-0 overflow-hidden">
                <CitedMarkdown text={b.text} refs={refs} />
              </div>
            ) : null)
            : b.kind === 'card' ? <ChatCard key={i} kind={b.card} data={b.data} /> : null
        ))}
        {turn.streaming && empty && (
          <div className="flex gap-1.5 items-center py-2 px-1">
            {[0, 1, 2].map(j => <div key={j} className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: `${j * 0.15}s` }} />)}
          </div>
        )}
        {turn.error && <p className="text-xs text-destructive">{turn.error}</p>}
        {!turn.streaming && turn.costUsd !== undefined && (
          <p className="text-[10px] text-muted-foreground">Claude Sonnet 4.6 · ${turn.costUsd.toFixed(turn.costUsd < 0.1 ? 3 : 2)}</p>
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  const [params, setParams] = useSearchParams();
  const [turns, setTurns] = useState<UiTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(params.get('chat'));
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatIdRef = useRef(0);
  const hasMessages = turns.length > 0;

  // The thread open beside the chat (?thread=ID).
  const openThreadId = params.get('thread');
  const openThread = useCallback((threadId: string) => {
    setParams(p => { const n = new URLSearchParams(p); n.set('thread', threadId); return n; });
  }, [setParams]);
  const closeThread = useCallback(() => {
    setParams(p => { const n = new URLSearchParams(p); n.delete('thread'); return n; }, { replace: true });
  }, [setParams]);

  const loadSessions = useCallback(() => {
    listChatSessions(40).then(r => setSessions(r.sessions)).catch(() => {});
  }, []);
  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Reopen ?chat=ID (SQL only — no AI).
  useEffect(() => {
    const id = params.get('chat');
    if (!id || id === sessionId && turns.length) return;
    chatIdRef.current++;
    getChatSession(id).then(r => {
      setSessionId(r.session.id);
      setTurns(r.turns.map(t => ({ key: t.id, userText: t.userText, parts: t.parts, refs: t.refs, costUsd: t.costUsd })));
    }).catch(e => {
      toast.error(e instanceof Error ? e.message : 'Could not open that chat');
      setParams(p => { const n = new URLSearchParams(p); n.delete('chat'); return n; }, { replace: true });
    });
  }, [params.get('chat')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns]);

  const patchLast = (fn: (t: UiTurn) => UiTurn) => setTurns(prev => {
    if (!prev.length) return prev;
    const next = [...prev];
    next[next.length - 1] = fn(next[next.length - 1]);
    return next;
  });

  const sendMessage = async (text: string) => {
    const message = text.trim();
    if (!message || streaming) return;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setStreaming(true);
    const myChat = chatIdRef.current;
    const stale = () => chatIdRef.current !== myChat;
    setTurns(prev => [...prev, { key: `t${Date.now()}`, userText: message, parts: [], refs: [], streaming: true }]);
    try {
      const s = chatAgent({ sessionId: sessionId ?? undefined, message });
      for await (const c of s) {
        if (stale()) break;
        if (c.type === 'session') {
          if (c.sessionId !== sessionId) {
            setSessionId(c.sessionId);
            setParams(p => { const n = new URLSearchParams(p); n.set('chat', c.sessionId); return n; }, { replace: true });
          }
        } else if (c.type === 'text') {
          patchLast(t => {
            const parts = [...t.parts];
            const last = parts[parts.length - 1];
            if (last && last.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + c.delta };
            else parts.push({ kind: 'text', text: c.delta });
            return { ...t, parts };
          });
        } else if (c.type === 'tool') {
          patchLast(t => {
            const i = t.parts.findIndex(p => p.kind === 'tool' && p.id === c.id);
            const part: ChatPart = { kind: 'tool', id: c.id, name: c.name, status: c.status, label: c.label, summary: c.summary };
            const parts = [...t.parts];
            if (i >= 0) parts[i] = { ...(parts[i] as any), ...part, label: c.status === 'running' ? c.label : (parts[i] as any).label };
            else parts.push(part);
            return { ...t, parts };
          });
        } else if (c.type === 'card') {
          patchLast(t => ({ ...t, parts: [...t.parts, { kind: 'card', card: c.kind, data: c.data }] }));
        } else if (c.type === 'refs') {
          patchLast(t => ({ ...t, refs: [...t.refs, ...c.refs] }));
        } else if (c.type === 'usage') {
          patchLast(t => ({ ...t, costUsd: c.costUsd }));
        }
      }
      if (!stale()) {
        const r = await s.result;
        patchLast(t => ({ ...t, streaming: false, costUsd: r.costUsd, refs: r.refs.length ? r.refs : t.refs }));
      }
    } catch (e) {
      if (!stale()) patchLast(t => ({ ...t, streaming: false, error: e instanceof Error ? e.message : 'Something went wrong — try again.' }));
    } finally {
      if (!stale()) { setStreaming(false); loadSessions(); }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(input); }
  };

  const newChat = () => {
    chatIdRef.current++;
    setTurns([]);
    setSessionId(null);
    setInput('');
    setStreaming(false);
    setHistoryOpen(false);
    setParams(p => { const n = new URLSearchParams(p); n.delete('chat'); return n; }, { replace: true });
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const openSession = (id: string) => {
    setHistoryOpen(false);
    if (id === sessionId) return;
    setParams(p => { const n = new URLSearchParams(p); n.set('chat', id); return n; });
  };

  const removeSession = async (id: string) => {
    try {
      await deleteChatSession(id);
      setSessions(s => s.filter(x => x.id !== id));
      if (id === sessionId) newChat();
    } catch { toast.error('Could not delete that chat'); }
  };

  const historyList = (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Chats · kept 30 days</span>
        <button onClick={() => setHistoryOpen(false)} className="md:hidden text-muted-foreground"><X size={14} /></button>
      </div>
      <button onClick={newChat} className="mx-3 mb-2 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-lg border border-border hover:bg-muted text-foreground">
        <RotateCcw size={12} /> New chat
      </button>
      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {sessions.length === 0 && <p className="px-2 text-xs text-muted-foreground">No chats yet.</p>}
        {sessions.map(s => (
          <div key={s.id} className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 cursor-pointer ${s.id === sessionId ? 'bg-primary/10' : 'hover:bg-muted'}`} onClick={() => openSession(s.id)}>
            <div className="min-w-0 flex-1">
              <p className={`text-xs truncate ${s.id === sessionId ? 'text-foreground font-medium' : 'text-foreground'}`}>{s.title || 'Untitled'}</p>
              <p className="text-[10px] text-muted-foreground">{new Date(s.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {s.turns} msg · ${s.costUsd.toFixed(2)}</p>
            </div>
            <button onClick={e => { e.stopPropagation(); void removeSession(s.id); }} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive" title="Delete this chat">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <ChatThreadProvider value={openThread}>
    <div className="flex h-full min-h-0 overflow-hidden flex-1" style={{ background: 'var(--bg-page)' }}>
      {/* History (desktop rail) */}
      <aside className="hidden md:flex w-56 flex-shrink-0 flex-col border-r border-border" style={{ background: 'var(--bg-sidebar-2)' }}>
        {historyList}
      </aside>
      {/* History (mobile overlay) */}
      {historyOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex" onClick={() => setHistoryOpen(false)}>
          <div className="w-72 max-w-[85vw] h-full border-r border-border shadow-xl" style={{ background: 'var(--bg-sidebar-2)' }} onClick={e => e.stopPropagation()}>{historyList}</div>
          <div className="flex-1 bg-black/40" />
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="md:hidden flex items-center justify-between px-3 pt-2">
          <button onClick={() => setHistoryOpen(true)} className="flex items-center gap-1.5 text-xs text-muted-foreground"><History size={13} /> History</button>
          {hasMessages && <button onClick={newChat} className="flex items-center gap-1.5 text-xs text-muted-foreground"><RotateCcw size={12} /> New chat</button>}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {!hasMessages ? (
            <div className="flex flex-col items-center justify-center min-h-full px-4 py-8">
              <div className="w-full max-w-2xl space-y-7">
                <div className="text-center space-y-3">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl mb-1" style={{ background: 'hsl(var(--primary) / 0.12)' }}>
                    <Sparkles size={22} style={{ color: 'hsl(var(--primary))' }} />
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">What can I help you with?</h1>
                  <p className="text-muted-foreground text-sm sm:text-base">Ask about your pipeline and deals, pull up any thread, check a sponsor's fit, or get reply and follow-up drafts written by the email agent's drafter. Open any thread right here to draft and send the reply — nothing is sent until you click Send.</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {SUGGESTIONS.map(s => (
                    <button key={s.title} onClick={() => void sendMessage(s.prompt)} disabled={streaming}
                      className="text-left p-3.5 rounded-2xl border border-border glass-card transition-all duration-150 hover:border-primary/40 hover:shadow-md group">
                      <p className="text-xs font-semibold text-muted-foreground mb-1 group-hover:text-primary transition-colors">{s.title}</p>
                      <p className="text-sm text-foreground leading-snug">{s.prompt}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-3 sm:px-4 py-6 space-y-6">
              {turns.map(t => (
                <div key={t.key} className="space-y-4">
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed text-primary-foreground whitespace-pre-wrap break-words" style={{ background: 'hsl(var(--primary))' }}>{t.userText}</div>
                  </div>
                  <AssistantTurn turn={t} />
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="flex-shrink-0 px-3 sm:px-4 pb-4 pt-3" style={{ borderTop: hasMessages ? '1px solid var(--border-color)' : 'none', background: 'var(--bg-page)' }}>
          <div className="max-w-3xl mx-auto">
            {hasMessages && (
              <div className="hidden md:flex justify-end mb-2">
                <button onClick={newChat} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"><RotateCcw size={12} /> New chat</button>
              </div>
            )}
            <div className="relative flex items-end gap-2 glass-card rounded-2xl p-3 border border-border focus-within:border-primary/50 transition-colors">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder="Ask about deals, pull up a thread, draft a reply, check a sponsor…"
                rows={1}
                disabled={streaming}
                className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none leading-relaxed min-w-0"
                style={{ scrollbarWidth: 'none', maxHeight: 160, overflowY: 'auto' }}
              />
              <button onClick={() => void sendMessage(input)} disabled={!input.trim() || streaming}
                className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-150 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: 'hsl(var(--primary))' }}>
                {streaming ? <Loader2 size={14} className="text-primary-foreground animate-spin" /> : <Send size={14} className="text-primary-foreground" />}
              </button>
            </div>
            <p className="text-center text-[11px] text-muted-foreground mt-2 flex items-center justify-center gap-1.5 flex-wrap">
              <Wrench size={10} /> Claude Sonnet 4.6 with your pipeline tools · drafts by the email agent's drafter (Opus 5.5) · Enter to send
            </p>
            <p className="text-center mt-1"><SyncIndicator /></p>
          </div>
        </div>
      </div>

      {openThreadId && <ChatThreadPanel key={openThreadId} threadId={openThreadId} onClose={closeThread} />}
    </div>
    </ChatThreadProvider>
  );
}
