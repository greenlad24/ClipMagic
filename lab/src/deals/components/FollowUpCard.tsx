import { useState } from 'react';
import { Mail, Pencil, SkipForward, Check, AlertTriangle, Sparkles, Loader2, XCircle, ThumbsDown, Hash } from 'lucide-react';
import ConfirmSendButton from '@/deals/components/ConfirmSendButton';
import { toast } from 'sonner';
import { LinkedText, SignatureFooter, splitSignature } from '@/deals/signature';
import { updateDeal } from '@/deals/api';
import { useStageLabels } from '@/deals/context/StageLabelsContext';

export type CardStatus = 'eligible' | 'skipped' | 'sent' | 'sending' | 'error' | 'moved';

export interface CardState {
  status: CardStatus;
  draft: string;
  movedTo?: string;
  /** Lab port: where the saved Gmail draft / sent email opens. */
  gmailUrl?: string;
  /** status 'sent': true = really SENT (Send button), false = saved as a Gmail draft. */
  delivered?: 'sent' | 'draft';
  /** Which button is busy while status is 'sending'. */
  busyMode?: 'send' | 'draft';
}

interface Deal {
  dealId: string;
  firstName: string;
  companyName: string;
  projectName: string;
  daysSinceLast: number;
  priorFollowUpCount: number;
  isCustomDraft: boolean;
  /** Redesign: the classifier's SUGGESTION ('poor_fit_now' = they offered under $4,000). Nothing is moved automatically. */
  suggestedStage?: string | null;
  classificationReason?: string;
}

interface Props {
  deal: Deal;
  state: CardState;
  onStateChange: (updates: Partial<CardState>) => void;
  /** "send" = Send (manual send, two clicks), "draft" = Save as Gmail draft. */
  onSend: (mode: 'send' | 'draft') => void;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function FollowUpCard({ deal, state, onStateChange, onSend }: Props) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(() => splitSignature(state.draft).body);
  const sig = splitSignature(state.draft).signature;
  const [moving, setMoving] = useState<string | null>(null);
  const { getStageLabel, isProductionStage } = useStageLabels();

  const { status, draft, movedTo } = state;
  const isSent = status === 'sent';
  const isSkipped = status === 'skipped';
  const isSending = status === 'sending';
  const isError = status === 'error';
  const isMoved = status === 'moved';
  const isDimmed = isSent || isSkipped || isMoved;

  const handleSave = () => {
    onStateChange({ draft: sig ? `${editDraft.replace(/\s+$/, '')}\n\n${sig}` : editDraft });
    setEditing(false);
  };

  // Sends the stage KEY (the original sent the labels "Rejected" / "Poor Fit Now"
  // and only worked through the server's label fallback).
  const handleMoveDeal = async (targetStage: 'rejected' | 'poor_fit_now') => {
    const label = getStageLabel(targetStage, targetStage === 'rejected' ? 'Rejected' : 'Poor Fit Now');
    setMoving(targetStage);
    try {
      await updateDeal({ id: deal.dealId, updates: { stage: targetStage, ...(isProductionStage(targetStage) ? {} : { in_production: false }) } });
      onStateChange({ status: 'moved', movedTo: label });
      toast.success(`${deal.companyName} moved to ${label}`);
    } catch {
      toast.error(`Failed to move ${deal.companyName}`);
    } finally {
      setMoving(null);
    }
  };

  const daysBadgeClass = deal.daysSinceLast >= 7
    ? 'bg-destructive/10 text-destructive'
    : 'bg-accent/60 text-accent-foreground';

  const projectLabel = deal.projectName && deal.projectName !== deal.companyName
    ? ` · "${deal.projectName}"`
    : '';

  // The count represents consecutive unanswered messages from you at the end of the thread.
  // This draft will be the next one, so display count = priorFollowUpCount + 1 would be "this send",
  // but the user wants to see how many are already sent, so we show priorFollowUpCount as-is
  // and label this as the Nth follow-up (the one about to be sent).
  const followUpLabel = `${ordinal(deal.priorFollowUpCount)} follow-up`;

  return (
    <div className={`border border-border rounded-xl p-4 bg-card transition-all ${isDimmed ? 'opacity-40' : ''}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-foreground">{deal.firstName}</span>
          <span className="text-xs text-muted-foreground ml-1.5 truncate inline-block max-w-[240px] align-bottom">
            {deal.companyName}{projectLabel}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Follow-up count badge — always visible */}
          <span className={`flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
            deal.priorFollowUpCount >= 3
              ? 'bg-destructive/10 text-destructive'
              : deal.priorFollowUpCount >= 2
                ? 'bg-orange-500/10 text-orange-600'
                : 'bg-muted text-muted-foreground'
          }`}>
            <Hash size={9} />
            {followUpLabel}
          </span>
          {deal.isCustomDraft && (
            <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              <Sparkles size={9} /> AI
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${daysBadgeClass}`}>
            {deal.daysSinceLast}d ago
          </span>
        </div>
      </div>

