/**
 * Avatar/lipsync backends behind one interface.
 *
 * Every provider here does the same job — portrait + narration audio in, talking
 * MP4 out — and every one of them is asynchronous: you submit a task, you get an
 * id, you poll. So the interface is just `submit` + `poll`, and the pipeline
 * never learns which backend it is talking to.
 *
 * The point of the seam is the migration path. Hosted InfiniteTalk is $0.06/s of
 * video at 720p; the same open-weights model on a rented GPU is nearer $0.004/s,
 * but only pays for itself past ~150 finished minutes a month once you count the
 * worker, the 30GB of weights on a network volume, and the cold starts. Keeping
 * `selfhost` a peer of `kie` from day one means crossing that threshold is an
 * env var, not a rewrite of the pipeline.
 *
 *   kie        — api.kie.ai, `infinitalk/from-audio`. Default. Same
 *                createTask/recordInfo shape as the Kinovi client already in
 *                endpoints.ts (Kinovi is a white-label of it).
 *   wavespeed  — api.wavespeed.ai, `wavespeed-ai/infinitetalk`. Same 720p price.
 *   selfhost   — a generic submit/poll worker (e.g. RunPod serverless running
 *                InfiniteTalk) at INFINITETALK_SELFHOST_URL.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import {
  getKieApiKey,
  getSegmindApiKey,
  getWaveSpeedApiKey,
  getSelfHostAvatarUrl,
  getSelfHostAvatarKey,
} from "../settings/secrets.js";
import type { AvatarProviderId, AvatarResolution } from "./types.js";

export interface SubmitInput {
  /** Publicly fetchable portrait URL (see publicAssets.ts). */
  imageUrl: string;
  /**
   * Publicly fetchable ROOM PLATE — the empty studio the presenter belongs in
   * (see rooms.ts). Sent alongside the portrait to the generative engines so
   * every segment opens and closes in the same room instead of one the model
   * re-imagines per job. Lipsync engines ignore it: they animate the portrait
   * and cannot introduce a background at all.
   */
  roomUrl?: string;
  /** Publicly fetchable narration audio URL. */
  audioUrl: string;
  /** Behaviour hint — what the presenter is doing, not what they are saying. */
  prompt: string;
  resolution: AvatarResolution;
  seed?: number;
  /**
   * Measured length of the narration, in seconds. Lipsync models infer this
   * from the audio; GENERATIVE engines (Seedance) must be told, because they
   * decide up front how much video to make — and a clip shorter than its
   * narration truncates the script mid-sentence.
   */
  seconds?: number;
  /** Output aspect ratio. Segmind defaults to 16:9, which ruins a 9:16 persona. */
  aspect?: string;
  /**
   * The words to be spoken, for engines that GENERATE the audio themselves.
   * Lipsync engines ignore this — they are driven by `audioUrl` and the words
   * are already in it.
   */
  speech?: string;
}

export type PollState =
  | { status: "pending" }
  /**
   * A finished clip, as EITHER a URL to fetch or a file already on disk.
   *
   * Most of these APIs hand back a URL. Segmind's /v1 endpoint instead answers
   * the submit call synchronously with the raw MP4 bytes, so there is no URL to
   * fetch afterwards — the provider has already got the video and just needs to
   * hand it over. Modelling that as a second shape beats inventing a fake URL
   * for the pipeline to re-download from ourselves.
   */
  | { status: "done"; videoUrl: string; videoFile?: undefined }
  | { status: "done"; videoFile: string; videoUrl?: undefined }
  | { status: "failed"; error: string };

export interface AvatarProvider {
  id: AvatarProviderId;
  label: string;
  /**
   * True when the engine produces its OWN audio track, synchronised to the
   * mouth it drew, from `speech` plus a voice reference.
   *
   * This decides whether the pipeline may mux our narration over the result.
   * For a lipsync engine it must (the clip is silent or carries our own track
   * anyway); for a generative engine it must NOT — overwriting the model's
   * audio with our separately-timed TTS is precisely what puts the lips out of
   * sync with the words.
   */
  producesAudio?: boolean;
  configured(): boolean;
  /** Submit a job; resolve with the provider's task id. */
  submit(input: SubmitInput): Promise<string>;
  /** Ask once whether the task is finished. Never throws on "still working". */
  poll(taskId: string): Promise<PollState>;
}

