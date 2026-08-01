/**
 * Skool's editor, as actions rather than as recordings.
 *
 * The operator demonstrated six flows — add page, add folder, delete page,
 * delete folder, edit course settings, edit course content. Those recordings
 * are EVIDENCE, not scripts, and replaying them literally would be wrong in
 * three separate ways:
 *
 *   1. THEY ENCODE INDICES THAT MOVE. "Delete" is `dropdown-item-6` in a page's
 *      menu and `dropdown-item-3` in a folder's. The 3-dots is `nth=1` for a
 *      course card and `nth=13` for a page row. Replaying an index against a
 *      classroom that has reordered deletes the wrong thing — silently, and
 *      with a confirmation dialog that looks exactly the same.
 *   2. THEY ENCODE ONE SPECIFIC TARGET. The recording edits "Master 85% of
 *      Google Nano Banana"; the job is to edit sixty different courses.
 *   3. THEY CONTAIN THE OPERATOR'S NOISE. The same input clicked four times,
 *      CapsLock followed by seventeen individual letter keys, a stray click
 *      onto another course at the end. Faithful replay reproduces all of it.
 *
 * So what was learned from them is the VOCABULARY — which menu item, which
 * field, which button, and in what order — and that is what this file encodes.
 * Everything resolves by what a thing SAYS, never by where it sat.
 *
 * ⚠️ EVERY ACTION VERIFIES. The failure that matters here is not an exception,
 * it is a click that lands on something plausible and proceeds. So each step
 * checks the thing it expected actually appeared, and stops with a reason when
 * it did not.
 */
import { blockToHtml, bodyToHtml, headingCount, parseBody, stripLeadingTitle, wantedStructure } from "./bodyHtml.js";
import { withSkoolPage } from "./browser.js";
import { classroomUrl, courseUrl, plainTextFromSkoolDoc } from "./classroom.js";
import { clearFocusedField } from "./console.js";

export interface ActionResult {
  ok: boolean;
  /** What happened, in a sentence, for the run log. */
  detail: string;
}

const OK = (detail: string): ActionResult => ({ ok: true, detail });
const FAIL = (detail: string): ActionResult => ({ ok: false, detail });

/** Skool's own settle time. Its modals animate, and a click mid-animation misses. */
const SETTLE = 900;

async function settle(ms = SETTLE): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Scroll the page — and any scrollable container in it — to the bottom.
 *
 * ⚠️ SKOOL'S PAGE EDITOR PUTS `SAVE` BELOW THE FOLD. Jake, 2026-07-31: "to save
 * you'll need to scroll all the way to the bottom of the page and you'll see the
 * save button there." A lesson body of any length pushes it off screen, so on a
 * real page — 8,000 to 30,000 characters — it is never visible on arrival.
 *
 * Every scrollable element is scrolled, not just the window: the editor is a
 * scrolling pane inside a page that itself barely scrolls, so scrolling only the
 * window moves nothing and reports success.
 */
/** Back to the top, so viewport-banded lookups measure what they expect. */
async function scrollToTop(): Promise<void> {
  await withSkoolPage(async (page) => {
    try {
      await page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        (globalThis as any).scrollTo(0, 0);
        for (const el of Array.from(doc.querySelectorAll("*")) as any[]) {
          if (el.scrollTop > 0) el.scrollTop = 0;
        }
      });
    } catch {
      /* best effort */
    }
  });
  await settle(400);
}

async function scrollToBottom(): Promise<void> {
  await withSkoolPage(async (page) => {
    try {
      await page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        const win: any = globalThis;
        win.scrollTo(0, doc.body.scrollHeight);
        for (const el of Array.from(doc.querySelectorAll("*")) as any[]) {
          if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = el.scrollHeight;
        }
      });
    } catch {
      /* best effort — a failed scroll just means the retry finds nothing */
    }
  });
  await settle(500);
}

/**
 * Click the element whose visible text matches, scoped to a container.
 *
 * Text match is EXACT after normalising whitespace and case. "Contains" was
 * tried and is wrong here: Skool's card text runs the title into the
 * description into the progress percentage, so "Delete" contains-matches half
 * the page and the smallest match is not reliably the button.
 *
 * ⚠️ TWO THINGS ABOUT COORDINATES, BOTH LEARNED THE HARD WAY.
 *
 * `getBoundingClientRect()` is VIEWPORT-relative and `page.mouse.click` takes
 * VIEWPORT coordinates, so an element below the fold yields a y beyond the
 * viewport height. That does not throw. It clicks empty space, or whatever
 * happens to sit at those coordinates, and reports success — the silent
 * mis-click this file exists to avoid. So the element is scrolled into view and
 * its rect RE-READ before the click, and if the result still is not inside the
 * viewport the action refuses instead of clicking something else.
 *
 * And a control that is off screen may not be found at all. When the first pass
 * matches nothing, the page is scrolled to the bottom and searched once more —
 * which is what makes `SAVE` reachable.
 */
async function clickText(
  text: string,
  opts: { within?: string; exact?: boolean } = {},
): Promise<{ ok: boolean; matched: string }> {
  const locate = async () =>
    withSkoolPage(async (page) =>
      page.evaluate(
      ({ wanted, within, exact }: { wanted: string; within: string | null; exact: boolean }) => {
        const doc: any = (globalThis as any).document;
        const win: any = globalThis;
        const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const target = norm(wanted);

        let root: any = doc;
        if (within) {
          const containers = (Array.from(doc.querySelectorAll("*")) as any[]).filter(
            (el) => norm(el.textContent).includes(norm(within)) && el.getBoundingClientRect().width > 0,
          );
          // The SMALLEST container holding the label — the page body holds it too.
          containers.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
          root = containers[0] ?? doc;
        }

        const candidates = (Array.from(root.querySelectorAll("*")) as any[]).filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const cur = win.getComputedStyle?.(el)?.cursor;
          const tag = el.tagName.toLowerCase();
          const clickable = cur === "pointer" || tag === "button" || tag === "a" || el.getAttribute("role") === "button";
          if (!clickable) return false;
          const t = norm(el.textContent);
          return exact ? t === target : t.includes(target);
        });
        if (candidates.length === 0) return { ok: false, matched: "" };
        candidates.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
        const el = candidates[0];
        const matched = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);

        // Bring it into view, THEN measure. Measuring first and scrolling after
        // would hand back coordinates describing where it used to be.
        try {
          el.scrollIntoView({ block: "center", inline: "nearest" });
        } catch {
          /* older engines: the viewport check below still guards the click */
        }
        const r = el.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2);
        const y = Math.round(r.y + r.height / 2);
        const inViewport = x >= 0 && y >= 0 && x <= win.innerWidth && y <= win.innerHeight;
        return { ok: true, matched, x, y, inViewport };
      },
      { wanted: text, within: opts.within ?? null, exact: opts.exact !== false },
    ),
  );

  const first = (await locate()) as any;
  // Not found on the visible page? It may simply be below the fold — SAVE always
  // is. Scroll to the bottom and look exactly once more.
  const found = first?.ok ? first : ((await scrollToBottom(), (await locate()) as any));

  if (!found?.ok) return { ok: false, matched: "" };
  if (!found.inViewport) {
    // Refuse rather than click coordinates that are not on screen: at best it
    // does nothing, at worst it hits whatever is at that spot instead.
    return { ok: false, matched: "" };
  }

  // Clicked through the real mouse: Skool's menus ignore synthetic clicks.
  await withSkoolPage(async (page) => {
    try {
      await page.mouse.click(found.x, found.y, { delay: 40 });
    } catch {
      /* best effort */
    }
  });
  await settle();
  return { ok: true, matched: found.matched };
}

/**
 * Open the 3-dots menu belonging to a named thing.
 *
 * ⚠️ THE MENU IS SCOPED TO ITS CARD, NOT TO AN INDEX. The recordings clicked
 * `button.sc-9634fac0-9` at nth=1 and nth=13 — positions that mean nothing once
 * a course is added, removed or reordered, which is precisely what a rebuild
 * does on every step. Here the button is found INSIDE the card that carries the
 * given title, so it stays the right menu however the classroom is arranged.
 *
 * Hover first: the button does not exist in the DOM until the card is hovered.
 */
