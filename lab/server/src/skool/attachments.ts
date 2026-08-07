/**
 * Putting a video or a poll into the composer, before the post is submitted.
 *
 * Measured on the live composer, 2026-08-07:
 *
 *   [aria-label="Add video"] → an input placeholdered
 *     "YouTube, Loom, Vimeo, or Wistia link" (testid `add-video-input`)
 *     + a button reading "Add".
 *   [aria-label="Add poll"] → inputs placeholdered "Option 1", "Option 2",
 *     "Option 3", a button "Add Option", and the toolbar's own button flips
 *     from "Add poll" to "Remove poll".
 *
 * ⚠️ THAT LAST DETAIL IS THE ONLY HONEST CONFIRMATION EITHER FLOW OFFERS, and
 * it is why the poll path checks it. Clicking a toolbar icon and finding fields
 * afterwards proves the fields exist; it does not prove THIS click produced
 * them. "Remove poll" existing means Skool itself considers a poll attached.
 *
 * ⚠️ AN ATTACHMENT NEVER BLOCKS A POST. Every failure here is reported and
 * swallowed: the words are the post, and a missing poll is a smaller loss than
 * a Friday with nothing on the feed. The caller logs what happened either way,
 * so a silently video-less post is still a visibly video-less post in the log.
 */
import { clickButton, fillField } from "./actions.js";
import { withSkoolPage } from "./browser.js";
import type { Attachment } from "./engageGen.js";

const settle = (ms = 700): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Click a control by its aria-label, with the real mouse.
 *
 * The composer's toolbar is icon-only — no text at all — so `clickButton` (which
 * matches visible text) cannot reach any of it. Same lesson as the email switch
 * one file over.
 */
async function clickByAria(label: string): Promise<boolean> {
  const at = await withSkoolPage(async (page) => {
    const spot = await page.evaluate((wanted: string) => {
      const doc: any = (globalThis as any).document;
      const els = (Array.from(doc.querySelectorAll(`[aria-label="${wanted}"]`)) as any[]).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (els.length !== 1) return null; // 0 = gone, >1 = ambiguous. Neither is clickable.
      els[0].scrollIntoView({ block: "center", inline: "nearest" });
      const r = els[0].getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, label);
    if (!spot) return false;
    await page.mouse.click(spot.x, spot.y, { delay: 40 });
    return true;
  });
  return at === true;
}

/** Is a control with this aria-label on screen? Used as a state check. */
async function ariaExists(label: string): Promise<boolean> {
  const found = await withSkoolPage(async (page) =>
    page.evaluate((wanted: string) => {
      const doc: any = (globalThis as any).document;
      return (Array.from(doc.querySelectorAll(`[aria-label="${wanted}"]`)) as any[]).some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }, label),
  );
  return found === true;
}

export interface AttachResult {
  ok: boolean;
  /** One line for the post's step log, whether it worked or not. */
  detail: string;
}


/** Is this video actually in the open composer? Also reports what IS there. */
async function videoInComposer(videoId: string): Promise<{ inComposer: boolean; reason: string; clue: string }> {
  const out = await withSkoolPage(async (page) =>
    page.evaluate((id: string) => {
      const doc: any = (globalThis as any).document;
      const title = (Array.from(doc.querySelectorAll("input")) as any[]).find(
        (el) => (el.getAttribute("placeholder") || "").trim().toLowerCase() === "title",
      );
      if (!title) return { inComposer: false, reason: "the composer is not open", clue: "" };

      // ⚠️ SCOPE TO THE WHOLE MODAL, NOT THE EDITOR'S WRAPPER. The nearest
      // ancestor containing `.skool-editor` is a tight box around the title and
      // body, and Skool renders the video preview in a SIBLING region below
      // them — so that scope reports "no video" for a video that attached fine.
      // The modal is the nearest ancestor holding both the title and Post.
      let box: any = title;
      for (let up = 0; up < 14 && box; up++) {
        box = box.parentElement;
        if (!box) break;
        const hasPost = (Array.from(box.querySelectorAll?.("button") ?? []) as any[]).some(
          (b: any) => (b.textContent || "").trim() === "Post",
        );
        if (hasPost && box.querySelector?.(".skool-editor")) break;
      }
      if (!box) return { inComposer: false, reason: "the composer body was not found", clue: "" };

      const html = String(box.innerHTML || "");
      // Skool may render the embed by id, by thumbnail, or as an iframe.
      const inComposer =
        html.includes(id) || !!box.querySelector(`[src*="${id}"], [href*="${id}"], iframe[src*="youtube"]`);
      let clue = "";
      if (!inComposer) {
        const at = html.search(/youtube|ytimg|iframe|vimeo|loom/i);
        clue = at >= 0 ? html.slice(Math.max(0, at - 120), at + 220) : `tail:${html.slice(-500)}`;
      }
      return { inComposer, reason: "", clue };
    }, videoId),
  );
  return out ?? { inComposer: false, reason: "no browser page", clue: "" };
}

async function attachVideo(videoId: string, url: string): Promise<AttachResult> {
  // Already open from a previous attempt? Opening it twice closes it again.
  if (!(await ariaExists("Add video"))) {
    return { ok: false, detail: "the composer has no \"Add video\" control" };
  }
  if (!(await clickByAria("Add video"))) {
    return { ok: false, detail: "\"Add video\" could not be clicked" };
  }
  await settle(1200);

  // ⚠️ THE TESTID IS `post-video-input`. A comment in `actions.ts` named it
  // `add-video-input` — measured 2026-08-07, no such attribute exists anywhere
  // in the composer — so the testid lookup silently missed and only the
  // placeholder fallback ever did the typing.
  const typed = await fillField("post-video-input", url);
  if (!typed.ok) {
    const byPlaceholder = await fillField("YouTube, Loom, Vimeo, or Wistia link", url);
    if (!byPlaceholder.ok) return { ok: false, detail: `the video link field did not accept the URL (${typed.detail})` };
  }
  await settle(600);

  // ⚠️ LOOK AT THE FIELD BEFORE PRESSING Add. Skool validates the link and keeps
  // the button DISABLED until it is happy — and clicking a disabled button
  // succeeds in every way that a click can be measured, then does nothing.
  const ready = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const input = (Array.from(doc.querySelectorAll("input")) as any[]).find((el) => {
        const ph = (el.getAttribute("placeholder") || "").toLowerCase();
        return el.getAttribute("data-testid") === "post-video-input" || ph.includes("youtube");
      });
      const addBtn = (Array.from(doc.querySelectorAll("button")) as any[]).find(
        (b) => (b.textContent || "").trim() === "Add" && b.getBoundingClientRect().width > 0,
      );
      return {
        value: input ? String(input.value || "") : null,
        addFound: !!addBtn,
        addDisabled: addBtn ? !!addBtn.disabled : null,
      };
    }),
  );
  if (ready && ready.value !== url) {
    return { ok: false, detail: `the link field holds ${JSON.stringify(ready.value)} rather than the URL` };
  }
  if (ready && ready.addDisabled) {
    return { ok: false, detail: `Skool kept the video's "Add" button disabled for ${url}` };
  }

  // ⚠️ ENTER FIRST, THEN THE BUTTON. Clicking "Add" alone leaves the toolbar
  // still reading "Add video" and nothing in the modal — measured repeatedly on
  // 2026-08-07 with the URL verified in the field and the button verified
  // enabled. Skool's DM composer has the same shape (there is no send button at
  // all there; Enter sends), so the keyboard is tried first here and the button
  // is kept as the fallback rather than the other way round.
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.press("Enter");
    } catch {
      /* best effort */
    }
  });
  await settle(5000);

  // Enter may have done it. Ask the composer rather than guessing at a label:
  // "Remove video" was a guess and the toolbar does not use it.
  if (!(await videoInComposer(videoId)).inComposer) {
    const added = await clickButton("Add");
    if (added.ok) await settle(5000);
  }

  // ⚠️ CONFIRM INSIDE THE COMPOSER, NOT ON THE PAGE. The first attempt to check
  // this from outside asked whether a YouTube embed existed anywhere in the
  // document and got "yes" — from the FEED BEHIND THE MODAL, which is full of
  // his own video posts and their ytimg thumbnails. A check that cannot fail is
  // not a check. So the search is scoped to the composer subtree and looks for
  // THIS id.
  const seen = await videoInComposer(videoId);

  if (!seen?.inComposer) {
    const clue = (seen as any)?.clue ? ` | composer holds: ${String((seen as any).clue).slice(0, 300)}` : " | nothing video-ish in the composer";
    const still = (seen as any)?.linkBoxStillOpen ? " | the link box is still open" : "";
    return { ok: false, detail: `the video did not appear in the composer${seen?.reason ? ` — ${seen.reason}` : ""}${still}${clue}` };
  }
  return { ok: true, detail: `video attached (${url})` };
}

