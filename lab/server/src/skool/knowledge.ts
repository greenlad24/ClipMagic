/**
 * What the engagement agent KNOWS: the classroom, as retrievable text.
 *
 * The rebuild left ~1.3M characters across 130 lessons in 15 courses. That does
 * not fit in a prompt and should not: a post or a reply needs the two or three
 * lessons that actually bear on the question, plus their real URLs so the agent
 * can point a member at one instead of re-explaining it.
 *
 * ⚠️ THE SOURCE IS THE LATEST COMPLETED INVENTORY, NOT THE PLAN. The plan
 * records intent; the inventory records what is live. Every `setplan-*.cjs`
 * replaced its track's modules wholesale, so plan bodies have drifted from the
 * classroom — and Jake edits lessons by hand besides. A citation must point at
 * something a member will actually find when they click it.
 *
 * ⚠️ RETRIEVAL IS RARE-TERM SCORING, NOT EMBEDDINGS. Deliberate: embeddings
 * would mean a paid API call per query on a feature whose whole premise is that
 * it must not spend money, plus an index to keep in step with the classroom.
 * Rare-term overlap is the same technique `absorb2.cjs` used to match unplaced
 * legacy units to their rebuilt homes, where it worked well enough to be useful
 * and — importantly — its misses look like misses.
 */
import { db } from "../db/index.js";
import { courseGates, freeTierCourseSlugs } from "./access.js";
import { transcriptMap, youtubeIdFrom } from "./transcripts.js";

export interface Lesson {
  courseTitle: string;
  courseSlug: string;
  unitId: string;
  title: string;
  text: string;
  videoUrl: string | null;
  /** The video's YouTube id, when one could be parsed from `videoUrl`. */
  videoId: string | null;
  /**
   * What the video actually says, when a transcript has been fetched.
   *
   * A page and its video are not the same content: the write-up summarises and
   * the video is the walkthrough. Without this the agent can say what a lesson
   * covers but not what it shows.
   */
  transcript: string;
  /**
   * When the lesson was last touched, as Skool records it.
   *
   * ⚠️ CARRIED SO THE DRAFTER CAN SEE HOW OLD ITS GROUNDING IS. Jake's rule
   * (2026-08-05): where a video says something outdated, answer with what is
   * true now. A model cannot apply that rule to a source whose age it cannot
   * see — and in this subject a lesson from last year names models that no
   * longer exist.
   */
  updatedAt: string;
  /** The link a member can click. */
  url: string;
  /**
   * Whether the course this lesson sits in is STILL IN THE CLASSROOM.
   *
   * ⚠️ THIS FIELD WAS CALLED `rebuilt` AND MEANT "THE REBUILD WROTE IT". That
   * was the admission test until 2026-08-27; the test is now "Skool still lists
   * it", so the old name would have described the wrong thing while reading as
   * a fact about provenance. Always true for a lesson that comes out of
   * `allLessons` — a course that has gone is not indexed at all — and kept as a
   * field because a retrieval result should be able to state that rather than
   * have its reader assume it.
   */
  live: boolean;
}

export interface Retrieved extends Lesson {
  score: number;
  /** The part of the written page that earned the score. */
  excerpt: string;
  /**
   * The part of the VIDEO that earned it, when the match was in the transcript.
   *
   * Kept apart from `excerpt` rather than concatenated, because the drafter has
   * to be able to tell "the page says this" from "the video says this" — they
   * age differently, and only one of them is a thing Jake wrote down.
   */
  videoExcerpt: string;
}

