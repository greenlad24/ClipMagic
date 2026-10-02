import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, CheckCircle2, Brain, Info, Sun, Moon, Sparkles, AlertCircle, PauseCircle, Stethoscope } from 'lucide-react';
import { useTheme } from '@/deals/context/ThemeContext';
import ConnectionsSection from '@/deals/components/ConnectionsSection';
import { getIntegrationsStatus, getAgentStatus, type IntegrationsStatus, type AgentStatus } from '@/deals/api';
import { useSync } from '@/deals/context/SyncContext';

// ─── Status pill ──────────────────────────────────────────────────────────────

type PillTone = 'ok' | 'warn' | 'off' | 'neutral';
function StatusPill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  const colors: Record<PillTone, { color: string; background: string }> = {
    ok:      { color: 'var(--pill-green-text)',  background: 'var(--pill-green-bg)' },
    warn:    { color: 'var(--pill-orange-text)', background: 'var(--pill-orange-bg)' },
    off:     { color: 'var(--pill-red-text)',    background: 'var(--pill-red-bg)' },
    neutral: { color: 'var(--pill-gray-text)',   background: 'var(--pill-gray-bg)' },
  };
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'off' ? AlertCircle : tone === 'warn' ? PauseCircle : Info;
  return (
    <div className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full flex-shrink-0" style={colors[tone]}>
      <Icon size={11} /> {children}
    </div>
  );
}

/** Optional AI-key status, if the server reports it (older servers don't). */
type AiKeyStatus = { configured?: boolean } | undefined;
function aiStatus(s: IntegrationsStatus | null, which: 'claude' | 'gemini'): AiKeyStatus {
  const ai = (s as unknown as { ai?: Record<string, AiKeyStatus> } | null)?.ai;
  return ai?.[which];
}

const TZ = 'Asia/Bangkok';
function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

// ─── Appearance Card ──────────────────────────────────────────────────────────

function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="glass-card rounded-xl p-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--bg-card-hover)' }}>
          {theme === 'light' ? <Sun size={17} style={{ color: 'var(--text-secondary)' }} /> : <Moon size={17} style={{ color: 'var(--text-secondary)' }} />}
        </div>
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Appearance</h3>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Choose how Deal Organizer looks</p>
        </div>
      </div>
      <div>
        <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>Theme</p>
        <div className="flex items-center gap-3">
          {(['light', 'dark'] as const).map(value => {
            const active = theme === value;
            const Icon = value === 'light' ? Sun : Moon;
            return (
              <button key={value} onClick={() => setTheme(value)} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '12px 24px', borderRadius: 10, cursor: 'pointer',
                background: active ? '#FF7420' : 'var(--bg-card-hover)',
                border: active ? 'none' : '1px solid var(--border-color)',
                color: active ? '#FFFFFF' : 'var(--text-secondary)',
                fontSize: 14, fontWeight: active ? 600 : 400,
                transition: 'background 150ms, color 150ms',
              }}>
                <Icon size={16} />{value.charAt(0).toUpperCase() + value.slice(1)}
              </button>
            );
          })}
        </div>
        <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
          Saved automatically. Changes apply instantly — no page reload needed.
        </p>
      </div>
    </div>
  );
}

