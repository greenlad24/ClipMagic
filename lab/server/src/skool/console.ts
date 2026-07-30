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

export async function pressKey(key: string): Promise<ConsoleFrame> {
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
