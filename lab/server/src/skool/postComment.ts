/**
 * The FIRST COMMENT under a post — where the @mentions actually go.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE A POST CANNOT TAG ANYBODY. Jake, 2026-08-27: "we
 * can't tag people directly in the post itself". The chips typed into the post
 * composer looked right in the editor and were verified there — the machinery in
 * `mentions.ts` proves a real ProseMirror mention NODE went in — and they still
 * did not reach the members. So the greeting moves: the post opens with a plain
 * welcome to the group, and the names go underneath as the first comment, which
 * is where a Skool mention notifies.
 *
 * ⚠️ THE COMMENT EDITOR IS THE SAME EDITOR. Measured on a live post page the
 * same day: one `contenteditable` on the page, `class="tiptap ProseMirror
 * skool-editor"`, `data-placeholder="Your comment"`. That is why `typeMentions`
 * is reused verbatim rather than reimplemented — `focusBody` picks the tallest
 * visible editor, and on a post page the comment box is the only one.
 *
 * ⚠️⚠️ ENTER IS NOT A SAFE KEY HERE, AND `typeMentions` IS WHY IT IS SAFE
 * ANYWAY. A comment box may submit on Enter, and committing a mention chip is an
 * Enter — so a naive version posts a half-written comment on the first name.
 * `typeMentions` presses Enter ONLY after it has seen the autocomplete open and
 * confirmed the first entry is the exact handle it asked for, and the popup
 * swallows that keystroke. Nothing else in this file presses Enter at all: the
 * closing line is typed, and the submit is a CLICK.
 */
import { readComments } from "./comments.js";
import { withSkoolPage } from "./browser.js";
import { focusBody } from "./actions.js";
import { typeMentions } from "./mentions.js";
import type { SkoolMember } from "./members.js";

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CommentResult {
  ok: boolean;
  /** One line per step, kept on success as well as failure. */
  detail: string;
  /** Members whose chip is verifiably in the comment — the welcome ledger's key. */
  mentioned: SkoolMember[];
  /** What was actually left in the editor, for a human reading a failure. */
  text: string;
  /**
   * Submit controls found next to the editor, named.
   *
   * ⚠️ REPORTED EVEN ON SUCCESS. Skool renames these on a redeploy and the
   * failure mode is a comment that silently never posts; the step log naming the
   * button it clicked is what makes that diagnosable a week later.
   */
  buttons: string[];
}

const FAIL = (detail: string, extra: Partial<CommentResult> = {}): CommentResult => ({
  ok: false, detail, mentioned: [], text: "", buttons: [], ...extra,
});

/** The visible comment editor's text, and whether anything is in it. */
async function editorState(): Promise<{ present: boolean; text: string }> {
  const state = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (!editors.length) return { present: false, text: "" };
      editors.sort((a: any, b: any) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      return { present: true, text: String(editors[0].textContent ?? "") };
    }),
  );
  return state ?? { present: false, text: "" };
}

/**
 * The buttons around the comment editor, as a human would name them.
 *
 * The toolbar's own controls (link, video, emoji, gif) are always there; the
 * submit appears once there is something to submit, which is why this is read
 * AFTER the text is typed and never before.
 */
