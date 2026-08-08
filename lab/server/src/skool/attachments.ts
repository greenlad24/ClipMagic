/**
 * Putting a video or a poll into the composer, before the post is submitted.
 *
 * Measured on the live composer, 2026-08-07:
 *
 *   [aria-label="Add video"] → an input placeholdered
 *     "YouTube, Loom, Vimeo, or Wistia link" (testid `post-video-input`,
 *     NOT `add-video-input`, which exists nowhere) + a button reading "Add".
 *     The panel closes when Skool takes the link and stays open, saying
 *     "Invalid video link", when it does not.
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


/**
 * The video link panel's own state: is it open, what does it hold, is Skool
 * complaining about it.
 *
 * ⚠️⚠️ THIS REPLACED A CHECK THAT COULD NEVER HAVE PASSED. Every previous
 * version asked whether the VIDEO ID appeared in the composer's DOM. It never
 * does — measured 2026-08-08 across the whole document, on an upload that had
 * never been posted, so the feed behind the modal could not have supplied a
 * false positive: zero occurrences, before AND after a video that Skool had
 * demonstrably accepted. Skool keeps the attachment in React state and renders
 * no preview carrying the id. Three sessions read that zero as "the attach
 * failed" and switched a working feature off.
 */
async function videoPanelState(): Promise<{ open: boolean; value: string | null; invalid: boolean }> {
  const out = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const input = (Array.from(doc.querySelectorAll("input")) as any[]).find((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const ph = (el.getAttribute("placeholder") || "").toLowerCase();
        return el.getAttribute("data-testid") === "post-video-input" || ph.includes("youtube");
      });
      // Skool's rejection copy. Read as text because it sits in an unlabelled
      // div — there is no role, no aria-live, nothing else to key on.
      const invalid = (Array.from(doc.querySelectorAll("div, span, p")) as any[]).some((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const t = String(el.textContent || "");
        return t.length < 120 && /invalid video link/i.test(t);
      });
      return { open: !!input, value: input ? String(input.value || "") : null, invalid };
    }),
  );
  return out ?? { open: false, value: null, invalid: false };
}

/**
 * Put a video in the composer.
 *
 * ⚠️⚠️ DO NOT PRESS Enter. Enter closes the link panel WITHOUT COMMITTING, and
 * that single keypress is why this feature was believed broken: the panel
 * vanished, so the follow-up "click Add" had no button left to click, and the
 * post went out with no video. The button is the only thing that attaches.
 *
 * How Skool answers, measured 2026-08-08 with three runs — a real link, an
 * empty field, and a non-video URL:
 *   • accepted → the panel CLOSES (the link input is gone) and "Post" becomes
 *     enabled;
 *   • rejected → the panel STAYS OPEN, still holding the text, and the words
 *     "Invalid video link" appear;
 *   • empty → the panel stays open and nothing at all happens.
 *
 * ⚠️ "Post" BECOMING ENABLED IS NOT USED AS THE CONFIRMATION, even though it is
 * the cleanest signal in the experiment. In production the title and body are
 * already filled by the time this runs, so Post is ALREADY enabled and the
 * signal is constant. It only worked in the experiment because the composer
 * was otherwise empty. The panel closing is what gets checked.
 */
async function attachVideo(videoId: string, url: string): Promise<AttachResult> {
  void videoId; // The id is not observable in the DOM; the URL is what is typed.

  // ⚠️ THE TOOLBAR CONTROL TOGGLES, exactly like "Add poll". If a previous
  // attempt left the panel open, clicking it again CLOSES it and the typing
  // then goes nowhere.
  const before = await videoPanelState();
  if (!before.open) {
    if (!(await ariaExists("Add video"))) {
      return { ok: false, detail: 'the composer has no "Add video" control' };
    }
    if (!(await clickByAria("Add video"))) {
      return { ok: false, detail: '"Add video" could not be clicked' };
    }
    await settle(1200);
  }

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

  const ready = await videoPanelState();
  if (ready.value !== url) {
    return { ok: false, detail: `the link field holds ${JSON.stringify(ready.value)} rather than the URL` };
  }

  const added = await clickButton("Add");
  if (!added.ok) return { ok: false, detail: `the video's "Add" button could not be clicked (${added.detail})` };

  // Skool fetches the embed's metadata before it accepts the link, so the
  // answer is not immediate. Poll rather than sleeping a fixed span: the
  // rejection is usually instant and the acceptance usually is not.
  let after = await videoPanelState();
  for (let i = 0; i < 12 && after.open && !after.invalid; i++) {
    await settle(500);
    after = await videoPanelState();
  }

  if (after.invalid) return { ok: false, detail: `Skool rejected ${url} as an invalid video link` };
  if (after.open) {
    return { ok: false, detail: `the link panel stayed open holding ${JSON.stringify(after.value)} — Skool did not take the video` };
  }
  return { ok: true, detail: `video attached (${url})` };
}

/**
 * How many Giphy tiles are on the page, and is the picker's search box open.
 *
 * ⚠️ THE GRID IS `background-image`, NOT `<img>`. That one fact is why the GIF
 * path was abandoned on 2026-08-07 as "renders nothing the probe can identify":
 * every probe counted elements and images, and a Giphy tile is neither. It is a
 * div with a CSS background. Measured 2026-08-08: opening the picker puts 16 of
 * them on a page that had ZERO, across media0-4.giphy.com.
 */