// ─── Gmail Accounts → Connections ─────────────────────────────────────────────
// Lab port: the original "Gmail Accounts" card (popup OAuth through
// getGmailAuthUrl + /gmail-callback, Reconnect, ✕ remove) is replaced by the
// Connections section — the Lab owns the one Gmail grant, plus YouTube
// Analytics and Slack. See components/ConnectionsSection.tsx.

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage({ section }: { section?: 'connections' }) {
  // /deal-organizer/connections opens Settings scrolled to Connections (the Gmail OAuth flow returns there).
  const connectionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (section === 'connections') connectionsRef.current?.scrollIntoView({ block: 'start' });
  }, [section]);

  // Real status for the cards below (the original always said "Connected"/"Active").
  const [integrations, setIntegrations] = useState<IntegrationsStatus | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [agentError, setAgentError] = useState(false);
  useEffect(() => {
    getIntegrationsStatus().then(setIntegrations).catch(() => setIntegrations(null));
    getAgentStatus().then(setAgent).catch(() => setAgentError(true));
  }, []);

  return (
    <div className="settings-page-root flex-1 overflow-y-auto h-full p-8" style={{ background: 'var(--bg-page)' }}>
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>Settings</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Manage integrations and app preferences</p>
        </div>

        <AppearanceCard />

        <div ref={connectionsRef} id="connections" style={{ scrollMarginTop: 24 }}>
          <ConnectionsSection />
        </div>

        <AiModelsCard integrations={integrations} />

        <ScanScheduleCard integrations={integrations} agent={agent} agentError={agentError} />

        {/* The companies Diagnostics panel (brand extraction debug) — unreachable in the original. */}
        <div className="flex items-center justify-end">
          <Link to="/deal-organizer/emails?diagnostics=1" className="inline-flex items-center gap-1.5 text-xs hover:underline" style={{ color: 'var(--text-muted)' }}>
            <Stethoscope size={12} /> Diagnostics — company / brand extraction
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── AI models (what the Lab port actually uses) ─────────────────────────────

function AiModelsCard({ integrations }: { integrations: IntegrationsStatus | null }) {
  const claude = aiStatus(integrations, 'claude');
  const gemini = aiStatus(integrations, 'gemini');
  const pill = (s: AiKeyStatus) => s?.configured === true
    ? <StatusPill tone="ok">Configured</StatusPill>
    : s?.configured === false
      ? <StatusPill tone="off">No API key</StatusPill>
      : <StatusPill tone="neutral">Server-managed</StatusPill>;

  return (
    <>
      <div className="glass-card rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--bg-card-hover)' }}>
            <Brain size={17} style={{ color: 'var(--text-secondary)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Claude (Anthropic)</h3>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>AI chat, deal extraction from email, and reply drafting</p>
          </div>
          {pill(claude)}
        </div>
        <div className="flex items-start gap-2 text-xs rounded-lg p-3" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}>
          <Info size={13} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          <p>
            Runs on the Lab's own Claude access (the server's key — nothing to set up here). The <strong style={{ color: 'var(--text-primary)' }}>Home chat</strong>,
            the <strong style={{ color: 'var(--text-primary)' }}>Gmail deal scan</strong> and <strong style={{ color: 'var(--text-primary)' }}>AI reply drafts</strong> use Claude.
            Replies are only ever saved as Gmail drafts — nothing is sent.
          </p>
        </div>
      </div>

      <div className="glass-card rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--bg-card-hover)' }}>
            <Sparkles size={17} style={{ color: 'var(--text-secondary)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Google Gemini</h3>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Analytics insights, follow-up classification, PDF reading</p>
          </div>
          {pill(gemini)}
        </div>
        <div className="flex items-start gap-2 text-xs rounded-lg p-3" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}>
          <Info size={13} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          <p>
            <span className="font-mono" style={{ color: 'var(--text-primary)' }}>gemini-2.5-flash</span> writes the Analytics page's insights and rejection reasons,
            classifies stale deals for follow-ups, and reads PDF attachments during the deal scan.
          </p>
        </div>
      </div>
    </>
  );
}

// ─── Scan schedule: the server's Gmail sync (runs with the agent) ────────────

function ScanScheduleCard({ integrations, agent, agentError }: {
  integrations: IntegrationsStatus | null; agent: AgentStatus | null; agentError: boolean;
}) {
  const { status: sync } = useSync();
  const gmailConnected = integrations?.gmail?.connected;
  // The sync runs at the agent's times whether or not the agent itself is on;
  // what stops it is a missing Gmail connection.
  const tone: PillTone = !integrations ? 'neutral'
    : gmailConnected === false ? 'off'
    : sync?.last?.ok === false ? 'warn' : 'ok';
  const label = !integrations ? (agentError ? 'Unknown' : 'Loading…')
    : gmailConnected === false ? 'Gmail not connected'
    : sync?.last?.ok === false ? 'Last run failed' : 'Active';
  const times = agent?.times?.length ? agent.times.join(' + ') : '—';
  const lastRun = sync?.last;

  const rows: [string, string][] = [
    ['Runs at', agent ? `${times} (${agent.timezone === TZ ? 'Bangkok' : agent.timezone})` : '—'],
    ['Next run', fmtWhen(sync?.nextRunAt ?? agent?.nextRunAt)],
    ['Last sync', lastRun ? `${fmtWhen(lastRun.finishedAt ?? lastRun.startedAt)}${lastRun.ok === false ? ' — failed' : ''}` : '—'],
    ['Scheduled scan window', 'Last 24 hours'],
    ['What runs', 'Thread index → recent emails → brands → AI deal scan'],
  ];

  return (
    <div className="glass-card rounded-xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--bg-card-hover)' }}>
          <Mail size={17} style={{ color: 'var(--text-secondary)' }} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Scan Schedule</h3>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>One server-side Gmail sync, twice a day at the agent's times (set on the Agent page) — runs even when the agent is off</p>
        </div>
        <div className="ml-auto"><StatusPill tone={tone}>{label}</StatusPill></div>
      </div>
      <div className="space-y-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
        {rows.map(([k, v], i, arr) => (
          <div key={k} className="flex items-center justify-between gap-3 py-2" style={{ borderBottom: i < arr.length - 1 ? '1px solid var(--border-color)' : 'none' }}>
            <span className="flex-shrink-0">{k}</span>
            <span className="font-medium text-right" style={{ color: 'var(--text-primary)' }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
