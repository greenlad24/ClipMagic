/**
 * Avatar Narrator — shared contract and the cost model.
 *
 * The tool makes one kind of thing: a talking-head narration video of a
 * synthetic presenter. The pipeline is deliberately NOT a text-to-video model
 * (Seedance/Veo/Kling). Those generate a *scene* with its own audio, cap out
 * around 30s, cost $0.15–0.50 per second, and give you no control over the
 * exact words or a consistent voice between clips. A narration avatar is a
 * different, far cheaper problem:
 *
 *     one locked portrait  +  TTS of the script  →  audio-driven lipsync model
 *
 * The portrait is generated once and reused forever (persona), the script is
 * spoken exactly as written, and the video model only has to move a face. That
 * is why this runs at ~$3.60 per finished minute instead of ~$28.
 *
 * Everything provider-specific lives behind `AvatarProvider` so the hosted
 * APIs (kie.ai, WaveSpeed) and a future self-hosted InfiniteTalk worker on a
 * rented GPU are the same interface — swapping is config, not a rewrite.
 */

/** Which avatar/lipsync backend runs the job. */
export type AvatarProviderId = "segmind" | "seedance" | "kie" | "wavespeed" | "selfhost";

/** Output resolution. InfiniteTalk emits 480p or 720p; 1080p is upscale-only. */
export type AvatarResolution = "480p" | "720p";

/** Which text-to-speech backend voices the script. */
export type TtsProviderId = "segmind" | "gemini" | "elevenlabs";

export const AVATAR_PROVIDER_IDS: AvatarProviderId[] = ["segmind", "seedance", "kie", "wavespeed", "selfhost"];
export const TTS_PROVIDER_IDS: TtsProviderId[] = ["segmind", "gemini", "elevenlabs"];

/** The default engine. Seedance 2.5 generates the presenter rather than
 *  animating a still, which is the whole reason it is worth its price. */
export function coerceProvider(x: unknown): AvatarProviderId {
  return (AVATAR_PROVIDER_IDS as string[]).includes(x as string) ? (x as AvatarProviderId) : "segmind";
}
/**
 * 480p is the default: at Segmind's rates a 45-second Short costs $4.79 at 480p
 * against $10.75 at 720p, and these are phone-screen verticals. Ask for "720p"
 * explicitly when a video earns it.
 */
export function coerceResolution(x: unknown): AvatarResolution {
  return x === "720p" ? "720p" : "480p";
}
/**
 * Segmind is the default voice as well as the default video engine — one key
 * covers both. It resells ElevenLabs, so the voice is ElevenLabs' quality at
 * Segmind's pay-as-you-go billing, with no subscription to under-use.
 */
export function coerceTtsProvider(x: unknown): TtsProviderId {
  return (TTS_PROVIDER_IDS as string[]).includes(x as string) ? (x as TtsProviderId) : "segmind";
}

// ── Cost model ───────────────────────────────────────────────────────────────
// Published list prices, Aug 2026. These drive the pre-flight estimate shown in
// the UI *and* the actual spend recorded per segment, so a provider price change
// is a one-line edit here rather than a hunt through the pipeline.
//
// InfiniteTalk bills a MINIMUM of 5 seconds per job and caps at 600s (10 min).
// That minimum is why "fast mode" (many short parallel jobs) is not free: eight
// 4-second chunks bill as eight 5-second jobs.

export const MIN_BILLED_SECONDS = 5;
export const MAX_JOB_SECONDS = 600;

/**
 * The longest single job each provider will accept, in seconds of video.
 *
 * This is emphatically NOT one number, and getting it wrong is not a rounding
 * error — it is a rejected job you have already paid to voice:
 *
 *   kie.ai     — 15s. Their pricing page names the model
 *                "MeiGen-AI InfiniteTalk, lip sync, up to 15 seconds", so the
 *                ceiling is the product, not a quota we might negotiate.
 *   WaveSpeed  — 600s. Same underlying model, documented "up to 10 minutes",
 *                billing capped at 600s, at the SAME $0.06/s for 720p.
 *   selfhost   — your own GPU, so the only limit is VRAM and patience; 600s
 *                matches WaveSpeed rather than pretending it is unbounded.
 *
 * The consequence is a real quality difference, not just plumbing: on kie.ai a
 * three-minute narration is 12 separate jobs with 11 visible seams, while on
 * WaveSpeed it is one continuous take at the same price.
 */
