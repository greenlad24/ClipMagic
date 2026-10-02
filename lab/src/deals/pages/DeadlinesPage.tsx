import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/deals/ui/button';
import { Skeleton } from '@/deals/ui/skeleton';
import { toast } from 'sonner';
import { Plus, Loader2, Search, Sun, Moon, X, LayoutGrid, List, Calendar, ArrowUpDown, ChevronDown, Trash2, Check } from 'lucide-react';
import { useTheme } from '@/deals/context/ThemeContext';
import { Deal, Stage } from '@/deals/lib/supabase';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { dealDeadlineDate, dealDaysUntil, dealDeadlineYmd, formatDeadline, formatDeadlineChip } from '@/deals/lib/deadline';
import { formatMoney } from '@/deals/lib/currency';
import { useBoardDnd } from '@/deals/lib/boardDnd';
import { useSearchHotkey, SEARCH_HOTKEY_LABEL } from '@/deals/lib/useSearchHotkey';
import { useSyncRefresh } from '@/deals/context/SyncContext';
import DeadlineEditor from '@/deals/components/DeadlineEditor';
import { getDeadlineProjects, addDealToProduction, updateDeal, getDeals, GetDealsOutputType } from '@/deals/api';
import { LayoutGroup } from '@/deals/ui/motion';
import KanbanColumn from '@/deals/components/KanbanColumn';
import DealDrawer from '@/deals/components/DealDrawer';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/deals/ui/dropdown-menu';

// ─── Deadline urgency helpers ─────────────────────────────────────────────────

// Deadlines are FREE TEXT (shown as written); every date decision here — month
// grouping, sort, countdown, urgency — runs on the server's parsed
// `deadline_date` (lib/deadline.ts dealDeadlineYmd; local parse until it lands).

type DeadlineFields = Pick<Deal, 'deadline' | 'deadline_date' | 'deadline_parsed_from'>;

function getDeadlineUrgency(deal: DeadlineFields): 'overdue' | 'soon' | 'ok' | 'none' {
  const days = dealDaysUntil(deal);
  if (days === null) return 'none';
  if (days < 0) return 'overdue';
  if (days <= 7) return 'soon';
  return 'ok';
}

const getDaysRemaining = dealDaysUntil;

// Fallback when the live stage list has no "Video Draft Submitted" stage.
const LATE_STAGE_FALLBACK = ['video_draft_submitted', 'reviewed_require_fixes', 'video_fixed_sent', 'second_review', 'video_ready_publish', 'second_invoice_sent', 'second_invoice_paid', 'completed'];

// ─── Insert Zone ─────────────────────────────────────────────────────────────

