/**
 * The DB half of render positions — kept out of renderPosition.ts so the parser
 * stays importable (and unit-testable) without opening the database.
 *
 * See renderPosition.ts for why a render's shooting position has to be recovered
 * through its project rather than read off its filename.
 */
import { db } from "../db/index.js";
import { positionKeyFromOriginal } from "./renderPosition.js";

/**
 * Positions for every render we can resolve, keyed by output filename
 * (`<nanoid>.mp4` → `"t7"`). Renders with no recoverable position are simply
 * absent — callers decide what to do with them (the scheduler lumps them into
 * one POSITION_UNKNOWN group so a run of them can't post back-to-back either).
 *
 * Never throws: a schema change or a missing table degrades to "no positions
 * known", which restores exactly the old filename-derived behavior.
 */
export function loadRenderPositions(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = db
      .prepare(
        `SELECT json_extract(doc,'$.outputUrl')       AS outputUrl,
                json_extract(doc,'$.narrationUrl')    AS narrationUrl,
                json_extract(doc,'$.videoChunksJson') AS chunks
           FROM z_projects
          WHERE json_extract(doc,'$.outputUrl') IS NOT NULL`,
      )
      .all() as Array<{ outputUrl: string | null; narrationUrl: string | null; chunks: string | null }>;
    if (rows.length === 0) return out;

    const originalById = new Map(
      (db.prepare("SELECT id, original FROM files").all() as Array<{ id: string; original: string }>).map(
        (r) => [r.id, r.original],
      ),
    );

    for (const row of rows) {
      const render = basename(row.outputUrl);
      if (!render) continue;
      // A project points at its source through narrationUrl and/or the video
      // chunk list; the first one that resolves to a known upload wins.
      let sources: string[] = [];
      try {
        sources = [row.narrationUrl, ...(JSON.parse(row.chunks || "[]") as string[])].filter(
          (u): u is string => typeof u === "string" && u.length > 0,
        );
      } catch {
        sources = row.narrationUrl ? [row.narrationUrl] : [];
      }
      for (const url of sources) {
        const original = originalById.get(basename(url));
        const key = positionKeyFromOriginal(original);
        if (key) {
          out.set(render, key);
          break;
        }
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** Last path segment of a URL-ish string ("" when there isn't one). */
function basename(url: string | null | undefined): string {
  const s = String(url ?? "").trim();
  if (!s) return "";
  const last = s.split("?")[0].split("/").pop();
  return last ?? "";
}