export async function openMenuFor(title: string): Promise<ActionResult> {
  const found = await withSkoolPage(async (page) =>
    page.evaluate((wanted: string) => {
      const doc: any = (globalThis as any).document;
      const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const target = norm(wanted);
      const cards = (Array.from(doc.querySelectorAll("*")) as any[]).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && norm(el.textContent).includes(target);
      });
      if (cards.length === 0) return null;
      // Smallest element containing the title is the TITLE ITSELF, not the card
      // — a one-line div whose box excludes the thumbnail the 3-dots sits on.
      // So climb until the box is big enough to be the card. Found by the menu
      // button landing outside the box and the action correctly refusing.
      cards.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      let card = cards[0];
      let hops = 0;
      while (card.parentElement && card.getBoundingClientRect().height < 200 && hops < 8) {
        card = card.parentElement;
        hops++;
      }
      const r = card.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height, left: r.x, top: r.y };
    }, title),
  );
  if (!found) return FAIL(`Could not find anything called "${title}" on this page.`);

  // Hover the card, then look for the button that appeared INSIDE it.
  await withSkoolPage(async (page) => {
    try {
      await page.mouse.move(found.x, found.y);
    } catch {
      /* best effort */
    }
  });
  await settle(700);

  const dots = await withSkoolPage(async (page) =>
    page.evaluate(
      ({ left, top, w, h }: { left: number; top: number; w: number; h: number }) => {
        const doc: any = (globalThis as any).document;
        const buttons = (Array.from(doc.querySelectorAll("button")) as any[]).filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          // Inside the card's box, and carrying no text — the 3-dots is an icon.
          const inside = r.x >= left - 4 && r.y >= top - 4 && r.x + r.width <= left + w + 4 && r.y + r.height <= top + h + 4;
          return inside && !(el.textContent || "").trim();
        });
        if (buttons.length === 0) return null;
        // The menu button sits at the card's top-right; furthest right wins.
        buttons.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
        const r = buttons[0].getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
      { left: found.left, top: found.top, w: found.w, h: found.h },
    ),
  );
  if (!dots) return FAIL(`Found "${title}" but no menu button appeared on it when hovered.`);

  await withSkoolPage(async (page) => {
    try {
      await page.mouse.click(dots.x, dots.y, { delay: 40 });
    } catch {
      /* best effort */
    }
  });
  await settle();

  // Verify a menu actually opened rather than assuming the click took.
  const open = await menuIsOpen();
  return open ? OK(`Opened the menu for "${title}".`) : FAIL(`Clicked the menu button for "${title}" but no menu opened.`);
}

/** Is a Skool dropdown currently on screen? */
async function menuIsOpen(): Promise<boolean> {
  const n = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      return doc.querySelectorAll('[data-testid^="dropdown-item-"]').length;
    }),
  );
  return (n ?? 0) > 0;
}

/**
 * Choose an item from the open dropdown BY ITS TEXT.
 *
 * ⚠️ NEVER BY `dropdown-item-N`. The recordings show why: "Delete" is item 6 in
 * a page's menu and item 3 in a folder's. The index is a property of the menu,
 * not of the action, and using it means the same recipe deletes different
 * things in different places.
 */
export async function chooseMenuItem(label: string): Promise<ActionResult> {
  if (!(await menuIsOpen())) return FAIL(`No menu is open, so "${label}" cannot be chosen.`);

  const items = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      return (Array.from(doc.querySelectorAll('[data-testid^="dropdown-item-"]')) as any[]).map((el) => ({
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
        testId: el.getAttribute("data-testid"),
        disabled: el.getAttribute("aria-disabled") === "true",
      }));
    }),
  );

  const wanted = label.trim().toLowerCase();
  const match = (items ?? []).find((i: any) => i.text.toLowerCase() === wanted);
  if (!match) {
    const seen = (items ?? []).map((i: any) => i.text).join(" · ");
    return FAIL(`No menu item called "${label}". The menu offers: ${seen}`);
  }

  const clicked = await clickText(match.text, { exact: true });
  return clicked.ok ? OK(`Chose "${match.text}" (${match.testId}).`) : FAIL(`Could not click "${label}".`);
}

/**
 * Put text into a field identified by what it SAYS — its placeholder, or the
 * value already in it.
 *
 * ⚠️ `data-testid="input-component"` IS ON EVERY INPUT SKOOL RENDERS. The
 * recordings are full of it and it identifies nothing: a modal with a name and
 * a description has two of them. The placeholder is the real handle.
 *
 * Existing content is cleared through the scoped clear, which refuses when
 * focus is not in an editable rather than letting a missed click select the
 * whole page.
 */
export async function fillField(placeholder: string, text: string): Promise<ActionResult> {
  const spot = await withSkoolPage(async (page) =>
    page.evaluate((wanted: string) => {
      const doc: any = (globalThis as any).document;
      const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const target = norm(wanted);
      const fields = (Array.from(doc.querySelectorAll("input, textarea, [contenteditable='true']")) as any[]).filter(
        (el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const ph = norm(el.getAttribute("placeholder") || "");
          const val = norm(el.value || el.textContent || "");
          const aria = norm(el.getAttribute("aria-label") || "");
          // ⚠️ TESTID FIRST. `add-video-input` is the ONE field Skool gives a
          // real testid, and it is the handle the recordings identify it by —
          // but matching only placeholders meant asking for it by that name
          // silently matched nothing at all.
          const testId = norm(el.getAttribute("data-testid") || "");
          if (testId && testId === target) return true;
          return ph === target || aria === target || (ph && ph.includes(target)) || (val && val === target);
        },
      );
      if (fields.length === 0) return null;
      const r = fields[0].getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, placeholder),
  );
  if (!spot) return FAIL(`No field matching "${placeholder}" is on screen.`);

  await withSkoolPage(async (page) => {
    try {
      await page.mouse.click(spot.x, spot.y, { delay: 40 });
    } catch {
      /* best effort */
    }
  });
  await settle(400);

  const cleared = await clearFocusedField();
  if (!cleared.cleared) return FAIL(`Clicked "${placeholder}" but could not clear it: ${cleared.reason}`);

  await withSkoolPage(async (page) => {
    try {
      // Typed as one string rather than key-by-key. The recording pressed
      // seventeen individual letters because that is how a person types; there
      // is no reason for a machine to.
      await page.keyboard.type(text, { delay: 12 });
    } catch {
      /* best effort */
    }
  });
  await settle(400);
  return OK(`Filled "${placeholder}".`);
}

/** Click a button by its label, case-insensitively — Skool ships SAVE, Save and Add. */
export async function clickButton(label: string): Promise<ActionResult> {
  const out = await clickText(label, { exact: true });
  return out.ok ? OK(`Clicked "${out.matched}".`) : FAIL(`No button called "${label}" is on screen.`);
}

/**
 * Confirm a destructive dialog.
 *
 * Both delete recordings end the same way: the menu item, then a second click
 * on a confirming "Delete". Separated out because it is the step where getting
 * it wrong is unrecoverable, and it verifies the dialog is actually present
 * rather than clicking whatever else says "Delete" on the page behind it.
 */
export async function confirmDelete(): Promise<ActionResult> {
  const present = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      // A confirmation is a dialog, or failing that a small box whose text is
      // dominated by the word delete.
      const dialogs = Array.from(doc.querySelectorAll('[role="dialog"], [role="alertdialog"]')) as any[];
      if (dialogs.some((d) => d.getBoundingClientRect().width > 0)) return true;
      const boxes = (Array.from(doc.querySelectorAll("div")) as any[]).filter((el) => {
        const r = el.getBoundingClientRect();
        const t = norm(el.textContent);
        return r.width > 200 && r.width < 700 && t.includes("delete") && t.length < 220;
      });
      return boxes.length > 0;
    }),
  );
  if (!present) return FAIL("No confirmation dialog appeared — refusing to click a stray Delete.");

  const out = await clickText("Delete", { exact: true });
  return out.ok ? OK("Confirmed the deletion.") : FAIL("A confirmation appeared but its Delete could not be clicked.");
}

/* ── Getting to the right page ─────────────────────────────────────────────
   Navigation is by URL, not by clicking through the app. The recordings click
   "Classroom" in the nav because that is what a person does; a URL is exact,
   survives a redesign of the nav, and cannot land on the wrong community.   */

/** Go to the classroom grid, optionally a later page of it. */
export async function openClassroom(communityUrl: string, gridPage = 1): Promise<ActionResult> {
  const url = classroomUrl(communityUrl, gridPage);
  if (!url) return FAIL("No community URL is set, so there is no classroom to open.");
  return goTo(url, `the classroom${gridPage > 1 ? ` (page ${gridPage})` : ""}`);
}