async function composerButtons(): Promise<{ label: string; disabled: boolean; submitish: boolean }[]> {
  const found = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (!editors.length) return [];
      editors.sort((a: any, b: any) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      // ⚠️⚠️ DO NOT STOP AT THE FIRST ANCESTOR THAT HAS A BUTTON. That ancestor
      // is the formatting toolbar — link, video, emoji, gif — and stopping
      // there reported "no submit control was found" on a comment box that has
      // one, because the submit sits further out than the toolbar it appears
      // beside. Walk a fixed number of hops and take the widest view instead;
      // the labels below are what tell a submit from a tool, not the distance.
      let card: any = editors[0];
      for (let hop = 0; hop < 6 && card?.parentElement; hop++) card = card.parentElement;
      const out: { label: string; disabled: boolean; submitish: boolean }[] = [];
      for (const b of Array.from(card.querySelectorAll("button")) as any[]) {
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const label = String(b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim();
        // ⚠️ THE TOOLBAR IS EXCLUDED BY NAME, NOT BY POSITION. "Add video" sits
        // next to the submit and clicking it opens a dialog over the comment.
        const isTool = /^add (link|video|emoji|gif|image|file)$/i.test(label);
        out.push({
          label: label || "(unlabelled)",
          disabled: b.disabled === true || b.getAttribute("aria-disabled") === "true",
          // An unlabelled button next to a comment box is usually the send
          // arrow, but it is also every icon Skool has not named — so it counts
          // as a candidate and is ranked BELOW a button that says what it does.
          submitish: !isTool && (/comment|post|send|submit|reply/i.test(label) || !label),
        });
      }
      return out;
    }),
  );
  return Array.isArray(found) ? found : [];
}

/**
 * Click a control by its label.
 *
 * ⚠️ UNUSED SINCE Ctrl+Enter WAS MEASURED — kept because `composerButtons`
 * still watches for a submit button appearing, and this is what would press it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function clickSubmit(label: string): Promise<boolean> {
  const clicked = await withSkoolPage(async (page) =>
    page.evaluate((want: string) => {
      const doc: any = (globalThis as any).document;
      for (const b of Array.from(doc.querySelectorAll("button")) as any[]) {
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const label = String(b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim();
        if ((label || "(unlabelled)") !== want) continue;
        if (b.disabled === true) continue;
        b.click();
        return true;
      }
      return false;
    }, label),
  );
  return clicked === true;
}

/**
 * Empty the comment editor with real keystrokes.
 *
 * Same rule as the DM composer: this is a React-controlled ProseMirror, so
 * assigning to its DOM is a lie the component corrects on its next render. Only
 * the keys a person would press leave both in agreement.
 */
async function clearEditor(): Promise<void> {
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
    } catch {
      /* best effort — the caller reports what is left */
    }
  });
  await settle(300);
}

export interface CommentInput {
  communityUrl: string;
  /** The post's slug, as `createPost` returned it. */
  slug: string;
  /** Who to tag, in order. Each becomes a real mention chip. */
  mentions: SkoolMember[];
  /** The line that follows the names — "welcome guys!" and never the same twice. */
  closing: string;
  /**
   * Do everything except the final click, then empty the editor.
   *
   * ⚠️ NOT A SIMULATION — the same bargain `replyToComment` makes. It opens the
   * real post, types real chips into the real comment box and reads back what
   * Skool did with them; only the submit is withheld. It is the only way to
   * learn whether the mention autocomplete exists in a comment at all without a
   * member seeing the answer.
   */
  dryRun?: boolean;
}

/**
 * Write the first comment under a post: every new member tagged, then a line.
 *
 * Returns rather than throws. A member who cannot be tagged is DROPPED and named
 * in the step log — the same failure direction as the post's attachment — but a
 * comment where NOBODY could be tagged is not posted at all: it would be a bare
 * "welcome guys!" under a post that welcomed them already, which is worse than
 * the silence and would still burn the welcome ledger.
 */
