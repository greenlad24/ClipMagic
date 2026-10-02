/**
 * The deal workspace's analytics fields — deal type, agreed price, publish
 * month, lost reason (+ won/lost dates). The AI fills them silently from the
 * thread; an "AI" marker shows which ones, with its one-line evidence on hover.
 * Anything typed here is saved as the human's value and never overwritten.
 * Saves go through the workspace's single write path (onUpdate → updateDeal).
 */
import { useEffect, useState } from 'react';
import type { Deal } from '@/deals/lib/supabase';
import { DEAL_TYPE_OPTIONS, LOST_REASON_OPTIONS, type DealFields } from '@/deals/apiAnalytics';

type Key = 'deal_type' | 'agreed_price' | 'slot_month' | 'lost_reason';
const LOST_STAGE_KEYS = new Set(['rejected', 'poor_fit_now']);

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', margin: 0,
  color: 'var(--text-muted)', textTransform: 'uppercase',
};
const INPUT_STYLE: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 14,
  color: 'hsl(var(--foreground))', background: 'hsl(var(--background))',
  border: '1px solid hsl(var(--border))', borderRadius: 6, padding: '5px 8px', height: 32, outline: 'none',
};

function AiMark({ evidence }: { evidence: string | null }) {
  return (
    <span
      title={evidence ? `Filled by AI from the email thread: ${evidence}` : 'Filled by AI from the email thread'}
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '1px 5px', borderRadius: 4,
        color: 'var(--pill-purple-text)', background: 'var(--pill-purple-bg)', cursor: 'help',
      }}
    >AI</span>
  );
}

function fmtDate(iso: string | null) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return iso; }
}

export default function DealFieldsEditor({ deal, onUpdate }: {
  deal: Deal;
  onUpdate: (updates: Partial<Deal>) => Promise<void> | void;
}) {
  const f = deal as unknown as Partial<DealFields>;
  const source = f.fields_source ?? {};
  const [price, setPrice] = useState<string>(f.agreed_price != null ? String(f.agreed_price) : '');
  const [month, setMonth] = useState<string>(f.slot_month ?? '');
  const [saving, setSaving] = useState<Key | null>(null);

  useEffect(() => { setPrice(f.agreed_price != null ? String(f.agreed_price) : ''); }, [deal.id, f.agreed_price]);
  useEffect(() => { setMonth(f.slot_month ?? ''); }, [deal.id, f.slot_month]);

  const save = async (key: Key, value: string | number | null) => {
    const current = (f as any)[key] ?? null;
    if (value === current) return;
    setSaving(key);
    try { await onUpdate({ [key]: value } as unknown as Partial<Deal>); } finally { setSaving(null); }
  };

  const isLost = LOST_STAGE_KEYS.has(String(deal.stage)) || !!f.lost_reason;
  const label = (key: Key, text: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <p style={LABEL_STYLE}>{text}</p>
      {source[key] === 'ai' && <AiMark evidence={f.fields_evidence ?? null} />}
      {saving === key && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Saving…</span>}
    </div>
  );

  return (
    <div>
      <p style={{ ...LABEL_STYLE, marginBottom: 8 }}>Deal facts (analytics)</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div>
          {label('deal_type', 'Type')}
          <select
            aria-label="Deal type"
            value={f.deal_type ?? ''}
            onChange={(e) => save('deal_type', e.target.value || null)}
            style={INPUT_STYLE}
          >
            <option value="">Not set</option>
            {DEAL_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          {label('agreed_price', 'Agreed price (USD)')}
          <input
            aria-label="Agreed price in USD"
            inputMode="numeric"
            value={price}
            placeholder="Not agreed"
            onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
            onBlur={() => {
              const n = price.trim() === '' ? null : Math.round(Number(price));
              if (n !== null && !Number.isFinite(n)) return;
              save('agreed_price', n);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={INPUT_STYLE}
          />
        </div>
        <div>
          {label('slot_month', 'Publish month')}
          <input
            aria-label="Publish month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            onBlur={() => save('slot_month', month || null)}
            style={INPUT_STYLE}
          />
        </div>
        {isLost && (
          <div>
            {label('lost_reason', 'Lost reason')}
            <select
              aria-label="Lost reason"
              value={f.lost_reason ?? ''}
              onChange={(e) => save('lost_reason', e.target.value || null)}
              style={INPUT_STYLE}
            >
              <option value="">Not set</option>
              {LOST_REASON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
      </div>
      {(f.won_at || f.lost_at) && (
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
          {f.won_at && <>Won {fmtDate(f.won_at)}{source.won_at === 'ai' ? ' (estimated from the thread)' : ''}</>}
          {f.won_at && f.lost_at && ' · '}
          {f.lost_at && <>Lost {fmtDate(f.lost_at)}{source.lost_at === 'ai' ? ' (estimated from the thread)' : ''}</>}
        </p>
      )}
    </div>
  );
}
