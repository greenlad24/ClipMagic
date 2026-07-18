/**
 * YouTube Shorts-only gate (PURE — no IO). The Bulk Scheduler posts short-form
 * VERTICAL clips; this enforces that ONLY vertical (9:16) videos reach a YouTube
 * channel, so a landscape/long-form clip is never published as a regular YouTube
 * video. It is deliberately narrow:
 *   - VERTICAL is the only criterion — duration is NOT gated (a vertical clip
 *     within YouTube's Shorts limit still qualifies), and #Shorts is enforced
 *     separately in the caption engine (see captions.ts assemblePlatformCaption).
 *   - It is a HARD gate: a post is blocked unless the video is CONFIRMED vertical.
 *
 * `verticalPass` is the pre-flight probe result for the file:
 *   - true  → measured vertical (allowed — it's a Short)
 *   - false → measured non-vertical (BLOCKED — confirmed long-form)
 *   - null  → unmeasurable: cloud link / no local file / ffprobe failed. ALLOWED
 *             (fail-OPEN): we never block a post just because the aspect couldn't
 *             be read, so a real Short is never stuck. Only a CONFIRMED long-form
 *             is refused.
 *
 * `override: true` bypasses the gate (consistent with the per-item override on
 * SchedulePostInput). Non-YouTube posts are never affected.
 *
 * This gate is about long-form UPLOADS only. The un-bypassable "never edit or
 * delete @jake.dawson" protection lives in postiz/postizGuard.ts.
 *
 * The decision is split out here (no db/ffmpeg imports) so it's unit-tested in
 * isolation — bulkScheduler runs the probe and turns a block into a result.
 */

export type VerticalPass = boolean | null;

/** The minimal post shape the gate inspects. */
export interface YouTubeGatePost {
  /** Postiz platform key (x, tiktok, youtube, …). */
  identifier: string;
  /** Routing provider; defaults to "postiz". Only Postiz-routed YouTube is gated. */
  provider?: string;
  /** Per-item bypass. */
  override?: boolean;
}

/** A block decision: the reason + a required GrowthCheck-shaped entry for the UI. */
export interface YouTubeGateBlock {
  error: string;
  check: { id: string; label: string; pass: false; severity: "required"; hint: string };
}

/** True when this post targets a YouTube channel via Postiz. */
export function isYouTubePost(p: YouTubeGatePost): boolean {
  return (p.provider ?? "postiz") === "postiz" && (p.identifier ?? "").toLowerCase() === "youtube";
}

/**
 * Returns a block descriptor when a YouTube post must be REJECTED (not vertical /
 * unverifiable), or null when it may proceed (confirmed vertical, overridden, or
 * not a YouTube post).
 */
export function youtubeShortsGate(p: YouTubeGatePost, verticalPass: VerticalPass): YouTubeGateBlock | null {
  if (!isYouTubePost(p) || p.override) return null;
  // Block ONLY a CONFIRMED long-form (measured non-vertical). A confirmed vertical
  // Short (true) and an unmeasurable aspect (null) both pass — fail-open so a real
  // Short is never blocked just because ffprobe couldn't read it.
  if (verticalPass !== false) return null;
  const error =
    "Not posted to YouTube: this video is not vertical (9:16). YouTube posting here is Shorts-only — re-export it portrait to post.";
  return {
    error,
    check: {
      id: "youtube-shorts-vertical",
      label: "Vertical 9:16 (YouTube Shorts-only)",
      pass: false,
      severity: "required",
      hint: error,
    },
  };
}
