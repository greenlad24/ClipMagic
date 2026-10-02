import { useState } from 'react';
import { Mail, Loader2, ChevronDown, ChevronRight, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { type GetFollowUpDraftsOutputType, sendFollowUp } from '@/deals/api';
import FollowUpCard, { type CardState } from './FollowUpCard';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { toastDraftSaved, toastSent } from '@/deals/lib/draftToast';
import ConfirmSendButton from '@/deals/components/ConfirmSendButton';

/** The server adds the classifier's view (additive): suggestedStage is a suggestion only — nothing is auto-moved. */
type FollowUpDeal = GetFollowUpDraftsOutputType['deals'][0] & { suggestedStage?: string | null; classificationReason?: string; classification?: string };
type AutoMovedDeal = GetFollowUpDraftsOutputType['autoMoved'][0];

// Stage groups follow the live board order (custom + renamed stages included);
// the original used a hard-coded list of five labels.

interface Props {
  deals: FollowUpDeal[];
  autoMoved?: AutoMovedDeal[];
}

export default function FollowUpPanel({ deals, autoMoved = [] }: Props) {
  const { allStageKeys, resolveStageKey, getStageLabel } = useStageLabels();
  const [cardStates, setCardStates] = useState<Record<string, CardState>>(() =>
    Object.fromEntries(deals.map(d => [d.dealId, { status: 'eligible' as CardState['status'], draft: d.draft }]))
  );
  const [bulkSending, setBulkSending] = useState<false | 'send' | 'draft'>(false);
  const [bulkProgress, setBulkProgress] = useState(0);
  const [autoMovedOpen, setAutoMovedOpen] = useState(true);

  const updateCard = (dealId: string, updates: Partial<CardState>) =>
    setCardStates(prev => ({ ...prev, [dealId]: { ...prev[dealId], ...updates } }));

  // "send" = a manual send Jake clicked (allowed); "draft" = a Gmail draft in the thread.
  const doSend = async (deal: FollowUpDeal, mode: 'send' | 'draft', quiet = false): Promise<boolean> => {
    updateCard(deal.dealId, { status: 'sending', busyMode: mode });
    try {
      const res = await sendFollowUp({
        dealId: deal.dealId,
        threadId: deal.threadId,
        toEmail: deal.toEmail,
        lastMessageId: deal.lastMessageId,
        lastReferences: deal.lastReferences,
        subject: deal.lastSubject,
        draftText: cardStates[deal.dealId]?.draft ?? deal.draft,
        mode,
      });
      updateCard(deal.dealId, { status: 'sent', gmailUrl: res.gmailUrl, delivered: mode === 'send' ? 'sent' : 'draft' });
      if (!quiet) {
        if (mode === 'send') toastSent(`Follow-up sent to ${deal.firstName}`, res.gmailUrl);
        else toastDraftSaved(`Follow-up to ${deal.firstName} saved as a Gmail draft`, res.gmailUrl);
      }
      return true;
    } catch (e) {
      updateCard(deal.dealId, { status: 'error' });
      toast.error(`Could not ${mode === 'send' ? 'send the follow-up' : 'save the draft'} for ${deal.firstName}: ${e instanceof Error ? e.message : 'check the Gmail connection'}`);
      return false;
    }
  };

  const handleBulk = async (mode: 'send' | 'draft') => {
    const eligible = deals.filter(d => cardStates[d.dealId]?.status === 'eligible');
    if (!eligible.length) return;
    setBulkSending(mode);
    setBulkProgress(0);
    let ok = 0;
    for (let i = 0; i < eligible.length; i++) {
      if (await doSend(eligible[i], mode, true)) ok++;
      setBulkProgress(i + 1);
    }
    setBulkSending(false);
    if (mode === 'send') toast.success(`Sent ${ok} follow-up${ok !== 1 ? 's' : ''}`);
    else toast.success(`Saved ${ok} follow-up draft${ok !== 1 ? 's' : ''} in Gmail — nothing was sent`);
  };

  // Group by stage
  const grouped = new Map<string, FollowUpDeal[]>();
  for (const d of deals) {
    if (!grouped.has(d.stage)) grouped.set(d.stage, []);
    grouped.get(d.stage)!.push(d);
  }
  for (const grp of grouped.values()) grp.sort((a, b) => b.daysSinceLast - a.daysSinceLast);

  // The server reports the stage as stored (a label); order and name the groups by the live stages.
  const stageIndex = (s: string) => {
    const key = resolveStageKey(s);
    const i = key ? allStageKeys.indexOf(key) : -1;
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const stageTitle = (s: string) => {
    const key = resolveStageKey(s);
    return key ? getStageLabel(key, s) : s;
  };
  const orderedStages = [...grouped.keys()].sort((a, b) => stageIndex(a) - stageIndex(b));

  const eligibleCount = deals.filter(d => cardStates[d.dealId]?.status === 'eligible').length;

  if (!deals.length && !autoMoved.length) {
    return (
      <div className="mt-2 px-4 py-3 rounded-xl border border-border bg-muted/40 text-sm text-muted-foreground">
        ✅ No stale deals found — all threads have recent activity or recent follow-ups already sent.
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-4 w-full">
      {/* Auto-moved low-ballers summary */}
      {autoMoved.length > 0 && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 overflow-hidden">
          <button
            onClick={() => setAutoMovedOpen(o => !o)}
            className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-destructive/10 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Ban size={13} className="text-destructive flex-shrink-0" />
              <span className="text-xs font-semibold text-destructive">
                {autoMoved.length} deal{autoMoved.length !== 1 ? 's' : ''} moved to Poor Fit Now
              </span>
              <span className="text-[10px] text-muted-foreground font-normal">
                (earlier runs)
              </span>
            </div>
            {autoMovedOpen
              ? <ChevronDown size={13} className="text-muted-foreground" />
              : <ChevronRight size={13} className="text-muted-foreground" />
            }
          </button>

          {autoMovedOpen && (
            <div className="px-3.5 pb-3 space-y-2">
              {autoMoved.map(item => (
                <div
                  key={item.dealId}
                  className="flex items-start justify-between gap-3 py-1.5 border-t border-destructive/10 first:border-t-0 first:pt-0"
                >
                  <span className="text-xs font-medium text-foreground">
                    {item.companyName}
                    {item.firstName && item.firstName !== item.companyName && (
                      <span className="text-muted-foreground font-normal"> · {item.firstName}</span>
                    )}
                  </span>
                  <span className="text-[11px] text-muted-foreground text-right max-w-[55%] leading-snug">
                    {item.reason}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Follow-up cards */}
      {deals.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            {deals.length} stale deal{deals.length !== 1 ? 's' : ''} — review the drafts below, then send them or save them as Gmail drafts. Nothing goes out until you click Send.
          </p>

          {orderedStages.map(stage => (
            <div key={stage}>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">
                {stageTitle(stage)}
              </p>
              <div className="space-y-2">
                {(grouped.get(stage) ?? []).map(deal => (
                  <FollowUpCard
                    key={deal.dealId}
                    deal={deal}
                    state={cardStates[deal.dealId] ?? { status: 'eligible', draft: deal.draft }}
                    onStateChange={updates => updateCard(deal.dealId, updates)}
                    onSend={mode => void doSend(deal, mode)}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Footer */}
          <div className="flex items-center justify-between pt-3 border-t border-border">
            <span className="text-sm text-muted-foreground">
              {eligibleCount} of {deals.length} ready
            </span>
            {eligibleCount > 0 && (
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <button
                  onClick={() => handleBulk('draft')}
                  disabled={!!bulkSending}
                  title="Saves each follow-up as a draft in its Gmail thread — nothing is sent"
                  className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border text-foreground text-sm font-medium hover:bg-muted disabled:opacity-60 transition-opacity"
                >
                  {bulkSending === 'draft'
                    ? <><Loader2 size={14} className="animate-spin" /> Saving {bulkProgress}/{eligibleCount}…</>
                    : <><Mail size={14} /> Save all as drafts</>}
                </button>
                <ConfirmSendButton
                  onSend={() => handleBulk('send')}
                  busy={bulkSending === 'send'}
                  disabled={!!bulkSending}
                  iconSize={14}
                  label={`Send all (${eligibleCount})`}
                  armedLabel={`Click again to send ${eligibleCount}`}
                  busyLabel={`Sending ${bulkProgress}/${eligibleCount}…`}
                  title={`Sends all ${eligibleCount} follow-ups still shown (skipped and moved ones are left out) — click twice to confirm`}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-60 transition-opacity"
                  armedClassName="ring-2 ring-primary/40"
                />
              </div>
            )}
          </div>
        </>
      )}

      {/* Edge case: only auto-moved, no follow-ups */}
      {deals.length === 0 && autoMoved.length > 0 && (
        <div className="px-4 py-3 rounded-xl border border-border bg-muted/40 text-sm text-muted-foreground">
          ✅ No additional follow-up drafts — {autoMoved.length} deal{autoMoved.length !== 1 ? 's were' : ' was'} automatically moved to Poor Fit Now.
        </div>
      )}
    </div>
  );
}
