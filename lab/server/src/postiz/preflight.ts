/**
 * Pre-flight VIDEO validator for the Bulk Scheduler's Growth Guardrails.
 *
 * Inspects each selected render/upload by its LOCAL file path with ffprobe and
 * grades it against 2026 short-form growth best-practices (vertical 9:16, a
 * completion-friendly duration, sane resolution/fps). It reuses the existing
 * `probe()` from render/ffmpeg.ts — but that call is INJECTABLE (`ProbeFn`) so
 * the logic is unit-tested with a stub, no ffmpeg/network in tests.
 *
 * Graceful degradation is a hard requirement:
 *   - CLOUD share-links have no local file → every video check is `unknown`
 *     (advisory) with a note that deep checks need a local render. We never
 *     download a whole video just to probe it, and we never fail hard.
 *   - ffprobe failures (returns nulls / throws) also degrade to `unknown`, not a
 *     crash or a false `required` failure.
 *
 * Severity policy (see captions.ts for the parallel caption policy):
 *   - `required`     : we measured the value and it violates a hard growth rule.
 *   - `recommended`  : a softer signal, OR a value we can only heuristically read.
 *   - `unknown`      : we couldn't measure it (cloud link / ffprobe unavailable)
 *                      — purely advisory, never gates scheduling.
 */
import { probe, type ProbeResult } from "../render/ffmpeg.js";
import { scoreChecks, type GrowthCheck } from "./captions.js";
import { resolveLocalPath, type FileSourceRef } from "./fileSources.js";

/** Pre-flight checks add an `unknown` state on top of the caption severities. */
export type PreflightSeverity = "required" | "recommended" | "unknown";

export interface PreflightCheck {
  id: string;
  label: string;
  /** null when the check couldn't be evaluated (severity === "unknown"). */
  pass: boolean | null;
  severity: PreflightSeverity;
  hint: string;
}

export interface PreflightResult {
  /** 0..100 over the checks we COULD evaluate (unknowns are excluded). */
  score: number;
  checks: PreflightCheck[];
}

/** Injectable probe — same shape as render/ffmpeg.ts `probe()`. Stubbed in tests. */
export type ProbeFn = (filePath: string) => Promise<ProbeResult>;

// ── Tunable thresholds ───────────────────────────────────────────────────────
// Duration window for short-form. The upper bound exists because watch-time /
// completion rate is the dominant 2026 ranking signal — the widely cited
// benchmark is keeping ~70% average completion, which gets much harder as a clip
// runs long. We don't fail short clips (a 5s clip can crush completion); we only
// flag clips long enough to put the 70%-completion target at risk.
const MIN_DURATION_SEC = 3;
const MAX_DURATION_SEC = 90; // beyond ~90s, sustaining 70% completion is unlikely
// Vertical: 9:16 ≈ 0.5625. Allow a little slack for 0.55–0.58 exports.
const VERTICAL_MAX_RATIO = 0.6; // width/height must be ≤ this to count as vertical
const MIN_SHORT_EDGE = 720; // ≥720p short edge keeps it crisp on full-screen feeds

/**
 * Light, ADVISORY watermark heuristic. True watermark detection needs pixel
 * analysis / a model and is explicitly OUT OF SCOPE here — we do NOT claim to
 * detect watermarks. We only flag NAME/REF hints that the file is a re-export
 * from another platform (a download tool, a "watermark" tag, a tiktok/capcut/
 * snaptik origin), which often carries a baked-in logo. Severity is
 * `recommended` — never a hard block — because it's a guess, not a measurement.
 */
const WATERMARK_HINT_RE =
  /(watermark|snaptik|ssstik|musicallydown|tiktok[_-]?download|savefrom|capcut|no[_-]?watermark|_dl\b|download_)/i;

/**
 * Validate one selected item. `src` decides whether we can probe locally; the
 * optional `ref` (the file's display name / id) feeds the advisory watermark
 * hint. `probeFn` is injected for tests.
 */
export async function preflightVideo(
  src: FileSourceRef,
  opts: { probeFn?: ProbeFn; nameHint?: string } = {},
): Promise<PreflightResult> {
  const probeFn = opts.probeFn ?? probe;
  const nameHint = opts.nameHint ?? src.ref;

  // Cloud links: no local file. Every measurable check is unknown/advisory.
  if (src.kind === "cloud") {
    return buildResult(null, nameHint, "Cloud link — render or upload the file locally for deep video checks.");
  }

  const localPath = await resolveLocalPath(src);
  if (!localPath) {
    return buildResult(null, nameHint, "File not found on this server — deep video checks were skipped.");
  }

  let info: ProbeResult;
  try {
    info = await probeFn(localPath);
  } catch {
    // probe() itself never throws, but an injected/abstract probe might.
    info = { duration: null, width: null, height: null, hasAudio: false };
  }
  return buildResult(info, nameHint, "ffprobe couldn't read this file — deep video checks were skipped.");
}

