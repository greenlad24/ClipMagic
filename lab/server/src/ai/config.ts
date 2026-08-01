/**
 * AI provider configuration for Stage 2.
 *
 * Transcription: Groq Whisper (OpenAI-compatible audio endpoint).
 * Director / LLM: Anthropic Claude, tiered for cost/quality:
 *   - director tier  (creative beat-planner / shot list)  -> Opus (default 4.8)
 *   - research tier  (URL research, beat structure)        -> Sonnet 4.6
 *   - fast tier      (subtitle emphasis tagging)           -> Haiku 4.5
 *
 * All model IDs are overridable via env so you can switch (e.g. director to
 * Sonnet for cheaper runs) without a rebuild.
 */
export const aiConfig = {
  // ── Groq (transcription + vision fallback) ────────────────────────────────
  groqApiKey: process.env.GROQ_API_KEY || "",
  groqBaseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  groqModel: process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo",
  // Multimodal Groq model used to index promo frames when Claude vision is
  // overloaded/unavailable. Llama 4 Scout accepts images and is fast/cheap.
  groqVisionModel: process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",

  // ── Anthropic (director / LLM) ────────────────────────────────────────────
  // Two auth modes:
  //   • API key (sk-ant-api…) via x-api-key  — the standard, ToS-clean path.
  //   • OAuth/access token (sk-ant-oat…, e.g. `claude setup-token`) via
  //     Authorization: Bearer + the oauth beta header. Set ANTHROPIC_AUTH_TOKEN
  //     (or CLAUDE_CODE_OAUTH_TOKEN). If both are set, the token wins.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicAuthToken:
    process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN || "",

  // ── Anthropic, SUBSCRIPTION (Max plan) ────────────────────────────────────
  // A SECOND, PER-CALL credential — not a global override like the two above.
  // Set it and nothing changes for the lab at large; only call sites that ask
  // for it by name (`auth: "subscription"` — currently the Skool Manager's
  // planner and lesson authoring) send it, and those calls bill Jake's Max
  // subscription instead of API credits.
  //
  // ⚠️ IT MUST BE A `claude setup-token` TOKEN, NOT THE ONE IN
  // ~/.claude/.credentials.json. Claude Code's own access token is refreshed
  // every few hours and rotated on refresh, so a copy of it here works for one
  // afternoon and then fails; worse, using its refresh token from two places
  // races Claude Code and can invalidate the login. `claude setup-token` mints
  // a separate long-lived token for exactly this.
  //
  // The 5-hour Max window is SHARED with Jake's own Claude Code sessions, which
  // is why this is opt-in per call rather than lab-wide: a background worker on
  // a timer would quietly eat the limit he is typing into.
  anthropicSubscriptionToken: process.env.ANTHROPIC_SUBSCRIPTION_TOKEN || "",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  anthropicVersion: "2023-06-01",
  anthropicOauthBeta: "oauth-2025-04-20",

  // Tiered models. Defaults chosen for "Opus for the director step".
  models: {
    director: process.env.CLAUDE_DIRECTOR_MODEL || "claude-opus-4-8",
    research: process.env.CLAUDE_RESEARCH_MODEL || "claude-sonnet-4-6",
    fast: process.env.CLAUDE_FAST_MODEL || "claude-haiku-4-5",
  },

  maxTokens: Number.parseInt(process.env.CLAUDE_MAX_TOKENS || "8192", 10),
};

/** Map an internal tier name to its configured Claude model ID. */
export function modelForTier(tier: "director" | "research" | "fast"): string {
  return aiConfig.models[tier];
}
