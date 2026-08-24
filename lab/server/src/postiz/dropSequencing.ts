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

// ── Cadence ramps (warm-up mode) ─────────────────────────────────────────────
/**
 * A ramp is a list of PHASES walked in order from the plan's first day, each
 * capping how many drops a day may hold. It exists so a brand-new account can
 * start sparse and step up, instead of taking a 200-video batch at full speed
 * from day one.
 *
 * A phase caps by day (`perDay`) or by week (`perWeek`). `perWeek` is the
 * interesting one: it spreads its quota over evenly-spaced days and leaves the
 * rest of the week at ZERO, so the account posts on a fixed weekly rhythm
 * (3/week → days 0, 2, 4 — a Mon/Wed/Fri shape) rather than three days clumped
 * together. Predictability is the point; platforms reward a steady cadence more
 * than they reward volume.
 */
export interface CadencePhase {
  /** Whole weeks this phase lasts. Omit on the LAST phase so it runs forever. */
  weeks?: number;
  /** Drops allowed on every day of this phase. Takes precedence over perWeek. */
  perDay?: number;
  /** Drops allowed per week, spread over evenly-spaced days (rest days = 0). */
  perWeek?: number;
}

/**
 * The WARM-UP ramp: 3 drops a week for 4 weeks, then one a day for 4 weeks, then
 * two a day from week 9 on. Two a day is the ceiling on purpose — past that, a
 * single short-form account mostly competes with itself for the same viewers.
 */
export const WARM_UP_RAMP: readonly CadencePhase[] = [
  { weeks: 4, perWeek: 3 },
  { weeks: 4, perDay: 1 },
  { perDay: 2 },
];

/**
 * Hard bound on how far the packer will walk looking for a free day. A ramp that
 * somehow caps every day at 0 must degrade to "place it anyway", never spin.
 */
const MAX_PLAN_DAYS = 3650;

/** The 7 per-weekday caps for one phase (index 0 = the phase's first weekday). */
function weekdayCapacities(p: CadencePhase): number[] {
  const perDay = Math.floor(p.perDay ?? 0);
  if (perDay > 0) return Array.from({ length: 7 }, () => perDay);

  const perWeek = Math.max(0, Math.floor(p.perWeek ?? 0));
  // A phase that caps nothing would stall the packer forever — treat it as 1/day.
  if (perWeek <= 0) return Array.from({ length: 7 }, () => 1);

  const base = Math.floor(perWeek / 7);
  const rem = perWeek % 7;
  const caps = Array.from({ length: 7 }, () => base);
  // Spread the remainder over evenly-spaced days so the rhythm stays regular.
  for (let i = 0; i < rem; i++) caps[Math.floor((i * 7) / rem)] += 1;
  return caps;
}

/**
 * Resolve a ramp into `day -> capacity`, where `day` is an absolute day offset
 * and `startDay` is the plan's first day (so "week 1" means the first week of
 * THIS plan, not of the epoch). Days before the start hold nothing.
 */
export function rampCapacityFn(ramp: readonly CadencePhase[], startDay: number): (day: number) => number {
  const phases: Array<{ from: number; to: number; caps: number[] }> = [];
  let cursor = 0;
  ramp.forEach((p, i) => {
    const isLast = i === ramp.length - 1;
    const weeks = Math.floor(p.weeks ?? 0);
    // The final phase always runs forever, whatever it says, so a ramp can't
    // fall off its own end and leave later days uncapped.
    const span = isLast || weeks <= 0 ? Number.POSITIVE_INFINITY : weeks * 7;
    phases.push({ from: cursor, to: cursor + span - 1, caps: weekdayCapacities(p) });
    cursor += span;
  });
  const last = phases[phases.length - 1];
  return (day: number) => {
    const rel = day - startDay;
    if (rel < 0) return 0;
    const phase = phases.find((ph) => rel >= ph.from && rel <= ph.to) ?? last;
    return phase.caps[(rel - phase.from) % 7];
  };
}

/**
 * Days covered by a ramp's FIRST phase — its sparse opening.
 *
 * Warm-up ships no call to action for exactly this window, so the two stay tied:
 * retune the ramp's opening and the quiet period follows it, instead of a 28
 * hard-coded somewhere else drifting out of sync.
 */
export function rampFirstPhaseDays(ramp: readonly CadencePhase[]): number {
  const first = ramp[0];
  if (!first) return 0;
  const weeks = Math.floor(first.weeks ?? 0);
  // A single-phase ramp has no "opening" distinct from the rest of the campaign.
  return ramp.length <= 1 || weeks <= 0 ? 0 : weeks * 7;
}

/** The busiest day any phase of a ramp allows (the per-channel cap must clear it). */
export function rampPeakPerDay(ramp: readonly CadencePhase[]): number {
  let peak = 1;
  for (const p of ramp) for (const c of weekdayCapacities(p)) peak = Math.max(peak, c);
  return peak;
}

/**
 * How many days a ramp needs to release `count` drops — the UI's "N days to
 * clear these videos" estimate, and the reason warm-up mode has to say so up
 * front: 227 videos at 3/week would take years, so the ramp has to reach a
 * daily cadence for a big batch to be realistic at all.
 */
export function rampDaysToClear(count: number, ramp: readonly CadencePhase[]): number {
  if (count <= 0) return 0;
  const capacity = rampCapacityFn(ramp, 0);
  let left = count;
  let day = 0;
  while (left > 0 && day < MAX_PLAN_DAYS) {
    left -= capacity(day);
    day++;
  }
  return day;
}

