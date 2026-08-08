/**
 * A classroom page for every new upload.
 *
 * Jake, 2026-08-08: "write a classroom page of prompts and step by step tutorial
 * for any new video that was published in the last week — that page should be
 * added to the right class every time."
 *
 * Three things in that sentence are load-bearing and each one shapes the code:
 *
 *   "in the last week" → a WINDOW, not a backlog. An empty ledger must not mean
 *     "the whole back catalogue is unwritten" — the same trap the announcement
 *     ledger has, and it is worse here, because the recovery from announcing
 *     twenty old videos is a scroll and the recovery from writing twenty pages
 *     into the classroom is twenty manual deletions.
 *
 *   "prompts and step by step tutorial" → the page is grounded in the video's
 *     TRANSCRIPT and nothing else will do. A page written from a title is
 *     confident instructions for a tutorial nobody watched, and it is indexed
 *     as classroom knowledge afterwards, so the next drafter quotes it back as
 *     fact. NO TRANSCRIPT, NO PAGE.
 *
 *   "the right class every time" → the course is CHOSEN from the courses that
 *     exist, by slug, and a choice that is not on the list becomes no page
 *     rather than a new course. Same bargain as the video attachment: the model
 *     picks from a list it was shown, and anything else is discarded.
 *
 * ⚠️ THE LEDGER ROW IS WRITTEN WHEN THE PAGE LANDS, NEVER AT DRAFT TIME. A run
 * that drafts and then fails to place the page must be able to try again; a row
 * written early burns the video and it never gets its page. This is the third
 * time that rule has had to be applied in this feature — the pinned subject and
 * the announcement ledger both learned it the same way.
 */
import { db } from "../db/index.js";
import { claudeJSONForPurpose } from "../ai/claude.js";
import { channelVideos, youtubeUrl, type ChannelVideo } from "./channelVideos.js";
import { fetchFreeCaptions, getTranscript, youtubeIdFrom } from "./transcripts.js";
import { transcriptFor } from "./lessons.js";
import { indexedCourses } from "./knowledge.js";
import { openCourse, addPageToOpenCourse } from "./actions.js";

/**
 * How recent an upload has to be to earn a page.
 *
 * Seven days because that is what Jake said, and because the scheduler runs
 * three times a week — every upload gets several chances to be picked up
 * before it ages out, and none of them can reach back into the archive.
 */
const NEW_LESSON_DAYS = 7;

/** Below this a transcript is a caption fragment, not a tutorial. */
const MIN_TRANSCRIPT = 400;

export interface VideoLessonRow {
  videoId: string;
  courseSlug: string;
  pageTitle: string;
  createdAt: number;
}

const rowToLesson = (r: any): VideoLessonRow => ({
  videoId: String(r.video_id),
  courseSlug: String(r.course_slug),
  pageTitle: String(r.page_title),
  createdAt: Number(r.created_at),
});

