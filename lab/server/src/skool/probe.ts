/**
 * A development probe for Skool's editing UI.
 *
 * READING Skool needs no DOM at all — the page ships its state as JSON. WRITING
 * does, and Skool's class names are obfuscated and change without notice, so the
 * selectors have to be learned from the real logged-in DOM rather than guessed.
 * The engagement tool's two worst bugs were both a guessed selector silently
 * matching the wrong element, and both were found in production.
 *
 * So: this navigates, optionally hovers, optionally clicks, and reports what is
 * actually on the page. It exists so the write path can be built against
 * observed structure.
 *
 * ⚠️ IT FINDS CONTROLS BY COMPUTED CURSOR, NOT BY TAG, and that is the whole
 * lesson of its first version. Asking for `button, a[href], [role="button"]`
 * reported that this classroom had NO admin UI at all — no "New Course" tile,
 * no edit menu, nothing — and that conclusion was wrong. Skool builds those as
 * plain divs with click handlers, icon buttons with no text, and dropdowns that
 * do not exist in the DOM until they are opened. A tag-based probe cannot see
 * any of it, and reports their absence with total confidence.
 *
 * ⚠️ THIS IS A DEVELOPMENT TOOL AND IT IS BROADLY CAPABLE — it can drive the
 * logged-in browser to any URL and dump the page. It is behind the lab's sign-in
 * gate, and it never types into a field or submits anything: clicking is limited
 * to matching visible text, and there is no fill/submit here on purpose. Remove
 * it once the write path's selectors are settled.
 */
import { withSkoolPage } from "./browser.js";

export interface ProbeElement {
  tag: string;
  /** How this element was found — `tag` or `cursor:pointer`. */
  via: string;
  /** Trimmed visible text, capped — enough to recognise a control by. */
  text: string;
  testId: string | null;
  ariaLabel: string | null;
  role: string | null;
  type: string | null;
  placeholder: string | null;
  /** Class attribute — often the only handle on an icon-only control. */
  cls: string;
  /** Whether it is actually on screen. A hidden match is the classic wrong match. */
  visible: boolean;
}

export interface ProbeResult {
  url: string | null;
  title: string | null;
  elements: ProbeElement[];
  /** Present only when `dumpHtml` was asked for. Truncated. */
  html: string | null;
  /** Present only when `payloadPath` was asked for — JSON at that path in pageProps. */
  payload: any;
  clicked: string | null;
  error: string | null;
}

/**
 * Navigate, optionally click something by its visible text, and describe the
 * controls on the resulting page.
 */
