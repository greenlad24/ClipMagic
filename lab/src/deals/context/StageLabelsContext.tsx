import { createContext, useContext, useState, useCallback, useEffect, useMemo, ReactNode } from 'react';
import { getStages, renameStage, createStage, reorderStages, deleteStage } from '@/deals/api';
import type { GetStagesOutputType } from '@/deals/api';
import { STAGES } from '@/deals/lib/stages';

type StageInfo = GetStagesOutputType['stages'][0];

// Production stage keys for the fallback (hardcoded list)
const PRODUCTION_STAGE_KEYS = new Set([
  'contract_signed', 'invoice_created_sent', 'in_research', 'need_to_script',
  'script_in_review', 'script_fixes', 'need_to_film', 'in_video_editing',
  'video_draft_submitted', 'reviewed_require_fixes', 'video_fixed_sent',
  'second_review', 'video_ready_publish', 'second_invoice_sent',
  'second_invoice_paid', 'completed',
]);

interface StageLabelsContextType {
  columnLabels: Record<string, string>;
  stageRecords: StageInfo[];
  /** Ordered deal (non-production) stage keys from DB */
  dealStageKeys: string[];
  /** Ordered production stage keys from DB */
  productionStageKeys: string[];
  /** Deal stages then production stages, in board order. */
  allStageKeys: string[];
  /** True for a production stage (same rule the board uses for in_production). */
  isProductionStage: (stageKey: string) => boolean;
  /** Resolve a stage key from a key or a (DB/display) label, case-insensitive. */
  resolveStageKey: (keyOrLabel: string) => string | null;
  getStageLabel: (stageKey: string, defaultLabel: string) => string;
  getStageColor: (stageKey: string) => string;
  setStageLabel: (stageKey: string, newLabel: string) => void;
  /** Create a new stage at the given index within its group and persist to DB */
  addStage: (name: string, isProduction: boolean, atIndex: number) => Promise<void>;
  /** Reorder stages by passing the full new ordered key list and persist to DB */
  reorderStageKeys: (orderedKeys: string[]) => Promise<void>;
  /** Delete a stage and reassign its deals to the fallback stage */
  removeStage: (stageKey: string) => Promise<{ fallbackStageKey: string | null; reassignedCount: number }>;
  isLoaded: boolean;
}

const StageLabelsContext = createContext<StageLabelsContextType>({
  columnLabels: {},
  stageRecords: [],
  dealStageKeys: [],
  productionStageKeys: [],
  allStageKeys: [],
  isProductionStage: () => false,
  resolveStageKey: () => null,
  getStageLabel: (_, def) => def,
  getStageColor: () => 'hsl(var(--primary))',
  setStageLabel: () => {},
  addStage: async () => {},
  reorderStageKeys: async () => {},
  removeStage: async () => ({ fallbackStageKey: null, reassignedCount: 0 }),
  isLoaded: false,
});

