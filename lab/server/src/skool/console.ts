/**
 * A live console onto the Skool browser — and the "teach" mode built on it.
 *
 * WHY THIS EXISTS. Skool's editing UI cannot be found by reading the DOM. Three
 * attempts proved it: the controls are plain divs with click handlers (no role,
 * no tag to query), the per-card menus do not exist until the card is hovered,
 * the dropdown items do not exist until the menu is opened, and every class is
 * a styled-components hash that changes when Skool redeploys. A probe that
 * queried for buttons reported, with complete confidence, that this classroom
 * had no admin UI whatsoever. It was wrong.
 *
 * So the operator teaches it instead: they drive the real browser, click the
 * thing, and the server records WHAT they clicked. Demonstration beats
 * inference here, and it stays true when Skool moves things.
 *
 * ⚠️ CLICKS GO THROUGH THE REAL MOUSE, never `element.click()`. A synthetic
 * click on Skool's 3-dots menu does nothing at all — the menu is built on
 * pointer events, and dispatching a click on the node skips them. This is not a
 * detail: it is the difference between the write path working and silently
 * doing nothing.
 */
import { screenshotBase64 } from "../browser/runtime.js";
import { withSkoolPage } from "./browser.js";

export interface ConsoleFrame {
  /** Base64 JPEG of the current page. */
  image: string | null;
  url: string | null;
  title: string | null;
  /** CSS-pixel size of the viewport the image corresponds to. */
  width: number;
  height: number;
  error: string | null;
}

const NO_FRAME = (error: string): ConsoleFrame => ({
  image: null,
  url: null,
  title: null,
  width: 0,
  height: 0,
  error,
});

/**
 * How an element can be found again later.
 *
 * Several handles are recorded rather than one, most durable first, because the
 * durable ones are frequently absent (Skool ships almost no test ids or aria
 * labels) and the available one — the class — is the least durable thing on the
 * page. Replay tries them in order and reports which one it used, so drift
 * shows up as a changed handle instead of a wrong click.
 */
export interface ElementDescriptor {
  tag: string;
  /** Visible text, trimmed and capped. Empty for icon-only controls. */
  text: string;
  testId: string | null;
  ariaLabel: string | null;
  role: string | null;
  /** Styled-components hashes. Volatile: they change on Skool's redeploys. */
  classes: string[];
  /** Position among elements sharing the best handle — disambiguates repeats. */
  nth: number;
  /** Ancestor tag chain, as a last resort when everything else has changed. */
  path: string;
  /** Whether the control only appeared because something was hovered first. */
  neededHover: boolean;
}

/**
 * Turn a fraction of the displayed image into a real viewport pixel.
 *
 * The console shows the frame at whatever size fits on screen, so the UI sends
 * FRACTIONS and the server scales them. Sending pixels would mean every click
 * landed somewhere else the moment the panel was a different width — the same
 * reason the engagement console works this way.
 */
async function toPixels(xFrac: number, yFrac: number): Promise<{ x: number; y: number }> {
  const size = await withSkoolPage(async (page) =>
    page.evaluate(() => ({
      w: (globalThis as any).innerWidth ?? 0,
      h: (globalThis as any).innerHeight ?? 0,
    })),
  );
  const w = size?.w || 1280;
  const h = size?.h || 900;
  return {
    x: Math.max(0, Math.min(w - 1, Math.round(xFrac * w))),
    y: Math.max(0, Math.min(h - 1, Math.round(yFrac * h))),
  };
}

/** Fractional variants — what the UI actually calls. */
export async function hoverFrac(xFrac: number, yFrac: number): Promise<ConsoleFrame> {
  const { x, y } = await toPixels(xFrac, yFrac);
  return hover(x, y);
}

export async function clickFrac(
  xFrac: number,
  yFrac: number,
  opts: { describe?: boolean } = {},
): Promise<{ frame: ConsoleFrame; descriptor: ElementDescriptor | null }> {
  const { x, y } = await toPixels(xFrac, yFrac);
  return clickAt(x, y, opts);
}

export async function frame(): Promise<ConsoleFrame> {
  const out = await withSkoolPage(async (page) => {
    const image = await screenshotBase64(page, 70);
    const info = await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const win: any = globalThis;
      return {
        url: win.location?.href ?? null,
        title: doc?.title ?? null,
        width: win.innerWidth ?? 0,
        height: win.innerHeight ?? 0,
      };
    });
    return { image, ...info, error: null };
  });
  return out ?? NO_FRAME("The browser could not be reached.");
}

export async function navigate(url: string): Promise<ConsoleFrame> {
  if (!/^https:\/\/(www\.)?skool\.com\//.test(url)) return NO_FRAME("Console navigation is limited to skool.com.");
  await withSkoolPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 1500));
  });
  return frame();
}

/**
 * Move the mouse somewhere without clicking.
 *
 * Its own action because hover IS an action in Skool: the per-card controls do
 * not exist in the DOM until the pointer is over the card, so a recipe that
 * clicks one has to hover first, and the teaching has to be able to express it.
 */
