import { useState, useRef } from 'react';
import { Deal } from '@/deals/lib/supabase';
import DealCard from './DealCard';
import { Plus, GripVertical, Pencil, Trash2 } from 'lucide-react';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { TOUCH_ONLY, type BoardDnd } from '@/deals/lib/boardDnd';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/deals/ui/alert-dialog';

interface KanbanColumnProps {
  stage: string;
  label: string;
  accent: string;
  deals: Deal[];
  /** The board's drag-and-drop controller (mouse + touch), see lib/boardDnd.ts. */
  dnd: BoardDnd<Deal>;
  onCardClick: (deal: Deal) => void;
  onAddDeal: () => void;
  /** Optional: told after a rename; the rename itself is written once, here. */
  onRename?: (newLabel: string) => void;
  onMoveCard?: (deal: Deal, stage: string) => void;
  onArchiveCard?: (deal: Deal) => void;
  onDeleteStage?: (stageKey: string) => Promise<void>;
}

export default function KanbanColumn({
  stage, label, accent, deals, dnd,
  onCardClick, onAddDeal, onRename, onMoveCard, onArchiveCard, onDeleteStage,
}: KanbanColumnProps) {
  const { getStageLabel, setStageLabel } = useStageLabels();
  const displayLabel = getStageLabel(stage, label);
  const isDragOver = dnd.dragType === 'card' && dnd.overStage === stage;
  const isColumnTarget = dnd.dragType === 'column' && dnd.overStage === stage;

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(displayLabel);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = () => {
    setRenameValue(displayLabel);
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 30);
  };

  const commitRename = () => {
    setRenaming(false);
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== displayLabel) {
      // ONE write: the original also called onRename → setStageLabel again, so
      // every rename hit renameStage twice.
      setStageLabel(stage, trimmed);
      onRename?.(trimmed);
    } else {
      setRenameValue(displayLabel);
    }
  };

  const handleDelete = async () => {
    if (!onDeleteStage) return;
    setDeleting(true);
    try {
      await onDeleteStage(stage);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <div
        className="flex flex-col flex-shrink-0"
        style={{ minWidth: 230, width: 230 }}
        data-stage={stage}
        onDragOver={dnd.columnDragOver(stage)}
        onDrop={dnd.columnDrop(stage)}
      >
        <div
          className="flex flex-col flex-1 overflow-hidden bg-card"
          style={{
            borderRadius: 12, border: '1px solid var(--border-color)', boxShadow: 'var(--shadow-card)',
            outline: isColumnTarget ? `2px dashed ${accent}` : 'none', outlineOffset: 2,
          }}
        >
          {/* Top accent stripe */}
          <div className="h-[3px] flex-shrink-0 rounded-tl-xl rounded-tr-xl" style={{ background: accent }} />

          {/* Header */}
          <div
            className="px-[14px] pt-[12px] pb-[10px] flex items-center gap-1.5 group/hdr cursor-grab active:cursor-grabbing border-b border-border/40 bg-card flex-shrink-0 select-none"
            style={{ WebkitTouchCallout: 'none' }}
            draggable={!TOUCH_ONLY && !renaming}
            onDragStart={dnd.columnDragStart(stage)}
            onDragEnd={dnd.dragEnd}
            onTouchStart={renaming ? undefined : dnd.columnTouchStart(stage)}
          >
            <GripVertical size={13} className="text-muted-foreground/25 opacity-0 group-hover/hdr:opacity-100 transition-opacity flex-shrink-0 -ml-1" />

            <div className="flex-1 min-w-0 flex items-center gap-1">
              {renaming ? (
                <input
                  ref={inputRef}
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') { setRenaming(false); setRenameValue(displayLabel); }
                  }}
                  onClick={e => e.stopPropagation()}
                  className="text-[13px] font-semibold text-foreground bg-transparent border-b-2 border-primary outline-none w-full py-0.5 uppercase tracking-[0.04em]"
                />
              ) : (
                <span
                  className="text-[13px] font-semibold text-foreground truncate uppercase tracking-[0.04em]"
                  onDoubleClick={e => { e.stopPropagation(); startRename(); }}
                  title={displayLabel}
                >
                  {displayLabel}
                </span>
              )}

              {/* Rename button */}
              <button
                onClick={e => { e.stopPropagation(); startRename(); }}
                className="opacity-0 group-hover/hdr:opacity-50 hover:!opacity-100 transition-opacity flex-shrink-0 p-0.5 rounded"
                title="Rename stage"
              >
                <Pencil size={10} className="text-muted-foreground" />
              </button>

              {/* Delete button */}
              {onDeleteStage && (
                <button
                  onClick={e => { e.stopPropagation(); setConfirmDelete(true); }}
                  className="opacity-0 group-hover/hdr:opacity-40 hover:!opacity-100 transition-opacity flex-shrink-0 p-0.5 rounded hover:text-destructive"
                  title="Delete stage"
                >
                  <Trash2 size={10} className="text-muted-foreground hover:text-destructive" />
                </button>
              )}
            </div>

            {/* Count badge */}
            <span
              className="text-[12px] font-bold w-6 h-6 rounded-full flex items-center justify-center text-white flex-shrink-0"
              style={{ background: accent }}
            >
              {deals.length}
            </span>
          </div>

          {/* Cards area */}
          <div className="flex-1 flex flex-col gap-[10px] p-[10px] min-h-[80px]">
            {deals.map(deal => (
              <DealCard
                key={deal.id}
                layoutId={`card-${deal.id}`}
                deal={deal}
                onClick={() => { if (!dnd.clickSuppressed()) onCardClick(deal); }}
                onDragStart={dnd.cardDragStart(deal)}
                onDragEnd={dnd.dragEnd}
                onTouchStart={dnd.cardTouchStart(deal)}
                onMoveToStage={onMoveCard ? (s: string) => onMoveCard(deal, s) : undefined}
                onArchive={onArchiveCard ? () => onArchiveCard(deal) : undefined}
              />
            ))}

            {isDragOver && (
              <div
                className="rounded-[10px] min-h-[72px] flex items-center justify-center transition-all"
                style={{
                  background: `color-mix(in srgb, ${accent} 8%, transparent)`,
                  border: `2px dashed ${accent}`,
                  opacity: 0.8,
                }}
              >
                <span className="text-xs font-medium" style={{ color: accent }}>Drop here</span>
              </div>
            )}

            {deals.length === 0 && !isDragOver && (
              <div className="flex-1 flex items-center justify-center min-h-[60px]">
                <span className="text-xs text-muted-foreground/25">Empty</span>
              </div>
            )}
          </div>

          {/* Add deal */}
          <button
            onClick={onAddDeal}
            className="flex items-center justify-center gap-1.5 py-2.5 text-xs text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/20 transition-colors border-t border-border/40 flex-shrink-0"
          >
            <Plus size={12} /> Add deal
          </button>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{displayLabel}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {deals.length > 0
                ? `This stage has ${deals.length} deal${deals.length !== 1 ? 's' : ''}. ${deals.length !== 1 ? 'They' : 'It'} will be moved to the next available stage automatically.`
                : 'This stage is empty and will be permanently removed.'}
              {' '}This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Delete Stage'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