export function StageLabelsProvider({ children }: { children: ReactNode }) {
  const [stageRecords, setStageRecords] = useState<StageInfo[]>([]);
  const [columnLabels, setColumnLabels] = useState<Record<string, string>>({});
  const [isLoaded, setIsLoaded] = useState(false);

  const fetchAndApply = useCallback(() => {
    return getStages({}).then(({ stages }) => {
      setStageRecords(stages);
      const labels: Record<string, string> = {};
      for (const s of stages) labels[s.key] = s.displayName;
      setColumnLabels(labels);
      setIsLoaded(true);
    });
  }, []);

  useEffect(() => {
    fetchAndApply().catch(() => {
      // Fallback to hardcoded STAGES list
      const fallback: StageInfo[] = STAGES.map((s, i) => ({
        key: s.value,
        displayName: s.label,
        shortName: s.shortLabel,
        cssVariable: s.cssVar,
        sortOrder: i + 1,
        isProduction: PRODUCTION_STAGE_KEYS.has(s.value),
      }));
      setStageRecords(fallback);
      const labels: Record<string, string> = {};
      for (const s of fallback) labels[s.key] = s.displayName;
      setColumnLabels(labels);
      setIsLoaded(true);
    });
  }, [fetchAndApply]);

  // Derived sorted lists — memoised so pages get stable references
  const dealStageKeys = useMemo(() =>
    stageRecords
      .filter(r => !r.isProduction)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(r => r.key),
    [stageRecords]
  );

  const productionStageKeys = useMemo(() =>
    stageRecords
      .filter(r => r.isProduction)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(r => r.key),
    [stageRecords]
  );

  const allStageKeys = useMemo(() => [...dealStageKeys, ...productionStageKeys], [dealStageKeys, productionStageKeys]);
  const productionSet = useMemo(() => new Set(productionStageKeys), [productionStageKeys]);
  const isProductionStage = useCallback((stageKey: string) => productionSet.has(stageKey), [productionSet]);

  const resolveStageKey = useCallback((keyOrLabel: string): string | null => {
    const q = keyOrLabel.trim().toLowerCase();
    if (!q) return null;
    const rec = stageRecords.find(r => r.key.toLowerCase() === q)
      ?? stageRecords.find(r => r.displayName.toLowerCase() === q || r.shortName.toLowerCase() === q);
    if (rec) return rec.key;
    const hard = STAGES.find(s => s.label.toLowerCase() === q || s.shortLabel.toLowerCase() === q);
    return hard && stageRecords.some(r => r.key === hard.value) ? hard.value : null;
  }, [stageRecords]);

  const getStageLabel = useCallback((stageKey: string, defaultLabel: string) =>
    columnLabels[stageKey] ?? defaultLabel,
    [columnLabels]
  );

  const getStageColor = useCallback((stageKey: string): string => {
    const record = stageRecords.find(r => r.key === stageKey);
    const cssVar = record?.cssVariable;
    if (cssVar && cssVar !== 'custom') return `hsl(var(--stage-${cssVar}))`;
    // Try hardcoded fallback
    const hardcoded = STAGES.find(s => s.value === stageKey);
    if (hardcoded) return `hsl(var(--stage-${hardcoded.cssVar}))`;
    return 'hsl(var(--primary))';
  }, [stageRecords]);

  const setStageLabel = useCallback((stageKey: string, newLabel: string) => {
    const oldLabel = columnLabels[stageKey] ?? '';
    setColumnLabels(prev => ({ ...prev, [stageKey]: newLabel }));
    setStageRecords(prev => prev.map(s => s.key === stageKey ? { ...s, displayName: newLabel } : s));

    renameStage({ stageKey, newDisplayName: newLabel }).catch(() => {
      setColumnLabels(prev => ({ ...prev, [stageKey]: oldLabel }));
      setStageRecords(prev => prev.map(s => s.key === stageKey ? { ...s, displayName: oldLabel } : s));
    });
  }, [columnLabels]);

  const addStage = useCallback(async (name: string, isProduction: boolean, atIndex: number) => {
    const stageKey = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (stageRecords.some(r => r.key === stageKey)) return;

    // Compute optimistic sortOrder so it lands at the right position
    const groupRecords = stageRecords
      .filter(r => r.isProduction === isProduction)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    let newSortOrder: number;
    if (groupRecords.length === 0) newSortOrder = 10;
    else if (atIndex <= 0) newSortOrder = groupRecords[0].sortOrder - 5;
    else if (atIndex >= groupRecords.length) newSortOrder = groupRecords[groupRecords.length - 1].sortOrder + 10;
    else newSortOrder = (groupRecords[atIndex - 1].sortOrder + groupRecords[atIndex].sortOrder) / 2;

    const optimistic: StageInfo = {
      key: stageKey,
      displayName: name,
      shortName: name,
      cssVariable: 'custom',
      sortOrder: newSortOrder,
      isProduction,
    };

    // Optimistic update
    setStageRecords(prev => [...prev, optimistic]);
    setColumnLabels(prev => ({ ...prev, [stageKey]: name }));

    try {
      await createStage({ name, isProduction, atIndex });
      // Refetch all stages so normalized sortOrders are correct for every record
      await fetchAndApply();
    } catch {
      // Revert
      setStageRecords(prev => prev.filter(r => r.key !== stageKey));
      setColumnLabels(prev => { const next = { ...prev }; delete next[stageKey]; return next; });
    }
  }, [stageRecords, fetchAndApply]);

  const reorderStageKeys = useCallback(async (orderedKeys: string[]) => {
    // Optimistic: reassign sortOrder based on new position
    const keyToIdx = new Map(orderedKeys.map((key, idx) => [key, idx]));
    setStageRecords(prev => prev.map(r => {
      const idx = keyToIdx.get(r.key);
      return idx !== undefined ? { ...r, sortOrder: (idx + 1) * 10 } : r;
    }));

    try {
      await reorderStages({ orderedKeys });
    } catch {
      // On failure, refetch from DB
      fetchAndApply().catch(() => {});
    }
  }, [fetchAndApply]);

  const removeStage = useCallback(async (stageKey: string): Promise<{ fallbackStageKey: string | null; reassignedCount: number }> => {
    // Optimistic: remove from local state immediately
    const prevRecords = stageRecords;
    const prevLabels = columnLabels;
    setStageRecords(prev => prev.filter(r => r.key !== stageKey));
    setColumnLabels(prev => { const next = { ...prev }; delete next[stageKey]; return next; });

    try {
      const result = await deleteStage({ stageKey });
      // Refetch to get clean state
      await fetchAndApply();
      return { fallbackStageKey: result.fallbackStageKey, reassignedCount: result.reassignedCount };
    } catch {
      // Revert on failure
      setStageRecords(prevRecords);
      setColumnLabels(prevLabels);
      throw new Error('Failed to delete stage');
    }
  }, [stageRecords, columnLabels, fetchAndApply]);

  return (
    <StageLabelsContext.Provider value={{
      columnLabels,
      stageRecords,
      dealStageKeys,
      productionStageKeys,
      allStageKeys,
      isProductionStage,
      resolveStageKey,
      getStageLabel,
      getStageColor,
      setStageLabel,
      addStage,
      reorderStageKeys,
      removeStage,
      isLoaded,
    }}>
      {children}
    </StageLabelsContext.Provider>
  );
}

export function useStageLabels() {
  return useContext(StageLabelsContext);
}