      {/* Warning badge for high follow-up count */}
      {deal.priorFollowUpCount >= 3 && !isSent && !isSkipped && !isMoved && (
        <div className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-destructive/10 text-destructive mb-2">
          <AlertTriangle size={11} />
          {deal.priorFollowUpCount} unanswered follow-ups — consider rejecting or marking as poor fit
        </div>
      )}

      {/* The classifier's suggestion (rule #19: under $4,000 → hold at $6,500; moving is Jake's call) */}
      {deal.suggestedStage && !isSent && !isSkipped && !isMoved && (
        <div className="flex items-start gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-amber-500/10 text-amber-700 [.dealorg-dark_&]:text-amber-300 mb-2">
          <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
          <span>
            Suggested: move to {getStageLabel(deal.suggestedStage, 'Poor Fit Now')}{deal.classificationReason ? ` — ${deal.classificationReason}` : ''}.
            {' '}The follow-up still holds the $6,500 rate.
          </span>
        </div>
      )}

      {/* Status messages */}
      {isSent && (
        <p className="text-xs font-medium text-emerald-600 [.dealorg-dark_&]:text-emerald-400 mb-1">
          {state.delivered === 'sent' ? '✅ Sent' : '✅ Saved as a Gmail draft — not sent'}
          {state.gmailUrl && (
            <> · <a href={state.gmailUrl} target="_blank" rel="noopener noreferrer" className="underline">Open in Gmail</a></>
          )}
        </p>
      )}
      {isSkipped && <p className="text-xs text-muted-foreground mb-1">⏭️ Skipped</p>}
      {isMoved && <p className="text-xs text-muted-foreground mb-1">📦 Moved to {movedTo}</p>}
      {isError && <p className="text-xs text-destructive mb-1">❌ Could not {state.busyMode === 'send' ? 'send it' : 'save the draft'} — try again</p>}

      {/* Draft + actions */}
      {!isSent && !isSkipped && !isMoved && (
        <>
          {editing ? (
            <textarea
              value={editDraft}
              onChange={e => setEditDraft(e.target.value)}
              rows={7}
              className="w-full text-sm bg-muted border border-border rounded-lg p-3 text-foreground outline-none resize-none leading-relaxed mb-2"
            />
          ) : null}
          {editing ? (
            <div className="mb-2"><SignatureFooter signature={sig} /></div>
          ) : (
            <div className="bg-muted rounded-lg p-3 text-sm text-foreground leading-relaxed whitespace-pre-wrap mb-3">
              <LinkedText text={draft} />
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            {editing ? (
              <button
                onClick={handleSave}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground"
              >
                <Check size={11} /> Save
              </button>
            ) : (
              <>
                <ConfirmSendButton
                  onSend={() => onSend('send')}
                  busy={isSending && state.busyMode === 'send'}
                  disabled={isSending}
                  iconSize={11}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-60"
                  armedClassName="ring-2 ring-primary/40"
                />
                <button
                  onClick={() => onSend('draft')}
                  disabled={isSending}
                  title="Saves a draft in the Gmail thread — nothing is sent"
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted disabled:opacity-60"
                >
                  {isSending && state.busyMode === 'draft' ? <Loader2 size={11} className="animate-spin" /> : <Mail size={11} />}
                  {isSending && state.busyMode === 'draft' ? 'Saving…' : 'Save as draft'}
                </button>
                <button
                  onClick={() => { setEditDraft(draft); setEditing(true); }}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted transition-colors"
                >
                  <Pencil size={11} /> Edit
                </button>
                <button
                  onClick={() => onStateChange({ status: 'skipped' })}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                >
                  <SkipForward size={11} /> Skip
                </button>

                {/* Divider */}
                <div className="w-px h-4 bg-border mx-0.5" />

                {/* Reject button */}
                <button
                  onClick={() => handleMoveDeal('rejected')}
                  disabled={!!moving}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-60"
                >
                  {moving === 'rejected' ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={11} />}
                  Reject
                </button>

                {/* Poor Fit button */}
                <button
                  onClick={() => handleMoveDeal('poor_fit_now')}
                  disabled={!!moving}
                  className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60 ${deal.suggestedStage === 'poor_fit_now' ? 'border border-amber-500/40 text-amber-700 [.dealorg-dark_&]:text-amber-300 bg-amber-500/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                  title={deal.suggestedStage === 'poor_fit_now' ? 'Suggested by the classifier — click to move (nothing moves by itself)' : undefined}
                >
                  {moving === 'poor_fit_now' ? <Loader2 size={11} className="animate-spin" /> : <ThumbsDown size={11} />}
                  Poor Fit
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
