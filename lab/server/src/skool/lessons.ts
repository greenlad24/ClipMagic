/**
 * Writing every page in the classroom to one standard.
 *
 * The spine decides WHAT goes where. This decides what a member actually reads
 * when they open it, and it applies the same bar to all 136 pages so the
 * classroom does not read in two voices.
 *
 * THREE KINDS OF PAGE, THREE KINDS OF SOURCE MATERIAL:
 *   - an existing lesson: has a video AND Jake's own write-up. The write-up is
 *     the strongest signal there is and is given to the model as the substance
 *     to rework, not as something to replace.
 *   - a new video: has a video and NOTHING written. Its transcript is fetched,
 *     because writing a "complete" lesson about a video nobody has watched is
 *     how a classroom fills up with confident, wrong instructions.
 *   - an authored chapter: has neither. Written from the model's own knowledge,
 *     which is exactly why the standard forbids inventing prices and menus.
 *
 * ⚠️ A PAGE WHOSE SOURCE COULD NOT BE READ KEEPS ITS ORIGINAL BODY. A video
 * whose transcript fails is not rewritten from its title alone — that produces
 * plausible prose about a tutorial the model has not seen, which is worse than
 * the write-up that was already there.
 */
import { fetchTranscript } from "../audit/content.js";
import { getApifyToken } from "../settings/postizSecrets.js";
import { claudeJSONForPurpose } from "../ai/claude.js";

/** How many pages are written at once. Network-bound, so some concurrency pays. */
const CONCURRENCY = 3;

/** Below this, a transcript is a caption fragment rather than a tutorial. */
const MIN_TRANSCRIPT = 400;

export interface LessonSource {
  pageTitle: string;
  courseTitle: string;
  coursePromise: string;
  videoId: string | null;
  /** Jake's existing write-up, when the page already had one. */
  existingBody: string;
  /** The video's transcript, when one could be fetched. */
  transcript: string;
}

export interface LessonWriteStats {
  written: number;
  /** Pages a previous run had already written and this one left alone. */
  reused: number;
  /** Pages neither written nor reused — a run that ended early says so. */
  pending: number;
  skipped: { title: string; why: string }[];
  grounding: Record<string, number>;
}

export interface LessonResult {
  body: string;
  /** What the writing was actually grounded in — surfaced, not assumed. */
  grounding: "write-up + transcript" | "write-up" | "transcript" | "none";
  /** Set when the page was deliberately left alone. */
  skipped: string | null;
}

const LESSON_SYSTEM = `You write one page of a paid community's classroom, in the creator's voice.

WHO IS READING. Salespeople and small business owners with no technical
background. They bought outcomes — templates, prompts, automations that work —
not an education in AI. Assume zero prior knowledge every time: no jargon that
has not been explained on this same page, no "simply just", no step that
quietly assumes an account, a paid plan, or a concept they have not met. Most
of them never get past the first level of this community. That is the problem
this page exists to fix.

⚠️ TLDR FIRST, THEN THE JOURNEY. The page opens with the short version: the
outcome in a line or two, and THE ASSET — the prompt, the template, the
formula, the blueprint, the configuration — complete and copy-paste ready,
placeholders in [brackets], one line on what to swap. A PROMPT IS AN ASSET;
treat it as the deliverable it is, not as an illustration inside a tutorial.
A member who reads only the TLDR must be able to go and do the thing.

Then the journey: how to get there from zero, for the member who needs it.
They pay monthly FOR the assets. Making them scroll through a tutorial to
reach the thing they came for is backwards.

THE JOURNEY GOES ZERO TO ADVANCED, on this one page:
  1. What this does and why it is worth their time, in outcomes not features.
  2. What they need first: accounts, costs, free-tier limits. Real prices.
  3. The steps, exactly — real menu names, real values, real numbers. Someone
     following without understanding yet must still succeed.
  4. What goes wrong and what to do about it.
  5. Advanced: how to push it further once it works, and when not to.

SOURCES. You may be given the creator's existing write-up and/or the
transcript of the video this page accompanies. Both are the substance — use
their specifics, their tool names, their actual numbers. You are raising the
page to the standard above, not replacing what it teaches with something else.

- Match the reference writing's voice and formatting habits.
- Never invent a price, a limit, a menu or a step you were not given. Tell the
  member what to check instead — a confident wrong number costs them money.
- No preamble about what you are about to cover. No "in conclusion".

Return JSON only: {"body":"the page, as plain text with line breaks"}`;

