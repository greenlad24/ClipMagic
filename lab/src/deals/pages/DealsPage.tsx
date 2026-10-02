import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Button } from '@/deals/ui/button';
import { Skeleton } from '@/deals/ui/skeleton';
import { toast } from 'sonner';
import { Plus, Terminal, Search, Sun, Moon, X, Check, ChevronRight } from 'lucide-react';
import { useTheme } from '@/deals/context/ThemeContext';
import { Deal, Stage } from '@/deals/lib/supabase';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { getDeals, updateDeal, syncSteps } from '@/deals/api';
import { loadDealFileCounts } from '@/deals/apiFiles';
import { LayoutGroup } from '@/deals/ui/motion';
import KanbanColumn from '@/deals/components/KanbanColumn';
import DealDrawer from '@/deals/components/DealDrawer';
import AddDealModal from '@/deals/components/AddDealModal';
import LogsPanel from '@/deals/components/LogsPanel';
import { SyncNowButton, SyncIndicator } from '@/deals/components/SyncControls';
import { useSync, useSyncRefresh } from '@/deals/context/SyncContext';
import { useBoardDnd } from '@/deals/lib/boardDnd';
import { useSearchHotkey, SEARCH_HOTKEY_LABEL } from '@/deals/lib/useSearchHotkey';
import { toastArchived } from '@/deals/lib/archive';

interface ScanMeta { scanned: number; created: number; updated: number; nonDeals: number; errored: number; runAt: number; }

// ─── Section Divider ──────────────────────────────────────────────────────────

function PipelineDivider({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-start self-stretch mx-1" style={{ minWidth: 28 }}>
      <div className="flex flex-col items-center gap-1.5 pt-3">
        <div className="w-px flex-1" style={{ background: 'hsl(var(--border) / 0.6)', minHeight: 40 }} />
        <div className="flex flex-col items-center gap-1" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground/30 whitespace-nowrap">{label}</span>
        </div>
        <ChevronRight size={10} className="text-muted-foreground/25 -rotate-90" />
      </div>
    </div>
  );
}

// ─── Insert Zone ─────────────────────────────────────────────────────────────

interface InsertZoneProps {
  active: boolean;
  stageName: string;
  onActivate: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onNameChange: (v: string) => void;
}

