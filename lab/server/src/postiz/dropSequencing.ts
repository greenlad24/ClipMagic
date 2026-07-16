/**
 * Drop sequencing for the Bulk Scheduler — PURE and deterministic.
 *
 * A "drop" is ONE video released to ALL selected accounts within the same local
 * day. This module decides, for a big pile of picked videos, WHICH day each drop
 * lands on so that:
 *   - videos of the SAME visual "look" are spaced apart (a min day-gap), so the
 *     feed never posts two near-identical clips back-to-back;
 *   - looks are MIXED — consecutive drops come from different looks where possible;
 *   - a caps-per-day CADENCE is honored (at most N drops/day);
 *   - the arrangement is RANDOMIZED but reproducible: same `seed` → same plan, a
 *     new seed re-shuffles the mix (the UI's "reshuffle" button).
 *
 * It never picks the posting HOUR — that stays in scheduling.ts (per-platform
 * optimal windows). This module only assigns each drop a day + intra-day slot;
 * bulkScheduler pins the (file × channel) items to that day.
 *
 * The "look" of a render is derived from its FILENAME: batch renders are named
 * `<LookName>_<n>.mp4`, so the group key is the name with the trailing `_<n>` and
 * extension stripped (see groupKeyForFilename). Two videos share a look iff they
 * share that key.
 */

// ── Seeded RNG (mulberry32) — deterministic, no Date.now / Math.random ───────
/** A small, fast, deterministic PRNG. Returns a function yielding [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher–Yates shuffle using a seeded RNG. Returns a NEW array. */
export function seededShuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── Look grouping from a filename ────────────────────────────────────────────
/**
 * Derive a video's "look" group key from its filename. Batch renders are named
 * `<LookName>_<n>.mp4` (see routes/batches.ts), so we strip the extension and a
 * trailing numeric suffix (any of `_12`, `-12`, ` 12`, `.12`, ` (12)`). The rest,
 * lower-cased and trimmed, is the group key. A name with no separable number is
 * its own group. Never returns "" — an empty result falls back to the raw name.
 *
 * Examples:
 *   "SpaceFacts_12.mp4"   → "spacefacts"
 *   "Neon Loop - 3.mov"   → "neon loop"
 *   "cats (7).mp4"        → "cats"
 *   "oneoff.mp4"          → "oneoff"
 */
export function groupKeyForFilename(name: string): string {
  const raw = (name ?? "").trim();
  if (!raw) return "";
  // Strip a single trailing extension (2–4 alnum chars).
  const noExt = raw.replace(/\.[a-z0-9]{2,4}$/i, "");
  // Strip a trailing "(n)" or a "<sep>n" numeric suffix.
  const stripped = noExt
    .replace(/\s*\(\d+\)\s*$/, "") // " (12)"
    .replace(/[\s._-]+\d+\s*$/, ""); // "_12" / "-12" / " 12" / ".12"
  const key = stripped.trim().toLowerCase();
  return key || noExt.trim().toLowerCase() || raw.toLowerCase();
}

// ── Sequencing ───────────────────────────────────────────────────────────────
export interface DropFile {
  /** Stable id (matches bulkScheduler's fileId). */
  fileId: string;
  /** The look/visual group key (from groupKeyForFilename). */
  groupId: string;
}

export interface SequenceOptions {
  /** Max drops (distinct videos) per day. >= 1. */
  videosPerDay: number;
  /**
   * Minimum whole days between two drops of the SAME look. 0 = no spacing;
   * 3 = a look can reappear no sooner than 3 days later ("once every 3 days").
   */
  minGapDays: number;
  /** Deterministic shuffle seed (same seed → same plan). */
  seed: number;
  /** First day index the plan may use (>= 0). Default 0. */
  startDayOffset?: number;
}

export interface DropAssignment {
  fileId: string;
  groupId: string;
  /** Whole days from the schedule's start day (0 = start day). */
  dayOffset: number;
  /** 0-based position within that day (0 .. videosPerDay-1). */
  slot: number;
  /** Global emission order in the interleaved mix (0-based). */
  order: number;
}

/**
 * Order the picked files into a MIXED sequence (spreading each look apart) and
 * assign each a day + slot honoring the cadence and the min same-look gap.
 *
 * Two-phase, both pure:
 *   1) INTERLEAVE — a "largest remaining group, but not the same look as the last
 *      emission" round-robin (seeded tie-breaks) so looks alternate as much as the
 *      counts allow. This is what makes the feed feel varied.
 *   2) PACK — walk the interleaved sequence, placing each drop on the EARLIEST day
 *      that (a) still has cadence room and (b) is >= that look's last day + gap.
 *      Under-filled days are fine: a dominant look legitimately stretches the plan.
 *
 * Determinism: no Date.now / Math.random; only the seeded RNG. Same inputs +
 * seed → identical output, so it's unit-testable and the UI can reproduce a plan.
 */
export function sequenceDrops(files: readonly DropFile[], opts: SequenceOptions): DropAssignment[] {
  const cadence = Math.max(1, Math.floor(opts.videosPerDay));
  const gap = Math.max(0, Math.floor(opts.minGapDays));
  const startDay = Math.max(0, Math.floor(opts.startDayOffset ?? 0));
  const rng = mulberry32(opts.seed >>> 0);

  // 1) INTERLEAVE ──────────────────────────────────────────────────────────────
  // Build per-look queues, each internally shuffled, and the group order shuffled
  // too so equal-sized looks don't always emit in the same order across seeds.
  const byGroup = new Map<string, DropFile[]>();
  for (const f of files) {
    const list = byGroup.get(f.groupId) ?? [];
    list.push(f);
    byGroup.set(f.groupId, list);
  }
  const groups = seededShuffle([...byGroup.keys()], rng).map((g) => ({
    id: g,
    queue: seededShuffle(byGroup.get(g)!, rng),
  }));

  const sequence: DropFile[] = [];
  let lastGroup: string | null = null;
  let remaining = files.length;
  while (remaining > 0) {
    // Candidates = groups with items left; prefer NOT repeating the last look.
    const live = groups.filter((g) => g.queue.length > 0);
    const maxLen = Math.max(...live.map((g) => g.queue.length));
    let pool = live.filter((g) => g.queue.length === maxLen && g.id !== lastGroup);
    // Only the last look remains with the max count → allow the smaller others,
    // else (truly nothing else) allow the repeat.
    if (pool.length === 0) {
      const others = live.filter((g) => g.id !== lastGroup);
      pool = others.length > 0 ? others : live;
    }
    const pick = pool[Math.floor(rng() * pool.length)];
    sequence.push(pick.queue.shift()!);
    lastGroup = pick.id;
    remaining--;
  }

  // 2) PACK ─────────────────────────────────────────────────────────────────────
  const lastDayForGroup = new Map<string, number>();
  const countOnDay = new Map<number, number>();
  const out: DropAssignment[] = [];
  sequence.forEach((f, order) => {
    const gapDay = lastDayForGroup.has(f.groupId) ? lastDayForGroup.get(f.groupId)! + gap : startDay;
    let day = Math.max(startDay, gapDay);
    while ((countOnDay.get(day) ?? 0) >= cadence) day++;
    const slot = countOnDay.get(day) ?? 0;
    countOnDay.set(day, slot + 1);
    lastDayForGroup.set(f.groupId, day);
    out.push({ fileId: f.fileId, groupId: f.groupId, dayOffset: day, slot, order });
  });
  return out;
}

/** How many distinct looks a set of files spans (for UI hints / warnings). */
export function countLooks(files: readonly DropFile[]): number {
  return new Set(files.map((f) => f.groupId)).size;
}