/**
 * kie.ai documents `seed` as "valid range is 10000 to 1000000" and rejects the
 * task outright otherwise — so a caller passing the obvious `seed: 42` would
 * lose the job, and the narration already paid for with it. Fold the value into
 * range instead of failing: the point of a seed is repeatability, and a
 * deterministic fold keeps that while staying inside what the API accepts.
 */
const SEED_MIN = 10000;
const SEED_MAX = 1000000;

export function normalizeSeed(seed: number | undefined): number | undefined {
  if (seed === undefined || !Number.isFinite(seed)) return undefined;
  const n = Math.floor(Math.abs(seed));
  return SEED_MIN + (n % (SEED_MAX - SEED_MIN + 1));
}

/** Read a JSON body without letting a non-JSON error page throw a parse error. */
async function readJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
}

/**
 * Pull the first plausible video URL out of a provider payload. Each of these
 * services has moved its result field at least once (`resultUrls`, `outputs`,
 * `resultJson` as a *string*), so we look in all the known shapes rather than
 * betting the pipeline on one of them.
 */
function findVideoUrl(payload: any): string | null {
  const seen = new Set<any>();
  const walk = (node: any, depth: number): string | null => {
    if (node == null || depth > 6) return null;
    if (typeof node === "string") {
      const s = node.trim();
      if (/^https?:\/\/\S+\.(mp4|webm|mov)(\?|$)/i.test(s)) return s;
      // Some providers hand back the result object as an embedded JSON string.
      if (s.startsWith("{") || s.startsWith("[")) {
        try { return walk(JSON.parse(s), depth + 1); } catch { return null; }
      }
      return null;
    }
    if (typeof node !== "object") return null;
    if (seen.has(node)) return null;
    seen.add(node);
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(payload, 0);
}

// ── kie.ai ───────────────────────────────────────────────────────────────────

const KIE_BASE = process.env.KIE_BASE_URL || "https://api.kie.ai";
const KIE_MODEL = process.env.KIE_INFINITETALK_MODEL || "infinitalk/from-audio";

const kieProvider: AvatarProvider = {
  id: "kie",
  label: "kie.ai — InfiniteTalk",
  configured: () => !!getKieApiKey(),

  async submit(input) {
    const key = getKieApiKey();
    if (!key) throw new Error("kie.ai API key not configured — add KIE_API_KEY in Settings → Avatar Narrator.");

    const res = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: KIE_MODEL,
        input: {
          image_url: input.imageUrl,
          audio_url: input.audioUrl,
          prompt: input.prompt,
          resolution: input.resolution,
          ...(normalizeSeed(input.seed) ? { seed: normalizeSeed(input.seed) } : {}),
        },
      }),
    });

    const json = await readJson(res);
    if (!res.ok) throw new Error(`kie.ai createTask failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    // kie.ai answers HTTP 200 with a non-200 `code` on business errors.
    if (json?.code && json.code !== 200) throw new Error(`kie.ai rejected the task (code ${json.code}): ${json?.msg ?? "unknown"}`);

    const taskId = json?.data?.taskId ?? json?.data?.task_id ?? json?.taskId;
    if (!taskId) throw new Error(`kie.ai returned no taskId: ${JSON.stringify(json).slice(0, 300)}`);
    return String(taskId);
  },

  async poll(taskId) {
    const key = getKieApiKey();
    if (!key) return { status: "failed", error: "kie.ai API key not configured." };

    const res = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const json = await readJson(res);
    // A transient 5xx while polling is not a failed render — keep waiting.
    if (!res.ok) return res.status >= 500 ? { status: "pending" } : { status: "failed", error: `kie.ai recordInfo HTTP ${res.status}` };

    const data = json?.data ?? {};
    const state = String(data.state ?? data.status ?? "").toLowerCase();
    if (state === "fail" || state === "failed" || state === "error") {
      return { status: "failed", error: data.failMsg || data.failCode || json?.msg || "kie.ai reported failure" };
    }

    const url = findVideoUrl(data);
    if (url) return { status: "done", videoUrl: url };
    return { status: "pending" };
  },
};

/**
 * Compose the prompt for a GENERATIVE engine.
 *
 * Two things have to be in it that a lipsync engine never needs: the exact
 * words, because the model is the one speaking them, and an instruction to take
 * the voice from the reference clip rather than inventing one. Segmind binds
 * references only when the prompt cites them by name, so "@Image 1" and
 * "@Audio 1" are load-bearing, not decorative.
 */
function generativeSpeechPrompt(input: SubmitInput, cite: boolean): string {
  const who = cite ? "the person in @Image 1" : "the person in the first reference image";
  const voice = cite ? "@Audio 1" : "the reference audio";
  const line = (input.speech ?? "").trim();
  // The room has to be CITED, not merely attached. Handed a second image with
  // no instruction, the model treats it as another view of the subject; named,
  // it becomes the set — and naming the first and last frame is what stops a
  // long script drifting into a different room segment by segment.
  const room = cite ? "@Image 2" : "the second reference image";
  return [
    `${input.prompt}`,
    `The speaker is ${who}, filmed in a single continuous take.`,
    input.roomUrl
      ? `They are in the room shown in ${room}. That room is the set: the shot opens and ends in it, ` +
        `filmed from the same camera position with the same lighting, the same objects and the same colour ` +
        `grade as ${room}. Do not change the room, relight it, move the camera or cut away from it.`
      : "",
    line
      ? `They say exactly this, word for word, at a natural unhurried pace, and nothing else: "${line}"`
      : "",
    `Their voice must match the voice in ${voice} — same timbre, age, accent and delivery.`,
    "Lip movement must match the words precisely.",
  ]
    .filter(Boolean)
    .join(" ");
}

// ── Seedance 2.5 (kie.ai) ────────────────────────────────────────────────────

const SEEDANCE_MODEL = process.env.KIE_SEEDANCE_MODEL || "bytedance/seedance-2-5";

/** Seedance accepts 4-30s; anything outside that is rejected, not clamped. */
const SEEDANCE_MIN_SECONDS = 4;
const SEEDANCE_MAX_SECONDS = 30;

/**
 * Seedance 2.5 — a generative engine, not a lipsync one.
 *
 * The difference is the entire reason it costs 5x what InfiniteTalk does:
 * InfiniteTalk animates the portrait you hand it and can never look better
 * than that flat-lit still, while Seedance GENERATES the presenter from the
 * portrait as a reference — so it can light them, move them and give them
 * skin that behaves like skin.
 *
 * Two settings here are worth more than the rest of the file:
 *
 *   generate_audio: false — the API defaults it TRUE and explicitly bills more
 *     for it. We already have the narration; letting Seedance invent its own
 *     would cost extra AND fight the script the operator actually wrote. The
 *     narration is muxed back over the silent render in the stitch step, which
 *     is also what guarantees the words are verbatim.
 *
 *   aspect_ratio omitted — defaults to `adaptive`, which follows the reference
 *     portrait. Sending one risks fighting a 9:16 portrait with a 16:9 frame.
 */
const seedanceProvider: AvatarProvider = {
  id: "seedance",
  label: "Seedance 2.5 (kie.ai)",
  producesAudio: true,
  configured: () => !!getKieApiKey(),

  async submit(input) {
    const key = getKieApiKey();
    if (!key) throw new Error("kie.ai API key not configured — add KIE_API_KEY in Settings → Avatar Narrator.");

    // CEIL plus a second of headroom. The reference clip tells us roughly how
    // long the line takes, but the model sets its own pace — and speech clipped
    // mid-word is a ruined take, where a beat of silence at the end is not.
    const seconds = Math.min(SEEDANCE_MAX_SECONDS, Math.ceil(input.seconds ?? 0) + 1);
    if (seconds > SEEDANCE_MAX_SECONDS) {
      throw new Error(
        `Seedance 2.5 caps a job at ${SEEDANCE_MAX_SECONDS}s and this segment is ${seconds}s — split the script into shorter chunks.`,
      );
    }

    const res = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SEEDANCE_MODEL,
        input: {
          prompt: generativeSpeechPrompt(input, false),
          // The multimodal reference path. Mutually exclusive with
          // first_frame_url/last_frame_url — sending both is a 4xx. The room
          // plate goes here as a second reference rather than as a first/last
          // frame for exactly that reason: the portrait already has to occupy
          // this slot, and losing it would cost the face to fix the room.
          reference_image_urls: [input.imageUrl, ...(input.roomUrl ? [input.roomUrl] : [])],
          // The voice to imitate, NOT the track to play. The model speaks the
          // words from the prompt in this voice, and lip-syncs to what it
          // produced — which is the only way the mouth can actually match.
          reference_audio_urls: [input.audioUrl],
          resolution: input.resolution,
          duration: Math.max(SEEDANCE_MIN_SECONDS, seconds || SEEDANCE_MIN_SECONDS),
          generate_audio: true,
          output_format: "mp4",
        },
      }),
    });

    const json = await readJson(res);
    if (!res.ok) throw new Error(`Seedance createTask failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    if (json?.code && json.code !== 200) {
      throw new Error(`kie.ai rejected the Seedance task (code ${json.code}): ${json?.msg ?? "unknown"}`);
    }

    const taskId = json?.data?.taskId ?? json?.data?.task_id ?? json?.taskId;
    if (!taskId) throw new Error(`kie.ai returned no taskId: ${JSON.stringify(json).slice(0, 300)}`);
    return String(taskId);
  },

  // Same jobs API as every other kie.ai model, so the polling is identical.
  poll: (taskId) => kieProvider.poll(taskId),
};

