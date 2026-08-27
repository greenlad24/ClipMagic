/**
 * Put ONE course into the agent's index without re-reading the whole classroom.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE THE FREEMIUM CHANGE MADE A NEW COURSE LOAD-BEARING
 * OVERNIGHT. *Free AI Starter Pack* was written on 2026-08-25; the newest full
 * inventory predates it, so the course the agent must now recommend to every
 * free member was not in the index at all — and `retrieve` would have reported
 * "nothing matched" for them, indistinguishably from a member asking about
 * something the classroom does not cover.
 *
 * The honest alternative is a full `readFullClassroom`, and it is not a small
 * thing: 19 courses and 257 modules, one browser navigation per unit, on the
 * single shared session — tens of minutes during which nothing else can use the
 * browser. A six-lesson course costs seven navigations.
 *
 * ⚠️ IT WRITES A NEW SNAPSHOT ROW, IT DOES NOT EDIT THE OLD ONE. An inventory is
 * a record of what was live at a moment; editing one in place would make an old
 * plan un-reproducible and would rewrite the evidence behind decisions already
 * taken. The new row carries `toppedUpFrom` so a reader can see it is a copy
 * with one course re-read rather than a fresh full scan — which matters,
 * because every OTHER course in it is exactly as stale as the row it came from.
 */
import { readClassroom, readCourse } from "./classroom.js";
import { finishInventory, latestCompleteInventory, startInventory } from "../db/skool.js";

export interface TopUpResult {
  inventoryId: number | null;
  courseTitle: string;
  slug: string;
  units: number;
  /** True when the course was already in the snapshot and was replaced. */
  replaced: boolean;
  /** Copied forward untouched — stale by exactly as much as they already were. */
  carriedOver: number;
  error: string | null;
}

export async function topUpInventoryWithCourse(communityUrl: string, slug: string): Promise<TopUpResult> {
  const fail = (error: string): TopUpResult => ({
    inventoryId: null, courseTitle: "", slug, units: 0, replaced: false, carriedOver: 0, error,
  });
  if (!slug.trim()) return fail("Which course? Pass its slug.");

  const previous = latestCompleteInventory();
  if (!previous || !Array.isArray(previous.data?.courses)) {
    return fail("There is no completed inventory to add to. Run a full classroom read first.");
  }

  // The classroom list is where a course's own record lives — title, module
  // count, gates. `readCourse` returns the tree inside it and not those.
  const classroom = await readClassroom(communityUrl);
  if (classroom.error) return fail(`Could not read the classroom: ${classroom.error}`);
  const course = classroom.courses.find((c) => c.slug === slug);
  if (!course) {
    return fail(`No course with slug "${slug}" is in the classroom. Its slugs: ${classroom.courses.map((c) => c.slug).join(", ")}`);
  }

  const detail = await readCourse(communityUrl, slug);
  if (detail.error) return fail(`Could not read "${course.title}": ${detail.error}`);
  // ⚠️ AN EMPTY READ IS A FAILURE, NOT A COURSE WITH NO LESSONS. Writing it
  // would replace a good snapshot entry with a husk, and the husks are exactly
  // what `allLessons` was taught to drop — so the course would vanish from the
  // index silently, which is the failure this file exists to fix.
  if (!detail.units.length) return fail(`"${course.title}" read as empty. Nothing was changed.`);

  const others = previous.data.courses.filter((c: any) => String(c?.slug ?? "") !== slug);
  const replaced = others.length !== previous.data.courses.length;
  const merged = {
    ...previous.data,
    courses: [...others, { ...course, units: detail.units, readError: null }],
    readAt: Date.now(),
    toppedUpFrom: previous.id,
    toppedUpCourse: slug,
  };

  const id = startInventory(communityUrl);
  finishInventory(id, merged, null);
  return {
    inventoryId: id,
    courseTitle: course.title,
    slug,
    units: detail.units.length,
    replaced,
    carriedOver: others.length,
    error: null,
  };
}