/** Words too common in this classroom to tell two lessons apart. */
const STOP = new Set(
  ("the a an and or but if then than that this these those is are was were be been being to of in on at by for with " +
    "from as it its it's you your yours i me my we our they them their he she his her not no yes do does did done " +
    "can could should would will won't can't don't doesn't isn't aren't what when where which who whom how why all " +
    "any some most more less least very just only also too so such own same other another each every both few many " +
    "one two three first second next last new now then here there about into over under out up down off again once " +
    "ai prompt prompts lesson course classroom skool video watch here click use using used make makes making get " +
    "gets getting go goes going want need take takes want thing things way ways time times work works working")
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Fold the endings that stop a query matching a title that means the same thing.
 *
 * ⚠️ THIS IS NOT COSMETIC — IT WAS A REAL MISS. "which AI tool should a total
 * beginner start with" scored courses called "AI for Beginners" and "Automation
 * For Beginners" at zero for that word, and returned cold outreach and Facebook
 * scraping instead. Exact-term matching is the right default everywhere else in
 * this project, but a retrieval query is written by a member, not by the person
 * who titled the lesson.
 *
 * Deliberately timid: plurals and the two commonest verb endings, nothing that
 * would collapse two different words into one stem.
 */
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

function terms(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((w) => w.length > 2 && w.length < 30)
    .map(stem)
    // Stop-check AFTER stemming, or the list only catches the form it happens
    // to be written in: "video" is on it and "videos" is not, so the plural
    // would have survived and then stemmed straight back into it.
    .filter((w) => w.length > 2 && !STOP_STEMS.has(w));
}

const STOP_STEMS = new Set(Array.from(STOP, stem));

export function lessonUrl(communityUrl: string, courseSlug: string, unitId: string): string {
  const base = communityUrl.replace(/\/+$/, "");
  return `${base}/classroom/${courseSlug}?md=${unitId}`;
}

interface InventoryRow {
  id: number;
  data_json: string;
}

function normaliseTitle(t: string): string {
  return String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Which live courses are the rebuild's, matched BY LESSON TITLES rather than by
 * course title.
 *
 * ⚠️ MATCHING ON THE COURSE TITLE WOULD MISS TWO OF THE FIFTEEN. Jake renamed
 * "Scrape Facebook and Instagram for Leads and Data" to "Scrape Facebook &
 * Instagram" and "Scrape Websites, Search and Directories for Leads" to "Scrape
 * Leads, Websites And More" by hand — the plan still holds the old names, and
 * memory already records that plan-vs-live must not be matched on title. A
 * course's LESSONS are what the plan actually placed, and a rename does not
 * touch them.
 */
function rebuiltCourseSlugs(courses: any[]): Set<string> {
  const row = db
    .prepare(`SELECT data_json FROM skool_plans WHERE status = 'done' ORDER BY id DESC LIMIT 1`)
    .get() as { data_json: string } | undefined;
  const slugs = new Set<string>();
  if (!row) return slugs;

  let planned: Set<string>;
  try {
    const plan = JSON.parse(row.data_json);
    planned = new Set(
      (plan?.tracks ?? []).flatMap((t: any) => (t?.modules ?? []).map((m: any) => normaliseTitle(m?.title ?? ""))),
    );
  } catch {
    return slugs;
  }
  if (!planned.size) return slugs;

  for (const course of courses) {
    const units = (course?.units ?? []).filter((u: any) => Number(u?.depth ?? 0) > 0);
    if (units.length < 3) continue;
    const hits = units.filter((u: any) => planned.has(normaliseTitle(u?.title ?? ""))).length;
    // Half its lessons named in the plan is not a coincidence at this scale, and
    // the threshold survives both the husks the rebuild left behind and the
    // lessons Jake has since edited or removed by hand.
    if (hits >= 3 && hits / units.length >= 0.5) slugs.add(String(course?.slug ?? ""));
  }
  return slugs;
}

/**
 * Every lesson the agent is allowed to know — THE REBUILT COURSES ONLY.
 *
 * ⚠️⚠️ THE INDEX IS THE WHOLE LIVE CLASSROOM, AND EVERY LESSON IN IT MAY BE
 * LINKED. Jake, 2026-08-27: "extend and have an index of the whole classroom
 * (and be free to refer to them in the posts)."
 *
 * ⚠️ THAT REVERSES AN EARLIER INSTRUCTION, AND THE REVERSAL IS ONLY SAFE
 * BECAUSE THE WORLD CHANGED. On 2026-08-05 he asked for "only the new course
 * and existing course - no old courses", when 60 legacy courses were queued for
 * retirement and teaching from them meant writing posts about lessons that were
 * about to stop existing. The retirement is done: Skool lists 19 courses today.
 * So the exclusion no longer protects anything, and it was costing the agent
 * three live courses it is welcome to teach — *25 Advanced ChatGPT Features*,
 * *The Complete AI Marketing Playbook for 2026* and *Community Resources*.
 *
 * ⚠️ WHAT IS STILL EXCLUDED IS ANYTHING SKOOL NO LONGER SERVES. See
 * `allLessons` — the admission list is the course-gate table, which is
 * rewritten from the live classroom, and NOT the inventory blob, which is a
 * snapshot still holding all 75. `indexedCourses()` makes the result
 * inspectable, and an empty index is reported as an ERROR rather than as
 * "nothing matched" — the two look identical to a caller otherwise, and
 * grounding in nothing is exactly how an agent invents.
 *
 * ⚠️ COURSE ROOTS AND EMPTY UNITS ARE ALSO EXCLUDED, AND THE HUSKS ARE WHY. The
 * rebuild left a scatter of 0-char "New page" units behind, and a retrieval hit
 * on one of those would ground a reply in nothing at all while looking like a
 * citation. Depth > 0 drops the course root (the same depth test as
 * `isCourseRootUnit` — `unitType` is not reliable at the root).
 */
export function allLessons(communityUrl: string): { lessons: Lesson[]; inventoryId: number | null } {
  const row = db
    .prepare(`SELECT id, data_json FROM skool_inventory WHERE status = 'done' ORDER BY id DESC LIMIT 1`)
    .get() as InventoryRow | undefined;
  if (!row) return { lessons: [], inventoryId: null };

  let parsed: any;
  try {
    parsed = JSON.parse(row.data_json);
  } catch {
    return { lessons: [], inventoryId: row.id };
  }

  const courses = parsed?.courses ?? [];
  // ⚠️⚠️ THE WHOLE CLASSROOM, AS SKOOL CURRENTLY LISTS IT. Jake, 2026-08-27:
  // "extend and have an index of the whole classroom (and be free to refer to
  // them in the posts)". This reverses his instruction of 2026-08-05 ("index
  // only the new course and existing course — no old courses"), and the reason
  // it is safe to reverse now is that the retirement actually happened: the
  // classroom is 19 courses today, not 75, so "everything live" and "everything
  // Jake wants taught" have converged.
  //
  // ⚠️⚠️ AND THE LIST COMES FROM THE GATE TABLE, NOT FROM THE INVENTORY BLOB.
  // The inventory is a snapshot and still holds 75 courses, most of which Skool
  // no longer serves — indexing those would put confident links to deleted
  // pages in front of members, which is worse than the narrow index it
  // replaces. `skool_course_gate` is rewritten from the live classroom on every
  // refresh and DELETES the rows of courses that have gone (see access.ts), so
  // it is the only list here that means "still there".
  //
  // Admission is not permission: this puts a course IN the index, and
  // `retrieve`'s `onlyCourseSlugs` is what keeps a paid course out of a free
  // member's answer.
  const liveSlugs = new Set(courseGates().map((g) => g.slug).filter(Boolean));
  // ⚠️ THE OLD RULE IS THE FALLBACK, NOT A TIE-BREAK. With no gates ever read
  // there is no way to tell a live course from a deleted one, and the safe
  // answer is the narrow index that was correct for three weeks — never "admit
  // all 75", which is exactly the broken-link failure above.
  const indexed = liveSlugs.size
    ? liveSlugs
    : new Set([...rebuiltCourseSlugs(courses), ...freeTierCourseSlugs()]);
  // One read for the whole index rather than one per lesson.
  const transcripts = transcriptMap();

  const lessons: Lesson[] = [];
  for (const course of courses) {
    // The whole filter, in one line: a course that is neither the rebuild's nor
    // free to everyone is not the agent's to teach from.
    if (!indexed.has(String(course?.slug ?? ""))) continue;
    for (const unit of course?.units ?? []) {
      if (Number(unit?.depth ?? 0) <= 0) continue;
      const text = String(unit?.content ?? "").trim();
      const videoUrl = unit?.videoUrl ? String(unit.videoUrl) : null;
      const videoId = youtubeIdFrom(videoUrl);
      const transcript = videoId ? (transcripts.get(videoId)?.text ?? "") : "";
      // ⚠️ A PAGE WITH ALMOST NO TEXT BUT A REAL TRANSCRIPT IS STILL A LESSON.
      // Dropping on body length alone would discard the bare-video pages, which
      // are precisely the ones where the video IS the lesson.
      if (text.length < 200 && transcript.length < 200) continue;
      lessons.push({
        courseTitle: String(course?.title ?? ""),
        courseSlug: String(course?.slug ?? ""),
        unitId: String(unit?.id ?? ""),
        title: String(unit?.title ?? "").trim(),
        text,
        videoUrl,
        videoId,
        transcript,
        updatedAt: String(unit?.updatedAt ?? ""),
        url: lessonUrl(communityUrl, String(course?.slug ?? ""), String(unit?.id ?? "")),
        live: indexed.has(String(course?.slug ?? "")),
      });
    }
  }
  return { lessons, inventoryId: row.id };
}

/**
 * The lessons most likely to bear on `query`.
 *
 * Scoring is inverse-document-frequency over the classroom itself: a term that
 * appears in three lessons is worth far more than one that appears in ninety.
 * A title hit counts double — a lesson called "MCP Explained in Plain English"
 * is about MCP in a way a lesson that merely mentions it is not.
 */
export function retrieve(
  communityUrl: string,
  query: string,
  limit = 5,
  opts: {
    /**
     * Restrict the search to these course slugs — the freemium gate.
     *
     * ⚠️⚠️ A FILTER ON WHAT IS SEARCHED, NOT ON WHAT IS SHOWN, AND THAT IS THE
     * SAFETY. The drafter may only cite a URL it was given (`citedFrom`), so a
     * lesson that never enters this list cannot reach a member — no prompt
     * sentence has to hold. Telling the model "don't mention the paid courses"
     * while handing it their contents is the version of this that fails
     * quietly, once, in front of a member who cannot open the link.
     *
     * `undefined`/`null` = no restriction (a paying member). `[]` = nothing
     * matches, which is the correct answer for a free member whose course gates
     * have never been read.
     */
    onlyCourseSlugs?: string[] | null;
  } = {},
): { hits: Retrieved[]; searched: number; inventoryId: number | null; error: string | null } {
  const { lessons: all, inventoryId } = allLessons(communityUrl);
  const allow = opts.onlyCourseSlugs;
  const lessons = allow ? all.filter((l) => allow.includes(l.courseSlug)) : all;
  // ⚠️ THE EMPTINESS TEST BELOW MUST STILL SEE THE WHOLE INDEX. An empty index
  // is a broken tool and says so; an empty ALLOWED set is a member with little
  // to be pointed at, which is a normal answer and not an error.
  if (allow && all.length && !lessons.length) {
    return { hits: [], searched: 0, inventoryId, error: null };
  }
  // ⚠️ AN EMPTY INDEX IS AN ERROR, NOT AN EMPTY RESULT. Since the index is now
  // filtered to the rebuilt courses, a failure to identify them returns exactly
  // what "your question matched nothing" returns — and a drafter told "no
  // lessons matched" will write from its own general knowledge and sound
  // completely confident doing it.
  if (!lessons.length) {
    return {
      hits: [],
      searched: 0,
      inventoryId,
      error:
        "The classroom index is EMPTY — no rebuilt course could be identified in the latest inventory. " +
        "Nothing should be drafted from this: check the inventory and plan rows before using any output.",
    };
  }

  const wanted = Array.from(new Set(terms(query)));
  if (!wanted.length) return { hits: [], searched: lessons.length, inventoryId, error: null };

  // Document frequency per wanted term, counted once per lesson.
  // The transcript is part of what a lesson KNOWS, so it is part of what a
  // lesson can be found by. A question about something demonstrated on screen
  // and never written down should still land on the right page.
  const lessonTerms = lessons.map((l) => new Set(terms(`${l.courseTitle} ${l.title} ${l.text} ${l.transcript}`)));
  // ⚠️ THE COURSE TITLE COUNTS AS A TITLE TERM, AND LEAVING IT OUT WAS A REAL
  // MISS: "which AI tool should a total beginner start with" returned cold
  // outreach and Facebook scraping, and never surfaced the course literally
  // called "AI for Beginners". The words a lesson is FILED under say as much
  // about its subject as the words in its own name.
  const titleTerms = lessons.map((l) => new Set(terms(`${l.courseTitle} ${l.title}`)));
  const dfOf = (t: string) => lessonTerms.reduce((n, set) => n + (set.has(t) ? 1 : 0), 0);
  const df = new Map(wanted.map((t) => [t, dfOf(t)]));

  const scored = lessons.map((lesson, i) => {
    let score = 0;
    const matched: string[] = [];
    for (const t of wanted) {
      const n = df.get(t) ?? 0;
      if (!n) continue; // a term nothing has says nothing about anything
      const weight = Math.log(1 + lessons.length / n);
      if (lessonTerms[i].has(t)) {
        score += weight;
        matched.push(t);
      }
      // A title hit is worth three body hits. A lesson NAMED for the subject is
      // about it; a lesson that mentions it once in passing is not, and body
      // frequency alone cannot tell those apart in a classroom where every
      // lesson mentions AI.
      if (titleTerms[i].has(t)) score += weight * 2;
    }
    // ⚠️ THE 1.25× TILT TOWARDS REBUILT COURSES IS GONE, AND ITS ABSENCE IS THE
    // CHANGE. It existed to rank the rebuild's lessons above the legacy ones
    // when both were in the index. Every lesson in the index is now a live
    // classroom page, so the tilt applied to all of them equally — which is not
    // a tie-break, it is a multiplier on every score and changes no ordering at
    // all. Leaving it would have been a rule that looks like it does something.
    return { lesson, score, matched };
  });

  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ lesson, score, matched }) => ({
      ...lesson,
      score,
      excerpt: excerptAround(lesson.text, matched),
      // Only when the transcript actually carries the matched terms — otherwise
      // this is 1,400 characters of unrelated talking in every prompt.
      videoExcerpt: lesson.transcript && matched.some((t) => lesson.transcript.toLowerCase().includes(t))
        ? excerptAround(lesson.transcript, matched)
        : "",
    }));

  return { hits, searched: lessons.length, inventoryId, error: null };
}

