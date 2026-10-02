import { useState } from 'react';
import { Deal } from '@/deals/lib/supabase';
import { sc } from '@/deals/lib/stages';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { MessageSquare, CheckSquare, MoreHorizontal, Edit2, MoveRight, Archive, Paperclip } from 'lucide-react';
import { useDealFileCount } from '@/deals/apiFiles';
import { motion } from '@/deals/ui/motion';
import { TOUCH_ONLY } from '@/deals/lib/boardDnd';
import { isIsoDate, formatDeadline, dealDeadlineYmd, formatDeadlineChip } from '@/deals/lib/deadline';
import { useDealFocus } from '@/deals/apiFocus';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/deals/ui/dropdown-menu';

interface DealCardProps {
  deal: Deal;
  layoutId?: string;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  /** Touch drag (long-press), see lib/boardDnd.ts. */
  onTouchStart?: (e: React.TouchEvent<HTMLElement>) => void;
  onMoveToStage?: (stage: string) => void;
  onArchive?: () => void;
}

const CONF: Record<string, { label: string; cssVar: string }> = {
  high:   { label: 'High',   cssVar: 'payment' },
  medium: { label: 'Medium', cssVar: 'invoice' },
  low:    { label: 'Low',    cssVar: 'rejected' },
};

/** Focus grade badge (agent/focus.ts): A = best fit, right price, easy — the follow-ups go there first. */
const FOCUS_STYLE: Record<string, React.CSSProperties> = {
  A: { background: 'var(--pill-green-bg)', color: 'var(--pill-green-text)' },
  B: { background: 'var(--pill-orange-bg)', color: 'var(--pill-orange-text)' },
  C: { background: 'var(--pill-gray-bg)', color: 'var(--pill-gray-text)' },
};

const GENERIC_DOMAINS = ['gmail', 'yahoo', 'outlook', 'hotmail', 'icloud', 'protonmail', 'me'];

