/**
 * Writing to the community: publishing a post.
 *
 * The composer was mapped by probing the live page (2026-08-05):
 *
 *   feed → "Write something" (a plain div, no role, text runs together as
 *   "Write somethingGo Live") → "Title" input, found by PLACEHOLDER because its
 *   testid is the useless `input-component` every Skool input carries → a
 *   ProseMirror body, so the lesson writer's paste path applies unchanged →
 *   "Select a category" → the category → "Post".
 *
 * ⚠️⚠️ THE READ-BACK IS THE POINT, NOT THE CLICKS. The classroom rebuild's most
 * expensive lesson was that `addPage` reported success it had not earned: four
 * pages logged "is in the course" and two of them were not there, and a later
 * bug retitled an existing lesson and appended underneath it while reporting OK
 * every time. A click sequence completing is not a post existing. So this
 * finishes by re-reading the FEED and finding the post by title, and reports
 * failure when it cannot — even though every click "worked".
 */
import { clickButton, clickVisibleText, fillField, appendBody } from "./actions.js";
import { withSkoolPage } from "./browser.js";
import { communityFeedUrl, readFeed, type SkoolPost } from "./community.js";

export interface PostResult {
  ok: boolean;
  detail: string;
  /** The post as read back from Skool, when it was found. */
  post: SkoolPost | null;
}

const OK = (detail: string, post: SkoolPost | null = null): PostResult => ({ ok: true, detail, post });
const FAIL = (detail: string): PostResult => ({ ok: false, detail, post: null });

const settle = (ms = 800): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Is the composer open? Its Title field is the tell. */
async function composerIsOpen(): Promise<boolean> {
  const found = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      return (Array.from(doc.querySelectorAll("input")) as any[]).some((el) => {
        const ph = (el.getAttribute("placeholder") || "").trim().toLowerCase();
        const r = el.getBoundingClientRect();
        return ph === "title" && r.width > 0 && r.height > 0;
      });
    }),
  );
  return !!found;
}

/**
 * How much text the composer body already holds.
 *
 * ⚠️ THE SAME GUARD AS `bodyMustBeEmpty` IN THE LESSON WRITER, AND FOR THE SAME
 * REASON. That one fired four times in ten pages and each fire was a lesson
 * saved from being overwritten. Skool keeps unsent drafts in the composer, so
 * "the composer opened" does not mean "the composer is blank" — and appending a
 * post underneath somebody's half-written draft publishes both.
 */
async function composerBodyChars(): Promise<number> {
  const n = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (!editors.length) return -1;
      editors.sort((a: any, b: any) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      return String(editors[0].textContent || "").trim().length;
    }),
  );
  return typeof n === "number" ? n : -1;
}

/** Close the composer without publishing. Used when a guard refuses. */
async function cancelComposer(): Promise<void> {
  await clickButton("Cancel").catch(() => undefined);
  await settle(500);
}

export interface CreatePostInput {
  communityUrl: string;
  title: string;
  body: string;
  /** Must be one of the community's own categories; Skool will not invent one. */
  category: string | null;
}

export async function createPost(input: CreatePostInput): Promise<PostResult> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) return FAIL("A post needs a title.");
  if (body.length < 50) return FAIL(`The body is only ${body.length} characters — refusing to publish that.`);

  const log: string[] = [];
  const step = (s: string): void => {
    log.push(s);
  };

  // ⚠️ REFUSE A DUPLICATE BEFORE OPENING ANYTHING. The agent posts on a timer
  // and a retry after an ambiguous failure is the normal case, so "did this
  // already go out?" has to be answered from Skool, not from our own log.
  const before = await readFeed(input.communityUrl, 1);
  if (before.error) return FAIL(`Could not read the feed first, so nothing was posted: ${before.error}`);
  if (before.posts.some((p) => p.title.trim() === title)) {
    return FAIL(`A post called "${title}" is already on the feed. Not posting it twice.`);
  }
  step(`Feed read: ${before.posts.length} post(s), no duplicate title`);

  await withSkoolPage(async (page) => {
    await page.goto(communityFeedUrl(input.communityUrl, 1), { waitUntil: "domcontentloaded", timeout: 60_000 });
  });
  await settle(2500);

  const opened = await clickVisibleText("Write something", { exact: false });
  if (!opened.ok) return FAIL(`${log.join(" → ")} → Could not open the composer: ${opened.detail}`);
  await settle(1200);
  if (!(await composerIsOpen())) {
    return FAIL(`${log.join(" → ")} → Clicked "Write something" but no Title field appeared, so the composer is not open.`);
  }
  step("Composer open");

  const already = await composerBodyChars();
  if (already > 40) {
    await cancelComposer();
    return FAIL(
      `${log.join(" → ")} → The composer already holds ${already} characters — that is an unsent draft, not a blank post. ` +
        `Refusing to write: continuing would publish it with this post appended underneath.`,
    );
  }

  const titled = await fillField("Title", title);
  if (!titled.ok) return FAIL(`${log.join(" → ")} → ${titled.detail}`);
  step("Title filled");

  // The composer body is a ProseMirror document, same as a lesson's, so this is
  // the proven paste path: a real `paste` event carrying a DataTransfer. Typing
  // is its fallback and puts raw markdown characters on the page.
  const written = await appendBody(body);
  if (!written.ok) return FAIL(`${log.join(" → ")} → ${written.detail}`);
  step("Body pasted");

  if (input.category) {
    const opensCategory = await clickButton("Select a category");
    if (opensCategory.ok) {
      await settle(600);
      const chose = await clickVisibleText(input.category, { exact: true });
      // ⚠️ NOT FATAL, AND SAID OUT LOUD. Skool will publish without a category;
      // an uncategorised post is untidy, a lost post is not recoverable.
      step(chose.ok ? `Category "${input.category}"` : `Category "${input.category}" NOT set: ${chose.detail}`);
      await settle(500);
    } else {
      step(`Category picker did not open: ${opensCategory.detail}`);
    }
  }

  const posted = await clickButton("Post");
  if (!posted.ok) return FAIL(`${log.join(" → ")} → ${posted.detail}`);
  step('Clicked "Post"');
  await settle(4000);

  // ⚠️ THE ONLY EVIDENCE THAT COUNTS. Read the feed back and find it by title.
  const after = await readFeed(input.communityUrl, 1);
  if (after.error) {
    return FAIL(`${log.join(" → ")} → Posted, but the feed could not be re-read, so the post is UNCONFIRMED: ${after.error}`);
  }
  const landed = after.posts.find((p) => p.title.trim() === title);
  if (!landed) {
    return FAIL(
      `${log.join(" → ")} → Every click worked and "${title}" is NOT on the feed afterwards. ` +
        `Treat this as not posted — but check the community before re-running, because a post that landed late would duplicate.`,
    );
  }
  if (landed.body.trim().length < body.length * 0.6) {
    return FAIL(
      `${log.join(" → ")} → "${title}" is on the feed but reads ${landed.body.trim().length} characters ` +
        `against ${body.length} written. The body did not land in full.`,
    );
  }

  return OK(
    `${log.join(" → ")} → Read back: "${landed.title}" at /${landed.slug}, ${landed.body.trim().length} characters.`,
    landed,
  );
}
