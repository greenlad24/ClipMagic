/**
 * Auto Editor — "Graphics only — editor adds screencasts" (Jake 2026-10-09: "a mode where the AI can creative
 * edit everything but without adding the screencasts - so I can send an editor all of the motion graphic parts
 * and he only does the screencast").
 *
 * A long-form creative job with request.json "handoff": true. The worker (aieditor/handoff.py) plans the edit
 * (one plan call, no browser), renders the overlays and builds a package for a human editor in Premiere Pro or
 * DaVinci Resolve: handoff-NN/ (+ handoff-NN.zip streamed by handoffZip.ts) (Premiere XML, FCPXML, the A-roll, ProRes 4444 graphics, audio
 * stems, the screencast brief) and preview-NN.mp4 with a labelled card in every screencast slot.
 * control.ts calls the three helpers below and nothing else, so the mode stays one small block there.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { packageZipSize } from "./handoffZip.js";
import { listShares, type ShareView } from "./share.js";

export const HANDOFF_TITLE = "Graphics only — editor adds screencasts";

/** createJob: request.json "handoff" — only on a long-form creative edit. */
export function parseHandoff(input: { handoff?: unknown; workflow?: unknown; format?: unknown }): boolean {
  if (input.handoff === undefined || input.handoff === null || input.handoff === false) return false;
  if (input.handoff !== true) throw new Error("handoff must be true or false.");
  if (input.workflow !== "creative" || input.format !== "long") {
    throw new Error("The editor hand-off is a long-form creative edit.");
  }
  return true;
}

/** The worker's stages for a hand-off job (aieditor/handoff.py STAGES), with the Lab's titles. */
export function handoffStages(head: { id: string; title: string }[]): { id: string; title: string }[] {
  return [
    ...head,
    { id: "timeline", title: "Keep the edited timeline (no cuts)" },
    { id: "preprod", title: "Plan the edit (screencast slots + overlays, no browser)" },
    { id: "graphics", title: "Render the overlays" },
    { id: "handoff", title: "Build the hand-off package (timelines, graphics, stems, brief, preview)" },
  ];
}

/** stagesFor()'s list, or the hand-off stages when the job is a hand-off. */
export function withHandoff(list: { id: string; title: string }[], handoff: boolean): { id: string; title: string }[] {
  return handoff ? handoffStages(list.slice(0, 4)) : list;
}

export interface HandoffPackage {
  /** handoff-NN */
  pkg: string;
  /** handoff-NN.zip — served by /api/aieditor/files (streamed from the folder, or a zip an older build wrote) */
  zip: string;
  bytes: number;
  modifiedAt: number;
  slots: { n: number; start_tc: string; end_tc: string; label: string; steps?: number }[];
  /** the worker's slot count: plan segments + screen references added → slots after merging */
  slotCount?: { planned: number; screen_ref_added: number; final: number } | null;
  /** public share links of this package (share.ts) */
  shares: ShareView[];
}

/**
 * getJob: the packages on disk. A package is the worker's handoff-NN.json + the handoff-NN/ folder whose every
 * file has the size the worker recorded (a package still being copied back from a factory server is not listed
 * yet), or a handoff-NN.zip an older build wrote.
 */
export async function handoffPackages(dir: string): Promise<HandoffPackage[]> {
  const out: HandoffPackage[] = [];
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).sort();
  } catch {
    return out;
  }
  const job = path.basename(dir);
  const pkgs = new Set<string>();
  for (const f of files) {
    const m = /^(handoff-\d{2})(?:\.zip|\.json)$/.exec(f);
    if (m) pkgs.add(m[1]);
  }
  for (const pkg of [...pkgs].sort()) {
    let doc: any = null;
    try {
      doc = JSON.parse(await fsp.readFile(path.join(dir, `${pkg}.json`), "utf8"));
    } catch {
      doc = null;
    }
    const legacy = await fsp.stat(path.join(dir, `${pkg}.zip`)).catch(() => null);
    let bytes: number | null = legacy?.isFile() ? legacy.size : null;
    let modifiedAt = legacy?.isFile() ? legacy.mtimeMs / 1000 : 0;
    if (bytes === null) {
      bytes = await packageZipSize(dir, pkg);
      if (bytes === null) continue; // not complete yet
      modifiedAt = Number(doc?.built_at) || 0;
    }
    out.push({
      pkg,
      zip: `${pkg}.zip`,
      bytes,
      modifiedAt,
      slots: Array.isArray(doc?.slots) ? doc.slots : [],
      slotCount: doc?.slot_count ?? null,
      shares: await listShares(job, pkg),
    });
  }
  return out;
}