export async function commentOnPost(input: CommentInput): Promise<CommentResult> {
  const base = input.communityUrl.replace(/\/+$/, "");
  const closing = input.closing.trim();
  if (!input.slug.trim()) return FAIL("No post slug, so there is nothing to comment on.");
  if (!input.mentions.length) return FAIL("Nobody to tag, so no comment was written.");
  if (!closing) return FAIL("No closing line was written, so the comment was not posted.");

  const steps: string[] = [];
  const url = `${base}/${input.slug.replace(/^\/+/, "")}`;

  const arrived = await withSkoolPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // The comment box is client-rendered; `domcontentloaded` is well before it.
    await settle(3500);
    return String(page.url() ?? "");
  });
  if (!arrived) return FAIL("The browser could not be reached, so no comment was written.");
  steps.push(`Opened ${url}`);

  const before = await editorState();
  if (!before.present) {
    return FAIL(`${steps.join(" · ")} · ⚠ No comment editor on the page — Skool may have bounced the session to a login.`);
  }
  // ⚠️ A COMMENT BOX WITH SOMETHING ALREADY IN IT IS SOMEBODY ELSE'S DRAFT.
  // Typing into it would post their half-sentence with our names on the end.
  if (before.text.trim()) {
    return FAIL(
      `${steps.join(" · ")} · ⚠ The comment box already holds a draft (${before.text.trim().slice(0, 60)}…). ` +
        `Refusing to type into it.`,
    );
  }

  const tagged = await typeMentions(input.mentions);
  steps.push(tagged.detail);
  if (!tagged.mentioned.length) {
    // Nothing landed. Leave the box as we found it and say so loudly: this is
    // the case where Skool has changed the comment editor's mention support,
    // and a silent "posted" would hide it for weeks.
    await clearEditor();
    return FAIL(`${steps.join(" · ")} · ⚠ No mention chip could be written, so no comment was posted.`, {
      text: (await editorState()).text,
    });
  }

  // Typed, never pasted: it is one plain line and the paste path is markdown's.
  // No Enter anywhere — see the header.
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.type(` ${closing}`, { delay: 20 });
    } catch {
      /* the read-back below is what decides */
    }
  });
  await settle(500);

  const written = await editorState();
  if (!written.text.includes(closing.slice(0, Math.min(closing.length, 20)))) {
    await clearEditor();
    return FAIL(`${steps.join(" · ")} · ⚠ The closing line did not reach the editor, so nothing was posted.`, {
      text: written.text,
    });
  }
  steps.push(`Wrote "${closing}"`);

  const buttons = await composerButtons();
  const names = buttons.map((b) => `${b.label}${b.disabled ? " (disabled)" : ""}`);

  if (input.dryRun) {
    await clearEditor();
    const after = await editorState();
    return {
      ok: true,
      detail:
        `${steps.join(" · ")} · DRY RUN — not submitted. Editor held: "${written.text.trim().slice(0, 160)}". ` +
        `Would submit with Ctrl+Enter. ` +
        `Buttons: ${names.join(", ") || "none"}. Editor cleared${after.text.trim() ? ` (⚠ ${after.text.trim().slice(0, 40)} left behind)` : ""}.`,
      mentioned: tagged.mentioned,
      text: written.text,
      buttons: names,
    };
  }

  // ⚠️⚠️ CTRL+ENTER SENDS A SKOOL COMMENT. THERE IS NO SUBMIT BUTTON AND PLAIN
  // ENTER DOES NOTHING. All three were measured on a live post on 2026-08-27,
  // in that order, and each had looked obvious beforehand:
  //   • the only <button>s beside the box are Add link / video / emoji / gif,
  //     and widening the search to every clickable div, span and svg within
  //     eight ancestors found nothing else — so "click the send control" has no
  //     control to click;
  //   • plain Enter was then the obvious answer. It left the comment sitting in
  //     the box and posted nothing, which reads as success from inside the
  //     browser: the keystroke is accepted, nothing errors, and only re-reading
  //     the post from Skool shows that nothing arrived;
  //   • Ctrl+Enter posted it, mention chip and all.
  //
  // ⚠️ AND THE MENTION CHIPS ARE WHY THE PLAIN-ENTER RESULT WAS NOT A DEAD END
  // TO SHRUG AT: `typeMentions` presses Enter to commit each chip, so if Enter
  // ever starts submitting, this file posts a comment with one name in it. The
  // popup swallowing that keystroke is what stops it, and that is now the only
  // thing standing between a half-written greeting and the community.
  //
  // The button list is still read, purely so the step log names what was beside
  // the box on the day — a submit button appearing here later is a change worth
  // seeing rather than one to be silently outvoted by a keystroke.
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.down("Control");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Control");
    } catch {
      /* the read-back decides */
    }
  });
  steps.push("Pressed Ctrl+Enter");
  await settle(2500);

  // ⚠️ THE PROOF IS SKOOL'S OWN COPY OF THE COMMENT, NOT AN EMPTY EDITOR. A box
  // that cleared is what a submit looks like and also what a discard looks like.
  const check = await readComments(input.communityUrl, input.slug).catch(() => ({ comments: [], error: "unreadable" }));
  const needle = closing.slice(0, Math.min(closing.length, 20));
  const landed = (check.comments ?? []).find((c: any) => c.byMe && String(c.body ?? "").includes(needle));
  if (!landed) {
    // ⚠️ CLEAR IT. A submit that did not submit leaves the whole comment sitting
    // in the box — and the next run refuses to type into a composer that already
    // holds a draft, so one failure would block every attempt after it.
    await clearEditor();
    return FAIL(
      `${steps.join(" · ")} · ⚠ The comment was submitted but is not on the post yet` +
        `${check.error ? ` (the comments could not be re-read: ${check.error})` : ""}. Treating it as NOT posted, ` +
        `and the editor was emptied.`,
      { text: written.text, buttons: names },
    );
  }

  return {
    ok: true,
    detail: `${steps.join(" · ")} · Comment is live, tagging ${tagged.mentioned.map((m) => `@${m.displayName}`).join(", ")}.`,
    mentioned: tagged.mentioned,
    text: written.text,
    buttons: names,
  };
}

