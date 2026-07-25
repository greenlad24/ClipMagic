/**
 * Engagement Manager — reply delivery (Phase 3).
 *
 * TWO PATHS, in order of preference:
 *
 *  1. META GRAPH API — addressed by the comment id the monitor already stored.
 *     The token is the auth, so there's no session, no selectors, no captcha
 *     and no ToS grey area. This is how Instagram and Facebook SHOULD reply,
 *     and Instagram can today: the operator's token already carries
 *     `instagram_manage_comments`. Facebook additionally needs
 *     `pages_manage_engagement`, which it currently lacks.
 *
 *  2. HEADLESS BROWSER — typed into the real web UI in the logged-in profile
 *     (engage/browser.ts). The fallback when the API says "not permitted", and
 *     the only route for TikTok, which has no comment API at all.
 *
 * A permission error falls through to the browser. Any other API failure (bad
 * id, deleted comment, dead token) is reported as-is — retrying a genuinely
 * broken request in a browser just fails differently and hides the cause.
 *
 * ⚠️ SELECTOR STATUS — read before trusting this in production.
 * Instagram, Facebook and TikTok all ship obfuscated, frequently-churned DOM.
 * Every sender therefore matches on a LIST of candidate selectors, preferring
 * stable accessibility attributes (aria-label, role, contenteditable) over
 * class names, and gives up cleanly instead of clicking something random.
 *
 * Verified 2026-07-23 against Jake's own logged-in accounts, read-only:
 *   - instagram: composer FOUND on a real reel ("Add a comment…").
 *   - facebook:  composer FOUND on his Page ("Comment as Jake Dawson").
 * Verified 2026-07-25 against a real logged-in TikTok video, read-only (session
 * carried over via cookie import):
 *   - tiktok:    the composer is a bare `div[contenteditable][role="textbox"]`
 *                with NO comment-specific aria-label/data-e2e, wrapped in
 *                `[data-e2e="comment-input"]`; the Post button is
 *                `button[data-e2e="comment-post"]`. CRUCIALLY it is not in the
 *                DOM at all until the comment panel is opened by clicking
 *                `[data-e2e="comment-icon"]` — a video permalink lands with
 *                comments collapsed. openTikTokComments() below does that.
 * What is still unproven everywhere is the SUBMIT half: nobody has posted a
 * reply through this yet, because there are no real comments to answer (all
 * three accounts are pre-launch/empty). Finding the box is not the same as the
 * reply landing. TikTok additionally serves an intermittent slider captcha from
 * this datacenter IP (observed on some navigations, not all) that an unattended
 * worker cannot solve — so TikTok browser replies are best-effort at best.
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
import { getChannelAuth } from "./db.js";
import { getMetaCreds } from "../settings/postizSecrets.js";
import {
  isPermissionError,
  metaConfigured,
  replyToFacebookComment,
  replyToInstagramComment,
} from "./metaGraph.js";
import type { ReplyMechanism } from "./types.js";

export interface SendResult {
  ok: boolean;
  /** Platform-native id of the posted reply, when we can read one back. */
  externalId: string | null;
  /** Populated on failure, or with the dry-run notice. */
  error: string | null;
  /** True when the sender stopped short of submitting (dry run). */
  dryRun: boolean;
  /** How it went out (or would have). Recorded on the reply row. */
  mechanism: ReplyMechanism;
}

/**
 * Post a reply the proper way: Meta's Graph API, addressed by the comment id the
 * monitor already stored. No browser, no session, no selectors — the token is
 * the auth. This is the PREFERRED path for Instagram and Facebook; the browser
 * is the fallback for when a permission is missing (Facebook needs
 * `pages_manage_engagement`, which the current token lacks) and the only path
 * for TikTok, which has no comment API at all.
 *
 * Returns null when the API can't be attempted, so the caller falls through to
 * the browser rather than treating it as a failure.
 */
