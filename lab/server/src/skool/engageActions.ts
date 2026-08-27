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
 * ⚠️ THAT MAP IS NOW THE FALLBACK. When the operator has taught a `createPost`
 * action in the teach console, its recording is replayed instead — see
 * `composeTaught`. The mapped path stays because it is what runs before anything
 * has been taught, and because it is the only description of the composer that
 * survives someone deleting the recipe.
 *
 * ⚠️⚠️ THE READ-BACK IS THE POINT, NOT THE CLICKS. The classroom rebuild's most
 * expensive lesson was that `addPage` reported success it had not earned: four
 * pages logged "is in the course" and two of them were not there, and a later
 * bug retitled an existing lesson and appended underneath it while reporting OK
 * every time. A click sequence completing is not a post existing. So this
 * finishes by re-reading the FEED and finding the post by title, and reports
 * failure when it cannot — even though every click "worked".
 */
import { clickButton, clickVisibleText, fillField, appendBody, type ActionResult } from "./actions.js";
import { withSkoolPage } from "./browser.js";
import { communityFeedUrl, readFeed, type SkoolPost } from "./community.js";
import { readComments } from "./comments.js";
import { getRecipe, type RecipeStep } from "./recipes.js";
import { isSemanticClass, placeholdersIn, replaySteps, type ReplayResult } from "./replay.js";
import { confirmEmailDialog, setEmailNotify } from "./emailNotify.js";
import { attachToComposer } from "./attachments.js";
import { typeMentions } from "./mentions.js";
import type { SkoolMember } from "./members.js";
import type { Attachment } from "./engageGen.js";

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

/**
 * The taught version of the composer flow, if the operator has recorded one.
 *
 * ⚠️⚠️ A RECORDING BEATS A GUESS AT EXACTLY ONE THING, AND IT IS THE THING THAT
 * KEPT FAILING. The built-in path finds the submit button by looking for a
 * clickable element whose text is "Post" — and every step below "succeeds"
 * merely by finding SOMETHING with that label. A recorded descriptor names the
 * element itself, so a page with several "Post"s on it stops being ambiguous.
 *
 * The guards are NOT part of the recording and run either way. A recording can
 * only carry what the operator did; it cannot carry "and refuse if this post is
 * already on the feed", which is the part that stops a retry double-posting.
 */
const POST_RECIPE = "createPost";

/** How much of the body must survive for the post to count as landed. */
const BODY_LANDED_RATIO = 0.6;

export interface CreatePostInput {
  communityUrl: string;
  title: string;
  body: string;
  /** Must be one of the community's own categories; Skool will not invent one. */
  category: string | null;
  /**
   * Turn on "Send email to all members" before publishing.
   *
   * ⚠️ FAILING TO SET THIS DOES NOT BLOCK THE POST, AND THAT IS THE DELIBERATE
   * DIRECTION. If Skool renames or moves the switch, the choice is between a
   * post that goes out without an email and no post at all — and the wrong
   * direction to fail in is the one that emails 65 people by accident. So a
   * switch that cannot be read is reported loudly in the step log and on the
   * slot, and the post still goes out.
   */
  emailNotify?: boolean;
  /**
   * A video or poll to put in the composer before submitting.
   *
   * Same failure direction as `emailNotify`: an attachment that will not go in
   * is logged and the post still publishes. The words are the post.
   */
  attachment?: Attachment | null;
  /**
   * Members to @mention at the very start of the body, as real mention chips.
   *
   * ⚠️ THESE CANNOT TRAVEL IN `body`, WHICH IS WHY THEY ARE A SEPARATE FIELD. A
   * post body is delivered as ONE PASTE, and a pasted "@Name" is grey text that
   * links to nobody and notifies nobody. A mention has to be TYPED so Skool's
   * autocomplete can turn it into a node — see `typeMentions`, which does that
   * immediately before the body is pasted in after it.
   *
   * Same failure direction as the attachment and the email switch: a member who
   * cannot be tagged is dropped and said so in the step log; the post still goes
   * out. The question is the post.
   */
  mentions?: SkoolMember[];
}