function extractCompanyName(email: string): string {
  const domain = email.split('@')[1] ?? '';
  const base = domain.split('.')[0] ?? '';
  if (GENERIC_DOMAINS.includes(base.toLowerCase())) {
    return email.length > 24 ? email.slice(0, 24) + '…' : email;
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const MONTH_ABBR: Record<string, string> = {
  january: 'Jan', february: 'Feb', march: 'Mar', april: 'Apr',
  may: 'May', june: 'Jun', july: 'Jul', august: 'Aug',
  september: 'Sep', october: 'Oct', november: 'Nov', december: 'Dec',
};

// Filler prefixes to strip from the start
const FILLER_PREFIX = /^(publishing window|sponsor window|campaign window|deal window|deadline[:\s]+|target[:\s]+|goal[:\s]+|window[:\s]+|by\s+|before\s+|no later than\s+|end of\s+|start of\s+|beginning of\s+|around\s+|approx\.?\s+|approximately\s+|from\s+|starting\s+|launching?\s+)\s*/i;

function shortenDeadline(s: string): string {
  if (isIsoDate(s)) return formatDeadline(s); // a picked date: "Oct 15"
  let r = s.trim();

  // Strip filler prefixes repeatedly
  let prev = '';
  while (prev !== r) { prev = r; r = r.replace(FILLER_PREFIX, ''); }

  // Abbreviate full month names
  for (const [full, abbr] of Object.entries(MONTH_ABBR)) {
    r = r.replace(new RegExp(`\\b${full}\\b`, 'gi'), abbr);
  }

  // Normalize "and onward/beyond/onwards/later" → "& onward"
  r = r.replace(/\band\s+(onward|onwards|beyond|later)\b/gi, '& onward');
  // "or later" / "or beyond" → "& onward"
  r = r.replace(/\bor\s+(later|beyond|onwards?)\b/gi, '& onward');
  // Standalone "and" → "&"
  r = r.replace(/\band\b/gi, '&');

  // Strip trailing year if result would still be > 3 tokens without it
  const tokens = r.trim().split(/\s+/);
  if (tokens.length > 3) {
    // Try removing year tokens (4-digit numbers)
    const withoutYear = tokens.filter(t => !/^\d{4}$/.test(t));
    if (withoutYear.length <= 3) r = withoutYear.join(' ');
    else r = withoutYear.slice(0, 3).join(' '); // hard cap
  }

  return r.trim() || s;
}

function extractNextSteps(nextSteps: string | null | undefined, description: string | null | undefined): string {
  if (nextSteps?.trim()) return nextSteps.trim();
  if (!description) return 'No next steps yet';
  const match = description.match(/\*\*Next Steps:\*\*\s*(.+?)(?=\n\n|\*\*|$)/s);
  return match?.[1]?.trim() ?? 'Review this deal';
}

export default function DealCard({ deal, layoutId, onClick, onDragStart, onDragEnd, onTouchStart, onMoveToStage, onArchive }: DealCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const { getStageLabel, getStageColor, dealStageKeys, productionStageKeys } = useStageLabels();

  const commentCount = deal.comment_count ?? 0;
  const actionCount  = deal.action_count ?? 0;
  const fileCount    = useDealFileCount(deal.id);
  const focus        = useDealFocus(deal.id);
  const deadlineYmd  = deal.deadline ? dealDeadlineYmd(deal) : null;
  const deadlineChip = deadlineYmd && !isIsoDate((deal.deadline ?? '').trim()) ? formatDeadlineChip(deadlineYmd) : '';
  const stageAccent = getStageColor(deal.stage ?? '');
  const confStyle   = deal.confidence ? CONF[deal.confidence] : null;
  const isNew = deal.stage === 'new_requests' && deal.source === 'gmail';
  const company = extractCompanyName(deal.client_email);
  const nextSteps = extractNextSteps(deal.next_steps, deal.description);

  return (
    <div
      draggable={!TOUCH_ONLY}
      onDragStart={e => { setIsDragging(true); onDragStart(e); }}
      onDragEnd={e => { setIsDragging(false); onDragEnd?.(e); }}
      onTouchStart={onTouchStart}
      onClick={onClick}
      className="relative cursor-pointer select-none group"
      style={{ WebkitTouchCallout: 'none' }}
    >
    <motion.div
      layoutId={layoutId}
      whileHover={{ y: -2, boxShadow: '0 6px 20px rgba(0,0,0,0.10)' }}
      animate={{ opacity: isDragging ? 0.35 : 1 }}
      transition={{ duration: 0.15 }}
      className="relative"
      style={{
        background: 'hsl(var(--card))',
        border: '1px solid hsl(var(--border))',
        borderLeft: `4px solid ${stageAccent}`,
        borderRadius: 10,
        boxShadow: '0 1px 6px rgba(0,0,0,0.05)',
      }}
    >
      {/* NEW badge */}
      {isNew && !menuOpen && (
        <motion.span
          className="absolute top-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white badge-pulse z-10 pointer-events-none"
          style={{ background: sc('new-requests') }}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
        >
          NEW
        </motion.span>
      )}

      {/* Three-dot menu */}
      <div
        className={`absolute top-1.5 right-1.5 z-20 transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        onClick={e => e.stopPropagation()}
      >
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground/60 hover:bg-muted hover:text-foreground transition-colors">
              <MoreHorizontal size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onClick}><Edit2 size={13} className="mr-2" /> Edit</DropdownMenuItem>
            {onMoveToStage && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><MoveRight size={13} className="mr-2" /> Move to</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                  {[...dealStageKeys, ...productionStageKeys].filter(k => k !== deal.stage).map(k => (
                    <DropdownMenuItem key={k} onClick={() => onMoveToStage(k)}>
                      <span className="w-2 h-2 rounded-full mr-2 flex-shrink-0" style={{ background: getStageColor(k) }} />
                      {getStageLabel(k, k)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {onArchive && (
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onArchive}>
                <Archive size={13} className="mr-2" /> Archive
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content */}
      <div style={{ padding: '12px 12px 12px 10px' }}>
        {/* Line 1: client name */}
        <p className="font-semibold text-[14px] text-foreground leading-snug pr-6">{deal.client_name}</p>

        {/* Line 2: company name */}
        <p className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>{company}</p>

        {/* Line 3: next steps */}
        <p className="text-[12px] mt-1.5 line-clamp-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <span className="mr-1">→</span>{nextSteps}
        </p>

        {/* Bottom row */}
        <div className="flex items-center justify-between mt-2 gap-1">
          <div className="flex items-center gap-1 min-w-0 flex-wrap">
            {deal.deadline ? (
              <>
                <span
                  className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                  title={deal.deadline}
                  style={{ background: 'hsl(var(--muted))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground) / 0.65)' }}
                >
                  📅 {shortenDeadline(deal.deadline)}
                </span>
                {deadlineChip && deadlineChip !== shortenDeadline(deal.deadline) && (
                  <span className="text-[10px] whitespace-nowrap" title={`Read as ${deadlineYmd}`} style={{ color: 'var(--text-muted)' }}>
                    → {deadlineChip}
                  </span>
                )}
              </>
            ) : (
              <span
                className="text-[11px] px-2 py-0.5 rounded-full"
                style={{ background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground) / 0.35)', border: '1px dashed hsl(var(--border))' }}
              >
                No deadline
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {focus && (
              <span
                className="text-[10px] font-bold leading-none px-1.5 py-[3px] rounded-md"
                title={focus.reason}
                style={FOCUS_STYLE[focus.grade] ?? FOCUS_STYLE.C}
              >
                {focus.grade}
              </span>
            )}
            {fileCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/40" title={`${fileCount} file${fileCount === 1 ? '' : 's'} & document link${fileCount === 1 ? '' : 's'} across this deal's threads`}>
                <Paperclip size={10} />{fileCount}
              </span>
            )}
            {commentCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/40">
                <MessageSquare size={10} />{commentCount}
              </span>
            )}
            {actionCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/40">
                <CheckSquare size={10} />{actionCount}
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
    </div>
  );
}
