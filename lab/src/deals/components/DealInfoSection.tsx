import { useState, useRef, useCallback } from 'react';
import { Deal } from '@/deals/lib/supabase';
import { ExternalLink, File, FileText, Image as ImageIcon, Calendar } from 'lucide-react';
import { formatDeadline, formatDeadlineChip, formatShortDay, dealDeadlineYmd } from '@/deals/lib/deadline';
import DeadlineEditor from './DeadlineEditor';
import DealFieldsEditor from './analytics/DealFieldsEditor'; // analytics redesign: AI-filled deal facts

interface Props {
  deal: Deal;
  /** The workspace's single write path (DealDrawer.handleFieldUpdate). */
  onUpdate: (updates: Partial<Deal>) => Promise<void> | void;
}

/** File/link tiles — theme tokens instead of the original's light-only hex. */
const TILE_STYLE: React.CSSProperties = {
  width: 64, padding: '8px 4px', display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', gap: 4,
  background: 'var(--bg-card-hover)', border: '1px solid var(--border-color)', borderRadius: 8,
  cursor: 'pointer', textDecoration: 'none', fontFamily: 'inherit',
};
const TILE_LABEL: React.CSSProperties = {
  fontSize: 10, color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.3,
  maxWidth: 56, overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-all',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatScannedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}

function parseList(val: string | null | undefined): string[] {
  if (!val) return [];
  return val.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url.replace(/^https?:\/\//, '').split('/')[0] ?? url; }
}

const BLOCKED_LINK_DOMAINS = [
  'twitter.com', 'x.com', 'instagram.com', 'linkedin.com',
  'facebook.com', 'youtube.com', 'tiktok.com',
];
function isBlockedLink(url: string): boolean {
  const l = url.toLowerCase();
  if (l.startsWith('mailto:') || l.includes('unsubscribe')) return true;
  return BLOCKED_LINK_DOMAINS.some(d => l.includes(d));
}

type FileIconDef = { Icon: React.FC<{ size: number; color: string }>; color: string };
function getFileIcon(name: string): FileIconDef {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return { Icon: FileText as any, color: '#dc2626' };
  if (['doc', 'docx'].includes(ext)) return { Icon: FileText as any, color: '#2563eb' };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { Icon: FileText as any, color: '#16a34a' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return { Icon: ImageIcon as any, color: '#7c3aed' };
  return { Icon: File as any, color: '#6b7280' };
}

// ── Shared label ─────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', margin: '0 0 6px',
      color: 'var(--text-muted)', textTransform: 'uppercase',
    }}>
      {children}
    </p>
  );
}

// ── "from email · <date>" — a field the autofill keeps current ───────────────

/** Subtle marker on a field the email autofill wrote (fields_source[key] === 'ai'). */
function FromEmail({ deal, field }: { deal: Deal; field: string }) {
  if (deal.fields_source?.[field] !== 'ai') return null;
  const day = formatShortDay(deal.card_asof);
  return (
    <span
      title={`Filled automatically from the email thread${day ? ` (latest email ${day})` : ''}. Edit it to override — your text is kept.`}
      style={{ fontSize: 10, fontWeight: 500, letterSpacing: 0, textTransform: 'none', color: 'var(--text-muted)', opacity: 0.75, cursor: 'help' }}
    >
      from email{day ? ` · ${day}` : ''}
    </span>
  );
}

function LabelRow({ label, hint }: { label: string; hint?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 6px' }}>
      <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', margin: 0, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</p>
      {hint}
    </div>
  );
}

// ── Deadline pill (editable FREE TEXT + the parsed-date chip) ─────────────────