/** Go to one course's page, by the slug the inventory recorded. */
export async function openCourse(communityUrl: string, slug: string): Promise<ActionResult> {
  const url = courseUrl(communityUrl, slug);
  if (!url) return FAIL("No community URL or course slug, so there is no course to open.");
  const went = await goTo(url, `the course at /${slug}`);
  if (!went.ok) return went;

  // ⚠️ NAVIGATION SUCCEEDING IS NOT THE COURSE EXISTING. A wrong slug loads
  // Skool's own 404 page with a perfectly good HTTP response, so `goTo` reports
  // success and every step after it fails somewhere less obvious — the observed
  // symptom was "no icon buttons are in that part of the page", which reads like
  // a broken selector rather than a page that simply is not there.
  const missing = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const text = String(doc.body?.innerText ?? "");
      return /404 Error|this page doesn't exist/i.test(text);
    }),
  );
  if (missing) {
    return FAIL(
      `There is no course at /${slug} — Skool returned its 404 page. ` +
        `The slug is Skool's own, not one derived from the title; read it from the classroom rather than guessing it.`,
    );
  }
  return went;
}

/** Reload, so a payload read after a write describes what was written. */
async function reloadPage(): Promise<void> {
  await withSkoolPage(async (page) => {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch {
      /* best effort */
    }
  });
  await settle(2500);
}

async function goTo(url: string, what: string): Promise<ActionResult> {
  const landed = await withSkoolPage(async (page) => {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 2200));
      return String(page.url() ?? "");
    } catch (err) {
      return `ERROR:${String(err)}`;
    }
  });
  if (landed === null) return FAIL("The Skool browser is not available.");
  if (landed.startsWith("ERROR:")) return FAIL(`Could not open ${what}: ${landed.slice(6)}`);
  // Skool bounces a signed-out session to its login. Landing somewhere else is
  // not a navigation failure to shrug at — every write after it would be aimed
  // at the wrong page.
  if (/\/login|\/signup/.test(landed)) return FAIL(`Opening ${what} landed on Skool's login — the session is signed out.`);
  return OK(`Opened ${what}.`);
}

/**
 * ⚠️ SKOOL'S ICON BUTTONS HAVE NO HANDLE AT ALL — no text, no testid, no aria
 * label, and a styled-components class that is a build hash. The recordings
 * identify them by position: the 3-dots is `nth=1` in a course card and `nth=13`
 * in a page row; the pencil is `nth=7` and the add-video button `nth=21`. Those
 * numbers are properties of one page at one moment, and a rebuild changes the
 * page on every step.
 *
 * So an icon button is identified by WHAT HAPPENS WHEN IT IS CLICKED. Each
 * candidate is clicked in turn and the outcome is tested; a wrong one is undone
 * with Escape and the next is tried.
 *
 * ⚠️ THE CANDIDATE LIST MUST BE FENCED TO THE PART OF THE PAGE BEING WORKED ON.
 * The first version of this took every icon button above y=400 and worked down
 * from the top, which put Skool's OWN HEADER first: the messages icon, the
 * notification bell, the avatar. It clicked all three before ever reaching the
 * pencil, one of them navigated away from the course, and the run ended saying
 * "tried every icon button and none of them opened the page editor" — while the
 * editor sat one click away the whole time. Clicking unknown chrome in a live
 * community is also just not acceptable: it opens DMs and marks lessons
 * complete. Candidates are now confined to a rectangle the caller names.
 */
async function clickIconUntil(
  outcome: () => Promise<boolean>,
  what: string,
  opts: { minX?: number; minY?: number; maxY?: number; rightMostFirst?: boolean; limit?: number } = {},
): Promise<ActionResult> {
  if (await outcome()) return OK(`${what} was already open.`);

  // ⚠️ THE BANDS BELOW ARE VIEWPORT COORDINATES, SO SCROLL POSITION IS PART OF
  // THIS FUNCTION'S INPUT. Callers describe where a control sits as "y between
  // 0 and 240" — true only from the top of the page. Left scrolled by whatever
  // ran previously, a header 3-dots has a NEGATIVE y and the search reports that
  // the page has no icon buttons at all. That is exactly what happened once
  // `clickText` gained the ability to scroll to the bottom looking for SAVE:
  // adding a page started failing on a course that had worked minutes earlier.
  await scrollToTop();

  const spots = await withSkoolPage(async (page) =>
    page.evaluate(
      ({ minX, minY, maxY, rightMostFirst, limit }: any) => {
        const doc: any = (globalThis as any).document;
        const win: any = globalThis;
        const buttons = (Array.from(doc.querySelectorAll("button, [role='button']")) as any[]).filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          if ((el.textContent || "").trim()) return false; // icon buttons only
          if (win.getComputedStyle?.(el)?.visibility === "hidden") return false;
          return r.x >= minX && r.y >= minY && r.y <= maxY;
        });
        buttons.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rightMostFirst ? rb.x - ra.x || ra.y - rb.y : ra.y - rb.y || rb.x - ra.x;
        });
        return buttons.slice(0, limit).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
      },
      {
        minX: opts.minX ?? 0,
        minY: opts.minY ?? 0,
        maxY: opts.maxY ?? 100_000,
        rightMostFirst: opts.rightMostFirst === true,
        limit: opts.limit ?? 8,
      },
    ),
  );
  if (!spots?.length) return FAIL(`No icon buttons are in that part of the page, so ${what} cannot be reached.`);

  for (const spot of spots) {
    await withSkoolPage(async (page) => {
      try {
        await page.mouse.click(spot.x, spot.y, { delay: 40 });
      } catch {
        /* best effort */
      }
    });
    await settle(700);
    if (await outcome()) return OK(`Found ${what}.`);
    // Wrong button. Escape closes whatever it opened; a click elsewhere might
    // land on something that acts.
    await withSkoolPage(async (page) => {
      try {
        await page.keyboard.press("Escape");
      } catch {
        /* best effort */
      }
    });
    await settle(400);
  }
  return FAIL(`Tried every icon button on the page and none of them opened ${what}.`);
}

/** Does the open dropdown offer this item? Used to identify a menu by content. */
async function menuOffers(label: string): Promise<boolean> {
  const items = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      return (Array.from(doc.querySelectorAll('[data-testid^="dropdown-item-"]')) as any[]).map((el) =>
        (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase(),
      );
    }),
  );
  return (items ?? []).includes(label.trim().toLowerCase());
}

/**
 * Open the menu on an open course's own page — the one carrying "Add page".
 *
 * ⚠️ A PAGE HAS SEVERAL 3-DOTS AND THEY DO DIFFERENT THINGS. The community
 * header has one, the course has one, and every page row in the sidebar has
 * one; they are the same class and differ only by index. Choosing by index is
 * how a recording that added a page ends up deleting one. This opens menus
 * until it finds the one that OFFERS the item wanted.
 */
export async function openMenuOffering(label: string): Promise<ActionResult> {
  // ⚠️ BELOW SKOOL'S HEADER, ALWAYS. Unfenced, this swept the site chrome
  // first — messages, bell, avatar — and on a course whose lesson was on
  // screen it also clicked into the open lesson on the way past. The one
  // observed casualty was a test page that lost its write-up while keeping its
  // video, with nothing in any result to say so. Full width is deliberate: the
  // course's own 3-dots sits at the top of the left column, not in the content
  // area, and the outcome check is what tells the menus apart.
  return clickIconUntil(() => menuOffers(label), `the menu offering "${label}"`, {
    minY: CHROME_BOTTOM,
    limit: 10,
  });
}

/** Is the page editor open — is there a SAVE waiting? */
async function editorIsOpen(): Promise<boolean> {
  const yes = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      return (Array.from(doc.querySelectorAll("button")) as any[]).some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && norm(el.textContent) === "save";
      });
    }),
  );
  return yes === true;
}

/* ── Where things are ──────────────────────────────────────────────────────
   Not selectors — a fence. These keep a search for an unlabelled icon inside
   the lesson being edited, so a miss can never reach Skool's own header.     */

/** Skool's site header ends here; the page being worked on is below it. */
const CHROME_BOTTOM = 120;
/** The classroom's page sidebar ends here; the lesson itself is to the right. */
const CONTENT_LEFT = 440;

