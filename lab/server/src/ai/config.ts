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
  // ⚠️ THE WINDOW IS SLOWER TO REOPEN THAN "5 HOURS" SUGGESTS, AND IT IS NOT
  // MEASURABLY SHARED WITH CLAUDE CODE. Measured 2026-08-05/06: the lab's token
  // was 429 on every Opus and Sonnet model for ~26 hours continuously (only
  // Haiku stayed open) while a Claude Code session on Opus 5 kept working
  // normally throughout. A 5-hour rolling window would have lifted five times
  // over, so treat this as a WEEKLY cap on a quota that is effectively separate
  // from Claude Code's. The practical consequence: a call that must actually
  // happen on a schedule cannot depend on this token being available.
  anthropicSubscriptionToken: process.env.ANTHROPIC_SUBSCRIPTION_TOKEN || "",
  // Which credential the SKOOL ENGAGEMENT AGENT drafts with — `api` (default)
  // or `subscription`. It is a setting rather than a constant because the two
  // credentials fail in opposite ways and the right answer changes: the
  // subscription costs nothing but can be shut for a day at a time (see above),
  // and the agent posts on advertised days, so an unavailable credential is a
  // missed post rather than a slow one. Jake, 2026-08-06: "lets switch it to
  // claude api" — after the window had been shut ~26h and no draft had ever
  // been read. Set `subscription` to hand it back to the free window.
  //
  // ⚠️ THIS IS NOT A FALLBACK CHAIN AND MUST NOT BECOME ONE. `AuthMode`'s whole
  // point is that a call spends the credential it was told to spend; auto-
  // promoting a 429 to API credits is precisely the quiet billing the no-
  // fallback rule exists to prevent. It uses exactly what is set here.
  // The annotation is load-bearing: inside an object literal a string ternary
  // widens to `string`, which is not assignable to `AuthMode`. It is written
  // out rather than imported because `ai/claude.ts` (where `AuthMode` lives)
  // imports THIS file — importing it back would be a cycle.
  skoolEngageAuth: (process.env.SKOOL_AI_AUTH === "subscription"
    ? "subscription"
    : "api") as "api" | "subscription",

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