export async function probeSkool(opts: {
  url: string;
  /**
   * Hover this text first. Skool reveals per-card controls (the 3-dots menu)
   * only on hover, so they cannot be clicked without it.
   */
  hoverText?: string;
  clickText?: string;
  /** Click by CSS selector instead of text — for icons with no text at all. */
  clickSelector?: string;
  /** Which match to click when several are the same. Defaults to the first. */
  clickIndex?: number;
  waitMs?: number;
  dumpHtml?: boolean;
  /** Dotted path into `props.pageProps` — e.g. "self" or "currentGroup.metadata". */
  payloadPath?: string;
}): Promise<ProbeResult> {
  const { url, hoverText, clickText, clickSelector, clickIndex = 0, waitMs = 2500, dumpHtml = false, payloadPath } = opts;
  const empty = (error: string): ProbeResult => ({
    url: null,
    title: null,
    elements: [],
    html: null,
    payload: null,
    clicked: null,
    error,
  });
  if (!url) return empty("No URL to probe.");

  const out = await withSkoolPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, waitMs));

    // Hover first: a control that only exists on hover cannot be clicked, and
    // a real mouse move is what triggers it — dispatching a synthetic event on
    // the wrong node silently does nothing.
    if (hoverText) {
      const box = await page.evaluate((needle: string) => {
        const doc: any = (globalThis as any).document;
        const wanted = needle.trim().toLowerCase();
        const all = Array.from(doc.querySelectorAll("*")) as any[];
        const hits = all.filter((el) => {
          const t = (el.textContent || "").trim().toLowerCase();
          if (!t.includes(wanted)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!hits.length) return null;
        hits.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
        const r = hits[0].getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, hoverText);
      if (box) {
        try {
          await page.mouse.move(box.x, box.y);
        } catch {
          /* best effort — the runtime's contract */
        }
        await new Promise((r) => setTimeout(r, 900));
      }
    }

    let clicked: string | null = null;
    if (clickSelector) {
      clicked = await page.evaluate(
        ({ sel, idx }: { sel: string; idx: number }) => {
          const doc: any = (globalThis as any).document;
          const els = (Array.from(doc.querySelectorAll(sel)) as any[]).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const el = els[idx];
          if (!el) return null;
          el.click();
          return (el.textContent || el.getAttribute("aria-label") || sel).trim().slice(0, 80) || sel;
        },
        { sel: clickSelector, idx: clickIndex },
      );
      await new Promise((r) => setTimeout(r, 1800));
    } else if (clickText) {
      clicked = await page.evaluate(
        ({ needle, idx }: { needle: string; idx: number }) => {
        const doc: any = (globalThis as any).document;
        const win: any = globalThis;
        const wanted = needle.trim().toLowerCase();
        // EVERY element, then narrowed by what it looks like to a user — a
        // pointer cursor. Tag-based candidate lists miss Skool's plain-div
        // controls entirely.
        const candidates = Array.from(doc.querySelectorAll("*")) as any[];
        // Prefer the SMALLEST element whose text matches: a page-wide container
        // also "contains" the text, and clicking that does nothing useful.
        const hits = candidates.filter((el) => {
          const t = (el.textContent || "").trim().toLowerCase();
          if (!t || !t.includes(wanted)) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const cur = win.getComputedStyle?.(el)?.cursor;
          const tag = el.tagName.toLowerCase();
          return cur === "pointer" || tag === "button" || tag === "a" || el.getAttribute("role") === "button";
        });
        if (hits.length === 0) return null;
        // Smallest matching text wins: a page-wide container also "contains"
        // the words, and clicking that does nothing useful.
        hits.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
        const el = hits[idx] ?? hits[0];
        const label = (el.textContent || "").trim().slice(0, 80);
        el.click();
        return label;
      },
        { needle: clickText, idx: clickIndex },
      );
      await new Promise((r) => setTimeout(r, 1800));
    }

    const described = await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const win: any = globalThis;
      const TAGS = new Set(["button", "input", "textarea", "select"]);
      const els = (Array.from(doc.querySelectorAll("*")) as any[]).filter((el) => {
        const tag = el.tagName.toLowerCase();
        if (TAGS.has(tag)) return true;
        if (tag === "a" && el.getAttribute("href")) return true;
        const role = el.getAttribute("role");
        if (role === "button" || role === "menuitem") return true;
        if (el.getAttribute("contenteditable") === "true") return true;
        // The part that matters: anything the browser says is clickable, but
        // only when it is a LEAF-ish node. A pointer cursor is inherited, so
        // without this every ancestor of a button reports as clickable too.
        const cur = win.getComputedStyle?.(el)?.cursor;
        if (cur !== "pointer") return false;
        const parentCur = el.parentElement ? win.getComputedStyle?.(el.parentElement)?.cursor : null;
        return parentCur !== "pointer";
      });
      const seen = new Set<string>();
      const elements = els
        .map((el) => {
          const r = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role");
          const viaTag =
            TAGS.has(tag) || (tag === "a" && el.getAttribute("href")) || role === "button" || role === "menuitem";
          return {
            tag,
            via: viaTag ? "tag" : "cursor:pointer",
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70),
            // Icon-only controls have no text at all — the class is often the
            // only handle on them.
            cls: String(el.getAttribute("class") || "").slice(0, 60),
            testId: el.getAttribute("data-testid") || null,
            ariaLabel: el.getAttribute("aria-label") || null,
            role: el.getAttribute("role") || null,
            type: el.getAttribute("type") || null,
            placeholder: el.getAttribute("placeholder") || null,
            visible: r.width > 0 && r.height > 0,
          };
        })
        .filter((e) => {
          // Collapse the repeats — a classroom page has 30 identical course
          // links and they tell us nothing we don't already know.
          const key = `${e.tag}|${e.text}|${e.testId}|${e.ariaLabel}|${e.placeholder}|${e.cls}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 160);
      return {
        url: (globalThis as any).location?.href ?? null,
        title: doc.title ?? null,
        elements,
      };
    });

    const html = dumpHtml
      ? String(await page.evaluate(() => (globalThis as any).document?.body?.innerHTML ?? "")).slice(0, 40_000)
      : null;

    // The payload is the reliable half of Skool. When the DOM is ambiguous —
    // is this session even an admin? — the answer is usually in here.
    const payload = payloadPath
      ? await page.evaluate((path: string) => {
          const doc: any = (globalThis as any).document;
          const el = doc?.getElementById("__NEXT_DATA__");
          if (!el?.textContent) return null;
          let node: any;
          try {
            node = JSON.parse(el.textContent)?.props?.pageProps;
          } catch {
            return null;
          }
          for (const key of path.split(".")) {
            if (node == null) return null;
            node = node[key];
          }
          // Returned as a TRUNCATED STRING, not an object: some of these
          // subtrees are megabytes, and slicing the JSON then re-parsing it
          // just throws on the cut.
          try {
            return JSON.stringify(node ?? null).slice(0, 8000);
          } catch {
            return String(node);
          }
        }, payloadPath)
      : null;

    return { ...described, html, payload, clicked, error: null };
  });

  return out ?? empty("The browser could not be reached.");
}