interface InsertZoneProps {
  active: boolean; stageName: string;
  onActivate: () => void; onConfirm: () => void; onCancel: () => void; onNameChange: (v: string) => void;
}
function InsertZone({ active, stageName, onActivate, onConfirm, onCancel, onNameChange }: InsertZoneProps) {
  const [hovered, setHovered] = useState(false);
  if (active) {
    return (
      <div style={{ minWidth: 230, width: 230, flexShrink: 0, margin: '0 7px', background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="text-[12px] font-semibold text-foreground uppercase tracking-widest mb-1">Insert Stage</p>
        <input autoFocus value={stageName} onChange={e => onNameChange(e.target.value)}
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
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onClick={onActivate} title="Insert stage here"
      style={{ width: hovered ? 48 : 16, flexShrink: 0, transition: 'width 0.2s ease', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', position: 'relative', alignSelf: 'stretch' }}
    >
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 2, transform: 'translateX(-50%)', borderRadius: 2, background: 'hsl(var(--primary) / 0.35)', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s ease' }} />
      <div style={{ position: 'relative', width: 30, height: 30, borderRadius: '50%', background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: hovered ? 1 : 0, transform: hovered ? 'scale(1)' : 'scale(0.5)', transition: 'opacity 0.15s ease, transform 0.2s ease', boxShadow: '0 2px 8px hsl(var(--primary) / 0.4)', flexShrink: 0 }}>
        <Plus size={15} strokeWidth={2.5} />
      </div>
    </div>
  );
}

// ─── Deal Picker Modal ────────────────────────────────────────────────────────

type RawDeal = GetDealsOutputType['deals'][0];

function DealPickerModal({ onClose, onAdded }: { onClose: () => void; onAdded: (deal: Deal) => void }) {
  const [allDeals, setAllDeals] = useState<RawDeal[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);
  const { getStageColor, getStageLabel } = useStageLabels();

  useEffect(() => {
    getDeals({}).then(r => setAllDeals(r.deals.filter(d => !d.in_production)))
      .catch(() => toast.error('Failed to load deals')).finally(() => setLoading(false));
  }, []);

  const filtered = allDeals.filter(d => {
    const q = search.toLowerCase();
    return !q || d.client_name.toLowerCase().includes(q) || (d.project_name ?? '').toLowerCase().includes(q);
  });

  const handleAdd = async (deal: RawDeal) => {
    setAdding(deal.id);
    try {
      const { deal: updated } = await addDealToProduction({ dealId: deal.id });
      onAdded(updated as Deal);
      toast.success(`${deal.client_name} added to production! 🚀`);
    } catch { toast.error('Failed to add deal'); }
    finally { setAdding(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div className="mobile-modal-card rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
        style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-[15px] font-bold text-foreground">Add Deal to Production</h2>
            <p className="text-[12px] text-muted-foreground mt-0.5">Pick a scanned deal to add to your production pipeline</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground"><X size={15} /></button>
        </div>
        <div className="px-5 py-3 border-b border-border">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input autoFocus placeholder="Search deals..." value={search} onChange={e => setSearch(e.target.value)}
              className="w-full h-9 text-sm bg-muted/50 border border-border rounded-[8px] outline-none focus:border-primary/40 text-foreground"
              style={{ paddingLeft: 36, paddingRight: 12 }}
            />
          </div>
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 420 }}>
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">{search ? 'No matching deals found' : 'All deals are already in production'}</p>
            </div>
          ) : filtered.map((deal, i) => {
            const color = getStageColor(deal.stage ?? '');
            return (
              <div key={deal.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/30 transition-colors"
                style={{ borderBottom: i < filtered.length - 1 ? '1px solid hsl(var(--border) / 0.5)' : undefined }}>
                <div className="flex-1 min-w-0">
                  <p className="text-[14px] font-semibold text-foreground truncate">{deal.client_name}</p>
                  {deal.project_name && <p className="text-[12px] text-muted-foreground truncate mt-0.5">{deal.project_name}</p>}
                  {deal.stage && (
                    <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
                      {getStageLabel(deal.stage, deal.stage)}
                    </span>
                  )}
                </div>
                {deal.estimated_value != null && (
                  <span className="text-[13px] font-medium text-foreground/60 flex-shrink-0">{formatMoney(deal.estimated_value, deal.currency)}</span>
                )}
                <Button size="sm" variant="outline" className="h-8 px-3 text-xs gap-1.5 flex-shrink-0"
                  disabled={adding === deal.id} onClick={() => handleAdd(deal)}>
                  {adding === deal.id ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Add
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── List View ────────────────────────────────────────────────────────────────

type SortKey = 'deadline' | 'stage' | 'client' | 'value';

interface ListViewProps {
  deals: Deal[];
  onSelect: (deal: Deal) => void;
  onMoveCard: (deal: Deal, stage: Stage) => void;
  onRemove: (deal: Deal) => void;
  onDeadlineUpdate: (deal: Deal, newDeadline: string | null) => Promise<void>;
}

function DeadlinesListView({ deals, onSelect, onMoveCard, onRemove, onDeadlineUpdate }: ListViewProps) {
  const { getStageLabel, getStageColor, productionStageKeys } = useStageLabels();
  const [sortKey, setSortKey] = useState<SortKey>('deadline');
  const [sortAsc, setSortAsc] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const STAGE_ORDER: Record<string, number> = {};
  productionStageKeys.forEach((v, i) => { STAGE_ORDER[v] = i; });

  // Stages at/after "Video Draft Submitted" (live order) — an overdue deadline is no longer actionable there.
  const draftIdx = productionStageKeys.indexOf('video_draft_submitted');
  const LATE_STAGES = new Set(draftIdx >= 0 ? productionStageKeys.slice(draftIdx) : LATE_STAGE_FALLBACK);

  const sorted = [...deals].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'deadline') {
      cmp = (getDaysRemaining(a) ?? 99999) - (getDaysRemaining(b) ?? 99999);
    } else if (sortKey === 'stage') {
      cmp = (STAGE_ORDER[a.stage] ?? 99) - (STAGE_ORDER[b.stage] ?? 99);
    } else if (sortKey === 'client') {
      cmp = a.client_name.localeCompare(b.client_name);
    } else if (sortKey === 'value') {
      cmp = (b.estimated_value ?? 0) - (a.estimated_value ?? 0);
    }
    return sortAsc ? cmp : -cmp;
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(v => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const SortBtn = ({ label, k }: { label: string; k: SortKey }) => (
    <button onClick={() => toggleSort(k)}
      className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors">
      {label} <ArrowUpDown size={10} className={sortKey === k ? 'text-primary' : 'opacity-30'} />
    </button>
  );

  const urgencyStyle = (u: ReturnType<typeof getDeadlineUrgency>) => {
    if (u === 'overdue') return { bg: 'hsl(var(--destructive) / 0.12)', color: 'hsl(var(--destructive))', border: 'hsl(var(--destructive) / 0.3)' };
    if (u === 'soon')    return { bg: 'hsl(38 92% 50% / 0.12)', color: 'hsl(38 92% 40%)', border: 'hsl(38 92% 50% / 0.3)' };
    if (u === 'ok')      return { bg: 'hsl(142 71% 45% / 0.12)', color: 'hsl(142 71% 35%)', border: 'hsl(142 71% 45% / 0.3)' };
    return { bg: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))', border: 'hsl(var(--border))' };
  };

  const startEdit = (deal: Deal, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(deal.id);
  };
  const commitEdit = async (deal: Deal, val: string | null) => {
    setEditingId(null);
    if (val === (deal.deadline ?? null)) return;
    setSavingId(deal.id);
    try { await onDeadlineUpdate(deal, val); } finally { setSavingId(null); }
  };

  if (deals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <p className="text-sm">No projects in production yet</p>
      </div>
    );
  }

  // Group by month
  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  type DealGroup = { key: string; label: string; isPast: boolean; deals: typeof sorted };
  const groupsMap = new Map<string, DealGroup>();
  const groupsOrder: string[] = [];
  for (const deal of sorted) {
    const d = dealDeadlineDate(deal);
    let key: string, label: string, isPast = false;
    if (!d) { key = 'zzz-none'; label = 'No Deadline'; }
    else {
      const y = d.getFullYear(), mo = d.getMonth();
      key = `${y}-${String(mo + 1).padStart(2, '0')}`;
      isPast = key < thisMonthKey;
      label = key === thisMonthKey ? 'This Month' : d.toLocaleString('default', { month: 'long', year: 'numeric' });
    }
    if (!groupsMap.has(key)) { groupsMap.set(key, { key, label, isPast, deals: [] }); groupsOrder.push(key); }
    groupsMap.get(key)!.deals.push(deal);
  }
  const dealGroups = groupsOrder.map(k => groupsMap.get(k)!);

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 px-4 sm:px-6 py-2.5 sticky top-0 z-10 bg-background border-b border-border overflow-x-auto">
        <span className="text-[11px] text-muted-foreground/50 mr-1">Sort by</span>
        {(['client', 'stage', 'deadline', 'value'] as SortKey[]).map(k => (
          <SortBtn key={k} label={k === 'client' ? 'Project' : k.charAt(0).toUpperCase() + k.slice(1)} k={k} />
        ))}
      </div>

      {dealGroups.map(group => (
        <div key={group.key}>
          <div className="flex items-center gap-3 px-3 sm:px-6 pt-5 pb-2">
            <span className="text-[11px] font-bold uppercase tracking-widest flex-shrink-0"
              style={{ color: group.key === 'zzz-none' ? 'hsl(var(--muted-foreground) / 0.4)' : group.isPast ? 'hsl(var(--destructive) / 0.7)' : group.key === thisMonthKey ? 'hsl(var(--primary) / 0.8)' : 'hsl(var(--muted-foreground) / 0.55)' }}>
              {group.label}{group.isPast ? ' · Overdue' : ''}
            </span>
            <div className="flex-1 h-px bg-border/40" />
            <span className="text-[11px] text-muted-foreground/35 flex-shrink-0">{group.deals.length} project{group.deals.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="flex flex-col gap-3 px-3 sm:px-6 pb-4">
            {group.deals.map(deal => {
              const rawUrgency = getDeadlineUrgency(deal);
              const urgency = rawUrgency === 'overdue' && LATE_STAGES.has(deal.stage ?? '') ? 'none' : rawUrgency;
              const days = getDaysRemaining(deal);
              const dateYmd = dealDeadlineYmd(deal);
              const us = urgencyStyle(urgency);
              const stageColor = getStageColor(deal.stage ?? '');
              const stageLabel = getStageLabel(deal.stage ?? '', deal.stage ?? '—');
              const stageIdx = productionStageKeys.indexOf(deal.stage ?? '');

              return (
                <div key={deal.id} className="group cursor-pointer rounded-[10px] transition-all hover:-translate-y-[1px]"
                  style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderLeft: `4px solid ${stageColor}`, boxShadow: '0 1px 6px rgba(0,0,0,0.05)' }}
                  onClick={() => onSelect(deal)}>
                  <div className="px-3 py-3 flex items-center gap-2 sm:gap-4 sm:px-4 sm:py-3.5">
                    {/* Name */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px] font-semibold text-foreground truncate">{deal.client_name}</p>
                      {deal.project_name && <p className="text-[12px] text-muted-foreground truncate mt-0.5">{deal.project_name}</p>}
                    </div>

                    {/* Stage dropdown — flat list from context (includes custom stages) */}
                    <div onClick={e => e.stopPropagation()} className="flex-shrink-0">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition-colors hover:bg-muted/50" style={{ color: stageColor }}>
                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: stageColor }} />
                            <span className="hidden sm:inline truncate max-w-[130px]">{stageLabel}</span>
                            <ChevronDown size={11} className="opacity-50" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-52 max-h-72 overflow-y-auto">
                          {productionStageKeys.filter(sv => sv !== deal.stage).map(sv => (
                            <DropdownMenuItem key={sv} onClick={() => onMoveCard(deal, sv as Stage)}>
                              <span className="w-2 h-2 rounded-full mr-2 flex-shrink-0" style={{ background: getStageColor(sv) }} />
                              {getStageLabel(sv, sv)}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {/* Deadline */}
                    <div className="deadline-date-cell flex-shrink-0 min-w-[120px] sm:min-w-[140px]" onClick={e => e.stopPropagation()}>
                      {editingId === deal.id ? (
                        <DeadlineEditor value={deal.deadline} onSave={val => commitEdit(deal, val)} onCancel={() => setEditingId(null)} className="w-[230px] max-w-[70vw]" />
                      ) : (
                        <button
                          className="group/dl inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-lg transition-all hover:opacity-90 w-full"
                          style={deal.deadline
                            ? { background: us.bg, color: us.color, border: `1px solid ${us.border}` }
                            : { background: 'hsl(var(--muted)/0.5)', color: 'hsl(var(--muted-foreground)/0.4)', border: '1px dashed hsl(var(--border))' }
                          }
                          onClick={e => startEdit(deal, e)} title="Click to edit deadline"
                        >
                          {savingId === deal.id ? <Loader2 size={11} className="animate-spin" /> : <Calendar size={11} className="flex-shrink-0" />}
                          <span className="truncate" title={deal.deadline ? `${deal.deadline}${dateYmd ? ` → ${formatDeadlineChip(dateYmd)}` : ''}` : undefined}>{deal.deadline ? formatDeadline(deal.deadline) : 'No deadline'}</span>
                          {urgency !== 'none' && deal.deadline && (
                            <span className="ml-auto flex-shrink-0 text-[10px] opacity-70 font-semibold">
                              {urgency === 'overdue' ? `${Math.abs(days!)}d late` : days === 0 ? 'today' : `${days}d`}
                            </span>
                          )}
                        </button>
                      )}
                    </div>

                    {/* Value */}
                    {deal.estimated_value != null && (
                      <span className="deadline-value-cell text-[13px] font-semibold text-foreground/60 flex-shrink-0 hidden md:block">
                        {formatMoney(deal.estimated_value, deal.currency)}
                      </span>
                    )}

                    {/* Pipeline progress dots — driven by context */}
                    <div className="pipeline-progress-dots flex items-center gap-[3px] flex-shrink-0 hidden lg:flex">
                      {productionStageKeys.slice(0, -1).map((sv, i) => (
                        <div key={sv} className="w-2 h-2 rounded-full transition-colors"
                          style={{ background: i <= stageIdx ? getStageColor(sv) : 'hsl(var(--border))' }}
                          title={getStageLabel(sv, sv)}
                        />
                      ))}
                    </div>

                    {/* Remove */}
                    <div className="flex-shrink-0" onClick={e => e.stopPropagation()}>
                      <button className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground/20 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all"
                        title="Remove from production" onClick={() => onRemove(deal)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type ViewMode = 'kanban' | 'list';

export default function DeadlinesPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Deal | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [addingStage, setAddingStage] = useState(false);
  const [newStageName, setNewStageName] = useState('');
  const [insertingAtIndex, setInsertingAtIndex] = useState<number | null>(null);
  const [insertStageName, setInsertStageName] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  useSearchHotkey(searchRef, !selected && !showPicker);

  const { theme, toggleTheme } = useTheme();

  // ── Single source of truth: context ─────────────────────────────────────────
  const { productionStageKeys, getStageLabel, getStageColor, addStage: ctxAddStage, reorderStageKeys, removeStage, isLoaded } = useStageLabels();

  const load = useCallback(async () => {
    try {
      const res = await getDeadlineProjects({});
      setDeals(res.deals as Deal[]);
    } catch { toast.error('Failed to load production deals'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useSyncRefresh(load); // the shared Gmail sync finished → fresh data

  const handleAddStage = () => {
    const name = newStageName.trim();
    if (!name) return;
    const value = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (productionStageKeys.includes(value)) { toast.error('A stage with that name already exists'); return; }
    ctxAddStage(name, true, productionStageKeys.length);
    setNewStageName('');
    setAddingStage(false);
    toast.success(`Stage "${name}" added`);
  };

  const handleInsertStage = (atIndex: number) => {
    const name = insertStageName.trim();
    if (!name) return;
    const value = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (productionStageKeys.includes(value)) { toast.error('A stage with that name already exists'); return; }
    ctxAddStage(name, true, atIndex);
    setInsertStageName('');
    setInsertingAtIndex(null);
    toast.success(`Stage "${name}" inserted`);
  };

  const cancelInsert = () => { setInsertingAtIndex(null); setInsertStageName(''); };

  const handleDeleteStage = async (stageKey: string) => {
    try {
      const { fallbackStageKey, reassignedCount } = await removeStage(stageKey);
      if (reassignedCount > 0 && fallbackStageKey) {
        const fallbackLabel = getStageLabel(fallbackStageKey, fallbackStageKey);
        setDeals(d => d.map(x => x.stage === stageKey ? { ...x, stage: fallbackStageKey as Stage } : x));
        toast(`Stage deleted — ${reassignedCount} project${reassignedCount !== 1 ? 's' : ''} moved to "${fallbackLabel}"`);
      } else {
        toast('Stage deleted');
      }
    } catch {
      toast.error('Failed to delete stage');
    }
  };

  const applyStageUpdate = async (deal: Deal, stage: Stage) => {
    const prev = deals;
    const isCompleted = stage === 'completed';
    const isProdStage = productionStageKeys.includes(stage);

    if (isCompleted) {
      setDeals(d => d.filter(x => x.id !== deal.id));
      toast.success(`🎉 ${deal.client_name} completed!`);
    } else if (!isProdStage) {
      setDeals(d => d.filter(x => x.id !== deal.id));
      toast(`${deal.client_name} moved back to deals pipeline`);
    } else {
      setDeals(d => d.map(x => x.id === deal.id ? { ...x, stage } : x));
      toast.success(`Moved to ${getStageLabel(stage, stage)}`, { duration: 3000 });
    }

    try {
      const updates: { stage: string; in_production?: boolean } = { stage };
      if (isCompleted || !isProdStage) updates.in_production = false;
      await updateDeal({ id: deal.id, updates });
    } catch { setDeals(prev); toast.error('Failed to update stage'); }
  };

  // Mouse (HTML5) + touch (long-press) drag-and-drop, see lib/boardDnd.ts.
  const dnd = useBoardDnd<Deal>({
    onCardDrop: (deal, targetStage) => {
      if (deal.stage === targetStage) return;
      void applyStageUpdate(deal, targetStage as Stage);
    },
    onColumnDrop: (from, targetStage) => {
      const next = [...productionStageKeys];
      const fi = next.indexOf(from), ti = next.indexOf(targetStage);
      if (fi !== -1 && ti !== -1) {
        next.splice(fi, 1);
        next.splice(ti, 0, from);
        reorderStageKeys(next); // persists to DB via context
      }
    },
  });

  const handleMoveCard = async (deal: Deal, stage: string) => {
    if (deal.stage === stage) return;
    await applyStageUpdate(deal, stage as Stage);
  };

  const handleDeadlineUpdate = async (deal: Deal, newDeadline: string | null) => {
    setDeals(d => d.map(x => x.id === deal.id ? { ...x, deadline: newDeadline } : x));
    try {
      const { deal: saved } = await updateDeal({ id: deal.id, updates: { deadline: newDeadline } });
      // The server parsed the text → take its deadline_date (the page groups/sorts on it).
      setDeals(d => d.map(x => x.id === deal.id ? { ...x, ...(saved as Partial<Deal>) } : x));
      toast.success('Deadline updated');
    } catch {
      setDeals(d => d.map(x => x.id === deal.id ? { ...x, deadline: deal.deadline } : x));
      toast.error('Failed to update deadline');
    }
  };

  const handleRemoveFromProduction = async (deal: Deal) => {
    setDeals(d => d.filter(x => x.id !== deal.id));
    try {
      await updateDeal({ id: deal.id, updates: { in_production: false } });
      toast('Removed from production');
    } catch { load(); toast.error('Failed to remove'); }
  };

  const filteredDeals = searchQuery.trim()
    ? deals.filter(d => {
        const q = searchQuery.toLowerCase();
        return d.client_name.toLowerCase().includes(q) || (d.project_name ?? '').toLowerCase().includes(q);
      })
    : deals;

  const skeletonStages = Array.from({ length: 7 }, (_, i) => ({ value: `skeleton-${i}` }));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar */}
      <div className="glass-nav flex-shrink-0 px-6 flex items-center gap-4" style={{ height: 60 }}>
        <h1 className="text-[20px] font-bold text-foreground shrink-0">Deadlines</h1>

        <div className="relative ml-4 mobile-search-wrap" style={{ width: 300 }}>
          <Search size={16} className="absolute left-[14px] top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          <input ref={searchRef} type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setSearchQuery(''); e.currentTarget.blur(); } }}
            placeholder="Search projects..."
            className="w-full h-10 text-sm bg-card border border-border rounded-[10px] outline-none focus:border-primary/40 transition-all"
            style={{ paddingLeft: 42, paddingRight: 52, color: 'hsl(var(--foreground))' }}
          />
          <span className="search-cmd-badge absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold rounded-[6px]"
            style={{ background: 'hsl(var(--primary) / 0.10)', color: 'hsl(var(--primary))', padding: '2px 6px' }}>
            {SEARCH_HOTKEY_LABEL}
          </span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <div className="flex items-center h-9 rounded-[8px] p-0.5 bg-muted/60 border border-border/60">
            <button onClick={() => setViewMode('kanban')} className="flex items-center justify-center w-8 h-8 rounded-[6px] transition-all"
              style={viewMode === 'kanban' ? { background: 'hsl(var(--card))', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', color: 'hsl(var(--foreground))' } : { color: 'hsl(var(--muted-foreground))' }}
              title="Kanban view"><LayoutGrid size={14} /></button>
            <button onClick={() => setViewMode('list')} className="flex items-center justify-center w-8 h-8 rounded-[6px] transition-all"
              style={viewMode === 'list' ? { background: 'hsl(var(--card))', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', color: 'hsl(var(--foreground))' } : { color: 'hsl(var(--muted-foreground))' }}
              title="List view"><List size={14} /></button>
          </div>

          <Button variant="ghost" size="sm" onClick={toggleTheme} className="h-9 w-9 p-0 text-muted-foreground"
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}>
            {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
          </Button>

          <Button size="sm" onClick={() => setShowPicker(true)}
            className="h-9 text-[14px] font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-[8px] px-3 sm:px-[18px]">
            <Plus size={13} /> <span className="hidden sm:inline">Add Project</span>
          </Button>
        </div>
      </div>

      {/* Content */}
      {viewMode === 'kanban' ? (
        <div ref={dnd.boardRef} className="kanban-board-area flex-1 overflow-x-auto bg-background" style={{ padding: '20px 24px' }}>
          {loading || !isLoaded ? (
            <div className="flex gap-[14px]">
              {skeletonStages.map(s => (
                <div key={s.value} style={{ minWidth: 230, width: 230 }} className="space-y-3 flex-shrink-0">
                  <Skeleton className="h-10 w-full rounded-xl" />
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
                </div>
              ))}
            </div>
          ) : (
            <LayoutGroup>
              <div className="flex items-start" style={{ minWidth: 'max-content' }}>
                {productionStageKeys.map((stageValue, idx) => {
                  const label = getStageLabel(stageValue, stageValue);
                  const accent = getStageColor(stageValue);
                  return (
                    <div key={stageValue} className="flex items-start">
                      {idx > 0 && (
                        <InsertZone
                          active={insertingAtIndex === idx} stageName={insertStageName}
                          onActivate={() => { cancelInsert(); setInsertingAtIndex(idx); }}
                          onConfirm={() => handleInsertStage(idx)}
                          onCancel={cancelInsert} onNameChange={setInsertStageName}
                        />
                      )}
                      <KanbanColumn
                        stage={stageValue} label={label} accent={accent}
                        deals={filteredDeals.filter(d => d.stage === stageValue)}
                        dnd={dnd}
                        onCardClick={setSelected}
                        onAddDeal={() => setShowPicker(true)}
                        onMoveCard={handleMoveCard}
                        onArchiveCard={handleRemoveFromProduction}
                        onDeleteStage={handleDeleteStage}
                      />
                    </div>
                  );
                })}

                {productionStageKeys.length > 0 && (
                  <InsertZone
                    active={insertingAtIndex === productionStageKeys.length} stageName={insertStageName}
                    onActivate={() => { cancelInsert(); setInsertingAtIndex(productionStageKeys.length); }}
                    onConfirm={() => handleInsertStage(productionStageKeys.length)}
                    onCancel={cancelInsert} onNameChange={setInsertStageName}
                  />
                )}

                {/* Add Stage */}
                <div style={{ minWidth: 230, width: 230 }} className="flex-shrink-0 flex flex-col">
                  {addingStage ? (
                    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}>
                      <p className="text-[12px] font-semibold text-foreground uppercase tracking-widest mb-1">New Stage</p>
                      <input autoFocus value={newStageName} onChange={e => setNewStageName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAddStage(); if (e.key === 'Escape') { setAddingStage(false); setNewStageName(''); } }}
                        placeholder="Stage name…"
                        className="h-8 px-2.5 text-sm bg-muted/40 border border-border rounded-lg outline-none focus:border-primary/40 text-foreground"
                      />
                      <div className="flex gap-1.5">
                        <button onClick={handleAddStage} className="flex-1 h-7 rounded-lg bg-primary text-primary-foreground text-xs font-semibold flex items-center justify-center gap-1 hover:opacity-90 transition-opacity">
                          <Check size={11} /> Add
                        </button>
                        <button onClick={() => { setAddingStage(false); setNewStageName(''); }} className="h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors">
                          <X size={11} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => { cancelInsert(); setAddingStage(true); }}
                      className="w-full h-12 rounded-xl flex items-center justify-center gap-2 text-muted-foreground/40 hover:text-muted-foreground transition-colors text-sm font-medium"
                      style={{ border: '2px dashed hsl(var(--border) / 0.5)' }}>
                      <Plus size={14} /> Add Stage
                    </button>
                  )}
                </div>
              </div>
            </LayoutGroup>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto bg-background">
          {loading || !isLoaded ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
            </div>
          ) : (
            <DeadlinesListView
              deals={filteredDeals}
              onSelect={setSelected}
              onMoveCard={handleMoveCard}
              onRemove={handleRemoveFromProduction}
              onDeadlineUpdate={handleDeadlineUpdate}
            />
          )}
        </div>
      )}

      {selected && (
        <DealDrawer deal={selected} onClose={() => setSelected(null)}
          onUpdated={d => {
            // Leaving production from the drawer takes it off this board, like a move here does.
            if (d.in_production === false) { setDeals(ds => ds.filter(x => x.id !== d.id)); setSelected(d); return; }
            setDeals(ds => ds.map(x => x.id === d.id ? d : x)); setSelected(d);
          }}
          onArchived={id => { setDeals(ds => ds.filter(x => x.id !== id)); }}
          onRestored={d => { if (d.in_production) setDeals(ds => ds.some(x => x.id === d.id) ? ds : [...ds, d]); }}
        />
      )}
      {showPicker && (
        <DealPickerModal onClose={() => setShowPicker(false)}
          onAdded={deal => { setDeals(ds => [...ds, deal]); setShowPicker(false); }}
        />
      )}
    </div>
  );
}
