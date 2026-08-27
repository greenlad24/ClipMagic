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
 * ⚠️⚠️ NOTE WHAT THAT EXAMPLE TYPES: A PREFIX, NOT THE HANDLE. This file's first
 * version then typed the WHOLE handle, suffix and all, and the difference went
 * unnoticed for as long as the mentions were never verified from the member's
 * side. Skool's suggestion search does not match the numeric suffix, so
 * "@denise-ferguson-7626" opens nothing whatever. See `typeMentions`.
 *
 * ⚠️ THE POPUP IS SLOWER THAN IT LOOKS. A screenshot 500 ms after the last
 * keystroke shows plain text and no popup at all — which is indistinguishable
 * from "Skool has no mention autocomplete in the post composer", and was in fact
 * the first conclusion drawn here. It arrives around a second later. Anything
 * that gives up early does not merely fail; it fails in the one direction that
 * looks like a finding about Skool.
 *
 * ⚠️⚠️ AND A CHIP IN A POST DOES NOT NOTIFY — USE THIS IN A COMMENT. Jake,
 * 2026-08-27: "we can't tag people directly in the post itself". Everything
 * below was proven against the post composer and the chip demonstrably went in;
 * the members still did not hear about it. The weekly greeting therefore types
 * its mentions into the first COMMENT (`postComment.ts`), where the same
 * sequence works and the notification actually arrives. Do not move it back
 * into the post body without evidence that Skool has changed.
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
 * Wait for the autocomplete and report the handles it is offering, IN ORDER.
 *
 * ⚠️⚠️ THE ORDER IS THE SAFETY, NOT A DETAIL. Enter commits the highlighted
 * entry, which is the first one, so `handles[0]` is what the caller checks
 * against the member it asked for. Anything that returns the right handles in
 * the wrong order tags the wrong person.
 *
 * ⚠️⚠️ SKOOL RENDERS A SUGGESTION AS ONE NODE, AND MATCHING A LEAF THAT READS
 * EXACTLY "@handle" FOUND NOTHING IN A COMMENT. Measured 2026-08-27 on a live
 * post: the comment box's popup is `div.skool-editor-suggestion-list` inside a
 * tippy box, and its entry's text is `Claudia Garcia@claudia-garcia-3172` — the
 * display name and the handle concatenated, with no leaf holding the handle on
 * its own. The old matcher required that leaf, so it reported "the autocomplete
 * never opened" while the autocomplete was open on screen, and every mention in
 * a comment was silently skipped.
 *
 * So there are two readers, in order of how much they can be trusted:
 *   1. THE SUGGESTION LIST BY NAME. `skool-editor-suggestion-list` is Skool's
 *      own class on its tiptap suggestion renderer — not a styled-components
 *      hash — and its direct children are the entries, in the order shown.
 *   2. A CONTENT SCAN, for the day that class changes. Any visible element
 *      outside the editor whose text ENDS in `@handle`, preferring the smallest
 *      such element so an ancestor wrapping two entries cannot answer for both.
 */
async function popupHandles(): Promise<string[]> {
  const found = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      // ⚠️⚠️ ANCESTORS OF THE EDITOR ARE EXCLUDED TOO, AND LEAVING THEM IN COST
      // A WHOLE DEBUGGING CYCLE. The composer's wrapper divs CONTAIN the editor,
      // so `ed.contains(el)` is false for them while their `textContent`
      // includes every character just typed — meaning the wrapper's text ends in
      // "@denise-ferguson-7626" the instant it is typed, matches the handle
      // being waited for, and `waitForPopup` returns on its first poll. Enter is
      // then pressed before Skool's suggestion list has rendered, and the result
      // is "pressed Enter and no mention chip appeared" on a mention that would
      // have worked. The editor and everything around it is off limits; only the
      // popup counts.
      const related = (el: any): boolean =>
        editors.some((ed: any) => ed.contains(el) || el.contains(ed));
      const visible = (el: any): boolean => {
        const r = el.getBoundingClientRect?.();
        return !!r && r.width > 0 && r.height > 0;
      };
      // A handle at the END of the text: "@denise-ferguson-7626" on its own, and
      // "Denise Ferguson@denise-ferguson-7626" alike.
      const handleOf = (text: string): string | null => {
        const m = /@([a-z0-9][a-z0-9-]{2,})\s*$/i.exec(String(text ?? "").trim());
        return m ? m[1] : null;
      };

      const list = (Array.from(doc.querySelectorAll(".skool-editor-suggestion-list")) as any[]).find(
        (el) => visible(el) && !related(el),
      );
      if (list) {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const item of Array.from(list.children) as any[]) {
          const h = handleOf(item.textContent);
          if (!h || seen.has(h)) continue;
          seen.add(h);
          out.push(h);
        }
        // A list that is on screen but whose children carry no handle is a real
        // finding, not a reason to fall through and guess from the page.
        if (out.length) return out;
      }

      const hits: { el: any; handle: string }[] = [];
      for (const el of Array.from(doc.querySelectorAll("div,span,p,li,a")) as any[]) {
        if (related(el) || !visible(el)) continue;
        const h = handleOf(el.textContent);
        if (!h) continue;
        hits.push({ el, handle: h });
      }
      // ⚠️ WRAPPERS DROPPED, DOCUMENT ORDER KEPT — and the order is why this is
      // not simply "take the shortest". A wrapper around two suggestions ends in
      // the SECOND one's handle and would answer for the first; sorting by
      // length would fix that and lose the running order, which is the one thing
      // `handles[0]` depends on.
      const out: string[] = [];
      const seen = new Set<string>();
      for (const hit of hits) {
        if (hits.some((other) => other !== hit && hit.el.contains(other.el))) continue;
        if (seen.has(hit.handle)) continue;
        seen.add(hit.handle);
        out.push(hit.handle);
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

    // ⚠️⚠️ THE WHOLE HANDLE FINDS NOBODY IN A COMMENT. Measured live
    // 2026-08-27: typing "@claudia-garcia-3172" opens no autocomplete at all,
    // while "@claudia-garc" opens one offering exactly her. Skool's suggestion
    // search does not match its own numeric suffix — the part it appends to
    // make handles unique — so the query that looks the most precise is the one
    // that returns nothing. Typed as a person would type it: the name part
    // first, the full handle only as a fallback for a community where the
    // shorter query genuinely finds nobody.
    const queries = Array.from(new Set([member.handle.replace(/-\d{2,}$/, ""), member.handle])).filter(Boolean);

    let handles: string[] = [];
    let typed = "";
    for (const query of queries) {
      typed = `${lead}@${query}`;
      await withSkoolPage(async (page) => {
        try {
          await page.keyboard.type(typed, { delay: 25 });
        } catch {
          /* best effort — the verification below is what decides */
        }
      });
      handles = await waitForPopup();
      if (handles.length) break;
      // Undo this attempt before trying the next spelling, or the second query
      // is typed onto the end of the first.
      await backspace(typed.length);
    }

    if (!handles.length) {
      skipped.push(
        `${member.displayName}: the mention autocomplete never opened for ${queries.map((q) => `@${q}`).join(" or ")}.`,
      );
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
