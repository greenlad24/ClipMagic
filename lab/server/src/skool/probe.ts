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

/** One call the page made to Skool's API while the probe was watching. */
export interface ProbeRequest {
  method: string;
  url: string;
  /** Null when the response never arrived before the probe stopped watching. */
  status: number | null;
}

export interface ProbeResult {
  url: string | null;
  title: string | null;
  elements: ProbeElement[];
  /** Skool (non-asset) calls seen during the probe. Empty unless `captureRequests`. */
  requests: ProbeRequest[];
  /**
   * EVERY request the page made, counted.
   *
   * ⚠️ THIS IS HOW YOU KNOW THE INSTRUMENT IS ALIVE. Zero `requests` with a
   * healthy `requestsSeen` means Skool really did not call anything; zero of
   * both means nothing was listening and the run proves nothing.
   */
  requestsSeen: number;
  /** Distinct hosts contacted — names the surface the filter may be missing. */
  requestHosts: string[];
  /** Whether a request listener was successfully attached at all. */
  watching: boolean;
  /** Why attaching failed, when it did. */
  watchError: string | null;
  /** Raw body of the `apiGet` path, truncated. Null unless asked for. */
  api: { status: number; body: string } | null;
  /** Present only when `dumpHtml` was asked for. Truncated to `htmlLimit`. */
  html: string | null;
  /**
   * Whether the dump hit its limit and lost the tail.
   *
   * ⚠️⚠️ A TRUNCATED DUMP READS EXACTLY LIKE A COMPLETE ONE, AND THAT HAS
   * ALREADY PRODUCED ONE CONFIDENT WRONG ANSWER HERE — the DM panel was
   * declared unreadable ("renders nothing") because it sat past a 40,000-char
   * cut, when in fact the account had 167 threads. The composer repeated it:
   * `skool-editor` was inside the window and `Select a category` was not, so
   * "no email toggle in the markup" was unprovable rather than false.
   *
   * So the reader is now TOLD when it is holding a fragment.
   */
  htmlTruncated: boolean;
  /** Whether the element list hit `elementLimit` and lost the tail. */
  elementsTruncated: boolean;
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
  /**
   * How much of `document.body.innerHTML` to keep. Default 40,000.
   *
   * ⚠️ 40,000 IS NOT ENOUGH TO SEE A SKOOL MODAL. The post composer alone
   * overruns it, because the emoji picker renders ~1,800 nodes inline before
   * the category row and the buttons below it — so the half of the modal that
   * matters is the half that gets cut.
   */
  htmlLimit?: number;
  /**
   * How many described elements to return. Default 160.
   *
   * ⚠️ AND THIS CAP TOLD THE SAME LIE THE HTML ONE DID, ON THE SAME DAY. Probing
   * "Add video" and "Add gif" reported no new field appearing — which reads as a
   * finding about Skool's composer ("those buttons open nothing") and was a
   * finding about this number. Both runs returned EXACTLY 160 elements, the tell
   * that a list has been cut rather than exhausted.
   */
  elementLimit?: number;
  /** Dotted path into `props.pageProps` — e.g. "self" or "currentGroup.metadata". */
  payloadPath?: string;
  /**
   * Record the calls the page makes to `api2.skool.com`.
   *
   * The surface this reveals is not visible any other way: Skool's chat panel
   * renders nothing at all into the DOM, so what it FETCHES is the only
   * available evidence about how DMs work.
   */
  captureRequests?: boolean;
  /**
   * Fetch one `api2.skool.com` path from inside the page and return its raw body.
   *
   * ⚠️ GET ONLY, AND api2.skool.com ONLY — this is reconnaissance, not a client.
   * It exists because the chat panel renders NOTHING into the DOM: the only way
   * to learn what a DM looks like is to ask the endpoint the panel itself calls
   * (`/self/chat-channels`, found with `captureRequests`). Running it inside the
   * page means it carries the session cookies without this module ever handling
   * them — the same bargain as reading `__NEXT_DATA__`.
   */
  apiGet?: string;
  /**
   * A SECOND click, after the first has settled.
   *
   * ⚠️ SOME OF SKOOL IS TWO CLICKS DEEP AND CANNOT BE REACHED IN ONE. The chat
   * panel is the case that forced this: opening it fires `/self/chat-channels`,
   * but the call that loads a CONVERSATION only happens once a thread inside the
   * panel is clicked, and the panel does not exist until the first click. Probing
   * one click at a time can therefore see the thread list and never the messages
   * — and guessing the messages path instead produced three straight 404s.
   */
  thenClickText?: string;
  thenClickSelector?: string;
  thenWaitMs?: number;
}): Promise<ProbeResult> {
  const {
    url,
    hoverText,
    clickText,
    clickSelector,
    clickIndex = 0,
    waitMs = 2500,
    dumpHtml = false,
    htmlLimit = 40_000,
    elementLimit = 160,
    payloadPath,
    captureRequests = false,
    apiGet,
    thenClickText,
    thenClickSelector,
    thenWaitMs = 4000,
  } = opts;
  const empty = (error: string): ProbeResult => ({
    url: null,
    title: null,
    elements: [],
    requests: [],
    requestsSeen: 0,
    requestHosts: [],
    watching: false,
    watchError: null,
    api: null,
    html: null,
    htmlTruncated: false,
    elementsTruncated: false,
    payload: null,
    clicked: null,
    error,
  });
  if (!url) return empty("No URL to probe.");

  const out = await withSkoolPage(async (page) => {
    // ⚠️⚠️ THE NETWORK IS WHERE SKOOL'S REAL SURFACE IS, AND THE DOM IS NOT.
    // The comments API — the only place a comment id exists — was found by
    // watching a post page load, not by reading its markup. The chat panel makes
    // the same point from the other side: it renders NOTHING into the DOM (two
    // occurrences of "chat", both the button's aria-label), so a DM path cannot
    // be built by looking at elements at all. What it fetches is the only
    // evidence available about how DMs work.
    //
    // Recorded for `api2.skool.com` only. The page also pulls fonts, images and
    // analytics, and a list that includes those buries the one line that matters.
    // ⚠️ THE TOTAL IS RECORDED SEPARATELY, AND THAT IS NOT BOOKKEEPING. The first
    // version filtered to `api2.skool.com` and reported zero calls when the chat
    // panel was opened — which reads as "opening chats fetches nothing" and is a
    // real finding. It was not one: a CONTROL RUN against a post page, which is
    // known to use that API, also reported zero. The filter was the bug. An
    // instrument that cannot tell "nothing matched" from "nothing was watching"
    // reports its own failure as a discovery about Skool.
    const requests: ProbeRequest[] = [];
    let totalSeen = 0;
    const hosts = new Set<string>();
    const onRequest = (req: any): void => {
      // ⚠️ COUNT FIRST, THEN INSPECT. The previous ordering read `req.url()`
      // before incrementing, so anything thrown while inspecting the request
      // landed in the catch below with the counter still at zero — the exact
      // "nothing was watching" reading this counter exists to rule out.
      totalSeen += 1;
      try {
        const u = String(req.url?.() ?? "");
        try {
          hosts.add(new URL(u).host);
        } catch {
          /* an unparseable URL still counts toward the total */
        }
        // Anything that is not a static asset. Skool's own frontend calls are
        // the point; fonts, images and analytics bury the line that matters.
        if (!/skool\.com/.test(u)) return;
        if (/\.(png|jpe?g|gif|svg|webp|woff2?|ttf|css|ico|mp4)(\?|$)/i.test(u)) return;
        requests.push({ method: String(req.method() ?? ""), url: u.slice(0, 300), status: null });
      } catch {
        /* a probe that throws on its own instrumentation is worse than one that misses a line */
      }
    };
    const onResponse = (res: any): void => {
      try {
        const u = String(res.url() ?? "");
        if (!u.includes("api2.skool.com")) return;
        const hit = requests.find((r) => r.url === u.slice(0, 300) && r.status === null);
        if (hit) hit.status = Number(res.status());
      } catch {
        /* as above */
      }
    };
    // ⚠️ WHETHER THE LISTENER COULD BE ATTACHED AT ALL IS REPORTED, not assumed.
    // `withSkoolPage` hands out an `AnyPage` — a deliberately untyped handle —
    // so "does this object emit request events?" is a question about the runtime,
    // not about Skool, and a silent no would look identical to a quiet network.
    let watching = false;
    let watchError: string | null = null;
    if (captureRequests) {
      try {
        page.on("request", onRequest);
        page.on("response", onResponse);
        watching = true;
      } catch (e: any) {
        watching = false;
        watchError = String(e?.message ?? e).slice(0, 200);
      }
    }

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

    // The second click, on whatever the first one revealed.
    if (thenClickText || thenClickSelector) {
      const hit = await page.evaluate(
        ({ txt, sel }: { txt: string | null; sel: string | null }) => {
          const doc: any = (globalThis as any).document;
          const vis = (el: any): boolean => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          let el: any = null;
          if (sel) {
            el = (Array.from(doc.querySelectorAll(sel)) as any[]).filter(vis)[0] ?? null;
          } else if (txt) {
            const wanted = txt.trim().toLowerCase();
            const all = (Array.from(doc.querySelectorAll("*")) as any[]).filter(
              (e) => vis(e) && (e.textContent || "").trim().toLowerCase().includes(wanted),
            );
            // Smallest containing element — the same rule the first click uses,
            // because every ancestor up to <body> also "contains" the text.
            all.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
            el = all[0] ?? null;
          }
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        },
        { txt: thenClickText ?? null, sel: thenClickSelector ?? null },
      );
      if (hit) {
        try {
          await page.mouse.click(hit.x, hit.y, { delay: 40 });
        } catch {
          /* best effort */
        }
        await new Promise((r) => setTimeout(r, thenWaitMs));
      }
    }

    const described = await page.evaluate((limit: number) => {
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
        .slice(0, limit);
      return {
        url: (globalThis as any).location?.href ?? null,
        title: doc.title ?? null,
        elements,
        elementsTruncated: elements.length >= limit,
      };
    }, elementLimit);

    const rawHtml = dumpHtml
      ? String(await page.evaluate(() => (globalThis as any).document?.body?.innerHTML ?? ""))
      : null;
    const html = rawHtml === null ? null : rawHtml.slice(0, htmlLimit);
    const htmlTruncated = rawHtml !== null && rawHtml.length > htmlLimit;

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

    if (captureRequests) {
      page.off("request", onRequest);
      page.off("response", onResponse);
    }

    const api = apiGet
      ? await page.evaluate(async (path: string) => {
          const g: any = globalThis;
          const url = path.startsWith("http") ? path : `https://api2.skool.com${path}`;
          if (!/^https:\/\/api2\.skool\.com\//.test(url)) return { status: -1, body: "refused: not api2.skool.com" };
          try {
            const res = await g.fetch(url, { credentials: "include" });
            const text = await res.text();
            return { status: Number(res.status), body: String(text).slice(0, 12_000) };
          } catch (e: any) {
            return { status: -1, body: String(e?.message ?? e).slice(0, 200) };
          }
        }, apiGet)
      : null;

    return {
      ...described,
      api,
      html,
      htmlTruncated,
      payload,
      clicked,
      requests,
      requestsSeen: totalSeen,
      watching,
      watchError,
      requestHosts: [...hosts].slice(0, 25),
      error: null,
    };
  });

  return out ?? empty("The browser could not be reached.");
}
