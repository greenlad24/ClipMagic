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

interface Turn {
  role: "user" | "assistant";
  content: string;
}

function resolveTier(openaiModel: string, system: string): "director" | "research" | "fast" {
  if (openaiModel.includes("mini")) return "fast";
  // The creative beat-planner system prompt is unmistakable.
  if (/senior short-form video editor|semantic beat|creative director|elite short-form/i.test(system)) {
    return "director";
  }
  return "research";
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  error?: { message?: string };
}

async function callClaude(opts: {
  model: string;
  system: string;
  messages: Turn[];
  jsonMode?: boolean;
}): Promise<string> {
  if (!aiConfig.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to the server environment to enable the AI director."
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

  const res = await fetch(`${aiConfig.anthropicBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": aiConfig.anthropicApiKey,
      "anthropic-version": aiConfig.anthropicVersion,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as AnthropicResponse;
  if (!res.ok) {
    throw new Error(
      `Claude API error (${res.status}): ${json?.error?.message || JSON.stringify(json)}`
    );
  }
  return (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
}

/** Plain text chat completion. */
export async function claudeChat(opts: {
  model: string;
  system: string;
  messages: Turn[];
}): Promise<string> {
  const tier = resolveTier(opts.model, opts.system);
  return callClaude({ model: modelForTier(tier), system: opts.system, messages: opts.messages });
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
  if (!aiConfig.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to enable promo-video vision indexing.");
  }
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

  const res = await fetch(`${aiConfig.anthropicBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": aiConfig.anthropicApiKey,
      "anthropic-version": aiConfig.anthropicVersion,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as AnthropicResponse;
  if (!res.ok) {
    throw new Error(`Claude vision error (${res.status}): ${json?.error?.message || JSON.stringify(json)}`);
  }
  const text = (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
  return extractJson(text);
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