/**
 * Turn a ProbeResult (or null for cloud/unresolved) into the check list. When a
 * dimension is null we emit it as `unknown` with `unknownNote`, so the caller
 * gets a consistent shape whether we measured or not.
 */
function buildResult(info: ProbeResult | null, nameHint: string, unknownNote: string): PreflightResult {
  const w = info?.width ?? null;
  const h = info?.height ?? null;
  const d = info?.duration ?? null;

  const checks: PreflightCheck[] = [];

  // ── Vertical 9:16 ──────────────────────────────────────────────────────────
  if (w && h) {
    const ratio = w / h;
    checks.push({
      id: "vertical",
      label: "Vertical 9:16",
      pass: ratio <= VERTICAL_MAX_RATIO,
      // Advisory: a non-vertical clip still posts, it just won't fill the feed.
      severity: "recommended",
      hint: "Short-form is full-screen vertical (9:16). Re-export portrait so it fills the feed.",
    });
  } else {
    checks.push(unknownCheck("vertical", "Vertical 9:16", unknownNote));
  }

  // ── Resolution (short edge ≥ 720p) ───────────────────────────────────────────
  if (w && h) {
    const shortEdge = Math.min(w, h);
    checks.push({
      id: "resolution",
      label: "≥ 720p",
      pass: shortEdge >= MIN_SHORT_EDGE,
      severity: "recommended",
      hint: `Export at least ${MIN_SHORT_EDGE}p on the short edge (this is ${shortEdge}p) so it stays crisp.`,
    });
  } else {
    checks.push(unknownCheck("resolution", "≥ 720p", unknownNote));
  }

  // ── Duration window (completion-rate guardrail) ───────────────────────────────
  if (d != null) {
    const ok = d >= MIN_DURATION_SEC && d <= MAX_DURATION_SEC;
    checks.push({
      id: "duration",
      label: `${MIN_DURATION_SEC}–${MAX_DURATION_SEC}s runtime`,
      pass: ok,
      // Required: runtime directly drives completion rate (the ~70% benchmark),
      // which is the dominant ranking signal — a measured violation gates posting.
      severity: "required",
      hint:
        d > MAX_DURATION_SEC
          ? `${Math.round(d)}s is long for short-form — trim toward ≤ ${MAX_DURATION_SEC}s to protect ~70% completion.`
          : `${Math.round(d)}s is very short — give viewers enough to watch (≥ ${MIN_DURATION_SEC}s).`,
    });
  } else {
    checks.push(unknownCheck("duration", `${MIN_DURATION_SEC}–${MAX_DURATION_SEC}s runtime`, unknownNote));
  }

  // ── Watermark hint (ADVISORY heuristic — not real detection) ─────────────────
  // Name/ref-only guess; see WATERMARK_HINT_RE. Pass = "no hint found".
  const hinted = WATERMARK_HINT_RE.test(nameHint);
  checks.push({
    id: "watermark",
    label: "No watermark hint",
    pass: !hinted,
    severity: "recommended",
    hint: hinted
      ? "Filename hints at a re-export/other-platform download — check for a baked-in watermark (advisory)."
      : "Advisory only — we can't truly detect watermarks from metadata.",
  });

  return { score: scorePreflight(checks), checks };
}

function unknownCheck(id: string, label: string, note: string): PreflightCheck {
  return { id, label, pass: null, severity: "unknown", hint: note };
}

/**
 * 0..100 over only the checks we could MEASURE — `unknown` checks are excluded
 * (they're not failures, just unmeasured). Reuses the caption scorer's weighting
 * by mapping measured pre-flight checks onto GrowthCheck severities.
 */
export function scorePreflight(checks: PreflightCheck[]): number {
  const measured = checks.filter((c) => c.severity !== "unknown" && c.pass !== null);
  if (measured.length === 0) return 100; // nothing measurable → don't penalize
  const asGrowth: GrowthCheck[] = measured.map((c) => ({
    id: c.id,
    label: c.label,
    pass: c.pass === true,
    severity: c.severity as GrowthCheck["severity"],
    hint: c.hint,
  }));
  return scoreChecks(asGrowth);
}