function DeadlineSection({ deal, onSave }: {
  deal: Deal;
  onSave: (val: string | null) => Promise<void>;
}) {
  const value = deal.deadline;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (next: string | null) => {
    setEditing(false);
    if (next === (value ?? null)) return;
    setSaving(true);
    try { await onSave(next); } finally { setSaving(false); }
  };

  const parsed = value ? dealDeadlineYmd(deal) : null;

  return (
    <div>
      <LabelRow label="Deadline" hint={<FromEmail deal={deal} field="deadline" />} />
      {editing ? (
        <DeadlineEditor value={value} onSave={save} onCancel={() => setEditing(false)} className="max-w-[420px]" />
      ) : (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={() => setEditing(true)}
          title="Click to edit the deadline (free text)"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: value ? 'var(--pill-orange-bg)' : 'hsl(var(--muted) / 0.5)',
            border: `1px solid ${value ? 'color-mix(in srgb, var(--pill-orange-text) 35%, transparent)' : 'hsl(var(--border))'}`,
            borderRadius: 20, padding: '4px 12px',
            fontSize: 13, fontWeight: 600,
            color: value ? 'var(--pill-orange-text)' : 'hsl(var(--muted-foreground))',
            cursor: 'pointer', fontFamily: 'inherit',
            transition: 'opacity 0.12s',
          }}
        >
          <Calendar size={12} />
          {saving ? 'Saving\u2026' : (value ? formatDeadline(value) : 'No deadline yet')}
        </button>
        {value && !saving && parsed && formatDeadline(value) !== formatDeadlineChip(parsed) && (
          <span title={`Read as ${parsed}`} style={{ fontSize: 12, color: 'var(--text-muted)' }}>→ {formatDeadlineChip(parsed)}</span>
        )}
        </div>
      )}
    </div>
  );
}

// ── Files icon grid ───────────────────────────────────────────────────────────

