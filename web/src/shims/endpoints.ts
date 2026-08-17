/**
 * The backend, as the page sees it.
 *
 * `AvatarNarratorPage.tsx` and the avatar components were written against a
 * generated SDK where every backend endpoint is a typed async function. This
 * module keeps that shape: each name below POSTs to `/api/fn/<name>`, which the
 * server dispatches to the matching handler. That is why the page code is
 * byte-identical to the lab's — the contract it imports did not change.
 *
 * Only the Avatar Narrator endpoints exist here. The lab's version carried ~180
 * more for tools this repo does not contain.
 */

const BASE = ""; // same origin as the served app

// Verbose API logging — every call, its timing, result and errors go to the
// browser console so a failing render is easy to read off. Turn it off with
// localStorage.avatarDebug = "0".
function debugOn(): boolean {
  try {
    return localStorage.getItem("avatarDebug") !== "0";
  } catch {
    return true;
  }
}

let callSeq = 0;

async function callFn<T = any>(name: string, input: unknown): Promise<T> {
  const id = ++callSeq;
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (debugOn()) {
    console.log(`%c[avatar] → #${id} ${name}`, "color:#60a5fa;font-weight:bold", input ?? {});
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/fn/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
    });
  } catch (networkErr) {
    console.error(`[avatar] ✗ #${id} ${name} — network error`, networkErr);
    throw new Error(`${name}: network error (is the server reachable?)`);
  }
  const ms = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    console.error(`[avatar] ✗ #${id} ${name} (${ms}ms) — non-JSON response:`, text.slice(0, 500));
    throw new Error(`${name}: invalid response: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || json?.message || `${name} failed (${res.status})`;
    console.error(`[avatar] ✗ #${id} ${name} (${ms}ms) HTTP ${res.status}:`, msg, json);
    throw new Error(msg);
  }
  if (debugOn()) {
    console.log(`%c[avatar] ✓ #${id} ${name} (${ms}ms)`, "color:#34d399;font-weight:bold", json);
  }
  return json as T;
}

function endpoint<I = any, O = any>(name: string) {
  return (input: I): Promise<O> => callFn<O>(name, input);
}

// ── Avatar Narrator (LAB tool) ───────────────────────────────────────────────
// Synthetic-presenter talking-head videos: a locked portrait + TTS driven
// through an audio-driven lipsync model (InfiniteTalk on kie.ai by default).

export type AvatarProviderId = "segmind" | "seedance" | "kie" | "wavespeed" | "selfhost";
export type AvatarResolution = "480p" | "720p";
export type TtsProviderId = "segmind" | "gemini" | "elevenlabs";
export type AvatarVideoState =
  | "queued" | "voicing" | "rendering" | "stitching" | "done" | "failed" | "canceled";

export interface AvatarVoiceOption { id: string; label: string; hint: string }

export interface AvatarPersona {
  id: string;
  name: string;
  lookPrompt: string;
  scenePrompt: string;
  portraitFile: string;
  portraitMime: string;
  ttsProvider: TtsProviderId;
  ttsVoice: string;
  /** The clip the voice was cloned from — the part of the voice you own. */
  voiceSampleFile: string;
  /** Room plate this persona is filmed in, or "" for none. */
  roomId: string;
  /** Character sheet on disk, or "" if one has never been made. */
  sheetFile: string;
  createdAt: number;
  portraitUrl: string;
  voiceSampleUrl: string | null;
  sheetUrl: string | null;
}

export interface AvatarSegment {
  id: string;
  videoId: string;
  idx: number;
  text: string;
  seconds: number;
  status: "pending" | "voicing" | "submitted" | "done" | "failed";
  providerTask: string | null;
  costUsd: number;
  error: string | null;
}

export interface AvatarVideo {
  id: string;
  personaId: string;
  personaName: string;
  title: string;
  script: string;
  status: AvatarVideoState;
  phase: string;
  progress: number;
  provider: AvatarProviderId;
  resolution: AvatarResolution;
  audioSeconds: number;
  costUsd: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  audioUrl: string | null;
  videoUrl: string | null;
  segments: AvatarSegment[];
}

