/**
 * The composer's "Send email to all members" switch.
 *
 * Jake, 2026-08-07: "when you post I want to notify everyone by email — it's a
 * toggle click." It is one click, and almost everything about doing it safely is
 * in what that click is NOT.
 *
 * ⚠️⚠️ IT IS A TOGGLE, NOT A BUTTON, SO A RECORDED "CLICK" STEP IS THE WRONG
 * SHAPE FOR IT. Every other control in the post recipe is idempotent — clicking
 * the Title field twice is clicking the Title field. Clicking this twice turns
 * the email back OFF, silently, and the post still publishes looking exactly
 * like a success. So this is never replayed blind: the state is READ, and the
 * click only happens if the state is wrong.
 *
 * ⚠️⚠️ ITS ONLY CLASS HANDLES ARE OBFUSCATED, INCLUDING THE ONES THAT ENCODE
 * STATE. Measured on the live composer 2026-08-07:
 *   OFF (default): button `sc-a9cabdde-0 gyEjcq`, inner `TIpcf` / `lnxWgQ`
 *   ON  (1 click): button `sc-a9cabdde-0 eDDifO`, inner `eopFfh` / `hgEsXj`
 * Those hashes are exactly the kind `isSemanticClass()` warns about — they
 * change on Skool's redeploys. Reading state from them would produce a
 * confidently wrong answer the first time Skool restyles a switch, and the
 * failure would be invisible: we would "know" it was off, click, and turn it
 * off. So state comes from GEOMETRY instead — the knob sits at the left of the
 * track when off and the right when on, which is what a switch IS, and is true
 * regardless of what the classes are called.
 *
 * ⚠️ AND THE BUTTON HAS NO TEXT, NO testId AND NO aria-label, so it cannot be
 * found the way every other step finds things. The durable handle is the
 * SIBLING LABEL — the words a human reads. We find the label and walk up to the
 * nearest ancestor holding exactly one button, refusing if that is ambiguous.
 *
 * ⚠️ IN DOM ORDER IT COMES *AFTER* THE POST BUTTON. It was sitting in the very
 * first element dump of the composer and was dismissed as feed furniture for
 * that reason — the switch is markup-adjacent to the toolbar below the modal,
 * not to the Cancel/Post row it visually sits under.
 */
import { withSkoolPage } from "./browser.js";

/** The words on screen. The only handle here that Skool's build does not hash. */
export const EMAIL_NOTIFY_LABEL = "Send email to all members";

export interface EmailNotifyState {
  /** Whether the labelled switch was located at all. */
  found: boolean;
  /** Whether it is currently on. Null when it could not be read. */
  on: boolean | null;
  /**
   * How far the knob sits from the track's centre, as a fraction of the track.
   *
   * ⚠️ A SWITCH READ AT ~0 IS A SWITCH WE DID NOT READ. Mid-animation, or a
   * redesign where the knob fills the track, would land near zero and the
   * left/right test would be a coin flip. Reported so an ambiguous read can
   * refuse instead of guessing.
   */
  offset: number;
  /** Why it could not be read, when it could not. */
  reason: string | null;
  /**
   * Whether Skool has the switch disabled.
   *
   * ⚠️⚠️ THIS IS A THIRD STATE AND NOTHING HERE COULD SEE IT UNTIL 2026-08-12.
   * A disabled switch still has its knob at the left of the track, so the
   * geometry read — which is otherwise the durable one — calls it OFF, and every
   * caller then reasonably tries to turn it on. Twelve scheduled attempts on
   * 2026-08-11 clicked a dead button and reported "still off", which is true and
   * useless: OFF means "click it" and DISABLED means "Skool will not let you".
   * Measured on the live composer that day, the button carried `disabled=""` and
   * the class `kPYQEG` — neither of the two states this file had recorded.
   */
  disabled: boolean;
  /**
   * Where a real-mouse click would land, and what is actually there.
   *
   * ⚠️ ADDED 2026-08-12, AFTER A CLICK THAT LANDED ON NOTHING COST A POSTING
   * DAY. `setEmailNotify` reported "clicked the switch and it is still off"
   * twelve times in a row, and that sentence is true of every possible cause:
   * the coordinate being off screen, another element sitting over the switch,
   * and Skool no longer responding to a real click all read identically. The
   * state was reported and the CLICK TARGET was not, so there was nothing in
   * the log to tell them apart. `hit` is what `elementFromPoint` finds at the
   * click point — if that is not the switch, the click never reached it.
   */
  click: {
    x: number;
    y: number;
    inViewport: boolean;
    /** Tag and class of whatever sits at (x, y). Null when nothing does. */
    hit: string | null;
    /** Whether that thing is the switch, or inside it. */
    hitIsSelf: boolean;
  } | null;
}

