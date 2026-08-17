/**
 * API keys for the engines this tool drives.
 *
 * INTERNAL AND SERVER-ONLY. None of these values may ever be wired into an HTTP
 * response and none is logged — the UI asks `avatarStatus` which providers are
 * `configured` and gets booleans back, never the keys themselves. Keep it that
 * way: the readiness flags exist precisely so the browser never needs a key.
 *
 * In the lab these came from a UI-managed store on disk with env override. Here
 * there is only the environment: put them in `.env` (loaded at boot by
 * index.ts) or inject them however your host does it. `.env.example` lists
 * every name, and the variable names are unchanged from the lab, so an existing
 * environment drops straight in.
 */

function env(name: string): string | null {
  return (process.env[name] || "").trim() || null;
}

/**
 * Google Gemini. Does double duty: Nano Banana / Nano Banana Pro for every
 * image step (portrait, character sheet, room placement) AND Gemini TTS for the
 * narration voice. This is the one key the tool is close to useless without.
 */
export function getGeminiApiKey(): string | null {
  return env("GEMINI_API_KEY");
}

/** Segmind — hosts Seedance 2.5, the default render engine, and a TTS voice. */
export function getSegmindApiKey(): string | null {
  return env("SEGMIND_API_KEY");
}

/** kie.ai — InfiniteTalk lipsync (~$3.60/finished minute at 720p) and Seedance. */
export function getKieApiKey(): string | null {
  return env("KIE_API_KEY");
}

/** WaveSpeed — the second InfiniteTalk host, same model, different vendor. */
export function getWaveSpeedApiKey(): string | null {
  return env("WAVESPEED_API_KEY");
}

/** ElevenLabs — optional; better voice cloning than Gemini TTS, at a price. */
export function getElevenLabsApiKey(): string | null {
  return env("ELEVENLABS_API_KEY");
}

/**
 * A self-hosted InfiniteTalk worker (e.g. a rented GPU). The cheapest path by
 * far at ~$0.30/finished minute, but it only pays for its own upkeep above
 * roughly 150 finished minutes a month — below that, a hosted API is cheaper.
 */
export function getSelfHostAvatarUrl(): string | null {
  return env("INFINITETALK_SELFHOST_URL");
}
export function getSelfHostAvatarKey(): string | null {
  return env("INFINITETALK_SELFHOST_KEY");
}
