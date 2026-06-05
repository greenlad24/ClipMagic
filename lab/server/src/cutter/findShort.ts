/**
 * Narration Cutter — STAGE 4: "Find the short" — auto-detect the coherent short
 * inside a long, messy, multi-take recording.
 *
 * The problem this solves: a raw recording is often ~6 minutes but the intended
 * SHORT is ~30–60s. The 6 minutes contain the SAME script recorded many times
 * (restarts), false starts / flubs, and unrelated chatter ("my tablet died",
 * "all right", "I'm going to…"). The clean short is ONE coherent run-through —
 * commonly near the END. The keep-LAST-per-part dedup (Stage 3, `bestTake.ts`)
 * is not enough on its own: it leaves scattered selections because it groups
 * line-by-line instead of finding the single best COMPLETE run.
 *
 * Approach (researched): the durable pattern for "select / assemble the clean
 * take from a multi-take recording" is to transcribe to word level, then reason
 * over the FULL TIMESTAMPED TRANSCRIPT with an LLM — there is no off-the-shelf
 * "assemble the clean take" model, so we build it on the pieces this project
 * already has. We feed Claude (the same prompt-cached path the AI director uses,
 * via `claudeJSONForPurpose`) the full timestamped list of the detected
 * BIG-CHUNK takes (index, start–end, text) and ask it to return the ORDERED set
 * of take ids that together form the single best coherent short — DISCARDING
 * earlier repeated takes/restarts, incomplete false starts, and off-topic
 * chatter — plus a per-take reason. We prefer the cleanest COMPLETE run (usually
 * the last).
 *
 * The output is shaped as a `TakeDefault[]` disabled-set: every take NOT in the
 * short is disabled with a specific reason ("earlier take — not in the short" /
 * "off-topic chatter" / "false start" / "not part of the short"). That flows
 * through the SAME `applyDefaults` / `computeKeepSegments` path the timeline
 * already uses, so preview ↔ render parity is preserved for free — the short is
 * just a different default enabled-set the user can fine-tune with the existing
 * toggles and sliders.
 *
 * HARD GUARANTEES enforced in CODE, independent of the model (a misbehaving
 * model can break none of them):
 *   - only the dedup CANDIDATES (Stage-1-enabled big blocks) are eligible — the
 *     model can never pull in a faint/short block or invent an id;
 *   - the kept set is ORDERED by source time (the short plays in recording order);
 *   - NO DUPLICATE TEXT in the kept set — if the model keeps two takes whose
 *     normalized text matches, only the LAST is kept (the rest become "earlier
 *     take — not in the short"), so the short never repeats a line;
 *   - the short is NEVER empty — if the model returns nothing usable we fall back
 *     to the deterministic keep-last selection so the timeline still has a result.
 *
 * Graceful: no Anthropic key (or any AI failure) → fall back to the current
 * deterministic keep-last big-chunk selection (`heuristicTakeDefaults`), so the
 * action and the analyze default still work, just without the chatter/false-start
 * discrimination the model adds.
 */
import { claudeJSONForPurpose, anthropicConfigured } from "../ai/claude.js";
import {
  heuristicTakeDefaults,
  SHORT_EARLIER_REASON,
  SHORT_CHATTER_REASON,
  SHORT_FALSE_START_REASON,
  SHORT_EXCLUDED_REASON,
  type Take,
  type TakeDefault,
} from "./segments.js";

/** The Claude pass, injectable so tests can MOCK it instead of calling the API. */
export type ClaudeJSONFn = (opts: {
  tier: "director" | "research" | "fast";
  purpose: "take-detection";
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}) => Promise<string>;

/** One take the model marked as part of the short, with a reason for the rest. */
interface ModelShort {
  /** The ordered take ids that together form the single coherent short. */
  keep: string[];
  /**
   * Optional per-EXCLUDED-take reason classification, so the UI can explain why
   * a take was dropped. Any take not listed gets the generic excluded reason.
   */
  excluded?: { takeId: string; reason: "earlier" | "chatter" | "false-start" | "other" }[];
  /** Optional one-line rationale for the overall selection (logged, not shown). */
  rationale?: string;
}

/** Map the model's coarse reason tag to the shared, user-facing reason string. */
function reasonFor(tag: string | undefined): string {
  switch (tag) {
    case "earlier": return SHORT_EARLIER_REASON;
    case "chatter": return SHORT_CHATTER_REASON;
    case "false-start": return SHORT_FALSE_START_REASON;
    default: return SHORT_EXCLUDED_REASON;
  }
}