/**
 * Every `{{field}}` a recording takes from outside.
 *
 * ⚠️ BOTH PLACES A PLACEHOLDER CAN LIVE, WHICH IS NOT ONLY THE TYPED STEPS. The
 * title and body are typed; the CATEGORY is clicked, because it is a menu item
 * labelled with the category name. A scan that looked at typed steps alone
 * would report a perfectly good recording as having no `{{category}}` and warn
 * about a problem that is not there.
 */
function recipeFields(steps: RecipeStep[]): string[] {
  const found = new Set<string>();
  for (const s of steps) {
    for (const p of placeholdersIn(s.text ?? "")) found.add(p);
    for (const p of placeholdersIn(s.target?.text ?? "")) found.add(p);
  }
  return [...found];
}

export interface ReplyResult {
  ok: boolean;
  detail: string;
  /** The reply as read back from Skool's own API, when it was found. */
  replyId: string | null;
}

/**
 * Paste a reply into the editor Skool just opened.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE `appendBody` WOULD HAVE TYPED IT INSTEAD. That helper
 * is the LESSON writer, and every editor lookup in its chain — `bodyStructure`,
 * `pasteHtmlChunk` — selects "the tallest contenteditable OVER 40 PIXELS". A
 * lesson body always clears that; a reply box holding nothing but "@Remco
 * Borsato" is one line tall and need not. When it does not clear it, the chain
 * does not fail: `pasteHtmlChunk` finds no editor, reports that nothing was
 * pasted, and `appendBody` FALLS BACK TO TYPING THE REPLY KEY BY KEY.
 *
 * That fallback is the worst available outcome here. The text starts life next
 * to an @mention, and typing into ProseMirror re-opens Skool's mention
 * autocomplete — so an `@` anywhere in the reply, or the plain act of typing
 * beside the existing mention, can capture keystrokes into a popup and commit a
 * member's name into the middle of a sentence. It also puts raw markdown on the
 * page, which is the scar `pasteBody` was written for in the first place.
 *
 * So the reply is pasted into the editor identified by its OWN semantic class,
 * with no height test anywhere: `skool-editor` is a name somebody chose and
 * survives a redeploy, unlike the `sc-…` hashes beside it.
 *
 * ⚠️ text/plain ONLY, unlike a lesson. A reply is prose — Jake's own comments
 * carry no headings and no lists — so offering text/html would invite the editor
 * to build structure that none of the community's replies have.
 */
async function pasteIntoReplyEditor(text: string): Promise<ActionResult> {
  const measure = async (): Promise<number> =>
    (await withSkoolPage(async (page) =>
      page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        const ed = (Array.from(doc.querySelectorAll(".skool-editor[contenteditable='true']")) as any[]).find(
          (el) => el.getBoundingClientRect().height > 0,
        );
        return ed ? String(ed.textContent ?? "").trim().length : -1;
      }),
    )) ?? -1;

  const before = await measure();
  if (before < 0) return { ok: false, detail: "No reply editor is open to write into." };

  const dispatched = await withSkoolPage(async (page) => {
    try {
      return (await page.evaluate((t: string) => {
        const doc: any = (globalThis as any).document;
        const g: any = globalThis;
        const ed = (Array.from(doc.querySelectorAll(".skool-editor[contenteditable='true']")) as any[]).find(
          (el) => el.getBoundingClientRect().height > 0,
        );
        if (!ed) return false;
        ed.focus();

        // Caret to the very end, so the paste lands AFTER the @mention rather
        // than in front of it. Set explicitly because the editor was focused by
        // script rather than by a click, so it may hold no caret at all yet.
        const sel = g.getSelection?.();
        if (sel) {
          const range = doc.createRange();
          range.selectNodeContents(ed);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }

        const dt = new g.DataTransfer();
        dt.setData("text/plain", t);
        ed.dispatchEvent(new g.ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        return true;
      }, text)) as boolean;
    } catch {
      return false;
    }
  });
  if (!dispatched) return { ok: false, detail: "The reply editor vanished before the text could be pasted." };

  await settle(800);
  const after = await measure();
  const gained = after - before;
  // A proportion, not an equality: the editor normalises whitespace, and the
  // @mention it starts with is counted in both readings.
  if (gained < text.length * 0.6) {
    return {
      ok: false,
      detail: `The paste put ${gained} characters into the reply editor against ${text.length} written, so it is incomplete.`,
    };
  }
  return { ok: true, detail: `Pasted ${gained} characters after the mention.` };
}

