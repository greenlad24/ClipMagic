/**
 * Anthropic Claude client (via fetch — no SDK dependency needed in the bundle).
 *
 * The original pipeline issues three kinds of chat calls, all through the
 * OpenAI shim. We pick the Claude tier per call:
 *   - model "gpt-4o-mini"                -> fast tier   (Haiku)  : emphasis tags
 *   - model "gpt-4o" + director prompt   -> director tier (Opus) : beat planner
 *   - model "gpt-4o" + research prompt   -> research tier (Sonnet): URL research
 *   - anything else with "gpt-4o"        -> research tier (Sonnet)
 *
 * The director vs research split is detected from the system prompt text, since
 * the original code uses the same model name for both. Big system prompts are
 * sent with prompt caching to cut cost on repeated runs.
 *
 * Note: no temperature / top_p / thinking.budget_tokens — those are removed on
 * current Opus, and adaptive thinking is the default. We keep the request
 * surface minimal (model + system + messages + max_tokens) so it works across
 * Opus 4.8 / Sonnet 4.6 / Haiku 4.5 unchanged.
 */
import { aiConfig, modelForTier } from "./config.js";
import { recordAnthropicUsage, type CallPurpose } from "./runAccounting.js";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** True when either an API key or an OAuth access token is configured. */
export function anthropicConfigured(): boolean {
  return !!(aiConfig.anthropicAuthToken || aiConfig.anthropicApiKey);
}

/**
 * Build the Anthropic request headers for whichever auth mode is configured.
 * An OAuth access token (Bearer + oauth beta) takes precedence over an API key.
 */
function anthropicHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": aiConfig.anthropicVersion,
  };
  if (aiConfig.anthropicAuthToken) {
    headers["authorization"] = `Bearer ${aiConfig.anthropicAuthToken}`;
    // Anthropic requires this beta header for OAuth/account access tokens.
    headers["anthropic-beta"] = aiConfig.anthropicOauthBeta;
  } else {
    headers["x-api-key"] = aiConfig.anthropicApiKey;
  }
  return headers;
}

function resolveTier(openaiModel: string, system: string): "director" | "research" | "fast" {
  if (openaiModel.includes("mini")) return "fast";
  // The creative beat-planner system prompt is unmistakable.
  if (/senior short-form video editor|semantic beat|creative director|elite short-form/i.test(system)) {
    return "director";
  }
  return "research";
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: AnthropicUsage;
  error?: { message?: string };
}

/**
 * Classify an LLM call's PURPOSE for the per-run optimization report, from its
 * tier and system prompt. The pipeline reuses the gpt-4o model name for both
 * URL research and the final self-review, so we disambiguate by prompt text
 * (same approach resolveTier already uses for director vs research).
 */
