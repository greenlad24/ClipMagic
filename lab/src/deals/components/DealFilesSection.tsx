/**
 * Deal workspace — "Files & threads".
 *
 * Every document from every thread that belongs to the deal (source thread,
 * other threads with the same people, same agency + same brand, signing /
 * payment notices, threads Jake linked), grouped by kind, versions folded;
 * document links (Docs, Drive, Notion, …) under them; the related threads
 * with why each one is here. Opening costs ZERO Gmail calls — only "Check
 * Gmail for missing files" reads Gmail (≤10 threads).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Paperclip, FileText, FileSignature, Receipt, Presentation, ScrollText, File as FileIcon, Film, Image as ImageIcon,
  FileSpreadsheet, FileArchive, Download, Eye, Loader2, RefreshCw, Link2, ExternalLink, Unlink, Plus, Search, X,
  ChevronDown, ChevronRight, MessagesSquare, Mail,
} from 'lucide-react';
import { downloadAttachment, previewAttachment } from '@/deals/lib/attachments';
import { useSyncRefresh } from '@/deals/context/SyncContext';
import {
  getDealFiles, refreshDealFiles, linkDealThread, unlinkDealThread, searchDealThreads, setDealFileCount,
  type DealFilesResult, type DealFile, type DealFileVersion, type DealLink, type DealThread, type FileKind,
  type MatchedBy, type DealThreadSearchHit,
} from '@/deals/apiFiles';

const KINDS: Array<{ kind: FileKind; label: string; Icon: typeof FileText }> = [
  { kind: 'contract', label: 'Contracts', Icon: FileSignature },
  { kind: 'brief', label: 'Briefs', Icon: FileText },
  { kind: 'invoice', label: 'Invoices & forms', Icon: Receipt },
  { kind: 'deck', label: 'Decks & media kits', Icon: Presentation },
  { kind: 'script', label: 'Scripts & drafts', Icon: ScrollText },
  { kind: 'other', label: 'Other', Icon: FileIcon },
];

const MATCH: Record<MatchedBy, { label: string; cls: string; title: string }> = {
  source: { label: 'Source', cls: 'bg-primary/10 text-primary border-primary/25', title: "The deal's own thread" },
  manual: { label: 'Linked by you', cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/25 [.dealorg-dark_&]:text-emerald-400', title: 'You linked this thread' },
  contact: { label: 'Same contact', cls: 'bg-sky-500/10 text-sky-600 border-sky-500/25 [.dealorg-dark_&]:text-sky-400', title: 'Someone from this deal is on the thread' },
  'domain+brand': { label: 'Same agency · brand', cls: 'bg-violet-500/10 text-violet-600 border-violet-500/25 [.dealorg-dark_&]:text-violet-400', title: 'Same company domain and the same brand' },
  platform: { label: 'Signing / payment', cls: 'bg-amber-500/10 text-amber-700 border-amber-500/25 [.dealorg-dark_&]:text-amber-400', title: 'A DocuSign / PandaDoc / Stripe / Docs-share notice naming this deal’s people' },
};

const LINK_LABEL: Record<string, string> = {
  'google-doc': 'Google Doc', 'google-sheet': 'Google Sheet', 'google-slides': 'Google Slides', 'google-form': 'Google Form',
  'google-drive': 'Google Drive', notion: 'Notion', dropbox: 'Dropbox', docsend: 'DocSend', canva: 'Canva', figma: 'Figma',
  frameio: 'Frame.io', loom: 'Loom', wetransfer: 'WeTransfer', box: 'Box', onedrive: 'OneDrive', deck: 'Deck', airtable: 'Airtable',
  invoice: 'Invoice / payment', file: 'File',
};

const FILES_PREVIEW = 8;
const LINKS_PREVIEW = 6;
const THREADS_PREVIEW = 5;

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
function fmtSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
const cleanSubject = (s: string) => s.replace(/^((re|fwd?|aw|wg|回复|答复|转发)\s*[:：]\s*)+/i, '').trim() || '(no subject)';
const isPdf = (f: { name: string; mimeType: string }) => f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImage = (f: { name: string; mimeType: string }) => f.mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(f.name);

function FileTypeIcon({ f, size = 15 }: { f: { name: string; mimeType: string }; size?: number }) {
  const n = f.name.toLowerCase();
  const cls = 'text-primary/70';
  if (isPdf(f)) return <FileText size={size} className={cls} />;
  if (isImage(f)) return <ImageIcon size={size} className={cls} />;
  if (f.mimeType.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm)$/.test(n)) return <Film size={size} className={cls} />;
  if (/\.(xlsx?|csv|numbers)$/.test(n)) return <FileSpreadsheet size={size} className={cls} />;
  if (/\.(pptx?|key)$/.test(n)) return <Presentation size={size} className={cls} />;
  if (/\.(zip|rar|7z)$/.test(n)) return <FileArchive size={size} className={cls} />;
  return <Paperclip size={size} className={cls} />;
}

interface Props { dealId: string }

export default function DealFilesSection({ dealId }: Props) {
  const [data, setData] = useState<DealFilesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [showAllLinks, setShowAllLinks] = useState(false);
  const [showAllThreads, setShowAllThreads] = useState(false);
  const [linking, setLinking] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const apply = useCallback((r: DealFilesResult) => {
    if (!alive.current) return;
    setData(r);
    setError(null);
    setDealFileCount(r.dealId, r.counts.files + r.counts.links);
  }, []);

  const load = useCallback(async () => {
    try { apply(await getDealFiles({ dealId })); }
    catch (e: any) { if (alive.current) setError(e?.message ?? 'Could not load files'); }
    finally { if (alive.current) setLoading(false); }
  }, [dealId, apply]);

  useEffect(() => { setLoading(true); setData(null); load(); }, [load]);
  // The shared Gmail sync finished → local mail changed → re-read (still no Gmail call).
  useSyncRefresh(() => { load(); });

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const r = await refreshDealFiles({ dealId });
      apply(r);
      const { fetched, discovered, errors } = r.refresh;
      if (errors.length && !fetched) toast.error(`Gmail check failed: ${errors[0]}`);
      else if (!fetched) toast.success('Everything is already synced — no missing files.');
      else toast.success(`Fetched ${fetched} thread${fetched === 1 ? '' : 's'} from Gmail${discovered ? ` (${discovered} new)` : ''}.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Gmail check failed');
    } finally {
      if (alive.current) setRefreshing(false);
    }
  };

  const handleUnlink = async (t: DealThread) => {
    try {
      apply(await unlinkDealThread({ dealId, threadId: t.threadId }));
      toast.success('Thread unlinked — it won’t be matched to this deal again.', {
        action: { label: 'Undo', onClick: () => { linkDealThread({ dealId, threadId: t.threadId }).then(apply).catch(() => toast.error('Undo failed')); } },
      });
    } catch (e: any) { toast.error(e?.message ?? 'Could not unlink'); }
  };

  const handleLink = async (hit: DealThreadSearchHit) => {
    try {
      apply(await linkDealThread({ dealId, threadId: hit.threadId }));
      toast.success('Thread linked to this deal.');
    } catch (e: any) { toast.error(e?.message ?? 'Could not link'); }
  };

  const grouped = useMemo(() => {
    const files = data?.files ?? [];
    const visible = showAllFiles ? files : files.slice(0, FILES_PREVIEW);
    return KINDS.map((k) => ({ ...k, files: visible.filter((f) => f.kind === k.kind), total: files.filter((f) => f.kind === k.kind).length }))
      .filter((g) => g.files.length);
  }, [data, showAllFiles]);

  const threadSubject = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of data?.threads ?? []) m.set(t.threadId, cleanSubject(t.subject));
    return m;
  }, [data]);

  const counts = data?.counts;
  const unsynced = (data?.threads ?? []).filter((t) => !t.synced).length;

  return (
    <section className="rounded-xl border border-border/60 bg-card/40 p-3 sm:p-4" aria-label="Files and threads">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <Paperclip size={14} className="text-primary flex-shrink-0" />
          <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Files &amp; threads</h3>
        </div>
        {counts && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5 font-semibold">{counts.files} file{counts.files === 1 ? '' : 's'}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 font-semibold">{counts.links} link{counts.links === 1 ? '' : 's'}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 font-semibold">{counts.threads} thread{counts.threads === 1 ? '' : 's'}</span>
          </div>
        )}
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          title="Reads Gmail (up to 10 threads) to fill threads that aren’t fully synced and find threads with this deal’s contacts. Nothing is sent or changed."
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Checking Gmail…' : 'Check Gmail for missing files'}
          {!refreshing && unsynced > 0 && <span className="rounded-full bg-primary/15 text-primary px-1.5 text-[10px] font-bold">{unsynced}</span>}
        </button>
      </div>

      {loading && !data ? (
        <div className="mt-4 space-y-2" aria-busy>
          {[0, 1, 2].map((i) => <div key={i} className="h-10 rounded-lg bg-muted/60 animate-pulse" />)}
        </div>
      ) : error && !data ? (
        <div className="mt-4 text-xs text-destructive flex items-center gap-2">
          {error}
          <button type="button" onClick={() => { setLoading(true); load(); }} className="underline">Retry</button>
        </div>
      ) : data ? (
        <div className="mt-3 space-y-5">
          {/* Files */}
          {data.files.length === 0 ? (
            <p className="text-xs text-muted-foreground/70 py-2">
              No contracts, briefs or other documents in this deal’s {data.threads.length === 1 ? 'thread' : `${data.threads.length} threads`} yet.
              {unsynced > 0 && ' Some threads are only partly synced — try “Check Gmail for missing files”.'}
            </p>
          ) : (
            <div className="space-y-3">
              {grouped.map((g) => (
                <div key={g.kind}>
                  <p className="flex items-center gap-1.5 px-1 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                    <g.Icon size={11} /> {g.label} <span className="text-muted-foreground/50">({g.total})</span>
                  </p>
                  <div className="space-y-0.5">
                    {g.files.map((f) => (
                      <FileRow key={f.key} file={f} accountEmail={data.accountEmail} threadSubject={threadSubject.get(f.threadId) ?? ''} />
                    ))}
                  </div>
                </div>
              ))}
              {data.files.length > FILES_PREVIEW && (
                <button type="button" onClick={() => setShowAllFiles((v) => !v)} className="text-[11px] font-medium text-primary hover:underline px-1">
                  {showAllFiles ? 'Show fewer files' : `Show all ${data.files.length} files`}
                </button>
              )}
            </div>
          )}

          {/* Document links */}
          {data.links.length > 0 && (
            <div>
              <p className="flex items-center gap-1.5 px-1 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                <Link2 size={11} /> Document links <span className="text-muted-foreground/50">({data.links.length})</span>
              </p>
              <div className="space-y-0.5">
                {(showAllLinks ? data.links : data.links.slice(0, LINKS_PREVIEW)).map((l) => (
                  <LinkRow key={l.url} link={l} threadSubject={threadSubject.get(l.threadId) ?? ''} />
                ))}
              </div>
              {data.links.length > LINKS_PREVIEW && (
                <button type="button" onClick={() => setShowAllLinks((v) => !v)} className="mt-1 text-[11px] font-medium text-primary hover:underline px-1">
                  {showAllLinks ? 'Show fewer links' : `Show all ${data.links.length} links`}
                </button>
              )}
            </div>
          )}

          {/* Related threads */}
          <div>
            <div className="flex items-center gap-2 px-1 mb-1">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                <MessagesSquare size={11} /> Related threads <span className="text-muted-foreground/50">({data.threads.length})</span>
              </p>
              <button
                type="button"
                onClick={() => setLinking((v) => !v)}
                className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
              >
                {linking ? <X size={11} /> : <Plus size={11} />} {linking ? 'Close' : 'Link a thread'}
              </button>
            </div>
            {linking && <ThreadLinker dealId={dealId} onLink={handleLink} />}
            <div className="space-y-0.5">
              {(showAllThreads ? data.threads : data.threads.slice(0, THREADS_PREVIEW)).map((t) => (
                <ThreadRow key={t.threadId} thread={t} onUnlink={() => handleUnlink(t)} />
              ))}
            </div>
            {data.threads.length > THREADS_PREVIEW && (
              <button type="button" onClick={() => setShowAllThreads((v) => !v)} className="mt-1 text-[11px] font-medium text-primary hover:underline px-1">
                {showAllThreads ? 'Show fewer threads' : `Show all ${data.threads.length} threads`}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ── rows ─────────────────────────────────────────────────────────────────── */

function FileRow({ file, accountEmail, threadSubject }: { file: DealFile; accountEmail: string; threadSubject: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <VersionRow f={file} accountEmail={accountEmail} threadSubject={threadSubject}
        badge={file.versions > 1 ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            className="inline-flex items-center gap-0.5 rounded-full border border-primary/25 bg-primary/10 px-1.5 text-[10px] font-bold text-primary flex-shrink-0"
            title="Show older versions"
          >
            {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />} {file.versions} versions
          </button>
        ) : null}
      />
      {open && file.older.length > 0 && (
        <div className="ml-5 border-l border-border/60 pl-2">
          {file.older.map((o) => <VersionRow key={o.key} f={o} accountEmail={accountEmail} threadSubject={threadSubject} older />)}
        </div>
      )}
    </div>
  );
}

function VersionRow({ f, accountEmail, threadSubject, badge, older }: {
  f: DealFileVersion; accountEmail: string; threadSubject: string; badge?: React.ReactNode; older?: boolean;
}) {
  const [busy, setBusy] = useState<'dl' | 'pv' | null>(null);
  const ref = { messageId: f.messageId, attachmentId: f.attachmentId, accountEmail, name: f.name, mimeType: f.mimeType };
  const download = async () => {
    if (busy) return;
    setBusy('dl');
    try { await downloadAttachment(ref); } catch { toast.error(`Couldn’t download ${f.name}`); } finally { setBusy(null); }
  };
  const preview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy('pv');
    try { await previewAttachment(ref); } catch { toast.error(`Couldn’t open ${f.name}`); } finally { setBusy(null); }
  };
  const who = f.isFromMe ? 'You' : (f.fromName || f.from);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={download}
      onKeyDown={(e) => { if (e.key === 'Enter') download(); }}
      title={`Download ${f.name}`}
      className="group/f flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/60 cursor-pointer transition-colors"
    >
      <div className={`flex-shrink-0 flex items-center justify-center rounded-md border border-primary/10 bg-primary/5 ${older ? 'w-6 h-6' : 'w-8 h-8'}`}>
        <FileTypeIcon f={f} size={older ? 12 : 15} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className={`truncate font-medium text-foreground/90 ${older ? 'text-[11px]' : 'text-[12px]'}`}>{f.name}</p>
          {badge}
        </div>
        <p className="truncate text-[10.5px] text-muted-foreground/80">
          {who}{f.date ? ` · ${fmtDate(f.date)}` : ''}{f.size ? ` · ${fmtSize(f.size)}` : ''}{threadSubject ? ` · ${threadSubject}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {(isPdf(f) || isImage(f)) && (
          <button
            type="button"
            onClick={preview}
            title="Preview in a new tab"
            className="h-7 px-1.5 inline-flex items-center gap-1 rounded-md text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {busy === 'pv' ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
            <span className="hidden sm:inline">Preview</span>
          </button>
        )}
        <span className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground group-hover/f:text-foreground">
          {busy === 'dl' ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
        </span>
      </div>
    </div>
  );
}

function linkLabel(l: DealLink): string {
  if (l.title) return l.title;
  try {
    const u = new URL(l.url);
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path.length > 40 ? path.slice(0, 40) + '…' : path}`;
  } catch { return l.url; }
}