export function listVideoLessons(limit = 50): VideoLessonRow[] {
  return (
    db
      .prepare("SELECT * FROM skool_video_lessons ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(500, limit))) as any[]
  ).map(rowToLesson);
}

export function videoHasLesson(videoId: string): boolean {
  return !!db.prepare("SELECT 1 FROM skool_video_lessons WHERE video_id = ?").get(videoId);
}

/** Written only once the page is confirmed in the course. */
export function recordVideoLesson(videoId: string, courseSlug: string, pageTitle: string): void {
  db
    .prepare(
      `INSERT OR IGNORE INTO skool_video_lessons (video_id, course_slug, page_title, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(videoId, courseSlug, pageTitle, Date.now());
}

/**
 * The next upload that is recent enough to deserve a page and has not got one.
 *
 * Oldest-first among the eligible, so a week with two uploads writes them in
 * the order they were published rather than newest-first — a member reading
 * the course in order should meet them the way they happened.
 */
export async function nextVideoNeedingLesson(): Promise<ChannelVideo | null> {
  const cutoff = Date.now() - NEW_LESSON_DAYS * 24 * 3600_000;
  const recent = (await channelVideos(25)).filter((v) => v.publishedAt > 0 && v.publishedAt >= cutoff);
  // ⚠️ `publishedAt > 0` MATTERS. `channelVideos` records 0 when YouTube did not
  // say when a video went up, and 0 is not recent — but `0 >= cutoff` is false
  // only by luck of the epoch being in the past. Stated so it cannot be
  // "simplified" into a bug that writes pages for the whole channel.
  const eligible = recent.filter((v) => !videoHasLesson(v.videoId));
  eligible.sort((a, b) => a.publishedAt - b.publishedAt);
  return eligible[0] ?? null;
}

/**
 * What the video actually says.
 *
 * Free captions first, the paid fetch second, and the cache before either.
 * `transcripts.ts` already stores what it buys, so a video whose transcript was
 * fetched for the knowledge index is not bought again here.
 */
export async function transcriptForVideo(videoId: string): Promise<string> {
  const cached = getTranscript(videoId);
  if (cached && cached.status === "ok" && cached.text.length >= MIN_TRANSCRIPT) return cached.text;

  const free = await fetchFreeCaptions(videoId).catch(() => ({ text: null, noCaptions: false }));
  if (free.text && free.text.length >= MIN_TRANSCRIPT) return free.text;

  // Costs money. Last, and only because a page with no transcript is not
  // written at all — so the alternative to spending here is not a cheaper page,
  // it is no page.
  const paid = await transcriptFor(videoId).catch(() => "");
  return paid.length >= MIN_TRANSCRIPT ? paid : "";
}

const COURSE_SYSTEM = `You file one new lesson page into an existing classroom.

You are given a video's title, what it teaches (from its transcript), and the
list of courses that exist. Choose the ONE course this page belongs in.

⚠️ CHOOSE A SLUG FROM THE LIST EXACTLY. Never invent a course, never adjust a
slug, never propose a new one. If no course is a genuine home for this video —
not merely the same broad topic, but the place a member would look for it —
return null. A page filed in the wrong course is worse than a page not filed:
members navigate by course, and it is invisible in the wrong one.

Also choose the page's TITLE: what a member scanning the course contents would
click. Say what they will be able to DO, not what the video is called. No
episode numbers, no "Part 2", no clickbait.

Return JSON only: {"slug": string|null, "pageTitle": string, "why": string}`;

export interface CourseChoice {
  slug: string;
  courseTitle: string;
  pageTitle: string;
  why: string;
}

/**
 * Pick the course, from the courses that exist.
 *
 * ⚠️ THE LIST COMES FROM THE INDEXED CLASSROOM, WHICH IS THE REBUILT COURSES
 * ONLY. That is deliberate and it is the same rule the drafter follows for
 * links: the legacy courses are still full of real teaching, but Jake deletes
 * them by hand and intends to, and a page filed into one is a page that
 * disappears with it.
 */
export async function chooseCourseFor(
  communityUrl: string,
  video: ChannelVideo,
  transcript: string,
): Promise<{ choice: CourseChoice | null; error: string | null }> {
  const { courses } = indexedCourses(communityUrl);
  if (!courses.length) {
    return { choice: null, error: "The classroom index is empty, so there is no course to file a page into." };
  }

  const listing = courses
    .map((c) => `- ${c.slug} — ${c.title} (${c.pages.length} pages: ${c.pages.slice(0, 8).map((p) => p.title).join("; ")})`)
    .join("\n");

  try {
    const raw = await claudeJSONForPurpose({
      tier: "director",
      // The Max window, like every other model call in this feature. See
      // AuthMode in ai/claude.ts — nothing here bills API credits.
      auth: "subscription",
      purpose: "skool-video-lesson-course",
      system: COURSE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `VIDEO: ${video.title}`,
            `URL: ${video.url}`,
            "",
            "COURSES THAT EXIST:",
            listing,
            "",
            "--- what the video teaches (transcript) ---",
            transcript.slice(0, 20_000),
          ].join("\n"),
        },
      ],
    });
    const parsed = JSON.parse(raw) ?? {};
    const slug = String(parsed.slug ?? "").trim();
    if (!slug || slug === "null") {
      return { choice: null, error: `No course was a home for "${video.title}": ${String(parsed.why ?? "no reason given")}` };
    }
    const course = courses.find((c) => c.slug === slug);
    // Not on the list it was given. No repair, no nearest match — the same
    // rule the video attachment follows, for the same reason.
    if (!course) return { choice: null, error: `The chosen course "${slug}" is not one of the classroom's courses.` };

    const pageTitle = String(parsed.pageTitle ?? "").trim() || video.title;
    return {
      choice: { slug, courseTitle: course.title, pageTitle, why: String(parsed.why ?? "") },
      error: null,
    };
  } catch (err) {
    return { choice: null, error: `Choosing a course failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const PAGE_SYSTEM = `You write one page of a paid community's classroom, in the creator's voice.

WHO IS READING. Salespeople and small business owners with no technical
background. They bought outcomes — prompts, templates, automations that work.
Assume zero prior knowledge: no jargon you have not explained on this page, no
step that quietly assumes an account, a paid plan, or a concept they have not
met.

⚠️ THE FIRST LINE OF THE BODY IS "## Here's the [thing]" — name the asset for
what it actually is, and put "(copy this)" in brackets only where copying is the
point. "## Here's the formula (copy this)", "## Here's the checklist",
"## Here's the prompt pack". NEVER "## Copy this first". NEVER a "#" title:
Skool prints the page title above the body, so a "#" line prints it twice.

The asset comes first, complete and copy-paste ready, placeholders in
[brackets], one line on what to swap. A member must be able to land, take the
thing, and leave without reading a word of the tutorial.

Then the journey, in this order, each section a "##":
  1. The promise — what they will be able to DO, concretely.
  2. Why it matters — the cost of not knowing it.
  3. What you need first — tools, accounts, real costs and free-tier limits.
  4. The method — step by step, each step its own "###", in the order a person
     does them, with real menu names and real values.
  5. A worked example — the method run once, end to end.
  6. What usually goes wrong — the two or three mistakes that break it.
  7. Your next move — one specific action.

GROUNDING. Everything you write comes from the transcript below. It is the
video this page accompanies, and the page must teach what the video SHOWS.
Never invent a price, a limit, a menu or a step that is not in it — tell the
member what to check instead. A confident wrong number costs them money.

⚠️ EVERY PROMPT THE VIDEO USES BELONGS ON THIS PAGE, IN FULL, in a fenced code
block. The prompts are the reason a member opens the page. A prompt paraphrased
into prose is a prompt they cannot use.

No preamble about what you are about to cover. No "in conclusion".

Return JSON only: {"body":"the page, in markdown"}`;

/**
 * Write the page.
 *
 * Separate from `writeLesson` in lessons.ts on purpose, though they rhyme: that
 * one raises 136 EXISTING pages to a standard and may be grounded in Jake's own
 * write-up, and its prompt still carries the "## Copy this first" opening he
 * replaced on 2026-08-01. This one has a transcript and nothing else, and has
 * to obey the heading convention he actually asked for.
 */
export async function writeVideoLessonBody(
  video: ChannelVideo,
  courseTitle: string,
  pageTitle: string,
  transcript: string,
): Promise<{ body: string; error: string | null }> {
  try {
    const raw = await claudeJSONForPurpose({
      tier: "director",
      auth: "subscription",
      purpose: "skool-video-lesson",
      system: PAGE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `Course this page goes in: ${courseTitle}`,
            `Page title (do NOT repeat it in the body): ${pageTitle}`,
            `The video: ${video.title} — ${video.url}`,
            "",
            "--- transcript ---",
            transcript.slice(0, 40_000),
          ].join("\n"),
        },
      ],
    });
    const body = String(JSON.parse(raw)?.body ?? "").trim();
    if (body.length < 500) return { body: "", error: "The writer returned too little to publish." };
    return { body, error: null };
  } catch (err) {
    return { body: "", error: `The writer failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface VideoLessonResult {
  wrote: boolean;
  videoId: string | null;
  detail: string;
  /** Every step, so a failure says where it stopped rather than that it did. */
  steps: string[];
}

/**
 * One upload → one classroom page, end to end.
 *
 * ⚠️ WRITES TO THE LIVE CLASSROOM. `dryRun` stops after the body is written and
 * before anything is placed, which is the only way to read what it would say.
 */
export async function writeLessonForNewVideo(
  communityUrl: string,
  opts: { dryRun?: boolean; videoId?: string } = {},
): Promise<VideoLessonResult> {
  const steps: string[] = [];
  const step = (s: string): void => {
    steps.push(s);
  };

  let video: ChannelVideo | null;
  if (opts.videoId) {
    // An explicit id still has to be one of HIS uploads — the catalogue is the
    // gate, exactly as it is for an attachment.
    video = (await channelVideos(25)).find((v) => v.videoId === opts.videoId) ?? null;
    if (!video) return { wrote: false, videoId: opts.videoId, detail: `${opts.videoId} is not one of the channel's uploads.`, steps };
    if (videoHasLesson(video.videoId)) {
      return { wrote: false, videoId: video.videoId, detail: `"${video.title}" already has a classroom page.`, steps };
    }
  } else {
    video = await nextVideoNeedingLesson();
    if (!video) {
      return { wrote: false, videoId: null, detail: `No upload in the last ${NEW_LESSON_DAYS} days is without a page.`, steps };
    }
  }
  step(`Video: ${video.title} (${video.videoId})`);

  const transcript = await transcriptForVideo(video.videoId);
  if (!transcript) {
    // Not recorded in the ledger: a transcript that is not ready today may be
    // ready tomorrow, and the video is still inside its window.
    return {
      wrote: false,
      videoId: video.videoId,
      detail: `No transcript could be read for "${video.title}", so no page was written. A page written from the title alone would be confident instructions for a tutorial nobody watched.`,
      steps,
    };
  }
  step(`Transcript: ${transcript.length} characters`);

  const { choice, error: courseError } = await chooseCourseFor(communityUrl, video, transcript);
  if (!choice) return { wrote: false, videoId: video.videoId, detail: courseError ?? "No course was chosen.", steps };
  step(`Course: ${choice.courseTitle} (/${choice.slug}) — ${choice.why}`);
  step(`Page title: ${choice.pageTitle}`);

  const { body, error: writeError } = await writeVideoLessonBody(video, choice.courseTitle, choice.pageTitle, transcript);
  if (!body) return { wrote: false, videoId: video.videoId, detail: writeError ?? "Nothing was written.", steps };
  step(`Body: ${body.length} characters`);

  if (opts.dryRun) {
    return {
      wrote: false,
      videoId: video.videoId,
      detail: `Dry run — nothing was placed. Would add "${choice.pageTitle}" to ${choice.courseTitle}.`,
      steps: [...steps, `BODY:\n${body}`],
    };
  }

  const opened = await openCourse(communityUrl, choice.slug);
  if (!opened.ok) return { wrote: false, videoId: video.videoId, detail: `The course did not open: ${opened.detail}`, steps };
  step(`Opened /${choice.slug}`);

  // `addPageToOpenCourse` refuses a title that already exists in the course and
  // confirms from Skool's RELOADED payload — a SAVE click landing is not a page
  // existing. It also reports a page that saved without its video, which is a
  // failure mode that has actually happened here.
  const added = await addPageToOpenCourse({
    title: choice.pageTitle,
    videoUrl: youtubeUrl(video.videoId),
    body,
  });
  step(added.detail);
  if (!added.ok) return { wrote: false, videoId: video.videoId, detail: added.detail, steps };

  // Only now. See the note at the top of the file.
  recordVideoLesson(video.videoId, choice.slug, choice.pageTitle);
  return {
    wrote: true,
    videoId: video.videoId,
    detail: `"${choice.pageTitle}" is in ${choice.courseTitle}, built from ${video.title}.`,
    steps,
  };
}

/** Used by the reader that maps a Skool page back to the upload it came from. */
export function lessonVideoIdFrom(url: string | null): string | null {
  return youtubeIdFrom(url);
}
