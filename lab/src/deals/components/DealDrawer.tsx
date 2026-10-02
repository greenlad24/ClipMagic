import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from '@/deals/ui/motion';
import { Deal, Comment, Action, fetchComments, fetchActions, apiUpdateDeal } from '@/deals/lib/supabase';
import { getDeal } from '@/deals/api';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { useSync, useSyncRefresh } from '@/deals/context/SyncContext';
import { useEscapeLayer } from '@/deals/lib/escapeLayer';
import { toastArchived } from '@/deals/lib/archive';
import DealDrawerHeader from './DealDrawerHeader';
import DealDrawerBody from './DealDrawerBody';
import MergeDealModal from './MergeDealModal';
import { toast } from 'sonner';

interface DealDrawerProps {
  deal: Deal;
  onClose: () => void;
  onUpdated: (deal: Deal) => void;
  onArchived: (id: string) => void;
  /** Undo of an archive: the deal is back (archived:false). */
  onRestored?: (deal: Deal) => void;
}

export default function DealDrawer({ deal, onClose, onUpdated, onArchived, onRestored }: DealDrawerProps) {
  const { isProductionStage } = useStageLabels();
  const { runSync } = useSync();
  const [current, setCurrent] = useState<Deal>(deal);
  const [comments, setComments] = useState<Comment[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [loadingComments, setLoadingComments] = useState(true);
  const [loadingActions, setLoadingActions] = useState(true);
  const [showMerge, setShowMerge] = useState(false);

  useEffect(() => { setCurrent(deal); }, [deal]);

  useEffect(() => {
    setLoadingComments(true);
    fetchComments(deal.id).then(setComments).finally(() => setLoadingComments(false));
    setLoadingActions(true);
    fetchActions(deal.id).then(setActions).finally(() => setLoadingActions(false));
  }, [deal.id]);

  // Close on Escape — only when this workspace is the top layer (the merge
  // modal, confirm dialogs and menus on top of it take their own Esc).
  useEscapeLayer(onClose);

  /** The ONE write path for every field edit in the workspace. */
  const handleFieldUpdate = useCallback(async (input: Partial<Deal>) => {
    const updates: Partial<Deal> = { ...input };
    // A stage change follows the board's rule: production stages set in_production.
    if (updates.stage && updates.stage !== current.stage) {
      const nowProduction = isProductionStage(updates.stage);
      if (nowProduction !== (current.in_production ?? false)) updates.in_production = nowProduction;
    }
    const optimistic = { ...current, ...updates };
    setCurrent(optimistic);
    try {
      const saved = await apiUpdateDeal(current.id, updates);
      const merged = { ...optimistic, ...saved };
      setCurrent(merged);
      onUpdated(merged);
    } catch {
      toast.error('Failed to save');
      setCurrent(current);
    }
  }, [current, onUpdated, isProductionStage]);

  // "Delete deal" archives (as it always did) — now it says so, with Undo.
  const handleArchive = async () => {
    try {
      await apiUpdateDeal(current.id, { archived: true });
      toastArchived(current, onRestored);
      onArchived(current.id);
      onClose();
    } catch { toast.error('Failed to archive the deal'); }
  };

  const reloadDeal = useCallback(async () => {
    const { deal: refreshed } = await getDeal({ id: current.id });
    const updated = refreshed as Deal;
    setCurrent(updated);
    onUpdated(updated);
  }, [current.id, onUpdated]);

  // The original ran its own targeted scanGmail here. Gmail scanning is now the
  // ONE shared sync: run it, then reload this deal.
  const handleRefresh = useCallback(async () => {
    await runSync();
    await reloadDeal();
  }, [runSync, reloadDeal]);

  // A sync that finishes while the workspace is open (schedule / another page) → fresh data.
  useSyncRefresh(() => { reloadDeal().catch(() => {}); });

  return (
    <>
    <AnimatePresence>
      {/* Backdrop */}
      <motion.div
        key="backdrop"
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />

      {/* Full-screen card workspace */}
      <motion.div
        key="workspace"
        className="fixed inset-0 z-50 flex flex-col overflow-hidden"
        style={{ background: 'var(--bg-shell)' }}
        initial={{ opacity: 0, scale: 0.98, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 12 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        <DealDrawerHeader
          deal={current}
          onClose={onClose}
          onDelete={handleArchive}
          onMerge={() => setShowMerge(true)}
          onUpdate={handleFieldUpdate}
          onRefresh={handleRefresh}
        />
        <DealDrawerBody
          deal={current}
          comments={comments}
          actions={actions}
          loadingComments={loadingComments}
          loadingActions={loadingActions}
          onUpdate={handleFieldUpdate}
          onCommentsChange={setComments}
          onActionsChange={setActions}
        />
      </motion.div>
    </AnimatePresence>

    {showMerge && (
      <MergeDealModal
        currentDeal={current}
        onClose={() => setShowMerge(false)}
        onMerged={updated => {
          setCurrent(updated);
          onUpdated(updated);
        }}
      />
    )}
    </>
  );
}