/**
 * Reply to one comment.
 *
 * ⚠️⚠️ THE HARD PART IS JOINING AN API ID TO A DOM BUTTON. Comments are READ
 * from `api2.skool.com`, which is the only place their ids exist — the rendered
 * page carries no id, no data attribute and no permalink for a comment. But the
 * reply is WRITTEN through the UI, because that is this project's rule for
 * anything that changes the community. So the two have to be joined by the one
 * thing both sides can see: the comment's TEXT.
 *
 * The join is: for every visible "Reply" button, climb to the nearest ancestor
 * whose text contains this comment's opening, and keep the SMALLEST such
 * ancestor — the comment's own block rather than the thread or the page around
 * it. Ambiguity is fatal, not resolved by picking the first: two candidates
 * means the snippet was not distinctive, and a reply under the wrong member's
 * comment is not something a read-back can undo.
 *
 * ⚠️ THE SUBMIT BUTTON IS ALSO CALLED "Reply", WHICH THE POST BUTTON WAS NOT.
 * Opening the editor takes the count from 40 to 41, so "the button that says
 * Reply" is meaningless here. Measured: the submit shares a row with the
 * editor's "Cancel" and sits to its right, and is DISABLED until the body has
 * real content. Both facts are used.
 *
 * ⚠️ THE EDITOR OPENS PRE-FILLED WITH AN @MENTION of the person being answered
 * ("@Remco Borsato", 14 characters). That is Skool's doing and it must be kept,
 * so the body is APPENDED and the blank-composer rule from `createPost` cannot
 * apply — the field is legitimately non-empty before we type.
 */
