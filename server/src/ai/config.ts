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
  // ── Groq (transcription) ──────────────────────────────────────────────────
  groqApiKey: process.env.GROQ_API_KEY || "",
  groqBaseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  groqModel: process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo",

  // ── Anthropic (director / LLM) ────────────────────────────────────────────
  // Two auth modes:
  //   • API key (sk-ant-api…) via x-api-key  — the standard, ToS-clean path.
  //   • OAuth/access token (sk-ant-oat…, e.g. `claude setup-token`) via
  //     Authorization: Bearer + the oauth beta header. Set ANTHROPIC_AUTH_TOKEN
  //     (or CLAUDE_CODE_OAUTH_TOKEN). If both are set, the token wins.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicAuthToken:
    process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
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
