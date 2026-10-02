/**
 * The agent drafter's reply, for the chat and the Emails page.
 *
 * `draftReply` runs the live email agent's own pipeline in PREVIEW (Opus 5.5 +
 * the rulebook + the pre-save checks, one redraft) — nothing is saved until
 * Jake clicks. "Send" = `sendReply` mode "send" (a manual send — allowed;
 * two clicks to confirm); "Save as Gmail draft" = `sendReply` default, a DRAFT
 * in the thread.
 *
 * Shows: the draft (editable), the checks, warnings, the drafter's question
 * ("ask") or its "no reply needed" verdict with a way to answer / insist,
 * and a Regenerate-with-direction box.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, Loader2, Mail, RefreshCw, Sparkles, X, HelpCircle } from 'lucide-react';
import { toast } from 'sonner';
import { sendReply } from '@/deals/api';
import { draftReply, type DraftReplyResult } from '@/deals/apiInbox';
import { toastDraftSaved, toastSent } from '@/deals/lib/draftToast';
import ConfirmSendButton from '@/deals/components/ConfirmSendButton';
import { SignatureFooter, splitSignature } from '@/deals/signature';

interface Props {
  threadId: string;
  /** A result already computed (the chat's draft_reply card). */
  initial?: DraftReplyResult | null;
  /** Start drafting on mount (the Emails page "AI Draft" button). */
  autoStart?: boolean;
  /** Direction for the first run (what Jake typed in the reply box). */
  initialInstructions?: string;
  onSaved?: (gmailUrl: string) => void;
  onClose?: () => void;
}

const money = (n: number) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;