/* ────────────────────────── the diagnostic ────────────────────────── */

export interface MentionDiagnosis {
  editorFound: boolean;
  placeholder: string;
  /** Whether the caret is verifiably inside the comment editor after focusing. */
  focused: boolean;
  activeElement: string;
  /** What the editor held after typing a plain word — proof the keys arrive. */
  plainTyped: string;
  /** What it held after typing "@handle". */
  mentionTyped: string;
  /**
   * What the editor holds after the commit key, as TEXT and as MARKUP.
   *
   * ⚠️⚠️ THE MARKUP IS THE POINT. `typeMentions` proves a chip by looking for
   * the member's DISPLAY NAME in the editor's text — which is proof precisely
   * because the keystrokes were the handle. If a comment chip renders as
   * "@claudia-garcia-3172" rather than "@Claudia Garcia", that check fails on a
   * mention that went in perfectly, and the failure is indistinguishable from
   * the popup not committing at all. Only the HTML tells them apart.
   */
  afterEnter: { text: string; html: string };
  /** The same, having pressed Tab instead — some suggestion lists commit on it. */
  afterTab: { text: string; html: string };
  /**
   * Everything visible OUTSIDE the editor that mentions the handle or an "@".
   *
   * ⚠️ DELIBERATELY WIDER THAN `popupHandles`. That matcher requires a LEAF
   * whose entire text is exactly "@handle", which is the shape the POST
   * composer's popup happens to have. If the comment popup renders the name and
   * the handle in one node it would be invisible to that matcher and the
   * autocomplete would be reported as "never opened" while sitting on screen.
   * This dump is how those two are told apart.
   */
  candidates: { tag: string; cls: string; text: string }[];
  cleared: boolean;
}

/**
 * Why a mention did not go into a comment: no editor, no focus, no keys, or no
 * popup. Types into the real box and empties it again; never submits.
 */
