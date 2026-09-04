/**
 * Higgsfield REST client, for generating a plan's motion graphics.
 *
 * WHY REST AND NOT THE MCP. The earlier read of this was that we needed the MCP
 * (and therefore an OAuth device-code flow, since Higgsfield's MCP has no API
 * key), because Marketing Studio and the explainer presets are MCP-only. That
 * turned out not to matter: every one of the 23 explainer presets is 9:16, and
 * a long-form video is 16:9, so the MCP's exclusive features are the wrong
 * shape for this tool. What the public REST API does have is exactly the two
 * calls the pipeline needs — an image model that renders text, and image-to-video
 * that takes that image as its first frame. So this needs a key and a secret
 * pasted into Settings, and no OAuth at all.
 *
 * THE PIPELINE, AND WHY IT IS TWO CALLS. Generated video renders text
 * unreliably; a title card whose headline is misspelled is worthless. The spike
 * that settled this generated the still FIRST (text came out sharp and
 * correctly kerned on the first try) and then animated that still, which moves
 * the background and the light while leaving the lettering alone. Never ask a
 * video model for a title card directly.
 *
 * Media never passes through us: `/nano-banana` returns a hosted image URL, and
 * that URL is what image-to-video takes as its first frame. Nothing here needs
 * to be publicly reachable, which is what makes this workable on a box whose
 * lab is behind a sign-in gate.
 */
import { getHiggsfieldCredentials } from "../settings/postizSecrets.js";

const BASE = "https://api.higgsfield.ai";

/** How long to wait for one generation before giving up. Video is the slow one. */
const POLL_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

/** The image model. Renders legible text, which is the whole reason it is here. */
export const STILL_PATH = "/nano-banana";

/**
 * Image-to-video. Kling 2.5-turbo pro is the quality pick among the endpoints
 * that accept a first frame; the others (seedance lite, hailuo standard, wan)
 * take the same shape if this ever needs to be cheaper.
 */
export const MOTION_PATH = "/kling-video/v2.5-turbo/pro/image-to-video";

/** Kling generates 5 or 10 seconds and nothing in between. Slots are trimmed to fit. */
export const MOTION_DURATIONS = [5, 10] as const;

export interface MediaOutput {
  url?: string;
  [k: string]: unknown;
}

export interface HiggsfieldRequest {
  status: "queued" | "in_progress" | "nsfw" | "failed" | "completed" | "canceled";
  request_id: string;
  error?: string | null;
  images?: MediaOutput[];
  video?: MediaOutput;
}

export function higgsfieldConfigured(): boolean {
  return getHiggsfieldCredentials() !== null;
}

/**
 * The documented scheme is a single `Authorization: Key <id>:<secret>` header —
 * NOT HTTP Basic, despite what the credential getter's comment used to say.
 * base64-encoding this pair produces a 401.
 */
function authHeader(): string {
  const creds = getHiggsfieldCredentials();
  if (!creds) {
    throw new Error(
      "Higgsfield is not configured. Add HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in Settings.",
    );
  }
  return `Key ${creds.key}:${creds.secret}`;
}

async function submit(path: string, body: unknown): Promise<HiggsfieldRequest> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // The body carries the useful part (`detail`), and a bare status code on a
    // 422 tells you nothing about which field the model rejected.
    throw new Error(`Higgsfield ${path} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as HiggsfieldRequest;
}

/** Poll one request to a terminal state. Returns the finished request. */
async function awaitRequest(requestId: string, label: string): Promise<HiggsfieldRequest> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const res = await fetch(`${BASE}/requests/${requestId}/status`, {
      headers: { Authorization: authHeader() },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Higgsfield status ${requestId} (${res.status}): ${text.slice(0, 300)}`);
    const req = JSON.parse(text) as HiggsfieldRequest;
    if (req.status === "completed") return req;
    // `nsfw` and `canceled` are terminal too, and neither will ever produce a
    // file — treating them as "keep waiting" would hang until the timeout.
    if (req.status === "failed" || req.status === "nsfw" || req.status === "canceled") {
      throw new Error(`Higgsfield ${label} ${req.status}: ${req.error || "no reason given"}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Higgsfield ${label} still ${req.status} after ${POLL_TIMEOUT_MS / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * Generate the still. `referenceImages` are style references, not content: they
 * are what keeps twenty separate cards inside one visual world, and they matter
 * more than any adjective in the prompt.
 */
export async function generateStill(opts: {
  prompt: string;
  aspectRatio?: string;
  referenceImages?: string[];
}): Promise<string> {
  const req = await submit(STILL_PATH, {
    prompt: opts.prompt,
    aspect_ratio: opts.aspectRatio ?? "16:9",
    num_images: 1,
    output_format: "png",
    // `input_images` items are objects, not bare URLs, and the schema is
    // `additionalProperties: false` — a plain string array 422s.
    ...(opts.referenceImages?.length
      ? {
          input_images: opts.referenceImages.map((image_url) => ({
            type: "image_url",
            image_url,
          })),
        }
      : {}),
  });
  const done = req.status === "completed" ? req : await awaitRequest(req.request_id, "still");
  const url = done.images?.[0]?.url;
  if (!url) throw new Error(`Higgsfield returned no image for request ${done.request_id}`);
  return url;
}

/** Animate a still. The image is the first frame, so its text survives intact. */
export async function animateStill(opts: {
  imageUrl: string;
  prompt: string;
  durationSec?: 5 | 10;
  negativePrompt?: string;
}): Promise<string> {
  const req = await submit(MOTION_PATH, {
    prompt: opts.prompt,
    image_url: opts.imageUrl,
    duration: opts.durationSec ?? 5,
    ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
  });
  const done = req.status === "completed" ? req : await awaitRequest(req.request_id, "motion");
  const url = done.video?.url;
  if (!url) throw new Error(`Higgsfield returned no video for request ${done.request_id}`);
  return url;
}

/** Pull a finished asset down to disk. */
export async function downloadAsset(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading ${url} failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFile } = await import("node:fs/promises");
  await writeFile(destPath, buf);
}