async function gifPickerState(): Promise<{ open: boolean; tiles: number }> {
  const out = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const vis = (el: any): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const input = (Array.from(doc.querySelectorAll("input")) as any[]).find(
        (el) => vis(el) && el.getAttribute("data-testid") === "gif-picker-input",
      );
      let tiles = 0;
      for (const el of Array.from(doc.querySelectorAll("div, span, a, li, button")) as any[]) {
        if (!vis(el)) continue;
        const bg = String((globalThis as any).getComputedStyle?.(el)?.backgroundImage || "");
        if (bg.includes("giphy.com")) tiles++;
      }
      return { open: !!input, tiles };
    }),
  );
  return out ?? { open: false, tiles: 0 };
}

/**
 * Put a GIF in the composer, chosen by searching for `query`.
 *
 * ⚠️ THE FIRST RESULT, NEVER A RANDOM ONE. A slot that retries must attach what
 * the first attempt settled on; a fresh random pick would mean the post that
 * publishes is not the post that was drafted, which is the same rule the stored
 * title and body follow.
 *
 * ⚠️ AND JAKE SHOULD KNOW WHAT THIS IS: the image is whatever Giphy returns for
 * a search term, unseen by anyone, on a post that emails 65 members. That is
 * why the chosen URL goes in the step log rather than just "gif attached" —
 * it is the only record of what actually went out.
 *
 * Confirmation needs NO scoping, which is the point: the page carries zero
 * Giphy backgrounds before the picker opens, so "the picker closed and a Giphy
 * background is still on the page" cannot be satisfied by anything behind the
 * modal. That is the trap the video check kept falling into.
 */
async function attachGif(query: string): Promise<AttachResult> {
  const term = query.trim();
  if (!term) return { ok: false, detail: "a gif needs something to search for" };

  const baseline = await gifPickerState();
  if (baseline.tiles > 0 && !baseline.open) {
    return { ok: false, detail: `the composer already holds a gif (${baseline.tiles} on the page) — refusing to add a second` };
  }

  // Same toggle rule as the poll and the video: a second click closes it.
  if (!baseline.open) {
    if (!(await ariaExists("Add gif"))) return { ok: false, detail: 'the composer has no "Add gif" control' };
    if (!(await clickByAria("Add gif"))) return { ok: false, detail: '"Add gif" could not be clicked' };
    await settle(1500);
  }

  const typed = await fillField("gif-picker-input", term);
  if (!typed.ok) return { ok: false, detail: `the gif search box did not take "${term}" (${typed.detail})` };

  // ⚠️⚠️ WAITING FOR "SOME TILES" IS NOT WAITING FOR THE SEARCH. The picker
  // shows a TRENDING grid the moment it opens, so a poll for `tiles > 0`
  // returns instantly — against the trending results, not the search. Clicking
  // then lands on a tile React is about to replace, the click hits nothing, and
  // the picker stays open. That is exactly how this failed on the first live
  // run, and it looked like "the picker ignores clicks".
  //
  // So: give the search its round trip before looking at the grid at all.
  await settle(2500);

  let results = await gifPickerState();
  for (let i = 0; i < 12 && results.tiles === 0; i++) {
    await settle(500);
    results = await gifPickerState();
  }
  if (results.tiles === 0) return { ok: false, detail: `Giphy returned nothing for "${term}"` };

  // Up to three attempts, because the grid can still re-render underneath a
  // click. Each attempt re-reads the tile's position rather than reusing a
  // stale one — a remembered coordinate is how you click the gap between
  // tiles after a reflow.
  let picked: string | null = null;
  let after = await gifPickerState();
  for (let attempt = 0; attempt < 3 && after.open; attempt++) {
    const got = await withSkoolPage(async (page) => {
      const spot = await page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        for (const el of Array.from(doc.querySelectorAll("div, span, a, li, button")) as any[]) {
          const r = el.getBoundingClientRect();
          // A real tile, not the 1px spacer a CSS background can also sit on.
          if (r.width < 20 || r.height < 20) continue;
          const bg = String((globalThis as any).getComputedStyle?.(el)?.backgroundImage || "");
          if (!bg.includes("giphy.com")) continue;
          const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
          el.scrollIntoView({ block: "center", inline: "nearest" });
          const r2 = el.getBoundingClientRect();
          return { x: Math.round(r2.x + r2.width / 2), y: Math.round(r2.y + r2.height / 2), url: m ? m[1] : "" };
        }
        return null;
      });
      if (!spot) return null;
      await page.mouse.click(spot.x, spot.y, { delay: 40 });
      return spot.url;
    });
    if (got) picked = got as string;

    after = await gifPickerState();
    for (let i = 0; i < 8 && after.open; i++) {
      await settle(500);
      after = await gifPickerState();
    }
  }
  if (!picked) return { ok: false, detail: `could not click a gif tile for "${term}"` };
  if (after.open) return { ok: false, detail: `the gif picker stayed open after choosing a result for "${term}"` };

  // The picker closing and the gif rendering are two different moments, and
  // checking on the first one reports "nothing attached" for a gif that arrives
  // a beat later. Same mistake as the video, one surface over.
  for (let i = 0; i < 12 && after.tiles === 0; i++) {
    await settle(500);
    after = await gifPickerState();
  }
  if (after.tiles === 0) {
    return { ok: false, detail: `the picker closed but no gif is on the page — nothing was attached for "${term}"` };
  }
  return { ok: true, detail: `gif attached (search "${term}" → ${String(picked).slice(0, 120)})` };
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
    if (attachment.kind === "gif") return await attachGif(attachment.query);
    return await attachPoll(attachment.options);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