// ── Segmind (Seedance 2.5) ───────────────────────────────────────────────────

const SEGMIND_BASE = process.env.SEGMIND_BASE_URL || "https://api.segmind.com";
const SEGMIND_MODEL = process.env.SEGMIND_SEEDANCE_MODEL || "seedance-2.5";

/**
 * Seedance 2.5 via Segmind — the same ByteDance model as the kie.ai adapter
 * above, hosted ~24% cheaper at every tier (480p: $0.1065/s vs $0.140/s).
 *
 * Three differences from kie.ai are load-bearing, and each one is a silent
 * wrong-output bug rather than an error if you get it wrong:
 *
 *   1. REFERENCES MUST BE CITED IN THE PROMPT. Segmind passes references as
 *      `reference_images` / `reference_audios`, and the model only binds them
 *      when the prompt names them as "@Image 1" and "@Audio 1". Omit the
 *      citation and you pay full price for a video of a stranger.
 *   2. `aspect_ratio` DEFAULTS TO 16:9, where kie.ai defaults to adaptive. A
 *      9:16 persona sent without one comes back letterboxed and useless.
 *   3. The /v1 endpoint answers SYNCHRONOUSLY with raw MP4 bytes; the async
 *      request_id + /v2 polling path is the documented alternative. Both are
 *      handled — sync results are buffered to disk and handed back as
 *      `videoFile`.
 *
 * `generate_audio` stays false: we supply the narration, and on Segmind audio
 * generation is free rather than surcharged, so this is about owning the words
 * rather than about cost.
 */