/**
 * Open the editor for the page currently being viewed — the pencil.
 *
 * ⚠️ THE PENCIL HAS A NEIGHBOUR THAT DOES CARRY A HANDLE. The pencil itself has
 * no text, no testid and no aria-label, but the button beside it is Skool's
 * completion toggle and is labelled "Mark as complete" / "Mark as incomplete".
 * Anchoring on the neighbour and taking the icon button next to it is a real
 * handle where the pencil has none — and it is stable, because the two are
 * rendered as a pair.
 *
 * The fenced sweep below it is the fallback, and it is fenced hard: a lesson
 * that has never been opened has no completion toggle to anchor on.
 */
export async function openPageEditor(): Promise<ActionResult> {
  if (await editorIsOpen()) return OK("The page editor was already open.");

  const beside = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const mark = doc.querySelector('[aria-label^="Mark as"]');
      if (!mark) return null;
      const row = mark.parentElement;
      if (!row) return null;
      const sibling = (Array.from(row.querySelectorAll("button")) as any[]).find((el) => {
        if (el === mark) return false;
        if ((el.textContent || "").trim()) return false;
        if (el.getAttribute("aria-label")) return false;
        return el.getBoundingClientRect().width > 0;
      });
      if (!sibling) return null;
      const r = sibling.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }),
  );

  if (beside) {
    await withSkoolPage(async (page) => {
      try {
        await page.mouse.click(beside.x, beside.y, { delay: 40 });
      } catch {
        /* best effort */
      }
    });
    await settle(700);
    if (await editorIsOpen()) return OK("Opened the page editor.");
  }

  return clickIconUntil(editorIsOpen, "the page editor", {
    minX: CONTENT_LEFT,
    minY: CHROME_BOTTOM,
    maxY: 600,
    rightMostFirst: true,
    limit: 4,
  });
}

/** Is Skool's video dialog on screen? Its field is the one input with a real testid. */
async function videoFieldPresent(): Promise<boolean> {
  const yes = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el = doc.querySelector('[data-testid="add-video-input"]');
      return Boolean(el && el.getBoundingClientRect().width > 0);
    }),
  );
  return yes === true;
}

/** Click a button by text, but only one living inside a `form` — a dialog's own. */
async function clickFormButton(label: string): Promise<ActionResult> {
  const spot = await withSkoolPage(async (page) =>
    page.evaluate((wanted: string) => {
      const doc: any = (globalThis as any).document;
      const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const el = (Array.from(doc.querySelectorAll("form button")) as any[]).find((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && norm(b.textContent) === norm(wanted);
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, label),
  );
  if (!spot) return FAIL(`No "${label}" button inside a dialog is on screen.`);
  await withSkoolPage(async (page) => {
    try {
      await page.mouse.click(spot.x, spot.y, { delay: 40 });
    } catch {
      /* best effort */
    }
  });
  await settle();
  return OK(`Clicked "${label}".`);
}

/** Put the caret in the lesson body without changing a character of it. */
/**
 * Refuse unless the open editor's body is empty.
 *
 * ⚠️ THIS IS THE GUARD AGAINST WRITING A LESSON ON TOP OF ANOTHER ONE, AND IT
 * EXISTS BECAUSE THAT HAPPENED AND WAS NOT NOTICED. When "Add page" fails to
 * take — the menu did not open, or the click did not land — the editor opens
 * on the page that is ALREADY selected, which is the one the previous
 * operation just wrote. The flow then retitles that page and appends the new
 * body underneath the old one. Two lessons were destroyed this way in a single
 * run of ten, and every step reported success, including the post-write check:
 * the page it looked for really did exist, because it had just renamed one.
 *
 * A brand-new page has an empty body. That is the whole invariant, it is
 * checked before a single character is typed, and it turns silent destruction
 * into a stop.
 */
async function bodyMustBeEmpty(): Promise<ActionResult> {
  const len = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (editors.length === 0) return -1;
      editors.sort((a: any, b: any) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      return String(editors[0].textContent ?? "").trim().length;
    }),
  );
  if (len === null || len === -1) return FAIL("No lesson body editor is on screen, so it cannot be confirmed empty.");
  if (len > 0) {
    return FAIL(
      `The editor already holds ${len} characters, so this is an existing lesson rather than a new page. ` +
        `Refusing to write: "Add page" did not take, and continuing would retitle that lesson and append underneath it.`,
    );
  }
  return OK("The page editor is open and empty.");
}

async function focusBody(): Promise<boolean> {
  const spot = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (editors.length === 0) return null;
      editors.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      const r = editors[0].getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(20, r.height / 2)) };
    }),
  );
  if (!spot) return false;
  await withSkoolPage(async (page) => {
    try {
      await page.mouse.click(spot.x, spot.y, { delay: 40 });
    } catch {
      /* best effort */
    }
  });
  await settle(400);
  return true;
}

/**
 * Attach a video to the page open in the editor.
 *
 * ⚠️ THE VIDEO BUTTON DOES NOTHING UNTIL THE CARET IS IN THE BODY. Clicking the
 * ▶ in the editor toolbar with focus anywhere else visibly highlights it and
 * opens nothing — no dialog, no error, no clue. It is a ProseMirror insertion,
 * so it needs somewhere to insert. Verified live: focus the body first and the
 * "Add a video" dialog opens every time.
 *
 * ⚠️ AND THE VIDEO GOES IN BEFORE THE WRITE-UP, NOT AFTER. The video is a NODE
 * IN THE BODY DOCUMENT, not a separate field — so anything that clears the body
 * deletes the video with it, and inserting at the caret after typing would put
 * the video under the text instead of above it, which is not how a single one of
 * Jake's sixty lessons reads.
 */
export async function attachVideo(url: string): Promise<ActionResult> {
  if (!url.trim()) return OK("No video to attach.");
  if (!(await editorIsOpen())) return FAIL("The page editor is not open, so a video cannot be attached.");
  if (!(await focusBody())) return FAIL("No lesson body is on screen to insert a video into.");

  // The toolbar is the row of icon buttons along the top of the editor card,
  // and the video is its right-most. Fenced to that row: a stray click on a
  // formatting button is harmless, one on Skool's header is not.
  const opened = await clickIconUntil(videoFieldPresent, "the video dialog", {
    minX: CONTENT_LEFT,
    minY: CHROME_BOTTOM,
    maxY: 220,
    rightMostFirst: true,
    limit: 4,
  });
  if (!opened.ok) return opened;

  const filled = await fillField("add-video-input", url);
  if (!filled.ok) return filled;

  // ⚠️ THERE ARE TWO "ADD" BUTTONS ON SCREEN AT THIS MOMENT. The video dialog
  // has one, and the editor's own ADD dropdown — resource link, file,
  // transcript — is still behind it. They normalise to the same text, so
  // asking for a button called "Add" is a coin toss. The dialog's lives in a
  // `form`, which is exactly what Jake's recording captured, and the
  // dropdown's does not.
  const added = await clickFormButton("Add");
  if (!added.ok) return added;
  await settle(1200); // Skool resolves the link and renders the embed.

  // Verified by the dialog having gone, not by the click landing — a rejected
  // link leaves the dialog open with the field still in it.
  return (await videoFieldPresent())
    ? FAIL(`Skool did not accept the video link "${url}" — its dialog is still open.`)
    : OK(`Attached the video ${url}.`);
}

/**
 * How long between keystrokes when we do have to type. ProseMirror only updates
 * from real input events, so the keystrokes must be real — but they need not be
 * SLOW. At the original 8–12ms a 10,000-character lesson spent two minutes
 * typing, which was most of the 245s a page took.
 */
const TYPE_DELAY_MS = Number.parseInt(process.env.SKOOL_TYPE_DELAY_MS || "1", 10);

export interface BodyStructure {
  chars: number;
  h1: number;
  h2: number;
  h3: number;
  code: number;
  strong: number;
  li: number;
}

/**
 * What the lesson body editor currently holds — length AND structure.
 *
 * Structure is the point. Jake's requirement is that headings, bolded principles
 * and fenced prompt templates survive the write, and the only way to know they
 * did is to count them in the editor afterwards. A paste that silently arrives
 * as plain text looks identical to a successful one from the outside.
 */
