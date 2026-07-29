/**
 * Minimal Anthropic client for the planner.
 *
 * Deliberately separate from `ai/claude.ts`'s `opusScriptChat`, which carries
 * the Script Generator's own usage caps and accounting. The planner needs two
 * things that helper doesn't expose: server-side web search, and streaming with
 * a very large `max_tokens`.
 *
 * Model note: current models REJECT `temperature`/`top_p`/`top_k` and
 * `budget_tokens`. Depth is controlled by `output_config.effort` with adaptive
 * thinking.
 */
import { aiConfig } from "../ai/config.js";

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

/**
 * The one place the planner's model is named. It was written out at each call
 * site and the status endpoint reported a fourth, stale value ("claude-opus-5")
 * long after the switch to 4.8 — so the tool told you it was running a model it
 * was not. Every caller reads this.
 *
 * Note 4.8 needs `thinking` set EXPLICITLY; omitting it means no thinking at
 * all, unlike Opus 5 where it is on by default.
 */
export const PLANNER_MODEL = "claude-opus-4-8";

/** Claude Opus 4.8 list pricing, USD per million tokens (same rates as Opus 5). */
const PRICE_IN = 5 / 1_000_000;
const PRICE_OUT = 25 / 1_000_000;
const PRICE_CACHE_WRITE = 6.25 / 1_000_000;
const PRICE_CACHE_READ = 0.5 / 1_000_000;

function costOf(u: any): number {
  if (!u) return 0;
  return (
    (u.input_tokens || 0) * PRICE_IN +
    (u.output_tokens || 0) * PRICE_OUT +
    (u.cache_creation_input_tokens || 0) * PRICE_CACHE_WRITE +
    (u.cache_read_input_tokens || 0) * PRICE_CACHE_READ
  );
}

function apiKey(): string {
  const k = (aiConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!k) throw new Error("ANTHROPIC_API_KEY is not set — the Video Planner needs it.");
  return k;
}

const TRANSIENT = [429, 500, 502, 503, 529];

/** Non-streaming request with retry on transient failures. */
export async function anthropicRequest(opts: {
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ content: any[]; stop_reason: string | null; usage: any; costUsd: number }> {
  const payload = JSON.stringify(opts.body);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "x-api-key": apiKey(), "anthropic-version": VERSION, "content-type": "application/json" },
      body: payload,
      signal: opts.signal,
    });
    if (r.ok) {
      const j: any = await r.json();
      if (j.error) throw new Error(`Anthropic ${j.error.type}: ${j.error.message}`);
      return { content: j.content || [], stop_reason: j.stop_reason ?? null, usage: j.usage, costUsd: costOf(j.usage) };
    }
    const text = await r.text();
    if (!TRANSIENT.includes(r.status) || attempt >= 4) {
      throw new Error(`Anthropic HTTP ${r.status}: ${text.slice(0, 300)}`);
    }
    await new Promise((res) => setTimeout(res, Math.round(8000 * Math.pow(1.8, attempt))));
  }
}

/**
 * Streaming request returning the concatenated text.
 *
 * Streaming is required at high `max_tokens` or the request hits an HTTP
 * timeout. Note that thinking is billed as output and spent BEFORE any text, so
 * `max_tokens` must sit well above the size of the answer you expect — a 32000
 * budget once spent 29996 on thinking and truncated the plan a fifth of the way
 * through the video.
 */
export async function anthropicStream(opts: {
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ text: string; stop_reason: string | null; usage: any; costUsd: number }> {
  const payload = JSON.stringify({ ...opts.body, stream: true });

  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "x-api-key": apiKey(), "anthropic-version": VERSION, "content-type": "application/json" },
      body: payload,
      signal: opts.signal,
    });
    if (!r.ok) {
      const text = await r.text();
      if (!TRANSIENT.includes(r.status) || attempt >= 4) {
        throw new Error(`Anthropic HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      await new Promise((res) => setTimeout(res, Math.round(8000 * Math.pow(1.8, attempt))));
      continue;
    }

    let text = "";
    let stop: string | null = null;
    let usage: any = null;
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of r.body as any) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() as string;
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let e: any;
        try {
          e = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta") text += e.delta.text;
        if (e.type === "message_delta") {
          usage = e.usage;
          stop = e.delta?.stop_reason ?? stop;
        }
        if (e.type === "error") throw new Error(`Anthropic stream error: ${JSON.stringify(e).slice(0, 200)}`);
      }
    }
    return { text, stop_reason: stop, usage, costUsd: costOf(usage) };
  }
}