async function sendViaMetaApi(
  platform: BrowserPlatform,
  opts: { channelId: string; commentId: string | null; threadId: string | null; text: string },
): Promise<SendResult | null> {
  if (platform === "tiktok") return null;
  if (!metaConfigured()) return null;

  // The page token stored at seed time; falls back to the operator's user token.
  const token = getChannelAuth(opts.channelId) || getMetaCreds()?.token || "";
  if (!token) return null;

  // Instagram only threads one level deep, so a reply must be addressed to the
  // TOP-LEVEL comment. Facebook accepts a reply on the specific comment.
  const targetId = platform === "instagram" ? opts.threadId || opts.commentId : opts.commentId || opts.threadId;
  if (!targetId) return null;

  if (dryRunEnabled()) {
    return {
      ok: false,
      externalId: null,
      dryRun: true,
      mechanism: "meta-api",
      error: `DRY RUN — would have replied via the Graph API on comment ${targetId}. Set ENGAGE_REPLY_DRY_RUN=false to post.`,
    };
  }

  try {
    const id =
      platform === "instagram"
        ? await replyToInstagramComment(targetId, opts.text, token)
        : await replyToFacebookComment(targetId, opts.text, token);
    return { ok: true, externalId: id, error: null, dryRun: false, mechanism: "meta-api" };
  } catch (e) {
    if (isPermissionError(e)) {
      // Missing scope — this is exactly what the browser fallback is for.
      console.warn(`[engage/reply] ${platform} API reply not permitted, falling back to the browser: ${errMsg(e)}`);
      return null;
    }
    // A real failure (bad id, deleted comment, expired token). Don't paper over
    // it by retrying in a browser — report it.
    return { ok: false, externalId: null, dryRun: false, mechanism: "meta-api", error: errMsg(e) };
  }
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
    // Verified against Jake's own Page: the composer is labelled "Comment as
    // <name>", NOT "Write a comment". That variant is kept below because it's
    // what a non-Page post shows.
    'div[contenteditable="true"][aria-label*="Comment as" i]',
    'div[contenteditable="true"][aria-label*="Write a comment" i]',
    'div[contenteditable="true"][aria-label*="comment" i]',
    // Last resort ONLY: on a Facebook page the status composer ("What's on your
    // mind?") is also a role=textbox, so this can grab the wrong box. It stays
    // last so a labelled match always wins.
    'div[role="textbox"][contenteditable="true"]',
  ],
  tiktok: [
    // Verified 2026-07-25: the composer carries no comment-specific attribute of
    // its own, so anchor via the wrapper first, then fall back to the plain
    // role=textbox contenteditable (there is exactly one on an open comment panel).
    'div[data-e2e="comment-input"] div[contenteditable="true"]',
    'div[data-e2e="comment-input"] [contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
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
    // Verified 2026-07-25: <button data-e2e="comment-post" aria-label="Post">.
    'button[data-e2e="comment-post"]:not([disabled]):not([aria-disabled="true"])',
    'div[data-e2e="comment-post"]:not([aria-disabled="true"])',
    'button[aria-label="Post" i][data-e2e="comment-post"]',
  ],
};

/**
 * TikTok video permalinks load with the comment panel COLLAPSED — the composer
 * isn't in the DOM until the comment icon is clicked (verified 2026-07-25). Open
 * it, but only if the composer isn't already present: clicking the icon while
 * the panel is open would toggle it shut. Best-effort — never throws.
 */
async function openTikTokComments(page: any): Promise<void> {
  const already = await waitForAny(page, COMPOSER_SELECTORS.tiktok, 4_000);
  if (already) return;
  try {
    await page.click('[data-e2e="comment-icon"]');
    await sleep(randInt(2_000, 3_500));
  } catch {
    // The composer search below reports cleanly if it's still not there.
  }
}

/**
 * Post a reply on a platform. NEVER throws — every failure path returns a
 * SendResult the worker can record against the reply row.
 */
export async function sendReply(
  platform: BrowserPlatform,
  opts: {
    permalink: string | null;
    text: string;
    /** The channel the reply goes out from (holds the Meta page token). */
    channelId: string;
    /** Platform-native id of the comment being answered (InboxItem.dedupKey). */
    commentId: string | null;
    /** Top-level comment id — what Instagram's API needs. */
    threadId: string | null;
  },
): Promise<SendResult> {
  const { permalink, text } = opts;

  // API FIRST for Instagram and Facebook. Only when it can't be attempted —
  // missing scope, no token, TikTok — do we drive a browser.
  const viaApi = await sendViaMetaApi(platform, {
    channelId: opts.channelId,
    commentId: opts.commentId,
    threadId: opts.threadId,
    text,
  });
  if (viaApi) return viaApi;

  if (!permalink) {
    return {
      ok: false,
      externalId: null,
      error: "No permalink on the item — nowhere for the browser to reply.",
      dryRun: false,
      mechanism: "browser",
    };
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
      mechanism: "browser",
    };
  }

  const dry = dryRunEnabled();

  // Annotated so the object literals keep their literal `mechanism` type
  // rather than widening to `string`.
  const result = await withPage<SendResult>(platform, async (page) => {
    // 1. Open the post the comment lives on.
    try {
      await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (e) {
      return { ok: false, externalId: null, error: `Navigation failed: ${errMsg(e)}`, dryRun: dry, mechanism: "browser" };
    }
    // Let the comment section hydrate; these are all heavy SPA pages.
    await sleep(randInt(2_500, 5_000));

    // 1b. TikTok lands with comments collapsed — open the panel or there is no
    //     composer to find. (Instagram/Facebook show theirs by default.)
    if (platform === "tiktok") await openTikTokComments(page);

    // 2. Find the composer.
    const composer = await waitForAny(page, COMPOSER_SELECTORS[platform], 20_000);
    if (!composer) {
      return {
        ok: false,
        externalId: null,
        error: "Could not find the comment composer (logged out, or the page layout changed).",
        dryRun: dry,
        mechanism: "browser",
      };
    }

    // 3. Focus it like a person would — click, pause, then type.
    try {
      await page.click(composer);
    } catch (e) {
      return { ok: false, externalId: null, error: `Could not focus the composer: ${errMsg(e)}`, dryRun: dry, mechanism: "browser" };
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
        mechanism: "browser",
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
        return { ok: false, externalId: null, error: `Could not submit: ${errMsg(e)}`, dryRun: false, mechanism: "browser" };
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
        mechanism: "browser",
      };
    }
    return { ok: true, externalId: null, error: null, dryRun: false, mechanism: "browser" };
  });

  if (!result) {
    return { ok: false, externalId: null, error: "Browser unavailable.", dryRun: dry, mechanism: "browser" };
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
