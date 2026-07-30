/**
 * Reading the Skool classroom.
 *
 * THE IMPORTANT FINDING, and the reason this file is short: Skool is a Next.js
 * app and ships its entire page state as JSON in a `__NEXT_DATA__` script tag.
 * The classroom page carries the whole course list in
 * `props.pageProps.allCourses` — ids, titles, descriptions, module counts,
 * privacy, ordering. So READING needs no DOM scraping at all: no obfuscated
 * class names, nothing that breaks the next time Skool ships a redesign.
 *
 * That matters more than it sounds. Every brittle thing in the engagement tool
 * is a selector, and every selector that broke was found by it silently
 * matching the wrong element. A JSON payload either parses or it doesn't.
 *
 * Writing is a different story and will need the DOM — but reading is the half
 * that everything else is built on, and it gets to be reliable.
 *
 * NOTHING IS CACHED. The classroom is read live every time, because Jake can
 * edit it in another tab and a stale copy is a copy that is wrong exactly when
 * it matters — at the moment we are about to reorder or rewrite something.
 */
import { withSkoolPage } from "./browser.js";

/** One course as the classroom lists it. */
export interface SkoolCourse {
  id: string;
  /** Skool's URL slug for the course (`name` in its payload). */
  slug: string;
  title: string;
  description: string;
  /** How many modules Skool says it holds. */
  modules: number;
  /** Position in the classroom, as listed. Reordering is a change to this. */
  position: number;
  coverImage: string | null;
  /** Skool's own flags — carried through rather than interpreted. */
  state: number;
  privacy: number;
  minTier: number;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkoolClassroom {
  /** The community's display name, as Skool renders it. */
  community: string | null;
  /** Who the live session belongs to. */
  account: string | null;
  courses: SkoolCourse[];
  /** Epoch ms this was read. There is no cache; this is a freshness stamp. */
  readAt: number;
  error: string | null;
}

const EMPTY = (error: string): SkoolClassroom => ({
  community: null,
  account: null,
  courses: [],
  readAt: Date.now(),
  error,
});

/** `https://www.skool.com/<slug>` → its classroom URL, optionally a later page. */
export function classroomUrl(communityUrl: string, page = 1): string {
  const base = (communityUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const url = base.endsWith("/classroom") ? base : `${base}/classroom`;
  return page > 1 ? `${url}?p=${page}` : url;
}

/**
 * ⚠️ THE CLASSROOM IS PAGINATED AT 30 AND THE PAYLOAD ONLY CARRIES ONE PAGE.
 *
 * `allCourses` is named as if it were all of them. It is not — it is the
 * current page, and a community with 60 courses reads as exactly 30 with no
 * error, no truncation flag, and nothing in the payload to suggest anything is
 * missing. The tell was elsewhere: `currentGroup.metadata.numCourses` said 60.
 *
 * This is the worst failure mode this tool has: a planner working off half a
 * classroom proposes creating courses that already exist, and the write path
 * then duplicates them. So the page walk stops only on an empty page or one
 * that adds nothing new, and the cap is a runaway guard, not a limit anyone is
 * expected to hit.
 */
const MAX_CLASSROOM_PAGES = 40;

/**
 * Read the whole classroom.
 *
 * Returns an `error` rather than throwing, and never a partial success: a
 * course list that silently lost half its entries because a payload shape
 * changed would be worse than no list, since the planner would then propose
 * "new" courses that already exist.
 */
export async function readClassroom(communityUrl: string): Promise<SkoolClassroom> {
  if (!classroomUrl(communityUrl)) return EMPTY("No community URL is set.");

  const courses: SkoolCourse[] = [];
  const seen = new Set<string>();
  let community: string | null = null;
  let account: string | null = null;
  let expected: number | null = null;

  for (let p = 1; p <= MAX_CLASSROOM_PAGES; p++) {
    const page = await readClassroomPage(communityUrl, p);
    if (page.error) {
      // A failure on page 1 is a failure. A failure on a later page would give
      // a silently short classroom, which is the thing this must never do.
      if (p === 1) return EMPTY(page.error);
      return EMPTY(`Read ${courses.length} courses but page ${p} failed: ${page.error}`);
    }
    if (p === 1) {
      community = page.community;
      account = page.account;
      expected = page.expectedCourses;
    }
    const fresh = page.courses.filter((c) => c.id && !seen.has(c.id));
    for (const c of fresh) {
      seen.add(c.id);
      courses.push({ ...c, position: courses.length });
    }
    // Stop on a page that is empty or adds nothing — Skool serves the last page
    // again for an out-of-range `p` rather than an error.
    if (fresh.length === 0) break;
  }

  // Skool tells us how many there should be. If the walk disagrees, say so
  // rather than returning a plausible-looking short list.
  const error =
    expected != null && expected !== courses.length
      ? `Skool reports ${expected} courses but only ${courses.length} could be read.`
      : null;

  return { community, account, courses, readAt: Date.now(), error };
}

interface ClassroomPage {
  community: string | null;
  account: string | null;
  courses: SkoolCourse[];
  /** `numCourses` from the group payload — the check against a short read. */
  expectedCourses: number | null;
  error: string | null;
}

/** One page of the classroom grid. */
async function readClassroomPage(communityUrl: string, pageNo: number): Promise<ClassroomPage> {
  const url = classroomUrl(communityUrl, pageNo);
  const fail = (error: string): ClassroomPage => ({
    community: null,
    account: null,
    courses: [],
    expectedCourses: null,
    error,
  });

  const raw = await withSkoolPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // The payload is server-rendered into the HTML, so it is present at
    // DOMContentLoaded — but Skool client-side navigates, so give a hydrating
    // page a moment before reading rather than racing it.
    await new Promise((r) => setTimeout(r, 2500));

    return await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el = doc?.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return { fail: "no-payload" as const };
      let data: any;
      try {
        data = JSON.parse(el.textContent);
      } catch {
        return { fail: "unparseable" as const };
      }
      const pp = data?.props?.pageProps;
      if (!pp) return { fail: "no-pageprops" as const };
      if (!Array.isArray(pp.allCourses)) return { fail: "no-courses" as const };

      const self = pp.self ?? {};
      const account =
        [self.firstName, self.lastName].filter(Boolean).join(" ").trim() || self.name || self.email || null;

      return {
        fail: null,
        url: (globalThis as any).location?.href ?? null,
        // Skool puts the community's display name in the page title as
        // "Classroom · <name>"; the group object is not always present.
        pageTitle: pp.settings?.pageTitle ?? doc.title ?? null,
        account,
        // How many courses Skool believes the classroom holds, which is the
        // only in-payload signal that `allCourses` is one page of several.
        expectedCourses: Number(pp.currentGroup?.metadata?.numCourses ?? 0) || null,
        courses: pp.allCourses.map((c: any, i: number) => ({
          id: String(c?.id ?? ""),
          slug: String(c?.name ?? ""),
          title: String(c?.metadata?.title ?? ""),
          description: String(c?.metadata?.desc ?? ""),
          modules: Number(c?.metadata?.numModules ?? 0),
          position: i,
          coverImage: c?.metadata?.coverImage ?? null,
          state: Number(c?.state ?? 0),
          privacy: Number(c?.metadata?.privacy ?? 0),
          minTier: Number(c?.metadata?.minTier ?? 0),
          published: c?.public === true,
          createdAt: String(c?.createdAt ?? ""),
          updatedAt: String(c?.updatedAt ?? ""),
        })),
      };
    });
  });

  if (!raw) return fail("The browser could not be reached.");
  if (raw.fail) {
    const why: Record<string, string> = {
      "no-payload": "That page carried no Skool data payload — the session may have been bounced to a login.",
      unparseable: "Skool's data payload did not parse. Its page format may have changed.",
      "no-pageprops": "Skool's data payload had no page props. Its page format may have changed.",
      "no-courses": "Skool's data payload had no course list — check the community URL points at a classroom.",
    };
    return fail(why[raw.fail] ?? "Could not read the classroom.");
  }

  // "Classroom · AI & Automation Mastery" → the community's own name.
  const community = String(raw.pageTitle ?? "").split("·").pop()?.trim() || null;

  return {
    community,
    account: raw.account ?? null,
    courses: raw.courses as SkoolCourse[],
    expectedCourses: raw.expectedCourses ?? null,
    error: null,
  };
}