/** Locate the switch and describe it, without touching it. */
export async function readEmailNotify(): Promise<EmailNotifyState> {
  const out = await withSkoolPage(async (page) =>
    page.evaluate((label: string) => {
      const doc: any = (globalThis as any).document;
      if (!doc) return { found: false, on: null, offset: 0, reason: "No document.", disabled: false, click: null };

      // The deepest node whose whole text is the label. Ancestors match too when
      // they contain nothing else, and the deepest one is the actual <span>.
      const exact = [...doc.querySelectorAll("span,div,label,p")].filter(
        (e: any) => (e.textContent || "").trim() === label,
      );
      if (exact.length === 0) {
        return { found: false, on: null, offset: 0, reason: `No element reads "${label}".`, disabled: false, click: null };
      }
      const labelEl: any = exact[exact.length - 1];

      // Walk up to the nearest ancestor that holds exactly one button. One is
      // the switch; several means we have climbed into the modal's button row
      // and no longer know which control we are looking at.
      let anchor: any = labelEl;
      let btn: any = null;
      for (let up = 0; up < 5; up++) {
        anchor = anchor?.parentElement;
        if (!anchor) break;
        const btns = [...anchor.querySelectorAll("button")];
        if (btns.length === 1) {
          btn = btns[0];
          break;
        }
        if (btns.length > 1) {
          return {
            found: false,
            on: null,
            offset: 0,
            reason: `${btns.length} buttons sit beside "${label}" — refusing to guess which is the switch.`,
            disabled: false,
            click: null,
          };
        }
      }
      if (!btn) {
        return { found: false, on: null, offset: 0, reason: `Found "${label}" but no switch beside it.`, disabled: false, click: null };
      }

      const track = btn.getBoundingClientRect();
      if (!(track.width > 0 && track.height > 0)) {
        return { found: false, on: null, offset: 0, reason: "The switch is not rendered.", disabled: false, click: null };
      }

      // The knob is the smallest painted box inside the track.
      const inner = [...btn.querySelectorAll("div")]
        .map((d: any) => d.getBoundingClientRect())
        .filter((r: any) => r.width > 0 && r.height > 0 && r.width < track.width);
      if (inner.length === 0) {
        return { found: false, on: null, offset: 0, reason: "The switch has no knob to read.", disabled: false, click: null };
      }
      inner.sort((a: any, b: any) => a.width * a.height - b.width * b.height);
      const knob = inner[0];

      const offset = (knob.left + knob.width / 2 - (track.left + track.width / 2)) / track.width;
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      const r2 = btn.getBoundingClientRect();
      const x = Math.round(r2.x + r2.width / 2);
      const y = Math.round(r2.y + r2.height / 2);

      // What a real mouse would actually hit. `elementFromPoint` answers in
      // VIEWPORT coordinates, which is the same space `page.mouse.click` takes,
      // so this is the click the browser is about to make and not a model of it.
      const win: any = globalThis;
      const atPoint: any = doc.elementFromPoint(x, y);
      const describe = (el: any): string | null => {
        if (!el) return null;
        // `className` is an SVGAnimatedString on SVG nodes and stringifies to
        // "[object SVGAnimatedString]" — the attribute is the honest read.
        const cls = (el.getAttribute?.("class") || "").trim();
        return el.tagName.toLowerCase() + (cls ? "." + cls.split(/\s+/).join(".") : "");
      };
      return {
        found: true,
        on: offset > 0,
        offset,
        reason: null,
        disabled: !!btn.disabled || btn.getAttribute("aria-disabled") === "true",
        click: {
          x,
          y,
          inViewport: x >= 0 && y >= 0 && x < (win.innerWidth || 0) && y < (win.innerHeight || 0),
          hit: describe(atPoint),
          hitIsSelf: !!atPoint && (atPoint === btn || btn.contains(atPoint)),
        },
      };
    }, EMAIL_NOTIFY_LABEL),
  );

  if (!out) return { found: false, on: null, offset: 0, reason: "No browser page.", disabled: false, click: null };
  return {
    found: out.found,
    on: out.on,
    offset: out.offset,
    reason: out.reason,
    disabled: out.disabled === true,
    click: out.click ?? null,
  };
}