/* ────────────────────────── past posts ────────────────────────── */

export interface RetrievedPost {
  id: string;
  slug: string;
  title: string;
  url: string;
  /** The matched part of the body, not the whole post. */
  excerpt: string;
  createdAt: string;
  score: number;
}

/**
 * The community posts most likely to bear on `query`.
 *
 * ⚠️ THIS EXISTS FOR THE FREE HALF OF A REPLY. Jake, 2026-08-27: a free member
 * may be pointed at "a page from the first class or a past post in the
 * community". One free course is not much to answer 73 members' questions with,
 * and the feed is 243 posts of real answers that every member — free or paying —
 * can already open. Measured 2026-08-27: a post's payload carries NO `minTier`
 * and no `minAccessLevel`, and the landing page sells "full access to the AI
 * beginner community", so the feed genuinely is open to everyone. If Skool ever
 * gates a post, this function is where that gate has to be read.
 *
 * Takes the posts as an argument rather than reading the feed itself: the feed
 * is a browser navigation per page, and a sweep answering four members must not
 * pay for it four times.
 *
 * Scoring is the same rare-term overlap `retrieve` uses, against the posts in
 * hand rather than the classroom — deliberately not shared code, because a
 * post's "title" is a headline and its weight against a lesson title is not a
 * thing either corpus can tell us.
 */
