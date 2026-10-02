import { useState, useRef } from 'react';
import { Deal, Action, apiAddAction, apiUpdateActionStatus } from '@/deals/lib/supabase';
import { CheckSquare, Square, Loader2, CheckCircle2, Plus, Clipboard, MoreHorizontal, Check, Undo2, Play } from 'lucide-react';
import { Skeleton } from '@/deals/ui/skeleton';
import { toast } from 'sonner';
import { formatShortDay } from '@/deals/lib/deadline';

interface Props {
  deal: Deal;
  actions: Action[];
  loading: boolean;
  onActionsChange: (actions: Action[]) => void;
}

// The to-do list keeps ITSELF current from the email thread (server
// dealAutofill.ts, every sync): it adds the next steps ("Send contract", "Wait for
// payment", "Send script for approval by …"), ticks the ones the thread shows
// happened and drops its own that no longer apply. Nothing here asks Jake to type
// — the manual "Add default to-dos" / "Generate" buttons are gone (2026-09-30).
// A status Jake sets is his from then on (the autofill never changes it).
// Explicit status changes (the original cycled pending → in progress → done).
// There is no delete endpoint for to-dos, so Delete is not offered.

function StatusIcon({ status }: { status: Action['status'] }) {
  if (status === 'done')        return <CheckCircle2 size={16} style={{ color: 'var(--conf-high-text)', flexShrink: 0 }} />;
  if (status === 'in_progress') return <Loader2 size={16} className="animate-spin" style={{ color: 'hsl(var(--primary))', flexShrink: 0 }} />;
  return <Square size={16} style={{ color: 'var(--border-color)', flexShrink: 0 }} />;
}

function TodoItem({ action, onSetStatus }: {
  action: Action;
  onSetStatus: (status: Action['status']) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isDone = action.status === 'done';
  const onToggle = () => onSetStatus(isDone ? 'pending' : 'done');
  const auto = action.source === 'auto' || action.status_by === 'auto';
  const autoTitle = action.status_by === 'auto'
    ? `Ticked automatically from the email thread${action.updated_at ? ` (${formatShortDay(action.updated_at)})` : ''}`
    : 'Added automatically from the email thread';

  return (
    <div
      className="group/todo"
      style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-light)', position: 'relative' }}
      onMouseLeave={() => setMenuOpen(false)}
    >
      <button onClick={onToggle} title={isDone ? 'Mark as not done' : 'Mark as done'} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 1, flexShrink: 0 }}>
        <StatusIcon status={action.status} />
      </button>
      <span
        onClick={onToggle}
        style={{
          fontSize: 13, color: isDone ? 'var(--text-muted)' : 'var(--text-primary)',
          lineHeight: 1.5, flex: 1, textDecoration: isDone ? 'line-through' : 'none',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        {action.content}
        {auto && (
          <span title={autoTitle} style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)', opacity: 0.7, textDecoration: 'none', display: 'inline-block', cursor: 'help' }}>
            from email
          </span>
        )}
      </span>

      {/* ··· overflow menu */}
      <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          onClick={() => setMenuOpen(o => !o)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
            borderRadius: 5, color: 'var(--text-muted)',
          }}
          className="opacity-0 group-hover/todo:opacity-100 focus:opacity-100 transition-opacity"
          title="More"
        >
          <MoreHorizontal size={13} />
        </button>
        {menuOpen && (
          <div style={{
            position: 'absolute', right: 0, top: '100%', zIndex: 50,
            background: 'var(--bg-shell)', border: '1px solid var(--border-color)',
            borderRadius: 8, boxShadow: 'var(--shadow-elevated)', padding: 4, minWidth: 130,
          }}>
            {isDone ? (
              <button
                onClick={() => { onSetStatus('pending'); setMenuOpen(false); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 5, fontSize: 13, color: 'var(--text-primary)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <Undo2 size={13} style={{ color: 'var(--text-secondary)' }} /> Mark not done
              </button>
            ) : (
              <>
                <button
                  onClick={() => { onSetStatus('done'); setMenuOpen(false); }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 5, fontSize: 13, color: 'var(--text-primary)', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  <Check size={13} style={{ color: 'var(--conf-high-text)' }} /> Mark done
                </button>
                {action.status === 'pending' ? (
                  <button
                    onClick={() => { onSetStatus('in_progress'); setMenuOpen(false); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 5, fontSize: 13, color: 'var(--text-primary)', background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    <Play size={13} style={{ color: 'hsl(var(--primary))' }} /> Mark in progress
                  </button>
                ) : (
                  <button
                    onClick={() => { onSetStatus('pending'); setMenuOpen(false); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 5, fontSize: 13, color: 'var(--text-primary)', background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    <Undo2 size={13} style={{ color: 'var(--text-secondary)' }} /> Back to to-do
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TodoListSection({ deal, actions, loading, onActionsChange }: Props) {
  const [inputVisible, setInputVisible] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!inputValue.trim()) return;
    setAdding(true);
    try {
      const action = await apiAddAction(deal.id, inputValue.trim());
      onActionsChange([...actions, action]);
      setInputValue('');
      setInputVisible(false);
    } finally { setAdding(false); }
  };

  const handleSetStatus = async (action: Action, next: Action['status']) => {
    if (action.status === next) return;
    const prev = actions;
    onActionsChange(actions.map(a => a.id === action.id ? { ...a, status: next, status_by: 'human' } : a));
    try {
      await apiUpdateActionStatus(action.id, next);
    } catch {
      onActionsChange(prev);
      toast.error('Could not update the to-do');
    }
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <CheckSquare size={14} style={{ color: 'hsl(var(--primary))' }} />
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-secondary)' }}>
            To-Do List
          </span>
        </div>
      </div>

      {/* Items */}
      <div style={{ marginBottom: 10 }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 8 }}>
            <Skeleton className="h-5 rounded" style={{ width: '80%' }} />
            <Skeleton className="h-5 rounded" style={{ width: '60%' }} />
            <Skeleton className="h-5 rounded" style={{ width: '50%' }} />
          </div>
        ) : actions.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 0' }}>
            <Clipboard size={14} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              {deal.card_filled_at ? 'Nothing to do right now' : 'To-dos appear here from the email thread'}
            </p>
          </div>
        ) : (
          actions.map(action => (
            <TodoItem
              key={action.id}
              action={action}
              onSetStatus={next => handleSetStatus(action, next)}
            />
          ))
        )}
      </div>

      {/* Add input */}
      {inputVisible ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            autoFocus
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAdd();
              if (e.key === 'Escape') { setInputVisible(false); setInputValue(''); }
            }}
            placeholder="Add a to-do..."
            style={{
              flex: 1, height: 32, fontSize: 13, padding: '0 10px',
              background: 'var(--bg-input)', border: '1px solid var(--border-color)',
              borderRadius: 7, outline: 'none', color: 'var(--text-primary)',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'hsl(var(--primary))'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
          />
          <button
            onClick={handleAdd}
            disabled={adding || !inputValue.trim()}
            style={{
              height: 32, padding: '0 12px', fontSize: 12, fontWeight: 600,
              background: 'hsl(var(--primary))', color: '#fff', border: 'none',
              borderRadius: 7, cursor: 'pointer', opacity: adding || !inputValue.trim() ? 0.5 : 1,
            }}
          >
            Add
          </button>
        </div>
      ) : (
        <button
          onClick={() => setInputVisible(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
          className="hover:text-foreground transition-colors"
        >
          <Plus size={12} /> Add to-do
        </button>
      )}
    </div>
  );
}
