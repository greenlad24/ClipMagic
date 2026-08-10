/**
 * One-off repair: absolutise relative media urls on existing projects.
 *
 * Projects built with "choose from storage" stored the picker's url verbatim,
 * and listStorage hands out browser-relative ones ("/api/uploads/<id>"). The
 * pipeline fetches that url SERVER-side, where Node rejects a relative URL
 * before a byte moves — so those runs died at transcription with
 * "Failed to parse URL from /api/uploads/…" while runs built from fresh
 * uploads (absolute url via publicUrlFor) worked.
 *
 * StoragePickerDialog now absolutises at the source, so NEW projects are fine.
 * This fixes the ones already in the database, which would otherwise keep
 * failing every retry.
 *
 * Dry-run by default — prints what it would change and touches nothing:
 *   node dist/scripts/fix-relative-project-urls.js
 *   node dist/scripts/fix-relative-project-urls.js --apply
 */
import { config } from "../config.js";
import { db } from "../db/index.js";

/** Fields that hold a media url the server later fetches. */
const URL_FIELDS = ["audioUrl", "narrationUrl"] as const;

/** Relative app url? (absolute http(s), data: and blob: are left alone) */
function isRelativeAppUrl(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("/") && !v.startsWith("//");
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const base = (config.publicBaseUrl || "").replace(/\/+$/, "");
  if (!base) {
    console.error(
      "PUBLIC_BASE_URL is not set — there is no origin to resolve against. " +
        "Set it (it's what publicUrlFor already uses for fresh uploads) and re-run.",
    );
    process.exitCode = 1;
    return;
  }

  const rows = db.prepare("SELECT id, doc FROM z_projects").all() as Array<{ id: string; doc: string }>;
  const update = db.prepare("UPDATE z_projects SET doc = ? WHERE id = ?");

  let scanned = 0;
  let changed = 0;
  const edits: string[] = [];

  for (const row of rows) {
    scanned++;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(row.doc);
    } catch {
      console.warn(`  skip ${row.id} — unreadable doc`);
      continue;
    }
    let touched = false;
    for (const field of URL_FIELDS) {
      const v = doc[field];
      if (!isRelativeAppUrl(v)) continue;
      doc[field] = `${base}${v}`;
      edits.push(`  ${row.id} ${field}: ${v} -> ${doc[field]}`);
      touched = true;
    }
    if (!touched) continue;
    changed++;
    if (apply) update.run(JSON.stringify(doc), row.id);
  }

  for (const line of edits) console.log(line);
  console.log(
    `\n${scanned} projects scanned · ${changed} with relative urls · ` +
      (apply ? `${changed} UPDATED` : "dry run, nothing written (pass --apply)"),
  );
}

main();