export interface AvatarCostEstimate {
  seconds: number;
  segments: number;
  videoUsd: number;
  ttsUsd: number;
  totalUsd: number;
  perMinuteUsd: number;
}

/** How the footage was captured — the biggest single realism lever. */
export interface AvatarMedium { id: string; label: string; hint: string }

/** A room plate. `ready` is false when the plate's PNG is not on disk. */
export interface AvatarRoom { id: string; label: string; hint: string; ready: boolean }

/** A complete starting character plus the medium it was designed for. */
export interface AvatarLookPreset {
  id: string;
  label: string;
  hint: string;
  mediumId: string;
  voice: string;
  /** The character spec rendered as prompt text — editable before generating. */
  description: string;
}

export const avatarStatus = endpoint<
  Record<string, never>,
  {
    providers: { id: AvatarProviderId; label: string; configured: boolean }[];
    ttsConfigured: Record<TtsProviderId, boolean>;
    geminiVoices: AvatarVoiceOption[];
    publicBaseUrlConfigured: boolean;
    defaultScenePrompt: string;
    /** The paragraph a voice is auditioned with — editable in the UI. */
    auditionText: string;
    voiceSettings: AvatarVoiceSettings;
    voiceModels: { id: string; label: string; hint: string }[];
    mediums: AvatarMedium[];
    /** How much of the person is in frame — decides whether they can gesture. */
    framings: AvatarMedium[];
    /**
     * The fixed room plates a persona can be placed into. `ready` is false when
     * the plate PNG is missing from disk, which is how the UI greys a room out
     * instead of offering a placement that would silently fall back to a
     * text-described room.
     */
    rooms: AvatarRoom[];
    presets: AvatarLookPreset[];
    personas: AvatarPersona[];
    totalSpendUsd: number;
  }
>("avatarStatus");

export const avatarEstimate = endpoint<
  { script: string; provider: AvatarProviderId; resolution: AvatarResolution; tts: TtsProviderId; segmentSeconds: number },
  AvatarCostEstimate
>("avatarEstimate");

export const avatarPreviewPortrait = endpoint<
  {
    description?: string;
    aspect?: string;
    model?: string;
    /** Capture medium id. Omit to inherit the preset's, or fall back to the default. */
    mediumId?: string;
    framingId?: string;
    /** Start from a built-in look; `description` overrides it when both are sent. */
    presetId?: string;
    /** Fixed set to generate them into. Overrides mediumId/framingId entirely. */
    roomId?: string;
  },
  { file: string; url: string; mime: string; prompt: string }
>("avatarPreviewPortrait");

export const avatarCreatePersona = endpoint<
  {
    name: string;
    file: string;
    lookPrompt: string;
    scenePrompt: string;
    ttsProvider: TtsProviderId;
    ttsVoice: string;
    /** Basename of the archived voice sample, from avatarCloneVoice. */
    voiceSampleFile?: string;
    /** Room the portrait was made in — every video returns to it. */
    roomId?: string;
  },
  { persona: AvatarPersona }
>("avatarCreatePersona");

/**
 * Build (or rebuild) a persona's 20-view character sheet.
 *
 * The sheet is what lets the SAME face survive a change of room: one portrait
 * shows one angle, so a placement has to invent the rest, and inventing is
 * where a face drifts into someone else.
 */
export const avatarCharacterSheet = endpoint<
  { personaId: string },
  { persona: AvatarPersona; sheetUrl: string }
>("avatarCharacterSheet");

/**
 * Put a saved persona into a room. Returns a PREVIEW in the same shape as
 * avatarPreviewPortrait, so it can be re-rolled and then locked in as its own
 * persona rather than overwriting the one it came from.
 */
export const avatarPlaceInRoom = endpoint<
  { personaId: string; roomId: string },
  { file: string; url: string; mime: string; prompt: string; usedSheet: boolean; roomId: string }
>("avatarPlaceInRoom");

/**
 * Improve an existing roll. `instruction` is plain language ("warmer light",
 * "a little older") — the server composes the edit prompt, most of which is
 * spent forbidding the model from returning a different person.
 */
export const avatarEditPortrait = endpoint<
  { file: string; instruction: string; aspect?: string; mediumId?: string; quality?: string },
  { file: string; url: string; mime: string; prompt: string }
>("avatarEditPortrait");