async function bodyStructure(): Promise<BodyStructure> {
  return withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[])
        .filter((el) => el.getBoundingClientRect().height > 40)
        .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      const el = editors[0];
      if (!el) return { chars: 0, h1: 0, h2: 0, h3: 0, code: 0, strong: 0, li: 0 };
      const n = (sel: string) => el.querySelectorAll(sel).length;
      return {
        chars: String(el.innerText ?? "").length,
        h1: n("h1"),
        h2: n("h2"),
        h3: n("h3"),
        code: n("pre, code"),
        strong: n("strong, b"),
        li: n("li"),
      };
    }),
  );
}

/** A one-line summary for the action's detail string. */
function describeStructure(s: BodyStructure): string {
  return `${s.h1} h1, ${s.h2} h2, ${s.h3} h3, ${s.code} code, ${s.strong} bold, ${s.li} list items`;
}

/**
 * Put `text` on the clipboard and paste it into the focused editor.
 *
 * One input event instead of ten thousand keystrokes — the same move Jake used
 * by hand for the video URL (⌘V, step 13 of his recording).
 *
 * ⚠️ VERIFIED BY MEASUREMENT, NOT BY THE ABSENCE OF AN EXCEPTION. A blocked
 * clipboard, a permission prompt, or an editor that ignores the paste all fail
 * SILENTLY — and a lesson that saves with an empty body is precisely the defect
 * this rebuild exists to remove. So the body is measured before and after, and
 * the result says which of three things happened rather than assuming the good
 * one.
 */
/** Caret to the very end, so the next chunk lands after the last one. */
async function moveCaretToEnd(): Promise<void> {
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.down("Control");
      await page.keyboard.press("End");
      await page.keyboard.up("Control");
    } catch {
      /* best effort */
    }
  });
}

/**
 * Hand ProseMirror one `paste` event carrying HTML, and report whether the
 * document actually grew. Growth is the only evidence that matters — dispatching
 * the event always "succeeds".
 */
async function pasteHtmlChunk(html: string, plain: string): Promise<boolean> {
  const before = (await bodyStructure()).chars;
  const dispatched = await withSkoolPage(async (page) => {
    try {
      return (await page.evaluate(
        ({ h, t }: { h: string; t: string }) => {
          const doc: any = (globalThis as any).document;
          const g: any = globalThis;
          const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[])
            .filter((el) => el.getBoundingClientRect().height > 40)
            .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
          const el = editors[0];
          if (!el) return false;
          el.focus();
          const dt = new g.DataTransfer();
          // Both flavours: the editor prefers text/html and builds real headings
          // from it; text/plain is what anything refusing HTML falls back to, so
          // the worst case is unformatted text rather than no text.
          dt.setData("text/html", h);
          dt.setData("text/plain", t);
          el.dispatchEvent(new g.ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
          return true;
        },
        { h: html, t: plain },
      )) as boolean;
    } catch {
      return false;
    }
  });
  if (!dispatched) return false;
  await settle(220);
  return (await bodyStructure()).chars > before;
}

async function pasteBody(
  text: string,
): Promise<{ outcome: "pasted" | "nothing" | "partial" | "flattened"; structure: BodyStructure }> {
  const before = await bodyStructure();
  const html = bodyToHtml(text);
  const wantedHeadings = headingCount(text);

  // ⚠️ THE ASYNC CLIPBOARD API IS NOT AVAILABLE HERE. `navigator.clipboard.write`
  // with a ClipboardItem is the obvious way to do this and it FAILS in headless
  // Chromium — permission overrides do not rescue it — so the first version of
  // this silently fell back to typing and put raw `#` and `**` characters on a
  // live page.
  //
  // A paste does not actually need the system clipboard. ProseMirror builds its
  // document from the `paste` event's DataTransfer, so handing it one directly
  // is the same input by a shorter road, and it needs no permission at all.
  // ⚠️ THE WHOLE BODY GOES IN ONE PASTE. Block-by-block was tried, on the
  // reasoning that a block the editor dislikes should only cost itself, and it
  // is WORSE: pasting `<h2>…</h2>` at a caret inside an existing paragraph makes
  // ProseMirror inline it as text, so a lesson that produced 5 h2 and 16 h3 in a
  // single paste produced ZERO of either when fed the same blocks one at a time.
  // The editor builds structure from a whole document, not from fragments.
  const wrote = await pasteHtmlChunk(html, text);
  if (!wrote) return { outcome: "nothing", structure: before };
  await settle(900);

  const after = await bodyStructure();
  const gained = after.chars - before.chars;
  // Whitespace and rich-text normalisation move the count a little, so this is
  // a proportion rather than an equality.
  if (gained < text.length * 0.6) {
    return { outcome: gained > 40 ? "partial" : "nothing", structure: after };
  }
  // The text arrived. Did its SHAPE arrive with it? Measured against what the
  // lesson ASKED FOR, not against the editor we started from: "kept none of its
  // headings" was once reported while the editor plainly held two, which told
  // nobody anything. A body wanting sixteen headings that produced two is the
  // failure worth naming, and the numbers are the useful part of naming it.
  const gotHeadings = after.h1 + after.h2 + after.h3 - (before.h1 + before.h2 + before.h3);
  if (wantedHeadings > 0 && gotHeadings < wantedHeadings * 0.6) {
    return { outcome: "flattened", structure: after };
  }
  return { outcome: "pasted", structure: after };
}

/**
 * Add to the end of the lesson body, leaving what is already there alone.
 *
 * Distinct from `fillBody`, which clears first. Clearing is right when
 * replacing a lesson's text and catastrophic once a video is in the document,
 * since the video is part of it.
 */
export async function appendBody(text: string): Promise<ActionResult> {
  if (!text.trim()) return OK("No body to write.");
  if (!(await focusBody())) return FAIL("No lesson body editor is on screen.");

  // To the very end of the document, so the write-up lands under the video.
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.down("Control");
      await page.keyboard.press("End");
      await page.keyboard.up("Control");
    } catch {
      /* best effort */
    }
  });

  const { outcome, structure } = await pasteBody(text);
  if (outcome === "partial") {
    // Half a lesson is in the document. Typing now would append the whole thing
    // again on top of it, so stop here — nothing is saved yet, and a re-run
    // starts from a clean editor.
    return FAIL("The clipboard paste landed only partially, so the body is incomplete. Nothing was saved; re-run this page.");
  }
  if (outcome === "flattened") {
    return FAIL(
      `The body lost its formatting: it asked for ${wantedStructure(text).headings} headings and ` +
        `${wantedStructure(text).code} templates, and the editor kept ${describeStructure(structure)}. ` +
        `Not saving — an unformatted wall of text is what this rewrite exists to remove.`,
    );
  }
  if (outcome === "nothing") {
    await withSkoolPage(async (page) => {
      try {
        await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
      } catch {
        /* best effort */
      }
    });
    await settle(400);
    return OK("Wrote the lesson body (typed — the clipboard was unavailable).");
  }
  await settle(400);
  return OK(`Wrote the lesson body (pasted: ${describeStructure(structure)}).`);
}

/* ── Reading the grid ──────────────────────────────────────────────────────
   Every write here has to answer "where is that course, and is it there at
   all", and the answer has to come from Skool rather than from anything this
   process remembers — a rebuild moves courses between grid pages on almost
   every step.                                                               */

interface GridCourse {
  title: string;
  slug: string;
  /** Which page of the grid it is on, so a card can be brought on screen. */
  page: number;
}

/** The grid page currently open, read from its payload rather than its cards. */
async function readOpenGrid(): Promise<{ courses: Omit<GridCourse, "page">[]; total: number | null } | null> {
  const grid = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el = doc.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return null;
      try {
        const pp = JSON.parse(el.textContent)?.props?.pageProps;
        if (!Array.isArray(pp?.allCourses)) return null;
        return {
          // ⚠️ A GRID ENTRY IS FLAT. The wrapper trap — `{ course: {...} }` —
          // is in the course TREE, not here. Unwrapping `.course` on a grid
          // entry yields `undefined`, so every title reads as "" and the list
          // is the right LENGTH with nothing in it: a course lookup that
          // matches nothing, a "does it exist" that always says no, and a
          // delete that reports success without checking. Tolerant of both
          // shapes so it survives whichever way Skool changes.
          courses: pp.allCourses.map((node: any) => {
            const c = node?.course ?? node;
            return { title: String(c?.metadata?.title ?? ""), slug: String(c?.name ?? "") };
          }),
          total: Number(pp?.currentGroup?.metadata?.numCourses ?? 0) || null,
        };
      } catch {
        return null;
      }
    }),
  );
  return grid ?? null;
}

