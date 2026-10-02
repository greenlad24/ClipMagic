/**
 * "Delete deal" has always ARCHIVED (updateDeal archived:true) — the original
 * toast said "Deal deleted". Say what happened, and offer Undo
 * (updateDeal archived:false puts it back).
 */
import { toast } from 'sonner';
import { updateDeal } from '@/deals/api';
import type { Deal } from './supabase';

export function toastArchived(deal: Deal, onRestored?: (deal: Deal) => void) {
  toast('Deal archived', {
    description: `${deal.client_name} was moved to the archive.`,
    duration: 8000,
    action: {
      label: 'Undo',
      onClick: async () => {
        try {
          const { deal: restored } = await updateDeal({ id: deal.id, updates: { archived: false } });
          onRestored?.({ ...deal, ...(restored as Partial<Deal>), archived: false } as Deal);
          toast.success('Deal restored');
        } catch {
          toast.error('Could not restore the deal');
        }
      },
    },
  });
}
