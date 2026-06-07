/**
 * Per-provider `settings` adapter for create-post payloads — ISOLATED here
 * because this is the most version-sensitive part of the Postiz contract.
 *
 * Every channel in a create-post request carries a `settings` object whose
 * `__type` MUST equal the channel's `identifier` (x, tiktok, youtube, …). Some
 * providers also require extra fields (e.g. YouTube wants a title; TikTok wants
 * a privacy level). Postiz validates these per-provider DTOs and 400s on a bad
 * shape, but the exact required keys differ across Postiz versions and aren't
 * fully documented (see gitroomhq/postiz-app#717, #7 n8n).
 *
 * Strategy: send a SAFE minimum that works for the common short-form trio
 * (TikTok / Instagram Reels / YouTube Shorts) and is easy to extend. Each
 * provider's extras are a tiny data-driven map below, so tuning against a live
 * server is a one-line change.
 *
 * TODO(live): validate each provider's required `settings` against the running
 * Postiz instance and fill in any missing required fields here. Until then we
 * keep settings minimal; Postiz applies its own defaults for omitted optionals.
 */

/** Canonical short-form platforms our caption/scheduling engines target. */
export type ShortPlatform = "tiktok" | "instagram" | "youtube";

/**
 * Map a Postiz `identifier` to our canonical short-form platform, or null if we
 * don't have tuned caption/timing rules for it (we still let the user post —
 * we just use a generic caption + generic schedule window).
 */
export function toShortPlatform(identifier: string): ShortPlatform | null {
  const id = identifier.toLowerCase();
  if (id === "tiktok") return "tiktok";
  if (id === "instagram" || id === "instagram-standalone") return "instagram";
  if (id === "youtube") return "youtube";
  return null;
}

/**
 * Build the `settings` object for one channel. `title` is the SEO first-line /
 * title we generated (YouTube uses it as the video title). Extra per-provider
 * required keys go in the table below.
 */
export function buildProviderSettings(identifier: string, opts: { title?: string }): Record<string, unknown> & { __type: string } {
  const base: Record<string, unknown> & { __type: string } = { __type: identifier };
  const short = toShortPlatform(identifier);
  if (short === "youtube") {
    // YouTube uploads REQUIRE a title and a visibility `type` (Postiz 400s without).
    base.title = (opts.title || "Short").slice(0, 100); // YT title hard cap is 100 chars.
    base.type = "public";
  } else if (short === "instagram") {
    // Instagram REQUIRES a post_type; a vertical short-form clip → a Reel.
    base.post_type = "reel";
  }
  // TikTok via Postiz would also need a privacy level, but we post TikTok through
  // PostPeer, so it isn't built here.
  return base;
}