/** A runaway guard, not a limit anyone is expected to reach. */
const MAX_GRID_PAGES = 40;

/**
 * Walk the whole grid.
 *
 * ⚠️ ERRORS ARE RETURNED, NEVER FOLDED INTO AN EMPTY LIST. "I read the
 * classroom and the course is not in it" and "I could not read the classroom"
 * look identical to a caller that only gets a list back — and the second one
 * reaching `deleteCourse`'s verification would report a course successfully
 * deleted because nothing could be seen.
 */
async function readGrid(communityUrl: string): Promise<{ courses: GridCourse[]; pages: number; error: string | null }> {
  const courses: GridCourse[] = [];
  const seen = new Set<string>();
  let pages = 1;

  for (let p = 1; p <= MAX_GRID_PAGES; p++) {
    const opened = await openClassroom(communityUrl, p);
    if (!opened.ok) return { courses, pages, error: opened.detail };
    const grid = await readOpenGrid();
    if (!grid) {
      return {
        courses,
        pages,
        error: `Page ${p} of the classroom carried no course payload — the session may have been signed out.`,
      };
    }
    pages = p;
    const fresh = grid.courses.filter((c) => c.slug && !seen.has(c.slug));
    for (const c of fresh) {
      seen.add(c.slug);
      courses.push({ ...c, page: p });
    }
    // Skool serves the last page again for an out-of-range `p` rather than an
    // error, so a page that adds nothing is the end of the grid.
    if (fresh.length === 0) break;
    if (grid.total != null && courses.length >= grid.total) break;
  }

  return { courses, pages, error: null };
}

const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Create a course.
 *
 * ⚠️ "NEW COURSE" IS ON THE LAST PAGE OF THE GRID, NOT THE FIRST. The grid
 * paginates at 30 — the same fact that made a 60-course classroom read as 30 —
 * and the tile that creates a course is the last tile of the last page. The
 * recording clicks the "2" pagination button first, and it does so because it
 * has to.
 *
 * ⚠️ WHICH page that is CANNOT BE A CONSTANT. This classroom sits at 61
 * courses — three pages, not the two the recording was made against — and a
 * rebuild that creates fifteen courses and deletes sixty crosses a page
 * boundary in both directions while it runs. So the last page is looked up
 * every time.
 *
 * The two fields carry real aria-labels ("Course name", "Course description"),
 * which makes this the one Skool dialog that can be addressed directly.
 */
export async function createCourse(communityUrl: string, name: string, description: string): Promise<ActionResult> {
  const before = await readGrid(communityUrl);
  if (before.error) return FAIL(`The classroom could not be read, so a course cannot be added to it: ${before.error}`);
  if (before.courses.some((c) => norm(c.title) === norm(name))) {
    return OK(`"${name}" is already in the classroom — left alone.`);
  }

  return sequence([
    () => openClassroom(communityUrl, before.pages),
    () => clickButton("New course"),
    () => fillField("Course name", name),
    ...(description ? [() => fillField("Course description", description)] : []),
    () => clickButton("Add"),
    // Verified by the course existing, not by the click landing. The dialog
    // closing looks the same whether Skool accepted it or rejected the name.
    () => courseExists(communityUrl, name),
  ]);
}

/** Confirm a course of this name is in the classroom, whichever grid page it is on. */
export async function courseExists(communityUrl: string, name: string): Promise<ActionResult> {
  const grid = await readGrid(communityUrl);
  if (grid.error) return FAIL(`The classroom could not be read: ${grid.error}`);
  return grid.courses.some((c) => norm(c.title) === norm(name))
    ? OK(`"${name}" is in the classroom.`)
    : FAIL(`"${name}" is not in the classroom after checking all ${grid.pages} pages of the grid.`);
}

/**
 * Find a course's slug by its title, across every page of the grid.
 *
 * A course created a minute ago has a slug nobody knows yet, so the only way
 * to open it is to look it up. Read from `__NEXT_DATA__` rather than the
 * rendered grid — a payload either parses or it does not, where a selector can
 * quietly match the wrong card.
 */
export async function findCourseSlug(communityUrl: string, title: string): Promise<string | null> {
  const grid = await readGrid(communityUrl);
  return grid.courses.find((c) => norm(c.title) === norm(title))?.slug ?? null;
}

/** The titles of the pages already inside the open course. */
export interface OpenCoursePage {
  title: string;
  /**
   * ⚠️ THIS IS ONLY TRUE FOR THE PAGE THE URL SELECTED. NEVER DELETE, REWRITE
   * OR PLAN AROUND IT FOR ANY OTHER PAGE.
   *
   * Skool ships `metadata.desc` for the selected unit alone; every sibling in
   * the payload carries `""`. So a listing of a ten-page course reports nine of
   * them empty however much is written in them — which is exactly how 60
   * modules full of prompts came to be measured as hollow and planned for
   * deletion. `readCourse` visits `?md=<unitId>` per unit to get the truth;
   * this listing does not, because its callers want the page ORDER and the
   * titles, and one navigation per page would make every write ten times
   * slower for a field they do not use.
   *
   * Its one honest use is the post-write check below, where the page just
   * saved IS the selected one. Being wrong there fails a write that worked,
   * which costs a re-run — not a lesson.
   */
  empty: boolean;
}

/**
 * ⚠️ NULL MEANS "COULD NOT READ", AND IT IS NOT THE SAME AS AN EMPTY COURSE.
 * Folding the two together is what made a fresh course's blank seeded page
 * invisible: the payload was read under the wrong key, the list came back
 * empty, and an empty list reads as a perfectly ordinary answer.
 */
export async function pagesInOpenCourse(): Promise<OpenCoursePage[] | null> {
  const raw = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el = doc.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return null;
      const out: { title: string; videoLink: string; desc: string }[] = [];
      const walk = (node: any, depth: number): void => {
        if (!node) return;
        // ⚠️ EVERY NODE IN A COURSE TREE IS A WRAPPER — the real fields are on
        // `.course`. Reading straight through gives the right number of units
        // with nothing in any of them.
        const c = node.course ?? node;
        const m = c?.metadata ?? {};
        const t = m.title;
        // ⚠️ DEPTH IS THE TEST FOR THE ROOT, NOT `unitType`. The root node is
        // the course itself and is not a page, but its `unitType` is not
        // reliably "course" in the wild — so it was being listed as a page. Two
        // consequences, both seen live: every count was one too high, and the
        // "is this a fresh course with only its seeded blank page?" check never
        // fired, because that course reported TWO pages (root + "New page").
        // Which meant every new course kept a hollow "New page" forever — the
        // exact defect the rebuild exists to remove, produced by the rebuild.
        // Same rule, same reason, as isCourseRootUnit in classroom.ts.
        if (depth > 0 && typeof t === "string" && t.trim() && m.unitType !== "course") {
          out.push({ title: t.trim(), videoLink: String(m.videoLink ?? ""), desc: String(m.desc ?? "") });
        }
        for (const child of node.children ?? []) walk(child, depth + 1);
      };
      try {
        const pp = JSON.parse(el.textContent)?.props?.pageProps;
        // ⚠️ BOTH KEYS EXIST IN THE WILD — `readCourse` has always tolerated
        // either, and reading only `course` is why the first page written into
        // a fresh course did not reuse the blank one Skool seeded it with: the
        // tree came back undefined, the course looked EMPTY rather than
        // unreadable, and "there is no blank page here" was the wrong
        // conclusion drawn from no data at all.
        walk(pp?.course ?? pp?.currentCourse ?? null, 0);
      } catch {
        return null;
      }
      return out;
    }),
  );
  if (!raw) return null;
  // Emptiness is decided out here, where the `[v2]` ProseMirror body can
  // actually be flattened rather than guessed at by its raw length.
  return (raw as { title: string; videoLink: string; desc: string }[]).map((p) => ({
    title: p.title,
    empty: !p.videoLink.trim() && plainTextFromSkoolDoc(p.desc).trim().length === 0,
  }));
}

/** What Skool calls a page it has just made for you. */
const SEEDED_PAGE_TITLE = "New page";

