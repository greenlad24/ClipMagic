import { Check, X, MessageSquare, PenLine } from 'lucide-react';
import { LookupThreadOutputType } from '@/deals/api';
import ThreadMessages from './ThreadMessages';

type ThreadMatch = LookupThreadOutputType['matches'][0];

function timeAgo(iso: string | null): string {
  if (!iso) return 'unknown';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return `${months} months ago`;
}

interface Props {
  match: ThreadMatch;
  onApprove: () => void;
  onReject: () => void;
  onBack?: () => void;  // go back to thread list (when coming from multi_match)
}

export default function ThreadPreviewCard({ match, onApprove, onReject, onBack }: Props) {
  return (
    <div className="border border-border rounded-xl bg-card p-4 space-y-3">
      {/* Back link */}
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors -mt-1"
        >
          ← Back to thread list
        </button>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">
            {match.projectName || match.clientName}
          </p>
          <p className="text-xs text-muted-foreground">
            {match.clientName} · {match.toEmail}
          </p>
        </div>
        {match.stage && (
          <span className="flex-shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-accent text-accent-foreground font-medium whitespace-nowrap">
            {match.stage}
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <MessageSquare size={10} />
          {match.messageCount} messages ({match.myMessageCount} from me, {match.theirMessageCount} from them)
        </span>
        <span className={match.lastMessageIsDraft ? 'text-amber-700 [.dealorg-dark_&]:text-amber-500 flex items-center gap-1' : ''}>
          {match.lastMessageIsDraft && <PenLine size={10} />}
          Last: {match.lastMessageIsDraft ? 'Draft (unsent)' : match.lastMessageFrom}, {timeAgo(match.lastMessageDate)}
        </span>
      </div>

      {/* Full thread */}
      <ThreadMessages threadId={match.threadId} />

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={onApprove}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Check size={12} /> Yes, draft reply
        </button>
        <button
          onClick={onReject}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted transition-colors"
        >
          <X size={12} /> No, search again
        </button>
      </div>
    </div>
  );
}
