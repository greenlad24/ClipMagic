/**
 * Narration voice for the Avatar Narrator.
 *
 * The lipsync model is audio-driven: whatever this produces is what the face
 * says, and how real the finished video sounds is decided here, not by the
 * video model. Two backends behind one function:
 *
 *   • gemini     — default. Reuses the GEMINI_API_KEY the Thumbnail Designer
 *                  and Image Generator already need, so the tool works with no
 *                  new account. ~$0.012 / 1k chars. Returns raw PCM.
 *   • elevenlabs — optional, ~8x the price, noticeably more human on long-form
 *                  narration. Returns MP3 directly.
 *
 * Both paths chunk the script, because both APIs cap the text per request and a
 * 5-minute narration is well past it. Chunks are concatenated with ffmpeg into
 * one MP3, which is what the provider fetches — one file, one job, no seams.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { getGeminiApiKey, getElevenLabsApiKey, getSegmindApiKey } from "../settings/postizSecrets.js";
import { publishForProvider, revoke } from "./publicAssets.js";
import { TTS_RATE_USD_PER_1K_CHARS, type TtsProviderId } from "./types.js";

const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";

/**
 * Gemini TTS model id, isolated behind one env-overridable constant so a Google
 * rename is a config change rather than a rebuild (same stance as
 * thumbnails/nanoBanana.ts's NANO_BANANA_MODEL).
 */
export const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";

/** ElevenLabs model id — multilingual v2 is the long-form narration default. */
export const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_v3";

/** The models worth offering, and what each actually sounds like. */
export const ELEVENLABS_MODELS = [
  { id: "eleven_v3", label: "v3 — expressive", hint: "Most life and emotional range. The fix for a robotic read." },
  { id: "eleven_multilingual_v2", label: "Multilingual v2 — steady", hint: "Flatter and more consistent take to take." },
  { id: "eleven_turbo_v2_5", label: "Turbo v2.5 — fast", hint: "Lowest latency, least nuance." },
];

/**
 * The operator's voice settings, applied to EVERY generation — auditions,
 * previews and the narration that ends up in a published video alike.
 *
 * That uniformity is the point. If an audition is rendered with different
 * settings from the final narration, the audition is worthless: you would be
 * choosing a voice you never actually ship. So this is one constant, read by
 * the only function that speaks.
 *
 * Chosen deliberately, not defaults:
 *   speed 1.08          — a touch quicker than neutral; short-form pacing
 *   stability 0.36      — LOW on purpose. High stability is flat and safe;
 *                         low lets the read move, at the cost of more variance
 *                         between takes
 *   similarityBoost .85 — holds the voice's identity while stability is loose
 *   style 0.70          — strong delivery. Costs latency and amplifies the
 *                         instability above, which is the trade being made
 *   speakerBoost        — on; sharpens the speaker's characteristics
 */
export interface VoiceSettings {
  model: string;
  speed: number;
  stability: number;
  similarityBoost: number;
  style: number;
  speakerBoost: boolean;
}

export const VOICE_SETTINGS: VoiceSettings = {
  model: ELEVENLABS_MODEL,
  speed: Number(process.env.ELEVENLABS_SPEED ?? 1.05),
  stability: Number(process.env.ELEVENLABS_STABILITY ?? 0.35),
  similarityBoost: Number(process.env.ELEVENLABS_SIMILARITY ?? 0.75),
  // Lowered from 0.70 deliberately. High style exaggerates delivery, which
  // sounds performed rather than alive and — counter-intuitively — is a common
  // cause of a stiff, synthetic read. Life comes from LOW stability, not high
  // style; style is the dial that overacts.
  style: Number(process.env.ELEVENLABS_STYLE ?? 0.35),
  speakerBoost: (process.env.ELEVENLABS_SPEAKER_BOOST ?? "true") !== "false",
};

/** Merge whatever the operator sent over the defaults, clamped to legal ranges. */
export function resolveVoiceSettings(patch?: Partial<VoiceSettings> | null): VoiceSettings {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const p = patch ?? {};
  return {
    model: typeof p.model === "string" && p.model ? p.model : VOICE_SETTINGS.model,
    speed: clamp(Number.isFinite(Number(p.speed)) ? Number(p.speed) : VOICE_SETTINGS.speed, 0.7, 1.2),
    stability: clamp(Number.isFinite(Number(p.stability)) ? Number(p.stability) : VOICE_SETTINGS.stability, 0, 1),
    similarityBoost: clamp(
      Number.isFinite(Number(p.similarityBoost)) ? Number(p.similarityBoost) : VOICE_SETTINGS.similarityBoost, 0, 1),
    style: clamp(Number.isFinite(Number(p.style)) ? Number(p.style) : VOICE_SETTINGS.style, 0, 1),
    speakerBoost: typeof p.speakerBoost === "boolean" ? p.speakerBoost : VOICE_SETTINGS.speakerBoost,
  };
}

