import { useState } from 'react';
import { ListCompaniesOutputType } from '@/deals/api';
import { X, RefreshCw, ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Loader2, Database, Brain, Layers, Search, Filter, Save } from 'lucide-react';
import { E } from '@/deals/lib/emailTheme';

type DebugInfo = NonNullable<ListCompaniesOutputType['debugInfo']>;
type BatchDebug = DebugInfo['step5_batches'][number];

interface Props {
  debug: DebugInfo | null;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

function Section({ title, icon, count, status, children, defaultOpen = false }: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  status?: 'ok' | 'warn' | 'error';
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const statusColor = status === 'error' ? '#f87171' : status === 'warn' ? '#fbbf24' : '#34d399';
  return (
    <div style={{ borderBottom: `1px solid ${E.border}`, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', background: 'transparent', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={13} color={E.textMuted} /> : <ChevronRight size={13} color={E.textMuted} />}
        <span style={{ color: E.accent, opacity: 0.8 }}>{icon}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: E.textPrimary, flex: 1 }}>{title}</span>
        {count !== undefined && (
          <span style={{ fontSize: 11, color: E.textMuted, fontFamily: 'monospace', marginRight: 6 }}>{count.toLocaleString()}</span>
        )}
        {status && <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />}
      </button>
      {open && (
        <div style={{ padding: '0 14px 12px 14px' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function CodeBlock({ children, maxH = 200 }: { children: string; maxH?: number }) {
  return (
    <pre style={{
      margin: 0, padding: '8px 10px', background: 'hsl(var(--muted) / 0.3)',
      borderRadius: 6, fontSize: 10, fontFamily: 'monospace', color: E.textSecondary,
      overflowY: 'auto', maxHeight: maxH, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      border: `1px solid ${E.border}`,
    }}>
      {children}
    </pre>
  );
}

function Tag({ children, color }: { children: string; color?: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 4,
      fontSize: 10, fontWeight: 600, fontFamily: 'monospace',
      background: color ? `${color}22` : 'hsl(var(--muted) / 0.4)',
      color: color ?? E.textMuted, border: `1px solid ${color ? `${color}44` : E.border}`,
    }}>{children}</span>
  );
}

function ThreadRow({ threadId, subject, domain, brand }: { threadId: string; subject: string; domain: string; brand?: string | null }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '3px 0', borderBottom: `1px solid ${E.border}` }}>
      <span style={{ fontSize: 9, color: E.textMuted, fontFamily: 'monospace', flexShrink: 0, marginTop: 2, width: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={threadId}>{threadId.slice(-8)}</span>
      <span style={{ fontSize: 11, color: E.textPrimary, flex: 2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subject || '(no subject)'}</span>
      <Tag>{domain}</Tag>
      {brand !== undefined && (
        brand ? <Tag color={E.accent}>{brand}</Tag> : <Tag color="#6b7280">null</Tag>
      )}
    </div>
  );
}

function BatchSection({ batch }: { batch: BatchDebug }) {
  const [open, setOpen] = useState(false);
  const hasError = !!batch.error;
  return (
    <div style={{ border: `1px solid ${hasError ? '#f87171' : E.border}`, borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        {open ? <ChevronDown size={12} color={E.textMuted} /> : <ChevronRight size={12} color={E.textMuted} />}
        <span style={{ fontSize: 11, fontWeight: 600, color: E.textPrimary }}>Batch {batch.batchIndex + 1}</span>
        <Tag>{`${batch.threadCount} threads`}</Tag>
        <Tag color="#60a5fa">{`${batch.savedToDb} saved to DB`}</Tag>
        {hasError && <Tag color="#f87171">error</Tag>}
        {!hasError && <Tag color="#34d399">ok</Tag>}
      </button>
      {open && (
        <div style={{ padding: '0 10px 10px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {batch.error && (
            <div style={{ padding: '6px 10px', background: '#f8717122', border: '1px solid #f87171', borderRadius: 6, fontSize: 11, color: '#f87171' }}>
              <strong>Error:</strong> {batch.error}
            </div>
          )}

          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: E.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Threads in batch</div>
            <div style={{ maxHeight: 120, overflowY: 'auto' }}>
              {batch.threads.map(t => <ThreadRow key={t.threadId} {...t} />)}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: E.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Prompt sent to Gemini</div>
            <CodeBlock maxH={150}>{batch.rawPrompt}</CodeBlock>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: E.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Raw Gemini response</div>
            <CodeBlock maxH={150}>{batch.rawResponse || '(empty)'}</CodeBlock>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: E.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Extracted brands</div>
            <div style={{ maxHeight: 160, overflowY: 'auto' }}>
              {batch.parsedBrands.map(t => (
                <ThreadRow key={t.threadId} threadId={t.threadId} subject={t.subject} domain={t.domain} brand={t.brand} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CompaniesDebugPanel({ debug, loading, onClose, onRefresh }: Props) {
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 999,
      height: '55vh', background: E.panel1,
      borderTop: `2px solid ${E.accent}`,
      display: 'flex', flexDirection: 'column',
      fontFamily: 'system-ui, sans-serif',
      boxShadow: '0 -8px 32px rgba(0,0,0,0.4)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
        borderBottom: `1px solid ${E.border}`, flexShrink: 0,
        background: `${E.accent}11`,
      }}>
        <Brain size={14} color={E.accent} />
        <span style={{ fontSize: 13, fontWeight: 700, color: E.accent }}>Companies Debug Panel</span>
        <span style={{ fontSize: 11, color: E.textMuted }}>— step-by-step brand extraction trace</span>
        <div style={{ flex: 1 }} />
        {debug && !loading && (
          <div style={{ display: 'flex', gap: 6 }}>
            {debug.errors.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', background: '#f8717122', borderRadius: 4, border: '1px solid #f87171' }}>
                <AlertCircle size={11} color="#f87171" />
                <span style={{ fontSize: 11, color: '#f87171' }}>{debug.errors.length} error{debug.errors.length !== 1 ? 's' : ''}</span>
              </div>
            )}
            {debug.errors.length === 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', background: '#34d39922', borderRadius: 4, border: '1px solid #34d399' }}>
                <CheckCircle2 size={11} color="#34d399" />
                <span style={{ fontSize: 11, color: '#34d399' }}>No errors</span>
              </div>
            )}
          </div>
        )}
        <button
          onClick={onRefresh} disabled={loading}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, border: `1px solid ${E.border}`, background: 'transparent', color: E.textSecondary, fontSize: 11, cursor: 'pointer' }}
        >
          {loading ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={11} />}
          Re-run
        </button>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: E.textMuted, cursor: 'pointer', padding: 4 }}>
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: E.textMuted }}>
            <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 13 }}>Running debug extraction…</span>
          </div>
        )}