const segmindProvider: AvatarProvider = {
  id: "segmind",
  label: "Segmind — Seedance 2.5",
  producesAudio: true,
  configured: () => !!getSegmindApiKey(),

  async submit(input) {
    const key = getSegmindApiKey();
    if (!key) throw new Error("Segmind API key not configured — add SEGMIND_API_KEY in Settings → Avatar Narrator.");

    // CEIL plus a second of headroom. The reference clip tells us roughly how
    // long the line takes, but the model sets its own pace — and speech clipped
    // mid-word is a ruined take, where a beat of silence at the end is not.
    const seconds = Math.min(SEEDANCE_MAX_SECONDS, Math.ceil(input.seconds ?? 0) + 1);
    if (seconds > SEEDANCE_MAX_SECONDS) {
      throw new Error(
        `Seedance 2.5 caps a job at ${SEEDANCE_MAX_SECONDS}s and this segment is ${seconds}s — split the script into shorter chunks.`,
      );
    }

    const res = await fetch(`${SEGMIND_BASE}/v1/${SEGMIND_MODEL}`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        // The citations are not decoration — see note 1 above.
        prompt: generativeSpeechPrompt(input, true),
        // Order is load-bearing: the prompt cites these as @Image 1 (the
        // presenter) and @Image 2 (the room), so swapping them swaps meanings.
        reference_images: [input.imageUrl, ...(input.roomUrl ? [input.roomUrl] : [])],
        // A voice to copy, not a track to play back. Seedance generates its own
        // audio from the words in the prompt and syncs the mouth to that.
        reference_audios: [input.audioUrl],
        resolution: input.resolution,
        duration: Math.max(SEEDANCE_MIN_SECONDS, seconds || SEEDANCE_MIN_SECONDS),
        aspect_ratio: input.aspect || "adaptive",
        generate_audio: true,
        output_format: "mp4",
        // Segmind accepts -1..2147483647, kie.ai only 10000..1000000. The
        // shared clamp satisfies both, so one seed means one face on either.
        ...(normalizeSeed(input.seed) ? { seed: normalizeSeed(input.seed) } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Segmind submit failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }

    // Async shape: JSON carrying a request id to poll.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const json = await readJson(res);
      const id = json?.request_id ?? json?.requestId ?? json?.id;
      if (id) return String(id);
      const direct = findVideoUrl(json);
      if (direct) return `url:${direct}`;
      throw new Error(`Segmind returned no request id: ${JSON.stringify(json).slice(0, 300)}`);
    }

    // Sync shape: the response body IS the finished MP4.
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("Segmind returned an empty video.");
    fs.mkdirSync(config.tmpDir, { recursive: true });
    const file = path.join(config.tmpDir, `segmind-${crypto.randomBytes(8).toString("hex")}.mp4`);
    fs.writeFileSync(file, buf);
    return `file:${file}`;
  },

  async poll(taskId) {
    // Both non-polling shapes are encoded in the id so a resumed run after a
    // restart still resolves without a second paid submit.
    if (taskId.startsWith("file:")) {
      const file = taskId.slice(5);
      return fs.existsSync(file)
        ? { status: "done", videoFile: file }
        : { status: "failed", error: "The rendered clip is no longer on disk." };
    }
    if (taskId.startsWith("url:")) return { status: "done", videoUrl: taskId.slice(4) };

    const key = getSegmindApiKey();
    if (!key) return { status: "failed", error: "Segmind API key not configured." };

    const res = await fetch(`${SEGMIND_BASE}/v2/requests/${encodeURIComponent(taskId)}/status`, {
      headers: { "x-api-key": key },
    });
    const json = await readJson(res);
    if (!res.ok) return res.status >= 500 ? { status: "pending" } : { status: "failed", error: `Segmind status HTTP ${res.status}` };

    const status = String(json?.status ?? "").toUpperCase();
    if (status === "FAILED" || status === "CANCELLED") {
      return { status: "failed", error: String(json?.error ?? "Segmind reported failure") };
    }
    if (status !== "COMPLETED") return { status: "pending" };

    // Completed — the status payload may already carry the URL, otherwise the
    // result endpoint has it.
    const inline = findVideoUrl(json);
    if (inline) return { status: "done", videoUrl: inline };

    const out = await fetch(`${SEGMIND_BASE}/v2/requests/${encodeURIComponent(taskId)}`, {
      headers: { "x-api-key": key },
    });
    const result = await readJson(out);
    const url = findVideoUrl(result);
    return url
      ? { status: "done", videoUrl: url }
      : { status: "failed", error: "Segmind completed with no output URL" };
  },
};