export const MAX_JOB_SECONDS_BY_PROVIDER: Record<AvatarProviderId, number> = {
  // Seedance 2.5: `duration` accepts 4-30, and `reference_audio_urls` caps at
  // 30 seconds TOTAL across all clips — so 30 is a hard wall on both sides of
  // the request, not just the output.
  segmind: 30,
  seedance: 30,
  kie: 15,
  wavespeed: MAX_JOB_SECONDS,
  selfhost: MAX_JOB_SECONDS,
};

export function maxJobSeconds(provider: AvatarProviderId): number {
  return MAX_JOB_SECONDS_BY_PROVIDER[provider] ?? MAX_JOB_SECONDS;
}

/** USD per second of generated video, by provider and resolution. */
export const VIDEO_RATE_USD: Record<AvatarProviderId, Record<AvatarResolution, number>> = {
  // Seedance 2.5 on kie.ai, from the operator's own logged-in pricing page
  // (credits price at a flat $0.005 each). kie.ai sells it at TWO tiers:
  //
  //   "with video"  720p 38 cr/s = $0.190   480p 17 cr/s = $0.085
  //   "no video"    720p 63 cr/s = $0.315   480p 28 cr/s = $0.140
  //
  // The cheaper tier applies when a reference VIDEO conditions the generation.
  // Our flow sends a portrait and narration audio only, so it bills at the
  // "no video" tier — which is what is recorded here. Understating this would
  // quietly halve every estimate the UI shows.
  // Seedance 2.5 on Segmind — the same ByteDance model as `seedance` below,
  // ~24% cheaper at every tier. These are the text/image-input rates, which is
  // what a portrait + narration bills at.
  //
  // Segmind bills OUTPUT tokens, and publishes the per-second equivalents used
  // here. The underlying rates are the provenance for the 40% lever below:
  //
  //   text or image input   $10.97 per million output tokens
  //   video input            $6.56 per million output tokens   (= 40% off)
  //
  // So supplying a reference VIDEO drops 480p from $0.1065/s to $0.0637/s —
  // the single largest saving still on the table, and it should tighten face
  // consistency at the same time by conditioning on the previous clip.
  segmind: { "480p": 0.1065, "720p": 0.2389 },
  seedance: { "480p": 0.14, "720p": 0.315 },
  // kie.ai — cheapest at 480p, tied with WaveSpeed at 720p.
  kie: { "480p": 0.015, "720p": 0.06 },
  // WaveSpeed — $0.15/5s and $0.30/5s.
  wavespeed: { "480p": 0.03, "720p": 0.06 },
  // A self-hosted worker bills GPU time, not seconds of video. ~20s of wall
  // time per 1s of 720p video on a 4090/L40S at ~$0.69–1.10/GPU-hr lands near
  // $0.004/s. Recorded as an ESTIMATE — the real bill comes from the GPU host.
  selfhost: { "480p": 0.002, "720p": 0.004 },
};

/**
 * USD per 1000 characters of narration. Rounding error next to the video cost
 * (a 1-minute script is ~900 characters), but tracked so the per-video total is
 * honest rather than "video only".
 */
export const TTS_RATE_USD_PER_1K_CHARS: Record<TtsProviderId, number> = {
  // ElevenLabs voices resold by Segmind. Dearer per character than going to
  // ElevenLabs directly ($0.0968/1k on Multilingual v2), and cheaper in
  // practice below ~130k characters a month, because there is no subscription
  // quota to buy and under-use. One key for voice and video is the other half
  // of the argument.
  segmind: 0.16875,
  gemini: 0.012,
  // ElevenLabs direct, Multilingual v2 API rate. Worth switching to past
  // roughly 200 Shorts a month, at which point a plan beats pay-as-you-go.
  elevenlabs: 0.0968,
};

/** Words per minute assumed when estimating a script's duration before TTS. */
export const NARRATION_WPM = 150;

/**
 * Estimate the finished duration of a script, in seconds, before we have spent
 * anything voicing it. Used only for the pre-flight cost estimate — once the
 * narration exists, the real measured duration replaces it.
 */
export function estimateScriptSeconds(script: string, wpm = NARRATION_WPM): number {
  const words = (script.trim().match(/\S+/g) ?? []).length;
  if (!words) return 0;
  return (words / wpm) * 60;
}