/**
 * Add a page to the course currently open, with its video and its body.
 *
 * The order is the operator's, and it matters: the page is created first and
 * then filled, because Skool's editor only exists once there is a page for it
 * to edit.
 *
 * ⚠️ EVERY COURSE SKOOL CREATES IS BORN WITH AN EMPTY PAGE CALLED "New page".
 * Creating fifteen spine courses therefore creates fifteen hollow pages for
 * free — a title with no video and no text, which is EXACTLY the defect this
 * whole rebuild exists to remove, reintroduced by the rebuild itself. So the
 * first page written into a fresh course RENAMES THE SEEDED ONE instead of
 * adding beside it.
 *
 * Only when it is the course's ONLY page. A blank "New page" sitting among
 * real ones is ambiguous — there can be several, and picking the wrong one
 * overwrites a lesson — so that case adds a page as normal and the leftover is
 * dealt with by looking at it.
 */
export async function addPageToOpenCourse(page: {
  title: string;
  videoUrl?: string | null;
  body?: string;
}): Promise<ActionResult> {
  const existing = await pagesInOpenCourse();
  if (!existing) {
    return FAIL("The open course's contents could not be read, so a page cannot safely be added to it.");
  }
  if (existing.some((p) => norm(p.title) === norm(page.title))) {
    return OK(`"${page.title}" is already a page in this course — left alone.`);
  }

  const seeded = existing.length === 1 && existing[0].empty && norm(existing[0].title) === norm(SEEDED_PAGE_TITLE);

  // A seeded course already displays its one blank page, so there is nothing to
  // create and nothing to select — the editor opens straight onto it.
  const steps: (() => Promise<ActionResult>)[] = seeded
    ? [async () => OK(`Reusing the empty "${SEEDED_PAGE_TITLE}" this course was created with.`)]
    : [() => openMenuOffering("Add page"), () => chooseMenuItem("Add page")];

  steps.push(
    () => openPageEditor(),
    // Before a single character is typed. See bodyMustBeEmpty.
    () => bodyMustBeEmpty(),
    () => fillPageTitle(page.title),
    // Video BEFORE the write-up: it is a node in the body document, so the
    // text has to be appended under it rather than the video dropped after.
    ...(page.videoUrl ? [() => attachVideo(page.videoUrl!)] : []),
    // Title stripped here: Skool renders it above the body already.
    ...(page.body ? [() => appendBody(stripLeadingTitle(page.body!))] : []),
    () => clickButton("SAVE"),
  );

  const done = await sequence(steps);
  if (!done.ok) return done;

  // Verified in Skool's own payload, not by the SAVE click landing.
  //
  // ⚠️ `__NEXT_DATA__` IS THE PAGE-LOAD SNAPSHOT AND NEVER UPDATES. Skool saves
  // over the network and re-renders from React; the JSON blob in the HTML still
  // describes the course as it was when the tab opened. Reading it straight
  // after a save reports the new page missing — which is the most alarming
  // possible way to be told a write worked. The reload is what makes the check
  // mean anything.
  await reloadPage();
  const after = await pagesInOpenCourse();
  if (!after) return FAIL(`${done.detail} → but the course could not be re-read to confirm it.`);
  const landed = after.find((p) => norm(p.title) === norm(page.title));
  if (!landed) return FAIL(`${done.detail} → but "${page.title}" is not in the course afterwards.`);
  if (landed.empty && (page.videoUrl || page.body)) {
    return FAIL(`${done.detail} → but "${page.title}" saved with neither its video nor its body.`);
  }
  return OK(`${done.detail} → "${page.title}" is in the course.`);
}

/**
 * Put the title into the page editor.
 *
 * ⚠️ THE PAGE TITLE FIELD HAS NEITHER A PLACEHOLDER NOR AN ARIA LABEL — the
 * recording shows only `data-testid="input-component"`, which is on every input
 * Skool renders. So it is identified by SHAPE AND POSITION WITHIN THE EDITOR:
 * the topmost single-line text input. Narrow, and stated as such, rather than
 * dressed up as a stable handle.
 */
export async function fillPageTitle(title: string): Promise<ActionResult> {
  const spot = await withSkoolPage(async (p) =>
    p.evaluate(
      ({ left, top }: { left: number; top: number }) => {
        const doc: any = (globalThis as any).document;
        const inputs = (Array.from(doc.querySelectorAll("input[type='text'], input:not([type])")) as any[]).filter(
          (el) => {
            const r = el.getBoundingClientRect();
            if (r.width <= 120 || r.height <= 0) return false;
            if (el.getAttribute("data-testid") === "add-video-input") return false;
            // ⚠️ "THE TOPMOST INPUT" IS SKOOL'S SEARCH BOX. It sits in the site
            // header above everything, so an unfenced search for the title
            // field clicks it every time — and then the title never gets typed
            // and the failure reads as "nothing is focused", which points
            // nowhere near the actual cause.
            return r.x >= left && r.y >= top;
          },
        );
        if (inputs.length === 0) return null;
        inputs.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
        const r = inputs[0].getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
      { left: CONTENT_LEFT, top: CHROME_BOTTOM },
    ),
  );
  if (!spot) return FAIL("No title field is on screen in the page editor.");

  await withSkoolPage(async (p) => {
    try {
      await p.mouse.click(spot.x, spot.y, { delay: 40 });
    } catch {
      /* best effort */
    }
  });
  await settle(400);
  const cleared = await clearFocusedField();
  if (!cleared.cleared) return FAIL(`Clicked the title field but could not clear it: ${cleared.reason}`);
  await withSkoolPage(async (p) => {
    try {
      await p.keyboard.type(title, { delay: 12 });
    } catch {
      /* best effort */
    }
  });
  await settle(400);
  return OK(`Titled the page "${title}".`);
}

/**
 * Delete a course from the classroom grid.
 *
 * ⚠️ THE ONE ACTION HERE WITH NO UNDO. It refuses unless the card's own menu
 * opened — the same menu that offers "Edit course", which proves the target is
 * a course card and not something else that happens to carry the same words.
 */
export async function deleteCourse(communityUrl: string, title: string): Promise<ActionResult> {
  const grid = await readGrid(communityUrl);
  if (grid.error) return FAIL(`The classroom could not be read, so nothing will be deleted: ${grid.error}`);

  const target = grid.courses.find((c) => norm(c.title) === norm(title));
  if (!target) return FAIL(`No course called "${title}" is in the classroom, so there is nothing to delete.`);

  // Its card has to be on screen for its own menu to be reachable.
  const opened = await openClassroom(communityUrl, target.page);
  if (!opened.ok) return opened;

  const menu = await openMenuFor(title);
  if (!menu.ok) return menu;
  if (!(await menuOffers("Delete course"))) {
    return FAIL(`The menu that opened for "${title}" is not a course menu — refusing to delete anything.`);
  }
  const chosen = await chooseMenuItem("Delete course");
  if (!chosen.ok) return chosen;
  const confirmed = await confirmDelete();
  if (!confirmed.ok) return confirmed;

  // ⚠️ VERIFIED AGAINST A GRID THAT ACTUALLY READ. An unreadable classroom
  // also contains no courses, and reporting "deleted" on the strength of that
  // would be a false success on the one action with no undo.
  const after = await readGrid(communityUrl);
  if (after.error) {
    return FAIL(`Clicked through the deletion of "${title}" but the classroom could not be re-read to confirm it: ${after.error}`);
  }
  return after.courses.some((c) => norm(c.title) === norm(title))
    ? FAIL(`Clicked through the deletion of "${title}" but it is still in the classroom.`)
    : OK(`Deleted "${title}".`);
}

/* ── The flows, composed ───────────────────────────────────────────────────
   Each is the SHAPE the operator demonstrated, with the specifics as
   parameters. What was learned from six recordings of six particular things
   is how to do those six things to anything.                                */

/** Every step must succeed; the first failure stops and explains itself. */
async function sequence(steps: (() => Promise<ActionResult>)[]): Promise<ActionResult> {
  const log: string[] = [];
  for (const step of steps) {
    const out = await step();
    log.push(out.detail);
    if (!out.ok) return FAIL(log.join(" → "));
  }
  return OK(log.join(" → "));
}

/**
 * Rename/redescribe a course — the "Edit course" dialog on a card's menu.
 *
 * The recording typed into "Course name" and "Course description", both of
 * which are `input-component`; they are told apart by their placeholders.
 */
export async function editCourseSettings(
  courseTitle: string,
  fields: { name?: string; description?: string },
): Promise<ActionResult> {
  return sequence([
    () => openMenuFor(courseTitle),
    () => chooseMenuItem("Edit course"),
    ...(fields.name ? [() => fillField("Course name", fields.name!)] : []),
    ...(fields.description ? [() => fillField("Course description", fields.description!)] : []),
    () => clickButton("Save"),
  ]);
}

/** Add a folder to the classroom. Menu → "Add folder" → Name → Add. */
export async function addFolder(name: string): Promise<ActionResult> {
  return sequence([() => chooseMenuItem("Add folder"), () => fillField("Name", name), () => clickButton("Add")]);
}

/**
 * Write the lesson body — the big rich-text area, which has no placeholder to
 * match on and is therefore found as the page's contenteditable.
 */
export async function fillBody(text: string): Promise<ActionResult> {
  const spot = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 40,
      );
      if (editors.length === 0) return null;
      // The tallest editable is the body; a title field can also be editable.
      editors.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      const r = editors[0].getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(30, r.height / 2)) };
    }),
  );
  if (!spot) return FAIL("No lesson body editor is on screen.");

  await withSkoolPage(async (page) => {
    try {
      await page.mouse.click(spot.x, spot.y, { delay: 40 });
    } catch {
      /* best effort */
    }
  });
  await settle(400);
  const cleared = await clearFocusedField();
  if (!cleared.cleared) return FAIL(`Could not clear the lesson body: ${cleared.reason}`);
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.type(text, { delay: 8 });
    } catch {
      /* best effort */
    }
  });
  await settle(400);
  return OK("Wrote the lesson body.");
}

