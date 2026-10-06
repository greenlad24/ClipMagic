import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Server, RefreshCw, Loader2, Folder, File as FileIcon, Lock, Link2, ChevronRight, Trash2,
  AlertTriangle, CheckCircle2, ArrowUp, Link as LinkIcon, History,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  serverStorageSummary, serverStorageTree, serverStorageType, serverStorageRefresh,
  serverStorageLog, serverStoragePreview, serverStorageDelete,
} from 'zite-endpoints-sdk';

// Everything here comes from the host `storage-agent` service (via
// server/src/zite/serverStorage.ts). The agent enforces every protection — a
// lock icon here only mirrors a refusal the server would make anyway.

interface Disk { total: number; free: number; used: number }
interface FileRec {
  path: string; size: number; apparent?: number; nlink: number; mtime: number; type: string;
  links?: string[]; linksFound?: number; protected?: string | null;
}
interface TypeRow { type: string; label: string; bytes: number; files: number }
interface LinkGroup { ino: number; size: number; nlink: number; linksFound: number; paths: string[]; protected?: string | null }
interface Summary {
  available: boolean; reason?: string; ready?: boolean; indexing?: boolean; progress?: number;
  builtAt?: number | null; duration?: number | null; files?: number; error?: string | null;
  disk?: Disk; types?: TypeRow[]; largest?: FileRec[]; hardlinks?: LinkGroup[]; indexed?: number;
}
interface TreeEntry {
  name: string; path: string; kind: 'dir' | 'file' | 'link' | 'other'; size: number | null;
  files?: number; shared?: number; nlink?: number; type?: string; mtime: number; mount?: boolean;
  protected?: string | null; target?: string;
}
interface Tree {
  available: boolean; path: string; parent: string | null; size: number | null; files: number | null;
  protected?: string | null; entries: TreeEntry[]; totalEntries: number; truncated: boolean; error?: string;
}
interface PlanTarget {
  path: string; ok: boolean; reason?: string; kind?: string; bytes?: number; files?: number;
  externalLinks?: string[]; sharedInodes?: number; nlink?: number;
  heldOpen?: { file: string; size: number; by: { pid: number; comm: string }[] }[];
}
interface Plan {
  planId: string; targets: PlanTarget[]; totalBytes: number; heldOpenBytes: number;
  needsTypedConfirm: boolean; confirmWord: string; refused: number;
}
interface DeleteResult {
  results: { path: string; ok: boolean; bytes?: number; error?: string; errors?: string[]; removedLinks?: string[]; heldOpen?: PlanTarget['heldOpen'] }[];
  expectedBytes: number; freedBytes: number; heldOpenBytes: number; disk: Disk;
}
interface LogEntry { at: string; actor: string; path: string; kind: string; bytes: number; files: number; nlink?: number; externalLinks?: string[]; ok: boolean; heldOpenBytes?: number }

