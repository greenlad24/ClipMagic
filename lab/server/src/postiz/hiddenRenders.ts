/**
 * Persistent HIDDEN-RENDERS list for the Bulk Scheduler's picker.
 *
 * Rendered Shorts accumulate in the outputs dir forever, and plenty of them are
 * never going to be posted (test renders, rejected looks, one-offs). Hiding one
 * takes it out of the picker grid so it stops competing for attention, without
 * deleting the file — it moves to a collapsed "Hidden" list the user can reopen
 * and restore from at any time.
 *
 * This is DISPLAY state, not a posting gate: nothing here refuses to schedule a
 * clip. The picker simply doesn't offer hidden renders, and deselects one the
 * moment it's hidden, so a hidden clip can't reach a plan by accident.
 *
 * Persistence mirrors scheduleLedger.ts exactly: a plain JSON file in the lab's
 * (git-ignored) data dir, with reads/writes that NEVER throw — a missing or
 * corrupt file degrades to "nothing hidden", and a read-only data dir loses the
 * write rather than crashing the picker. Renders are keyed by FILENAME, which is
 * what `listStorage` returns and what a `render:` file source refs.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** The on-disk shape: just the set of hidden render filenames. */
interface HiddenFile {
  names: string[];
}

/**
 * Resolve the path lazily so a test can point it at a throwaway file via
 * BULK_HIDDEN_RENDERS_PATH without re-importing config.
 */
function hiddenPath(): string {
  return (
    process.env.BULK_HIDDEN_RENDERS_PATH ||
    path.join(config.dataDir, "bulk-hidden-renders.json")
  );
}

// ── Persistence (resilient: never throws on read; best-effort on write) ───────
function readHidden(): string[] {
  try {
    const raw = fs.readFileSync(hiddenPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<HiddenFile> | null;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.names)) return [];
    // De-dupe defensively: a hand-edited file must not produce repeats.
    const seen = new Set<string>();
    for (const n of parsed.names) {
      if (typeof n === "string" && n.length > 0) seen.add(n);
    }
    return [...seen].sort();
  } catch {
    /* missing or corrupt → nothing hidden */
    return [];
  }
}

function writeHidden(names: string[]): void {
  try {
    const p = hiddenPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ names } satisfies HiddenFile, null, 2));
  } catch {
    /* best-effort: a read-only data dir must never crash the picker */
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
/** Every hidden render filename, sorted. Empty when nothing is hidden. */
export function listHiddenRenders(): string[] {
  return readHidden();
}

/**
 * Hide or restore renders by filename, and return the resulting full list so a
 * caller can replace its state without a second round-trip. Idempotent in both
 * directions: hiding an already-hidden name (or restoring a visible one) is a
 * no-op, so a double-click or a retry can't corrupt the list.
 */
export function setRendersHidden(names: string[], hidden: boolean): string[] {
  const clean = names.filter((n): n is string => typeof n === "string" && n.length > 0);
  if (clean.length === 0) return readHidden();
  const set = new Set(readHidden());
  for (const n of clean) {
    if (hidden) set.add(n);
    else set.delete(n);
  }
  const next = [...set].sort();
  writeHidden(next);
  return next;
}

/**
 * Which render filenames a finished schedule run should park automatically.
 *
 * Once a clip has actually gone out, re-offering it in the picker is just an
 * invitation to post it twice, so a fully-scheduled render moves itself into the
 * Hidden list. A file is parked only when EVERY post attempted for it in this
 * run succeeded — a partial failure leaves the clip in the grid, which is
 * exactly the case where the user still needs to select it. Only `render`
 * sources have a picker tile at all; uploads and cloud clips have nothing to
 * hide. Still display-only and still restorable: the ledger, not this list, is
 * what actually de-dupes a re-run.
 */
export function rendersToAutoHide(
  posts: Array<{ fileId: string; source?: { kind?: string; ref?: string } }>,
  results: Array<{ fileId: string; ok: boolean }>,
): string[] {
  const refByFile = new Map<string, string>();
  for (const p of posts) {
    const ref = p?.source?.ref;
    if (p?.source?.kind === "render" && typeof ref === "string" && ref.length > 0) {
      refByFile.set(p.fileId, ref);
    }
  }
  if (refByFile.size === 0) return [];
  // A file is "clean" only if it has at least one result and none of them failed.
  const cleanByFile = new Map<string, boolean>();
  for (const r of results) {
    cleanByFile.set(r.fileId, (cleanByFile.get(r.fileId) ?? true) && r.ok);
  }
  const names = new Set<string>();
  for (const [fileId, ref] of refByFile) {
    if (cleanByFile.get(fileId) === true) names.add(ref);
  }
  return [...names].sort();
}
