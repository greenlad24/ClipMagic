/**
 * Deal Organizer — Agent (new in the Lab port; not in the Zite app).
 *
 * The sponsorship email agent: twice a day (default 08:00 + 20:00 Bangkok) it
 * reads the sponsor inbox, decides per thread (draft / skip / spam / flag /
 * ask), writes reply drafts in Jake's voice, and asks Jake on Slack when it
 * needs a decision. It NEVER sends email — at most it saves Gmail drafts.
 *
 * "Save drafts to Gmail" and "Post questions to Slack" are OFF by default =
 * PREVIEW MODE: runs happen and are shown here, but nothing is written to
 * Gmail or Slack.
 *
 * Server contract (POST /api/deals/<fn>): getAgentStatus, updateAgentSettings,
 * runAgentNow (NDJSON), listAgentRuns, getAgentRun, listAgentQuestions,
 * listAgentLessons — see ../api.ts. Until the server has them the calls fail;
 * every panel then shows an empty state (no mock data).
 */
import { LinkedText } from '@/deals/signature';
import { TeachAgentPanel, LessonList } from '@/deals/components/TeachAgent';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Bot, Play, Loader2, Moon, Sun, Clock, Mail, MessageSquare, Power, ExternalLink, CheckCircle2, XCircle,
  AlertTriangle, ShieldAlert, SkipForward, HelpCircle, FileEdit, ChevronDown, ChevronRight, Lightbulb, GraduationCap,
  PenLine, Plus, X, RefreshCw, KanbanSquare, Eye, Target, Send, Archive,
} from 'lucide-react';
import { Button } from '@/deals/ui/button';
import { Skeleton } from '@/deals/ui/skeleton';
import { useTheme } from '@/deals/context/ThemeContext';
import {
  getAgentStatus, updateAgentSettings, runAgentNow, listAgentRuns, getAgentRun, listAgentQuestions, listAgentLessons,
  type AgentStatus, type RunSummary, type AgentItem, type AgentQuestion, type AgentLesson, type AgentDecision,
} from '@/deals/api';
import {
  listAgentFocus, updateFollowUpSettings, runFollowUpsPreview,
  type FollowUpSettings, type FocusListRow, type FocusGrade,
} from '@/deals/apiFocus';

const DEFAULT_TZ = 'Asia/Bangkok';