function resolvePurpose(tier: "director" | "research" | "fast", system: string): CallPurpose {
  if (tier === "director") return "director";
  if (tier === "fast") return "emphasis-fallback";
  // research tier: URL research vs the final accuracy review.
  if (/QUALITY-CONTROL PASS|final quality|CRITICAL MISMATCH|reviews/i.test(system)) return "review";
  return "url-research";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to the Anthropic Messages API with retry/backoff on transient errors.
 * 529 (Overloaded), 429 (rate limit), and 5xx are retried with exponential
 * backoff + jitter; everything else (and the final attempt) throws.
 */
async function anthropicRequest(body: unknown, label: string): Promise<AnthropicResponse> {
  const maxAttempts = Number.parseInt(process.env.CLAUDE_MAX_RETRIES || "5", 10);
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${aiConfig.anthropicBaseUrl}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Network blip — treat as retryable.
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt < maxAttempts) { await sleep(backoff(attempt)); continue; }
      throw new Error(`${label} network error after ${attempt} attempts: ${lastErr}`);
    }

    if (res.ok) return (await res.json()) as AnthropicResponse;

    const json = (await res.json().catch(() => ({}))) as AnthropicResponse;
    lastErr = `${res.status}: ${json?.error?.message || JSON.stringify(json)}`;
    const retryable = res.status === 529 || res.status === 429 || (res.status >= 500 && res.status < 600);
    if (retryable && attempt < maxAttempts) {
      // Honor Retry-After when present, else exponential backoff + jitter.
      const ra = Number.parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt);
      console.warn(`${label} ${res.status} (attempt ${attempt}/${maxAttempts}) — retrying in ${Math.round(wait)}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${label} (${res.status}): ${json?.error?.message || JSON.stringify(json)}`);
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts: ${lastErr}`);
}

/** Exponential backoff with jitter: ~1s, 2s, 4s, 8s … capped at 20s. */
function backoff(attempt: number): number {
  const base = Math.min(20000, 1000 * 2 ** (attempt - 1));
  return base + Math.random() * 400;
}

async function callClaude(opts: {
  model: string;
  system: string;
  messages: Turn[];
  jsonMode?: boolean;
  /** Purpose for per-run accounting (so the optimization report can attribute cost). */
  purpose?: CallPurpose;
}): Promise<string> {
  if (!anthropicConfigured()) {
    throw new Error(
      "No Anthropic credentials set. Add ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) to enable the AI director."
    );
  }

  const system = opts.jsonMode
    ? `${opts.system}\n\nIMPORTANT: Respond with ONLY the raw JSON object. No markdown, no code fences, no commentary.`
    : opts.system;

  // Prompt-cache the (large, reused) system prompt.
  const systemBlocks = system
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : undefined;

  const body = {
    model: opts.model,
    max_tokens: aiConfig.maxTokens,
    ...(systemBlocks ? { system: systemBlocks } : {}),
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  };

  const t0 = Date.now();
  const json = await anthropicRequest(body, "Claude API error");
  // Record the REAL usage from Anthropic's response into the active run's report.
  if (opts.purpose) {
    recordAnthropicUsage({ model: opts.model, purpose: opts.purpose, usage: json.usage, ms: Date.now() - t0 });
  }
  return (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
}

/**
 * Opus chat for the Jake Dawson Script Generator — always the latest Opus
 * (claude-opus-4-8 via the "director" tier), with an optional Anthropic
 * server-side web_search tool for the live-research stage. Larger default
 * max_tokens (script stages are long-form). Returns the concatenated text
 * blocks (server tool-use / search-result blocks are ignored).
 *
 * Adaptive thinking is set explicitly: on Opus 4.8 an omitted `thinking` field
 * means the model runs with NO thinking at all. Every scriptgen stage is a
 * judgement call (does this line punch down? does this outline carry the
 * research?), so the thinking is worth its latency. `budget_tokens` and
 * temperature/top_p/top_k are rejected with a 400 on this model — adaptive
 * thinking plus `effort` is the only way to steer depth.
 */
export async function opusScriptChat(opts: {
  system: string;
  /**
   * Extra system blocks appended after `system`. Use for content that is stable
   * across a batch of calls (the section-writing rules, the fact sheet) so the
   * cached prefix clears Opus 4.8's 4096-token minimum — below that threshold
   * cache_control silently does nothing. Volatile content belongs in `messages`.
   */
  systemExtra?: string[];
  messages: Turn[];
  maxTokens?: number;
  /** Enable Anthropic's server-side web search (used by Stage 1 research). */
  webSearch?: boolean;
  /**
   * Adaptive thinking. On by default — most stages are judgement calls. Pass
   * false for mechanical stages (classify, reformat, extract): thinking bills as
   * OUTPUT at 5x the input rate, so it is the most expensive thing to waste.
   */
  thinking?: boolean;
  /** Shows up in the [scriptgen:usage] log line. */
  label?: string;
  /**
   * If provided, web-search sources are appended here (deduped by URL). The
   * server-side search returns its results in `web_search_tool_result` blocks
   * and attaches `citations` to the text blocks — we filter to text blocks for
   * the answer, so without this sink every source the research rested on is
   * discarded and no price claim can ever be traced back.
   */
  sinkSources?: ScriptSource[];
  purpose?: CallPurpose;
}): Promise<string> {
  if (!anthropicConfigured()) {
    throw new Error("No Anthropic credentials set. Add ANTHROPIC_API_KEY to use the Script Generator.");
  }
  const model = aiConfig.models.director; // latest Opus (claude-opus-4-8)
  // One cache breakpoint, on the LAST system block: the whole system prefix is
  // cached together. Everything before it must be byte-stable across the batch.
  const texts = [opts.system, ...(opts.systemExtra ?? [])].filter((t) => t && t.trim());
  const systemBlocks = texts.length
    ? texts.map((text, i) => ({
        type: "text",
        text,
        ...(i === texts.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }))
    : undefined;
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 16000,
    ...(opts.thinking === false ? {} : { thinking: { type: "adaptive" } }),
    ...(systemBlocks ? { system: systemBlocks } : {}),
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (opts.webSearch) {
    // Anthropic's server-executed web search tool. The _20260209 variant adds
    // dynamic filtering — the model filters results before they reach the
    // context window, which matters when we're hunting exact prices and click
    // paths. max_uses is generous: a tool review has to check every tier.
    body.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 20 }];
  }
  const t0 = Date.now();
  const json = await anthropicRequest(body, "Claude (scriptgen) API error");
  const ms = Date.now() - t0;
  if (opts.purpose) {
    recordAnthropicUsage({ model, purpose: opts.purpose, usage: json.usage, ms });
  }
  // recordAnthropicUsage no-ops outside a pipeline run (scriptgen has no active
  // run context), so the provider's own token counts were being dropped on the
  // floor. Log them: a script is ~28 Opus calls and the bill is worth seeing.
  logScriptgenUsage(opts.label ?? "scriptgen", json.usage, ms);
  if (opts.sinkSources) collectSources(json.content, opts.sinkSources);
  return (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
}

/** A web page the research actually rested on. */
export interface ScriptSource {
  url: string;
  title: string;
}

/**
 * Pull sources out of a response's content blocks, deduped by URL, appending to
 * `sink`. Two places carry them: `web_search_tool_result` blocks (the raw hits)
 * and `citations` arrays hanging off the text blocks (what the model actually
 * leaned on). Both are dropped by the text-only filter above.
 */
function collectSources(content: unknown, sink: ScriptSource[]): void {
  if (!Array.isArray(content)) return;
  const seen = new Set(sink.map((s) => s.url));
  const add = (url: unknown, title: unknown): void => {
    if (typeof url !== "string" || !url.trim() || seen.has(url)) return;
    seen.add(url);
    sink.push({ url, title: typeof title === "string" && title.trim() ? title.trim() : url });
  };
  for (const raw of content) {
    const b = (raw ?? {}) as Record<string, unknown>;
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content as Array<Record<string, unknown>>) {
        if (r?.type === "web_search_result") add(r.url, r.title);
      }
    }
    if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations as Array<Record<string, unknown>>) {
        add(c?.url, c?.title ?? c?.cited_text);
      }
    }
  }
}

/** Running per-process tally so a finished script can report what it actually cost. */
const scriptgenTally = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ms: 0 };

/** Opus 4.8 list price, $/token. Output is 5x input — thinking bills as output. */
const OPUS_IN = 5 / 1_000_000;
const OPUS_OUT = 25 / 1_000_000;

function logScriptgenUsage(
  label: string,
  usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined,
  ms: number,
): void {
  const u = usage ?? {};
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  // Cache reads bill at ~0.1x input, writes at ~1.25x.
  const cost = input * OPUS_IN + output * OPUS_OUT + cacheRead * OPUS_IN * 0.1 + cacheWrite * OPUS_IN * 1.25;

  scriptgenTally.calls++;
  scriptgenTally.input += input;
  scriptgenTally.output += output;
  scriptgenTally.cacheRead += cacheRead;
  scriptgenTally.cacheWrite += cacheWrite;
  scriptgenTally.ms += ms;

  console.log(
    `[scriptgen:usage] ${label} in=${input} out=${output} cache_read=${cacheRead} cache_write=${cacheWrite} ` +
      `$${cost.toFixed(4)} ${(ms / 1000).toFixed(1)}s`,
  );
}

/** Total spend since process start, for the end-of-run summary line. */
export function scriptgenUsageTotal(): { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; ms: number } {
  const t = scriptgenTally;
  const costUsd =
    t.input * OPUS_IN + t.output * OPUS_OUT + t.cacheRead * OPUS_IN * 0.1 + t.cacheWrite * OPUS_IN * 1.25;
  return { ...t, costUsd };
}

/** Plain text chat completion. */
export async function claudeChat(opts: {
  model: string;
  system: string;
  messages: Turn[];
}): Promise<string> {
  const tier = resolveTier(opts.model, opts.system);
  return callClaude({
    model: modelForTier(tier),
    system: opts.system,
    messages: opts.messages,
    purpose: resolvePurpose(tier, opts.system),
  });
}

/**
 * JSON chat completion. Returns a JSON string (the pipeline calls JSON.parse on
 * it). We strip any accidental code fences so JSON.parse always succeeds.
 */
export async function claudeChatJSON(opts: {
  model: string;
  system: string;
  messages: Turn[];
}): Promise<string> {
  const tier = resolveTier(opts.model, opts.system);
  const raw = await callClaude({
    model: modelForTier(tier),
    system: opts.system,
    messages: opts.messages,
    jsonMode: true,
    purpose: resolvePurpose(tier, opts.system),
  });
  return extractJson(raw);
}

/**
 * JSON completion on an EXPLICIT tier + purpose. Used for calls whose system
 * prompt doesn't fit the gpt-4o-name heuristic resolveTier/resolvePurpose use
 * (e.g. the Narration Cutter's take-detection, which is a cheap structured
 * extraction that belongs on the fast/Haiku tier and must be attributed to its
 * own purpose in the optimization report — not mis-billed as url-research).
 */
export async function claudeJSONForPurpose(opts: {
  tier: "director" | "research" | "fast";
  purpose: CallPurpose;
  system: string;
  messages: Turn[];
}): Promise<string> {
  const raw = await callClaude({
    model: modelForTier(opts.tier),
    system: opts.system,
    messages: opts.messages,
    jsonMode: true,
    purpose: opts.purpose,
  });
  return extractJson(raw);
}

/**
 * Vision JSON completion: send a set of base64 JPEG frames + a prompt to Claude
 * and get JSON back. Used by indexPromoVideo to actually "watch" a promo video
 * (1 frame/sec) and describe what's on screen each second. Runs once per video
 * at index time; the result is cached in the DB.
 *
 * Uses the research tier (Sonnet) by default — strong vision at lower cost than
 * Opus for this descriptive task; override with CLAUDE_VISION_MODEL.
 */
export async function claudeVisionJSON(opts: {
  system: string;
  userText: string;
  /** Base64-encoded JPEG frames, in chronological order. */
  frames: string[];
  model?: string;
}): Promise<string> {
  // Try Claude first (when configured); on overload/failure, fall back to Groq
  // vision so promo indexing still produces a real vision index. If Claude
  // isn't configured at all, go straight to Groq.
  const { groqVisionConfigured, groqVisionJSON } = await import("./groqVision.js");
  if (!anthropicConfigured()) {
    if (groqVisionConfigured()) {
      console.warn("[vision] No Anthropic creds — using Groq vision.");
      return groqVisionJSON({ system: opts.system, userText: opts.userText, frames: opts.frames });
    }
    throw new Error("No vision provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY.");
  }
  try {
    return await claudeVisionAnthropic(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (groqVisionConfigured()) {
      console.warn(`[vision] Claude vision failed (${msg.slice(0, 80)}) — falling back to Groq vision.`);
      return groqVisionJSON({ system: opts.system, userText: opts.userText, frames: opts.frames });
    }
    throw e;
  }
}

async function claudeVisionAnthropic(opts: {
  system: string;
  userText: string;
  frames: string[];
  model?: string;
}): Promise<string> {
  const model = opts.model || process.env.CLAUDE_VISION_MODEL || aiConfig.models.research;

  // Build a single user turn: all frames (each labeled), then the instruction.
  const content: any[] = [];
  opts.frames.forEach((b64, i) => {
    content.push({ type: "text", text: `Frame at ${i}s:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: b64 },
    });
  });
  content.push({
    type: "text",
    text:
      opts.userText +
      "\n\nRespond with ONLY the raw JSON object. No markdown, no code fences, no commentary.",
  });

  const body = {
    model,
    max_tokens: aiConfig.maxTokens,
    system: opts.system
      ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
      : undefined,
    messages: [{ role: "user", content }],
  };

  const json = await anthropicRequest(body, "Claude vision error");
  const text = (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
  return extractJson(text);
}