function FilesSection({ value }: { value: string | null }) {
  const items = parseList(value);
  if (items.length === 0) return null;
  return (
    <div>
      <SectionLabel>Files</SectionLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {items.filter(item => item.startsWith('http')).map((item, i) => {
          const name = item.split('/').pop() ?? item;
          const { Icon, color } = getFileIcon(name);
          return (
            <a key={i} href={item} target="_blank" rel="noopener noreferrer" title={name} style={TILE_STYLE}>
              <Icon size={20} color={color} />
              <span style={TILE_LABEL}>
                {name}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// ── Links favicon grid ────────────────────────────────────────────────────────

function LinkTile({ url }: { url: string }) {
  const domain = extractDomain(url);
  return (
    <button onClick={() => window.open(url, '_blank')} title={url} style={TILE_STYLE}>
      <img
        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
        alt={domain} width={20} height={20} style={{ borderRadius: 3 }}
        onError={e => { (e.currentTarget as HTMLImageElement).style.opacity = '0'; }}
      />
      <span style={TILE_LABEL}>
        {domain}
      </span>
    </button>
  );
}

function LinksSection({ value }: { value: string | null }) {
  const filtered = parseList(value).filter(u => u.startsWith('http') && !isBlockedLink(u));
  if (filtered.length === 0) return null;
  return (
    <div>
      <SectionLabel>Links</SectionLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {filtered.map((url, i) => <LinkTile key={i} url={url} />)}
      </div>
    </div>
  );
}

// ── Next Steps checklist ──────────────────────────────────────────────────────

function NextStepsSection({ value, hint }: { value: string | null; hint?: React.ReactNode }) {
  const items = (value ?? '')
    .split(/\n|(?=\d+\.)/)
    .map(s => s.replace(/^\d+\.\s*/, '').replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  return (
    <div>
      <LabelRow label="Next Steps" hint={hint} />
      <div style={{
        background: 'var(--pill-green-bg)', border: '1px solid color-mix(in srgb, var(--pill-green-text) 30%, transparent)',
        borderRadius: 10, padding: '12px 16px',
      }}>
        {items.map((step, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: i < items.length - 1 ? 6 : 0 }}>
            <span style={{ color: 'var(--pill-green-text)', marginTop: 2, flexShrink: 0 }}>✓</span>
            <span style={{ fontSize: 14, color: 'var(--pill-green-text)', lineHeight: 1.5 }}>{step}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Gmail Thread button ───────────────────────────────────────────────────────

function GmailThreadSection({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <div>
      <button onClick={() => window.open(url, '_blank')}
        className="hover:bg-muted/60"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 14px',
          fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
          background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
          transition: 'background 0.12s',
        }}
      >
        <ExternalLink size={14} />
        Open Gmail Thread
      </button>
    </div>
  );
}

// ── Editable text section ─────────────────────────────────────────────────────

function EditableTextSection({ label, value, onSave, hint }: {
  label: string;
  value: string | null;
  onSave: (val: string) => Promise<void>;
  hint?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [hovered, setHovered] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const startEdit = useCallback(() => {
    setDraft(value ?? '');
    setEditing(true);
    setTimeout(() => ref.current?.focus(), 0);
  }, [value]);

  const commit = useCallback(async () => {
    if (saving) return;
    setEditing(false);
    if (draft === (value ?? '')) return;
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  }, [draft, value, onSave, saving]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { setEditing(false); setDraft(value ?? ''); }
  };

  return (
    <div>
      <LabelRow label={label} hint={hint} />
      {editing ? (
        <textarea ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
          onBlur={commit} onKeyDown={handleKeyDown}
          rows={Math.max(3, draft.split('\n').length + 1)}
          placeholder={label}
          style={{
            width: '100%', boxSizing: 'border-box', fontFamily: 'inherit',
            fontSize: 14, lineHeight: 1.6, color: 'hsl(var(--foreground))',
            border: '1px solid hsl(var(--border))', borderRadius: 6,
            padding: '8px 10px', background: 'hsl(var(--background))',
            outline: 'none', resize: 'vertical',
          }}
        />
      ) : (
        <div onClick={startEdit}
          onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
          style={{
            cursor: 'text', borderRadius: 6, minHeight: 28,
            padding: hovered ? '4px 6px' : '4px 0',
            background: hovered ? 'hsl(var(--muted) / 0.4)' : 'transparent',
            transition: 'background 0.12s, padding 0.12s',
          }}>
          {saving
            ? <span style={{ fontSize: 14, color: 'var(--text-muted)', fontStyle: 'italic' }}>Saving…</span>
            : !value
            ? <span style={{ fontSize: 14, color: 'hsl(var(--muted-foreground) / 0.35)' }}>—</span>
            : <p style={{ fontSize: 14, color: 'hsl(var(--foreground))', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{value}</p>
          }
        </div>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function DealInfoSection({ deal, onUpdate }: Props) {
  // ONE write per edit: the original called apiUpdateDeal here AND then
  // onUpdate, which wrote the same fields again.
  const save = (key: keyof Deal) => async (val: string | null) => {
    await onUpdate({ [key]: val || null } as Partial<Deal>);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Everything below fills itself from the email thread(s) (server dealAutofill.ts);
          each stays editable, and what Jake types is never overwritten. */}
      <DeadlineSection deal={deal} onSave={save('deadline')} />
      <DealFieldsEditor deal={deal} onUpdate={onUpdate} />
      <EditableTextSection label="Opportunity" value={deal.opportunity} onSave={save('opportunity')} hint={<FromEmail deal={deal} field="opportunity" />} />
      <EditableTextSection label="Key Details" value={deal.key_details} onSave={save('key_details')} hint={<FromEmail deal={deal} field="key_details" />} />
      <FilesSection value={deal.files_text} />
      <LinksSection value={deal.links_text} />
      <NextStepsSection value={deal.next_steps} hint={<FromEmail deal={deal} field="next_steps" />} />
      <EditableTextSection label="Contact Info" value={deal.contact_info} onSave={save('contact_info')} hint={<FromEmail deal={deal} field="contact_info" />} />
      <EditableTextSection label="About" value={deal.about} onSave={save('about')} hint={<FromEmail deal={deal} field="about" />} />
      {deal.last_scanned_at && (
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Last scanned: {formatScannedAt(deal.last_scanned_at)}
        </p>
      )}
    </div>
  );
}