function buildSystem(): string {
  return `You are an elite short-form video editor. You are given a RAW, unedited narration recording that has already been split into TAKES — each a BIG contiguous block of speech with a stable id, a start/end time (seconds), and its transcript text. The takes are listed IN RECORDING ORDER.

The raw recording is long and MESSY. It typically contains, in some order:
- the SAME intended script recorded MANY times (the narrator restarts and re-records),
- FALSE STARTS and flubs (incomplete attempts that trail off or get cut short),
- OFF-TOPIC CHATTER unrelated to the script ("my tablet died", "all right", "okay let me try again", "I'm gonna…", throat-clears, asides).

Hidden inside is ONE coherent SHORT: a single clean, COMPLETE run-through of the intended script. Your job is to FIND IT and return the ordered takes that compose it.

Return ONLY JSON of this exact shape:
{"keep":["t620","t804","t910"],"excluded":[{"takeId":"t12","reason":"earlier"},{"takeId":"t77","reason":"chatter"}],"rationale":"one short sentence"}

How to choose the short:
- Identify the intended SCRIPT from the lines that get repeated/attempted across the recording.
- ALWAYS use the LAST COMPLETE run-through — the FINAL time the narrator recorded the whole script start-to-finish. Even if an earlier delivery of a line sounds cleaner, use the FINAL run; NEVER assemble the short from lines taken at different times in the recording.
- "keep" must be ONE CONTIGUOUS BLOCK: the takes of that final run, in recording order. EVERYTHING before the final run (all earlier recordings/attempts of the script) is excluded as "earlier", and any chatter/false-starts AFTER the final run are excluded too. Do NOT include the same line twice.
- EXCLUDE and classify every other take in "excluded":
    - "earlier"     — an earlier/repeated attempt of a line that you kept a later, cleaner version of.
    - "false-start" — an incomplete attempt, flub, or trailing-off fragment.
    - "chatter"     — talk unrelated to the script (asides, "my tablet died", "okay", "all right", "let me try again").
    - "other"       — anything else you are dropping.
- Do NOT pad the short with chatter or half-lines just to make it longer. Keep it as long as the real coherent script is — no more, no less. A short script stays short; a longer one stays longer. Do NOT target a fixed duration.
- Only use take ids that were given to you. Keep at least one take.

Think about the whole recording before deciding, but return ONLY the JSON.`;
}

function buildUser(takes: Take[]): string {
  const total = takes.reduce((sum, t) => sum + (t.end - t.start), 0);
  const lines = takes
    .map(
      (t, i) =>
        `#${i + 1} ${t.id} [${t.start.toFixed(1)}–${t.end.toFixed(1)}s, ${(t.end - t.start).toFixed(1)}s] ${t.text || "(no transcript)"}`,
    )
    .join("\n");
  return `The recording is ${total.toFixed(0)}s long across ${takes.length} takes, in recording order:\n${lines}\n\nReturn the ordered "keep" take ids that form the single coherent short, and classify every excluded take.`;
}