export async function hover(x: number, y: number): Promise<ConsoleFrame> {
  await withSkoolPage(async (page) => {
    try {
      await page.mouse.move(x, y);
    } catch {
      /* best effort — the runtime's contract */
    }
    await new Promise((r) => setTimeout(r, 700));
  });
  return frame();
}

/**
 * Click at a point, and describe what was there.
 *
 * The descriptor is captured BEFORE the click: clicking frequently unmounts the
 * thing that was clicked (a menu item closes its own menu), and describing it
 * afterwards would describe whatever replaced it.
 */
export async function clickAt(
  x: number,
  y: number,
  opts: { describe?: boolean } = {},
): Promise<{ frame: ConsoleFrame; descriptor: ElementDescriptor | null }> {
  const descriptor = opts.describe ? await describePoint(x, y) : null;
  await withSkoolPage(async (page) => {
    try {
      // The real mouse, not element.click(). Skool's menus are built on pointer
      // events and ignore a synthetic click entirely.
      await page.mouse.click(x, y, { delay: 40 });
    } catch {
      /* best effort */
    }
    await new Promise((r) => setTimeout(r, 1200));
  });
  return { frame: await frame(), descriptor };
}

export async function typeText(text: string): Promise<ConsoleFrame> {
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.type(text, { delay: 20 });
    } catch {
      /* best effort */
    }
    await new Promise((r) => setTimeout(r, 500));
  });
  return frame();
}

/**
 * Modifier names Puppeteer understands, and the ⌘ → Ctrl translation.
 *
 * ⚠️ THE REMOTE BROWSER RUNS ON LINUX. Chromium's accelerator there is Control,
 * not Meta — sending a literal Meta+A does nothing at all, silently, which
 * looks exactly like "the shortcut is not supported". So an operator on a Mac
 * pressing ⌘A gets Control+A sent to the page, which is what actually selects
 * the text they are looking at.
 */
const MODIFIER_ALIASES: Record<string, string> = {
  cmd: "Control",
  command: "Control",
  meta: "Control",
  ctrl: "Control",
  control: "Control",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
};

/**
 * Press a chord — modifiers held, key tapped, modifiers released.
 *
 * Released in reverse order and in a `finally`, because a modifier left stuck
 * down poisons every later keystroke in the session: the next plain click
 * becomes a ctrl-click, and nothing about the page explains why.
 */
export async function pressCombo(parts: string[]): Promise<ConsoleFrame> {
  const raw = parts.map((p) => p.trim()).filter(Boolean);
  if (raw.length === 0) return frame();

  const modifiers: string[] = [];
  let key = "";
  for (const part of raw) {
    const mapped = MODIFIER_ALIASES[part.toLowerCase()];
    if (mapped) {
      if (!modifiers.includes(mapped)) modifiers.push(mapped);
    } else {
      key = part;
    }
  }
  if (!key) return frame();

  // Copy/paste need clipboard permission or Chromium blocks the read. Granted
  // best-effort and only for Skool's own origin — a failure here degrades
  // paste, it does not break the chord.
  if (/^[cvx]$/i.test(key)) await grantClipboard();

  await withSkoolPage(async (page) => {
    try {
      for (const m of modifiers) await page.keyboard.down(m);
      try {
        await page.keyboard.press(key);
      } finally {
        for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
      }
    } catch {
      /* best effort — the runtime's contract */
    }
    await new Promise((r) => setTimeout(r, 700));
  });
  return frame();
}

async function grantClipboard(): Promise<void> {
  await withSkoolPage(async (page) => {
    try {
      const context = page.browserContext?.();
      await context?.overridePermissions?.("https://www.skool.com", ["clipboard-read", "clipboard-write"]);
    } catch {
      /* older Chromium, or a context that refuses — paste simply may not work */
    }
  });
}

export async function pressKey(key: string): Promise<ConsoleFrame> {
  // "Control+a" and friends route to the chord path — an operator typing a
  // shortcut into a key field should not have to know the difference.
  if (key.includes("+")) return pressCombo(key.split("+"));
  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.press(key);
    } catch {
      /* best effort */
    }
    await new Promise((r) => setTimeout(r, 800));
  });
  return frame();
}

export async function scrollBy(dy: number): Promise<ConsoleFrame> {
  await withSkoolPage(async (page) => {
    try {
      await page.evaluate((d: number) => (globalThis as any).scrollBy(0, d), dy);
    } catch {
      /* best effort */
    }
    await new Promise((r) => setTimeout(r, 500));
  });
  return frame();
}

/**
 * Empty the field that currently has focus.
 *
 * ⌘A + Delete already works, and select-all does scope itself to the focused
 * editing host — verified against Skool's own composer: it selected the post
 * body and left the title beside it untouched.
 *
 * The hole it does not cover is a MISSED CLICK. If the click that was meant to
 * land in the field landed just outside it, focus is on the document, ⌘A
 * selects the entire page, and the write path proceeds believing it cleared a
 * field. So this refuses when focus is not in something editable, and says so,
 * rather than doing something dramatic and reporting success.
 *
 * The selection is made in the page, but the DELETE is a real keystroke —
 * ProseMirror and React only update from real input events, and a
 * programmatic value change leaves the editor's own model untouched.
 */