export async function diagnoseCommentMentions(
  communityUrl: string,
  slug: string,
  handle: string,
): Promise<MentionDiagnosis> {
  const base = communityUrl.replace(/\/+$/, "");
  const out: MentionDiagnosis = {
    editorFound: false, placeholder: "", focused: false, activeElement: "",
    plainTyped: "", mentionTyped: "", afterEnter: { text: "", html: "" },
    afterTab: { text: "", html: "" }, candidates: [], cleared: false,
  };

  await withSkoolPage(async (page) => {
    await page.goto(`${base}/${slug.replace(/^\/+/, "")}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settle(3500);
  });

  const found = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const eds = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (!eds.length) return { editorFound: false, placeholder: "" };
      eds.sort((a: any, b: any) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      const ph = eds[0].querySelector("[data-placeholder]");
      return { editorFound: true, placeholder: String(ph?.getAttribute("data-placeholder") ?? "") };
    }),
  );
  out.editorFound = found?.editorFound === true;
  out.placeholder = found?.placeholder ?? "";
  if (!out.editorFound) return out;

  await focusBody();
  const active = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el: any = doc.activeElement;
      if (!el) return { focused: false, activeElement: "(none)" };
      const eds = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (e) => e.getBoundingClientRect().height > 20,
      );
      const inside = eds.some((e: any) => e === el || e.contains(el));
      return {
        focused: inside,
        activeElement: `${String(el.tagName ?? "?").toLowerCase()}.${String(el.className ?? "").slice(0, 60)}`,
      };
    }),
  );
  out.focused = active?.focused === true;
  out.activeElement = active?.activeElement ?? "";

  // Do the keys arrive at all?
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.type("diagnostic", { delay: 25 });
    } catch {
      /* the read-back is the answer */
    }
  });
  await settle(500);
  out.plainTyped = (await editorState()).text;
  await clearEditor();

  // Does an autocomplete open for a real handle?
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.type(`@${handle.slice(0, 12)}`, { delay: 40 });
    } catch {
      /* as above */
    }
  });
  await settle(2500);
  out.mentionTyped = (await editorState()).text;

  const cands = await withSkoolPage(async (page) =>
    page.evaluate((want: string) => {
      const doc: any = (globalThis as any).document;
      const eds = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      const inEditor = (el: any) => eds.some((ed: any) => ed.contains(el));
      const out: { tag: string; cls: string; text: string }[] = [];
      for (const el of Array.from(doc.querySelectorAll("div,span,p,li,a,button")) as any[]) {
        if (inEditor(el)) continue;
        const r = el.getBoundingClientRect?.();
        if (!r || r.width === 0 || r.height === 0) continue;
        if (el.children && el.children.length > 2) continue;
        const t = String(el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 120) continue;
        if (!t.includes("@") && !t.toLowerCase().includes(want.toLowerCase())) continue;
        out.push({ tag: String(el.tagName ?? "").toLowerCase(), cls: String(el.className ?? "").slice(0, 50), text: t });
        if (out.length >= 12) break;
      }
      return out;
    }, handle.slice(0, 12)),
  );
  out.candidates = Array.isArray(cands) ? cands : [];

  // Commit it, and look at what Skool actually put in the document.
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.press("Enter");
    } catch {
      /* the read-back is the answer */
    }
  });
  await settle(900);
  out.afterEnter = await editorMarkup();
  await clearEditor();

  // ⚠️ ONLY WHEN ENTER LEFT NO CHIP. Pressing both every time would tell us
  // nothing about which one works, and one of them may submit the comment.
  if (!/mention|data-id|data-type/i.test(out.afterEnter.html)) {
    await withSkoolPage(async (page) => {
      try {
        await page.keyboard.type(`@${handle.slice(0, 12)}`, { delay: 40 });
      } catch {
        /* as above */
      }
    });
    await settle(2500);
    await withSkoolPage(async (page) => {
      try {
        await page.keyboard.press("Tab");
      } catch {
        /* as above */
      }
    });
    await settle(900);
    out.afterTab = await editorMarkup();
    await clearEditor();
  }

  out.cleared = !(await editorState()).text.trim();
  return out;
}

/** The comment editor's text and its markup — see `MentionDiagnosis.afterEnter`. */
async function editorMarkup(): Promise<{ text: string; html: string }> {
  const got = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const eds = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (!eds.length) return { text: "", html: "" };
      eds.sort((a: any, b: any) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      return { text: String(eds[0].textContent ?? ""), html: String(eds[0].innerHTML ?? "").slice(0, 900) };
    }),
  );
  return got ?? { text: "", html: "" };
}

/* ────────────────────────── the submit hunt ────────────────────────── */

export interface SubmitProbe {
  /** What the editor holds once a chip and a line are in it. */
  typed: string;
  /**
   * Everything CLICKABLE around the composer, not just `<button>`.
   *
   * ⚠️⚠️ THE BUTTON-ONLY SCAN IS WHAT SENT A COMMENT NOWHERE. Skool's comment
   * box has four real `<button>` elements — link, video, emoji, gif — and no
   * fifth one, so "no submit control" looked like a finding and Enter looked
   * like the only remaining answer. Enter posted nothing. A control that is a
   * styled `div` with `cursor: pointer`, or an `svg` in a `[role=button]`, is
   * invisible to a `querySelectorAll("button")` and perfectly visible to a
   * person, which is the gap this dump exists to close.
   */
  clickables: { tag: string; role: string; label: string; cls: string; cursor: string; x: number; y: number }[];
  /** The editor after Ctrl+Enter — empty usually means it went somewhere. */
  afterCtrlEnter: string;
  cleared: boolean;
}

/**
 * Put a real comment in the box and describe every control around it.
 *
 * Types, dumps, tries Ctrl+Enter, then empties the box. Whether the comment
 * actually posted is NOT decided here — the caller re-reads the post, because
 * an empty editor is what a send and a discard both look like.
 */
export async function probeCommentSubmit(
  communityUrl: string,
  slug: string,
  member: SkoolMember,
  closing: string,
): Promise<SubmitProbe> {
  const base = communityUrl.replace(/\/+$/, "");
  const out: SubmitProbe = { typed: "", clickables: [], afterCtrlEnter: "", cleared: false };

  await withSkoolPage(async (page) => {
    await page.goto(`${base}/${slug.replace(/^\/+/, "")}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settle(3500);
  });

  const tagged = await typeMentions([member]);
  if (!tagged.mentioned.length) {
    out.typed = `⚠ no chip: ${tagged.detail}`;
    await clearEditor();
    return out;
  }
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.type(` ${closing}`, { delay: 20 });
    } catch {
      /* the read-back reports it */
    }
  });
  await settle(500);
  out.typed = (await editorState()).text;

  const found = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const win: any = globalThis;
      const eds = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (!eds.length) return [];
      eds.sort((a: any, b: any) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      const editor = eds[0];
      let card: any = editor;
      for (let hop = 0; hop < 8 && card?.parentElement; hop++) card = card.parentElement;

      const out: any[] = [];
      for (const el of Array.from(card.querySelectorAll("*")) as any[]) {
        if (el === editor || editor.contains(el)) continue;
        const r = el.getBoundingClientRect?.();
        if (!r || r.width === 0 || r.height === 0) continue;
        const style = win.getComputedStyle ? win.getComputedStyle(el) : null;
        const cursor = String(style?.cursor ?? "");
        const tag = String(el.tagName ?? "").toLowerCase();
        const role = String(el.getAttribute?.("role") ?? "");
        const clickable = tag === "button" || role === "button" || cursor === "pointer" || el.hasAttribute?.("tabindex");
        if (!clickable) continue;
        // A wrapper that merely inherits a pointer cursor is noise; the control
        // is small. Anything the width of the composer is the composer.
        if (r.width > 400) continue;
        out.push({
          tag,
          role,
          label: String(el.getAttribute?.("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
          cls: String(el.className?.baseVal ?? el.className ?? "").slice(0, 45),
          cursor,
          x: Math.round(r.x),
          y: Math.round(r.y),
        });
        if (out.length >= 25) break;
      }
      return out;
    }),
  );
  out.clickables = Array.isArray(found) ? found : [];

  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.down("Control");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Control");
    } catch {
      /* as above */
    }
  });
  await settle(2000);
  out.afterCtrlEnter = (await editorState()).text;

  await clearEditor();
  out.cleared = !(await editorState()).text.trim();
  return out;
}
