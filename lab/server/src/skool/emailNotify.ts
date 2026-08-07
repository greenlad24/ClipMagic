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
}

/** Locate the switch and describe it, without touching it. */
export async function readEmailNotify(): Promise<EmailNotifyState> {
  const out = await withSkoolPage(async (page) =>
    page.evaluate((label: string) => {
      const doc: any = (globalThis as any).document;
      if (!doc) return { found: false, on: null, offset: 0, reason: "No document.", x: 0, y: 0 };

      // The deepest node whose whole text is the label. Ancestors match too when
      // they contain nothing else, and the deepest one is the actual <span>.
      const exact = [...doc.querySelectorAll("span,div,label,p")].filter(
        (e: any) => (e.textContent || "").trim() === label,
      );
      if (exact.length === 0) {
        return { found: false, on: null, offset: 0, reason: `No element reads "${label}".`, x: 0, y: 0 };
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
            x: 0,
            y: 0,
          };
        }
      }
      if (!btn) {
        return { found: false, on: null, offset: 0, reason: `Found "${label}" but no switch beside it.`, x: 0, y: 0 };
      }

      const track = btn.getBoundingClientRect();
      if (!(track.width > 0 && track.height > 0)) {
        return { found: false, on: null, offset: 0, reason: "The switch is not rendered.", x: 0, y: 0 };
      }

      // The knob is the smallest painted box inside the track.
      const inner = [...btn.querySelectorAll("div")]
        .map((d: any) => d.getBoundingClientRect())
        .filter((r: any) => r.width > 0 && r.height > 0 && r.width < track.width);
      if (inner.length === 0) {
        return { found: false, on: null, offset: 0, reason: "The switch has no knob to read.", x: 0, y: 0 };
      }
      inner.sort((a: any, b: any) => a.width * a.height - b.width * b.height);
      const knob = inner[0];

      const offset = (knob.left + knob.width / 2 - (track.left + track.width / 2)) / track.width;
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      const r2 = btn.getBoundingClientRect();
      return {
        found: true,
        on: offset > 0,
        offset,
        reason: null,
        x: Math.round(r2.x + r2.width / 2),
        y: Math.round(r2.y + r2.height / 2),
      };
    }, EMAIL_NOTIFY_LABEL),
  );

  if (!out) return { found: false, on: null, offset: 0, reason: "No browser page." };
  return { found: out.found, on: out.on, offset: out.offset, reason: out.reason };
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

  await new Promise((r) => setTimeout(r, 600));
  const after = await readEmailNotify();
  if (!after.found || after.on === null) {
    return { ok: false, on: null, clicked: true, detail: `Clicked the switch but could not read it back: ${after.reason}` };
  }
  if (after.on !== want) {
    return {
      ok: false,
      on: after.on,
      clicked: true,
      detail: `Clicked the switch and it is still ${after.on ? "on" : "off"}.`,
    };
  }
  return { ok: true, on: want, clicked: true, detail: `Turned ${want ? "on" : "off"}.` };
}
