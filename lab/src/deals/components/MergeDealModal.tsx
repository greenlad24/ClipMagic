import { useState, useEffect, useRef } from 'react';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { useEscapeLayer } from '@/deals/lib/escapeLayer';
import { formatMoney } from '@/deals/lib/currency';
import { motion, AnimatePresence } from '@/deals/ui/motion';
import { X, Search, Loader2, GitMerge, AlertTriangle } from 'lucide-react';
import { getDeals, mergeDeals, GetDealsOutputType } from '@/deals/api';
import { Deal } from '@/deals/lib/supabase';
import { toast } from 'sonner';
import { Button } from '@/deals/ui/button';

type RawDeal = GetDealsOutputType['deals'][0];

interface Props {
  currentDeal: Deal;
  onClose: () => void;
  onMerged: (updated: Deal) => void;
}

export default function MergeDealModal({ currentDeal, onClose, onMerged }: Props) {
  const [allDeals, setAllDeals] = useState<RawDeal[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<RawDeal | null>(null);
  const [merging, setMerging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { getStageLabel, getStageColor } = useStageLabels();

  useEffect(() => {
    getDeals({}).then(r => {
      // Exclude the current deal
      setAllDeals(r.deals.filter(d => d.id !== currentDeal.id));
    }).catch(() => toast.error('Failed to load deals')).finally(() => setLoading(false));
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [currentDeal.id]);

  // Close on Escape — as the top layer only, so the deal workspace underneath stays open.
  useEscapeLayer(onClose);

  const filtered = allDeals.filter(d => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      d.client_name.toLowerCase().includes(q) ||
      (d.project_name ?? '').toLowerCase().includes(q) ||
      d.client_email.toLowerCase().includes(q)
    );
  });

  const handleMerge = async () => {
    if (!selected) return;
    setMerging(true);
    try {
      const { deal } = await mergeDeals({ keepId: currentDeal.id, mergeId: selected.id });
      toast.success(`Merged with ${selected.client_name} — duplicate archived`);
      onMerged(deal as Deal);
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? 'Merge failed');
    } finally {
      setMerging(false);
    }
  };

  return (
    <AnimatePresence>
      {/* Backdrop */}
      <motion.div
        key="merge-backdrop"
        className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
      />

      {/* Modal */}
      <motion.div
        key="merge-modal"
        className="fixed z-[70] inset-0 flex items-center justify-center p-4 pointer-events-none"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        <div
          className="mobile-modal-card pointer-events-auto w-full max-w-lg rounded-2xl overflow-hidden flex flex-col"
          style={{
            background: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
            maxHeight: '80vh',
          }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between px-5 py-4 border-b border-border flex-shrink-0">
            <div>
              <h2 className="text-[15px] font-bold text-foreground flex items-center gap-2">
                <GitMerge size={15} className="text-primary" /> Merge Deals
              </h2>
              <p className="text-[12px] text-muted-foreground mt-0.5">
                Search for a duplicate deal to merge into <span className="font-semibold text-foreground">{currentDeal.client_name}</span>. The duplicate will be archived.
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground ml-3 flex-shrink-0"
            >
              <X size={14} />
            </button>
          </div>

          {/* Search */}
          <div className="px-4 py-3 border-b border-border flex-shrink-0">
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => { setSearch(e.target.value); setSelected(null); }}
                placeholder="Search by name, email or project…"
                className="w-full h-9 text-sm rounded-lg outline-none bg-muted/50 border border-border focus:border-primary/40 text-foreground"
                style={{ paddingLeft: 32, paddingRight: 12 }}
              />
            </div>
          </div>

          {/* Deal list */}
          <div className="overflow-y-auto flex-1">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 size={18} className="animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                <p className="text-sm">{search ? 'No matching deals found' : 'No other deals'}</p>
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {filtered.slice(0, 30).map(deal => {
                  const stageColor = deal.stage ? getStageColor(deal.stage) : null;
                  const isSelected = selected?.id === deal.id;
                  return (
                    <button
                      key={deal.id}
                      onClick={() => setSelected(isSelected ? null : deal)}
                      className="w-full text-left rounded-xl px-3 py-2.5 transition-all flex items-center gap-3"
                      style={{
                        background: isSelected ? 'hsl(var(--primary) / 0.08)' : 'transparent',
                        border: isSelected ? '1px solid hsl(var(--primary) / 0.3)' : '1px solid transparent',
                      }}
                    >
                      {/* Stage dot */}
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-0.5"
                        style={{ background: stageColor ?? 'hsl(var(--border))' }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-foreground truncate">{deal.client_name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {deal.project_name ?? deal.client_email}
                        </p>
                      </div>
                      {deal.estimated_value != null && (
                        <span className="text-[12px] font-semibold text-muted-foreground flex-shrink-0">
                          {formatMoney(deal.estimated_value, deal.currency)}
                        </span>
                      )}
                      {deal.stage && stageColor && (
                        <span
                          className="text-[10px] font-medium px-2 py-0.5 rounded-full flex-shrink-0 max-w-[120px] truncate"
                          style={{
                            background: `color-mix(in hsl, ${stageColor} 12%, transparent)`,
                            color: stageColor,
                          }}
                          title={getStageLabel(deal.stage, deal.stage)}
                        >
                          {getStageLabel(deal.stage, deal.stage)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Confirm / footer */}
          {selected && (
            <div
              className="flex-shrink-0 border-t border-border px-4 py-3"
              style={{ background: 'hsl(var(--muted) / 0.4)' }}
            >
              <div className="flex items-start gap-2 mb-3">
                <AlertTriangle size={13} className="text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-[12px] text-muted-foreground">
                  <span className="font-semibold text-foreground">{selected.client_name}</span> will be archived. All its data (emails, notes, value) will be merged into <span className="font-semibold text-foreground">{currentDeal.client_name}</span>.
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1 h-8 text-xs" onClick={() => setSelected(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-8 text-xs gap-1.5"
                  disabled={merging}
                  onClick={handleMerge}
                >
                  {merging ? <Loader2 size={11} className="animate-spin" /> : <GitMerge size={11} />}
                  {merging ? 'Merging…' : 'Confirm Merge'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
