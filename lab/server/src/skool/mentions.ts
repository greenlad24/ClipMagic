/**
 * Writing REAL @mentions into the post composer.
 *
 * ⚠️⚠️ A MENTION CANNOT BE PASTED, AND THIS IS THE WHOLE REASON THIS FILE
 * EXISTS. Everything else the agent writes goes into the composer as one paste
 * event (`appendBody`) because the body is markdown and typing it would leave
 * literal `#` and `**` on the page. But `@Claudia Garcia` pasted as text is
 * *text*: it renders in grey, links to nobody, and — the part that matters —
 * sends no notification. A mention only notifies when it is a ProseMirror
 * mention NODE, and the only way to make one is to type `@`, wait for Skool's
 * autocomplete, and commit the entry it offers.
 *
 * The sequence was mapped against the live composer on 2026-08-27:
 *
 *   type "@denise-fer" → (≈1s) a popup appears listing "Denise Ferguson /
 *   @denise-ferguson-7626", first entry pre-highlighted → Enter → the typed
 *   characters are replaced by a blue "@Denise Ferguson" chip, and a trailing
 *   space is inserted for you.
 *
 * ⚠️ THE POPUP IS SLOWER THAN IT LOOKS. A screenshot 500 ms after the last
 * keystroke shows plain text and no popup at all — which is indistinguishable
 * from "Skool has no mention autocomplete in the post composer", and was in fact
 * the first conclusion drawn here. It arrives around a second later. Anything
 * that gives up early does not merely fail; it fails in the one direction that
 * looks like a finding about Skool.
 *
 * ⚠️ THE QUERY IS THE HANDLE, NOT THE FIRST NAME. The autocomplete matches
 * handles too, and a handle carries Skool's own disambiguating suffix
 * (`denise-ferguson-7626`), so it returns exactly one candidate. Typing "Denise"
 * in a community with two of them offers two, Enter takes the first, and the
 * wrong member is tagged in front of everybody — a mistake that cannot be
 * quietly fixed once the notification has gone out.
 */
import { focusBody } from "./actions.js";
import { withSkoolPage } from "./browser.js";
import type { SkoolMember } from "./members.js";

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long to wait for the autocomplete before deciding it is not coming. */
const POPUP_TIMEOUT_MS = 4000;
/** How often to look while waiting. */
const POPUP_POLL_MS = 250;

export interface MentionResult {
  /** Members whose chip is verifiably in the editor. */
  mentioned: SkoolMember[];
  /** Members who were dropped, and why — one line each. */
  skipped: string[];
  /** One line for the publisher's step log, success or not. */
  detail: string;
}

/** The editor's text content, or "" when there is no editor on screen. */
async function editorText(): Promise<string> {
  const text = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (!editors.length) return "";
      editors.sort((a: any, b: any) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      return String(editors[0].textContent ?? "");
    }),
  );
  return typeof text === "string" ? text : "";
}

/**
 * Wait for the autocomplete and report the handles it is offering.
 *
 * ⚠️ FOUND BY ITS CONTENT, NOT BY A CLASS. Every wrapper in the popup is a
 * styled-components hash (`sc-9634fac0-0`) that changes on Skool's next
 * redeploy. The one durable thing about a mention suggestion is that it contains
 * the text `@some-handle`, so that is what is matched — and it is matched
 * against elements OUTSIDE the editor, because the editor also contains an `@`
 * (the one just typed) and would otherwise count as its own suggestion.
 */
async function popupHandles(): Promise<string[]> {
  const found = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      const inEditor = (el: any): boolean => editors.some((ed: any) => ed.contains(el));
      const out: string[] = [];
      const seen = new Set<string>();
      for (const el of Array.from(doc.querySelectorAll("div,span,p,li,a")) as any[]) {
        if (inEditor(el)) continue;
        const r = el.getBoundingClientRect?.();
        if (!r || r.width === 0 || r.height === 0) continue;
        // The LEAF carrying the handle, not every ancestor that contains it.
        if (el.children && el.children.length > 0) continue;
        const t = String(el.textContent ?? "").trim();
        const m = /^@([a-z0-9][a-z0-9-]{2,})$/i.exec(t);
        if (!m) continue;
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        out.push(m[1]);
      }
      return out;
    }),
  );
  return Array.isArray(found) ? found : [];
}

