/**
 * WHO IS ALLOWED TO OPEN WHAT — the community is freemium, and the agent has to
 * know it before it recommends anything.
 *
 * Jake, 2026-08-27: "I've changed the business model of the skool community —
 * it's a freemium model. Only the first course 'Free AI Starter Pack' is
 * available for free users. Before answering a person on a DM, first understand
 * if he or she is a paid or free user and recommend accordingly. If he's paid
 * you can recommend anything. If he's free you can recommend a page from the
 * first class or a past post in the community."
 *
 * ⚠️⚠️ "THE FIRST COURSE" IS THE ANSWER TODAY, NOT THE RULE. Skool gates a
 * course on TWO numbers — `minTier` (1 = free, 2 = paid) and `minAccessLevel`
 * (1-9) — and a member carries both a tier and a level. Hardcoding one course id
 * would be right this week and silently wrong the moment Jake adds a second free
 * course, opens one at level 6 (his own landing page promises exactly that:
 * "At Level 6 — unlock 5 paid courses for free"), or renames the starter pack.
 * So the gate is READ from Skool and applied per member, and the fact that it
 * currently yields exactly *Free AI Starter Pack* is a measurement, not an
 * assumption:
 *
 *   measured 2026-08-27, 19 courses —
 *     Free AI Starter Pack .......... minTier 1, minAccessLevel 1  ← the only
 *                                                                    one open
 *     Make Videos with AI ........... minTier 1, minAccessLevel 9
 *     Automation For Beginners ...... minTier 1, minAccessLevel 9
 *     the other 16 .................. minTier 2
 *
 * ⚠️⚠️ THE PAID SIGNAL IS VISIBLE ONLY BECAUSE THIS SESSION IS AN ADMIN.
 * `user.member.metadata` on the members page carries the Stripe subscription id,
 * the period end and the plan — for every member — because `pageProps.self` is a
 * group-admin here. If the imported cookie is ever demoted or replaced with a
 * member's, every member reads as free. That is the SAFE direction (a paid
 * member gets offered a free lesson) but it is not silent: `refreshMemberAccess`
 * reports how many paying members it found, and zero against a community whose
 * own `totalMBp` is not zero is the tell.
 *
 * ⚠️ AN UNKNOWN MEMBER IS TREATED AS FREE. Someone who left, someone the read
 * missed, a stale cache: all of them resolve to the free entitlement, because
 * recommending a free page to a paying member is a small loss and recommending a
 * paid course to a free one is the exact failure this file exists to prevent.
 * `unknown` is carried on the entitlement so the ledger can show which it was.
 */
import { db } from "../db/index.js";
import { readClassroom } from "./classroom.js";
import { readMembers, type SkoolMember } from "./members.js";

/* ────────────────────────── what a member may open ────────────────────────── */

export interface MemberAccess {
  userId: string;
  handle: string;
  displayName: string;
  /** 1 = free member, 2 = paying (or an admin — see `members.ts`). */
  tier: 1 | 2;
  paid: boolean;
  level: number;
  plan: string;
  renewsAt: number;
  role: string;
  /** Epoch ms this was read from Skool. 0 for the unknown-member fallback. */
  readAt: number;
  /**
   * True when nothing was known about this person and the free default was
   * applied. NOT the same as a member who is genuinely free.
   */
  unknown: boolean;
}

export interface CourseGate {
  slug: string;
  courseId: string;
  title: string;
  minTier: number;
  minAccessLevel: number;
  readAt: number;
}

/** The entitlement, plus the courses it actually opens. */
export interface Entitlement {
  member: MemberAccess;
  /** Every course this person can open, gate by gate. */
  openCourses: CourseGate[];
  /** Courses that exist and are shut to them — named, for the prompt. */
  lockedCourses: CourseGate[];
  /** Empty when the gates have never been read; the caller must say so. */
  gatesReadAt: number;
}

const freeUnknown = (userId: string, name: string): MemberAccess => ({
  userId,
  handle: "",
  displayName: name,
  tier: 1,
  paid: false,
  level: 0,
  plan: "",
  renewsAt: 0,
  role: "",
  readAt: 0,
  unknown: true,
});

/* ────────────────────────── the member cache ────────────────────────── */

const rowToAccess = (r: any): MemberAccess => ({
  userId: String(r.user_id),
  handle: String(r.handle ?? ""),
  displayName: String(r.display_name ?? ""),
  tier: Number(r.tier) === 2 ? 2 : 1,
  paid: Number(r.paid) === 1,
  level: Number(r.level ?? 0),
  plan: String(r.plan ?? ""),
  renewsAt: Number(r.renews_at ?? 0),
  role: String(r.role ?? ""),
  readAt: Number(r.read_at ?? 0),
  unknown: false,
});

