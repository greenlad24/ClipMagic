/**
 * Code Import — bring a tool's source code into the Lab before porting it.
 *
 * Jake, 2026-09-28: "I want to recreate another tool that I have on Zite ... where
 * can I paste all of the source code to have a clear start" + "I want a UI for it".
 *
 * Three ways in (zip, folder/files, paste), one place to browse what arrived,
 * and a notes box for what the tool does and what to build next. The code is
 * staged on the Lab's data volume under imports/<name>/ — it is not built or
 * deployed; porting it into the Lab is the next, separate step.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ClipboardPaste,
  FileArchive,
  FileCode2,
  FolderOpen,
  FolderUp,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import {
  codeImportDelete,
  codeImportDeleteFile,
  codeImportGet,
  codeImportList,
  codeImportReadFile,
  codeImportSaveFiles,
  codeImportSaveNotes,
  codeImportUploadZip,
  type CodeImportDetail,
  type CodeImportFileIn,
  type CodeImportSummary,
} from 'zite-endpoints-sdk';

/** Same list the server skips — filtered here too so they are never uploaded. */
const SKIP_DIRS = new Set(['node_modules', '.git', '__MACOSX', '.next', 'dist', 'build', '.turbo', '.cache']);
/** Requests are batched so one huge folder is not one huge JSON body. */
const BATCH_BYTES = 24 * 1024 * 1024;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const skipped = (p: string) => p.split('/').some((seg) => SKIP_DIRS.has(seg)) || p.endsWith('.DS_Store');

/** Walk a dropped folder (DataTransferItem entries) into [relativePath, File]. */
async function filesFromDrop(items: DataTransferItemList): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = [];
  const readEntry = async (entry: any, prefix: string): Promise<void> => {
    if (!entry) return;
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) return;
      const reader = entry.createReader();
      // readEntries returns in chunks; keep reading until empty.
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = Array.from(items)
    .map((i) => (i as any).webkitGetAsEntry?.())
    .filter(Boolean);
  for (const e of entries) await readEntry(e, '');
  return out;
}

