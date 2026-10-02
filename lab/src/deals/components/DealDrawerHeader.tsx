import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from '@/deals/ui/motion';
import { Deal, Confidence } from '@/deals/lib/supabase';
import { Stage } from '@/deals/lib/stages';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import InlineEdit from './InlineEdit';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/deals/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/deals/ui/select';
import { Archive, X, ChevronDown, Check, RefreshCw, GitMerge } from 'lucide-react';
import { currencySymbol } from '@/deals/lib/currency';
import { useSync } from '@/deals/context/SyncContext';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'];

const CONF_OPTIONS = [
  { value: 'high' as Confidence,   label: 'High',   bg: 'var(--conf-high-bg)', text: 'var(--conf-high-text)' },
  { value: 'medium' as Confidence, label: 'Medium', bg: 'var(--conf-med-bg)',  text: 'var(--conf-med-text)' },
  { value: 'low' as Confidence,    label: 'Low',    bg: 'var(--conf-low-bg)',  text: 'var(--conf-low-text)' },
];



const DROP_ANIM = {
  initial: { opacity: 0, y: -4, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit:    { opacity: 0, y: -4, scale: 0.97 },
  transition: { duration: 0.15 },
};

function useOutsideClick(ref: React.RefObject<HTMLElement>, cb: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) cb(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, cb]);
}