// ── WaveSpeed ────────────────────────────────────────────────────────────────

const WAVESPEED_BASE = process.env.WAVESPEED_BASE_URL || "https://api.wavespeed.ai";
const WAVESPEED_MODEL = process.env.WAVESPEED_INFINITETALK_MODEL || "wavespeed-ai/infinitetalk";

const waveSpeedProvider: AvatarProvider = {
  id: "wavespeed",
  label: "WaveSpeed — InfiniteTalk",
  configured: () => !!getWaveSpeedApiKey(),

  async submit(input) {
    const key = getWaveSpeedApiKey();
    if (!key) throw new Error("WaveSpeed API key not configured — add WAVESPEED_API_KEY in Settings → Avatar Narrator.");

    const res = await fetch(`${WAVESPEED_BASE}/api/v3/${WAVESPEED_MODEL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        image: input.imageUrl,
        audio: input.audioUrl,
        prompt: input.prompt,
        resolution: input.resolution,
        ...(input.seed ? { seed: input.seed } : {}),
      }),
    });

    const json = await readJson(res);
    if (!res.ok) throw new Error(`WaveSpeed submit failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    const id = json?.data?.id ?? json?.id;
    if (!id) throw new Error(`WaveSpeed returned no prediction id: ${JSON.stringify(json).slice(0, 300)}`);
    return String(id);
  },

  async poll(taskId) {
    const key = getWaveSpeedApiKey();
    if (!key) return { status: "failed", error: "WaveSpeed API key not configured." };

    const res = await fetch(`${WAVESPEED_BASE}/api/v3/predictions/${encodeURIComponent(taskId)}/result`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const json = await readJson(res);
    if (!res.ok) return res.status >= 500 ? { status: "pending" } : { status: "failed", error: `WaveSpeed result HTTP ${res.status}` };

    const data = json?.data ?? {};
    const status = String(data.status ?? "").toLowerCase();
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      return { status: "failed", error: data.error || "WaveSpeed reported failure" };
    }
    if (status === "completed") {
      const url = findVideoUrl(data.outputs ?? data);
      if (url) return { status: "done", videoUrl: url };
      return { status: "failed", error: "WaveSpeed completed with no output URL" };
    }
    return { status: "pending" };
  },
};

// ── Self-hosted worker ───────────────────────────────────────────────────────

/**
 * A generic submit/poll worker — shaped for RunPod serverless, which is the
 * cheapest way to run InfiniteTalk yourself:
 *
 *   POST <url>/run      { input: {...} }        → { id }
 *   GET  <url>/status/<id>                      → { status, output }
 *
 * Anything speaking that shape works; RunPod's own endpoint URL
 * (https://api.runpod.ai/v2/<endpoint-id>) drops straight in.
 */
const selfHostProvider: AvatarProvider = {
  id: "selfhost",
  label: "Self-hosted InfiniteTalk (GPU worker)",
  configured: () => !!getSelfHostAvatarUrl(),

  async submit(input) {
    const base = getSelfHostAvatarUrl();
    if (!base) throw new Error("Self-hosted worker URL not configured — add INFINITETALK_SELFHOST_URL in Settings.");
    const key = getSelfHostAvatarKey();

    const res = await fetch(`${base.replace(/\/+$/, "")}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        input: {
          image_url: input.imageUrl,
          audio_url: input.audioUrl,
          prompt: input.prompt,
          resolution: input.resolution,
          ...(normalizeSeed(input.seed) ? { seed: normalizeSeed(input.seed) } : {}),
        },
      }),
    });

    const json = await readJson(res);
    if (!res.ok) throw new Error(`Self-hosted worker submit failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    const id = json?.id ?? json?.data?.id;
    if (!id) throw new Error(`Self-hosted worker returned no job id: ${JSON.stringify(json).slice(0, 300)}`);
    return String(id);
  },

  async poll(taskId) {
    const base = getSelfHostAvatarUrl();
    if (!base) return { status: "failed", error: "Self-hosted worker URL not configured." };
    const key = getSelfHostAvatarKey();

    const res = await fetch(`${base.replace(/\/+$/, "")}/status/${encodeURIComponent(taskId)}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    const json = await readJson(res);
    if (!res.ok) return res.status >= 500 ? { status: "pending" } : { status: "failed", error: `Self-hosted worker status HTTP ${res.status}` };

    const status = String(json?.status ?? "").toUpperCase();
    if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") {
      return { status: "failed", error: String(json?.error ?? `worker reported ${status}`) };
    }
    if (status === "COMPLETED") {
      const url = findVideoUrl(json?.output ?? json);
      if (url) return { status: "done", videoUrl: url };
      return { status: "failed", error: "Worker completed with no output URL" };
    }
    return { status: "pending" };
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<AvatarProviderId, AvatarProvider> = {
  segmind: segmindProvider,
  seedance: seedanceProvider,
  kie: kieProvider,
  wavespeed: waveSpeedProvider,
  selfhost: selfHostProvider,
};

export function getProvider(id: AvatarProviderId): AvatarProvider {
  return REGISTRY[id] ?? segmindProvider;
}

export function listProviders(): Array<{ id: AvatarProviderId; label: string; configured: boolean }> {
  return (Object.keys(REGISTRY) as AvatarProviderId[]).map((id) => ({
    id,
    label: REGISTRY[id].label,
    configured: REGISTRY[id].configured(),
  }));
}

/** Exported for unit tests — the result-shape sniffing is the fragile part. */
// generativeSpeechPrompt is exported for test because the CITATIONS are the
// contract with the model: @Image 1 is the presenter, @Image 2 is the room.
export const __test = { findVideoUrl, generativeSpeechPrompt };
