import { Deal, Comment, Action } from '@/deals/lib/supabase';
import CommentsSection from './CommentsSection';
import AiInsightSection from './AiInsightSection';
import TodoListSection from './TodoListSection';
import LinksMediaSection from './LinksMediaSection';
import DealInfoSection from './DealInfoSection';
import DealFilesSection from './DealFilesSection';

interface Props {
  deal: Deal;
  comments: Comment[];
  actions: Action[];
  loadingComments: boolean;
  loadingActions: boolean;
  onUpdate: (updates: Partial<Deal>) => Promise<void> | void;
  onCommentsChange: (c: Comment[]) => void;
  onActionsChange: (a: Action[]) => void;
}

export default function DealDrawerBody({
  deal, comments, actions,
  loadingComments, loadingActions,
  onUpdate, onCommentsChange, onActionsChange,
}: Props) {
  // Nothing is written on open. The card fields and the to-do list fill
  // themselves from the email thread(s) in the central sync (server
  // dealAutofill.ts); no empty state asks Jake to type details.

  return (
    <div className="flex-1 overflow-y-auto lg:overflow-hidden flex flex-col lg:flex-row" style={{ background: 'var(--bg-shell)' }}>
      {/* Main — AI insight + structured deal info */}
      <div className="lg:flex-1 lg:overflow-y-auto px-4 py-5 sm:px-10 sm:py-8 flex flex-col" style={{ background: 'var(--bg-panel)' }}>
        <div className="max-w-3xl w-full mx-auto flex flex-col gap-6 sm:gap-8">
          <AiInsightSection deal={deal} />
          <DealInfoSection deal={deal} onUpdate={onUpdate} />
          {/* Every file, document link and thread of the deal (all related threads; no Gmail call on open). */}
          <DealFilesSection dealId={deal.id} />
          {deal.source && (
            <div className="pt-4 border-t border-border/30">
              <p className="text-xs text-muted-foreground/40">
                <span className="font-semibold text-muted-foreground/50">Source:</span>{' '}
                {deal.source}
                {deal.source_email_id && (
                  <span className="ml-2 text-muted-foreground/25">
                    · Gmail ID: {deal.source_email_id.slice(0, 12)}…
                  </span>
                )}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Right sidebar */}
      <div className="w-full lg:w-[300px] flex-shrink-0 lg:overflow-y-auto px-4 py-4 sm:px-5 sm:py-6 space-y-5 sm:space-y-6 border-t lg:border-t-0 lg:border-l border-border/30" style={{ background: 'var(--bg-sidebar-2)' }}>
        <TodoListSection
          deal={deal}
          actions={actions}
          loading={loadingActions}
          onActionsChange={onActionsChange}
        />
        <div className="border-t border-border/20 pt-5">
          {/* Links from the deal's own notes / comments / to-dos; the email threads' files and links live in Files & threads. */}
          <LinksMediaSection deal={deal} comments={comments} actions={actions} />
        </div>
        <div className="border-t border-border/20 pt-5">
          <CommentsSection dealId={deal.id} comments={comments} loading={loadingComments} onCommentsChange={onCommentsChange} />
        </div>
      </div>
    </div>
  );
}