/** Gemini returns signed 16-bit little-endian mono PCM at this rate. */
const GEMINI_PCM_RATE = 24000;

/** Characters per request. Both APIs cap well above this; the margin is intentional. */
const CHUNK_CHARS = 1800;

export interface VoiceOption {
  id: string;
  label: string;
  hint: string;
}

/**
 * The Gemini prebuilt voices worth offering for narration. Google ships ~30;
 * these are the ones that read as a presenter rather than an assistant.
 */
export const GEMINI_VOICES: VoiceOption[] = [
  { id: "Charon", label: "Charon", hint: "Deep, measured — documentary narrator" },
  { id: "Kore", label: "Kore", hint: "Warm, even — the safe default" },
  { id: "Puck", label: "Puck", hint: "Bright, energetic — short-form hooks" },
  { id: "Fenrir", label: "Fenrir", hint: "Gravelly, forceful" },
  { id: "Aoede", label: "Aoede", hint: "Light, conversational" },
  { id: "Leda", label: "Leda", hint: "Youthful, upbeat" },
  { id: "Orus", label: "Orus", hint: "Firm, authoritative" },
  { id: "Zephyr", label: "Zephyr", hint: "Airy, relaxed" },
];

export function ttsConfigured(provider: TtsProviderId): boolean {
  if (provider === "segmind") return !!getSegmindApiKey();
  if (provider === "elevenlabs") return !!getElevenLabsApiKey();
  return !!getGeminiApiKey();
}

export function defaultVoice(provider: TtsProviderId): string {
  // Rachel's public id — the one ElevenLabs voice id that is stable and
  // documented, so the tool speaks out of the box. Override with the operator's
  // own voice via SEGMIND_VOICE_ID or the persona field.
  if (provider === "segmind") return process.env.SEGMIND_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  if (provider === "elevenlabs") return process.env.ELEVENLABS_VOICE_ID || "";
  return "Charon";
}

// ── Voice cloning ────────────────────────────────────────────────────────────

/**
 * Clone a voice on ElevenLabs from a reference clip and return its voice id.
 *
 * WHY THE SAMPLE IS ARCHIVED, NOT DISCARDED: what comes back is an id pointing
 * at a model held inside ElevenLabs. It cannot be exported, and their terms
 * keep a perpetual licence to the voice and its derivatives. So the id is a
 * tenancy, not an asset. The clip it was made from IS an asset — keep it and
 * the persona's voice can be re-cloned into another provider later; lose it and
 * the voice is only ever rentable from one vendor. The caller stores it on the
 * persona (see db/avatar.ts `voice_sample_file`).
 *
 * CONSENT: ElevenLabs requires you to hold rights to any real person's voice
 * you clone. A synthetic sample generated by this tool is unencumbered; a
 * recording of a person is not, unless it is you or you have their permission.
 */
export async function cloneVoice(opts: {
  /** Absolute path to the reference clip (mp3/wav). */
  sampleFile: string;
  /** Name the voice will carry in the ElevenLabs library. */
  name: string;
  description?: string;
  /** Which account clones it. Defaults to Segmind — one key for voice + video. */
  provider?: TtsProviderId;
}): Promise<{ voiceId: string }> {
  if ((opts.provider ?? "segmind") === "segmind") return cloneVoiceViaSegmind(opts);
  const key = getElevenLabsApiKey();
  if (!key) throw new Error("ElevenLabs API key not configured — add ELEVENLABS_API_KEY in Settings.");
  if (!fs.existsSync(opts.sampleFile)) throw new Error("That voice sample is no longer available — record or generate a new one.");

  const bytes = fs.readFileSync(opts.sampleFile);
  if (!bytes.length) throw new Error("The voice sample is empty.");

  const form = new FormData();
  form.append("name", opts.name);
  if (opts.description) form.append("description", opts.description);
  form.append(
    "files",
    new Blob([new Uint8Array(bytes)], { type: opts.sampleFile.endsWith(".wav") ? "audio/wav" : "audio/mpeg" }),
    path.basename(opts.sampleFile),
  );

  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`ElevenLabs voice cloning failed: HTTP ${res.status} ${text.slice(0, 300)}`);

  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`ElevenLabs returned an unreadable response: ${text.slice(0, 200)}`);
  }
  const voiceId = json?.voice_id ?? json?.voiceId;
  if (!voiceId) throw new Error(`ElevenLabs returned no voice id: ${text.slice(0, 200)}`);
  return { voiceId: String(voiceId) };
}

