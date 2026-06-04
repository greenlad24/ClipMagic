/**
 * Narration Cutter — STAGE 3: full-transcript keep-LAST dedup of the big blocks.
 *
 * This is the server-side DEFAULT for which takes start enabled in the timeline
 * editor. It runs once during the analyze job (the AI-assisted grouping can't
 * live in the deterministic client core), and its output — a `TakeDefault[]`
 * disabled-set — is returned to the client, which then recomputes live and lets
 * the user override any of it. The render uses the explicit enabled keep-segments
 * the client sends, so parity is preserved.
 *
 * The problem this fixes: the narrator re-records lines, so the big-block list
 * has the SAME script part covered by several blocks. The old behaviour both
 * DROPPED some parts and KEPT THE WRONG repeat. Here we:
 *   1. order the big blocks by time and group the ones that are re-takes of the
 *      same line (tolerant of minor wording, but CONSERVATIVE so distinct lines
 *      are never merged);
 *   2. KEEP THE LAST occurrence of each group (the narrator's final delivery) and
 *      disable the EARLIER ones with the reason "earlier take — final kept";
 *   3. a block said ONCE is ALWAYS kept (never grouped, never dropped).
 *
 * The AI (Claude) only ASSISTS the fuzzy grouping when a key is present. The hard
 * GUARANTEES are enforced in CODE afterward (`defaultsFromParts`), independent of
 * the model: no unique part is ever dropped, every group keeps exactly its LAST
 * member, and order is preserved — a misbehaving model cannot break any of these.
 * With no key (or on any AI failure) we fall back to the deterministic
 * `heuristicTakeDefaults` text grouping, so the timeline still works fully.
 */
import { claudeJSONForPurpose, anthropicConfigured } from "../ai/claude.js";
import { heuristicTakeDefaults, EARLIER_TAKE_REASON, type Take, type TakeDefault } from "./segments.js";

/** The Claude pass, injectable so tests can MOCK it instead of calling the API. */
export type ClaudeJSONFn = (opts: {
  tier: "director" | "research" | "fast";
  purpose: "take-detection";
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}) => Promise<string>;

/** One script part the model identified, with the take ids that cover it. */
interface ModelPart {
  /** A short label/snippet for the part (shown in the UI as the group). */
  part: string;
  /** All take ids that are re-takes of this same part (in any order). */
  takeIds: string[];
}

function buildSystem(): string {
  return `You are a meticulous video editor reviewing a RAW, unedited narration recording that was already split into TAKES — each a BIG contiguous block of speech, with a stable id, a start/end time, and its transcript text.

The narrator frequently RE-RECORDS lines: they flub a line, stop, and say essentially the SAME line again, sometimes several times. Your ONLY job is to GROUP the takes that are re-records of the SAME line. You do NOT choose which take to keep — the system always keeps the LAST take of each group automatically.

Return ONLY JSON of this exact shape:
{"parts":[{"part":"a short label for this script line","takeIds":["t45","t123"]}]}

Strict rules:
- Each "part" is one distinct line of the intended final script. "takeIds" lists EVERY take that is an attempt at that SAME line (re-takes), tolerant of minor wording differences.
- A line said only ONCE is its own part with a single take id — that is correct and expected. Most parts may have a single take.
- BE CONSERVATIVE: only group takes whose text GENUINELY matches the same line. If you are unsure, keep them as SEPARATE single-take parts. Never merge two genuinely different lines just because they share a few words — merging distinct lines would wrongly delete content.
- EVERY take id you were given must appear in exactly ONE part's takeIds (no take left out, no take in two parts).
Return {"parts":[]} only if there are truly no takes.`;
}

function buildUser(takes: Take[]): string {
  const lines = takes
    .map((t) => `${t.id} [${t.start.toFixed(2)}–${t.end.toFixed(2)}, ${(t.end - t.start).toFixed(1)}s] ${t.text || "(no transcript)"}`)
    .join("\n");
  return `Here are the ${takes.length} detected takes, in order:\n${lines}`;
}

/**
 * Turn the model's per-part GROUPING into a DEFAULT disabled-set, ENFORCING the
 * keep-LAST + full-coverage + order guarantees in CODE regardless of what the
 * model returned:
 *   - every CANDIDATE take (the real big blocks passed in) belongs to exactly one
 *     part; a take the model forgot becomes its OWN single-take part, so no unique
 *     part is ever dropped;
 *   - within each part the KEEPER is the LAST take by start time — the model has
 *     no say in which take is kept, so it can never override keep-last;
 *   - a part with a single take disables nothing (a line said once is always
 *     kept);
 *   - order is preserved (groups built in take order; keeper = latest start).
 * Returns the takes to DISABLE (the earlier re-takes), each with the keeper's
 * snippet as the scriptPart and the "earlier take — final kept" reason.
 *
 * `takes` MUST be the dedup CANDIDATES (the Stage-1-enabled big blocks). Any take
 * id the model references that isn't a candidate is ignored, so the model cannot
 * pull a faint/short block into a group or drop a real one.
 */