        {!loading && !debug && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: E.textMuted, fontSize: 13 }}>
            No debug data yet — click Re-run to start
          </div>
        )}

        {!loading && debug && (
          <>
            {/* Step 1 */}
            <Section title="Step 1 — Emails fetched from DB" icon={<Database size={13} />} count={debug.step1_emailsFetched} status="ok" defaultOpen>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {[
                  { label: 'Total emails', value: debug.step1_emailsFetched },
                  { label: 'Inbox emails', value: debug.step1_inboxEmails },
                  { label: 'Skipped (non-inbox)', value: debug.step1_emailsFetched - debug.step1_inboxEmails },
                ].map(s => (
                  <div key={s.label} style={{ background: 'hsl(var(--muted) / 0.3)', borderRadius: 8, padding: '8px 14px', border: `1px solid ${E.border}` }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: E.textPrimary, fontFamily: 'monospace' }}>{s.value.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: E.textMuted, marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </Section>

            {/* Step 2 */}
            <Section title="Step 2 — Unique inbox threads" icon={<Filter size={13} />} count={debug.step2_uniqueThreads} status="ok">
              <div style={{ fontSize: 11, color: E.textMuted, marginBottom: 6 }}>
                De-duplicated by threadId. Skipped: free email domains, no-reply prefixes, own domain.
                {debug.step2_threads.length < debug.step2_uniqueThreads && ` Showing first ${debug.step2_threads.length}.`}
              </div>
              <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                {debug.step2_threads.map(t => <ThreadRow key={t.threadId} {...t} />)}
              </div>
            </Section>

            {/* Step 3 */}
            <Section title="Step 3 — Cache lookup (Thread Brands DB)" icon={<Search size={13} />}
              count={debug.step3_cacheHits + debug.step3_cacheMisses}
              status={debug.step3_cacheMisses === 0 ? 'ok' : 'warn'}>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
                {[
                  { label: 'Cache hits', value: debug.step3_cacheHits, color: '#34d399' },
                  { label: 'Cache misses (new)', value: debug.step3_cacheMisses, color: '#fbbf24' },
                ].map(s => (
                  <div key={s.label} style={{ background: `${s.color}11`, borderRadius: 8, padding: '8px 14px', border: `1px solid ${s.color}44` }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: s.color, fontFamily: 'monospace' }}>{s.value.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: E.textMuted, marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>
              {debug.step3_cachedSample.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 600, color: E.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Cached sample (up to 50)</div>
                  <div style={{ maxHeight: 120, overflowY: 'auto' }}>
                    {debug.step3_cachedSample.map(r => (
                      <div key={r.threadId} style={{ display: 'flex', gap: 6, padding: '2px 0', borderBottom: `1px solid ${E.border}` }}>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: E.textMuted, width: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.threadId.slice(-8)}</span>
                        {r.brand ? <Tag color={E.accent}>{r.brand}</Tag> : <Tag color="#6b7280">null</Tag>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Section>

            {/* Step 4 */}
            <Section title="Step 4 — New threads sent to Gemini" icon={<Brain size={13} />}
              count={debug.step4_newThreads.length}
              status={debug.step4_newThreads.length === 0 ? 'ok' : 'warn'}>
              {debug.step4_newThreads.length === 0 ? (
                <div style={{ fontSize: 11, color: '#34d399' }}>✓ All threads were cached — Gemini was not called.</div>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: E.textMuted, marginBottom: 6 }}>
                    These threads had no cached brand and were sent to Gemini.
                    {debug.step4_newThreads.length < debug.step2_uniqueThreads - debug.step3_cacheHits && ' (showing first 200)'}
                  </div>
                  <div style={{ maxHeight: 140, overflowY: 'auto' }}>
                    {debug.step4_newThreads.map(t => <ThreadRow key={t.threadId} {...t} />)}
                  </div>
                </>
              )}
            </Section>

            {/* Step 5 */}
            <Section title="Step 5 — Gemini extraction batches" icon={<Brain size={13} />}
              count={debug.step5_batches.length}
              status={debug.step5_batches.some(b => b.error) ? 'error' : debug.step5_batches.length === 0 ? 'ok' : 'ok'}>
              {debug.step5_batches.length === 0 ? (
                <div style={{ fontSize: 11, color: '#34d399' }}>✓ No batches run (all cached)</div>
              ) : (
                debug.step5_batches.map(batch => <BatchSection key={batch.batchIndex} batch={batch} />)
              )}
            </Section>

            {/* Step 6 */}
            <Section title="Step 6 — Final company groups" icon={<Layers size={13} />} count={debug.step6_groups.length} status="ok" defaultOpen>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {debug.step6_groups.map(g => (
                  <div key={g.companyKey} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '3px 0', borderBottom: `1px solid ${E.border}` }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: E.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.displayName}</span>
                    <Tag>{g.domain}</Tag>
                    {g.brand ? <Tag color={E.accent}>{g.brand}</Tag> : <Tag color="#6b7280">domain-only</Tag>}
                    <Tag color="#818cf8">{`${g.threadCount} threads`}</Tag>
                  </div>
                ))}
              </div>
            </Section>

            {/* Errors */}
            {debug.errors.length > 0 && (
              <Section title="Errors" icon={<AlertCircle size={13} />} count={debug.errors.length} status="error" defaultOpen>
                {debug.errors.map((e, i) => (
                  <div key={i} style={{ fontSize: 11, color: '#f87171', padding: '3px 0', borderBottom: `1px solid #f8717122` }}>{e}</div>
                ))}
              </Section>
            )}

            {/* DB save summary */}
            {debug.step5_batches.length > 0 && (
              <Section title="Step 5b — Saved to Thread Brands DB" icon={<Save size={13} />}
                count={debug.step5_batches.reduce((sum, b) => sum + b.savedToDb, 0)} status="ok">
                <div style={{ fontSize: 11, color: E.textMuted }}>
                  {debug.step5_batches.reduce((sum, b) => sum + b.savedToDb, 0)} records upserted across {debug.step5_batches.length} batch{debug.step5_batches.length !== 1 ? 'es' : ''}.
                  These will be served from cache on the next load.
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
