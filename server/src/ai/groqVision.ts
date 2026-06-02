/**
 * Groq vision fallback for promo-video indexing.
 *
 * Groq exposes an OpenAI-compatible chat/completions endpoint with multimodal
 * models (Llama 4 Scout) that accept images. We use it as a FALLBACK when
 * Claude vision is overloaded (HTTP 529) or otherwise unavailable, so promo
 * indexing still produces a real vision index instead of the coarse fallback.
 *
 * Same contract as claudeVisionJSON: frames (base64 JPEG) + system + userText
 * → returns a JSON string.
 */
import { aiConfig } from "./config.js";
import { extractJson } from "./claude.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function groqVisionConfigured(): boolean {
  return !!aiConfig.groqApiKey;
}

export async function groqVisionJSON(opts: {
  system: string;
  userText: string;
  frames: string[]; // base64 JPEG, chronological
  model?: string;
}): Promise<string> {
  if (!aiConfig.groqApiKey) {
    throw new Error("GROQ_API_KEY is not set — Groq vision fallback unavailable.");
  }
  const model = opts.model || aiConfig.groqVisionModel;

  // Build OpenAI-style multimodal content: each frame as an image_url data URI,
  // then the instruction text.
  const content: any[] = [];
  opts.frames.forEach((b64, i) => {
    content.push({ type: "text", text: `Frame at ${i}s:` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } });
  });
  content.push({
    type: "text",
    text: opts.userText + "\n\nRespond with ONLY the raw JSON object. No markdown, no code fences, no commentary.",
  });

  const body = {
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content },
    ],
    temperature: 0.2,
    max_tokens: aiConfig.maxTokens,
    response_format: { type: "json_object" },
  };

  const maxAttempts = Number.parseInt(process.env.GROQ_MAX_RETRIES || "4", 10);
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${aiConfig.groqBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${aiConfig.groqApiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt < maxAttempts) { await sleep(800 * attempt); continue; }
      throw new Error(`Groq vision network error: ${lastErr}`);
    }
    if (res.ok) {
      const json: any = await res.json();
      const text = json?.choices?.[0]?.message?.content ?? "";
      return extractJson(text);
    }
    const j: any = await res.json().catch(() => ({}));
    lastErr = `${res.status}: ${j?.error?.message || JSON.stringify(j)}`;
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (retryable && attempt < maxAttempts) { await sleep(1000 * 2 ** (attempt - 1)); continue; }
    throw new Error(`Groq vision error (${res.status}): ${j?.error?.message || JSON.stringify(j)}`);
  }
  throw new Error(`Groq vision failed after ${maxAttempts} attempts: ${lastErr}`);
}