export default function AgentDraftCard({ threadId, initial = null, autoStart = false, initialInstructions, onSaved, onClose }: Props) {
  const [result, setResult] = useState<DraftReplyResult | null>(initial);
  const [text, setText] = useState(() => splitSignature(initial?.draftText ?? '').body);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const started = useRef(false);

  const run = async (instructions?: string) => {
    if (running) return;
    setRunning(true);
    setError(null);
    setProgress('Starting…');
    try {
      const s = draftReply(threadId, instructions);
      for await (const c of s) if (c?.message) setProgress(c.message);
      const r = await s.result;
      setResult(r);
      setText(splitSignature(r.draftText ?? '').body);
      setSavedUrl(null);
      setSentOk(false);
      setDirection('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  useEffect(() => {
    if (autoStart && !initial && !started.current) { started.current = true; void run(initialInstructions); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const deliver = async (mode: 'draft' | 'send') => {
    if (!result || !text.trim() || saving || sending) return;
    if (!result.reply.toEmail) { toast.error('Could not work out who to reply to in this thread'); return; }
    const setBusy = mode === 'send' ? setSending : setSaving;
    setBusy(true);
    try {
      const res = await sendReply({
        dealId: result.reply.dealId || '',
        threadId,
        toEmail: result.reply.toEmail,
        cc: result.reply.cc || undefined,
        lastMessageId: result.reply.lastMessageId || '',
        lastReferences: result.reply.lastReferences || '',
        subject: result.reply.subject || '',
        draftText: text.trim(),
        mode,
      });
      setSavedUrl(res.gmailUrl);
      if (mode === 'send') { setSentOk(true); toastSent(`Reply sent to ${result.reply.toEmail}`, res.gmailUrl); }
      else toastDraftSaved('Reply saved as a Gmail draft', res.gmailUrl);
      onSaved?.(res.gmailUrl);
    } catch (e) {
      toast.error(`Could not ${mode === 'send' ? 'send the reply' : 'save the draft'}: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const failed = result?.checks.filter(c => !c.ok) ?? [];
  const sig = splitSignature(result?.draftText ?? '').signature;
  // The footer is kept out of the box and re-added by the server on save (every email ends with it).
  const edited = !!result?.draftText && text.trim() !== splitSignature(result.draftText).body.trim();

  return (
    <div className="border border-border rounded-xl bg-card p-3.5 space-y-3 text-sm w-full min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground min-w-0">
          <Sparkles size={13} className="text-primary flex-shrink-0" />
          <span className="truncate">Agent draft{result?.brand ? ` · ${result.brand}` : ''}{result?.stage ? ` · ${result.stage}` : ''}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {result && <span className="text-[10px] text-muted-foreground" title={`${result.models.triage} triage · ${result.models.draft} draft + check`}>{money(result.costUsd)}</span>}
          {onClose && <button onClick={onClose} className="text-muted-foreground hover:text-foreground" title="Close"><X size={14} /></button>}
        </div>
      </div>

      {running && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Loader2 size={13} className="animate-spin flex-shrink-0" />
          <span className="truncate">{progress ?? 'Drafting…'}</span>
          <span className="ml-auto text-[10px] whitespace-nowrap">Opus 5.5 · ~$0.15</span>
        </div>
      )}
      {error && !running && (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 text-destructive text-xs p-2.5">
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" /> <span className="break-words">{error}</span>
        </div>
      )}
      {!result && !running && !error && (
        <button onClick={() => run(initialInstructions)} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground">
          <Sparkles size={12} /> Write the draft (~$0.15)
        </button>
      )}

      {result && !running && (
        <>
          {result.goal && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">They want:</span> {result.goal}</p>}

          {result.warnings.length > 0 && (
            <div className="space-y-1">
              {result.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1.5 rounded-md bg-amber-500/10 text-amber-700 [.dealorg-dark_&]:text-amber-300 text-xs px-2.5 py-1.5">
                  <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" /><span className="break-words">{w}</span>
                </div>
              ))}
            </div>
          )}

          {result.fit && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Fit (#41):</span> {result.fit.verdict}{result.fit.angle ? ` — angle: ${result.fit.angle}` : ''}
            </p>
          )}

          {result.action === 'ask' && result.ask && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 space-y-1.5">
              <p className="flex items-start gap-1.5 text-xs font-semibold text-foreground"><HelpCircle size={12} className="mt-0.5 flex-shrink-0 text-primary" /> The drafter needs your call{result.ask.rule ? ` (${result.ask.rule})` : ''}</p>
              <p className="text-xs text-foreground whitespace-pre-wrap">{result.ask.question}</p>
              {result.ask.proposal && <p className="text-xs text-muted-foreground whitespace-pre-wrap"><span className="font-medium">It proposes:</span> {result.ask.proposal}</p>}
            </div>
          )}
          {result.action === 'no_reply' && (
            <div className="rounded-lg border border-border bg-muted/50 p-2.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">No reply needed, says the drafter:</span> {result.summary || 'the latest message needs no answer.'}
            </div>
          )}

          {result.action === 'draft' && (
            <>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                rows={Math.min(18, Math.max(7, text.split('\n').length + 1))}
                className="w-full text-sm bg-muted/60 border border-border rounded-lg p-3 text-foreground outline-none focus:border-primary/50 leading-relaxed resize-y"
              />
              <SignatureFooter signature={sig} />
              <button onClick={() => setChecksOpen(o => !o)} className="flex items-center gap-1.5 text-xs">
                {checksOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {result.checksPassed
                  ? <span className="text-emerald-600 [.dealorg-dark_&]:text-emerald-400 font-medium">All {result.checks.length} pre-save checks passed{result.redrafted ? ' (after one redraft)' : ''}</span>
                  : <span className="text-destructive font-medium">{failed.length} check{failed.length === 1 ? '' : 's'} failed{result.redrafted ? ' after a redraft' : ''} — review before sending</span>}
                {edited && <span className="text-muted-foreground">· edited by you</span>}
              </button>
              {checksOpen && (
                <ul className="space-y-1 pl-1">
                  {result.checks.map(c => (
                    <li key={c.name} className={`flex items-start gap-1.5 text-[11px] ${c.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
                      {c.ok ? <Check size={11} className="mt-0.5 flex-shrink-0" /> : <X size={11} className="mt-0.5 flex-shrink-0" />}
                      <span><span className="font-medium">{c.name.replace(/^model_/, '')}</span>: {c.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              {result.suggestedBoardStage && (
                <p className="text-[11px] text-muted-foreground">Board suggestion (not applied): {result.suggestedBoardStage}</p>
              )}
            </>
          )}

          {savedUrl ? (
            <div className="flex items-center gap-2 text-xs text-emerald-600 [.dealorg-dark_&]:text-emerald-400 font-medium">
              <Check size={13} /> {sentOk ? 'Sent.' : 'Saved as a Gmail draft — nothing was sent.'}
              <a href={savedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline"><ExternalLink size={11} /> Open in Gmail</a>
            </div>
          ) : result.action === 'draft' && (
            <div className="flex items-center gap-2 flex-wrap">
              <ConfirmSendButton onSend={() => deliver('send')} busy={sending} disabled={saving || !text.trim()}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                armedClassName="ring-2 ring-primary/40" />
              <button onClick={() => deliver('draft')} disabled={saving || sending || !text.trim()} title="Creates a draft in this Gmail thread — nothing is sent"
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted disabled:opacity-50">
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />} {saving ? 'Saving…' : 'Save as Gmail draft'}
              </button>
              <span className="text-[11px] text-muted-foreground truncate">to {result.reply.toEmail}{result.reply.cc ? ` (cc ${result.reply.cc})` : ''}</span>
            </div>
          )}
        </>
      )}

      {!running && (result || error) && !savedUrl && (
        <div className="flex gap-2 items-center">
          <input
            value={direction}
            onChange={e => setDirection(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && direction.trim()) void run(direction); }}
            placeholder={result?.action === 'ask' ? 'Your answer / direction…' : result?.action === 'no_reply' ? 'Write it anyway — what should it say?' : 'Redraft with direction: shorter, mention the date…'}
            className="flex-1 min-w-0 text-xs bg-muted border border-border rounded-lg px-3 py-1.5 text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50"
          />
          <button onClick={() => run(direction)} disabled={!direction.trim() && result?.action !== 'draft'}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted disabled:opacity-50 whitespace-nowrap"
            title="Runs the drafter again (~$0.15)">
            <RefreshCw size={12} /> {result?.action === 'draft' ? 'Redraft' : 'Draft'}
          </button>
        </div>
      )}
    </div>
  );
}