/** Normalize a take's text for duplicate detection (lowercase, strip punctuation). */
function normText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turn the model's coherent-short selection into a DEFAULT disabled-set,
 * ENFORCING the guarantees in CODE regardless of what the model returned:
 *   - candidate-only: ids that aren't real big blocks are ignored;
 *   - ordered: the kept set is sorted by source time;
 *   - no duplicate text: if the model keeps two takes with the same normalized
 *     text, only the LAST survives (earlier ones become "earlier take");
 *   - non-empty: if nothing usable is kept, returns null so the caller falls back.
 * Every CANDIDATE take not in the final kept set is disabled with a reason
 * (the model's classification when present, else the generic excluded reason).
 *
 * `takes` MUST be the dedup CANDIDATES (the Stage-1-enabled big blocks).
 */
export function defaultsFromShort(
  takes: Take[],
  model: ModelShort,
): TakeDefault[] | null {
  const byId = new Map(takes.map((t) => [t.id, t]));

  // 1 ─ The model's keep list, filtered to real candidates, in SOURCE-TIME order.
  const wantedKeep = (Array.isArray(model?.keep) ? model.keep : [])
    .filter((id) => byId.has(id));
  const keepOrdered = [...new Set(wantedKeep)]
    .sort((a, b) => byId.get(a)!.start - byId.get(b)!.start);

  // 2 ─ NO DUPLICATE TEXT: among kept takes with the same normalized text, keep
  //     only the LAST (latest start) — the short never repeats a line. Earlier
  //     duplicates fall out of the kept set and become "earlier take".
  const keptByText = new Map<string, string>(); // normText → winning take id
  const finalKeep = new Set<string>();
  for (const id of keepOrdered) {
    const key = normText(byId.get(id)!.text);
    if (key === "") { finalKeep.add(id); continue; } // untranscribed: can't dedup
    keptByText.set(key, id); // later id overwrites earlier → last wins
  }
  for (const id of keptByText.values()) finalKeep.add(id);

  // 3 ─ Non-empty guarantee: nothing kept → signal fallback.
  if (finalKeep.size === 0) return null;

  // 4 ─ The model's per-take exclusion reasons (only for non-kept candidates).
  const excludedReason = new Map<string, string>();
  for (const e of Array.isArray(model?.excluded) ? model.excluded : []) {
    if (e && byId.has(e.takeId)) excludedReason.set(e.takeId, reasonFor(e.reason));
  }

  // 5 ─ Every CANDIDATE not in the final kept set is disabled with a reason.
  const defaults: TakeDefault[] = [];
  for (const t of takes) {
    if (finalKeep.has(t.id)) continue;
    // A kept-but-deduped duplicate is an "earlier take"; otherwise use the
    // model's classification, falling back to the generic excluded reason.
    const wasDeduped = wantedKeep.includes(t.id);
    const reason = wasDeduped
      ? SHORT_EARLIER_REASON
      : (excludedReason.get(t.id) ?? SHORT_EXCLUDED_REASON);
    defaults.push({ id: t.id, reason });
  }
  return defaults;
}

/**
 * Largest TIME gap (seconds) allowed between two consecutive KEPT takes before we
 * treat them as belonging to DIFFERENT recording passes. Within the final run,
 * kept takes are seconds apart (a cut, a breath, at most a short flub between
 * them). An earlier pass sits much further back in the recording — typically
 * minutes — so the gap to it is huge. 10s comfortably allows within-run flubs/
 * pauses while still cutting off earlier passes.
 */
const FINAL_RUN_MAX_GAP_S = 10;

/**
 * Enforce "ONE contiguous block = the LAST run" in CODE, independent of the model.
 *
 * The user's rule: only the LAST time the script was filmed counts — discard every
 * earlier recording of it. So whatever the model (or heuristic) kept, we keep only
 * the FINAL time-contiguous cluster: walking the kept takes from the end backward,
 * we stop at the first big TIME gap (= the boundary to an earlier pass). Everything
 * before that boundary is re-disabled as an "earlier take".
 *
 * `candidates` MUST be the Stage-1-enabled big blocks, in source-time order.
 */
export function enforceFinalRun(candidates: Take[], defaults: TakeDefault[]): TakeDefault[] {
  const disabled = new Set(defaults.map((d) => d.id));
  const kept = candidates.filter((t) => !disabled.has(t.id)); // time-ordered
  if (kept.length <= 1) return defaults;

  const finalRun = new Set<string>([kept[kept.length - 1].id]);
  for (let i = kept.length - 2; i >= 0; i--) {
    const gap = kept[i + 1].start - kept[i].end; // seconds between consecutive kept takes
    if (gap <= FINAL_RUN_MAX_GAP_S) finalRun.add(kept[i].id);
    else break; // earlier pass — everything from here back is discarded
  }
  if (finalRun.size === kept.length) return defaults; // already a single run

  // Re-disable the earlier-pass kept takes as "earlier take".
  const result = [...defaults];
  for (const t of kept) {
    if (!finalRun.has(t.id)) result.push({ id: t.id, reason: SHORT_EARLIER_REASON });
  }
  return result;
}

/**
 * Find the single coherent short and return the DEFAULT disabled-set (Stage 4).
 * The dedup CANDIDATES are the real big blocks — the Stage-1-ENABLED takes.
 * Uses a focused Claude pass when an Anthropic key is configured; otherwise (or
 * on any failure, or if the model returns nothing usable) falls back to the
 * deterministic keep-last selection (`heuristicTakeDefaults`) so the action
 * always produces a sensible result. The Claude call is injectable (`claudeFn`)
 * so it can be MOCKED in tests without touching the network.
 *
 * GUARANTEES (enforced in code, independent of the model): only candidates are
 * eligible; the kept short is ordered by source time; no duplicate text; never
 * empty. The model only PROPOSES the selection + reasons.
 */
export async function selectCoherentShort(
  takes: Take[],
  opts: { claudeFn?: ClaudeJSONFn; hasKey?: boolean } = {},
): Promise<{ defaults: TakeDefault[]; usedAI: boolean }> {
  const candidates = takes.filter((t) => t.enabled);
  // Fewer than two real takes: nothing to disambiguate — keep what's there.
  if (candidates.length < 2) return { defaults: [], usedAI: false };

  const hasKey = opts.hasKey ?? anthropicConfigured();
  const claudeFn = opts.claudeFn ?? (claudeJSONForPurpose as ClaudeJSONFn);

  // No key → deterministic keep-last, then collapse to the final contiguous run.
  if (!hasKey) {
    return { defaults: enforceFinalRun(candidates, heuristicTakeDefaults(takes)), usedAI: false };
  }

  try {
    const raw = await claudeFn({
      tier: "director",
      purpose: "take-detection",
      system: buildSystem(),
      messages: [{ role: "user", content: buildUser(candidates) }],
    });
    const data = JSON.parse(raw) as ModelShort;
    const defaults = defaultsFromShort(candidates, data);
    // Model returned nothing usable → fall back so the short is never empty.
    if (!defaults) return { defaults: enforceFinalRun(candidates, heuristicTakeDefaults(takes)), usedAI: false };
    // Enforce "last contiguous run only" regardless of how the model selected.
    return { defaults: enforceFinalRun(candidates, defaults), usedAI: true };
  } catch (e) {
    console.warn(
      "[findShort] AI short-selection failed (non-fatal) — using keep-last heuristic:",
      e instanceof Error ? e.message : e,
    );
    return { defaults: enforceFinalRun(candidates, heuristicTakeDefaults(takes)), usedAI: false };
  }
}
