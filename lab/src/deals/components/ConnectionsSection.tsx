/**
 * Deal Organizer — Connections (the "Connections" part of Settings).
 *
 * Moved here from the Lab's stand-alone src/pages/DealOrganizerConnectionsPage
 * and restyled in the Deal Organizer look; behaviour is unchanged. Replaces the
 * original Zite "Gmail Accounts" card (popup OAuth + /gmail-callback): the Lab
 * now owns the Gmail grant, so connecting is a full-page trip to
 * /api/deals-oauth/gmail/start, which comes back to
 * /deal-organizer/connections?gmail=<result>.
 *
 * The three outside services the sponsorship agent needs (rulebook 2026-09-30):
 *   Gmail   — read the sponsor inbox, label, save DRAFTS, mark spam. Never sends.
 *   YouTube — read-only analytics for the standard audience snapshot (#66).
 *             Shares the Channel Audit's existing connection.
 *   Slack   — where the agent asks Jake about conflicts, prices, links, risks.
 *
 * Secrets are write-only: the page learns whether each is set, never the value.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Copy, Loader2, Mail, MessageSquare, Youtube, AlertCircle, Plug, ExternalLink } from 'lucide-react';
import {
  getIntegrationsStatus, testGmail, getAudienceSnapshot, saveSlackSettings, testSlack, getAccounts,
  GMAIL_CONNECT_URL, GMAIL_DISCONNECT_URL,
  type IntegrationsStatus, type AudienceSnapshot, type GetAccountsOutputType,
} from '@/deals/api';

type Account = GetAccountsOutputType['accounts'][number];

const GMAIL_FLASH: Record<string, [string, boolean]> = {
  connected: ['Gmail connected.', true],
  disconnected: ['Gmail disconnected.', true],
  denied: ['Consent was declined.', false],
  failed: ['That did not complete. Try connecting again.', false],
  norefresh: ['Google did not return a lasting token. Try connecting again.', false],
  scope: ['That grant was missing Gmail access or carried more than it should, so nothing was saved. Tick every box on the consent screen.', false],
};

// ── Small pieces in the Deal Organizer style ─────────────────────────────────
function Pill({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full flex-shrink-0"
      style={ok
        ? { color: 'var(--pill-green-text)', background: 'var(--pill-green-bg)' }
        : { color: 'var(--pill-gray-text)', background: 'var(--pill-gray-bg)' }}
    >
      {ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />} {children}
    </div>
  );
}

function CardHeader({ icon, title, sub, right }: { icon: ReactNode; title: string; sub: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{sub}</p>
      </div>
      {right}
    </div>
  );
}

const btnBase: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500,
  cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap',
};
const btnOutline: React.CSSProperties = { ...btnBase, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)' };
const btnPrimary: React.CSSProperties = { ...btnBase, border: 'none', background: '#FF7420', color: '#fff', fontWeight: 600 };

function Btn({ primary, busy, disabled, onClick, children }: { primary?: boolean; busy?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      style={{ ...(primary ? btnPrimary : btnOutline), opacity: disabled || busy ? 0.6 : 1, cursor: busy ? 'wait' : disabled ? 'not-allowed' : 'pointer' }}
    >
      {busy && <Loader2 size={12} className="animate-spin" />} {children}
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs rounded-lg p-3" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
      {children}
    </div>
  );
}

function CopyLine({ value }: { value: string }) {
  const copy = () => {
    const fallback = () => {
      const el = document.createElement('textarea');
      el.value = value;
      document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
      toast.success('Copied');
    };
    try { navigator.clipboard.writeText(value).then(() => toast.success('Copied')).catch(fallback); } catch { fallback(); }
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginTop: 8,
      background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 12px',
    }}>
      <code style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>{value}</code>
      <button onClick={copy} title="Copy" style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
        <Copy size={13} />
      </button>
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>{label}</label>
      {children}
      {hint && <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)', lineHeight: 1.6 }}>{hint}</p>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 12px', borderRadius: 8, fontSize: 13,
  background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', outline: 'none',
};

// ── Section ──────────────────────────────────────────────────────────────────
export default function ConnectionsSection() {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [gmailTest, setGmailTest] = useState<{ email: string; messagesTotal: number; recent: string[] } | null>(null);
  const [snapshot, setSnapshot] = useState<AudienceSnapshot | null>(null);
  const [slackToken, setSlackToken] = useState('');
  const [slackTarget, setSlackTarget] = useState('');

  const load = useCallback(() => {
    setLoadError(null);
    getIntegrationsStatus()
      .then((s) => { setStatus(s); setSlackTarget(s.slack.target || ''); })
      .catch((e) => { setLoadError(e.message); toast.error(e.message); });
    getAccounts({}).then((r) => setAccount(r.accounts[0] ?? null)).catch(() => setAccount(null));
  }, []);
  useEffect(load, [load]);

  // One-shot result of the OAuth round trip (?gmail=…).
  const [flash] = useState(() => new URLSearchParams(window.location.search).get('gmail'));
  useEffect(() => {
    if (flash && GMAIL_FLASH[flash]) {
      const [msg, ok] = GMAIL_FLASH[flash];
      if (ok) toast.success(msg); else toast.error(msg);
    }
  }, [flash]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };

  if (!status) {
    return (
      <div className="glass-card rounded-xl p-6">
        <CardHeader icon={<Plug size={17} />} title="Connections" sub="Gmail, YouTube Analytics and Slack for the sponsorship agent" />
        <div className="flex items-center gap-2 pt-4" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {loadError
            ? <><AlertCircle size={14} /> Could not load the connections: {loadError} <button onClick={load} style={{ ...btnOutline, padding: '4px 10px', marginLeft: 8 }}>Try again</button></>
            : <><Loader2 size={14} className="animate-spin" /> Loading connections…</>}
        </div>
      </div>
    );
  }

  const g = status.gmail;
  const gmailEmail = g.email || account?.email;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Connections</h2>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
          The sponsorship agent reads the sponsor inbox, writes drafts, pulls your audience snapshot, and asks you on Slack when it needs a decision.
        </p>
      </div>

      {/* Gmail */}
      <div className="glass-card rounded-xl p-6 space-y-4">
        <CardHeader
          icon={<Mail size={17} />}
          title="Gmail"
          sub={g.connected && gmailEmail ? gmailEmail : 'The sponsor inbox'}
          right={<Pill ok={!!g.connected}>{g.connected ? 'Connected' : 'Not connected'}</Pill>}
        />
        {flash && GMAIL_FLASH[flash] && (
          <p className="text-xs font-medium" style={{ color: GMAIL_FLASH[flash][1] ? 'var(--pill-green-text)' : 'var(--pill-red-text)' }}>{GMAIL_FLASH[flash][0]}</p>
        )}
        <Note>
          Reads the sponsor inbox, applies labels, saves replies as <strong style={{ color: 'var(--text-primary)' }}>drafts</strong>, and marks suspicious senders as spam.{' '}
          <strong style={{ color: 'var(--text-primary)' }}>Automated runs never send.</strong> Only a Send button you click in the Deal Organizer sends; the Lab blocks every other send.
        </Note>
        {g.connected && account && (
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {account.lastSyncedAt
              ? `Last synced ${new Date(account.lastSyncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
              : 'Never synced'}
          </p>
        )}
        {g.connected ? (
          <div className="flex flex-wrap items-center gap-2">
            <Btn busy={busy === 'gmail'} onClick={() => run('gmail', async () => setGmailTest(await testGmail()))}>Test: read the 5 newest threads</Btn>
            <a href={GMAIL_CONNECT_URL} style={btnOutline}>Connect a different inbox</a>
            <a href={GMAIL_DISCONNECT_URL} style={{ ...btnBase, color: 'var(--text-muted)', textDecoration: 'underline', padding: '7px 6px' }}>Disconnect</a>
          </div>
        ) : g.configured ? (
          <div>
            <a href={GMAIL_CONNECT_URL} style={btnPrimary}><Mail size={13} /> Connect the sponsor Gmail</a>
            <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>Pick the inbox that receives sponsor emails on Google&apos;s account chooser.</p>
            <p className="text-[11px] mt-3" style={{ color: 'var(--text-muted)', lineHeight: 1.6 }}>
              One-time Google Cloud setup, on the project that holds the Lab sign-in client: enable the <strong>Gmail API</strong>, add the scope{' '}
              <code>gmail.modify</code> to the consent screen, and add this exact URL under <strong>Authorised redirect URIs</strong>{' '}
              (<a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" style={{ color: '#FF7420' }}>Google Cloud Console <ExternalLink size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /></a>):
            </p>
            {g.redirectUri && <CopyLine value={g.redirectUri} />}
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No Google OAuth client is configured on this Lab.</p>
        )}
        {gmailTest && (
          <div className="rounded-lg p-3 text-xs" style={{ background: 'var(--bg-panel-alt)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
            <div className="mb-1 font-medium" style={{ color: 'var(--text-primary)' }}>{gmailTest.email} · {gmailTest.messagesTotal?.toLocaleString()} messages</div>
            <ul className="list-disc space-y-1 pl-4">{gmailTest.recent.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
        )}
      </div>

      {/* YouTube */}
      <div className="glass-card rounded-xl p-6 space-y-4">
        <CardHeader
          icon={<Youtube size={17} />}
          title="YouTube Analytics (read-only)"
          sub="The standard audience snapshot for sponsors"
          right={<Pill ok={!!status.youtube.connected}>{status.youtube.connected ? 'Connected' : 'Not connected'}</Pill>}
        />
        <Note>
          Builds the one standard audience snapshot sponsors get: top countries, age range and gender. It never shares past sponsors&apos; results. This uses the same read-only connection as Channel Audit.
        </Note>
        {status.youtube.connected ? (
          <Btn busy={busy === 'yt'} onClick={() => run('yt', async () => setSnapshot(await getAudienceSnapshot({ days: 90 })))}>Show the last 90 days</Btn>
        ) : status.youtube.configured ? (
          <a href="/api/yt-oauth/start" style={btnPrimary}>Connect my channel (read-only)</a>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Add the YouTube Analytics OAuth client in Settings → Postiz first.</p>
        )}
        {snapshot && (
          <div className="grid gap-3 rounded-lg p-3 text-xs sm:grid-cols-3" style={{ background: 'var(--bg-panel-alt)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
            <div>
              <div className="mb-1 font-medium" style={{ color: 'var(--text-primary)' }}>Top countries</div>
              {snapshot.countries.slice(0, 5).map((c) => <div key={c.country}>{c.country} · {c.share}%</div>)}
            </div>
            <div>
              <div className="mb-1 font-medium" style={{ color: 'var(--text-primary)' }}>Age</div>
              {snapshot.ageGroups.map((a) => <div key={a.ageGroup}>{a.ageGroup} · {a.percent}%</div>)}
            </div>
            <div>
              <div className="mb-1 font-medium" style={{ color: 'var(--text-primary)' }}>Gender</div>
              {snapshot.gender.map((x) => <div key={x.gender}>{x.gender} · {x.percent}%</div>)}
              <div className="mt-2" style={{ color: 'var(--text-muted)' }}>{snapshot.totalViews.toLocaleString()} views, {snapshot.from} to {snapshot.to}</div>
            </div>
          </div>
        )}
      </div>

      {/* Slack */}
      <div className="glass-card rounded-xl p-6 space-y-4">
        <CardHeader
          icon={<MessageSquare size={17} />}
          title="Slack"
          sub="Where the agent asks you for decisions"
          right={<Pill ok={!!(status.slack.configured && status.slack.hasTarget)}>{status.slack.configured && status.slack.hasTarget ? 'Connected' : 'Not connected'}</Pill>}
        />
        <Note>
          Where the agent asks you about contract and scheduling conflicts, and about going below the price floor. It also sends you standout service providers, asks for links it needs, and flags anything risky. It reads only the replies in its own threads.
        </Note>
        <div className="grid gap-3">
          <Field id="slack-token" label={<>Bot User OAuth Token {status.slack.configured && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(saved — paste a new one to replace it)</span>}</>}>
            <input id="slack-token" type="password" autoComplete="off" placeholder="xoxb-…" value={slackToken} onChange={(e) => setSlackToken(e.target.value)} style={inputStyle} />
          </Field>
          <Field
            id="slack-target"
            label="Send to"
            hint={<>Member ID: in Slack, click your profile, then ⋯, then <strong>Copy member ID</strong>. Channel ID: open the channel details. The ID is at the bottom. Invite the bot to the channel first.</>}
          >
            <input id="slack-target" placeholder="Your member ID (U…) for a DM, or a channel ID (C…)" value={slackTarget} onChange={(e) => setSlackTarget(e.target.value)} style={inputStyle} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Btn primary busy={busy === 'slack-save'} onClick={() => run('slack-save', async () => {
              await saveSlackSettings({ ...(slackToken ? { botToken: slackToken } : {}), target: slackTarget });
              setSlackToken(''); toast.success('Slack saved'); load();
            })}>Save</Btn>
            <Btn
              busy={busy === 'slack-test'}
              disabled={!status.slack.configured || !status.slack.hasTarget}
              onClick={() => run('slack-test', async () => { const r = await testSlack(); toast.success(`Sent a test message in ${r.team}`); })}
            >Send a test message</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