/** The heading on the modal Skool raises when Post is pressed with the switch on. */
export const EMAIL_CONFIRM_HEADING = "Send email to all members?";

export interface EmailConfirmResult {
  ok: boolean;
  /** Whether the confirmation modal appeared at all. */
  appeared: boolean;
  /** Whether Confirm was clicked and the modal then went away. */
  submitted: boolean;
  detail: string;
}

/**
 * Answer the "Send email to all members?" modal, if it appears.
 *
 * ⚠️⚠️ THIS IS WHY THE FIRST TWELVE ATTEMPTS AT AN EMAILED POST PUBLISHED
 * NOTHING. With the switch on, the Post click does NOT submit — it opens a React
 * modal reading "This email will be sent to N members, are you sure you want to
 * proceed?" over the composer, and `POST /posts` is never issued. Measured
 * 2026-08-09 with the create-post request intercepted: zero requests fired.
 *
 * Every symptom of that is indistinguishable from success from the inside. The
 * Post button really was clicked, the click really did land, no error is raised,
 * no native dialog fires, nothing in the modal reads like a warning — and the
 * composer simply stays open behind the confirmation. Only the read-back knows,
 * and all it can say is "every click worked and the post is not there".
 *
 * ⚠️ ABSENT IS NOT AN ERROR. With the switch off there is no modal, so a missing
 * one is the normal case for any post that is not emailing the community.
 *
 * ⚠️ AND IT MUST NOT BE A RECORDED RECIPE STEP, for the same reason the switch
 * itself is not one: it exists only when the switch is on, so a recipe carrying
 * it would stall on every post that does not email, and a recipe without it
 * would never publish one that does.
 */
export async function confirmEmailDialog(timeoutMs = 8000): Promise<EmailConfirmResult> {
  const deadline = Date.now() + timeoutMs;
  let at: { x: number; y: number } | null = null;

  // Poll: the modal is mounted by React a moment after the click, and clicking
  // where it is about to be does nothing at all.
  while (Date.now() < deadline) {
    at = await findConfirmButton();
    if (at) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!at) {
    return { ok: true, appeared: false, submitted: false, detail: "No email confirmation appeared." };
  }

  const clicked = await withSkoolPage(async (page) => {
    // The real mouse, like the switch itself — a synthetic click on Skool's
    // pointer-driven controls does nothing.
    await page.mouse.click(at!.x, at!.y, { delay: 40 });
    return true;
  });
  if (!clicked) {
    return { ok: false, appeared: true, submitted: false, detail: "The email confirmation appeared but there was no page to click it with." };
  }

  await new Promise((r) => setTimeout(r, 1500));
  const still = await findConfirmButton();
  if (still) {
    // ⚠️ NOT REPORTED AS "not posted". The click may have landed and the modal
    // may merely be slow to unmount; the feed read-back is the only evidence
    // that counts, and it runs either way.
    return { ok: false, appeared: true, submitted: false, detail: "Clicked Confirm and the email confirmation is still up." };
  }
  return { ok: true, appeared: true, submitted: true, detail: "Confirmed the email to all members." };
}

/**
 * Where to click to confirm, or null if the modal is not up.
 *
 * ⚠️ SCOPED TO THE MODAL, NEVER MATCHED ACROSS THE DOCUMENT. "Confirm" is a
 * generic label and the feed behind the modal is a live page; the only safe
 * anchor is the heading, which names the action in words a human reads.
 *
 * ⚠️ AND CANCEL IS NEVER CLICKED. It sits in the same row, one button away, and
 * clicking it discards the post silently — the same wrong-control failure the
 * switch's own "exactly one button" rule exists to prevent.
 */