export async function replyToComment(input: {
  communityUrl: string;
  slug: string;
  commentId: string;
  /** The comment's own text — the only handle the DOM shares with the API. */
  commentBody: string;
  text: string;
  /**
   * Do everything except the final click.
   *
   * ⚠️ THE POINT IS THAT IT IS NOT A SIMULATION. It opens the real editor on the
   * real thread and pastes the real text; only the submit is withheld, after
   * being RESOLVED so the count and the disabled state are reported. That is how
   * `createPost` was proven — every step but the last ran for real — and it is
   * the only way to learn whether the join, the paste and the submit lookup work
   * without a member seeing the answer.
   */
  dryRun?: boolean;
}): Promise<ReplyResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, detail: "An empty reply was not sent.", replyId: null };

  // The join key. Long enough to be distinctive, short enough to survive the
  // whitespace and entity differences between the API's text and the DOM's.
  const snippet = input.commentBody.replace(/\s+/g, " ").trim().slice(0, 60);
  if (snippet.length < 12) {
    return {
      ok: false,
      detail:
        `That comment is only ${snippet.length} characters, which is too short to locate reliably on the page. ` +
        `Refusing rather than risk replying under somebody else's comment.`,
      replyId: null,
    };
  }

  // ⚠️ CHECK SKOOL, NOT OUR OWN RECORD, IMMEDIATELY BEFORE WRITING. The worker
  // retries, and Jake answers comments himself; either can have happened since
  // the queue was built.
  const before = await readComments(input.communityUrl, input.slug);
  if (before.error) return { ok: false, detail: `Could not read the comments first, so nothing was sent: ${before.error}`, replyId: null };
  const target = before.comments.find((c) => c.id === input.commentId);
  if (!target) return { ok: false, detail: `Comment ${input.commentId} is no longer on that post — it may have been deleted.`, replyId: null };
  if (target.answeredByMe) return { ok: false, detail: `That comment already has a reply from this account. Not answering it twice.`, replyId: null };

  const opened = await withSkoolPage(async (page) => {
    const found = await page.evaluate((want: string) => {
      const doc: any = (globalThis as any).document;
      const win: any = globalThis;
      const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
      const vis = (el: any) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const buttons = (Array.from(doc.querySelectorAll("button")) as any[])
        .filter((b) => norm(b.textContent).toLowerCase() === "reply")
        .filter(vis);

      const hits: { btn: any; size: number }[] = [];
      for (const btn of buttons) {
        let node: any = btn;
        for (let hop = 0; hop < 9 && node; hop++) {
          node = node.parentElement;
          if (!node) break;
          if (norm(node.textContent).includes(want)) {
            hits.push({ btn, size: (node.textContent || "").length });
            break;
          }
        }
      }
      if (hits.length === 0) return { ok: false, why: "not-found", count: 0 };
      // The smallest containing block is the comment itself; larger ones are the
      // thread and the page. Distinct buttons at the same minimum size means the
      // snippet genuinely appears twice.
      hits.sort((a, b) => a.size - b.size);
      const best = hits[0];
      const tied = hits.filter((h) => h.btn !== best.btn && h.size === best.size);
      if (tied.length > 0) return { ok: false, why: "ambiguous", count: tied.length + 1 };

      best.btn.scrollIntoView({ block: "center", inline: "nearest" });
      const r = best.btn.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2);
      const y = Math.round(r.y + r.height / 2);
      if (!(x >= 0 && y >= 0 && x <= win.innerWidth && y <= win.innerHeight)) {
        return { ok: false, why: "offscreen", count: hits.length };
      }
      return { ok: true, x, y, count: hits.length };
    }, snippet);

    if (!found?.ok) return found;
    await page.mouse.click(found.x, found.y, { delay: 40 });
    return found;
  });

  if (!opened?.ok) {
    const why: Record<string, string> = {
      "not-found": `No comment on that page contains "${snippet.slice(0, 40)}…", so its Reply button could not be found.`,
      ambiguous: `That comment's opening matches ${opened?.count ?? 2} separate blocks on the page. Refusing rather than guessing which member gets the reply.`,
      offscreen: "The Reply button would not come into view, so it was not clicked.",
    };
    return { ok: false, detail: why[String(opened?.why)] ?? "The reply editor could not be opened.", replyId: null };
  }
  await settle(1800);

  // Append: Skool has already put the @mention in, and it belongs there.
  const written = await pasteIntoReplyEditor(text);
  if (!written.ok) {
    await clickButton("Cancel").catch(() => undefined);
    return { ok: false, detail: `The reply was not written: ${written.detail}`, replyId: null };
  }
  await settle(800);

  const sent = await withSkoolPage(async (page) => {
    const hit = await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
      const vis = (el: any) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const all = (Array.from(doc.querySelectorAll("button")) as any[]).filter(vis);
      const cancel = all.find((b) => norm(b.textContent).toLowerCase() === "cancel");
      if (!cancel) return { ok: false, why: "no-cancel" };
      const cr = cancel.getBoundingClientRect();
      // Same row as Cancel, to its right. Measured on the live editor.
      const submits = all.filter((b) => {
        if (norm(b.textContent).toLowerCase() !== "reply") return false;
        const r = b.getBoundingClientRect();
        return Math.abs(r.y - cr.y) < 12 && r.x > cr.x;
      });
      if (submits.length !== 1) return { ok: false, why: submits.length === 0 ? "no-submit" : "many-submits" };
      const btn = submits[0];
      // Disabled means Skool does not consider the body filled — clicking it
      // would silently do nothing and the read-back would blame the wrong thing.
      if (btn.disabled) return { ok: false, why: "disabled" };

      // ⚠️⚠️ SCROLL IT INTO VIEW AND RE-MEASURE, OR A LONG REPLY IS NEVER SENT.
      // `page.mouse.click` takes VIEWPORT coordinates. A reply of any length
      // grows the editor and pushes this button below the 900px fold, so the
      // rect comes back with y past the bottom of the window and the click is
      // delivered to empty space — no error, no write, and every step still
      // reports success. Measured 2026-08-20 with request interception armed:
      // the whole flow made FIVE api2.skool.com calls and NOT ONE was a write.
      // The dry run could never have caught it, because it resolves the button
      // and deliberately does not click.
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      const r = btn.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2);
      const y = Math.round(r.y + r.height / 2);
      const w = (globalThis as any).innerWidth;
      const h = (globalThis as any).innerHeight;
      if (x < 0 || y < 0 || x > w || y > h) return { ok: false, why: "offscreen", x, y, w, h };
      // ⚠️ AND CHECK WHAT IS ACTUALLY AT THAT POINT. Scrolled into view is not
      // the same as clickable: a sticky footer or a toast sitting over the
      // button swallows the click just as silently as the fold did.
      const at = doc.elementFromPoint(x, y);
      if (!at || (at !== btn && !btn.contains(at) && !at.contains(btn))) {
        return { ok: false, why: "covered", at: norm(at?.tagName) + " " + norm(at?.textContent).slice(0, 60) };
      }
      return { ok: true, x, y };
    });
    if (!hit?.ok) return hit;
    // ⚠️ RESOLVED BUT NOT CLICKED. Everything above this line has already run
    // against the live thread — the editor is open and holds the reply — so the
    // dry run proves the join, the paste and the submit lookup. Only the public
    // half is withheld.
    if (input.dryRun) return { ...hit, skipped: true };
    await page.mouse.click(hit.x, hit.y, { delay: 40 });
    return hit;
  });

  if (!sent?.ok) {
    const why: Record<string, string> = {
      "no-cancel": "The reply editor did not open — there is no Cancel beside a submit button.",
      "no-submit": "The editor is open but no Reply button sits beside Cancel, so nothing was submitted.",
      "many-submits": "More than one submit button matched. Refusing to guess.",
      disabled: "The submit button is still disabled, so Skool did not register the reply text.",
      offscreen:
        `The submit button is outside the window even after scrolling to it ` +
        `(${sent?.x},${sent?.y} in a ${sent?.w}x${sent?.h} viewport), so a click would have gone nowhere.`,
      covered: `Something is sitting on top of the submit button (${sent?.at}), so the click would not reach it.`,
    };
    await clickButton("Cancel").catch(() => undefined);
    return { ok: false, detail: why[String(sent?.why)] ?? "The reply could not be submitted.", replyId: null };
  }

  if (input.dryRun) {
    // ⚠️ CANCEL, AND EXPECT IT TO LEAVE A DRAFT BEHIND. Clearing a ProseMirror
    // document does not work (measured during the composer work: 2,630 chars
    // down to 2,591), and Skool raises a native confirm on abandoning a part
    // written reply. The draft lives in the page rather than on Skool's server,
    // so a session relaunch is what actually discards it.
    await clickButton("Cancel").catch(() => undefined);
    return {
      ok: true,
      detail:
        `DRY RUN — replying to ${target.authorName}: the editor opened on the right comment, ${text.length} characters ` +
        `were pasted after Skool's @mention, and exactly one enabled submit button was found beside Cancel. ` +
        `It was NOT clicked; nothing was sent.`,
      replyId: null,
    };
  }
  await settle(3500);

  // ⚠️ THE ONLY EVIDENCE THAT COUNTS, and here it is exact rather than fuzzy:
  // re-read the API and look for a NEW child of this comment written by us.
  const after = await readComments(input.communityUrl, input.slug);
  if (after.error) {
    return { ok: false, detail: `Submitted, but the comments could not be re-read, so the reply is UNCONFIRMED: ${after.error}`, replyId: null };
  }
  const seen = new Set(before.comments.map((c) => c.id));
  const landed = after.comments.find((c) => c.parentId === input.commentId && c.byMe && !seen.has(c.id));
  if (!landed) {
    return {
      ok: false,
      detail:
        `Every click worked and no new reply from this account is under that comment. Treat it as not sent — ` +
        `but check the post before retrying, because one that landed late would duplicate.`,
      replyId: null,
    };
  }
  return { ok: true, detail: `Replied to ${target.authorName}: ${landed.body.trim().length} characters.`, replyId: landed.id };
}