/**
 * Read ONE course's inner structure.
 *
 * The classroom list gives titles and a module COUNT but no contents, and the
 * contents are what a reorganisation actually moves.
 *
 * ⚠️ THE SHAPE TRAP, found the hard way: every node in this tree is a WRAPPER,
 * not a record — `{ course: {...the actual fields...}, children: [...] }`. The
 * obvious walk reads `node.metadata.title` and gets a correctly-shaped tree of
 * entirely blank units (right count, right depth, no data), which looks like an
 * empty course rather than a parsing bug. Always unwrap `node.course` first.
 *
 * `unitType` is Skool's own word for the kind: "course" at the root, "module"
 * for the things inside it.
 */
export interface SkoolUnit {
  id: string;
  slug: string;
  title: string;
  /** Skool's own kind for this node — "course" at the root, "module" inside. */
  unitType: string;
  /** Depth below the course root: 0 = the course itself. */
  depth: number;
  /** Sibling order at this depth. */
  position: number;
  /** Which unit this hangs off, as Skool records it. */
  parentId: string | null;
  /** A video attached to this unit, when the payload names one. */
  videoUrl: string | null;
  /** Runtime of that video in seconds, when Skool knows it. */
  videoSeconds: number | null;
  /** The written body, flattened out of Skool's rich-text document. */
  content: string;
  /** Length of that body. A unit with a video and 0 chars is a bare video. */
  contentChars: number;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Flatten Skool's rich-text body to plain text.
 *
 * A unit's `desc` is a ProseMirror/TipTap document serialised as JSON behind a
 * `[v2]` marker. This is deliberately tolerant: anything it cannot parse comes
 * back as-is rather than as an empty string, because a lesson whose body silently
 * read as empty would look like a lesson worth deleting.
 */
export function plainTextFromSkoolDoc(raw: string): string {
  const body = String(raw ?? "").replace(/^\[v\d+\]/, "").trim();
  if (!body || !body.startsWith("[") && !body.startsWith("{")) return body;

  let doc: any;
  try {
    doc = JSON.parse(body);
  } catch {
    return body;
  }

  const out: string[] = [];
  // Blocks become their own line; inline text is joined as written. `hardBreak`
  // is a line of its own so step lists don't run together into one sentence.
  const BLOCK = new Set(["paragraph", "heading", "listItem", "blockquote", "codeBlock"]);
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    else if (n.type === "hardBreak") out.push("\n");
    if (Array.isArray(n.content)) {
      n.content.forEach(walk);
      if (BLOCK.has(n.type)) out.push("\n");
    }
  };
  walk(doc);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export interface SkoolCourseDetail {
  courseId: string;
  slug: string;
  title: string;
  units: SkoolUnit[];
  error: string | null;
}

export async function readCourse(communityUrl: string, slug: string): Promise<SkoolCourseDetail> {
  const base = (communityUrl || "").trim().replace(/\/+$/, "").replace(/\/classroom$/, "");
  const url = `${base}/classroom/${slug}`;
  const empty = (error: string): SkoolCourseDetail => ({ courseId: "", slug, title: "", units: [], error });
  if (!base || !slug) return empty("Missing community URL or course slug.");

  const raw = await withSkoolPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2500));
    return await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el = doc?.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return { fail: "no-payload" as const };
      let pp: any;
      try {
        pp = JSON.parse(el.textContent)?.props?.pageProps;
      } catch {
        return { fail: "unparseable" as const };
      }
      if (!pp) return { fail: "no-pageprops" as const };

      const units: any[] = [];
      // Each node is `{ course: <record>, children: [...] }` — unwrap before
      // reading anything. Falling back to the node itself keeps this working if
      // Skool ever flattens the wrapper away.
      const walk = (node: any, depth: number, position: number) => {
        if (!node || units.length > 500) return;
        const rec = node.course ?? node;
        const md = rec.metadata ?? {};
        units.push({
          id: String(rec.id ?? ""),
          slug: String(rec.name ?? ""),
          title: String(md.title ?? ""),
          unitType: String(rec.unitType ?? ""),
          depth,
          position,
          parentId: rec.parentId ? String(rec.parentId) : null,
          videoUrl: md.videoLink || null,
          videoSeconds: Number(md.videoLenMs ?? 0) > 0 ? Math.round(Number(md.videoLenMs) / 1000) : null,
          // Flattened server-side — this stays the raw document.
          rawContent: String(md.desc ?? ""),
          published: rec.public === true,
          createdAt: String(rec.createdAt ?? ""),
          updatedAt: String(rec.updatedAt ?? ""),
        });
        const kids = Array.isArray(node.children) ? node.children : [];
        kids.forEach((c: any, i: number) => walk(c, depth + 1, i));
      };
      const root = pp.course ?? pp.currentCourse ?? null;
      if (!root) return { fail: "no-course" as const, keys: Object.keys(pp).slice(0, 40) };
      walk(root, 0, 0);
      const rootRec = root.course ?? root;
      return {
        fail: null,
        courseId: String(rootRec.id ?? ""),
        title: String(rootRec.metadata?.title ?? ""),
        units,
      };
    });
  });

  if (!raw) return empty("The browser could not be reached.");
  if (raw.fail) return empty(`Could not read that course (${raw.fail}${(raw as any).keys ? `; pageProps keys: ${(raw as any).keys.join(", ")}` : ""}).`);

  const units: SkoolUnit[] = (raw.units as any[]).map(({ rawContent, ...u }) => {
    const content = plainTextFromSkoolDoc(rawContent);
    return { ...u, content, contentChars: content.length } as SkoolUnit;
  });
  return { courseId: raw.courseId, slug, title: raw.title, units, error: null };
}