function LinkRow({ link, threadSubject }: { link: DealLink; threadSubject: string }) {
  const who = link.isFromMe ? 'You' : (link.fromName || link.from);
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={link.url}
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/60 transition-colors"
    >
      <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-md bg-muted overflow-hidden">
        <img src={`https://www.google.com/s2/favicons?domain=${link.host}&sz=32`} alt="" width={16} height={16}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="truncate text-[12px] font-medium text-foreground/90">{linkLabel(link)}</p>
        <p className="truncate text-[10.5px] text-muted-foreground/80">
          {LINK_LABEL[link.kind] ?? link.host} · {who}{link.date ? ` · ${fmtDate(link.date)}` : ''}{threadSubject ? ` · ${threadSubject}` : ''}
        </p>
      </div>
      <ExternalLink size={12} className="text-muted-foreground flex-shrink-0" />
    </a>
  );
}

function ThreadRow({ thread: t, onUnlink }: { thread: DealThread; onUnlink: () => void }) {
  const m = MATCH[t.matchedBy];
  const people = t.participants.slice(0, 3).map((p) => p.name || p.email).join(', ') + (t.participants.length > 3 ? ` +${t.participants.length - 3}` : '');
  return (
    <div className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60 transition-colors">
      <Mail size={13} className="mt-0.5 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <Link to={`/deal-organizer/emails?thread=${t.threadId}`} className="truncate max-w-full text-[12px] font-medium text-foreground/90 hover:text-primary hover:underline" title="Open in Emails">
            {cleanSubject(t.subject)}
          </Link>
          <span className={`rounded-full border px-1.5 text-[10px] font-semibold flex-shrink-0 ${m.cls}`} title={`${m.title}${t.via ? ` (${t.via})` : ''}`}>{m.label}</span>
          {!t.synced && <span className="text-[10px] text-muted-foreground/70 flex-shrink-0" title="Not every message of this thread is synced locally">partly synced</span>}
        </div>
        <p className="truncate text-[10.5px] text-muted-foreground/80">
          {people || '—'}{t.lastAt ? ` · ${fmtDate(t.lastAt)}` : ''} · {t.messageCount} msg{t.messageCount === 1 ? '' : 's'}{t.fileCount ? ` · ${t.fileCount} file${t.fileCount === 1 ? '' : 's'}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <a href={t.gmailUrl} target="_blank" rel="noopener noreferrer" title="Open in Gmail"
          className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <ExternalLink size={12} />
        </a>
        <button type="button" onClick={onUnlink} title="Unlink from this deal (won’t be auto-matched again)"
          className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
          <Unlink size={12} />
        </button>
      </div>
    </div>
  );
}

function ThreadLinker({ dealId, onLink }: { dealId: string; onLink: (hit: DealThreadSearchHit) => Promise<void> }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<DealThreadSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await searchDealThreads({ dealId, q });
        if (n === seq.current) setHits(r.threads);
      } catch { /* keep the old list */ }
      finally { if (n === seq.current) setBusy(false); }
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, dealId]);

  return (
    <div className="mb-2 rounded-lg border border-border bg-background/60 p-2">
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2">
        <Search size={12} className="text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search threads — brand, person, subject…"
          className="h-8 flex-1 min-w-0 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
        />
        {busy && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
      </div>
      <div className="mt-1 max-h-64 overflow-y-auto dealorg-scroll">
        {hits.length === 0 && !busy && <p className="px-2 py-2 text-[11px] text-muted-foreground/70">No threads found.</p>}
        {hits.map((h) => (
          <div key={h.threadId} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
            <div className="flex-1 min-w-0">
              <p className="truncate text-[12px] font-medium text-foreground/90">{cleanSubject(h.subject)}</p>
              <p className="truncate text-[10.5px] text-muted-foreground/80">
                {h.counterpart.name || h.counterpart.email}{h.brand ? ` · ${h.brand}` : ''}{h.lastAt ? ` · ${fmtDate(h.lastAt)}` : ''}{h.dealName ? ` · deal: ${h.dealName}` : ''}
              </p>
            </div>
            {h.linked ? (
              <span className="text-[10px] font-semibold text-muted-foreground flex-shrink-0">Linked</span>
            ) : (
              <button
                type="button"
                disabled={linkingId === h.threadId}
                onClick={async () => { setLinkingId(h.threadId); try { await onLink(h); setHits((xs) => xs.map((x) => x.threadId === h.threadId ? { ...x, linked: true } : x)); } finally { setLinkingId(null); } }}
                className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-primary/30 text-[11px] font-medium text-primary hover:bg-primary/10 flex-shrink-0 disabled:opacity-50"
              >
                {linkingId === h.threadId ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Link
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
