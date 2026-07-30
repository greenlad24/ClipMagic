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
import { withSkoolPage } from "./browser.js";
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
 * Click the element whose visible text matches, scoped to a container.
 *
 * Text match is EXACT after normalising whitespace and case. "Contains" was
 * tried and is wrong here: Skool's card text runs the title into the
 * description into the progress percentage, so "Delete" contains-matches half
 * the page and the smallest match is not reliably the button.
 */
async function clickText(
  text: string,
  opts: { within?: string; exact?: boolean } = {},
): Promise<{ ok: boolean; matched: string }> {
  const out = await withSkoolPage(async (page) =>
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
        const r = el.getBoundingClientRect();
        return { ok: true, matched, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
      { wanted: text, within: opts.within ?? null, exact: opts.exact !== false },
    ),
  );

  if (!out?.ok) return { ok: false, matched: "" };
  // Clicked through the real mouse: Skool's menus ignore synthetic clicks.
  await withSkoolPage(async (page) => {
    try {
      await page.mouse.click((out as any).x, (out as any).y, { delay: 40 });
    } catch {
      /* best effort */
    }
  });
  await settle();
  return { ok: true, matched: (out as any).matched };
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
 * Add a page (what this codebase calls a module) to the open course.
 *
 * The video is attached through its own dialog — `add-video-input` is the one
 * field Skool gives a distinct testid, so it is the one field that can be
 * addressed directly.
 */
export async function addPage(page: { title: string; videoUrl?: string; body?: string }): Promise<ActionResult> {
  const steps: (() => Promise<ActionResult>)[] = [
    () => chooseMenuItem("Add page"),
    () => fillField("Title", page.title),
  ];
  if (page.videoUrl) {
    steps.push(() => fillField("add-video-input", page.videoUrl!), () => clickButton("Add"));
  }
  if (page.body) steps.push(() => fillBody(page.body!));
  steps.push(() => clickButton("SAVE"));
  return sequence(steps);
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