export interface TaughtPostAction {
  /** Whether a recording exists at all. False means the built-in map runs. */
  taught: boolean;
  /** The name it must be saved under for the publisher to find it. */
  name: string;
  steps: number;
  /** The `{{fields}}` the recording accepts from outside. */
  placeholders: string[];
  /** Fields the publisher supplies that the recording has no step for. */
  missing: string[];
  /**
   * Steps whose element can only be found by a styled-components class or a tag
   * path — the handles that change on Skool's next redeploy. Predicted from the
   * recording rather than measured, since the real handle is only known once a
   * step resolves against a live page; a non-zero count here is a recording
   * worth redoing before it is depended on.
   */
  fragileSteps: number;
  /**
   * Typed fields that were recorded as CLICK targets — a recording that cannot
   * work. See `composeTaught`: the publisher refuses on this, and saying so on
   * the screen means finding out before a posting day rather than during one.
   */
  unclickableFields: string[];
}

/** Typed values can never identify a clicked element. Only a chosen one can. */
function unclickableFieldsIn(steps: RecipeStep[]): string[] {
  return [
    ...new Set(
      steps
        .filter((s) => s.kind === "click" || s.kind === "hover")
        .flatMap((s) => placeholdersIn(s.target?.text ?? ""))
        .filter((f) => f === "title" || f === "body"),
    ),
  ];
}