export function cachedAccess(userId: string): MemberAccess | null {
  if (!userId) return null;
  const r = db.prepare("SELECT * FROM skool_member_access WHERE user_id = ?").get(userId) as any;
  return r ? rowToAccess(r) : null;
}

/** When the member cache was last written, epoch ms. 0 when it never has been. */
export function memberAccessReadAt(): number {
  const r = db.prepare("SELECT MAX(read_at) AS at FROM skool_member_access").get() as { at: number | null };
  return Number(r?.at ?? 0);
}

export interface AccessRefresh {
  members: number;
  paying: number;
  pagesRead: number;
  readAt: number;
  error: string | null;
}

/**
 * Re-read every member and store what they may open.
 *
 * ⚠️ THE WHOLE LIST, NEVER ONE MEMBER. Skool's members page is the only place
 * the billing fields appear and it is paginated, not queryable — there is no
 * "fetch this member" to fall back on. Three pages at ~2.5s is the price, which
 * is why this is cached rather than called per reply.
 *
 * ⚠️ A FAILED READ LEAVES THE OLD CACHE STANDING. Wiping it would turn a
 * transient browser failure into "everybody is free", which is precisely the
 * wrong answer to give confidently — a stale tier is a far smaller error than a
 * fabricated one, and `readAt` shows a reader how stale.
 */
export async function refreshMemberAccess(communityUrl: string): Promise<AccessRefresh> {
  const read = await readMembers(communityUrl);
  if (read.error && !read.members.length) {
    return { members: 0, paying: 0, pagesRead: read.pagesRead, readAt: 0, error: read.error };
  }
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO skool_member_access
       (user_id, handle, display_name, tier, paid, level, plan, renews_at, role, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       handle = excluded.handle, display_name = excluded.display_name, tier = excluded.tier,
       paid = excluded.paid, level = excluded.level, plan = excluded.plan,
       renews_at = excluded.renews_at, role = excluded.role, read_at = excluded.read_at`,
  );
  const write = db.transaction((members: SkoolMember[]) => {
    for (const m of members) {
      stmt.run(
        m.userId, m.handle, m.displayName, m.tier, m.paid ? 1 : 0,
        m.level, m.plan, m.renewsAt, m.role, now,
      );
    }
  });
  write(read.members);
  return {
    members: read.members.length,
    paying: read.members.filter((m) => m.paid).length,
    pagesRead: read.pagesRead,
    readAt: now,
    error: read.error,
  };
}

/* ────────────────────────── the course gates ────────────────────────── */

const rowToGate = (r: any): CourseGate => ({
  slug: String(r.slug),
  courseId: String(r.course_id ?? ""),
  title: String(r.title ?? ""),
  minTier: Number(r.min_tier ?? 0),
  minAccessLevel: Number(r.min_access_level ?? 0),
  readAt: Number(r.read_at ?? 0),
});

export function courseGates(): CourseGate[] {
  return (db.prepare("SELECT * FROM skool_course_gate ORDER BY title").all() as any[]).map(rowToGate);
}

/**
 * The courses a FREE member at the lowest level can open.
 *
 * This is what makes the free half of a reply possible at all: the knowledge
 * index admits these courses even when the rebuild's plan does not name them,
 * because the *Free AI Starter Pack* is not one of the 15 rebuilt tracks and
 * would otherwise be invisible to the agent — leaving a free member's reply with
 * nothing whatever to point at.
 */
export function freeTierCourseSlugs(): string[] {
  return courseGates()
    .filter((g) => g.minTier <= 1 && g.minAccessLevel <= 1)
    .map((g) => g.slug);
}

export interface GateRefresh {
  courses: number;
  freeToEveryone: string[];
  readAt: number;
  error: string | null;
}

/** Re-read every course's two gates. One navigation per 30 courses. */
export async function refreshCourseGates(communityUrl: string): Promise<GateRefresh> {
  const classroom = await readClassroom(communityUrl);
  if (classroom.error) return { courses: 0, freeToEveryone: [], readAt: 0, error: classroom.error };
  // A classroom that reads as empty is not a reason to forget the gates: same
  // rule as the member cache above.
  if (!classroom.courses.length) {
    return { courses: 0, freeToEveryone: [], readAt: 0, error: "The classroom read carried no courses." };
  }

  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO skool_course_gate (slug, course_id, title, min_tier, min_access_level, read_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       course_id = excluded.course_id, title = excluded.title, min_tier = excluded.min_tier,
       min_access_level = excluded.min_access_level, read_at = excluded.read_at`,
  );
  const write = db.transaction(() => {
    for (const c of classroom.courses) {
      stmt.run(c.slug, c.id, c.title, c.minTier, c.minAccessLevel, now);
    }
    // ⚠️ A COURSE THAT HAS GONE MUST LOSE ITS GATE ROW. Leaving it would keep a
    // deleted course "open to free members" forever, and the index admits free
    // courses by this table.
    const keep = classroom.courses.map((c) => c.slug);
    const holes = keep.map(() => "?").join(",");
    db.prepare(`DELETE FROM skool_course_gate WHERE slug NOT IN (${holes})`).run(...keep);
  });
  write();

  return {
    courses: classroom.courses.length,
    freeToEveryone: classroom.courses
      .filter((c) => c.minTier <= 1 && c.minAccessLevel <= 1)
      .map((c) => c.title),
    readAt: now,
    error: null,
  };
}