// ── Segmind (ElevenLabs, resold) ─────────────────────────────────────────────

const SEGMIND_BASE = process.env.SEGMIND_BASE_URL || "https://api.segmind.com";
const SEGMIND_TTS_MODEL = process.env.SEGMIND_TTS_MODEL || "tts-eleven-labs";
const SEGMIND_CLONE_MODEL = process.env.SEGMIND_CLONE_MODEL || "elevenlabs-voice-clone";

/**
 * One chunk of narration through Segmind's ElevenLabs endpoint.
 *
 * Same voices and models as going to ElevenLabs directly ($0.16875/1k chars
 * against $0.0968), but pay-as-you-go with no plan quota to under-use — which
 * is cheaper below roughly 130k characters a month, and means the video engine
 * and the voice share one key.
 *
 * Segmind's /v1 endpoints answer with the raw media, so the body IS the audio.
 * `voice_id` carries a cloned voice; `voice` carries a preset name like
 * "Rachel". Sending whichever the operator set covers both.
 */
async function segmindChunk(text: string, voice: string, settings: VoiceSettings): Promise<Buffer> {
  const key = getSegmindApiKey();
  if (!key) throw new Error("Segmind API key not configured — add SEGMIND_API_KEY in Settings → Avatar Narrator.");
  if (!voice) throw new Error("Segmind needs a voice — pick a preset or clone one on the persona.");


  const res = await fetch(`${SEGMIND_BASE}/v1/${SEGMIND_TTS_MODEL}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      // `prompt`, not `text`: Segmind's /v1 wrapper uses one field name for the
      // primary input across every model — gpt-image-2, seedance-2.5 and this
      // all take `prompt`. Their TTS docs say `text`; the live API rejects it
      // with "'prompt' parameter is required". The convention wins.
      prompt: text,
      // ALWAYS an id, never a name. Segmind forwards whatever lands in `voice`
      // to ElevenLabs as an id — a display name comes back as
      // "An invalid ID has been received: 'Voice not found.'", so the
      // name-vs-id heuristic that used to live here was worse than useless: it
      // routed names into a field that could never accept them.
      voice_id: voice,
      model_id: settings.model,
      // Whatever the operator auditioned with is what the video gets — the two
      // must never diverge, or the audition is worthless.
      stability: settings.stability,
      similarity_boost: settings.similarityBoost,
      style: settings.style,
      speed: settings.speed,
      use_speaker_boost: settings.speakerBoost,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // The most common cause by far, and the message alone does not say how to
    // fix it — so say it here rather than making the operator work it out.
    if (/Voice not found|invalid_uid|invalid ID/i.test(body)) {
      throw new Error(
        `ElevenLabs does not recognise the voice "${voice}". It needs the voice ID, not the display name — ` +
          `copy the ID from the voice's page in your ElevenLabs library (it looks like 21m00Tcm4TlvDq8ikWAM) ` +
          `and paste that into the persona's voice field.`,
      );
    }
    throw new Error(`Segmind TTS failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("Segmind returned empty audio.");
  return buf;
}

const SEGMIND_DESIGN_MODEL = process.env.SEGMIND_VOICE_DESIGN_MODEL || "elevenlabs-voice-design";

/** Voice Design needs 100–1000 characters to show a voice's range. */
export const VOICE_DESIGN_MIN_CHARS = 100;
export const VOICE_DESIGN_MAX_CHARS = 1000;

/**
 * A line long enough to satisfy the minimum AND varied enough to expose the
 * voice: a flat sentence hides the prosody you are actually auditioning.
 */
/**
 * The audition paragraph — what you judge a narration voice on.
 *
 * A single flat sentence tells you almost nothing: every TTS engine sounds
 * competent for eight words. What separates a voice you can listen to for
 * forty minutes from one that grates is what it does with structure, and this
 * script is built to force each of those moments to happen:
 *
 *   • a short declarative opener        — does it land, or trail off?
 *   • a direct question                 — does the pitch actually rise?
 *   • a long multi-clause sentence      — does it keep the thread or run out of breath?
 *   • numbers and an abbreviation       — "9am", "20%" are where TTS mangles things
 *   • a parenthetical aside             — does it drop into a lower register?
 *   • an emphatic short sentence        — can it change gear at all?
 *   • a closing line                    — does it resolve, or just stop?
 *
 * Roughly 60 seconds of speech, which is also long enough to hear whether the
 * prosody drifts — the specific weakness of short-form TTS models on long-form.
 */
export const VOICE_AUDITION_TEXT =
  "Here's something nobody tells you when you start making videos. The hard part isn't the camera, and it isn't the editing either. " +
  "So what actually stops most people? Honestly, it's the decision about what to make in the first place. " +
  "I spent about eighteen months publishing three times a week — roughly two hundred videos, most of them fine, almost none of them memorable — " +
  "before I worked out that I was optimising the wrong thing entirely. Now I do something different. Every Monday at 9am, before I open a single app, " +
  "I write down the one question I want answered by Friday. That's it. That's the whole system. " +
  "It sounds almost too simple to matter, and I thought so too, right up until the week it doubled my output.";

export const VOICE_DESIGN_SAMPLE_TEXT =
  "Most people don't need a better to-do list — they need a shorter one. So here's the filter I run every Monday morning, " +
  "before anything is allowed onto my calendar. It takes about ninety seconds, and it has saved me more time than any app I've tried.";

/**
 * DESIGN a voice that has never existed, from a description.
 *
 * This is the answer to "I want a voice nobody else is using". Cloning copies a
 * voice that already exists; Voice Design generates a new one from words —
 * gender, age, accent, texture, pace — and every call produces a distinct
 * result. The persona gets a voice that is not in anyone's library.
 *
 * The output is archived exactly like a cloned sample, and for the same reason:
 * whatever the vendor hands back is a tenancy, and the audio is the asset. Once
 * you like a design, `cloneVoice` turns it into a persistent voice id — so the
 * chain is design → keep the clip → clone → reusable voice, with the clip as
 * the thing that survives a change of vendor.
 */
export async function designVoice(opts: {
  /** e.g. "a warm, unhurried woman in her early thirties, light American accent". */
  description: string;
  /** What the preview says. Padded to the 100-char minimum if short. */
  text?: string;
  outFile: string;
}): Promise<{ file: string; seconds: number; voiceId: string | null }> {
  const key = getSegmindApiKey();
  if (!key) throw new Error("Segmind API key not configured — add SEGMIND_API_KEY in Settings → Avatar Narrator.");

  const description = opts.description.trim();
  if (description.length < 20) {
    throw new Error("Describe the voice in a bit more detail — age, gender, accent, pace and texture all steer it.");
  }

  let text = (opts.text ?? "").trim() || VOICE_DESIGN_SAMPLE_TEXT;
  if (text.length < VOICE_DESIGN_MIN_CHARS) text = `${text} ${VOICE_DESIGN_SAMPLE_TEXT}`.trim();
  text = text.slice(0, VOICE_DESIGN_MAX_CHARS);

  const res = await fetch(`${SEGMIND_BASE}/v1/${SEGMIND_DESIGN_MODEL}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      voice_description: description,
      text,
      model_id: "eleven_multilingual_ttv_v2",
      // Mid guidance: high sticks rigidly to the description and sounds
      // synthetic, low wanders off the brief. Quality high because this voice
      // is reused by every video the persona ever makes.
      guidance_scale: 5,
      quality: 0.9,
      loudness: 0,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voice design failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  const contentType = res.headers.get("content-type") ?? "";

  // Two shapes are possible and both are fine:
  //
  //   JSON  — Segmind CREATES the voice and returns its record
  //           (`data.voice_id`, category "generated", `samples: null`). There is
  //           no preview audio, because the voice now persists on the account —
  //           which is better than a preview: no cloning step is needed, the id
  //           can be spoken with straight away.
  //   binary — the endpoint answered with the audio itself.
  if (contentType.includes("application/json")) {
    const json: any = await res.json().catch(() => ({}));
    const node = json?.data ?? json;
    const voiceId = node?.voice_id ?? node?.generated_voice_id ?? json?.voice_id ?? json?.generated_voice_id ?? null;

    // If it did hand back audio, keep it; otherwise speak the sample text in
    // the new voice so there is still something to listen to AND something to
    // archive. The clip is what survives a change of vendor, so a designed
    // voice with no clip on file would be a voice we do not really own.
    const b64 = node?.audio_base_64 ?? node?.audio_base64 ?? node?.b64_json;
    const url = node?.audio_url ?? node?.preview_url ?? node?.url;

    if (b64) {
      fs.writeFileSync(opts.outFile, Buffer.from(String(b64), "base64"));
    } else if (url) {
      const audio = await fetch(String(url));
      if (!audio.ok) throw new Error(`Fetching the designed voice failed: HTTP ${audio.status}`);
      fs.writeFileSync(opts.outFile, Buffer.from(await audio.arrayBuffer()));
    } else if (voiceId) {
      fs.writeFileSync(opts.outFile, await segmindChunk(text, String(voiceId), resolveVoiceSettings(null)));
    } else {
      throw new Error(`Voice design returned neither audio nor a voice id: ${JSON.stringify(json).slice(0, 300)}`);
    }

    return { file: opts.outFile, seconds: await probeDuration(opts.outFile), voiceId: voiceId ? String(voiceId) : null };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("Voice design returned empty audio.");
  fs.writeFileSync(opts.outFile, buf);
  return { file: opts.outFile, seconds: await probeDuration(opts.outFile), voiceId: null };
}

/**
 * Clone a voice through Segmind ($0.01 a go, against a paid ElevenLabs tier).
 *
 * UNVERIFIED CONTRACT: Segmind publishes the capability (1–25 samples,
 * `remove_background_noise`) but not the request schema, so the sample is sent
 * both ways it plausibly wants — base64 and a data URL — and the response is
 * searched for whatever id it returns. The first real call settles it; the
 * error carries the raw body so it is one edit to fix rather than a debugging
 * session.
 *
 * If Segmind's clone turns out to be per-call rather than a persistent voice,
 * that is BETTER for us, not worse: the archived sample becomes the voice, and
 * no vendor holds it at all.
 */
async function cloneVoiceViaSegmind(opts: {
  sampleFile: string;
  name: string;
  description?: string;
}): Promise<{ voiceId: string }> {
  const key = getSegmindApiKey();
  if (!key) throw new Error("Segmind API key not configured — add SEGMIND_API_KEY in Settings → Avatar Narrator.");
  if (!fs.existsSync(opts.sampleFile)) throw new Error("That voice sample is no longer available — record or generate a new one.");

  const bytes = fs.readFileSync(opts.sampleFile);
  if (!bytes.length) throw new Error("The voice sample is empty.");

  // Segmind fetches media fields server-side with Python `requests`, which
  // rejects a data URL outright ("No connection adapters were found") — proven
  // by the image-edit call failing exactly that way. So publish the clip and
  // send a URL, then revoke it as soon as the call returns.
  const published = publishForProvider(opts.sampleFile, `sample${path.extname(opts.sampleFile) || ".mp3"}`);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${SEGMIND_BASE}/v1/${SEGMIND_CLONE_MODEL}`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.name,
        ...(opts.description ? { description: opts.description } : {}),
        samples: [published.url],
        audio: published.url,
        remove_background_noise: true,
      }),
    });
    text = await res.text().catch(() => "");
  } finally {
    revoke(published.token);
  }
  if (!res.ok) throw new Error(`Segmind voice cloning failed: HTTP ${res.status} ${text.slice(0, 400)}`);

  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Segmind voice cloning returned a non-JSON body: ${text.slice(0, 200)}`);
  }
  const voiceId = json?.voice_id ?? json?.voiceId ?? json?.id ?? json?.data?.voice_id;
  if (!voiceId) {
    throw new Error(
      `Segmind cloned the voice but returned no id — check the response shape: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return { voiceId: String(voiceId) };
}

// ── Text chunking ────────────────────────────────────────────────────────────

/**
 * Split a script into request-sized pieces on sentence boundaries. Splitting
 * mid-sentence is audible — the model resets its prosody at every chunk edge —
 * so a sentence is never broken unless it alone exceeds the limit.
 */
export function chunkScript(script: string, limit = CHUNK_CHARS): string[] {
  const text = script.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  if (text.length <= limit) return [text];

  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > limit) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > limit) {
      // A single sentence longer than the cap — fall back to a hard split so we
      // never emit an over-length request.
      if (cur) { out.push(cur.trim()); cur = ""; }
      for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit).trim());
      continue;
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

// ── ffmpeg helpers ───────────────────────────────────────────────────────────

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString(); if (err.length > 8000) err = err.slice(-8000); });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().slice(-500)}`)),
    );
  });
}