async function waitForPopup(): Promise<string[]> {
  const until = Date.now() + POPUP_TIMEOUT_MS;
  while (Date.now() < until) {
    const handles = await popupHandles();
    if (handles.length) return handles;
    await settle(POPUP_POLL_MS);
  }
  return [];
}

/** Undo a typed run character by character, so a failure leaves no litter. */
async function backspace(times: number): Promise<void> {
  await withSkoolPage(async (page) => {
    for (let i = 0; i < times; i++) {
      try {
        await page.keyboard.press("Backspace");
      } catch {
        /* best effort */
      }
    }
  });
  await settle(300);
}

/**
 * Type the greeting's @mentions into the composer, ahead of the pasted body.
 *
 * Returns rather than throws, and a member who cannot be mentioned is DROPPED
 * rather than fatal — the same failure direction as the attachment and the email
 * switch. The words are the post; a missing chip costs one person a
 * notification, while refusing the post costs the community its Thursday.
 *
 * ⚠️ CALL THIS BEFORE THE BODY IS PASTED, NOT AFTER. `appendBody` sends the
 * caret to the end of the document and pastes there, so mentions typed first end
 * up in front of the first sentence, which is where the drafter has been told to
 * expect them. Typing them afterwards would also mean typing into a document
 * full of the body's own `@`-free prose — but with the caret parked wherever the
 * paste left it, which is not somewhere worth guessing about.
 */
export async function typeMentions(members: SkoolMember[]): Promise<MentionResult> {
  if (!members.length) return { mentioned: [], skipped: [], detail: "No members to mention." };

  if (!(await focusBody())) {
    return { mentioned: [], skipped: [], detail: "⚠ Mentions SKIPPED — no composer body on screen." };
  }

  const mentioned: SkoolMember[] = [];
  const skipped: string[] = [];

  for (const member of members) {
    const before = await editorText();
    // A separator between chips. Skool inserts a trailing space of its own after
    // a commit, so this only matters for the second chip onwards; typing it
    // unconditionally keeps the "before" length arithmetic below honest.
    const lead = mentioned.length ? " " : "";
    const typed = `${lead}@${member.handle}`;

    await withSkoolPage(async (page) => {
      try {
        await page.keyboard.type(typed, { delay: 25 });
      } catch {
        /* best effort — the verification below is what decides */
      }
    });

    const handles = await waitForPopup();
    if (!handles.length) {
      await backspace(typed.length);
      skipped.push(`${member.displayName}: the mention autocomplete never opened.`);
      continue;
    }
    // ⚠️ THE POPUP MUST BE OFFERING EXACTLY THE PERSON ASKED FOR. Enter commits
    // the highlighted entry, which is the FIRST one — so a popup whose first
    // entry is somebody else tags somebody else. Checked rather than assumed,
    // because the cost of being wrong is a notification to the wrong member.
    if (handles[0] !== member.handle) {
      await backspace(typed.length);
      skipped.push(
        `${member.displayName}: the autocomplete offered @${handles[0]} first, not @${member.handle}. ` +
          `Refusing rather than tagging the wrong member.`,
      );
      continue;
    }

    await withSkoolPage(async (page) => {
      try {
        await page.keyboard.press("Enter");
      } catch {
        /* best effort */
      }
    });
    await settle(600);

    // ⚠️ THE PROOF IS THE DISPLAY NAME, AND IT IS PROOF PRECISELY BECAUSE WE
    // NEVER TYPED IT. The keystrokes were the handle (`denise-ferguson-7626`);
    // "Denise Ferguson" can only be in the editor if Skool replaced them with a
    // real mention node. A check for the handle instead would pass on the exact
    // failure it exists to catch — the popup not committing and the typed text
    // simply staying put.
    const after = await editorText();
    if (!after.includes(member.displayName)) {
      const grew = after.length - before.length;
      await backspace(Math.max(0, grew));
      skipped.push(`${member.displayName}: pressed Enter and no mention chip appeared.`);
      continue;
    }
    mentioned.push(member);
  }

  const detail = mentioned.length
    ? `Mentioned ${mentioned.map((m) => `@${m.displayName}`).join(", ")}` +
      (skipped.length ? `; ⚠ ${skipped.length} skipped — ${skipped.join(" ")}` : "")
    : `⚠ Mentions SKIPPED — ${skipped.join(" ") || "none could be written"}; posting without them`;

  return { mentioned, skipped, detail };
}
