/**
 * Turning a plan into the operations that rebuild the classroom.
 *
 * This file does not touch Skool. It takes the spine and the inventory it was
 * planned against and produces an explicit, ordered, inspectable list of
 * writes — so the thing that gets approved is the thing that runs, and so a
 * run that dies halfway can be resumed rather than restarted.
 *
 * ⚠️ CREATE EVERYTHING, VERIFY IT, AND ONLY THEN DELETE ANYTHING. The whole
 * list is phased in that order and the executor will not begin the delete phase
 * until the pages it depends on have been read back from Skool. A rebuild that
 * interleaves them has a window where a video exists in neither the old course
 * nor the new one, and there is no undo in a Skool classroom.
 *
 * ⚠️ AN OLD COURSE IS DELETABLE ONLY WHEN EVERY UNIT OF IT THAT CARRIED
 * CONTENT IS PLACED SOMEWHERE IN THE NEW SPINE. Not "most of them" and not
 * "the ones we recognised": all of them, matched by unit id. A course holding
 * one lesson the planner declined is KEPT, with the reason attached. This is
 * the same rule as never dropping an unreadable course from the inventory —
 * the cost of keeping something twice is a tidy-up, and the cost of deleting
 * something once is that it is gone.
 *
 * ⚠️ MEMBER PROGRESS ON THE OLD COURSES DOES NOT SURVIVE. Skool has no way to
 * demote a course into a module, so a single-video course becomes a page in a
 * spine course and the original is deleted. Jake accepted this explicitly when
 * he chose to rebuild in place; it is restated here because it is the one
 * consequence of this file that cannot be undone by running something again.
 */
import { isCourseRootUnit, unitCarriesContent, type SkoolInventory } from "./classroom.js";

/** One write against the live classroom. */
export type RebuildOp =
  | {
      kind: "createCourse";
      id: string;
      phase: "create";
      trackTitle: string;
      description: string;
    }
  | {
      kind: "addPage";
      id: string;
      phase: "pages";
      /** The course this page belongs in, by title — resolved live, never by index. */
      trackTitle: string;
      /** Where it sits in the course, so a resumed run can tell what is missing. */
      position: number;
      title: string;
      videoUrl: string | null;
      body: string;
      /** What the page was built from, carried through for the run log. */
      source: "existing" | "new video" | "authored";
    }
  | {
      kind: "deleteCourse";
      id: string;
      phase: "delete";
      courseId: string;
      title: string;
      /** Which new pages now carry what this course held. */
      absorbedInto: string[];
    };

export interface RebuildPlan {
  ops: RebuildOp[];
  /**
   * Old courses that will NOT be deleted, each with the reason.
   *
   * A first-class part of the output rather than a footnote: after a rebuild
   * the classroom will still contain these, and an operator who expected a
   * clean sweep needs to know that before running it, not after.
   */
  kept: { title: string; courseId: string; why: string }[];
  /** Pages the plan asked for that cannot be written, and why. */
  refused: { title: string; why: string }[];
  counts: {
    coursesToCreate: number;
    pagesToWrite: number;
    coursesToDelete: number;
    coursesKept: number;
  };
  createdAt: number;
}

/** A page needs something to say. A title with nothing behind it is the disease. */
const MIN_BODY = 200;

function opId(kind: string, ...parts: (string | number)[]): string {
  return [kind, ...parts.map((p) => String(p).replace(/\s+/g, "-").slice(0, 40))].join(":").toLowerCase();
}

/**
 * Build the operation list.
 *
 * `existingTitles` is the set of course titles ALREADY in the live classroom.
 * A track whose course exists is not created again — that is how a resumed run
 * avoids ending with two courses of the same name, which is worse than either
 * failing or succeeding because a member sees both.
 */