const fmtBytes = (n: number | null | undefined) => {
  if (n == null) return '—';
  if (!n) return '0 B';
  const neg = n < 0;
  const v = Math.abs(n);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  return `${neg ? '−' : ''}${(v / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
const ago = (ms?: number | null) => {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const GB = 1024 ** 3;

type Tab = 'browse' | 'largest' | 'types' | 'links' | 'log';

/** Select-state row metadata so the delete button can show a size before the preview. */
interface Sel { size: number; nlink?: number }

export default function WholeServerStorage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('largest');   // real files first, not the root's system folders
  const [cwd, setCwd] = useState('/');
  const [tree, setTree] = useState<Tree | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [typeSel, setTypeSel] = useState<string | null>(null);
  const [typeFiles, setTypeFiles] = useState<FileRec[] | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [selected, setSelected] = useState<Map<string, Sel>>(new Map());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<DeleteResult | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      setSummary((await serverStorageSummary({})) as Summary);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not reach the storage agent');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTree = useCallback(async (p: string) => {
    setTreeLoading(true);
    try {
      const t = (await serverStorageTree({ path: p })) as Tree;
      setTree(t);
      setCwd(t.path ?? p);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not list that folder');
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => { loadSummary(); loadTree('/'); }, [loadSummary, loadTree]);

  // While the agent is (re-)indexing, poll so sizes fill in when it lands.
  useEffect(() => {
    if (!summary?.indexing) return;
    const t = setInterval(async () => {
      const s = (await serverStorageSummary({}).catch(() => null)) as Summary | null;
      if (s) {
        setSummary(s);
        if (!s.indexing) loadTree(cwd);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [summary?.indexing, cwd, loadTree]);

  useEffect(() => {
    if (tab === 'log') {
      serverStorageLog({ limit: 50 }).then((r: any) => setLog(r.entries ?? [])).catch(() => setLog([]));
    }
  }, [tab, result]);

  const openType = async (t: string) => {
    setTypeSel(t);
    setTypeFiles(null);
    try {
      const r = (await serverStorageType({ type: t })) as { files: FileRec[] };
      setTypeFiles(r.files ?? []);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed');
    }
  };

  const toggle = (path: string, meta: Sel) => {
    setSelected((prev) => {
      const next = new Map(prev);
      next.has(path) ? next.delete(path) : next.set(path, meta);
      return next;
    });
  };
  const selectedBytes = useMemo(() => [...selected.values()].reduce((s, v) => s + (v.size || 0), 0), [selected]);

  const reindex = async () => {
    try {
      await serverStorageRefresh({});
      toast.success('Re-indexing the whole disk — takes a couple of minutes');
      await loadSummary();
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed');
    }
  };

  const startDelete = async () => {
    setPreviewing(true);
    setConfirmText('');
    try {
      setPlan((await serverStoragePreview({ paths: [...selected.keys()] })) as Plan);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not check the selection');
    } finally {
      setPreviewing(false);
    }
  };

  const doDelete = async () => {
    if (!plan) return;
    setDeleting(true);
    try {
      const r = (await serverStorageDelete({ planId: plan.planId, confirm: confirmText.trim() })) as DeleteResult;
      setResult(r);
      setPlan(null);
      setSelected(new Map());
      await Promise.all([loadSummary(), loadTree(cwd)]);
    } catch (e: any) {
      toast.error(e?.message ?? 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  if (loading && !summary) {
    return (
      <div className="rounded-xl border border-border p-6 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading the whole-server view…
      </div>
    );
  }
  if (summary && !summary.available) {
    return (
      <div className="rounded-xl border border-border p-4 space-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Server className="w-3.5 h-3.5" /> Whole server
        </h2>
        <p className="text-[11px] text-muted-foreground">{summary.reason}</p>
      </div>
    );
  }

  const disk = summary?.disk;
  const pct = disk ? Math.round((disk.used / disk.total) * 100) : 0;
  const okTargets = plan?.targets.filter((t) => t.ok) ?? [];
  const typedOk = !plan?.needsTypedConfirm || confirmText.trim() === plan.confirmWord;

  const CheckCell = ({ path, size, nlink, protectedWhy }: { path: string; size: number; nlink?: number; protectedWhy?: string | null }) =>
    protectedWhy ? (
      <span title={`Protected — ${protectedWhy}`} className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
        <Lock className="w-3 h-3 text-muted-foreground/70" />
      </span>
    ) : (
      <input
        type="checkbox"
        checked={selected.has(path)}
        onChange={() => toggle(path, { size, nlink })}
        className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
      />
    );

  const LinkBadge = ({ nlink }: { nlink?: number }) =>
    nlink && nlink > 1 ? (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center gap-1 shrink-0"
        title="Hard-linked: the same bytes appear under several names. Deleting one name frees nothing, so a delete here removes every one of them."
      >
        <Link2 className="w-3 h-3" /> {nlink} links — deleting removes all {nlink}
      </span>
    ) : null;

  const FileRow = ({ f }: { f: FileRec }) => (
    <div className="px-3 py-1.5 flex items-center gap-2.5 hover:bg-muted/30">
      <CheckCell path={f.path} size={f.size} nlink={f.nlink} protectedWhy={f.protected} />
      <div className="min-w-0 flex-1">
        <button
          className="text-xs font-mono truncate block max-w-full text-left hover:underline"
          title={`Open the folder: ${f.path}`}
          onClick={() => { setTab('browse'); loadTree(f.path.replace(/\/[^/]*$/, '') || '/'); }}
        >
          {f.path}
        </button>
        {f.protected && <p className="text-[10px] text-muted-foreground truncate">Protected — {f.protected}</p>}
      </div>
      <LinkBadge nlink={f.nlink} />
      <span className="w-20 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{fmtBytes(f.size)}</span>
    </div>
  );

  const crumbs = cwd === '/' ? ['/'] : ['/', ...cwd.split('/').filter(Boolean)];
  const maxEntry = Math.max(1, ...(tree?.entries ?? []).map((e) => e.size ?? 0));

  return (
    <div className="rounded-xl border border-border p-4 space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5" /> Whole server
          </h2>
          <p className="text-[11px] text-muted-foreground/80 max-w-xl">
            Every file on the server's disk, not just The Lab's. Delete here is real: every hard link of a file goes, and the
            freed space is measured on the disk afterwards. System files, code, secrets, Docker's storage and anything a running
            job is using are locked.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={reindex} disabled={!!summary?.indexing}>
            <RefreshCw className={`w-3.5 h-3.5 ${summary?.indexing ? 'animate-spin' : ''}`} />
            {summary?.indexing ? `Indexing… ${((summary.progress ?? 0) / 1e6).toFixed(1)}M files` : 'Re-index'}
          </Button>
          <Button
            variant="destructive" size="sm" className="h-7 text-xs gap-1.5"
            disabled={selected.size === 0 || previewing}
            onClick={startDelete}
          >
            {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Delete{selected.size > 0 ? ` ${selected.size} (${fmtBytes(selectedBytes)})` : ''}
          </Button>
        </div>
      </div>

      {disk && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">Disk</span>
            <span className="text-muted-foreground font-mono">
              {fmtBytes(disk.free)} free · {fmtBytes(disk.used)} used of {fmtBytes(disk.total)}
            </span>
          </div>
          <div className="h-2.5 bg-muted rounded-full overflow-hidden">
            <div className={`h-full ${pct > 90 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Index: {summary?.ready ? `${(summary.files ?? 0).toLocaleString()} files, built ${ago(summary.builtAt)}` : 'building for the first time…'}
            {summary?.error ? ` · ${summary.error}` : ''}
          </p>
        </div>
      )}

      {/* Type breakdown */}
      {summary?.types && summary.types.length > 0 && (
        <div className="space-y-1">
          {summary.types.map((t) => (
            <button
              key={t.type}
              onClick={() => { setTab('types'); openType(t.type); }}
              className="w-full flex items-center gap-2 text-[11px] hover:bg-muted/40 rounded px-1 py-0.5"
            >
              <span className="w-56 shrink-0 truncate text-left">{t.label}</span>
              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${t.type === 'docker' ? 'bg-sky-500' : 'bg-primary'}`}
                  style={{ width: `${disk ? Math.min(100, (t.bytes / disk.used) * 100) : 0}%` }}
                />
              </div>
              <span className="w-20 shrink-0 text-right font-mono text-muted-foreground">{fmtBytes(t.bytes)}</span>
              <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">{t.files.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border text-xs">
        {([
          ['largest', 'Largest files'], ['browse', 'Folders'], ['types', 'By type'],
          ['links', `Hard links${summary?.hardlinks?.length ? ` (${summary.hardlinks.length})` : ''}`], ['log', 'Deleted'],
        ] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1.5 -mb-px border-b-2 ${tab === k ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'browse' && (
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <div className="px-3 py-2 bg-card/40 border-b border-border flex items-center gap-1 text-[11px] flex-wrap">
            {cwd !== '/' && (
              <button className="p-0.5 mr-1 rounded hover:bg-muted" title="Up" onClick={() => loadTree(tree?.parent ?? '/')}>
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            )}
            {crumbs.map((c, i) => {
              const p = i === 0 ? '/' : '/' + crumbs.slice(1, i + 1).join('/');
              return (
                <span key={p} className="flex items-center gap-1">
                  {i > 1 && <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                  <button className="font-mono hover:underline" onClick={() => loadTree(p)}>{c}</button>
                </span>
              );
            })}
            <span className="ml-auto text-muted-foreground font-mono">
              {treeLoading ? <Loader2 className="w-3 h-3 animate-spin inline" /> : fmtBytes(tree?.size)}
            </span>
          </div>
          {tree?.protected && cwd !== '/' && (
            <div className="px-3 py-1.5 text-[11px] text-muted-foreground flex items-center gap-1.5 border-b border-border/60">
              <Lock className="w-3 h-3" /> This folder is protected — {tree.protected}.
            </div>
          )}
          {tree?.error && <div className="px-3 py-3 text-xs text-destructive">{tree.error}</div>}
          <div className="divide-y divide-border/50 max-h-[32rem] overflow-y-auto">
            {(tree?.entries ?? []).map((e) => (
              <div key={e.path} className="px-3 py-1.5 flex items-center gap-2.5 hover:bg-muted/30">
                <CheckCell path={e.path} size={e.size ?? 0} nlink={e.nlink} protectedWhy={e.mount ? 'a separate filesystem' : e.protected} />
                {e.kind === 'dir' ? <Folder className="w-3.5 h-3.5 text-primary/80 shrink-0" /> : e.kind === 'link' ? <LinkIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <FileIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                <div className="min-w-0 flex-1">
                  {e.kind === 'dir' && !e.mount ? (
                    <button className="text-xs truncate max-w-full text-left hover:underline flex items-center gap-1 text-foreground" onClick={() => loadTree(e.path)}
                      title={`Open ${e.path}`}>
                      {e.name}/ <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                    </button>
                  ) : (
                    <span className="text-xs truncate block">{e.name}{e.target ? ` → ${e.target}` : ''}</span>
                  )}
                  {(e.protected || (e.shared ?? 0) > 0) && (
                    <p className="text-[10px] text-muted-foreground truncate">
                      {e.protected
                        ? (e.kind === 'dir' && !e.mount && /top-level|root of/.test(e.protected)
                          ? 'System folder — open it to see and delete the files inside'
                          : `Protected — ${e.protected}`)
                        : `${fmtBytes(e.shared)} of this is hard-linked from elsewhere — deleting removes those links too`}
                    </p>
                  )}
                </div>
                <LinkBadge nlink={e.nlink} />
                <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden shrink-0 hidden sm:block">
                  <div className="h-full bg-primary/70 rounded-full" style={{ width: `${((e.size ?? 0) / maxEntry) * 100}%` }} />
                </div>
                <span className="w-20 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {e.size == null ? 'indexing…' : fmtBytes(e.size)}
                </span>
              </div>
            ))}
            {tree && tree.entries.length === 0 && !tree.error && <div className="px-3 py-6 text-center text-xs text-muted-foreground">Empty</div>}
            {tree?.truncated && (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">Showing the largest {tree.entries.length} of {tree.totalEntries.toLocaleString()} entries.</div>
            )}
          </div>
        </div>
      )}

      {tab === 'largest' && (
        <div className="rounded-lg border border-border/60 divide-y divide-border/50 max-h-[32rem] overflow-y-auto">
          {(summary?.largest ?? []).map((f) => <FileRow key={f.path} f={f} />)}
        </div>
      )}

      {tab === 'types' && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {(summary?.types ?? []).map((t) => (
              <button
                key={t.type}
                onClick={() => openType(t.type)}
                className={`text-[11px] px-2 py-1 rounded border ${typeSel === t.type ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'}`}
              >
                {t.label} · {fmtBytes(t.bytes)}
              </button>
            ))}
          </div>
          {typeSel && (
            <div className="rounded-lg border border-border/60 divide-y divide-border/50 max-h-[32rem] overflow-y-auto">
              {typeFiles == null
                ? <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
                : typeFiles.map((f) => <FileRow key={f.path} f={f} />)}
            </div>
          )}
          {!typeSel && <p className="text-[11px] text-muted-foreground">Pick a type to see its largest files.</p>}
        </div>
      )}

      {tab === 'links' && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Files stored once but reachable under several names. Deleting any one name frees nothing — so deleting from here
            removes every name listed, and the bytes come back.
          </p>
          {(summary?.hardlinks ?? []).map((g) => {
            const first = g.paths[0];
            return (
              <div key={g.ino} className="rounded-lg border border-border/60 px-3 py-2 space-y-1">
                <div className="flex items-center gap-2.5">
                  <CheckCell path={first} size={g.size} nlink={g.nlink} protectedWhy={g.protected} />
                  <span className="text-xs font-mono truncate flex-1">{first.split('/').pop()}</span>
                  <LinkBadge nlink={g.nlink} />
                  <span className="w-20 text-right font-mono text-[11px] text-muted-foreground">{fmtBytes(g.size)}</span>
                </div>
                <div className="pl-6 text-[10px] font-mono text-muted-foreground space-y-0.5">
                  {g.paths.slice(0, 6).map((p) => <div key={p} className="truncate">{p}</div>)}
                  {g.paths.length > 6 && <div>…and {g.nlink - 6} more</div>}
                  {g.linksFound < g.nlink && <div className="text-amber-600">Only {g.linksFound} of {g.nlink} names are on this disk's index — a delete will be refused until all are found.</div>}
                </div>
              </div>
            );
          })}
          {summary?.hardlinks?.length === 0 && <p className="text-xs text-muted-foreground">No hard-linked files over 1 MB.</p>}
        </div>
      )}

      {tab === 'log' && (
        <div className="rounded-lg border border-border/60 divide-y divide-border/50 max-h-[32rem] overflow-y-auto">
          {log == null && <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>}
          {log?.length === 0 && <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><History className="w-3.5 h-3.5" /> Nothing deleted from here yet.</div>}
          {log?.map((l, i) => (
            <div key={i} className="px-3 py-1.5 text-[11px] flex items-center gap-2">
              {l.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-teal-500 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
              <span className="font-mono truncate flex-1" title={l.path}>{l.path}</span>
              {(l.externalLinks?.length ?? 0) > 0 && <span className="text-muted-foreground">+{l.externalLinks!.length} links</span>}
              <span className="font-mono text-muted-foreground w-20 text-right">{fmtBytes(l.bytes)}</span>
              <span className="text-muted-foreground w-40 text-right truncate" title={l.actor}>{new Date(l.at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* Preview → confirm */}
      <AlertDialog open={!!plan} onOpenChange={(o) => !o && !deleting && setPlan(null)}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {okTargets.length ? `Permanently delete ${fmtBytes(plan?.totalBytes)} from the server?` : 'Nothing here can be deleted'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-xs">
                <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
                  {plan?.targets.map((t) => (
                    <div key={t.path} className={`rounded border px-2 py-1.5 ${t.ok ? 'border-border' : 'border-amber-500/40 bg-amber-500/5'}`}>
                      <div className="flex items-center gap-2">
                        {t.ok ? <Trash2 className="w-3 h-3 text-destructive shrink-0" /> : <Lock className="w-3 h-3 text-amber-600 shrink-0" />}
                        <span className="font-mono truncate flex-1 text-foreground">{t.path}</span>
                        {t.ok && <span className="font-mono">{fmtBytes(t.bytes)}</span>}
                      </div>
                      {!t.ok && <p className="pl-5 text-amber-700 dark:text-amber-400">Won't be deleted: {t.reason}</p>}
                      {t.ok && t.kind === 'dir' && <p className="pl-5">Folder with {(t.files ?? 0).toLocaleString()} files — removed with everything in it.</p>}
                      {t.ok && (t.externalLinks?.length ?? 0) > 0 && (
                        <div className="pl-5">
                          <p>Also removes {t.externalLinks!.length} other name{t.externalLinks!.length !== 1 ? 's' : ''} of the same data (hard links), otherwise nothing would be freed:</p>
                          {t.externalLinks!.slice(0, 5).map((p) => <p key={p} className="font-mono truncate">· {p}</p>)}
                          {t.externalLinks!.length > 5 && <p>· …and {t.externalLinks!.length - 5} more</p>}
                        </div>
                      )}
                      {t.ok && (t.heldOpen?.length ?? 0) > 0 && (
                        <p className="pl-5 text-amber-700 dark:text-amber-400">
                          {t.heldOpen!.map((h) => `${h.file.split('/').pop()} is open in ${h.by.map((b) => `${b.comm} (pid ${b.pid})`).join(', ')}`).join('; ')} —
                          its space only comes back when that process closes it.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                {okTargets.length > 0 && (
                  <p>This cannot be undone. Every delete is recorded in the server's deletion log.</p>
                )}
                {plan?.needsTypedConfirm && okTargets.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-foreground">More than 1 GB — type <span className="font-mono font-semibold">{plan.confirmWord}</span> to confirm.</p>
                    <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={plan.confirmWord} className="h-8 font-mono" autoFocus />
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            {okTargets.length > 0 && (
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={(e) => { e.preventDefault(); doDelete(); }}
                disabled={deleting || !typedOk}
              >
                {deleting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Delete {fmtBytes(plan?.totalBytes)}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Result: what the disk actually got back */}
      <AlertDialog open={!!result} onOpenChange={(o) => !o && setResult(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Freed {fmtBytes(Math.max(0, result?.freedBytes ?? 0))} on the disk</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-xs">
                <p>
                  Expected {fmtBytes(result?.expectedBytes)}; measured on the disk {fmtBytes(result?.freedBytes)}
                  {result?.disk ? ` · now ${fmtBytes(result.disk.free)} free` : ''}.
                  {' '}Other programs writing at the same moment make the measured number drift a little either way.
                </p>
                {(result?.heldOpenBytes ?? 0) > 0 && (
                  <p className="text-amber-700 dark:text-amber-400">
                    {fmtBytes(result!.heldOpenBytes)} is deleted but still held open by a running process — that space returns when the process
                    closes the file (or is restarted).
                  </p>
                )}
                {result?.results.filter((r) => !r.ok).map((r) => (
                  <p key={r.path} className="text-amber-700 dark:text-amber-400 font-mono break-all">
                    {r.path}: {r.error ?? r.errors?.slice(0, 3).join('; ')}
                  </p>
                ))}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setResult(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