/** The classroom plus the inside of every course in it. */
export interface SkoolInventory {
  community: string | null;
  account: string | null;
  courses: (SkoolCourse & { units: SkoolUnit[]; readError: string | null })[];
  readAt: number;
  /** Courses whose contents could not be read. Named, never silently dropped. */
  unreadable: string[];
  error: string | null;
}

/**
 * Read the classroom AND the contents of every course in it.
 *
 * Sequential on purpose: there is one browser holding one session, and the
 * engagement tool already proved what a second Chromium against the same
 * profile does (it hangs, then strands a `SingletonLock`). At ~3.5s a course
 * this is minutes, not seconds — it is a snapshot job, not a page load.
 *
 * A course whose contents fail to read is KEPT, with its `readError` set and
 * its title listed in `unreadable`. Dropping it would be the worse failure:
 * a planner working off the remainder would propose creating a course that
 * already exists, and the write path would then duplicate it.
 */
export async function readFullClassroom(
  communityUrl: string,
  onProgress?: (read: number, total: number, title: string) => void,
): Promise<SkoolInventory> {
  const classroom = await readClassroom(communityUrl);
  if (classroom.error) {
    return { community: null, account: null, courses: [], readAt: Date.now(), unreadable: [], error: classroom.error };
  }

  const courses: SkoolInventory["courses"] = [];
  const unreadable: string[] = [];
  for (const [i, course] of classroom.courses.entries()) {
    let detail: SkoolCourseDetail;
    try {
      detail = await readCourse(communityUrl, course.slug);
    } catch (err) {
      detail = { courseId: "", slug: course.slug, title: course.title, units: [], error: String(err) };
    }
    if (detail.error) unreadable.push(course.title || course.slug);
    courses.push({ ...course, units: detail.units, readError: detail.error });
    onProgress?.(i + 1, classroom.courses.length, course.title);
  }

  return {
    community: classroom.community,
    account: classroom.account,
    courses,
    readAt: Date.now(),
    unreadable,
    error: null,
  };
}