export interface AvatarVoiceSample {
  file: string;
  url: string;
  createdAt: number;
  bytes: number;
  /** Length of the clip. What you compare voices on — bytes is noise. */
  seconds: number;
  inUse: boolean;
  /** Present for DESIGNED voices — the id that can still be spoken with. */
  voiceId: string | null;
  label: string;
  kind: "designed" | "sample";
}

/**
 * Past voice samples, newest first. Designed voices carry their `voiceId`, so a
 * design survives a refresh as a usable voice rather than just a recording.
 */
export const avatarListVoiceSamples = endpoint<{ limit?: number }, { samples: AvatarVoiceSample[] }>(
  "avatarListVoiceSamples",
);

export const avatarDeleteVoiceSample = endpoint<{ file: string }, { deleted: boolean }>("avatarDeleteVoiceSample");

export interface AvatarPortraitRoll {
  file: string;
  url: string;
  createdAt: number;
  bytes: number;
  /** True when a persona is already built on this face. */
  inUse: boolean;
}

/**
 * Every portrait rolled so far, newest first. Rolls cost money and 90 seconds,
 * so they outlive the page rather than living only in React state.
 */
export const avatarListPortraits = endpoint<{ limit?: number }, { portraits: AvatarPortraitRoll[] }>(
  "avatarListPortraits",
);

export const avatarDeletePortrait = endpoint<{ file: string }, { deleted: boolean }>("avatarDeletePortrait");

/** Roll a candidate voice — the audio equivalent of rolling a portrait. */
export interface AvatarVoiceSettings {
  model: string;
  speed: number;
  stability: number;
  similarityBoost: number;
  style: number;
  speakerBoost: boolean;
}

export const avatarPreviewVoice = endpoint<
  { text?: string; ttsProvider?: TtsProviderId; voice?: string; settings?: Partial<AvatarVoiceSettings> },
  { file: string; url: string; seconds: number; costUsd: number; text: string }
>("avatarPreviewVoice");

/**
 * Design a voice that does not exist yet, from a description. Cloning copies a
 * voice that already exists; this invents one. The clip is archived either way.
 */
export const avatarDesignVoice = endpoint<
  { description: string; text?: string },
  { file: string; url: string; seconds: number; voiceId: string | null }
>("avatarDesignVoice");

/**
 * Clone a voice from a sample and get the id to put on a persona. Pass `file`
 * for a sample this tool generated, or `sampleBase64` for one you recorded.
 * The sample is archived either way — the cloned model cannot be exported, so
 * the clip is the part of the voice you actually own.
 */
export const avatarCloneVoice = endpoint<
  { name: string; file?: string; sampleBase64?: string; sampleMime?: string; description?: string },
  { voiceId: string; sampleFile: string; sampleUrl: string }
>("avatarCloneVoice");

export const avatarUpdatePersona = endpoint<
  { id: string; name?: string; scenePrompt?: string; ttsProvider?: string; ttsVoice?: string },
  { persona: AvatarPersona }
>("avatarUpdatePersona");

export const avatarDeletePersona = endpoint<{ id: string }, { deleted: boolean }>("avatarDeletePersona");

export const avatarStartVideo = endpoint<
  {
    personaId: string;
    title: string;
    script: string;
    provider: AvatarProviderId;
    resolution: AvatarResolution;
    segmentSeconds: number;
    seed?: number;
  },
  { videoId: string }
>("avatarStartVideo");

export const avatarVideoStatus = endpoint<{ videoId: string }, { video: AvatarVideo }>("avatarVideoStatus");
export const avatarListVideos = endpoint<{ limit?: number }, { videos: AvatarVideo[]; totalSpendUsd: number }>("avatarListVideos");
export const avatarCancelVideo = endpoint<{ videoId: string }, { canceled: boolean }>("avatarCancelVideo");

/**
 * Retry a failed render. RESUMES rather than restarts — narration already paid
 * for is reused, and accepted provider jobs keep their ids.
 */
export const avatarRetryVideo = endpoint<{ videoId: string }, { retried: boolean }>("avatarRetryVideo");
export const avatarDeleteVideo = endpoint<{ videoId: string }, { deleted: boolean }>("avatarDeleteVideo");
