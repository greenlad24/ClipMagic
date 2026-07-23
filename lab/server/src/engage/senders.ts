/**
 * Engagement Manager — per-platform reply senders (Phase 3).
 *
 * Posts a drafted reply by driving the real web UI in the logged-in headless
 * profile (engage/browser.ts). One sender per platform, because each one's
 * comment composer is a different beast.
 *
 * ⚠️ SELECTOR CAVEAT — read before trusting this in production.
 * Instagram, Facebook and TikTok all ship obfuscated, frequently-churned DOM.
 * Every sender therefore matches on a LIST of candidate selectors, preferring
 * stable accessibility attributes (aria-label, role, contenteditable) over
 * class names, and gives up cleanly instead of clicking something random. Even
 * so, these selectors have NOT been verified against a live logged-in session:
 * all three of Jake's accounts are currently empty, so there is no real comment
 * to answer and no way to confirm the flow end-to-end. Expect one selector pass
 * against a real post before the first live reply.
 *
 * That uncertainty is exactly why DRY RUN DEFAULTS ON (ENGAGE_REPLY_DRY_RUN):
 * the sender navigates, locates the composer and types the reply, then stops
 * short of submitting and reports what it would have done. Set the env var to
 * "false" to actually post.
 */
import {
  errMsg,
  randInt,
  sleep,
  typeHuman,
  waitForAny,
  withPage,
  type BrowserPlatform,
} from "./browser.js";
import { navigationAllowed } from "./browserSession.js";

export interface SendResult {
  ok: boolean;
  /** Platform-native id of the posted reply, when we can read one back. */
  externalId: string | null;
  /** Populated on failure, or with the dry-run notice. */
  error: string | null;
  /** True when the sender stopped short of submitting (dry run). */
  dryRun: boolean;
}

/** Dry run is ON unless explicitly disabled — see the caveat above. */
export function dryRunEnabled(): boolean {
  return (process.env.ENGAGE_REPLY_DRY_RUN || "true").toLowerCase() !== "false";
}

/** Composer selectors per platform, most-specific first. */
const COMPOSER_SELECTORS: Record<BrowserPlatform, string[]> = {
  instagram: [
    'textarea[aria-label*="Add a comment" i]',
    'textarea[placeholder*="Add a comment" i]',
    'form textarea[aria-label*="comment" i]',
    'div[contenteditable="true"][aria-label*="comment" i]',
  ],
  facebook: [
    'div[contenteditable="true"][aria-label*="Write a comment" i]',
    'div[contenteditable="true"][aria-label*="comment" i]',
    'div[role="textbox"][contenteditable="true"]',
  ],
  tiktok: [
    'div[contenteditable="true"][aria-label*="comment" i]',
    'div[contenteditable="true"][data-e2e*="comment" i]',
    'div[data-e2e="comment-input"] div[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ],
};

/**
 * Explicit submit buttons, where the platform has one. Instagram and Facebook
 * accept Enter in the composer; TikTok wants its Post button clicked.
 */
const SUBMIT_SELECTORS: Record<BrowserPlatform, string[]> = {
  instagram: ['form div[role="button"]:not([aria-disabled="true"])', 'button[type="submit"]:not([disabled])'],
  facebook: [],
  tiktok: [
    'div[data-e2e="comment-post"]:not([aria-disabled="true"])',
    'button[data-e2e="comment-post"]:not([disabled])',
  ],
};

/**
 * Post a reply on a platform. NEVER throws — every failure path returns a
 * SendResult the worker can record against the reply row.
 */
export async function sendReply(
  platform: BrowserPlatform,
  opts: { permalink: string | null; text: string },
): Promise<SendResult> {
  const { permalink, text } = opts;
  if (!permalink) {
    return { ok: false, externalId: null, error: "No permalink on the item — nowhere to reply.", dryRun: false };
  }
  if (!navigationAllowed(platform, permalink)) {
    // The permalink comes from the platform's own API/scrape, but it is still
    // data we didn't author — don't navigate the logged-in browser anywhere
    // outside the platform's domain on its say-so.
    return {
      ok: false,
      externalId: null,
      error: `Refusing to navigate to an off-platform permalink: ${permalink}`,
      dryRun: false,
    };
  }

  const dry = dryRunEnabled();

  const result = await withPage(platform, async (page) => {
    // 1. Open the post the comment lives on.
    try {
      await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (e) {
      return { ok: false, externalId: null, error: `Navigation failed: ${errMsg(e)}`, dryRun: dry };
    }
    // Let the comment section hydrate; these are all heavy SPA pages.
    await sleep(randInt(2_500, 5_000));

    // 2. Find the composer.
    const composer = await waitForAny(page, COMPOSER_SELECTORS[platform], 20_000);
    if (!composer) {
      return {
        ok: false,
        externalId: null,
        error: "Could not find the comment composer (logged out, or the page layout changed).",
        dryRun: dry,
      };
    }

    // 3. Focus it like a person would — click, pause, then type.
    try {
      await page.click(composer);
    } catch (e) {
      return { ok: false, externalId: null, error: `Could not focus the composer: ${errMsg(e)}`, dryRun: dry };
    }
    await sleep(randInt(400, 1_200));
    await typeHuman(page, text);
    await sleep(randInt(600, 1_600));

    // 4. Submit — unless this is a dry run, in which case stop here. The typed
    //    text is deliberately left in the composer and NOT submitted; closing
    //    the page discards it.
    if (dry) {
      return {
        ok: false,
        externalId: null,
        error: "DRY RUN — composed the reply but did not post it. Set ENGAGE_REPLY_DRY_RUN=false to post.",
        dryRun: true,
      };
    }

    const submitSelectors = SUBMIT_SELECTORS[platform];
    let submitted = false;
    if (submitSelectors.length > 0) {
      const btn = await waitForAny(page, submitSelectors, 5_000);
      if (btn) {
        try {
          await page.click(btn);
          submitted = true;
        } catch {
          /* fall through to Enter */
        }
      }
    }
    if (!submitted) {
      try {
        await page.keyboard.press("Enter");
        submitted = true;
      } catch (e) {
        return { ok: false, externalId: null, error: `Could not submit: ${errMsg(e)}`, dryRun: false };
      }
    }

    // 5. Verify it landed. The composer clearing is the most portable signal
    //    across all three platforms — an id we could read back reliably isn't
    //    exposed in the DOM without a lot more scraping.
    await sleep(randInt(2_500, 4_500));
    const stillThere = await composerStillHasText(page, composer, text);
    if (stillThere) {
      return {
        ok: false,
        externalId: null,
        error: "Submitted but the composer still holds the text — the reply probably did not post.",
        dryRun: false,
      };
    }
    return { ok: true, externalId: null, error: null, dryRun: false };
  });

  if (!result) {
    return { ok: false, externalId: null, error: "Browser unavailable.", dryRun: dry };
  }
  return result;
}

/** Does the composer still contain (the start of) what we typed? */
async function composerStillHasText(page: any, selector: string, text: string): Promise<boolean> {
  try {
    const value: string = await page.$eval(selector, (el: any) => el.value ?? el.textContent ?? "");
    const probe = text.slice(0, 20).trim();
    return !!probe && value.includes(probe);
  } catch {
    // Composer gone from the DOM entirely — that reads as "submitted".
    return false;
  }
}