/**
 * Click a page in the course's left-hand list, by exact title.
 *
 * Constrained to the left column by x, because the page's own heading in the
 * content pane carries the same text and is the larger, more tempting target.
 */
export async function openPageByTitle(title: string): Promise<ActionResult> {
  await scrollToTop();
  const spot = await withSkoolPage(async (page) =>
    page.evaluate(
      ({ wanted, maxX }: { wanted: string; maxX: number }) => {
        const doc: any = (globalThis as any).document;
        const win: any = globalThis;
        const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const target = norm(wanted);
        const hits = (Array.from(doc.querySelectorAll("*")) as any[]).filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || r.x > maxX) return false;
          if (win.getComputedStyle?.(el)?.cursor !== "pointer") return false;
          return norm(el.textContent) === target;
        });
        if (!hits.length) return null;
        hits.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
        const r = hits[0].getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
      { wanted: title, maxX: 460 },
    ),
  );
  if (!spot) return FAIL(`No page called "${title}" is listed in this course.`);
  await withSkoolPage(async (page) => {
    try {
      await page.mouse.click(spot.x, spot.y, { delay: 40 });
    } catch {
      /* best effort */
    }
  });
  await settle(1200);
  return OK(`Opened the page "${title}".`);
}

/** Flattened length of one page's body, read from the payload after a reload. */
async function pageBodyLength(title: string): Promise<number | null> {
  const pages = await pagesInOpenCourse();
  if (!pages) return null;
  const raw = await withSkoolPage(async (page) =>
    page.evaluate(
      ({ wanted }: { wanted: string }) => {
        const doc: any = (globalThis as any).document;
        const el = doc.getElementById("__NEXT_DATA__");
        if (!el?.textContent) return null;
        const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        let found: string | null = null;
        const walk = (node: any): void => {
          if (!node || found !== null) return;
          const c = node.course ?? node;
          const m = c?.metadata ?? {};
          if (typeof m.title === "string" && norm(m.title) === norm(wanted) && m.unitType !== "course") {
            found = String(m.desc ?? "");
            return;
          }
          for (const child of node.children ?? []) walk(child);
        };
        try {
          const pp = JSON.parse(el.textContent)?.props?.pageProps;
          walk(pp?.course ?? pp?.currentCourse ?? null);
        } catch {
          return null;
        }
        return found;
      },
      { wanted: title },
    ),
  );
  if (raw === null || raw === undefined) return null;
  return plainTextFromSkoolDoc(String(raw)).trim().length;
}

/**
 * Empty the lesson body, and PROVE it is empty before returning.
 *
 * ⚠️ `clearFocusedField` REPORTED SUCCESS ON A BODY IT DID NOT CLEAR. The
 * rewrite then appended, and the page ended up holding the same 11,000-character
 * lesson twice — 15 h2 where the lesson has 8, 22,489 characters where it has
 * 11,479. Nothing in the run said so, because every step had said "ok".
 *
 * So the field is measured, not trusted: clear, count, and if anything survives,
 * clear again with a select-all and a real Delete. Still not empty means the
 * rewrite stops — appending onto stale text is the one outcome worse than not
 * writing at all.
 */
async function clearBodyOrFail(): Promise<ActionResult> {
  if (!(await focusBody())) return FAIL("No lesson body editor is on screen.");

  const before = (await bodyStructure()).chars;
  await clearFocusedField();
  await settle(400);
  let left = (await bodyStructure()).chars;

  if (left > 40) {
    // Second attempt: select the whole field and delete it with real keystrokes.
    // ProseMirror updates from real input events, so a programmatic wipe leaves
    // the editor's own model untouched no matter how empty the DOM looks.
    await withSkoolPage(async (page) => {
      try {
        await page.keyboard.down("Control");
        await page.keyboard.press("KeyA");
        await page.keyboard.up("Control");
        await page.keyboard.press("Delete");
      } catch {
        /* measured below either way */
      }
    });
    await settle(500);
    left = (await bodyStructure()).chars;
  }

  if (left > 40) {
    return FAIL(
      `The existing body would not clear — ${left} characters of the old lesson are still there ` +
        `(was ${before}). Stopping rather than writing the new lesson underneath the old one.`,
    );
  }
  return OK(`Cleared the existing body (${before} characters removed).`);
}

/**
 * Replace an existing page's body — the repeatable write.
 *
 * ⚠️ THE REASON THIS EXISTS: `addPage` skips a title that is already present,
 * so a page whose first write failed stays empty forever and every retry
 * cheerfully reports "left alone". Rewriting is what makes a lesson re-runnable,
 * which in turn is what makes a bad lesson fixable without deleting anything.
 *
 * ⚠️ CLEARING THE BODY REMOVES THE VIDEO WITH IT — the video is a node inside
 * the body document, not a field beside it. So the video is re-attached after
 * the clear and before the text, in the same order `addPage` uses.
 *
 * Ends by reading the page back from Skool's own payload. The click sequence
 * completing has already proved to be no evidence at all that a page was
 * written: four pages once reported "is in the course" and two of them were not.
 */
export async function rewritePage(opts: {
  title: string;
  videoUrl?: string | null;
  body: string;
}): Promise<ActionResult> {
  const steps: (() => Promise<ActionResult>)[] = [
    () => openPageByTitle(opts.title),
    () => openPageEditor(),
    () => clearBodyOrFail(),
    ...(opts.videoUrl ? [() => attachVideo(opts.videoUrl!)] : []),
    () => appendBody(stripLeadingTitle(opts.body)),
    () => clickButton("SAVE"),
  ];
  const wrote = await sequence(steps);
  if (!wrote.ok) return wrote;

  await reloadPage();
  const len = await pageBodyLength(opts.title);
  if (len === null) {
    return FAIL(`${wrote.detail} → Saved, but the page could not be read back, so the write is unconfirmed.`);
  }
  if (len < 200) {
    return FAIL(`${wrote.detail} → Saved, but reading "${opts.title}" back shows only ${len} characters. The body did not stick.`);
  }
  return OK(`${wrote.detail} → Read back: ${len} characters on the page.`);
}

/** Retitle and rewrite the page currently open in the editor. */
export async function editPageContent(fields: { title?: string; body?: string }): Promise<ActionResult> {
  const steps: (() => Promise<ActionResult>)[] = [];
  if (fields.title) steps.push(() => fillField("Title", fields.title!));
  if (fields.body) steps.push(() => fillBody(fields.body!));
  steps.push(() => clickButton("SAVE"));
  return sequence(steps);
}

/**
 * Delete a page or a folder by name.
 *
 * One function for both, because the only thing that differs is the menu
 * item's wording — which is exactly the sort of difference the recordings
 * encoded as an index (item 6 versus item 3) and which must not be.
 */
export async function deleteThing(name: string, kind: "page" | "folder"): Promise<ActionResult> {
  return sequence([
    () => openMenuFor(name),
    () => chooseMenuItem(kind === "folder" ? "Delete folder" : "Delete"),
    () => confirmDelete(),
  ]);
}