function PriorityDropdown({ value, onChange }: { value: Confidence | null; onChange: (v: Confidence) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null!);
  useOutsideClick(ref, () => setOpen(false));
  const active = CONF_OPTIONS.find(c => c.value === value);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
          borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          background: active ? active.bg : 'var(--bg-card-hover)',
          color: active ? active.text : 'var(--text-secondary)',
          border: active ? `1px solid color-mix(in srgb, ${active.text} 30%, transparent)` : '1px solid var(--border-color)',
        }}
      >
        {active && <span style={{ width: 8, height: 8, borderRadius: '50%', background: active.text, flexShrink: 0 }} />}
        {active ? active.label : 'Priority'}
        <ChevronDown size={12} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div {...DROP_ANIM} style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 200,
            background: 'var(--bg-shell)', border: '1px solid var(--border-color)',
            borderRadius: 10, boxShadow: 'var(--shadow-elevated)', padding: 4, minWidth: 140,
          }}>
            {CONF_OPTIONS.map(c => (
              <button key={c.value} onClick={() => { onChange(c.value); setOpen(false); }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 7, fontSize: 13, fontWeight: 500,
                  background: value === c.value ? c.bg : 'transparent',
                  color: value === c.value ? c.text : 'var(--text-primary)',
                  border: 'none', cursor: 'pointer',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.text, flexShrink: 0 }} />
                {c.label}
                {value === c.value && <Check size={12} style={{ marginLeft: 'auto', color: c.text }} />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StageDropdown({ value, onChange }: { value: Stage; onChange: (v: Stage) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null!);
  useOutsideClick(ref, () => setOpen(false));
  const { getStageLabel, getStageColor, dealStageKeys, productionStageKeys } = useStageLabels();

  const currentColor = getStageColor(value);
  const currentLabel = getStageLabel(value, value);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
          borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          background: 'var(--accent-bg)', color: 'hsl(var(--primary))',
          border: '1px solid var(--accent-border)',
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: currentColor, flexShrink: 0 }} />
        {currentLabel}
        <ChevronDown size={12} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div {...DROP_ANIM} style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 200,
            background: 'var(--bg-shell)', border: '1px solid var(--border-color)',
            borderRadius: 10, boxShadow: 'var(--shadow-elevated)',
            padding: 4, width: 260, maxHeight: 320, overflowY: 'auto',
          }}>
            {/* Deal stages */}
            {dealStageKeys.length > 0 && (
              <div>
                <p style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '6px 10px 2px' }}>
                  Pipeline
                </p>
                {dealStageKeys.map(sv => (
                  <button key={sv} onClick={() => { onChange(sv as Stage); setOpen(false); }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 10px', borderRadius: 7, fontSize: 14, fontWeight: 400,
                      background: value === sv ? 'var(--bg-card-hover)' : 'transparent',
                      color: 'var(--text-primary)', border: 'none', cursor: 'pointer',
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: getStageColor(sv), flexShrink: 0 }} />
                    {getStageLabel(sv, sv)}
                    {value === sv && <Check size={12} style={{ marginLeft: 'auto', color: 'hsl(var(--primary))' }} />}
                  </button>
                ))}
              </div>
            )}
            {/* Production stages */}
            {productionStageKeys.length > 0 && (
              <div>
                {dealStageKeys.length > 0 && <div style={{ height: 1, background: 'var(--border-light)', margin: '4px 0' }} />}
                <p style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '6px 10px 2px' }}>
                  Production
                </p>
                {productionStageKeys.map(sv => (
                  <button key={sv} onClick={() => { onChange(sv as Stage); setOpen(false); }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 10px', borderRadius: 7, fontSize: 14, fontWeight: 400,
                      background: value === sv ? 'var(--bg-card-hover)' : 'transparent',
                      color: 'var(--text-primary)', border: 'none', cursor: 'pointer',
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: getStageColor(sv), flexShrink: 0 }} />
                    {getStageLabel(sv, sv)}
                    {value === sv && <Check size={12} style={{ marginLeft: 'auto', color: 'hsl(var(--primary))' }} />}
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type RefreshState = 'idle' | 'loading' | 'success' | 'error';

/** Icon buttons in the header: muted, foreground on hover — in both themes. */
const ICON_BTN = 'w-7 h-7 flex items-center justify-center rounded-md bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors';

function RefreshButton({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [state, setState] = useState<RefreshState>('idle');
  const { running } = useSync();

  const handleClick = useCallback(async () => {
    if (state === 'loading') return;
    setState('loading');
    try {
      await onRefresh();
      setState('success');
      setTimeout(() => setState('idle'), 700);
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 1500);
    }
  }, [state, onRefresh]);

  const busy = state === 'loading' || running;
  const iconColor =
    state === 'success' ? 'var(--conf-high-text)' :
    state === 'error'   ? 'hsl(var(--destructive))' :
    undefined;

  return (
    <button
      onClick={handleClick}
      title={running ? 'Gmail sync in progress…' : 'Sync Gmail now and refresh this deal'}
      disabled={busy}
      className={`${ICON_BTN} disabled:cursor-wait`}
      style={iconColor ? { color: iconColor } : undefined}
    >
      {state === 'success' ? (
        <Check size={16} />
      ) : (
        <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
      )}
    </button>
  );
}

interface Props {
  deal: Deal;
  onClose: () => void;
  onDelete: () => void;
  onMerge: () => void;
  onUpdate: (updates: Partial<Deal>) => void;
  onRefresh: () => Promise<void>;
}

export default function DealDrawerHeader({ deal, onClose, onDelete, onMerge, onUpdate, onRefresh }: Props) {
  const [valueInput, setValueInput] = useState(deal.estimated_value?.toString() ?? '');

  useEffect(() => {
    setValueInput(deal.estimated_value?.toString() ?? '');
  }, [deal.estimated_value]);

  // Clearing the field sends estimated_value: null (the server clears it).
  const saveValue = () => {
    const raw = valueInput.trim();
    const current = deal.estimated_value ?? null;
    if (raw === '') { if (current !== null) onUpdate({ estimated_value: null }); return; }
    const n = parseFloat(raw);
    if (isNaN(n)) { setValueInput(current?.toString() ?? ''); return; }
    if (n !== current) onUpdate({ estimated_value: n });
  };

  return (
    <div className="deal-drawer-header-root px-4 sm:px-8 pt-4 sm:pt-6 pb-4 border-b border-border/30 flex-shrink-0 space-y-3"
      style={{ background: 'var(--bg-panel)', position: 'relative' }}>

      {/* Top row: client info + action buttons side-by-side on mobile; buttons absolute on desktop */}
      <div className="flex items-start justify-between gap-2 sm:block">
        {/* Client info */}
        <div className="deal-drawer-client-info min-w-0 flex-1 sm:pr-28">
          <InlineEdit value={deal.client_name} onSave={v => onUpdate({ client_name: v })} className="text-lg sm:text-2xl font-bold text-foreground block w-full" inputClassName="text-lg sm:text-2xl font-bold text-foreground" />
          <InlineEdit value={deal.client_email} onSave={v => onUpdate({ client_email: v })} placeholder="Add email…" className="text-xs sm:text-sm text-muted-foreground mt-1 block w-full" inputClassName="text-xs sm:text-sm text-muted-foreground" />
          <InlineEdit value={deal.project_name ?? ''} onSave={v => onUpdate({ project_name: v || null })} placeholder="Add project name…" className="text-xs text-muted-foreground/60 mt-0.5 block w-full" inputClassName="text-xs text-muted-foreground/60" />
        </div>

        {/* Action buttons — inline on mobile, absolute on desktop */}
        <div className="flex items-center gap-1 flex-shrink-0 sm:absolute sm:top-4 sm:right-4">
          <RefreshButton onRefresh={onRefresh} />

          <button onClick={onMerge} title="Merge with duplicate deal" className={ICON_BTN}>
            <GitMerge size={16} />
          </button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button title="Archive deal" className={ICON_BTN}>
                <Archive size={16} />
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive this deal?</AlertDialogTitle>
                <AlertDialogDescription>It leaves the board and moves to the archive. Nothing is deleted, and you can undo right after.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete}>Archive</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <button onClick={onClose} title="Close" className={ICON_BTN}>
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Controls row */}
      <div className="deal-drawer-controls-row" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Value + Currency */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-muted)' }} title={deal.currency ?? 'USD'}>{currencySymbol(deal.currency)}</span>
          <input
            type="number"
            value={valueInput}
            onChange={e => setValueInput(e.target.value)}
            onBlur={saveValue}
            onKeyDown={e => e.key === 'Enter' && saveValue()}
            placeholder="0"
            style={{
              width: 110, height: 34, fontSize: 14, fontWeight: 700,
              color: 'hsl(var(--primary))', background: 'var(--bg-input)',
              border: '1px solid var(--border-color)', borderRadius: 8,
              padding: '0 8px', outline: 'none', boxSizing: 'border-box',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'hsl(var(--primary))'; }}
            onBlurCapture={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
          />
          <Select value={deal.currency ?? 'USD'} onValueChange={v => onUpdate({ currency: v })}>
            <SelectTrigger style={{ height: 34, width: 78, fontSize: 12, background: 'var(--bg-input)', borderColor: 'var(--border-color)', borderRadius: 8 }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>{[...new Set([...CURRENCIES, (deal.currency ?? 'USD').toUpperCase()])].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: 'var(--border-color)', margin: '0 2px', flexShrink: 0 }} />

        {/* Priority + Stage */}
        <PriorityDropdown value={deal.confidence} onChange={c => onUpdate({ confidence: c })} />
        <StageDropdown value={deal.stage} onChange={s => onUpdate({ stage: s })} />
      </div>
    </div>
  );
}