function InsertZone({ active, stageName, onActivate, onConfirm, onCancel, onNameChange }: InsertZoneProps) {
  const [hovered, setHovered] = useState(false);

  if (active) {
    return (
      <div style={{ minWidth: 230, width: 230, flexShrink: 0, margin: '0 7px', background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="text-[12px] font-semibold text-foreground uppercase tracking-widest mb-1">Insert Stage</p>
        <input
          autoFocus value={stageName} onChange={e => onNameChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }}
          placeholder="Stage name…"
          className="h-8 px-2.5 text-sm bg-muted/40 border border-border rounded-lg outline-none focus:border-primary/40 text-foreground"
        />
        <div className="flex gap-1.5">
          <button onClick={onConfirm} className="flex-1 h-7 rounded-lg bg-primary text-primary-foreground text-xs font-semibold flex items-center justify-center gap-1 hover:opacity-90 transition-opacity">
            <Check size={11} /> Insert
          </button>
          <button onClick={onCancel} className="h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors">
            <X size={11} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onClick={onActivate} title="Insert stage here"
      style={{ width: hovered ? 48 : 16, flexShrink: 0, transition: 'width 0.2s ease', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', position: 'relative', alignSelf: 'stretch' }}
    >
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 2, transform: 'translateX(-50%)', borderRadius: 2, background: 'hsl(var(--primary) / 0.35)', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s ease' }} />
      <div style={{ position: 'relative', width: 30, height: 30, borderRadius: '50%', background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: hovered ? 1 : 0, transform: hovered ? 'scale(1)' : 'scale(0.5)', transition: 'opacity 0.15s ease, transform 0.2s ease', boxShadow: '0 2px 8px hsl(var(--primary) / 0.4)', flexShrink: 0 }}>
        <Plus size={15} strokeWidth={2.5} />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function DealsPage() {
  const { dealId } = useParams<{ dealId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Deal | null>(null);
  const [addStage, setAddStage] = useState<Stage | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [addingStage, setAddingStage] = useState(false);
  const [newStageName, setNewStageName] = useState('');
  const [insertingAtIndex, setInsertingAtIndex] = useState<number | null>(null);
  const [insertStageName, setInsertStageName] = useState('');
  const [insertingInGroup, setInsertingInGroup] = useState<'deal' | 'production'>('deal');

  const searchRef = useRef<HTMLInputElement>(null);
  const sync = useSync();

  // ── Single source of truth: context ────────────────────────────────────────
  const { dealStageKeys, productionStageKeys, getStageLabel, getStageColor, addStage: ctxAddStage, reorderStageKeys, removeStage, isLoaded } = useStageLabels();

  const productionStageSet = useMemo(() => new Set(productionStageKeys), [productionStageKeys]);

  const load = useCallback(async () => {
    try {
      const result = await getDeals({});
      setDeals(result.deals as Deal[]);
      loadDealFileCounts(); // 📎 badges: one batch call per board load (SQL only)
    }
    catch { toast.error('Failed to load deals'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  // The Gmail sync is ONE server job (twice a day with the agent, or "Sync now");
  // the board just reloads when a run finishes. Nothing here starts a scan.
  useSyncRefresh(load);

  // The URL is the source of truth for the open deal: /deal-organizer/deals/:id.
  useEffect(() => {
    if (!dealId) { if (selected) setSelected(null); return; } // e.g. the Back button
    if (loading || deals.length === 0) return;
    if (selected?.id === dealId) return;
    const deal = deals.find(d => d.id === dealId);
    if (deal) setSelected(deal);
  }, [dealId, deals, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDeal = (deal: Deal) => {
    setSelected(deal);
    if (dealId !== deal.id) navigate(`/deal-organizer/deals/${deal.id}${location.search}`);
  };
  const closeDeal = () => {
    setSelected(null);
    if (dealId) navigate(`/deal-organizer/deals${location.search}`, { replace: true });
  };

  useSearchHotkey(searchRef, !selected);

  const applyStageMove = async (deal: Deal, targetStage: string) => {
    if (deal.stage === targetStage) return;
    const isNowProduction = productionStageSet.has(targetStage);
    const wasProduction = deal.in_production ?? false;
    const inProductionChanged = isNowProduction !== wasProduction;

    const prev = deals;
    setDeals(d => d.map(x => x.id === deal.id ? { ...x, stage: targetStage as Stage, in_production: isNowProduction } : x));
    toast.success(`Moved to ${getStageLabel(targetStage, targetStage)}`, { duration: 3000 });

    try {
      const updates: { stage: string; in_production?: boolean } = { stage: targetStage };
      if (inProductionChanged) updates.in_production = isNowProduction;
      await updateDeal({ id: deal.id, updates });
    } catch {
      setDeals(prev);
      toast.error('Failed to update stage');
    }
  };

  const handleColumnDrop = (from: string, targetStage: string) => {
    const fromIsProduction = productionStageSet.has(from);
    const toIsProduction = productionStageSet.has(targetStage);
    // Only reorder within the same group
    if (fromIsProduction !== toIsProduction) { toast('Stages can only be reordered within their own group'); return; }
    const groupKeys = fromIsProduction ? productionStageKeys : dealStageKeys;
    const next = [...groupKeys];
    const fi = next.indexOf(from), ti = next.indexOf(targetStage);
    if (fi !== -1 && ti !== -1) {
      next.splice(fi, 1);
      next.splice(ti, 0, from);
      reorderStageKeys(next);
    }
  };

  // Mouse (HTML5) + touch (long-press) drag-and-drop, see lib/boardDnd.ts.
  const dnd = useBoardDnd<Deal>({
    onCardDrop: (deal, stage) => { void applyStageMove(deal, stage); },
    onColumnDrop: handleColumnDrop,
  });

  const handleMoveCard = async (deal: Deal, stage: string) => {
    await applyStageMove(deal, stage);
  };

  const handleDeleteStage = async (stageKey: string) => {
    try {
      const { fallbackStageKey, reassignedCount } = await removeStage(stageKey);
      if (reassignedCount > 0 && fallbackStageKey) {
        // Update local deals to reflect reassignment
        const fallbackLabel = getStageLabel(fallbackStageKey, fallbackStageKey);
        setDeals(d => d.map(x => x.stage === stageKey ? { ...x, stage: fallbackStageKey as Stage } : x));
        toast(`Stage deleted — ${reassignedCount} deal${reassignedCount !== 1 ? 's' : ''} moved to "${fallbackLabel}"`);
      } else {
        toast('Stage deleted');
      }
    } catch {
      toast.error('Failed to delete stage');
    }
  };

  const restoreDeal = (deal: Deal) => setDeals(ds => ds.some(x => x.id === deal.id) ? ds : [deal, ...ds]);

  const handleArchiveCard = async (deal: Deal) => {
    setDeals(d => d.filter(x => x.id !== deal.id));
    try {
      await updateDeal({ id: deal.id, updates: { archived: true } });
      toastArchived(deal, restoreDeal);
    }
    catch { load(); toast.error('Failed to archive deal'); }
  };

  const handleAddStage = (isProduction: boolean) => {
    const name = newStageName.trim();
    if (!name) return;
    const value = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    const groupKeys = isProduction ? productionStageKeys : dealStageKeys;
    if (groupKeys.includes(value)) { toast.error('A stage with that name already exists'); return; }
    ctxAddStage(name, isProduction, groupKeys.length);
    setNewStageName('');
    setAddingStage(false);
    toast.success(`Stage "${name}" added to ${isProduction ? 'Production' : 'Deals'}`);
  };

  const handleInsertStage = (atIndex: number, isProduction: boolean) => {
    const name = insertStageName.trim();
    if (!name) return;
    const value = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    const groupKeys = isProduction ? productionStageKeys : dealStageKeys;
    if (groupKeys.includes(value)) { toast.error('A stage with that name already exists'); return; }
    ctxAddStage(name, isProduction, atIndex);
    setInsertStageName('');
    setInsertingAtIndex(null);
    toast.success(`Stage "${name}" inserted`);
  };

  const cancelInsert = () => { setInsertingAtIndex(null); setInsertStageName(''); };

  const { theme, toggleTheme } = useTheme();

  const filteredDeals = searchQuery.trim()
    ? deals.filter(d => {
        const q = searchQuery.toLowerCase();
        return d.client_name.toLowerCase().includes(q) || (d.project_name ?? '').toLowerCase().includes(q) || d.client_email.toLowerCase().includes(q);
      })
    : deals;

  const scanLogs = sync.log;
  const errCount  = scanLogs.filter(l => l.level === 'error').length;
  const warnCount = scanLogs.filter(l => l.level === 'warn').length;
  // Deal-scan counts from the last sync, when the server reports them.
  const lastRun = sync.status?.last ?? null;
  const scanCounts = syncSteps(lastRun).find(st => st.step === 'scan' || st.step === 'scanGmail')?.counts;
  const scanMeta: ScanMeta | null = lastRun && scanCounts ? {
    scanned: scanCounts.scanned ?? 0, created: scanCounts.created ?? 0, updated: scanCounts.updated ?? 0,
    nonDeals: scanCounts.nonDeals ?? 0, errored: scanCounts.errored ?? 0,
    runAt: Date.parse(lastRun.finishedAt ?? lastRun.startedAt) || Date.now(),
  } : null;

  // Build a unified column list with group metadata
  type ColItem = { stageValue: string; isProduction: boolean; idxInGroup: number; groupSize: number };
  const dealCols: ColItem[] = dealStageKeys.map((k, i) => ({ stageValue: k, isProduction: false, idxInGroup: i, groupSize: dealStageKeys.length }));
  const prodCols: ColItem[] = productionStageKeys.map((k, i) => ({ stageValue: k, isProduction: true, idxInGroup: i, groupSize: productionStageKeys.length }));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar */}
      <div className="glass-nav flex-shrink-0 px-6 flex items-center gap-4" style={{ height: 60 }}>
        <h1 className="text-[20px] font-bold text-foreground shrink-0">Deals</h1>

        <div className="relative ml-4 mobile-search-wrap" style={{ width: 300 }}>
          <Search size={16} className="absolute left-[14px] top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          <input
            ref={searchRef}
            type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setSearchQuery(''); e.currentTarget.blur(); } }}
            placeholder="Search deals..."
            className="w-full h-10 text-sm bg-card border border-border rounded-[10px] outline-none focus:border-primary/40 transition-all"
            style={{ paddingLeft: 42, paddingRight: 52, color: 'hsl(var(--foreground))' }}
          />
          <span className="search-cmd-badge absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold rounded-[6px]"
            style={{ background: 'hsl(var(--primary) / 0.10)', color: 'hsl(var(--primary))', padding: '2px 6px' }}>
            {SEARCH_HOTKEY_LABEL}
          </span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Button variant="ghost" size="sm" onClick={toggleTheme} className="h-9 w-9 p-0 text-muted-foreground"
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}>
            {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
          </Button>

          <Button variant="ghost" size="sm" onClick={() => setLogsOpen(true)} className="h-9 px-2.5 text-xs text-muted-foreground gap-1.5 relative">
            <Terminal size={13} />
            <span className="hidden sm:inline">Logs</span>
            {errCount > 0 && <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] flex items-center justify-center font-bold">{errCount > 9 ? '9+' : errCount}</span>}
            {errCount === 0 && warnCount > 0 && <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full text-white text-[9px] flex items-center justify-center font-bold" style={{ background: 'hsl(var(--primary))' }}>{warnCount > 9 ? '9+' : warnCount}</span>}
          </Button>

          <div className="flex flex-col items-end min-w-0">
            <SyncNowButton />
            <SyncIndicator className="hidden md:inline-flex mt-0.5 max-w-[320px] text-[10px]" />
          </div>

          <Button size="sm" onClick={() => setAddStage('new_requests')} variant="outline"
            className="h-9 text-[14px] font-semibold gap-1.5 border-border rounded-[8px] px-3 sm:px-[14px] bg-card">
            <Plus size={14} /> <span className="hidden sm:inline">New Deal</span>
          </Button>
        </div>
      </div>

      {/* Kanban board */}
      <div ref={dnd.boardRef} className="kanban-board-area flex-1 overflow-x-auto bg-background" style={{ padding: '20px 24px' }}>
        {loading || !isLoaded ? (
          <div className="flex gap-[14px]">
            {[...Array(10)].map((_, i) => (
              <div key={i} style={{ minWidth: 230, width: 230 }} className="space-y-3 flex-shrink-0">
                <Skeleton className="h-10 w-full rounded-xl" />
                {[1, 2, 3].map(j => <Skeleton key={j} className="h-20 w-full rounded-xl" />)}
              </div>
            ))}
          </div>
        ) : (
          <LayoutGroup>
            <div className="flex items-start" style={{ minWidth: 'max-content' }}>

              {/* ── Deal Stages ── */}
              {dealCols.map((col, globalIdx) => {
                const { stageValue, idxInGroup } = col;
                const label = getStageLabel(stageValue, stageValue);
                const accent = getStageColor(stageValue);
                return (
                  <div key={stageValue} className="flex items-start">
                    {idxInGroup > 0 && (
                      <InsertZone
                        active={insertingAtIndex === globalIdx && insertingInGroup === 'deal'}
                        stageName={insertStageName}
                        onActivate={() => { cancelInsert(); setInsertingAtIndex(globalIdx); setInsertingInGroup('deal'); }}
                        onConfirm={() => handleInsertStage(idxInGroup, false)}
                        onCancel={cancelInsert}
                        onNameChange={setInsertStageName}
                      />
                    )}
                    <KanbanColumn
                      stage={stageValue} label={label} accent={accent}
                      deals={filteredDeals.filter(d => d.stage === stageValue)}
                      dnd={dnd}
                      onCardClick={openDeal}
                      onAddDeal={() => setAddStage(stageValue as Stage)}
                      onMoveCard={handleMoveCard}
                      onArchiveCard={handleArchiveCard}
                      onDeleteStage={handleDeleteStage}
                    />
                  </div>
                );
              })}

              {/* Insert zone at end of deal stages */}
              {dealStageKeys.length > 0 && (
                <InsertZone
                  active={insertingAtIndex === dealStageKeys.length && insertingInGroup === 'deal'}
                  stageName={insertStageName}
                  onActivate={() => { cancelInsert(); setInsertingAtIndex(dealStageKeys.length); setInsertingInGroup('deal'); }}
                  onConfirm={() => handleInsertStage(dealStageKeys.length, false)}
                  onCancel={cancelInsert}
                  onNameChange={setInsertStageName}
                />
              )}

              {/* ── Divider between deal and production stages ── */}
              {dealCols.length > 0 && prodCols.length > 0 && (
                <PipelineDivider label="Production" />
              )}

              {/* ── Production Stages ── */}
              {prodCols.map((col, localIdx) => {
                const { stageValue, idxInGroup } = col;
                const label = getStageLabel(stageValue, stageValue);
                const accent = getStageColor(stageValue);
                return (
                  <div key={stageValue} className="flex items-start">
                    {idxInGroup > 0 && (
                      <InsertZone
                        active={insertingAtIndex === localIdx && insertingInGroup === 'production'}
                        stageName={insertStageName}
                        onActivate={() => { cancelInsert(); setInsertingAtIndex(localIdx); setInsertingInGroup('production'); }}
                        onConfirm={() => handleInsertStage(idxInGroup, true)}
                        onCancel={cancelInsert}
                        onNameChange={setInsertStageName}
                      />
                    )}
                    <KanbanColumn
                      stage={stageValue} label={label} accent={accent}
                      deals={filteredDeals.filter(d => d.stage === stageValue)}
                      dnd={dnd}
                      onCardClick={openDeal}
                      onAddDeal={() => setAddStage(stageValue as Stage)}
                      onMoveCard={handleMoveCard}
                      onArchiveCard={handleArchiveCard}
                      onDeleteStage={handleDeleteStage}
                    />
                  </div>
                );
              })}

              {/* Insert zone at end of production stages */}
              {productionStageKeys.length > 0 && (
                <InsertZone
                  active={insertingAtIndex === productionStageKeys.length && insertingInGroup === 'production'}
                  stageName={insertStageName}
                  onActivate={() => { cancelInsert(); setInsertingAtIndex(productionStageKeys.length); setInsertingInGroup('production'); }}
                  onConfirm={() => handleInsertStage(productionStageKeys.length, true)}
                  onCancel={cancelInsert}
                  onNameChange={setInsertStageName}
                />
              )}

              {/* Add Stage column — adds a DEAL stage (this is the Deals board) */}
              <div style={{ minWidth: 230, width: 230 }} className="flex-shrink-0 flex flex-col ml-1">
                {addingStage ? (
                  <div className="rounded-xl p-3 flex flex-col gap-2"
                    style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}>
                    <p className="text-[12px] font-semibold text-foreground uppercase tracking-widest mb-1">New Stage</p>
                    <input
                      autoFocus value={newStageName} onChange={e => setNewStageName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddStage(false); if (e.key === 'Escape') { setAddingStage(false); setNewStageName(''); } }}
                      placeholder="Stage name…"
                      className="h-8 px-2.5 text-sm bg-muted/40 border border-border rounded-lg outline-none focus:border-primary/40 text-foreground"
                    />
                    {/* This is the Deals board: Enter and the main button add a DEAL stage.
                        A production stage can still be added here, explicitly. */}
                    <div className="flex gap-1.5">
                      <button onClick={() => handleAddStage(false)} className="flex-1 h-7 rounded-lg bg-primary text-primary-foreground text-xs font-semibold flex items-center justify-center gap-1 hover:opacity-90 transition-opacity">
                        <Check size={11} /> Add to Deals
                      </button>
                      <button onClick={() => { setAddingStage(false); setNewStageName(''); }} title="Cancel" className="h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors">
                        <X size={11} />
                      </button>
                    </div>
                    <button onClick={() => handleAddStage(true)} className="h-7 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                      Add to Production instead
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { cancelInsert(); setAddingStage(true); }}
                    className="w-full h-12 rounded-xl flex items-center justify-center gap-2 text-muted-foreground/40 hover:text-muted-foreground transition-colors text-sm font-medium"
                    style={{ border: '2px dashed hsl(var(--border) / 0.5)' }}
                  >
                    <Plus size={14} /> Add Stage
                  </button>
                )}
              </div>
            </div>
          </LayoutGroup>
        )}
      </div>

      {selected && (
        <DealDrawer deal={selected} onClose={closeDeal}
          onUpdated={d => { setDeals(ds => ds.map(x => x.id === d.id ? d : x)); setSelected(d); }}
          onArchived={id => { setDeals(ds => ds.filter(x => x.id !== id)); }}
          onRestored={restoreDeal}
        />
      )}
      {addStage && (
        <AddDealModal defaultStage={addStage} onClose={() => setAddStage(null)}
          onCreated={d => { setDeals(ds => [d, ...ds]); setAddStage(null); }}
        />
      )}
      <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} logs={scanLogs} scanMeta={scanMeta}
        onClear={sync.clearLog}
      />
    </div>
  );
}