/** Duration of a media file in seconds, via ffprobe. */
export async function probeDuration(file: string): Promise<number> {
  const out = await run(config.ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const n = Number.parseFloat(out.trim());
  return Number.isFinite(n) ? n : 0;
}

function tmpDir(): string {
  const dir = path.join(config.tmpDir || os.tmpdir(), "avatar-tts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Providers ────────────────────────────────────────────────────────────────

/** One Gemini TTS request → raw PCM bytes. */
async function geminiChunk(text: string, voice: string): Promise<Buffer> {
  const key = getGeminiApiKey();
  if (!key) throw new Error("Gemini API key not configured — add GEMINI_API_KEY in Settings.");

  const url = `${GEMINI_BASE}/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Charon" } } },
      },
    }),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The key only ever appears in the query string, which we never echo.
    throw new Error(`Gemini TTS failed: ${json?.error?.message || `HTTP ${res.status}`}`);
  }

  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const b64 = p?.inlineData?.data ?? p?.inline_data?.data;
    if (b64) return Buffer.from(b64, "base64");
  }
  const why = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || "no audio in response";
  throw new Error(`Gemini TTS returned no audio (${why}).`);
}

/** One ElevenLabs request → MP3 bytes. */
async function elevenChunk(text: string, voice: string): Promise<Buffer> {
  const key = getElevenLabsApiKey();
  if (!key) throw new Error("ElevenLabs API key not configured — add ELEVENLABS_API_KEY in Settings.");
  if (!voice) throw new Error("ElevenLabs needs a voice id — pick one on the persona.");

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface SynthesisResult {
  /** Absolute path of the finished MP3. */
  file: string;
  seconds: number;
  costUsd: number;
  chunks: number;
}

/**
 * Voice a script to a single MP3 at `outFile`.
 *
 * `onProgress(done, total)` fires per chunk so a long narration can move the
 * progress bar instead of looking hung.
 */
export async function synthesize(opts: {
  script: string;
  provider: TtsProviderId;
  voice: string;
  outFile: string;
  /** Per-call overrides; unset fields fall back to VOICE_SETTINGS. */
  settings?: Partial<VoiceSettings> | null;
  onProgress?: (done: number, total: number) => void;
}): Promise<SynthesisResult> {
  const chunks = chunkScript(opts.script);
  if (!chunks.length) throw new Error("Nothing to narrate — the script is empty.");

  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  const work = path.join(tmpDir(), crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(work, { recursive: true });

  try {
    if (opts.provider === "gemini") {
      // Every chunk comes back as PCM in the SAME format, so raw concatenation
      // is exact — no re-encode, no chunk-boundary artefacts — and one ffmpeg
      // pass turns the whole thing into the MP3 the provider will fetch.
      const pcmParts: Buffer[] = [];
      for (let i = 0; i < chunks.length; i++) {
        pcmParts.push(await geminiChunk(chunks[i], opts.voice));
        opts.onProgress?.(i + 1, chunks.length);
      }
      const pcm = path.join(work, "narration.pcm");
      fs.writeFileSync(pcm, Buffer.concat(pcmParts));
      await run(config.ffmpegPath, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", String(GEMINI_PCM_RATE), "-ac", "1", "-i", pcm,
        "-codec:a", "libmp3lame", "-b:a", "128k",
        opts.outFile,
      ]);
    } else {
      // MP3 frames cannot be byte-concatenated safely, so write each chunk out
      // and let ffmpeg's concat demuxer join them.
      const files: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const f = path.join(work, `part-${String(i).padStart(3, "0")}.mp3`);
          fs.writeFileSync(
          f,
          opts.provider === "segmind"
            ? await segmindChunk(chunks[i], opts.voice, resolveVoiceSettings(opts.settings))
            : await elevenChunk(chunks[i], opts.voice),
        );
        files.push(f);
        opts.onProgress?.(i + 1, chunks.length);
      }
      if (files.length === 1) {
        fs.copyFileSync(files[0], opts.outFile);
      } else {
        const list = path.join(work, "concat.txt");
        fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
        await run(config.ffmpegPath, [
          "-y", "-hide_banner", "-loglevel", "error",
          "-f", "concat", "-safe", "0", "-i", list,
          "-codec:a", "libmp3lame", "-b:a", "128k",
          opts.outFile,
        ]);
      }
    }

    const seconds = await probeDuration(opts.outFile);
    return {
      file: opts.outFile,
      seconds,
      costUsd: (opts.script.length / 1000) * TTS_RATE_USD_PER_1K_CHARS[opts.provider],
      chunks: chunks.length,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