export function retrievePosts(
  posts: { id: string; slug: string; title: string; body: string; createdAt: string }[],
  query: string,
  communityUrl: string,
  limit = 3,
): RetrievedPost[] {
  const wanted = Array.from(new Set(terms(query)));
  if (!wanted.length || !posts.length) return [];

  const postTerms = posts.map((p) => new Set(terms(`${p.title} ${p.body}`)));
  const titleTerms = posts.map((p) => new Set(terms(p.title)));
  const base = communityUrl.replace(/\/+$/, "");

  const scored = posts.map((post, i) => {
    let score = 0;
    const matched: string[] = [];
    for (const t of wanted) {
      const n = postTerms.reduce((acc, set) => acc + (set.has(t) ? 1 : 0), 0);
      if (!n) continue;
      const weight = Math.log(1 + posts.length / n);
      if (postTerms[i].has(t)) {
        score += weight;
        matched.push(t);
      }
      if (titleTerms[i].has(t)) score += weight * 2;
    }
    return { post, score, matched };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ post, score, matched }) => ({
      id: post.id,
      slug: post.slug,
      title: post.title,
      // ⚠️ BUILT FROM THE SLUG, WHICH IS THE ONLY LINKABLE THING A POST HAS.
      // A post with no slug gets no URL rather than a guessed one — the same
      // rule the lesson citations follow, and `citedFrom` drops what it cannot
      // match anyway.
      url: post.slug ? `${base}/${post.slug}` : "",
      excerpt: excerptAround(post.body, matched),
      createdAt: post.createdAt,
      score,
    }));
}

