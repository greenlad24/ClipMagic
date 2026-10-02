/**
 * Deal Organizer — Emails (redesign 2026-09-30): local-first triage.
 *
 * Opening this page makes ZERO Gmail and ZERO AI calls: every list is one SQL
 * read (listInbox) over what the syncs stored. Gmail is kept current by
 *   • the light inbox refresh every 15 min (history only, no AI — "Inbox
 *     refreshed 3 min ago", ↻ runs it now), and
 *   • the heavy sync (08:00 / 20:00 Bangkok + "Sync now": thread index →
 *     emails → brand extraction → deal scan → agent).
 * AI runs only when Jake clicks "AI Draft" (the agent's own drafter) or
 * "Draft follow-ups". Nothing is ever sent — drafts are saved to Gmail.
 *
 * Views: Needs reply (default) · Agent drafted · Asked Jake · Waiting on them
 * (+ Draft follow-ups) · Done — then Brands and All mail. ?thread=<id> opens a
 * thread directly (links from the chat).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebouncedCallback } from 'use-debounce';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { listCompanies, type ListCompaniesOutputType } from '@/deals/api';
import {
  listInbox, getInboxThread, refreshInbox, getFollowUpDraftsFor,
  type InboxList, type InboxThreadDetail, type InboxView, type InboxStatus, type FollowUpDeal,
} from '@/deals/apiInbox';
import { fetchDeals, type Deal } from '@/deals/lib/supabase';
import { E } from '@/deals/lib/emailTheme';
import EmailLeftPanel, { FOLDERS } from '@/deals/components/EmailLeftPanel';
import EmailThreadList from '@/deals/components/EmailThreadList';
import EmailThreadViewer from '@/deals/components/EmailThreadViewer';
import FollowUpPanel from '@/deals/components/FollowUpPanel';
import CompaniesDebugPanel from '@/deals/components/CompaniesDebugPanel';
import { SyncIndicator, SyncNowButton } from '@/deals/components/SyncControls';
import { useSyncRefresh } from '@/deals/context/SyncContext';

const EMAIL_STYLES = `
  .email-area ::-webkit-scrollbar { width: 5px; height: 5px; }
  .email-area ::-webkit-scrollbar-track { background: transparent; }
  .email-area ::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 3px; }
  .email-area { scrollbar-width: thin; scrollbar-color: var(--border-color) transparent; }
`;
const VIEW_KEY = 'deal-organizer-emails-view';

export default function EmailsPage() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<InboxView>(() => {
    try { const v = localStorage.getItem(VIEW_KEY) as InboxView | null; return v && FOLDERS.some(f => f.value === v) ? v : 'needs_reply'; } catch { return 'needs_reply'; }
  });
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [brand, setBrand] = useState<string | null>(null);
  const [includeOld, setIncludeOld] = useState(false);
  const [data, setData] = useState<InboxList | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(params.get('thread'));
  const [detail, setDetail] = useState<InboxThreadDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [status, setStatus] = useState<InboxStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [followUps, setFollowUps] = useState<{ deals: FollowUpDeal[]; scanned: number } | null>(null);
  const [followUpsLoading, setFollowUpsLoading] = useState(false);
  const [showDebug, setShowDebug] = useState(() => params.get('diagnostics') === '1');
  const [debugData, setDebugData] = useState<ListCompaniesOutputType['debugInfo']>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const listSeq = useRef(0);

  const loadList = useCallback(async (opts: { quiet?: boolean } = {}) => {
    const seq = ++listSeq.current;
    if (!opts.quiet) setLoadingList(true);
    try {
      const effectiveView: InboxView = brand ? 'all' : view;
      const r = await listInbox({ view: effectiveView, q: query || undefined, brand: brand ?? undefined, includeOld });
      if (seq !== listSeq.current) return;
      setData(brand ? { ...r, view } : r);
      setStatus(r.refresh);
    } catch (e) {
      if (seq === listSeq.current) toast.error(`Could not load the inbox: ${e instanceof Error ? e.message : 'error'}`);
    } finally {
      if (seq === listSeq.current) setLoadingList(false);
    }
  }, [view, query, brand, includeOld]);

  const loadDetail = useCallback(async (threadId: string, quiet = false) => {
    if (!quiet) setLoadingDetail(true);
    try { setDetail(await getInboxThread(threadId)); }
    catch { toast.error('Failed to load the thread'); setDetail(null); }
    finally { setLoadingDetail(false); }
  }, []);

  useEffect(() => { fetchDeals().then(setDeals).catch(() => {}); }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    if (selectedThreadId) void loadDetail(selectedThreadId); else setDetail(null);
  }, [selectedThreadId, loadDetail]);

  // ?thread=<id> (chat links) ↔ selection
  useEffect(() => {
    const t = params.get('thread');
    if (t && t !== selectedThreadId) setSelectedThreadId(t);
  }, [params.get('thread')]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectThread = (id: string | null) => {
    setSelectedThreadId(id);
    setFollowUps(null);
    setParams(p => { const n = new URLSearchParams(p); if (id) n.set('thread', id); else n.delete('thread'); return n; }, { replace: true });
  };

  // A heavy sync finished (here, elsewhere or on schedule) → reload quietly.
  useSyncRefresh(() => {
    fetchDeals().then(setDeals).catch(() => {});
    void loadList({ quiet: true });
    if (selectedThreadId) void loadDetail(selectedThreadId, true);
  });

  const onChanged = () => {
    void loadList({ quiet: true });
    fetchDeals().then(setDeals).catch(() => {});
    if (selectedThreadId) void loadDetail(selectedThreadId, true);
  };

  const debouncedQuery = useDebouncedCallback((q: string) => setQuery(q.trim()), 350);
  const handleSearchChange = (q: string) => { setSearch(q); debouncedQuery(q); };

  const handleViewChange = (v: InboxView) => {
    setView(v);
    setBrand(null);
    setSearch('');
    setQuery('');
    setIncludeOld(false);
    setFollowUps(null);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  };

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      const r = await refreshInbox();
      setStatus(r.status);
      if (r.skipped) toast(`Inbox refresh skipped: ${r.skipped}`);
      else if (r.error) toast.error(`Inbox refresh: ${r.error}`);
      else toast.success(`Inbox refreshed — ${r.counts.fetched ?? 0} new message${r.counts.fetched === 1 ? '' : 's'}`);
      void loadList({ quiet: true });
      if (selectedThreadId) void loadDetail(selectedThreadId, true);
    } catch (e) {
      toast.error(`Inbox refresh failed: ${e instanceof Error ? e.message : 'error'}`);
    } finally { setRefreshing(false); }
  };

  const draftFollowUps = async () => {
    const threads = data?.threads ?? [];
    const dealIds = [...new Set(threads.map(t => t.deal?.id).filter((x): x is string => !!x))].slice(0, 25);
    if (!dealIds.length) return;
    setFollowUpsLoading(true);
    try {
      const r = await getFollowUpDraftsFor(dealIds);
      setFollowUps({ deals: r.deals, scanned: r.scanned });
      selectThread(null);
      setFollowUps({ deals: r.deals, scanned: r.scanned });
    } catch (e) {
      toast.error(`Could not write follow-ups: ${e instanceof Error ? e.message : 'error'}`);
    } finally { setFollowUpsLoading(false); }
  };

  const runDebug = useCallback(async () => {
    setDebugLoading(true);
    try { const res = await listCompanies({ debug: true }); setDebugData(res.debugInfo); }
    catch (err) { console.error('Debug run failed', err); }
    finally { setDebugLoading(false); }
  }, []);
  useEffect(() => { if (showDebug) void runDebug(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const closeDebug = () => {
    setShowDebug(false);
    if (params.get('diagnostics')) setParams(p => { const n = new URLSearchParams(p); n.delete('diagnostics'); return n; }, { replace: true });
  };

  const counts = data?.counts ?? {};
  const showViewer = !!selectedThreadId;

  return (
    <div className="email-area flex flex-col h-full overflow-hidden" style={{ background: E.outerBg, position: 'relative' }}>
      <style>{EMAIL_STYLES}</style>

      {/* Sync status: emails are updated only by the twice-daily central sync (+ Sync now) — Jake, 2026-09-30 */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, padding: '6px 12px', background: E.panel1, borderBottom: `1px solid ${E.border}`, minWidth: 0 }}>
        <span className="min-w-0 overflow-hidden flex" style={{ flexShrink: 1 }}><SyncIndicator className="min-w-0" /></span>
        <SyncNowButton compact />
      </div>

      {/* Mobile view tabs */}
      {!showViewer && (
        <div className="sm:hidden flex items-center gap-0.5 px-2 py-2 flex-shrink-0 overflow-x-auto" style={{ background: E.panel1, borderBottom: `1px solid ${E.border}` }}>
          {FOLDERS.map(({ value: v, icon: Icon, label }) => {
            const active = view === v;
            const n = (counts as Record<string, number>)[v];
            return (
              <button key={v} onClick={() => handleViewChange(v)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px', borderRadius: 8, flexShrink: 0, border: 'none', background: active ? E.accentLight : 'transparent', color: active ? E.accent : E.textSecondary, fontSize: 13, fontWeight: active ? 600 : 400, cursor: 'pointer' }}>
                <Icon size={14} /><span>{label}</span>{typeof n === 'number' && n > 0 && v !== 'all' && <span style={{ fontSize: 11 }}>{n}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden" style={{ paddingBottom: showDebug ? '55vh' : 0 }}>
        <EmailLeftPanel view={view} onViewChange={handleViewChange} counts={counts} myEmail={data?.myEmail ?? ''} status={status} refreshing={refreshing} onRefresh={doRefresh} />

        <div className={`${showViewer || followUps ? 'hidden sm:flex' : 'flex'} min-w-0 w-full sm:w-auto`} style={{ flexShrink: 0 }}>
          <EmailThreadList
            view={view}
            threads={data?.threads ?? []}
            brands={data?.brands ?? []}
            total={data?.total ?? 0}
            olderNeedsReply={data?.olderNeedsReply ?? 0}
            includeOld={includeOld}
            onIncludeOld={setIncludeOld}
            brandFilter={brand}
            onClearBrand={() => { setBrand(null); setSearch(''); setQuery(''); }}
            onBrandSelect={b => { setBrand(b); setSearch(''); setQuery(''); }}
            selectedThreadId={selectedThreadId}
            loading={loadingList}
            search={search}
            onSearchChange={handleSearchChange}
            onThreadSelect={id => selectThread(id)}
            onDraftFollowUps={view === 'waiting' && !brand ? draftFollowUps : undefined}
            followUpsLoading={followUpsLoading}
          />
        </div>

        {followUps && !showViewer ? (
          <div className="flex-1 min-w-0 overflow-y-auto" style={{ background: E.panel3 }}>
            <div className="max-w-3xl mx-auto px-4 py-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-bold text-foreground">Follow-up drafts <span className="text-xs font-normal text-muted-foreground">({followUps.deals.length} of {followUps.scanned} checked)</span></h3>
                <button onClick={() => setFollowUps(null)} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
              </div>
              <FollowUpPanel deals={followUps.deals} />
            </div>
          </div>
        ) : (
          <div className={`${showViewer ? 'flex' : 'hidden sm:flex'} flex-1 min-w-0`}>
            <EmailThreadViewer detail={detail} loading={loadingDetail} deals={deals} onBack={() => selectThread(null)} onChanged={onChanged} />
          </div>
        )}
      </div>

      {showDebug && <CompaniesDebugPanel debug={debugData} loading={debugLoading} onClose={closeDebug} onRefresh={runDebug} />}
    </div>
  );
}
