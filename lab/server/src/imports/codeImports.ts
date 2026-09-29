/**
 * Code Import — a staging area for source code brought in from elsewhere
 * (a Zite tool, a repo, pasted files) before it is ported into the Lab.
 *
 * Jake, 2026-09-28: "I want to recreate another tool that I have on Zite ...
 * where can I paste all of the source code" + "I want a UI for it".
 *
 * Everything lands under DATA_DIR/imports/<name>/ — on the Lab's data volume,
 * NOT in the Lab's source tree, so nothing pasted here is compiled or deployed.
 * Porting it into lab/src + lab/server/src is a separate, deliberate step.
 *
 * ⚠️ PATHS COME FROM THE BROWSER AND FROM ZIP ENTRIES. Every one is normalised
 * and must stay inside its import folder: an entry named "../../x" or "/etc/x"
 * is refused, never "cleaned up" into somewhere plausible (zip-slip).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const run = promisify(execFile);

export const IMPORTS_ROOT = path.join(config.dataDir, "imports");
const NOTES_FILE = "NOTES.md";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_BYTES = 300 * 1024 * 1024;
/** Never worth importing, and each can be thousands of files. */
const SKIP_DIRS = new Set(["node_modules", ".git", "__MACOSX", ".next", "dist", "build", ".turbo", ".cache"]);

export class ImportError extends Error {}

export function importName(raw: unknown): string {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(name)) {
    throw new ImportError("Name the import with lowercase letters, numbers and dashes (e.g. my-zite-tool).");
  }
  return name;
}

function importDir(name: string): string {
  return path.join(IMPORTS_ROOT, importName(name));
}

/** A relative path that stays inside the import, or an error. Never repaired. */
export function safeRelPath(raw: unknown): string {
  const p = String(raw ?? "").replace(/\\/g, "/").trim();
  if (!p || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) throw new ImportError(`"${p}" is not a relative path.`);
  const norm = path.posix.normalize(p);
  if (norm === "." || norm.startsWith("../") || norm === ".." || norm.split("/").includes("..")) {
    throw new ImportError(`"${p}" points outside the import.`);
  }
  if (norm.split("/").some((seg) => SKIP_DIRS.has(seg))) throw new ImportError(`"${p}" is inside a skipped folder.`);
  return norm;
}