async function findConfirmButton(): Promise<{ x: number; y: number } | null> {
  const out = await withSkoolPage(async (page) =>
    page.evaluate((heading: string) => {
      const doc: any = (globalThis as any).document;
      if (!doc) return null;
      const vis = (el: any): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const headings = [...doc.querySelectorAll("h1,h2,h3,h4,div,span,p")].filter(
        (e: any) => (e.textContent || "").trim() === heading && vis(e),
      );
      if (headings.length === 0) return null;

      // Climb from the heading to the nearest ancestor that also holds a
      // Confirm button — that box is the modal, and nothing outside it counts.
      let anchor: any = headings[headings.length - 1];
      for (let up = 0; up < 6; up++) {
        anchor = anchor?.parentElement;
        if (!anchor) break;
        const confirm = [...anchor.querySelectorAll("button")].find(
          (b: any) => (b.textContent || "").trim().toLowerCase() === "confirm" && vis(b),
        );
        if (confirm) {
          const r = (confirm as any).getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
      }
      return null;
    }, EMAIL_CONFIRM_HEADING),
  );
  return out ?? null;
}

export interface EmailNotifyResult {
  ok: boolean;
  /** The state the switch was left in. Null when unknown. */
  on: boolean | null;
  /** Whether this call actually clicked anything. */
  clicked: boolean;
  detail: string;
}

/**
 * Leave the switch in `want`, clicking at most once, and confirm it landed.
 *
 * ⚠️ THE CONFIRMATION IS THE POINT. Clicking and assuming is how a toggle ends
 * up in the wrong state — the click may hit while React is still mounting the
 * modal, and there is no error when it misses. So it is read, clicked, and read
 * back; only the second read is reported.
 */
export async function setEmailNotify(want: boolean): Promise<EmailNotifyResult> {
  const before = await readEmailNotify();
  if (!before.found || before.on === null) {
    return { ok: false, on: null, clicked: false, detail: before.reason ?? "The switch could not be read." };
  }
  // Too close to call — see `offset`. Refusing beats a coin flip on an action
  // that emails every member of the community.
  if (Math.abs(before.offset) < 0.05) {
    return {
      ok: false,
      on: null,
      clicked: false,
      detail: `The switch's knob is centred (offset ${before.offset.toFixed(3)}), so its state is unreadable — not touching it.`,
    };
  }
  if (before.on === want) {
    return { ok: true, on: want, clicked: false, detail: `Already ${want ? "on" : "off"}.` };
  }
  // ⚠️ A DISABLED SWITCH IS NOT A FAILED CLICK, AND SAYING SO IS THE POINT.
  // Clicking it changes nothing, so the twelve retries on 2026-08-11 were twelve
  // browser cycles spent on something that could never work — and each one
  // reported a sentence ("still off") that reads like a flaky selector and sent
  // three sessions looking at coordinates. Refusing without clicking is both
  // cheaper and the only version that names what to go and fix.
  if (before.disabled) {
    return {
      ok: false,
      on: before.on,
      clicked: false,
      detail: `Skool has the switch DISABLED, so it cannot be turned ${want ? "on" : "off"} from here — this is Skool's own state, not a missed click.`,
    };
  }

  const clicked = await withSkoolPage(async (page) => {
    const at = await page.evaluate((label: string) => {
      const doc: any = (globalThis as any).document;
      const exact = [...doc.querySelectorAll("span,div,label,p")].filter(
        (e: any) => (e.textContent || "").trim() === label,
      );
      if (exact.length === 0) return null;
      let anchor: any = exact[exact.length - 1];
      for (let up = 0; up < 5; up++) {
        anchor = anchor?.parentElement;
        if (!anchor) break;
        const btns = [...anchor.querySelectorAll("button")];
        if (btns.length === 1) {
          btns[0].scrollIntoView({ block: "center", inline: "nearest" });
          const r = btns[0].getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        if (btns.length > 1) return null;
      }
      return null;
    }, EMAIL_NOTIFY_LABEL);
    if (!at) return false;
    // The real mouse — see the note at the top of `console.ts`. A synthetic
    // click on Skool's pointer-driven controls does nothing at all.
    await page.mouse.click(at.x, at.y, { delay: 40 });
    return true;
  });

  if (!clicked) return { ok: false, on: before.on, clicked: false, detail: "The switch moved before it could be clicked." };

  const after = await waitForSwitch(want, 2500);
  if (after.found && after.on === want) {
    return { ok: true, on: want, clicked: true, detail: `Turned ${want ? "on" : "off"}.` };
  }

  // ⚠️⚠️ THE SECOND ATTEMPT IS SYNTHETIC, AND IT CONTRADICTS THIS PROJECT'S
  // USUAL RULE ON PURPOSE. Everywhere else in Skool a synthetic click does
  // nothing — the 3-dots menus and the plain-div controls are built on pointer
  // events and only the real mouse drives them, which is why the real mouse is
  // tried FIRST here and stays the primary path. But this control is a genuine
  // `<button>`, and on 2026-08-12 the real-mouse click stopped moving it while
  // the switch still read perfectly (offset -0.25, exactly as measured on
  // 2026-08-07) — so the state read is fine and the click is what is not
  // arriving. A dispatched pointer sequence reaches a real button's handler
  // without depending on where the browser thinks the cursor is.
  //
  // ⚠️ IT IS SAFE ONLY BECAUSE THE STATE IS RE-READ AFTER IT. A toggle clicked
  // twice ends up back where it started, so a blind fallback would be the exact
  // "clicked it twice and emailed nobody while looking like a success" failure
  // this whole file exists to prevent. The worst case here is that the first
  // click was merely slow, this one undoes it, and the read-back below reports
  // the switch OFF — which fails in the direction that does not email 65 people.
  const fell = await clickSwitchSynthetically();
  const after2 = fell ? await waitForSwitch(want, 2500) : after;
  if (after2.found && after2.on === want) {
    return { ok: true, on: want, clicked: true, detail: `Turned ${want ? "on" : "off"} (the real mouse missed it; a dispatched click landed).` };
  }

  const state = after2.found ? after2 : after;
  if (!state.found || state.on === null) {
    return { ok: false, on: null, clicked: true, detail: `Clicked the switch but could not read it back: ${state.reason}` };
  }
  // ⚠️ THE CLICK TARGET IS PART OF THE MESSAGE. "Still off" on its own is what
  // twelve identical failures said on 2026-08-11, and it named no cause.
  return {
    ok: false,
    on: state.on,
    clicked: true,
    detail:
      `Clicked the switch and it is still ${state.on ? "on" : "off"}` +
      (state.click
        ? ` — clicked (${state.click.x}, ${state.click.y}), ${state.click.inViewport ? "in the viewport" : "OFF SCREEN"}, ` +
          `and what is there is ${state.click.hitIsSelf ? "the switch itself" : state.click.hit ?? "nothing"}.`
        : ".") +
      (fell ? " A dispatched click did not move it either." : " The dispatched fallback could not find it."),
  };
}

/**
 * Read the switch until it says `want`, or the time runs out.
 *
 * ⚠️ ONE 600ms SLEEP WAS THE OLD BEHAVIOUR AND IT CANNOT TELL "the click missed"
 * FROM "React has not re-rendered yet". Polling costs nothing when the click
 * worked (it returns on the first read) and only spends the budget when the
 * answer is going to be bad news, which is exactly when it is worth being sure.
 */
async function waitForSwitch(want: boolean, timeoutMs: number): Promise<EmailNotifyState> {
  const deadline = Date.now() + timeoutMs;
  let last = await readEmailNotify();
  while (last.on !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    last = await readEmailNotify();
  }
  return last;
}

/** Dispatch a pointer sequence at the switch. Returns whether it was found. */
async function clickSwitchSynthetically(): Promise<boolean> {
  const out = await withSkoolPage(async (page) =>
    page.evaluate((label: string) => {
      const doc: any = (globalThis as any).document;
      const win: any = globalThis;
      const exact = [...doc.querySelectorAll("span,div,label,p")].filter(
        (e: any) => (e.textContent || "").trim() === label,
      );
      if (exact.length === 0) return false;
      let anchor: any = exact[exact.length - 1];
      for (let up = 0; up < 5; up++) {
        anchor = anchor?.parentElement;
        if (!anchor) break;
        const btns = [...anchor.querySelectorAll("button")];
        if (btns.length > 1) return false;
        if (btns.length === 1) {
          const btn = btns[0];
          const r = btn.getBoundingClientRect();
          const init: any = {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: Math.round(r.x + r.width / 2),
            clientY: Math.round(r.y + r.height / 2),
            button: 0,
          };
          // The full sequence, not just `click()`. A styled switch may commit on
          // pointerup rather than click, and dispatching only the last event of
          // a gesture is how a control that "handles clicks" still does nothing.
          if (typeof win.PointerEvent === "function") {
            btn.dispatchEvent(new win.PointerEvent("pointerdown", init));
          }
          btn.dispatchEvent(new win.MouseEvent("mousedown", init));
          if (typeof win.PointerEvent === "function") {
            btn.dispatchEvent(new win.PointerEvent("pointerup", init));
          }
          btn.dispatchEvent(new win.MouseEvent("mouseup", init));
          btn.click();
          return true;
        }
      }
      return false;
    }, EMAIL_NOTIFY_LABEL),
  );
  return out === true;
}