/** Write one page. */
export async function writeLesson(source: LessonSource): Promise<LessonResult> {
  const hasBody = source.existingBody.trim().length > 200;
  const hasTranscript = source.transcript.trim().length > MIN_TRANSCRIPT;

  // A page with a video but no readable source is left exactly as it was.
  // Writing it from the title alone produces confident instructions for a
  // tutorial nobody has watched.
  if (source.videoId && !hasBody && !hasTranscript) {
    return {
      body: source.existingBody,
      grounding: "none",
      skipped: "Its video had no transcript and it had no write-up, so there was nothing to write from.",
    };
  }

  const grounding: LessonResult["grounding"] =
    hasBody && hasTranscript ? "write-up + transcript" : hasBody ? "write-up" : hasTranscript ? "transcript" : "none";

  const parts = [
    `Course: ${source.courseTitle}`,
    `What the course delivers: ${source.coursePromise}`,
    `\nWrite this page: ${source.pageTitle}`,
  ];
  if (hasBody) parts.push(`\n--- the creator's existing write-up for this page ---\n${source.existingBody.slice(0, 14_000)}`);
  if (hasTranscript) parts.push(`\n--- transcript of the video this page accompanies ---\n${source.transcript.slice(0, 24_000)}`);
  if (!hasBody && !hasTranscript) {
    parts.push("\nThere is no video and no existing write-up. Write it from what you know, and follow the rule about not inventing specifics.");
  }

  try {
    const raw = await claudeJSONForPurpose({
      tier: "director",
      // Bills Jake's Max subscription, never API credits. See AuthMode in ai/claude.ts.
      auth: "subscription",
      purpose: "skool-lesson",
      system: LESSON_SYSTEM,
      messages: [{ role: "user", content: parts.join("\n") }],
    });
    const body = String(JSON.parse(raw)?.body ?? "").trim();
    if (body.length < 300) {
      return { body: source.existingBody, grounding, skipped: "The writer returned too little to use." };
    }
    return { body, grounding, skipped: null };
  } catch (err) {
    return { body: source.existingBody, grounding, skipped: `The writer failed: ${String(err)}` };
  }
}

/** Fetch a transcript, tolerating absence — plenty of videos have captions off. */
export async function transcriptFor(videoId: string | null): Promise<string> {
  if (!videoId) return "";
  const token = getApifyToken();
  if (!token) return "";
  return (await fetchTranscript(videoId, token)) ?? "";
}

/**
 * Write a whole set of pages, a few at a time.
 *
 * Order is preserved in the output regardless of which finish first — the
 * classroom's sequence is the one thing a member sees, and shuffling it to
 * match completion order would quietly undo the spine.
 */
export async function writeLessons(
  sources: LessonSource[],
  onProgress?: (done: number, total: number, title: string) => void,
  /**
   * Called as each page lands, before the run finishes.
   *
   * ⚠️ THIS IS WHAT MAKES A RUN SURVIVABLE. The first real run of this died at
   * page 35 of 136 when the container restarted, and every one of those 35
   * director-tier calls was lost — because results were only returned at the
   * end. A page that has been written is worth keeping the moment it exists.
   */
  onDone?: (index: number, result: LessonResult) => void,
): Promise<LessonResult[]> {
  const results = new Array<LessonResult>(sources.length);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= sources.length) return;
      const source = sources[i];
      const transcript = source.transcript || (await transcriptFor(source.videoId));
      results[i] = await writeLesson({ ...source, transcript });
      done++;
      onDone?.(i, results[i]);
      onProgress?.(done, sources.length, source.pageTitle);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker));
  return results;
}

/**
 * Write every page of a plan, in place.
 *
 * The plan's items carry only a 220-character excerpt, so the full existing
 * write-up is joined back from the INVENTORY by unit id. Working from the
 * excerpt would mean rewriting a 32,000-character lesson from its first
 * sentence, which is indistinguishable from throwing it away.
 */
export async function writePlanLessons(
  plan: { tracks: { title: string; promise: string; modules: any[] }[] },
  inventory: { courses: { units: { id: string; content: string }[] }[] },
  opts: {
    onProgress?: (done: number, total: number, title: string) => void;
    /** Persist the plan mid-run. Called after each page is written home. */
    onCheckpoint?: () => void;
    /** Write pages that already have one. Off by default — a rerun resumes. */
    force?: boolean;
  } = {},
): Promise<LessonWriteStats> {
  const bodyByUnitId = new Map<string, string>();
  for (const course of inventory.courses ?? []) {
    for (const unit of course.units ?? []) {
      if (unit.id) bodyByUnitId.set(unit.id, unit.content ?? "");
    }
  }

  // Flattened with a back-reference, so results can be written home without
  // depending on completion order.
  const flat: { module: any; source: LessonSource }[] = [];
  let reused = 0;
  for (const track of plan.tracks ?? []) {
    for (const module of track.modules ?? []) {
      const item = module.item ?? {};
      // ALREADY WRITTEN — leave it. `module.lesson` is the marker rather than
      // `item.body`, because an authored chapter arrives from the planner with
      // a body already on it and would otherwise look like a finished page.
      if (module.lesson?.body && !opts.force) {
        reused++;
        continue;
      }
      flat.push({
        module,
        source: {
          pageTitle: module.title || item.title || "",
          courseTitle: track.title,
          coursePromise: track.promise,
          videoId: item.videoId ?? null,
          existingBody: (item.unitId ? bodyByUnitId.get(item.unitId) : "") || item.body || "",
          transcript: "",
        },
      });
    }
  }

  const skipped: { title: string; why: string }[] = [];
  const grounding: Record<string, number> = {};
  let written = 0;
  let landed = 0;

  await writeLessons(
    flat.map((f) => f.source),
    (done, _total, title) => opts.onProgress?.(reused + done, reused + flat.length, title),
    (i, result) => {
      const { module, source } = flat[i];
      grounding[result.grounding] = (grounding[result.grounding] ?? 0) + 1;
      if (result.skipped) skipped.push({ title: source.pageTitle, why: result.skipped });
      else written++;
      // Written home the moment it exists, not after all 136 have finished.
      // The original body is kept when the writer refused, so the page is
      // still writable — it just is not improved.
      module.lesson = { body: result.body, grounding: result.grounding, skipped: result.skipped };
      module.item = { ...module.item, body: result.body };
      landed++;
      opts.onCheckpoint?.();
    },
  );

  return { written, reused, pending: flat.length - landed, skipped, grounding };
}