/* ────────────────────────── the decision ────────────────────────── */

/** How stale the caches may be before a sweep re-reads them. */
export const ACCESS_MAX_AGE_MS = 6 * 3600_000;

/**
 * Bring both caches up to date if they are stale, and say what happened.
 *
 * Called ONCE per sweep, not once per reply — the reads are browser
 * navigations, and every target in a sweep is judged against the same snapshot.
 */
export async function ensureAccessFresh(
  communityUrl: string,
  opts: { maxAgeMs?: number; force?: boolean } = {},
): Promise<{ notes: string[]; membersReadAt: number; gatesReadAt: number }> {
  const maxAge = opts.maxAgeMs ?? ACCESS_MAX_AGE_MS;
  const notes: string[] = [];

  const gates = courseGates();
  const gatesAt = gates.length ? Math.max(...gates.map((g) => g.readAt)) : 0;
  if (opts.force || Date.now() - gatesAt > maxAge) {
    const r = await refreshCourseGates(communityUrl).catch((e) => ({
      courses: 0, freeToEveryone: [], readAt: 0, error: String(e?.message ?? e),
    }));
    if (r.error) notes.push(`Course gates not re-read: ${r.error}`);
    else notes.push(`Course gates: ${r.courses} courses, open to free members: ${r.freeToEveryone.join(", ") || "none"}.`);
  }

  const membersAt = memberAccessReadAt();
  if (opts.force || Date.now() - membersAt > maxAge) {
    const r = await refreshMemberAccess(communityUrl).catch((e) => ({
      members: 0, paying: 0, pagesRead: 0, readAt: 0, error: String(e?.message ?? e),
    }));
    if (r.error && !r.members) notes.push(`Member tiers not re-read: ${r.error}`);
    else notes.push(`Member tiers: ${r.members} members, ${r.paying} paying.`);
  }

  const after = courseGates();
  return {
    notes,
    membersReadAt: memberAccessReadAt(),
    gatesReadAt: after.length ? Math.max(...after.map((g) => g.readAt)) : 0,
  };
}

/**
 * What this person may be pointed at.
 *
 * Reads the caches only — `ensureAccessFresh` is what touches the browser, so a
 * per-target call here costs nothing and cannot hang a sweep half way through.
 */
export function entitlementFor(userId: string, displayName = ""): Entitlement {
  const member = cachedAccess(userId) ?? freeUnknown(userId, displayName);
  const gates = courseGates();
  // ⚠️⚠️ PAYING OVERRIDES THE LEVEL — Jake, asked directly 2026-08-27: a paying
  // member at level 3 opens a level-6 course. The two numbers are not a
  // conjunction for them, and reading them as one is not a harmless
  // conservatism: 12 of the 16 paid courses are `minAccessLevel: 9`, a level
  // almost nobody reaches, so an AND would have reported a community whose
  // paying members can open almost nothing — and `openCourses` is what the
  // bench and the ledger show a human.
  //
  // The level half is real for FREE members, where it is the only thing
  // separating the one open course from the two that merely look open
  // (`minTier: 1, minAccessLevel: 9` — see the header).
  const open = gates.filter(
    (g) => member.tier >= 2 || (g.minTier <= member.tier && g.minAccessLevel <= Math.max(member.level, 1)),
  );
  return {
    member,
    openCourses: open,
    lockedCourses: gates.filter((g) => !open.includes(g)),
    gatesReadAt: gates.length ? Math.max(...gates.map((g) => g.readAt)) : 0,
  };
}

/**
 * The slugs a retrieval may return for this person — or `null` for "no limit".
 *
 * ⚠️ NULL AND [] MEAN OPPOSITE THINGS AND BOTH ARE REACHABLE. A paid member is
 * `null` (everything). A free member whose gates have never been read is `[]`
 * (nothing), which correctly starves the drafter of lessons rather than handing
 * it the paid classroom by default.
 */
export function allowedCourseSlugs(ent: Entitlement): string[] | null {
  if (ent.member.tier >= 2) return null;
  return ent.openCourses.map((g) => g.slug);
}