function walk(dir: string, base = dir): { path: string; bytes: number; mtime: number }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { path: string; bytes: number; mtime: number }[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full, base));
    else if (ent.isFile()) {
      const st = fs.statSync(full);
      out.push({ path: path.relative(base, full).split(path.sep).join("/"), bytes: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

export interface ImportSummary {
  name: string;
  files: number;
  bytes: number;
  updatedAt: number;
  hasNotes: boolean;
}

export function listImports(): ImportSummary[] {
  if (!fs.existsSync(IMPORTS_ROOT)) return [];
  return fs
    .readdirSync(IMPORTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const files = walk(path.join(IMPORTS_ROOT, d.name));
      const code = files.filter((f) => f.path !== NOTES_FILE);
      return {
        name: d.name,
        files: code.length,
        bytes: code.reduce((s, f) => s + f.bytes, 0),
        updatedAt: Math.max(fs.statSync(path.join(IMPORTS_ROOT, d.name)).mtimeMs, ...files.map((f) => f.mtime)),
        hasNotes: files.some((f) => f.path === NOTES_FILE),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getImport(name: string): { name: string; files: { path: string; bytes: number }[]; notes: string; hostPath: string } {
  const dir = importDir(name);
  if (!fs.existsSync(dir)) throw new ImportError(`No import called "${name}".`);
  const files = walk(dir)
    .filter((f) => f.path !== NOTES_FILE)
    .map(({ path: p, bytes }) => ({ path: p, bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const notesPath = path.join(dir, NOTES_FILE);
  return {
    name: importName(name),
    files,
    notes: fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : "",
    hostPath: `imports/${importName(name)}`,
  };
}

/** A NUL byte in the first 8KB is how git decides "binary" too. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export function readImportFile(name: string, rel: string): { path: string; content: string; binary: boolean; bytes: number } {
  const file = path.join(importDir(name), safeRelPath(rel));
  if (!fs.existsSync(file)) throw new ImportError(`No file "${rel}".`);
  const buf = fs.readFileSync(file);
  const binary = looksBinary(buf);
  return { path: safeRelPath(rel), content: binary ? "" : buf.toString("utf8"), binary, bytes: buf.length };
}

export interface IncomingFile {
  path: string;
  content: string;
  /** "base64" for binaries picked from a folder; text otherwise. */
  encoding?: "utf8" | "base64";
}

export function saveFiles(
  name: string,
  files: IncomingFile[],
  opts: { replace?: boolean } = {},
): { saved: number; skipped: string[]; bytes: number } {
  const dir = importDir(name);
  if (!Array.isArray(files) || files.length === 0) throw new ImportError("No files were sent.");

  // Validate every path before writing any — a batch is all or nothing.
  const prepared = files.map((f) => {
    const rel = safeRelPath(f.path);
    const buf = Buffer.from(String(f.content ?? ""), f.encoding === "base64" ? "base64" : "utf8");
    return { rel, buf };
  });
  const skipped = prepared.filter((f) => f.buf.length > MAX_FILE_BYTES).map((f) => `${f.rel} (over 20 MB)`);
  const keep = prepared.filter((f) => f.buf.length <= MAX_FILE_BYTES);
  const incoming = keep.reduce((s, f) => s + f.buf.length, 0);
  const existing = opts.replace ? 0 : walk(dir).reduce((s, f) => s + f.bytes, 0);
  if (existing + incoming > MAX_IMPORT_BYTES) throw new ImportError("That would take this import over 300 MB.");

  if (opts.replace && fs.existsSync(dir)) {
    // Keep the notes: they describe the tool, not this copy of its code.
    const notes = path.join(dir, NOTES_FILE);
    const kept = fs.existsSync(notes) ? fs.readFileSync(notes) : null;
    fs.rmSync(dir, { recursive: true, force: true });
    if (kept) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(notes, kept);
    }
  }
  for (const f of keep) {
    const target = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.buf);
  }
  return { saved: keep.length, skipped, bytes: incoming };
}

/**
 * Unpack a zip into the import.
 *
 * The container has python3 and no `unzip`, so the extraction is Python's
 * zipfile — with the same rules as `saveFiles`: every member path is checked
 * before anything is written, skipped folders are dropped, and a zip whose
 * contents all sit under one top folder ("my-tool-main/…", which is what every
 * GitHub/Zite download looks like) has that folder stripped.
 */
export async function saveZip(
  name: string,
  zipBase64: string,
  opts: { replace?: boolean } = {},
): Promise<{ saved: number; skipped: string[]; bytes: number; stripped: string | null }> {
  importName(name);
  const buf = Buffer.from(String(zipBase64 ?? ""), "base64");
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new ImportError("That file is not a zip.");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeimport-"));
  try {
    const zipPath = path.join(tmp, "in.zip");
    fs.writeFileSync(zipPath, buf);
    const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
out = []
for i in z.infolist():
    if i.is_dir():
        continue
    out.append({"path": i.filename, "size": i.file_size})
print(json.dumps(out))
`;
    const { stdout } = await run("python3", ["-c", script, zipPath], { maxBuffer: 64 * 1024 * 1024 });
    const entries = JSON.parse(stdout) as { path: string; size: number }[];

    const segs = entries.map((e) => e.path.replace(/\\/g, "/").split("/"));
    const tops = new Set(segs.map((s) => (s.length > 1 ? s[0] : "")));
    const strip = tops.size === 1 && !tops.has("") ? [...tops][0] : null;

    const skipped: string[] = [];
    const wanted: { member: string; rel: string }[] = [];
    for (const e of entries) {
      let p = e.path.replace(/\\/g, "/");
      if (strip) p = p.slice(strip.length + 1);
      if (!p) continue;
      if (p.split("/").some((seg) => SKIP_DIRS.has(seg)) || p.split("/").pop() === ".DS_Store") continue;
      if (e.size > MAX_FILE_BYTES) {
        skipped.push(`${p} (over 20 MB)`);
        continue;
      }
      wanted.push({ member: e.path, rel: safeRelPath(p) });
    }
    const total = entries.filter((e) => wanted.some((w) => w.member === e.path)).reduce((s, e) => s + e.size, 0);
    if (total > MAX_IMPORT_BYTES) throw new ImportError("The zip unpacks to more than 300 MB.");
    if (!wanted.length) throw new ImportError("The zip holds no files worth importing.");

    const files: IncomingFile[] = [];
    const extract = `
import base64, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = json.loads(sys.stdin.read())
print(json.dumps({n: base64.b64encode(z.read(n)).decode() for n in names}))
`;
    const child = execFile("python3", ["-c", extract, zipPath], { maxBuffer: 1024 * 1024 * 1024 });
    const collected: string[] = [];
    child.stdout?.on("data", (d) => collected.push(String(d)));
    const done = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new ImportError("The zip could not be read."))));
    });
    child.stdin?.end(JSON.stringify(wanted.map((w) => w.member)));
    await done;
    const data = JSON.parse(collected.join("")) as Record<string, string>;
    for (const w of wanted) files.push({ path: w.rel, content: data[w.member] ?? "", encoding: "base64" });

    const res = saveFiles(name, files, opts);
    return { ...res, skipped: [...skipped, ...res.skipped], stripped: strip };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function deleteImportFile(name: string, rel: string): void {
  const file = path.join(importDir(name), safeRelPath(rel));
  if (!fs.existsSync(file)) throw new ImportError(`No file "${rel}".`);
  fs.rmSync(file);
}

export function deleteImport(name: string): void {
  const dir = importDir(name);
  if (!fs.existsSync(dir)) throw new ImportError(`No import called "${name}".`);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function saveNotes(name: string, notes: string): void {
  const dir = importDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, NOTES_FILE), String(notes ?? ""));
}
