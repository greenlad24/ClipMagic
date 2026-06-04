/**
 * Narration Cutter — full-script verification + BEST-TAKE-PER-PART selection.
 *
 * This is the server-side DEFAULT for which takes start enabled in the timeline
 * editor. It runs once during the analyze job (it can't live in the deterministic
 * client core because it's AI-assisted), and its output — a `TakeDefault[]`
 * disabled-set — is returned to the client, which then recomputes live and lets
 * the user override any of it. The render uses the explicit enabled keep-segments
 * the client sends, so parity is preserved.
 *
 * The problem this fixes: the speaker re-records lines, so the raw take list has
 * the SAME script part covered by several takes. The old behaviour both DROPPED
 * some parts and DUPLICATED others. Here we:
 *   1. determine the intended FULL SCRIPT — the distinct parts, in order;
 *   2. group the takes that cover the same part (tolerant of minor wording);
 *   3. choose the BEST take per part (prefer a clean, complete, LATER take),
 *      considering only takes longer than `minTakeForBest` (default 3s);
 *   4. GUARANTEE every distinct part is covered by exactly ONE enabled take (no
 *      part dropped) and no part is enabled twice (no duplicate).
 *
 * With no Anthropic key (or on any AI failure) we fall back to the deterministic
 * `heuristicTakeDefaults` text grouping, so the timeline still works fully.
 */
import { claudeJSONForPurpose, anthropicConfigured } from "../ai/claude.js";
import { heuristicTakeDefaults, type Take, type TakeDefault } from "./segments.js";

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
  /** The take id the model chose as best (must be one of `takeIds`). */
  best: string;
  /** All take ids that cover this part (re-takes), including `best`. */
  takeIds: string[];
}

function buildSystem(): string {
  return `You are a meticulous video editor reviewing a RAW, unedited narration recording that was already split into TAKES (one whole sentence each, with a stable id, a start/end time, and its transcript text).

The speaker frequently RE-RECORDS lines: they flub a sentence, stop, and say essentially the SAME sentence again. Your job is to reconstruct the intended FULL SCRIPT and, for each distinct part of the script, choose the single BEST take to keep.

Return ONLY JSON of this exact shape:
{"parts":[{"part":"a short label for this script line","best":"t123","takeIds":["t45","t123"]}]}

Strict rules:
- Reconstruct the script IN ORDER. Each "part" is one distinct line/sentence of the intended final script.
- "takeIds" lists EVERY take that is an attempt at that same part (re-takes), tolerant of minor wording differences. A part with a single take is fine (one attempt).
- "best" MUST be one of that part's takeIds. Prefer a CLEAN, COMPLETE, and LATER attempt. Strongly prefer takes longer than 3 seconds — a very short take is usually a false start, not the real line.
- EVERY take id you were given must appear in exactly ONE part's takeIds (no take left out, no take in two parts).
- Do NOT merge genuinely different script lines into one part just because they share a few words.
Return {"parts":[]} only if there are truly no takes.`;
}

function buildUser(takes: Take[]): string {
  const lines = takes
    .map((t) => `${t.id} [${t.start.toFixed(2)}–${t.end.toFixed(2)}, ${(t.end - t.start).toFixed(1)}s] ${t.text || "(no transcript)"}`)
    .join("\n");
  return `Here are the ${takes.length} detected takes, in order:\n${lines}`;
}

/**
 * Turn the model's per-part grouping into a DEFAULT disabled-set, ENFORCING the
 * guarantees regardless of what the model returned:
 *   - every take belongs to exactly one part (unassigned takes become their own
 *     single-take part so nothing is dropped),
 *   - exactly one take per part is enabled (the best),
 *   - the chosen best is > minTakeForBest when any take in the part qualifies
 *     (so a short false-start can't beat the real line); if NO take in the part
 *     is long enough, the longest is kept enabled (never drop a whole part).
 * Returns the takes to DISABLE (the losing re-takes), each with the keeper's
 * snippet as the reason + scriptPart.
 */