// ── Formatting ───────────────────────────────────────────────────────────────
function fmtDate(iso: string | null | undefined, tz: string, withDay = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString('en-GB', {
      timeZone: tz,
      ...(withDay ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return d.toLocaleString();
  }
}

function relative(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  const txt = m < 1 ? 'less than a minute' : m < 60 ? `${m} min` : m < 60 * 36 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  return ms >= 0 ? `in ${txt}` : `${txt} ago`;
}

function duration(run: RunSummary): string {
  if (!run.finishedAt) return '';
  const s = Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Decision / verdict styling (Deal Organizer pill tokens) ─────────────────
const DECISION: Record<AgentDecision, { label: string; bg: string; fg: string; icon: typeof FileEdit }> = {
  draft: { label: 'Draft', bg: 'var(--pill-green-bg)', fg: 'var(--pill-green-text)', icon: FileEdit },
  skip: { label: 'Skip', bg: 'var(--pill-gray-bg)', fg: 'var(--pill-gray-text)', icon: SkipForward },
  spam: { label: 'Spam', bg: 'var(--pill-red-bg)', fg: 'var(--pill-red-text)', icon: ShieldAlert },
  flag: { label: 'Flag', bg: 'var(--pill-orange-bg)', fg: 'var(--pill-orange-text)', icon: AlertTriangle },
  ask: { label: 'Ask Jake', bg: 'var(--pill-purple-bg)', fg: 'var(--pill-purple-text)', icon: HelpCircle },
};

const VERDICT: Record<'fit' | 'partial' | 'none', { label: string; bg: string; fg: string }> = {
  fit: { label: 'Good fit', bg: 'var(--pill-green-bg)', fg: 'var(--pill-green-text)' },
  partial: { label: 'Partial fit', bg: 'var(--pill-orange-bg)', fg: 'var(--pill-orange-text)' },
  none: { label: 'Not a fit', bg: 'var(--pill-red-bg)', fg: 'var(--pill-red-text)' },
};

function Chip({ bg, fg, children, title }: { bg: string; fg: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}

function DecisionChip({ decision }: { decision: AgentDecision }) {
  const d = DECISION[decision] ?? DECISION.skip;
  const Icon = d.icon;
  return <Chip bg={d.bg} fg={d.fg}><Icon size={11} /> {d.label}</Chip>;
}

// ── Building blocks ─────────────────────────────────────────────────────────
function Card({ title, sub, icon, right, children, className = '' }: {
  title: string; sub?: ReactNode; icon: ReactNode; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`glass-card rounded-xl p-5 ${className}`}>
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
          {sub && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg p-4 text-center text-xs" style={{ background: 'var(--bg-card-hover)', border: '1px dashed var(--border-color)', color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

function Toggle({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ background: checked ? 'hsl(var(--primary))' : 'var(--border-color)' }}
    >
      <span
        className="inline-block h-5 w-5 rounded-full bg-white shadow"
        style={{ transform: `translateX(${checked ? 22 : 2}px)`, transition: 'transform 150ms ease' }}
      />
    </button>
  );
}

function SwitchRow({ icon, title, desc, checked, busy, disabled, onChange }: {
  icon: ReactNode; title: string; desc: ReactNode; checked: boolean; busy?: boolean; disabled?: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 py-3" style={{ borderTop: '1px solid var(--border-color)' }}>
      <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</p>
        <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{desc}</p>
      </div>
      <div className="flex items-center gap-2">
        {busy && <Loader2 size={13} className="animate-spin" style={{ color: 'var(--text-muted)' }} />}
        <Toggle checked={checked} disabled={disabled || busy} onChange={onChange} label={title} />
      </div>
    </div>
  );
}

function CountsLine({ run }: { run: RunSummary }) {
  const c: RunSummary['counts'] = run.counts ?? { threads: 0, drafted: 0, skipped: 0, spam: 0, flagged: 0, asked: 0 };
  const parts: [string, number][] = [['threads', c.threads], ['drafted', c.drafted], ['skipped', c.skipped], ['spam', c.spam], ['flagged', c.flagged], ['asked', c.asked]];
  if (c.followUps) parts.push(['follow-ups', c.followUps]);
  if (c.closed) parts.push(['auto-closed', c.closed]);
  return (
    <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
      {parts.map(([k, v], i) => (
        <span key={k}>{i > 0 && ' · '}<strong style={{ color: 'var(--text-primary)' }}>{v ?? 0}</strong> {k}</span>
      ))}
    </span>
  );
}

function RunStatus({ run }: { run: RunSummary }) {
  if (run.status === 'running') return <Chip bg="var(--pill-blue-bg)" fg="var(--pill-blue-text)"><Loader2 size={10} className="animate-spin" /> Running</Chip>;
  if (run.status === 'failed') return <Chip bg="var(--pill-red-bg)" fg="var(--pill-red-text)"><XCircle size={10} /> Failed</Chip>;
  return <Chip bg="var(--pill-green-bg)" fg="var(--pill-green-text)"><CheckCircle2 size={10} /> Done</Chip>;
}

// ── One thread the agent handled ────────────────────────────────────────────
function ItemCard({ item, defaultOpen = false }: { item: AgentItem; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const failed = (item.checks ?? []).filter((c) => !c.ok).length;
  const verdict = item.fit ? VERDICT[item.fit.verdict] : null;
  return (
    <div className="rounded-xl" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)' }}>
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left px-4 py-3 flex items-start gap-3">
        <div className="pt-0.5">{open ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <DecisionChip decision={item.decision} />
            {verdict && <Chip bg={verdict.bg} fg={verdict.fg}>{verdict.label}</Chip>}
            {item.edgeCase?.startsWith('Auto-close') && <Chip bg="var(--pill-gray-bg)" fg="var(--pill-gray-text)" title="Moved to a lost column by the follow-up step"><Archive size={10} /> Closed</Chip>}
            {item.edgeCase?.startsWith('Auto-park') && <Chip bg="var(--pill-gray-bg)" fg="var(--pill-gray-text)" title="Moved to Potential Future Collaboration (they said not now)"><Archive size={10} /> Parked</Chip>}
            {item.edgeCase && <Chip bg="var(--pill-purple-bg)" fg="var(--pill-purple-text)" title={/^(Follow-up|Re-engagement)/.test(item.edgeCase) ? 'Follow-up cadence' : 'Edge case'}>{item.edgeCase}</Chip>}
            {(item.checks?.length ?? 0) > 0 && (
              failed > 0
                ? <Chip bg="var(--pill-red-bg)" fg="var(--pill-red-text)"><XCircle size={10} /> {failed} check{failed !== 1 ? 's' : ''} failed</Chip>
                : <Chip bg="var(--pill-green-bg)" fg="var(--pill-green-text)"><CheckCircle2 size={10} /> checks passed</Chip>
            )}
          </div>
          <p className="text-sm font-semibold mt-1.5 truncate" style={{ color: 'var(--text-primary)' }}>{item.subject || '(no subject)'}</p>
          <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
            {item.brand ? <><strong>{item.brand}</strong> · </> : null}{item.from}{item.stage ? ` · ${item.stage}` : ''}
          </p>
          {!open && item.reason && <p className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{item.reason}</p>}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pl-11 space-y-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Why</p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>{item.reason || '—'}</p>
          </div>

          {item.fit && (
            <div className="rounded-lg p-3" style={{ background: 'var(--ai-card-bg)', border: '1px solid var(--ai-card-border)' }}>
              <div className="flex items-center gap-2 mb-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Sponsor fit</p>
                {verdict && <Chip bg={verdict.bg} fg={verdict.fg}>{verdict.label}</Chip>}
              </div>
              {item.fit.angle && <p className="text-xs mb-1" style={{ color: 'var(--text-primary)' }}><strong>Angle:</strong> {item.fit.angle}</p>}
              {item.fit.notes && <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{item.fit.notes}</p>}
            </div>
          )}

          {item.draftText && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
                Draft {item.gmailDraftId ? '— saved in Gmail (not sent)' : '— preview only, not saved to Gmail'}
              </p>
              <div className="rounded-lg p-3 text-sm leading-relaxed whitespace-pre-wrap" style={{ background: 'var(--bg-panel-alt)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
                <LinkedText text={item.draftText} />
              </div>
            </div>
          )}

          {(item.checks?.length ?? 0) > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Pre-save checks</p>
              <ul className="space-y-1">
                {item.checks.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    {c.ok
                      ? <CheckCircle2 size={13} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--pill-green-text)' }} />
                      : <XCircle size={13} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--pill-red-text)' }} />}
                    <span style={{ color: 'var(--text-primary)' }}>
                      <strong>{c.name}</strong>{c.detail ? <span style={{ color: 'var(--text-secondary)' }}> — {c.detail}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 text-xs pt-1">
            {item.gmailUrl && (
              <a href={item.gmailUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium" style={{ color: 'hsl(var(--primary))' }}>
                <Mail size={12} /> Open in Gmail <ExternalLink size={10} />
              </a>
            )}
            {item.slackPermalink && (
              <a href={item.slackPermalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium" style={{ color: 'hsl(var(--primary))' }}>
                <MessageSquare size={12} /> Slack question <ExternalLink size={10} />
              </a>
            )}
            {item.dealId && (
              <Link to={`/deal-organizer/deals/${item.dealId}`} className="inline-flex items-center gap-1 font-medium" style={{ color: 'hsl(var(--primary))' }}>
                <KanbanSquare size={12} /> Open deal
              </Link>
            )}
            <span style={{ color: 'var(--text-muted)' }}>{item.createdAt ? relative(item.createdAt) : ''}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Focus + follow-up cadence (agent/focus.ts + followups.ts) ───────────────
const GRADE_STYLE: Record<FocusGrade, { bg: string; fg: string; title: string }> = {
  A: { bg: 'var(--pill-green-bg)', fg: 'var(--pill-green-text)', title: 'A — best fit, right price, easy to work with: follow-ups at ~5, 12 and 21 days' },
  B: { bg: 'var(--pill-orange-bg)', fg: 'var(--pill-orange-text)', title: 'B — worth a nudge: follow-ups at ~5 and 12 days' },
  C: { bg: 'var(--pill-gray-bg)', fg: 'var(--pill-gray-text)', title: 'C — weak fit, low price or demanding: one follow-up at ~7 days' },
};

function GradePill({ grade, score }: { grade: FocusGrade | null; score: number | null }) {
  if (!grade) return <Chip bg="var(--pill-gray-bg)" fg="var(--pill-gray-text)" title="Not scored yet">—</Chip>;
  const g = GRADE_STYLE[grade];
  return <Chip bg={g.bg} fg={g.fg} title={g.title}>{grade}{score != null ? <span className="font-normal opacity-80"> {score}</span> : null}</Chip>;
}

const ACTION_STYLE: Record<FocusListRow['followUp']['action'], { label: string; bg: string; fg: string }> = {
  followup: { label: 'Follow-up due', bg: 'var(--pill-blue-bg)', fg: 'var(--pill-blue-text)' },
  reengage: { label: 'Re-engage', bg: 'var(--pill-purple-bg)', fg: 'var(--pill-purple-text)' },
  close: { label: 'Closes next run', bg: 'var(--pill-red-bg)', fg: 'var(--pill-red-text)' },
  wait: { label: 'Scheduled', bg: 'var(--pill-gray-bg)', fg: 'var(--pill-gray-text)' },
  blocked: { label: 'On hold', bg: 'var(--pill-orange-bg)', fg: 'var(--pill-orange-text)' },
  none: { label: 'No follow-up', bg: 'var(--pill-gray-bg)', fg: 'var(--pill-gray-text)' },
};

const cadenceText = (d: number[]) => d.join(', ');
const parseCadence = (t: string): number[] | null => {
  const parts = t.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const n = parts.map(Number);
  if (n.some((x) => !Number.isInteger(x) || x < 1 || x > 120)) return null;
  return [...new Set(n)].sort((a, b) => a - b);
};

function NumField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }} title={hint}>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        className="rounded-md px-2 py-1.5 text-sm outline-none w-full"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
      />
    </label>
  );
}

function FollowUpsCard({ settings, saving, onSave, onPreview, previewing }: {
  settings: FollowUpSettings | null; saving: boolean; onSave: (patch: Partial<FollowUpSettings>) => void; onPreview: () => void; previewing: boolean;
}) {
  const toForm = (f: FollowUpSettings) => ({
    A: cadenceText(f.cadence.A), B: cadenceText(f.cadence.B), C: cadenceText(f.cadence.C),
    perRunCap: String(f.perRunCap), closeAfterDays: String(f.closeAfterDays), backlogDays: String(f.backlogDays),
    backlogCloseAfterDays: String(f.backlogCloseAfterDays), closuresPerRunCap: String(f.closuresPerRunCap),
  });
  const [form, setForm] = useState(() => (settings ? toForm(settings) : null));
  useEffect(() => { if (settings) setForm(toForm(settings)); }, [settings]);
  if (!settings || !form) {
    return (
      <Card icon={<Send size={17} />} title="Follow-ups & auto-close" sub="Nudges silent brands — best focus first — and closes deals that went quiet.">
        <Empty>Available once the agent is running on the server.</Empty>
      </Card>
    );
  }
  const base = toForm(settings);
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const cad = { A: parseCadence(form.A), B: parseCadence(form.B), C: parseCadence(form.C) };
  const nums = ['perRunCap', 'closeAfterDays', 'backlogDays', 'backlogCloseAfterDays', 'closuresPerRunCap'] as const;
  const valid = cad.A !== null && cad.B !== null && cad.C !== null && nums.every((k) => /^\d+$/.test(form[k]));
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => f && { ...f, [k]: v });
  return (
    <Card
      icon={<Send size={17} />}
      title="Follow-ups & auto-close"
      sub="When a brand goes silent after your email, the agent drafts a light nudge in your voice — best focus score first — and closes the deal as ghosted once the follow-ups are used up."
      right={
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onPreview} disabled={previewing} title="Preview only — nothing is saved to Gmail or moved on the board">
          {previewing ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />} Preview follow-ups
        </Button>
      }
    >
      <SwitchRow
        icon={<Send size={15} />}
        title="Follow up with silent brands"
        desc={<>Days are counted from your first unanswered email. A follow-up only counts once <strong>you sent it</strong>; while a follow-up draft is waiting, no second one is written. Drafts go to Gmail only when “Save drafts to Gmail” is on.</>}
        checked={settings.followUpsEnabled}
        busy={saving}
        onChange={(v) => onSave({ followUpsEnabled: v })}
      />
      <SwitchRow
        icon={<Archive size={15} />}
        title="Auto-close ghosted deals"
        desc={<>After the last follow-up and {settings.closeAfterDays} more silent days the card moves to <strong>Poor Fit Now</strong> (lost reason “ghosted”). Deals the thread shows are over are tidied too: declined → <strong>Poor Fit Now</strong> / <strong>Rejected</strong> with the lost reason from the thread, “not now” → <strong>Potential Future Collaboration</strong>. Each gets a System comment. Never in production, in Waiting For Invoice/Payment, after a stage move by you in the last 14 days, with an open Slack question or a waiting draft — and never for internal or non-sponsorship cards.</>}
        checked={settings.autoCloseEnabled}
        busy={saving}
        onChange={(v) => onSave({ autoCloseEnabled: v })}
      />
      <div className="pt-3 mt-1 space-y-3" style={{ borderTop: '1px solid var(--border-color)' }}>
        <div>
          <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Cadence <span className="text-[11px] font-normal" style={{ color: 'var(--text-muted)' }}>days after your unanswered email, per focus grade</span></p>
          <div className="grid grid-cols-3 gap-2">
            {(['A', 'B', 'C'] as const).map((g) => (
              <label key={g} className="flex items-center gap-2 rounded-lg px-2 py-1.5" style={{ background: 'var(--bg-card-hover)', border: `1px solid ${cad[g] === null ? 'var(--pill-red-text)' : 'var(--border-color)'}` }}>
                <GradePill grade={g} score={null} />
                <input value={form[g]} onChange={(e) => set(g)(e.target.value)} placeholder="none" className="bg-transparent text-sm outline-none w-full min-w-0" style={{ color: 'var(--text-primary)' }} />
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <NumField label="Drafts per run" value={form.perRunCap} onChange={set('perRunCap')} hint="Max follow-up drafts per run, best focus first" />
          <NumField label="Close after (days)" value={form.closeAfterDays} onChange={set('closeAfterDays')} hint="Silent days after the last follow-up before the auto-close" />
          <NumField label="Backlog after (days)" value={form.backlogDays} onChange={set('backlogDays')} hint="Silent this long: A gets one re-engagement, B/C close" />
          <NumField label="Re-engage close (days)" value={form.backlogCloseAfterDays} onChange={set('backlogCloseAfterDays')} hint="Silent days after the re-engagement before the auto-close" />
          <NumField label="Closes per run" value={form.closuresPerRunCap} onChange={set('closuresPerRunCap')} hint="The backlog is closed gradually" />
        </div>
        {dirty && (
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setForm(base)} className="text-xs px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>Discard</button>
            <Button size="sm" className="h-8" disabled={!valid || saving} onClick={() => onSave({
              cadence: { A: cad.A ?? [], B: cad.B ?? [], C: cad.C ?? [] },
              perRunCap: Number(form.perRunCap), closeAfterDays: Number(form.closeAfterDays), backlogDays: Number(form.backlogDays),
              backlogCloseAfterDays: Number(form.backlogCloseAfterDays), closuresPerRunCap: Number(form.closuresPerRunCap),
            })}>
              {saving && <Loader2 size={12} className="animate-spin" />} Save follow-up settings
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function FocusRowView({ r, tz }: { r: FocusListRow; tz: string }) {
  const [open, setOpen] = useState(false);
  const a = ACTION_STYLE[r.followUp.action] ?? ACTION_STYLE.none;
  return (
    <li className="rounded-lg" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)' }}>
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left px-3 py-2 flex items-start gap-2.5">
        <div className="pt-0.5"><GradePill grade={r.grade} score={r.score} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{r.dealName}</span>
            <Chip bg={a.bg} fg={a.fg}>{a.label}</Chip>
            {r.followUp.action === 'close' && (r.followUp.lostReason || r.followUp.closeKind === 'not_now') && (
              <Chip bg="var(--pill-gray-bg)" fg="var(--pill-gray-text)" title={r.followUp.closeKind === 'not_now' ? 'Moves to Potential Future Collaboration' : `Lost reason on close`}>
                {r.followUp.closeKind === 'not_now' ? '→ Future collab' : r.followUp.lostReason}
              </Chip>
            )}
            {r.followUp.daysSilent != null && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>silent {r.followUp.daysSilent}d</span>}
          </div>
          <p className="text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
            {r.stage}{r.followUp.total ? ` · ${r.followUp.sent}/${r.followUp.total} follow-ups sent` : ''}
          </p>
          <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{r.followUp.status}</p>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-12 space-y-1.5 text-xs">
          {r.reasons ? (
            <>
              <p style={{ color: 'var(--text-primary)' }}><strong>Fit ({r.fit}):</strong> <span style={{ color: 'var(--text-secondary)' }}>{r.reasons.fit || '—'}</span></p>
              <p style={{ color: 'var(--text-primary)' }}><strong>Price ({(r.price ?? '').replace('_', ' ')}):</strong> <span style={{ color: 'var(--text-secondary)' }}>{r.reasons.price || '—'}</span></p>
              <p style={{ color: 'var(--text-primary)' }}><strong>Ease ({r.ease}):</strong> <span style={{ color: 'var(--text-secondary)' }}>{r.reasons.ease || '—'}</span></p>
              {r.reasons.pending && <p style={{ color: 'var(--text-primary)' }}><strong>Waiting on them:</strong> <span style={{ color: 'var(--text-secondary)' }}>{r.reasons.pending}</span></p>}
            </>
          ) : <p style={{ color: 'var(--text-muted)' }}>Not scored yet — scored on the next agent run.</p>}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {r.followUp.dueAt && <span style={{ color: 'var(--text-muted)' }}>Next step {fmtDate(r.followUp.dueAt, tz)} ({relative(r.followUp.dueAt)})</span>}
            {r.followUp.lastJakeAt && <span style={{ color: 'var(--text-muted)' }}>Your last email {fmtDate(r.followUp.lastJakeAt, tz)}</span>}
            <Link to={`/deal-organizer/deals/${r.dealId}`} className="inline-flex items-center gap-1 font-medium" style={{ color: 'hsl(var(--primary))' }}>
              <KanbanSquare size={12} /> Open deal
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}

function FocusCard({ data, tz }: { data: { rows: FocusListRow[]; counts: Record<string, number> } | null; tz: string }) {
  const [filter, setFilter] = useState<'due' | 'all' | FocusGrade>('due');
  const rows = (data?.rows ?? []).filter((r) =>
    filter === 'all' ? true
      : filter === 'due' ? ['followup', 'reengage', 'close', 'blocked'].includes(r.followUp.action)
        : r.grade === filter);
  const c = data?.counts ?? {};
  return (
    <Card
      icon={<Target size={17} />}
      title="Focus"
      sub={<>Open deals by focus score — fit (#41), price vs $6,500–$7,000, and how easy they are to work with. Follow-ups go to the best ones first.</>}
      right={
        <div className="flex rounded-lg p-0.5" style={{ background: 'var(--bg-card-hover)' }}>
          {(['due', 'A', 'B', 'C', 'all'] as const).map((t) => (
            <button key={t} onClick={() => setFilter(t)} className="text-[11px] font-medium px-2 py-1 rounded-md"
              style={filter === t ? { background: 'var(--bg-shell)', color: 'var(--text-primary)', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' } : { color: 'var(--text-muted)' }}>
              {t === 'due' ? 'Due' : t === 'all' ? 'All' : `${t} ${c[t] ?? 0}`}
            </button>
          ))}
        </div>
      }
    >
      {data === null ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
      ) : (
        <>
          <p className="text-[11px] mb-2" style={{ color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{c.followup ?? 0}</strong> follow-ups due · <strong style={{ color: 'var(--text-primary)' }}>{c.reengage ?? 0}</strong> re-engagements · <strong style={{ color: 'var(--text-primary)' }}>{c.close ?? 0}</strong> auto-closes due · <strong style={{ color: 'var(--text-primary)' }}>{c.wait ?? 0}</strong> scheduled{c.unscored ? <> · {c.unscored} not scored yet</> : null}
          </p>
          {rows.length === 0 ? (
            <Empty>{filter === 'due' ? 'Nothing due — every silent deal is on schedule.' : 'No deals here.'}</Empty>
          ) : (
            <ul className="space-y-1.5 max-h-[560px] overflow-y-auto pr-1">
              {rows.map((r) => <FocusRowView key={r.dealId} r={r} tz={tz} />)}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function AgentPage() {
  const { theme, toggleTheme } = useTheme();

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<{ run: RunSummary; items: AgentItem[] } | null>(null);
  const [runLoading, setRunLoading] = useState(false);

  const [questionTab, setQuestionTab] = useState<'open' | 'answered'>('open');
  const [questions, setQuestions] = useState<AgentQuestion[] | null>(null);
  const [lessons, setLessons] = useState<AgentLesson[] | null>(null);

  // Live run
  const [live, setLive] = useState<{ messages: string[]; items: AgentItem[]; result: RunSummary | null; error: string | null } | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Signature + times editors
  const [signature, setSignature] = useState('');
  const [times, setTimes] = useState<string[]>([]);

  const tz = status?.timezone || DEFAULT_TZ;

  // Focus + follow-ups
  const [focus, setFocus] = useState<{ rows: FocusListRow[]; counts: Record<string, number> } | null>(null);
  const loadFocus = useCallback(async () => {
    try {
      const r = await listAgentFocus();
      setFocus({ rows: r.rows ?? [], counts: r.counts ?? {} });
    } catch {
      setFocus({ rows: [], counts: {} });
    }
  }, []);
  useEffect(() => { loadFocus(); }, [loadFocus]);
  const followUpSettings = status?.followUps ?? null;
  const saveFollowUps = async (patch: Partial<FollowUpSettings>) => {
    setSaving('followUps');
    try {
      const s = await updateFollowUpSettings(patch);
      setStatus(s);
      toast.success('Follow-up settings saved');
      loadFocus();
    } catch (e) {
      toast.error(`Could not save: ${errMsg(e)}`);
    } finally {
      setSaving(null);
    }
  };

  const loadStatus = useCallback(async () => {
    try {
      const s = await getAgentStatus();
      setStatus(s);
      setStatusError(null);
      setSignature(s.signature ?? '');
      setTimes(s.times ?? []);
    } catch (e) {
      setStatusError(errMsg(e));
      toast.error(`Agent status unavailable: ${errMsg(e)}`);
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const r = await listAgentRuns({ limit: 20 });
      setRuns(r.runs ?? []);
    } catch {
      setRuns([]);
    }
  }, []);

  const loadQuestions = useCallback(async (tab: 'open' | 'answered') => {
    setQuestions(null);
    try {
      const r = await listAgentQuestions({ status: tab });
      setQuestions(r.questions ?? []);
    } catch {
      setQuestions([]);
    }
  }, []);

  const loadLessons = useCallback(async () => {
    try {
      const r = await listAgentLessons({ limit: 50 });
      setLessons(r.lessons ?? []);
    } catch {
      setLessons([]);
    }
  }, []);

  useEffect(() => { loadStatus(); loadRuns(); loadLessons(); }, [loadStatus, loadRuns, loadLessons]);
  useEffect(() => { loadQuestions(questionTab); }, [questionTab, loadQuestions]);

  const openRun = useCallback(async (id: string) => {
    if (selectedRunId === id) { setSelectedRunId(null); setRunDetail(null); return; }
    setSelectedRunId(id);
    setRunDetail(null);
    setRunLoading(true);
    try {
      setRunDetail(await getAgentRun({ id }));
    } catch (e) {
      toast.error(`Could not load that run: ${errMsg(e)}`);
      setSelectedRunId(null);
    } finally {
      setRunLoading(false);
    }
  }, [selectedRunId]);

  const save = async (key: string, patch: Parameters<typeof updateAgentSettings>[0], okMsg?: string) => {
    setSaving(key);
    try {
      const s = await updateAgentSettings(patch);
      setStatus(s);
      setSignature(s.signature ?? '');
      setTimes(s.times ?? []);
      if (okMsg) toast.success(okMsg);
    } catch (e) {
      toast.error(`Could not save: ${errMsg(e)}`);
    } finally {
      setSaving(null);
    }
  };

  const runNow = async () => {
    if (runningNow) return;
    setRunningNow(true);
    setLive({ messages: ['Starting a preview run…'], items: [], result: null, error: null });
    try {
      const s = runAgentNow({ preview: true });
      for await (const chunk of s) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'progress') setLive((l) => l && { ...l, messages: [...l.messages, chunk.message] });
        else if (chunk.type === 'item') setLive((l) => l && { ...l, items: [...l.items, chunk.item] });
      }
      const result = await s.result;
      setLive((l) => l && { ...l, result });
      toast.success('Preview run finished — nothing was saved to Gmail or posted to Slack');
      loadRuns();
      loadStatus();
      loadQuestions(questionTab);
    } catch (e) {
      setLive((l) => l && { ...l, error: errMsg(e) });
      toast.error(`Run failed: ${errMsg(e)}`);
    } finally {
      setRunningNow(false);
    }
  };

  const previewFollowUps = async () => {
    if (runningNow) return;
    setRunningNow(true);
    setLive({ messages: ['Starting a follow-ups preview…'], items: [], result: null, error: null });
    try {
      const s = runFollowUpsPreview();
      for await (const chunk of s) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'progress') setLive((l) => l && { ...l, messages: [...l.messages, chunk.message] });
        else if (chunk.type === 'item') setLive((l) => l && { ...l, items: [...l.items, chunk.item] });
      }
      const result = await s.result;
      setLive((l) => l && { ...l, result });
      toast.success('Follow-ups preview finished — nothing was saved to Gmail or moved on the board');
      loadRuns();
      loadFocus();
    } catch (e) {
      setLive((l) => l && { ...l, error: errMsg(e) });
      toast.error(`Preview failed: ${errMsg(e)}`);
    } finally {
      setRunningNow(false);
    }
  };

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [live?.messages.length]);

  const preview = status ? !status.saveToGmail && !status.postToSlack : true;
  const timesDirty = status ? JSON.stringify(times) !== JSON.stringify(status.times ?? []) : false;
  const sigDirty = status ? signature !== (status.signature ?? '') : false;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar */}
      <div className="glass-nav flex-shrink-0 px-6 flex items-center gap-4" style={{ height: 60 }}>
        <h1 className="text-[20px] font-bold text-foreground shrink-0">Agent</h1>
        {status && (
          <span className="hidden md:inline-flex">
            {preview
              ? <Chip bg="var(--pill-blue-bg)" fg="var(--pill-blue-text)"><Eye size={11} /> Preview mode</Chip>
              : <Chip bg="var(--pill-orange-bg)" fg="var(--pill-orange-text)"><Power size={11} /> Live — writes {[status.saveToGmail && 'Gmail drafts', status.postToSlack && 'Slack questions'].filter(Boolean).join(' + ')}</Chip>}
          </span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <Button variant="ghost" size="sm" onClick={toggleTheme} className="h-9 w-9 p-0 text-muted-foreground"
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}>
            {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { loadStatus(); loadRuns(); loadLessons(); loadQuestions(questionTab); loadFocus(); }}
            className="h-9 px-2.5 text-xs text-muted-foreground gap-1.5" title="Refresh">
            <RefreshCw size={13} /> <span className="hidden sm:inline">Refresh</span>
          </Button>
          <Button size="sm" onClick={runNow} disabled={runningNow || !!status?.running}
            className="h-9 text-[14px] font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-[8px] px-[18px]">
            {runningNow || status?.running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            <span className="hidden sm:inline">{runningNow ? 'Running…' : status?.running ? 'A run is in progress' : 'Run now (preview)'}</span>
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ background: 'var(--bg-page)' }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-5">
          {/* ── Left column ── */}
          <div className="space-y-5 min-w-0">
            {/* Status + switches */}
            <Card
              icon={<Bot size={17} />}
              title="Sponsorship email agent"
              sub="Reads the sponsor inbox twice a day, sorts every new thread, and drafts replies in your voice. It never sends an email."
              right={status && (status.running
                ? <Chip bg="var(--pill-blue-bg)" fg="var(--pill-blue-text)"><Loader2 size={10} className="animate-spin" /> Running</Chip>
                : status.enabled
                  ? <Chip bg="var(--pill-green-bg)" fg="var(--pill-green-text)"><CheckCircle2 size={10} /> On</Chip>
                  : <Chip bg="var(--pill-gray-bg)" fg="var(--pill-gray-text)">Off</Chip>)}
            >
              {!status ? (
                statusError ? (
                  <Empty>
                    The agent isn&apos;t available on the server yet ({statusError}).
                    <div className="mt-2"><button onClick={loadStatus} className="underline font-medium" style={{ color: 'hsl(var(--primary))' }}>Try again</button></div>
                  </Empty>
                ) : (
                  <div className="space-y-2"><Skeleton className="h-12 rounded-lg" /><Skeleton className="h-12 rounded-lg" /><Skeleton className="h-12 rounded-lg" /></div>
                )
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-2">
                    <div className="rounded-lg p-3" style={{ background: 'var(--bg-card-hover)' }}>
                      <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Next run</p>
                      <p className="text-sm font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
                        {status.enabled ? (status.nextRunAt ? fmtDate(status.nextRunAt, tz) : '—') : 'Not scheduled (agent is off)'}
                      </p>
                      {status.enabled && status.nextRunAt && <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{relative(status.nextRunAt)} · {tz}</p>}
                    </div>
                    <div className="rounded-lg p-3" style={{ background: 'var(--bg-card-hover)' }}>
                      <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Last run</p>
                      {status.lastRun ? (
                        <>
                          <p className="text-sm font-semibold mt-1 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            {fmtDate(status.lastRun.startedAt, tz)} <RunStatus run={status.lastRun} />
                          </p>
                          <CountsLine run={status.lastRun} />
                        </>
                      ) : <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Never run</p>}
                    </div>
                  </div>

                  <SwitchRow
                    icon={<Power size={15} />}
                    title="Enabled"
                    desc={<>Runs on its own at the scheduled times below. Off = it only runs when you press <strong>Run now</strong>.</>}
                    checked={status.enabled}
                    busy={saving === 'enabled'}
                    onChange={(v) => save('enabled', { enabled: v }, v ? 'Agent turned on' : 'Agent turned off')}
                  />
                  <SwitchRow
                    icon={<Mail size={15} />}
                    title="Save drafts to Gmail"
                    desc={<>On: reply drafts are saved as <strong>Gmail drafts</strong> in the sponsor inbox for you to review and send yourself. Off: drafts only appear on this page. Either way, nothing is ever sent.</>}
                    checked={status.saveToGmail}
                    busy={saving === 'saveToGmail'}
                    onChange={(v) => save('saveToGmail', { saveToGmail: v }, v ? 'Drafts will be saved to Gmail' : 'Drafts stay on this page only')}
                  />
                  <SwitchRow
                    icon={<MessageSquare size={15} />}
                    title="Post questions to Slack"
                    desc={<>On: when it needs a decision (a conflict, a price below the floor, a missing link, anything risky) it asks you in Slack. Off: the questions are only listed on this page.</>}
                    checked={status.postToSlack}
                    busy={saving === 'postToSlack'}
                    onChange={(v) => save('postToSlack', { postToSlack: v }, v ? 'Questions will be posted to Slack' : 'Questions stay on this page only')}
                  />
                  {preview && (
                    <div className="flex items-start gap-2 rounded-lg p-3 mt-1 text-xs leading-relaxed" style={{ background: 'var(--pill-blue-bg)', color: 'var(--pill-blue-text)' }}>
                      <Eye size={13} className="flex-shrink-0 mt-0.5" />
                      <span>
                        <strong>Preview mode.</strong> With both switches off the agent still reads the inbox and decides what it would do, but it writes nothing to Gmail and posts nothing to Slack. Everything it would have done is shown on this page, so you can check its judgement first.
                      </span>
                    </div>
                  )}

                  {/* Schedule */}
                  <div className="pt-3 mt-1" style={{ borderTop: '1px solid var(--border-color)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Clock size={14} style={{ color: 'var(--text-muted)' }} />
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Schedule</p>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>daily, {tz}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {times.map((t, i) => (
                        <span key={i} className="inline-flex items-center gap-1 rounded-lg pl-2 pr-1 py-1" style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-color)' }}>
                          <input
                            type="time"
                            value={t}
                            onChange={(e) => setTimes((ts) => ts.map((x, j) => (j === i ? e.target.value : x)))}
                            className="bg-transparent text-sm outline-none"
                            style={{ color: 'var(--text-primary)', colorScheme: theme === 'dark' ? 'dark' : 'light' }}
                          />
                          <button onClick={() => setTimes((ts) => ts.filter((_, j) => j !== i))} title="Remove" className="p-0.5 rounded hover:bg-muted" style={{ color: 'var(--text-muted)' }}>
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                      <button onClick={() => setTimes((ts) => [...ts, '12:00'])} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg" style={{ border: '1px dashed var(--border-color)', color: 'var(--text-muted)' }}>
                        <Plus size={12} /> Add time
                      </button>
                      {timesDirty && (
                        <Button size="sm" className="h-8" disabled={saving === 'times' || times.some((t) => !/^\d{2}:\d{2}$/.test(t))}
                          onClick={() => save('times', { times: [...times].sort() }, 'Schedule saved')}>
                          {saving === 'times' && <Loader2 size={12} className="animate-spin" />} Save schedule
                        </Button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </Card>

            {/* Follow-ups & auto-close + the Focus list */}
            <FollowUpsCard settings={followUpSettings} saving={saving === 'followUps'} onSave={saveFollowUps} onPreview={previewFollowUps} previewing={runningNow} />

            {/* Live run */}
            {live && (
              <Card
                icon={<Play size={17} />}
                title={runningNow ? 'Running now (preview)…' : live.error ? 'Preview run failed' : 'Preview run finished'}
                sub="Preview runs never save to Gmail or post to Slack."
                right={!runningNow && <button onClick={() => setLive(null)} className="p-1 rounded hover:bg-muted" style={{ color: 'var(--text-muted)' }} title="Close"><X size={14} /></button>}
              >
                <div ref={logRef} className="rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-[11px] space-y-0.5" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                  {live.messages.map((m, i) => <div key={i}>› {m}</div>)}
                  {runningNow && <div className="flex items-center gap-1.5" style={{ color: 'hsl(var(--primary))' }}><Loader2 size={10} className="animate-spin" /> working…</div>}
                  {live.error && <div style={{ color: 'var(--pill-red-text)' }}>✕ {live.error}</div>}
                </div>
                {live.result && <div className="mt-2"><CountsLine run={live.result} /></div>}
                {live.items.length > 0 && (
                  <div className="space-y-2 mt-3">
                    {live.items.map((it) => <ItemCard key={it.id} item={it} />)}
                  </div>
                )}
              </Card>
            )}

            <FocusCard data={focus} tz={tz} />

            {/* Recent runs */}
            <Card icon={<RefreshCw size={17} />} title="Recent runs" sub="Open a run to see every thread it looked at and what it decided.">
              {runs === null ? (
                <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
              ) : runs.length === 0 ? (
                <Empty>No runs yet. Press <strong>Run now (preview)</strong> to see what the agent would do with your inbox.</Empty>
              ) : (
                <div className="space-y-2">
                  {runs.map((run) => {
                    const open = selectedRunId === run.id;
                    return (
                      <div key={run.id} className="rounded-xl" style={{ border: `1px solid ${open ? 'hsl(var(--primary) / 0.4)' : 'var(--border-color)'}`, background: open ? 'var(--bg-panel-alt)' : 'transparent' }}>
                        <button onClick={() => openRun(run.id)} className="w-full text-left px-3 py-2.5 flex items-center gap-3 rounded-xl hover:bg-muted/40">
                          {open ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{fmtDate(run.startedAt, tz)}</span>
                              <RunStatus run={run} />
                              <Chip bg="var(--pill-gray-bg)" fg="var(--pill-gray-text)">{run.trigger === 'schedule' ? 'Scheduled' : 'Manual'}</Chip>
                              {run.preview && <Chip bg="var(--pill-blue-bg)" fg="var(--pill-blue-text)"><Eye size={10} /> Preview</Chip>}
                              {duration(run) && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{duration(run)}</span>}
                            </div>
                            <CountsLine run={run} />
                            {run.error && <p className="text-[11px] mt-0.5" style={{ color: 'var(--pill-red-text)' }}>{run.error}</p>}
                          </div>
                        </button>
                        {open && (
                          <div className="px-3 pb-3 space-y-2">
                            {runLoading || !runDetail ? (
                              <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
                            ) : runDetail.items.length === 0 ? (
                              <Empty>This run found no new threads to handle.</Empty>
                            ) : (
                              runDetail.items.map((it) => <ItemCard key={it.id} item={it} />)
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* ── Right column ── */}
          <div className="space-y-5 min-w-0">
            {/* Slack questions */}
            <Card
              icon={<HelpCircle size={17} />}
              title="Questions for you"
              sub="Decisions the agent needed from you on Slack."
              right={
                <div className="flex rounded-lg p-0.5" style={{ background: 'var(--bg-card-hover)' }}>
                  {(['open', 'answered'] as const).map((t) => (
                    <button key={t} onClick={() => setQuestionTab(t)} className="text-[11px] font-medium px-2.5 py-1 rounded-md capitalize"
                      style={questionTab === t ? { background: 'var(--bg-shell)', color: 'var(--text-primary)', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' } : { color: 'var(--text-muted)' }}>
                      {t}
                    </button>
                  ))}
                </div>
              }
            >
              {questions === null ? (
                <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
              ) : questions.length === 0 ? (
                <Empty>{questionTab === 'open' ? 'No open questions.' : 'No answered questions yet.'}</Empty>
              ) : (
                <ul className="space-y-2">
                  {questions.map((q) => (
                    <li key={q.id} className="rounded-lg p-3" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)' }}>
                      <p className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{q.subject}</p>
                      <p className="text-sm mt-0.5 leading-snug" style={{ color: 'var(--text-primary)' }}>{q.question}</p>
                      {q.answer && (
                        <p className="text-xs mt-1.5 rounded-md px-2 py-1.5" style={{ background: 'var(--pill-green-bg)', color: 'var(--pill-green-text)' }}>
                          <strong>Answer:</strong> {q.answer}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <span>Asked {relative(q.askedAt)}</span>
                        {q.answeredAt && <span>· answered {relative(q.answeredAt)}</span>}
                        {q.slackPermalink && (
                          <a href={q.slackPermalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium ml-auto" style={{ color: 'hsl(var(--primary))' }}>
                            Open in Slack <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Teach it a rule (Lab) — the same as "rule: …" in Slack */}
            <Card icon={<GraduationCap size={17} />} title="Teach the agent a rule" sub="Paste a conversation with your partner, or write the rule. It tells you what it understood before anything is saved. Your rules override the rulebook.">
              <TeachAgentPanel />
            </Card>

            {/* Lessons */}
            <Card icon={<Lightbulb size={17} />} title="What it has learned" sub="From your edits to its drafts and your Slack answers. Edit or delete anything it got wrong.">
              {lessons === null ? (
                <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
              ) : lessons.length === 0 ? (
                <Empty>Nothing learned yet. Lessons appear after you edit its drafts or answer its questions.</Empty>
              ) : (
                <LessonList lessons={lessons} onChanged={() => void loadLessons()} />
              )}
            </Card>

            {/* Signature */}
            <Card icon={<PenLine size={17} />} title="Email signature" sub="Added to the end of every draft the agent writes.">
              {!status ? (
                <Empty>Available once the agent is running on the server.</Empty>
              ) : (
                <>
                  <textarea
                    value={signature}
                    onChange={(e) => setSignature(e.target.value)}
                    rows={7}
                    placeholder={'Best,\nJake Dawson\n…'}
                    className="w-full rounded-lg p-3 text-sm leading-relaxed resize-y outline-none font-mono"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                  />
                  <div className="flex items-center justify-end gap-2 mt-2">
                    {sigDirty && (
                      <button onClick={() => setSignature(status.signature ?? '')} className="text-xs px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>Discard</button>
                    )}
                    <Button size="sm" className="h-8" disabled={!sigDirty || saving === 'signature'} onClick={() => save('signature', { signature }, 'Signature saved')}>
                      {saving === 'signature' && <Loader2 size={12} className="animate-spin" />} Save signature
                    </Button>
                  </div>
                </>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