export function buildRebuild(
  plan: { tracks: { title: string; promise: string; modules: any[] }[] },
  inventory: SkoolInventory,
  existingTitles: string[] = [],
): RebuildPlan {
  const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const live = new Set(existingTitles.map(norm));

  const ops: RebuildOp[] = [];
  const refused: { title: string; why: string }[] = [];

  /** Every unit id the new spine places, so absorption can be checked exactly. */
  const placedUnitIds = new Set<string>();

  for (const track of plan.tracks ?? []) {
    if (!live.has(norm(track.title))) {
      ops.push({
        kind: "createCourse",
        id: opId("course", track.title),
        phase: "create",
        trackTitle: track.title,
        description: track.promise ?? "",
      });
    }

    let position = 0;
    for (const module of track.modules ?? []) {
      const item = module.item ?? {};
      const body = String(module.lesson?.body ?? item.body ?? "").trim();
      const videoUrl = item.videoId ? `https://youtu.be/${item.videoId}` : null;
      const title = module.title || item.title || "";

      // ⚠️ NEVER CREATE AN EMPTY PAGE. Sixty of this classroom's 123 modules
      // are a title with no video and no text, and that is the single biggest
      // thing wrong with it. Writing another one — because a lesson failed to
      // write, or a transcript could not be fetched — would reproduce the
      // exact defect this rebuild exists to fix.
      if (!videoUrl && body.length < MIN_BODY) {
        refused.push({
          title: `${track.title} → ${title}`,
          why: "It has no video and no written body, so creating it would add another empty page.",
        });
        continue;
      }

      if (item.unitId) placedUnitIds.add(String(item.unitId));

      ops.push({
        kind: "addPage",
        id: opId("page", track.title, position),
        phase: "pages",
        trackTitle: track.title,
        position,
        title,
        videoUrl,
        body,
        source: item.kind === "video" ? "new video" : item.kind === "written" ? "authored" : "existing",
      });
      position++;
    }
  }

  /* ── Which old courses can go ───────────────────────────────────────────
     A course is absorbed when every unit of it that carried anything is
     placed in the new spine. Empty modules do not count towards this: there
     was never anything in them to carry over, and requiring them to be placed
     would keep all sixty courses forever.                                   */

  const deletes: RebuildOp[] = [];
  const kept: { title: string; courseId: string; why: string }[] = [];

  for (const course of inventory.courses ?? []) {
    if (course.readError) {
      kept.push({
        title: course.title,
        courseId: course.id,
        why: "This course could not be read, so there is no way to know what deleting it would destroy.",
      });
      continue;
    }

    // ⚠️ A COURSE WITH AN UNREAD UNIT IS NOT A CANDIDATE FOR ANYTHING. Skool
    // ships a unit's body only when its own URL selected it, so a unit that was
    // never visited reads back blank — and this loop's entire job is deciding
    // what is safe to destroy on the strength of "there was nothing in it".
    // That reading was wrong once already, for 60 modules at a time.
    const unread = (course.units ?? []).filter((u) => !isCourseRootUnit(u) && u.contentRead === false);
    if (unread.length > 0) {
      kept.push({
        title: course.title,
        courseId: course.id,
        why:
          `${unread.length} of its lessons were never read (${unread.slice(0, 3).map((u) => u.title).join(", ")}` +
          `${unread.length > 3 ? ", …" : ""}), so "empty" here would mean "not looked at".`,
      });
      continue;
    }

    // The course ROOT is excluded before anything else: it always "carries
    // content" (its card blurb) and the planner never places it, so counting it
    // makes every course look unabsorbed. See isCourseRootUnit.
    const carrying = (course.units ?? []).filter((u) => !isCourseRootUnit(u) && unitCarriesContent(u));
    if (carrying.length === 0) {
      // An entirely empty course. Nothing to absorb, so nothing to check —
      // but also nothing lost, and leaving it standing leaves the classroom
      // exactly as hollow as it was.
      deletes.push({
        kind: "deleteCourse",
        id: opId("delete", course.id),
        phase: "delete",
        courseId: course.id,
        title: course.title,
        absorbedInto: [],
      });
      continue;
    }

    const missing = carrying.filter((u) => !placedUnitIds.has(u.id));
    if (missing.length > 0) {
      kept.push({
        title: course.title,
        courseId: course.id,
        why: `${missing.length} of its ${carrying.length} lessons are not in the new spine (${missing
          .slice(0, 3)
          .map((u) => u.title)
          .join(", ")}${missing.length > 3 ? ", …" : ""}).`,
      });
      continue;
    }

    const absorbedInto = new Set<string>();
    for (const track of plan.tracks ?? []) {
      for (const module of track.modules ?? []) {
        if (module.item?.courseId === course.id) absorbedInto.add(track.title);
      }
    }
    deletes.push({
      kind: "deleteCourse",
      id: opId("delete", course.id),
      phase: "delete",
      courseId: course.id,
      title: course.title,
      absorbedInto: [...absorbedInto],
    });
  }

  ops.push(...deletes);

  return {
    ops,
    kept,
    refused,
    counts: {
      coursesToCreate: ops.filter((o) => o.kind === "createCourse").length,
      pagesToWrite: ops.filter((o) => o.kind === "addPage").length,
      coursesToDelete: deletes.length,
      coursesKept: kept.length,
    },
    createdAt: Date.now(),
  };
}