/** What one provider job of `seconds` costs, honouring the 5-second minimum. */
export function videoCostUsd(
  provider: AvatarProviderId,
  resolution: AvatarResolution,
  seconds: number,
): number {
  const billed = Math.max(seconds, MIN_BILLED_SECONDS);
  return billed * VIDEO_RATE_USD[provider][resolution];
}

export interface CostEstimate {
  seconds: number;
  segments: number;
  videoUsd: number;
  ttsUsd: number;
  totalUsd: number;
  /** USD per finished minute — the number worth comparing across providers. */
  perMinuteUsd: number;
}

/**
 * Pre-flight estimate for a script. `segmentSeconds` of 0 means "as few jobs as
 * the provider allows" — which is one job on WaveSpeed but one job per 15s on
 * kie.ai. A positive value splits further still, which is faster in wall-clock
 * but pays the 5-second minimum per chunk.
 *
 * The provider's ceiling is a hard clamp, not a suggestion: asking for 30s
 * chunks on a provider that caps at 15 gets you 15, because that is what will
 * actually be submitted.
 */
export function estimateCost(opts: {
  script: string;
  provider: AvatarProviderId;
  resolution: AvatarResolution;
  tts: TtsProviderId;
  segmentSeconds?: number;
}): CostEstimate {
  const seconds = estimateScriptSeconds(opts.script);
  const cap = maxJobSeconds(opts.provider);
  const chunk = opts.segmentSeconds && opts.segmentSeconds > 0 ? Math.min(opts.segmentSeconds, cap) : cap;
  const segments = Math.max(1, Math.ceil(seconds / chunk));
  const per = seconds / segments;
  const videoUsd = segments * videoCostUsd(opts.provider, opts.resolution, per);
  const ttsUsd = (opts.script.length / 1000) * TTS_RATE_USD_PER_1K_CHARS[opts.tts];
  const totalUsd = videoUsd + ttsUsd;
  return {
    seconds,
    segments,
    videoUsd,
    ttsUsd,
    totalUsd,
    perMinuteUsd: seconds > 0 ? totalUsd / (seconds / 60) : 0,
  };
}

// ── Records ──────────────────────────────────────────────────────────────────

export interface AvatarPersona {
  id: string;
  name: string;
  lookPrompt: string;
  scenePrompt: string;
  portraitFile: string;
  portraitMime: string;
  ttsProvider: TtsProviderId;
  ttsVoice: string;
  /**
   * Absolute path of the clip this persona's voice was cloned from.
   *
   * The cloned voice MODEL belongs to the vendor and cannot be exported; this
   * sample is the part that is ours. Keeping it is what makes the persona's
   * voice reproducible somewhere else later, so it is archived beside the
   * portrait rather than discarded once the clone succeeds.
   */
  voiceSampleFile: string;
  /**
   * Room plate this persona is filmed in (see rooms.ts), or "" for a persona
   * whose room only ever existed as words in its portrait prompt. Stored on the
   * PERSONA rather than the video because the room is part of who they are: the
   * portrait was generated in it, and every clip has to return to it.
   */
  roomId: string;
  /** Character sheet on disk (see characterSheet.ts), or "" if never made. */
  sheetFile: string;
  createdAt: number;
  /** Server-relative URL for the portrait (behind the auth gate). */
  portraitUrl: string;
  /** Server-relative URL for the voice sample, when one has been archived. */
  voiceSampleUrl: string | null;
  /** Server-relative URL for the character sheet, when one has been made. */
  sheetUrl: string | null;
}

export type AvatarVideoStatus =
  | "queued"
  | "voicing"
  | "rendering"
  | "stitching"
  | "done"
  | "failed"
  | "canceled";

export interface AvatarSegment {
  id: string;
  videoId: string;
  idx: number;
  text: string;
  seconds: number;
  status: "pending" | "voicing" | "submitted" | "done" | "failed";
  providerTask: string | null;
  costUsd: number;
  error: string | null;
}

export interface AvatarVideo {
  id: string;
  personaId: string;
  personaName: string;
  title: string;
  script: string;
  status: AvatarVideoStatus;
  phase: string;
  progress: number;
  provider: AvatarProviderId;
  resolution: AvatarResolution;
  audioSeconds: number;
  costUsd: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** Server-relative URLs, present once the artefacts exist. */
  audioUrl: string | null;
  videoUrl: string | null;
  segments: AvatarSegment[];
}