export function defaultsFromParts(
  takes: Take[],
  modelParts: ModelPart[],
): TakeDefault[] {
  const byId = new Map(takes.map((t) => [t.id, t]));

  // Assign each candidate take to a part; collect the validated groups.
  const assigned = new Set<string>();
  const groups: { ids: string[]; label: string }[] = [];
  for (const p of modelParts) {
    const ids = (Array.isArray(p?.takeIds) ? p.takeIds : []).filter((id) => byId.has(id) && !assigned.has(id));
    if (ids.length === 0) continue;
    ids.forEach((id) => assigned.add(id));
    groups.push({ ids, label: String(p?.part ?? "").trim() });
  }
  // Any candidate the model failed to assign becomes its own single-take part —
  // a distinct part we must NOT drop. (Guarantee: no unique part dropped.)
  for (const t of takes) {
    if (!assigned.has(t.id)) {
      assigned.add(t.id);
      groups.push({ ids: [t.id], label: t.text });
    }
  }

  const defaults: TakeDefault[] = [];
  for (const g of groups) {
    if (g.ids.length <= 1) continue; // single attempt → nothing to disable
    // KEEP THE LAST occurrence in time — independent of the model. (Guarantee:
    // exactly one keeper per group = the LAST; order preserved.)
    const ordered = [...g.ids].sort((a, b) => (byId.get(a)!.start - byId.get(b)!.start));
    const keeper = ordered[ordered.length - 1];
    const keeperTake = byId.get(keeper)!;
    const snippet = keeperTake.text.length > 48
      ? keeperTake.text.slice(0, 47).trimEnd() + "…"
      : (keeperTake.text || g.label || "final take");
    const part = g.label || snippet;
    for (const id of ordered) {
      if (id === keeper) continue;
      defaults.push({ id, reason: EARLIER_TAKE_REASON, scriptPart: part });
    }
  }
  return defaults;
}

/**
 * Compute the DEFAULT disabled-set (STAGE 3 keep-LAST dedup) for the timeline
 * editor. The dedup CANDIDATES are the real big blocks — the Stage-1-ENABLED
 * takes; short/low-scattered blocks keep their Stage-1 reason and are never
 * grouped. Uses a focused Claude pass to GROUP re-takes when an Anthropic key is
 * configured; otherwise (or on any failure) falls back to the deterministic
 * `heuristicTakeDefaults`. The Claude call is injectable (`claudeFn`) so it can
 * be mocked in tests without touching the network.
 *
 * GUARANTEES (enforced in code, independent of the model): no unique part is ever
 * dropped; exactly one keeper per re-take group = the LAST occurrence; order is
 * preserved. The model only ASSISTS the fuzzy grouping.
 */
export async function selectBestTakeDefaults(
  takes: Take[],
  opts: { claudeFn?: ClaudeJSONFn; hasKey?: boolean } = {},
): Promise<{ defaults: TakeDefault[]; usedAI: boolean }> {
  // Only the real big blocks (Stage-1-enabled) are dedup candidates — re-takes
  // are big blocks; faint/short blocks aren't keepers and aren't grouped.
  const candidates = takes.filter((t) => t.enabled);
  if (candidates.length < 2) return { defaults: [], usedAI: false };

  const hasKey = opts.hasKey ?? anthropicConfigured();
  const claudeFn = opts.claudeFn ?? (claudeJSONForPurpose as ClaudeJSONFn);
  // The heuristic reads `enabled` itself, so it gets the FULL list; the AI path
  // is fed only the candidates (so the model can't reference a non-candidate).
  if (!hasKey) {
    return { defaults: heuristicTakeDefaults(takes), usedAI: false };
  }

  try {
    const raw = await claudeFn({
      tier: "fast",
      purpose: "take-detection",
      system: buildSystem(),
      messages: [{ role: "user", content: buildUser(candidates) }],
    });
    const data = JSON.parse(raw);
    const parts: ModelPart[] = Array.isArray(data?.parts) ? data.parts : [];
    return { defaults: defaultsFromParts(candidates, parts), usedAI: true };
  } catch (e) {
    console.warn("[bestTake] AI grouping failed (non-fatal) — using heuristic:", e instanceof Error ? e.message : e);
    return { defaults: heuristicTakeDefaults(takes), usedAI: false };
  }
}