/**
 * What is actually in the index, course by course and page by page.
 *
 * ⚠️ THIS EXISTS BECAUSE THE INDEX IS NOW A FILTER, and a filter that silently
 * drops a course is indistinguishable from a course that has no lessons. The
 * only defence this project has ever found against a plausible-looking short
 * answer is being able to count it — the classroom read as 30 of 60 courses
 * for days because nothing printed the number next to the expected one.
 */
export function indexedCourses(
  communityUrl: string,
): { courses: { title: string; slug: string; pages: { title: string; url: string; chars: number }[] }[]; totalPages: number } {
  const { lessons } = allLessons(communityUrl);
  const byCourse = new Map<string, { title: string; slug: string; pages: { title: string; url: string; chars: number }[] }>();
  for (const l of lessons) {
    const entry = byCourse.get(l.courseSlug) ?? { title: l.courseTitle, slug: l.courseSlug, pages: [] };
    entry.pages.push({ title: l.title, url: l.url, chars: l.text.length });
    byCourse.set(l.courseSlug, entry);
  }
  return { courses: Array.from(byCourse.values()), totalPages: lessons.length };
}

/**
 * The passage where the matched terms actually cluster.
 *
 * Grounding a draft in the opening 2,000 characters of a 12,000-character
 * lesson would quote the introduction of every lesson regardless of what was
 * asked — which reads like grounding and is not.
 */
