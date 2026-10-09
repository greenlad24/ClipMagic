/**
 * Auto Editor — "Graphics only — editor adds screencasts" (Jake 2026-10-09: "a mode where the AI can creative
 * edit everything but without adding the screencasts - so I can send an editor all of the motion graphic parts
 * and he only does the screencast").
 *
 * A long-form creative job with request.json "handoff": true. The worker (aieditor/handoff.py) plans the edit
 * (one plan call, no browser), renders the overlays and builds a package for a human editor in Premiere Pro or
 * DaVinci Resolve: handoff-NN/ + handoff-NN.zip (Premiere XML, FCPXML, the A-roll, ProRes 4444 graphics, audio
 * stems, the screencast brief) and preview-NN.mp4 with a labelled card in every screencast slot.
 * control.ts calls the three helpers below and nothing else, so the mode stays one small block there.
 */
import fsp from "node:fs/promises";
import path from "node:path";

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
  /** handoff-NN.zip, served by /api/aieditor/files */
  zip: string;
  bytes: number;
  modifiedAt: number;
  slots: { n: number; start_tc: string; end_tc: string; label: string }[];
}

/** getJob: the packages on disk (handoff-NN.zip + the worker's handoff-NN.json summary). */
export async function handoffPackages(dir: string): Promise<HandoffPackage[]> {
  const out: HandoffPackage[] = [];
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    const m = /^handoff-(\d{2})\.zip$/.exec(f);
    if (!m) continue;
    const s = await fsp.stat(path.join(dir, f)).catch(() => null);
    if (!s?.isFile()) continue;
    let slots: HandoffPackage["slots"] = [];
    try {
      const doc = JSON.parse(await fsp.readFile(path.join(dir, `handoff-${m[1]}.json`), "utf8"));
      slots = Array.isArray(doc?.slots) ? doc.slots : [];
    } catch {
      slots = [];
    }
    out.push({ zip: f, bytes: s.size, modifiedAt: s.mtimeMs / 1000, slots });
  }
  return out;
}