/** What the publisher will actually do, for a screen that has to say so. */
export function taughtPostAction(): TaughtPostAction {
  const recipe = getRecipe(POST_RECIPE);
  if (!recipe) {
    return {
      taught: false,
      name: POST_RECIPE,
      steps: 0,
      placeholders: [],
      missing: [],
      fragileSteps: 0,
      unclickableFields: [],
    };
  }
  const placeholders = new Set(recipeFields(recipe.steps));
  // A step with no durable handle of its own. A SEMANTIC class counts as one —
  // `skool-editor` is a name somebody chose and survives a redeploy, unlike the
  // `sc-…` hashes beside it, and flagging it trains the reader to ignore this.
  const fragileSteps = recipe.steps.filter(
    (s) =>
      s.target &&
      !s.target.testId &&
      !s.target.ariaLabel &&
      !s.target.placeholder &&
      !s.target.text &&
      !isSemanticClass(s.target.classes?.[0]),
  ).length;
  return {
    taught: true,
    name: POST_RECIPE,
    steps: recipe.steps.length,
    placeholders: [...placeholders],
    missing: ["title", "body", "category"].filter((f) => !placeholders.has(f)),
    fragileSteps,
    unclickableFields: unclickableFieldsIn(recipe.steps),
  };
}

interface ComposeResult {
  ok: boolean;
  detail: string;
}

const COMPOSED = (): ComposeResult => ({ ok: true, detail: "" });
const NOT_COMPOSED = (detail: string): ComposeResult => ({ ok: false, detail });

/**
 * The blank-composer guard, as a replay hook.
 *
 * ⚠️ THE SAME SCAR AS `bodyMustBeEmpty` IN THE LESSON WRITER, WHICH FIRED FOUR
 * TIMES IN TEN PAGES. Skool keeps unsent drafts in the composer, so "the
 * composer opened" does not mean "the composer is blank" — and writing into one
 * publishes somebody's half-finished draft with this post underneath it.
 *
 * It has to run at the moment the body is about to be written: before the
 * replay the composer is not open yet, and after it the post is already gone.
 */
async function refuseIfComposerHoldsADraft(): Promise<string | null> {
  const already = await composerBodyChars();
  if (already <= 40) return null;
  await cancelComposer();
  return (
    `The composer already holds ${already} characters — that is an unsent draft, not a blank post. ` +
    `Refusing to write: continuing would publish it with this post appended underneath.`
  );
}

/** The hand-written composer path. Used when nothing has been taught. */
async function composeBuiltIn(
  input: CreatePostInput,
  title: string,
  body: string,
  step: (s: string) => void,
): Promise<ComposeResult> {
  const opened = await clickVisibleText("Write something", { exact: false });
  if (!opened.ok) return NOT_COMPOSED(`Could not open the composer: ${opened.detail}`);
  await settle(1200);
  if (!(await composerIsOpen())) {
    return NOT_COMPOSED('Clicked "Write something" but no Title field appeared, so the composer is not open.');
  }
  step("Composer open");

  const draft = await refuseIfComposerHoldsADraft();
  if (draft) return NOT_COMPOSED(draft);

  const titled = await fillField("Title", title);
  if (!titled.ok) return NOT_COMPOSED(titled.detail);
  step("Title filled");

  // ⚠️ BEFORE THE BODY, NEVER AFTER. `appendBody` sends the caret to the end of
  // the document and pastes there, so chips typed first land in front of the
  // first sentence — which is where the drafter was told to expect them.
  if (input.mentions?.length) step((await typeMentions(input.mentions)).detail);

  // The composer body is a ProseMirror document, same as a lesson's, so this is
  // the proven paste path: a real `paste` event carrying a DataTransfer. Typing
  // is its fallback and puts raw markdown characters on the page.
  const written = await appendBody(body);
  if (!written.ok) return NOT_COMPOSED(written.detail);
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

  if (input.attachment) step(await attachNote(input.attachment));
  if (input.emailNotify) step(await emailNotifyNote());

  const posted = await clickButton("Post");
  if (!posted.ok) return NOT_COMPOSED(posted.detail);
  step('Clicked "Post"');
  return COMPOSED();
}