/** A single dropped folder arrives as "my-tool/src/…" — drop that shared top folder. */
function stripCommonRoot(list: { path: string; file: File }[]): { path: string; file: File }[] {
  const tops = new Set(list.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
  if (tops.size !== 1 || tops.has('')) return list;
  const root = [...tops][0];
  return list.map((f) => ({ ...f, path: f.path.slice(root.length + 1) }));
}

/**
 * Split pasted text on FILE markers. Accepts the forms people actually paste:
 *   // FILE: src/app.tsx      # FILE: main.py      <!-- FILE: index.html -->
 *   --- FILE: x ---           ### src/app.tsx  (a markdown heading that is a path)
 * Fenced code blocks directly under a marker are unwrapped.
 */
function parsePasted(text: string): { path: string; content: string }[] {
  const marker = /^\s*(?:\/\/|#|<!--|---|\*)?\s*FILE:\s*([^\s>*-][^\s>]*)\s*(?:-->|---|\*\/)?\s*$/i;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: { path: string; content: string[] }[] = [];
  for (const line of lines) {
    const m = line.match(marker);
    if (m) files.push({ path: m[1].replace(/^\.\//, ''), content: [] });
    else if (files.length) files[files.length - 1].content.push(line);
  }
  return files.map((f) => {
    let body = f.content.join('\n').replace(/^\n+|\s+$/g, '');
    const fenced = body.match(/^```[\w.-]*\n([\s\S]*?)\n```$/);
    if (fenced) body = fenced[1];
    return { path: f.path, content: body + '\n' };
  });
}

/* ── the page ───────────────────────────────────────────────────────────── */

export default function CodeImportPage() {
  const [imports, setImports] = useState<CodeImportSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CodeImportDetail | null>(null);
  const [newName, setNewName] = useState('');

  const refreshList = useCallback(async () => {
    try {
      const r = await codeImportList({});
      setImports(r.imports);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setImports([]);
    }
  }, []);

  const refreshDetail = useCallback(async (name: string) => {
    try {
      setDetail(await codeImportGet({ name }));
    } catch {
      // A brand-new import has no folder until the first file lands.
      setDetail({ name, files: [], notes: '', hostPath: `imports/${name}` });
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (selected) void refreshDetail(selected);
    else setDetail(null);
  }, [selected, refreshDetail]);

  const afterChange = useCallback(async () => {
    await refreshList();
    if (selected) await refreshDetail(selected);
  }, [refreshList, refreshDetail, selected]);

  const startNew = () => {
    const slug = slugify(newName);
    if (!slug) {
      toast.error('Give the import a name, e.g. "lead-finder".');
      return;
    }
    setSelected(slug);
    setNewName('');
  };

  return (
    <Layout breadcrumb="Code import">
      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Code import</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Bring a tool's source code in from Zite, a repo or anywhere else — as a zip, a folder, or pasted files. It
            is staged here, not deployed. Once it's in, ask Claude to port it into the Lab as a new tool and build on it.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          {/* ── imports list ── */}
          <aside className="space-y-4">
            <div className="rounded-lg border border-border bg-card p-3">
              <Label htmlFor="new-import" className="text-xs text-muted-foreground">
                New import
              </Label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="new-import"
                  placeholder="tool name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && startNew()}
                />
                <Button size="icon" onClick={startNew} aria-label="Create import">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {newName && slugify(newName) !== newName && (
                <p className="mt-1 text-xs text-muted-foreground">Saved as “{slugify(newName) || '…'}”</p>
              )}
            </div>

            <div className="rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Imports</span>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void refreshList()} aria-label="Refresh">
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
              {imports === null ? (
                <div className="p-4 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                  Loading…
                </div>
              ) : imports.length === 0 && !selected ? (
                <p className="p-4 text-sm text-muted-foreground">Nothing imported yet. Name one above to start.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {selected && !imports.some((i) => i.name === selected) && (
                    <li>
                      <button className="w-full bg-primary/10 px-3 py-2.5 text-left">
                        <div className="truncate text-sm font-medium">{selected}</div>
                        <div className="text-xs text-muted-foreground">new — add code to save it</div>
                      </button>
                    </li>
                  )}
                  {imports.map((i) => (
                    <li key={i.name}>
                      <button
                        onClick={() => setSelected(i.name)}
                        className={cn(
                          'w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
                          selected === i.name && 'bg-primary/10',
                        )}
                      >
                        <div className="truncate text-sm font-medium">{i.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {i.files} files · {human(i.bytes)} · {ago(i.updatedAt)}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {/* ── the selected import ── */}
          <section className="min-w-0">
            {!selected || !detail ? (
              <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-border text-center text-sm text-muted-foreground">
                <FileCode2 className="mb-3 h-8 w-8" />
                Pick an import on the left, or name a new one.
              </div>
            ) : (
              <ImportView key={selected} detail={detail} onChanged={afterChange} onDeleted={() => { setSelected(null); void refreshList(); }} />
            )}
          </section>
        </div>
      </div>
    </Layout>
  );
}

/* ── one import ─────────────────────────────────────────────────────────── */

function ImportView({
  detail,
  onChanged,
  onDeleted,
}: {
  detail: CodeImportDetail;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const total = detail.files.reduce((s, f) => s + f.bytes, 0);
  const [tab, setTab] = useState(detail.files.length ? 'files' : 'add');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold">{detail.name}</h2>
          <p className="text-sm text-muted-foreground">
            {detail.files.length} files · {human(total)} · stored at <code className="text-xs">/data/{detail.hostPath}</code>
          </p>
        </div>
        {detail.files.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete import
          </Button>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="add">Add code</TabsTrigger>
          <TabsTrigger value="files">Files ({detail.files.length})</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>
        <TabsContent value="add" className="mt-4">
          <AddCode name={detail.name} hasFiles={detail.files.length > 0} onSaved={async () => { await onChanged(); setTab('files'); }} />
        </TabsContent>
        <TabsContent value="files" className="mt-4">
          <FileBrowser detail={detail} onChanged={onChanged} />
        </TabsContent>
        <TabsContent value="notes" className="mt-4">
          <Notes name={detail.name} initial={detail.notes} onSaved={onChanged} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{detail.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes all {detail.files.length} staged files and the notes. Anything already ported into the Lab
              is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  await codeImportDelete({ name: detail.name });
                  toast.success(`Deleted ${detail.name}`);
                  onDeleted();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ── adding code: zip · folder/files · paste ────────────────────────────── */

function AddCode({ name, hasFiles, onSaved }: { name: string; hasFiles: boolean; onSaved: () => Promise<void> }) {
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pasted, setPasted] = useState('');
  const [singlePath, setSinglePath] = useState('');
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parsePasted(pasted), [pasted]);

  const report = (saved: number, skippedList: string[], extra = '') => {
    toast.success(`Saved ${saved} file${saved === 1 ? '' : 's'} to ${name}${extra}`);
    if (skippedList.length) toast.warning(`Skipped ${skippedList.length}: ${skippedList.slice(0, 3).join(', ')}${skippedList.length > 3 ? '…' : ''}`);
  };

  const uploadZip = async (file: File) => {
    setBusy(`Unpacking ${file.name}…`);
    try {
      const r = await codeImportUploadZip({ name, zipBase64: await readAsBase64(file), replace });
      report(r.saved, r.skipped, r.stripped ? ` (top folder “${r.stripped}” removed)` : '');
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const uploadFiles = async (list: { path: string; file: File }[]) => {
    const keep = stripCommonRoot(list).filter((f) => f.path && !skipped(f.path));
    if (!keep.length) {
      toast.error('Nothing to upload (node_modules, .git and build folders are skipped).');
      return;
    }
    // A single dropped .zip is a zip, not a file to stage as-is.
    if (keep.length === 1 && keep[0].file.name.toLowerCase().endsWith('.zip')) return uploadZip(keep[0].file);

    let saved = 0;
    const skippedAll: string[] = [];
    let first = true;
    try {
      let batch: CodeImportFileIn[] = [];
      let size = 0;
      const flush = async () => {
        if (!batch.length) return;
        const r = await codeImportSaveFiles({ name, files: batch, replace: replace && first });
        first = false;
        saved += r.saved;
        skippedAll.push(...r.skipped);
        batch = [];
        size = 0;
      };
      for (let i = 0; i < keep.length; i++) {
        setBusy(`Uploading ${i + 1} of ${keep.length}…`);
        batch.push({ path: keep[i].path, content: await readAsBase64(keep[i].file), encoding: 'base64' });
        size += keep[i].file.size;
        if (size >= BATCH_BYTES) await flush();
      }
      await flush();
      report(saved, skippedAll);
      await onSaved();
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : String(e)}${saved ? ` (${saved} files were saved before this)` : ''}`);
    } finally {
      setBusy(null);
    }
  };

  const savePasted = async () => {
    const files = parsed.length
      ? parsed
      : singlePath.trim()
        ? [{ path: singlePath.trim(), content: pasted }]
        : [];
    if (!files.length) {
      toast.error('Add FILE: markers, or give the pasted code a file path.');
      return;
    }
    setBusy('Saving…');
    try {
      const r = await codeImportSaveFiles({ name, files, replace });
      report(r.saved, r.skipped);
      setPasted('');
      setSinglePath('');
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      {hasFiles && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <Switch id="replace" checked={replace} onCheckedChange={setReplace} />
          <Label htmlFor="replace" className="text-sm">
            Replace everything already in this import
            <span className="block text-xs font-normal text-muted-foreground">
              Off: new files are added and same-named files are overwritten. Notes are always kept.
            </span>
          </Label>
        </div>
      )}

      {/* Drop zone: a zip, a folder, or loose files */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragOver(false);
          if (busy) return;
          const list = await filesFromDrop(e.dataTransfer.items);
          await uploadFiles(list);
        }}
        className={cn(
          'rounded-lg border-2 border-dashed p-8 text-center transition-colors',
          dragOver ? 'border-primary bg-primary/5' : 'border-border',
        )}
      >
        {busy ? (
          <div className="flex items-center justify-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {busy}
          </div>
        ) : (
          <>
            <Upload className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">Drop a zip, a folder, or files here</p>
            <p className="mt-1 text-xs text-muted-foreground">
              node_modules, .git and build output are skipped automatically. A zip's single top folder is removed.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => zipInput.current?.click()}>
                <FileArchive className="mr-2 h-4 w-4" />
                Choose zip
              </Button>
              <Button variant="outline" size="sm" onClick={() => folderInput.current?.click()}>
                <FolderUp className="mr-2 h-4 w-4" />
                Choose folder
              </Button>
              <Button variant="outline" size="sm" onClick={() => filesInput.current?.click()}>
                <FolderOpen className="mr-2 h-4 w-4" />
                Choose files
              </Button>
            </div>
          </>
        )}
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void uploadZip(f);
          }}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          className="hidden"
          {...({ webkitdirectory: '', directory: '' } as any)}
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []).map((f) => ({ path: (f as any).webkitRelativePath || f.name, file: f }));
            e.target.value = '';
            void uploadFiles(list);
          }}
        />
        <input
          ref={filesInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []).map((f) => ({ path: f.name, file: f }));
            e.target.value = '';
            void uploadFiles(list);
          }}
        />
      </div>

      {/* Paste */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center gap-2">
          <ClipboardPaste className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Paste code</h3>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Paste one file and give it a path, or paste many at once with a marker line above each —{' '}
          <code>// FILE: src/pages/Home.tsx</code>, <code># FILE: main.py</code> or <code>&lt;!-- FILE: index.html --&gt;</code>.
        </p>
        <Textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={'// FILE: src/App.tsx\nexport default function App() { … }\n\n// FILE: server/index.ts\n…'}
          className="min-h-[260px] font-mono text-xs"
          spellCheck={false}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {parsed.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {parsed.length} file{parsed.length === 1 ? '' : 's'} found: {parsed.slice(0, 4).map((f) => f.path).join(', ')}
              {parsed.length > 4 ? '…' : ''}
            </p>
          ) : (
            <Input
              value={singlePath}
              onChange={(e) => setSinglePath(e.target.value)}
              placeholder="file path, e.g. src/pages/Home.tsx"
              className="max-w-sm font-mono text-xs"
            />
          )}
          <Button size="sm" className="ml-auto" disabled={!pasted.trim() || !!busy} onClick={() => void savePasted()}>
            <Save className="mr-2 h-4 w-4" />
            Save pasted code
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── browsing what arrived ──────────────────────────────────────────────── */

function FileBrowser({ detail, onChanged }: { detail: CodeImportDetail; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; content: string; binary: boolean; bytes: number } | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!open) return setFile(null);
    let live = true;
    codeImportReadFile({ name: detail.name, path: open })
      .then((f) => live && setFile(f))
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open, detail.name]);

  const shown = detail.files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()));

  if (!detail.files.length) {
    return <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No files yet — use “Add code”.</p>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(220px,320px)_1fr]">
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border p-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" className="h-8 text-xs" />
        </div>
        <ul className="max-h-[560px] overflow-auto py-1">
          {shown.map((f) => (
            <li key={f.path}>
              <button
                onClick={() => setOpen(f.path)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-muted/50',
                  open === f.path && 'bg-primary/10',
                )}
                title={f.path}
              >
                <span className="truncate">{f.path}</span>
                <span className="shrink-0 text-muted-foreground">{human(f.bytes)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-w-0 rounded-lg border border-border bg-card">
        {!open ? (
          <p className="p-8 text-center text-sm text-muted-foreground">Pick a file to read it.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <code className="truncate text-xs">{open}</code>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    await codeImportDeleteFile({ name: detail.name, path: open });
                    toast.success(`Removed ${open}`);
                    setOpen(null);
                    await onChanged();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Remove
              </Button>
            </div>
            {!file ? (
              <div className="p-4 text-sm text-muted-foreground">
                <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : file.binary ? (
              <p className="p-4 text-sm text-muted-foreground">Binary file · {human(file.bytes)} — kept as-is.</p>
            ) : (
              <pre className="max-h-[560px] overflow-auto p-4 font-mono text-xs leading-relaxed">{file.content}</pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── notes: what the tool does, what to build next ──────────────────────── */

function Notes({ name, initial, onSaved }: { name: string; initial: string; onSaved: () => Promise<void> }) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = text !== initial;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        What this tool does, how it's used, and the features you want added. Claude reads this when porting it.
      </p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'What it does:\n\nWho uses it / how:\n\nKeys or services it needs:\n\nNew features I want:\n- '}
        className="min-h-[320px] text-sm"
      />
      <Button
        disabled={!dirty || saving}
        onClick={async () => {
          setSaving(true);
          try {
            await codeImportSaveNotes({ name, notes: text });
            toast.success('Notes saved');
            await onSaved();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          } finally {
            setSaving(false);
          }
        }}
      >
        <Save className="mr-2 h-4 w-4" />
        Save notes
      </Button>
    </div>
  );
}