// ── Sequencing ───────────────────────────────────────────────────────────────
export interface DropFile {
  /** Stable id (matches bulkScheduler's fileId). */
  fileId: string;
  /** The look/visual group key used for INTERLEAVING (never two in a row). */
  groupId: string;
  /**
   * The key used for the multi-day SPACING rule, when it differs from groupId.
   * These are two different questions: "which clips look alike back-to-back?"
   * (groupId — for renders, the shooting position) versus "which clips are the
   * same look and so must sit days apart?" (spacingId — the filename look).
   * Collapsing them would be a trap: with only a handful of positions, applying
   * a 3-day gap to positions would stretch a 240-clip plan across ~180 days.
   * Defaults to groupId, which is the historical behavior.
   */
  spacingId?: string;
}

export interface SequenceOptions {
  /** Max drops (distinct videos) per day. >= 1. Ignored when `ramp` is set. */
  videosPerDay: number;
  /**
   * A RAMPING cadence that replaces the flat `videosPerDay` cap — warm-up mode.
   * Phases are walked from the plan's first day; see CadencePhase / WARM_UP_RAMP.
   */
  ramp?: readonly CadencePhase[];
  /**
   * Minimum whole days between two drops of the SAME look. 0 = no spacing;
   * 3 = a look can reappear no sooner than 3 days later ("once every 3 days").
   */
  minGapDays: number;
  /** Deterministic shuffle seed (same seed → same plan). */
  seed: number;
  /** First day index the plan may use (>= 0). Default 0. */
  startDayOffset?: number;
  /**
   * An explicit emission order (fileIds) that REPLACES the seeded interleave.
   * The UI's Randomize button sends the arrangement the user is looking at, so
   * the plan is the order they were shown rather than a second, different mix.
   * Ids not in the list keep their input order and follow the listed ones; the
   * seeded interleave still runs when this is absent.
   */
  fixedOrder?: readonly string[];
}

export interface DropAssignment {
  fileId: string;
  groupId: string;
  /** Whole days from the schedule's start day (0 = start day). */
  dayOffset: number;
  /** 0-based position within that day (0 .. that day's capacity - 1). */
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
 *      With a `ramp`, "cadence room" varies by day and can be zero (a rest day).
 *
 * Determinism: no Date.now / Math.random; only the seeded RNG. Same inputs +
 * seed → identical output, so it's unit-testable and the UI can reproduce a plan.
 */
export function sequenceDrops(files: readonly DropFile[], opts: SequenceOptions): DropAssignment[] {
  const cadence = Math.max(1, Math.floor(opts.videosPerDay));
  const gap = Math.max(0, Math.floor(opts.minGapDays));
  const startDay = Math.max(0, Math.floor(opts.startDayOffset ?? 0));
  const rng = mulberry32(opts.seed >>> 0);
  // A ramp caps each day individually (and may close a day entirely); without
  // one every day gets the same flat cadence, which is the original behavior.
  const capacityForDay =
    opts.ramp && opts.ramp.length > 0 ? rampCapacityFn(opts.ramp, startDay) : () => cadence;

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
  if (opts.fixedOrder && opts.fixedOrder.length > 0) {
    const rank = new Map(opts.fixedOrder.map((id, i) => [id, i]));
    sequence.push(
      ...files
        .map((f, i) => ({ f, i, r: rank.get(f.fileId) ?? Number.POSITIVE_INFINITY }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.f),
    );
    return pack(sequence, { capacityForDay, gap, startDay });
  }
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
  return pack(sequence, { capacityForDay, gap, startDay });
}

/**
 * Walk a decided sequence and give each drop the EARLIEST day with cadence room
 * that also clears its look's min gap. "Room" comes from `capacityForDay`, so a
 * flat cadence and a warm-up ramp share this one code path. The gap is enforced on spacingId (which
 * falls back to groupId), so a plan can alternate positions on consecutive drops
 * while still holding same-look clips days apart.
 */
function pack(
  sequence: readonly DropFile[],
  {
    capacityForDay,
    gap,
    startDay,
  }: { capacityForDay: (day: number) => number; gap: number; startDay: number },
): DropAssignment[] {
  const lastDayForGroup = new Map<string, number>();
  const countOnDay = new Map<number, number>();
  const out: DropAssignment[] = [];
  sequence.forEach((f, order) => {
    const spacing = f.spacingId ?? f.groupId;
    const gapDay = lastDayForGroup.has(spacing) ? lastDayForGroup.get(spacing)! + gap : startDay;
    let day = Math.max(startDay, gapDay);
    // Walk to the next day with room. Under a ramp a day's capacity can be 0 (a
    // rest day in the weekly rhythm), so this skips CLOSED days as well as full
    // ones. Bounded: a ramp that closed every day would otherwise never return.
    const limit = day + MAX_PLAN_DAYS;
    while (day < limit && (countOnDay.get(day) ?? 0) >= Math.max(0, Math.floor(capacityForDay(day)))) {
      day++;
    }
    const slot = countOnDay.get(day) ?? 0;
    countOnDay.set(day, slot + 1);
    lastDayForGroup.set(spacing, day);
    out.push({ fileId: f.fileId, groupId: f.groupId, dayOffset: day, slot, order });
  });
  return out;
}

/** How many distinct looks a set of files spans (for UI hints / warnings). */
export function countLooks(files: readonly DropFile[]): number {
  return new Set(files.map((f) => f.groupId)).size;
}