function excerptAround(text: string, matched: string[], width = 1400): string {
  if (!matched.length || text.length <= width) return text.slice(0, width);
  const hay = text.toLowerCase();
  const positions = matched.map((t) => hay.indexOf(t)).filter((i) => i >= 0);
  if (!positions.length) return text.slice(0, width);
  positions.sort((a, b) => a - b);
  const centre = positions[Math.floor(positions.length / 2)];
  const start = Math.max(0, centre - Math.floor(width / 2));
  const prefix = start > 0 ? "…" : "";
  const suffix = start + width < text.length ? "…" : "";
  return prefix + text.slice(start, start + width) + suffix;
}

/**
 * A compact map of the whole classroom — every course and lesson title.
 *
 * This is what lets the agent choose a SUBJECT for a weekly post rather than
 * only answer one: it can see the shape of what is taught without any lesson
 * body. ~130 titles is a few thousand characters, which is affordable in every
 * call, unlike the 1.3M behind them.
 */
export function classroomOutline(communityUrl: string): { outline: string; courses: number; lessons: number } {
  const { lessons } = allLessons(communityUrl);
  const byCourse = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const list = byCourse.get(l.courseTitle) ?? [];
    list.push(l);
    byCourse.set(l.courseTitle, list);
  }
  const lines: string[] = [];
  for (const [course, list] of byCourse) {
    lines.push(`${course}`);
    for (const l of list) lines.push(`  - ${l.title}`);
  }
  return { outline: lines.join("\n"), courses: byCourse.size, lessons: lessons.length };
}