async function attachPoll(options: string[]): Promise<AttachResult> {
  if (options.length < 2) return { ok: false, detail: "a poll needs at least two options" };

  // ⚠️ "Add poll" TOGGLES. If a poll is already open — a retry, or a recording
  // that opened one — clicking it again REMOVES the poll, and the post would
  // publish with the options silently gone.
  const alreadyOpen = await ariaExists("Remove poll");
  if (!alreadyOpen) {
    if (!(await clickByAria("Add poll"))) return { ok: false, detail: "\"Add poll\" could not be clicked" };
    await settle(1200);
  }

  // Skool renders three option boxes; more need "Add Option" first.
  for (let i = 4; i <= options.length; i++) {
    const more = await clickButton("Add Option");
    if (!more.ok) return { ok: false, detail: `could not add option ${i} (${more.detail})` };
    await settle(500);
  }

  for (let i = 0; i < options.length; i++) {
    const typed = await fillField(`Option ${i + 1}`, options[i]);
    if (!typed.ok) return { ok: false, detail: `option ${i + 1} did not take (${typed.detail})` };
    await settle(300);
  }

  // Skool's own state, not ours: it says a poll is attached.
  if (!(await ariaExists("Remove poll"))) {
    return { ok: false, detail: "the options were typed but Skool does not report a poll attached" };
  }
  return { ok: true, detail: `poll attached (${options.length} options: ${options.join(" / ")})` };
}

/**
 * Put `attachment` into the open composer. Never throws.
 *
 * Returns a line for the step log in both directions — a failure here is
 * information, not an exception, because the post goes out regardless.
 */
export async function attachToComposer(attachment: Attachment | null): Promise<AttachResult> {
  if (!attachment) return { ok: true, detail: "no attachment" };
  try {
    if (attachment.kind === "video") return await attachVideo(attachment.videoId, attachment.url);
    return await attachPoll(attachment.options);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