export function defaultsFromParts(
  takes: Take[],
  modelParts: ModelPart[],
  minTakeForBest: number,
): TakeDefault[] {
  const byId = new Map(takes.map((t) => [t.id, t]));
  const len = (id: string) => {
    const t = byId.get(id);
    return t ? t.end - t.start : 0;
  };

  // Assign each take to a part; collect the validated groups (in take order so
  // the result is deterministic and stable).
  const assigned = new Set<string>();
  const groups: { ids: string[]; label: string }[] = [];
  for (const p of modelParts) {
    const ids = (Array.isArray(p?.takeIds) ? p.takeIds : []).filter((id) => byId.has(id) && !assigned.has(id));
    if (ids.length === 0) continue;
    ids.forEach((id) => assigned.add(id));
    groups.push({ ids, label: String(p?.part ?? "").trim() });
  }
  // Any take the model failed to assign becomes its own single-take part — it is
  // a distinct part we must NOT drop.
  for (const t of takes) {
    if (!assigned.has(t.id)) {
      assigned.add(t.id);
      groups.push({ ids: [t.id], label: t.text });
    }
  }

  const defaults: TakeDefault[] = [];
  for (const g of groups) {
    if (g.ids.length <= 1) continue; // single attempt → nothing to disable
    // Choose the keeper: among takes > minTakeForBest prefer the LATEST (by
    // start); if none qualifies, keep the LONGEST so the part is never dropped.
    const ordered = [...g.ids].sort((a, b) => (byId.get(a)!.start - byId.get(b)!.start));
    const qualifying = ordered.filter((id) => len(id) > minTakeForBest);
    const keeper = qualifying.length
      ? qualifying[qualifying.length - 1]
      : ordered.reduce((best, id) => (len(id) > len(best) ? id : best), ordered[0]);
    const keeperTake = byId.get(keeper)!;
    const snippet = keeperTake.text.length > 48
      ? keeperTake.text.slice(0, 47).trimEnd() + "…"
      : (keeperTake.text || g.label || "better take");
    const part = g.label || snippet;
    for (const id of g.ids) {
      if (id === keeper) continue;
      defaults.push({ id, reason: `duplicate — better take kept (${snippet})`, scriptPart: part });
    }
  }
  return defaults;
}

/**
 * Compute the DEFAULT disabled-set (best-take-per-part) for the timeline editor.
 * Uses a focused Claude pass over the takes + transcript when an Anthropic key is
 * configured; otherwise (or on any failure) falls back to the deterministic
 * `heuristicTakeDefaults`. The Claude call is injectable (`claudeFn`) so it can
 * be mocked in tests without touching the network.
 *
 * GUARANTEE (enforced in `defaultsFromParts`, independent of the model): every
 * distinct script part is covered by exactly one enabled take (no part dropped)
 * and no part is enabled twice (no duplicate).
 */
export async function selectBestTakeDefaults(
  takes: Take[],
  opts: { minTakeForBest?: number; claudeFn?: ClaudeJSONFn; hasKey?: boolean } = {},
): Promise<{ defaults: TakeDefault[]; usedAI: boolean }> {
  const minTakeForBest = opts.minTakeForBest ?? 3.0;
  if (takes.length < 2) return { defaults: [], usedAI: false };

  const hasKey = opts.hasKey ?? anthropicConfigured();
  const claudeFn = opts.claudeFn ?? (claudeJSONForPurpose as ClaudeJSONFn);
  if (!hasKey) {
    return { defaults: heuristicTakeDefaults(takes, minTakeForBest), usedAI: false };
  }

  try {
    const raw = await claudeFn({
      tier: "fast",
      purpose: "take-detection",
      system: buildSystem(),
      messages: [{ role: "user", content: buildUser(takes) }],
    });
    const data = JSON.parse(raw);
    const parts: ModelPart[] = Array.isArray(data?.parts) ? data.parts : [];
    return { defaults: defaultsFromParts(takes, parts, minTakeForBest), usedAI: true };
  } catch (e) {
    console.warn("[bestTake] AI selection failed (non-fatal) — using heuristic:", e instanceof Error ? e.message : e);
    return { defaults: heuristicTakeDefaults(takes, minTakeForBest), usedAI: false };
  }
}