/**
 * Set the email switch and describe what happened, in one line for the log.
 *
 * Shared by both compose paths so they cannot drift: the taught path is what
 * actually runs today, and the built-in path is what runs if the recipe is ever
 * deleted — a post that quietly stopped emailing on that fallback would be very
 * hard to notice.
 */
async function attachNote(attachment: Attachment): Promise<string> {
  const r = await attachToComposer(attachment);
  return r.ok ? `Attached: ${r.detail}` : `⚠ Attachment SKIPPED — ${r.detail}; posting without it`;
}

async function emailNotifyNote(): Promise<string> {
  const set = await setEmailNotify(true);
  if (set.ok) return set.clicked ? `Email to all members: ON` : `Email to all members: already on`;
  return `⚠ Email to all members NOT set (${set.detail}) — posting anyway, without the email`;
}

/**
 * The taught composer path — replay what the operator demonstrated.
 *
 * ⚠️ THE RECIPE IS CHECKED FOR ITS PLACEHOLDERS BEFORE ANYTHING IS OPENED. A
 * recording made without a `{{title}}` step would replay the title the operator
 * demoed it with, every week, and look like it was working. Refusing up front
 * costs nothing; discovering it from the feed costs a post members can see.
 */
async function composeTaught(
  steps: RecipeStep[],
  input: CreatePostInput,
  title: string,
  body: string,
  step: (s: string) => void,
): Promise<ComposeResult> {
  // ⚠️⚠️ A TYPED FIELD USED AS A CLICK TARGET CAN NEVER RESOLVE, AND IT IS AN
  // EASY MISTAKE TO MAKE. A placeholder on a CLICK means "find the element whose
  // label is this value" — right for the category, whose menu item is labelled
  // with the category name, and impossible for the title or the body, which are
  // typed INTO an input that is empty at the moment it is clicked. The first
  // recording had four such steps and would have died on the first one.
  //
  // Caught here rather than mid-replay because mid-replay is after the composer
  // is open, which leaves a half-filled draft sitting in the community's editor.
  const unclickable = unclickableFieldsIn(steps);
  if (unclickable.length > 0) {
    const which = unclickable.map((f) => `{{${f}}}`).join(" and ");
    return NOT_COMPOSED(
      `The taught "${POST_RECIPE}" action clicks ${which}, which cannot work: a placeholder on a click means ` +
        `"the element labelled with this value", and the title and body are TYPED into a field that is empty when ` +
        `you click it. Mark those on the typing step instead — only the category is picked by clicking its label.`,
    );
  }

  const declared = new Set(recipeFields(steps));
  const missing = ["title", "body"].filter((f) => !declared.has(f));
  if (missing.length > 0) {
    return NOT_COMPOSED(
      `The taught "${POST_RECIPE}" action has no ${missing.map((m) => `{{${m}}}`).join(" or ")} step, so replaying it ` +
        `would publish whatever was typed when it was recorded. Re-record it with the placeholder buttons.`,
    );
  }
  // A category is optional in the composer, so a recording without one is a
  // choice rather than a mistake — but the post will be uncategorised and that
  // should not be a surprise.
  if (input.category && !declared.has("category")) {
    step(`Taught action has no {{category}} step, so "${input.category}" will not be set`);
  }

  const vars: Record<string, string> = { title, body };
  if (input.category) vars.category = input.category;

  // ⚠️ THE SWITCH IS SET BEFORE THE LAST STEP, NOT RECORDED AS ONE. The recipe
  // ends with the click that publishes — that is what makes it a recipe — so the
  // last step is the final moment the composer is still open and editable. It
  // deliberately does not matter WHICH control the last step is: if a future
  // recording ends on something other than Post, the switch is still set while
  // the modal is up, which is the only requirement.
  const emailNotes: string[] = [];
  const played: ReplayResult = await replaySteps(steps, vars, {
    guard: async (s) => ((s.text ?? "").trim() === "{{body}}" ? refuseIfComposerHoldsADraft() : null),
    beforeStep: async (s, i, total) => {
      // ⚠️ THE CHIPS GO IN ON THE {{body}} STEP, NOT AS A RECORDED ONE. A
      // recording cannot carry them: it was made once, with whoever had joined
      // that day, and replaying it would tag those same people every week. This
      // hook runs AFTER the guard above has confirmed the composer is blank and
      // BEFORE the step that pastes the body, which is the only moment the
      // caret is in an empty editor.
      if (input.mentions?.length && (s.text ?? "").trim() === "{{body}}") {
        emailNotes.push((await typeMentions(input.mentions)).detail);
      }
      if (i !== total - 1) return null;
      // Both happen at the last moment the composer is still open and editable.
      if (input.attachment) emailNotes.push(await attachNote(input.attachment));
      if (input.emailNotify) emailNotes.push(await emailNotifyNote());
      return null;
    },
  });

  // Which handle each step matched on is the useful part of the log: a step
  // that used to match on a testId and now matches on a tag path is about to
  // break, and this is where that becomes visible.
  const weak = played.steps.filter((s) => s.handle === "class" || s.handle === "path").length;
  step(
    `Replayed the taught "${POST_RECIPE}": ${played.steps.filter((s) => s.ok).length}/${steps.length} steps` +
      (weak > 0 ? `, ${weak} on a fragile handle` : ""),
  );
  for (const n of emailNotes) step(n);
  for (const w of played.warnings) step(`⚠ ${w}`);

  return played.ok ? COMPOSED() : NOT_COMPOSED(played.detail);
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

  // ⚠️⚠️ DO NOT RE-NAVIGATE TO THE PAGE WE ARE ALREADY ON. THIS IS WHY THE
  // FIRST EVER PUBLISH FAILED. `readFeed` above just loaded this exact URL, and
  // Skool is a Next.js SPA: a second `goto` to the identical URL does not commit
  // a fresh navigation, so `domcontentloaded` never fires and the call sits for
  // the full 60s and throws. The symptom is maximally misleading — the browser
  // is healthy and `skoolReadFeed` answers in 3s, so it reads as a dead session
  // or an expired cookie rather than a redundant navigation.
  //
  // Compared by NORMALISED url (trailing slash and #fragment stripped) because
  // Skool echoes the feed back without the slash we may have asked for, and an
  // over-strict compare silently reintroduces the hang.
  const feedUrl = communityFeedUrl(input.communityUrl, 1);
  const sameUrl = (a: string, b: string): boolean =>
    a.split("#")[0].replace(/\/+$/, "") === b.split("#")[0].replace(/\/+$/, "");

  const navigated = await withSkoolPage(async (page) => {
    if (sameUrl(page.url() || "", feedUrl)) return false;
    await page.goto(feedUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return true;
  });
  step(navigated ? "Navigated to the feed" : "Already on the feed");
  await settle(2500);

  const taught = getRecipe(POST_RECIPE);
  const composed = taught
    ? await composeTaught(taught.steps, input, title, body, step)
    : await composeBuiltIn(input, title, body, step);
  if (!composed.ok) return FAIL(`${log.join(" → ")} → ${composed.detail}`);

  // ⚠️⚠️ THE POST CLICK IS NOT THE SUBMIT WHEN THE EMAIL SWITCH IS ON. Skool
  // raises a "Send email to all members?" modal over the composer and issues no
  // request until it is confirmed. Twelve scheduled attempts on 2026-08-09 each
  // clicked Post, reported nine of nine steps, and published nothing.
  //
  // Called on BOTH compose paths and unconditionally — not gated on
  // `input.emailNotify` — because the switch's state is what raises the modal,
  // and the switch can be on for reasons this call does not know about (it is a
  // real control a human may have left on). An absent modal is not an error.
  const confirmed = await confirmEmailDialog();
  if (confirmed.appeared) step(confirmed.detail);
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
  if (landed.body.trim().length < body.length * BODY_LANDED_RATIO) {
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