export async function clearFocusedField(): Promise<{ cleared: boolean; reason: string }> {
  const ready = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el: any = doc.activeElement;
      if (!el || el === doc.body) return { ok: false, reason: "Nothing is focused — click into the field first." };

      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        if (!el.value) return { ok: true, reason: "already empty" };
        el.select();
        return { ok: true, reason: "input selected" };
      }

      // Walk to the editing host: focus often sits on a node inside it.
      let host: any = el;
      let hops = 0;
      while (host && host.getAttribute?.("contenteditable") !== "true" && hops < 6) {
        host = host.parentElement;
        hops++;
      }
      if (!host) return { ok: false, reason: "Focus is not in an editable field." };
      if (!(host.textContent || "").trim()) return { ok: true, reason: "already empty" };

      const range = doc.createRange();
      range.selectNodeContents(host);
      const sel = (globalThis as any).getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return { ok: true, reason: "editable selected" };
    }),
  );

  if (!ready?.ok) return { cleared: false, reason: ready?.reason ?? "The browser could not be reached." };
  if (ready.reason === "already empty") return { cleared: true, reason: "The field was already empty." };

  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.press("Delete");
    } catch {
      /* best effort */
    }
    await new Promise((r) => setTimeout(r, 500));
  });
  return { cleared: true, reason: ready.reason };
}

/** Describe whatever sits at a point, without touching it. */
export async function describePoint(x: number, y: number): Promise<ElementDescriptor | null> {
  const out = await withSkoolPage(async (page) =>
    page.evaluate(
      ({ px, py }: { px: number; py: number }) => {
        const doc: any = (globalThis as any).document;
        let el: any = doc.elementFromPoint(px, py);
        if (!el) return null;

        // elementFromPoint lands on the innermost node — often a bare <span> of
        // label text inside the control. Walk up to the thing that actually
        // handles the click: the nearest ancestor that looks interactive.
        const interactive = (n: any): boolean => {
          if (!n || !n.tagName) return false;
          const tag = n.tagName.toLowerCase();
          if (tag === "button" || tag === "a" || tag === "input" || tag === "textarea") return true;
          const role = n.getAttribute?.("role");
          if (role === "button" || role === "menuitem") return true;
          const cur = (globalThis as any).getComputedStyle?.(n)?.cursor;
          return cur === "pointer";
        };
        let hops = 0;
        while (el && !interactive(el) && hops < 6) {
          el = el.parentElement;
          hops++;
        }
        if (!el) return null;

        // ⚠️ AN ICON IS NOT A HANDLE. On an icon-only control the pointer
        // cursor is set on the <svg> itself, so the walk above stops there and
        // records a descriptor with no text, no aria label and no classes —
        // `div>div>div>button>div>svg` and nothing else. That is unusable on
        // replay. Keep climbing to the enclosing button/link, which is the
        // thing that actually carries identity.
        const BARE = new Set(["svg", "path", "use", "g", "img", "i", "span"]);
        let climbs = 0;
        while (el && BARE.has(el.tagName.toLowerCase()) && climbs < 4) {
          const parent = el.parentElement;
          if (!parent) break;
          el = parent;
          climbs++;
          const tag = el.tagName.toLowerCase();
          if (tag === "button" || tag === "a" || el.getAttribute?.("role") === "button") break;
        }
        if (!el) return null;

        // Still one short: the icon usually sits in a wrapper DIV inside the
        // button, and that wrapper carries no identity either. If what we have
        // has no text and its parent is the real control, take the parent.
        const hasIdentity = (n: any) =>
          Boolean((n.textContent || "").trim() || n.getAttribute("aria-label") || n.getAttribute("data-testid"));
        if (!hasIdentity(el) && el.parentElement) {
          const ptag = el.parentElement.tagName.toLowerCase();
          if (ptag === "button" || ptag === "a" || el.parentElement.getAttribute("role") === "button") {
            el = el.parentElement;
          }
        }

        const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const testId = el.getAttribute("data-testid");
        const ariaLabel = el.getAttribute("aria-label");
        const role = el.getAttribute("role");
        const classes = String(el.getAttribute("class") || "")
          .split(/\s+/)
          .filter(Boolean);

        // Which of the same-looking things is this one? Counted against the
        // best handle available, so the index means something on replay.
        const cssEscape = (globalThis as any).CSS?.escape ?? ((v: string) => v);
        const sameClass = classes.length
          ? Array.from(doc.querySelectorAll(`.${cssEscape(classes[0])}`))
          : [];
        const nth = Math.max(0, sameClass.indexOf(el));

        const chain: string[] = [];
        let p: any = el;
        while (p && chain.length < 6) {
          chain.unshift(p.tagName.toLowerCase());
          p = p.parentElement;
        }

        return {
          tag: el.tagName.toLowerCase(),
          text,
          testId: testId || null,
          ariaLabel: ariaLabel || null,
          role: role || null,
          classes,
          nth,
          path: chain.join(">"),
          neededHover: false,
        };
      },
      { px: x, py: y },
    ),
  );
  return (out as ElementDescriptor | null) ?? null;
}