/** One labeled image for a vision review (base64 + its real media type). */
export interface LabeledImage {
  /** A short label shown before the image (e.g. "Candidate 1 (giphy):"). */
  label: string;
  /** Base64-encoded image bytes. */
  data: string;
  /** MIME type Anthropic accepts: image/png | image/webp | image/jpeg | image/gif. */
  mediaType: string;
}

/**
 * Vision JSON completion over a small set of LABELED, TYPED images (not the
 * JPEG-frames helper above). Used by the Sticker editor's AI fit-review to look
 * at the candidate reaction stickers (transparent PNG/WEBP) for a line and pick
 * the best fit (or drop it). Records usage under the given purpose so the cost
 * shows up honestly in the optimization report.
 *
 * Routes to Claude vision (Sonnet/research tier by default) and, on failure, to
 * Groq vision so the gate still runs when only Groq is configured. Throws if no
 * vision provider is configured at all — the caller treats that as "no review".
 */
export async function claudeVisionLabeledJSON(opts: {
  system: string;
  userText: string;
  images: LabeledImage[];
  purpose: CallPurpose;
  model?: string;
}): Promise<string> {
  const { groqVisionConfigured, groqVisionJSON } = await import("./groqVision.js");
  if (!anthropicConfigured()) {
    if (groqVisionConfigured()) {
      // Groq's OpenAI-compatible path takes data URIs; rebuild them with the type.
      return groqVisionJSON({
        system: opts.system,
        userText: labeledUserText(opts),
        frames: opts.images.map((im) => im.data), // jpeg-style helper; types below
        // groqVisionJSON hardcodes image/jpeg in its data URI — stickers are PNG,
        // but Groq's loader sniffs the bytes, so PNG still decodes. Acceptable
        // for the fallback path.
      });
    }
    throw new Error("No vision provider configured for sticker fit-review.");
  }

  const model = opts.model || process.env.CLAUDE_VISION_MODEL || aiConfig.models.research;
  const content: any[] = [];
  opts.images.forEach((im) => {
    content.push({ type: "text", text: im.label });
    content.push({
      type: "image",
      source: { type: "base64", media_type: im.mediaType, data: im.data },
    });
  });
  content.push({
    type: "text",
    text:
      opts.userText +
      "\n\nRespond with ONLY the raw JSON object. No markdown, no code fences, no commentary.",
  });

  const body = {
    model,
    max_tokens: aiConfig.maxTokens,
    system: opts.system
      ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
      : undefined,
    messages: [{ role: "user", content }],
  };

  const t0 = Date.now();
  const json = await anthropicRequest(body, "Claude sticker fit-review error");
  recordAnthropicUsage({ model, purpose: opts.purpose, usage: json.usage, ms: Date.now() - t0 });
  const text = (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
  return extractJson(text);
}

function labeledUserText(opts: { userText: string; images: LabeledImage[] }): string {
  return (
    opts.images.map((im) => im.label).join("\n") + "\n" + opts.userText
  );
}

/** Pull the JSON payload out of a model response, tolerating fences/prose. */
export function extractJson(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  const start =
    firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstObj, firstArr);
  if (start > 0) {
    const lastObj = t.lastIndexOf("}");
    const lastArr = t.lastIndexOf("]");
    const end = Math.max(lastObj, lastArr);
    if (end > start) t = t.slice(start, end + 1);
  }
  return t;
}
