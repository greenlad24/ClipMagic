/**
 * The Avatar Narrator endpoints.
 *
 * The web app calls these by name via POST /api/fn/<name> (see routes/fn.ts).
 * Lifted verbatim out of the lab's 6,000-line shared endpoints module — this
 * file is the avatar slice of it and nothing else.
 *
 * The tool's whole value proposition is that it is NOT a text-to-video model:
 * a locked portrait plus TTS driven through an audio-driven lipsync model runs
 * at ~$3.60 per finished minute instead of the ~$28 a Seedance-class model
 * costs, speaks the script verbatim, and keeps one voice and one face across
 * every video. See avatar/types.ts for the cost model behind the estimates.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import * as avatarStore from "../db/avatar.js";
import { listProviders as listAvatarProviders } from "../avatar/providers.js";
import {
  ttsConfigured,
  defaultVoice,
  GEMINI_VOICES,
  cloneVoice,
  designVoice,
  VOICE_AUDITION_TEXT,
  VOICE_SETTINGS,
  ELEVENLABS_MODELS,
  resolveVoiceSettings,
  synthesize as synthesizeNarration,
} from "../avatar/tts.js";
import {
  generatePortrait,
  editPortrait,
  generateCharacterSheet,
  placeInRoom,
  coercePortraitAspect,
  DEFAULT_SCENE_PROMPT,
} from "../avatar/portrait.js";
import { CAPTURE_MEDIUMS, FRAMINGS, LOOK_PRESETS, describeCharacter, findPreset } from "../avatar/look.js";
import { availableRooms } from "../avatar/rooms.js";
import {
  startVideo as startAvatarVideo,
  cancelVideo as cancelAvatarVideo,
  retryVideo as retryAvatarVideo,
} from "../avatar/pipeline.js";
import {
  estimateCost as estimateAvatarCost,
  coerceProvider as coerceAvatarProvider,
  coerceResolution as coerceAvatarResolution,
  coerceTtsProvider,
  TTS_PROVIDER_IDS,
  type TtsProviderId,
} from "../avatar/types.js";

/** A handler takes the POSTed body and returns the JSON response. */
type Handler = (input: any, userId: string) => Promise<any>;

/**
 * A typed error the handlers throw. `code` is mapped to an HTTP status by the
 * dispatcher: NOT_FOUND → 404, NOT_IMPLEMENTED → 501, everything else → 400.
 */
export class ZiteError extends Error {
  code: string;
  constructor(args: { code: string; message: string }) {
    super(args.message);
    this.code = args.code;
    this.name = "ZiteError";
  }
}

// ── Avatar Narrator (LAB tool — synthetic-presenter talking-head videos) ─────
// The tool's whole value proposition is that it is NOT a text-to-video model:
// a locked portrait plus TTS driven through an audio-driven lipsync model runs
// at ~$3.60 per finished minute instead of the ~$28 a Seedance-class model
// costs, speaks the script verbatim, and keeps one voice and one face across
// every video. See avatar/types.ts for the cost model behind the estimates.

/** Configuration + library snapshot the page loads on mount. */
const avatarStatus: Handler = async () => ({
  providers: listAvatarProviders(),
  // Built from the registry rather than listed by hand: a hardcoded pair is how
  // `segmind` came to be missing here, which left the UI showing its own
  // default voice as unavailable and the tool as "not ready" with a working key.
  ttsConfigured: Object.fromEntries(
    TTS_PROVIDER_IDS.map((id) => [id, ttsConfigured(id)]),
  ) as Record<TtsProviderId, boolean>,
  geminiVoices: GEMINI_VOICES,
  // Without a public origin the provider cannot fetch the portrait or the
  // narration, so surface it as a first-class readiness flag rather than
  // letting the first render fail with a confusing provider-side error.
  publicBaseUrlConfigured: !!config.publicBaseUrl,
  defaultScenePrompt: DEFAULT_SCENE_PROMPT,
  auditionText: VOICE_AUDITION_TEXT,
  voiceSettings: VOICE_SETTINGS,
  voiceModels: ELEVENLABS_MODELS,
  // The look layer: how the footage is captured, and two complete starting
  // characters. Naming a medium is the biggest realism lever the tool has, so
  // the UI offers it rather than leaving the model to guess.
  mediums: CAPTURE_MEDIUMS.map((m) => ({ id: m.id, label: m.label, hint: m.hint })),
  framings: FRAMINGS.map((f) => ({ id: f.id, label: f.label, hint: f.hint })),
  // The fixed sets. `ready` is false when the plate file is missing, which is
  // the difference between "pick this room" and "this room needs making".
  rooms: availableRooms().map((r) => ({ id: r.id, label: r.label, hint: r.hint, ready: r.ready })),
  presets: LOOK_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    hint: p.hint,
    mediumId: p.mediumId,
    voice: p.voice,
    description: describeCharacter(p.character),
  })),
  personas: avatarStore.listPersonas(),
  totalSpendUsd: avatarStore.totalSpendUsd(),
});

/** Pre-flight cost + duration estimate. Pure arithmetic — spends nothing. */
const avatarEstimate: Handler = async (input) => {
  const script = String(input?.script ?? "");
  return estimateAvatarCost({
    script,
    provider: coerceAvatarProvider(input?.provider),
    resolution: coerceAvatarResolution(input?.resolution),
    tts: coerceTtsProvider(input?.tts),
    segmentSeconds: Number.isFinite(Number(input?.segmentSeconds)) ? Number(input.segmentSeconds) : 0,
  });
};

/**
 * Generate a candidate portrait WITHOUT saving a persona. The portrait is the
 * one input that decides whether the finished video reads as a real person, so
 * the flow is deliberately "roll until you like it, then lock it in" rather
 * than committing the first result.
 */
const avatarPreviewPortrait: Handler = async (input) => {
  // A preset supplies both the character and the medium it was designed for, so
  // "use the explainer" is one click rather than a paragraph of typing. Anything
  // the caller states explicitly still wins over the preset.
  const preset = findPreset(input?.presetId ? String(input.presetId) : undefined);
  const description = String(input?.description ?? "").trim() || (preset ? describeCharacter(preset.character) : "");
  if (!description) throw new ZiteError({ code: "BAD_REQUEST", message: "Describe the presenter first." });
  const portrait = await generatePortrait({
    description,
    aspect: coercePortraitAspect(input?.aspect),
    model: input?.model === "flash" || input?.model === "flash-31" ? input.model : "pro",
    mediumId: String(input?.mediumId ?? preset?.mediumId ?? ""),
    framingId: String(input?.framingId ?? ""),
    // A room plate overrides the medium/framing entirely and forces Nano
    // Banana, because the plate has to ride along as an inline reference.
    roomId: String(input?.roomId ?? ""),
    engine: input?.engine === "nanobanana" ? "nanobanana" : "gptimage2",
    // Cheap rolls while hunting a face, full quality for the one that is kept.
    quality: input?.quality === "low" || input?.quality === "medium" ? input.quality : "high",
  });
  return {
    file: path.basename(portrait.file),
    url: `/api/avatar/${encodeURIComponent(path.basename(portrait.file))}`,
    mime: portrait.mime,
    prompt: portrait.prompt,
  };
};

/**
 * Produce a candidate VOICE sample — the audio equivalent of rolling a
 * portrait. Saved to the avatar library so it can be listened to, re-rolled,
 * and then cloned; the file that gets cloned is the one that gets archived on
 * the persona.
 */
const avatarPreviewVoice: Handler = async (input) => {
  // Default to the full audition paragraph, not a one-liner: a voice you will
  // listen to for forty minutes cannot be judged on eight words.
  const text = String(input?.text ?? "").trim() || VOICE_AUDITION_TEXT;
  const provider = coerceTtsProvider(input?.ttsProvider);
  const voice = String(input?.voice ?? "").trim() || defaultVoice(provider);

  fs.mkdirSync(config.avatarDir, { recursive: true });
  const file = path.join(config.avatarDir, `voice-${crypto.randomBytes(8).toString("hex")}.mp3`);
  const settings = resolveVoiceSettings(input?.settings as any);
  const result = await synthesizeNarration({ script: text, provider, voice, outFile: file, settings });
  writeVoiceSidecar(file, { voice, provider, text, seconds: result.seconds, settings, description: `Preset voice: ${voice}` });

  return {
    file: path.basename(file),
    url: `/api/avatar/${encodeURIComponent(path.basename(file))}`,
    seconds: result.seconds,
    costUsd: result.costUsd,
    text,
  };
};

/**
 * Design a voice that has never existed, from a description.
 *
 * This is what "a voice nobody else is using" actually requires — cloning only
 * ever copies something that already exists. The designed clip is archived like
 * any other sample, so it can then be cloned into a persistent voice id while
 * the audio stays ours.
 */
const avatarDesignVoice: Handler = async (input) => {
  const description = String(input?.description ?? "").trim();
  if (!description) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Describe the voice you want — age, gender, accent, pace, texture." });
  }
  fs.mkdirSync(config.avatarDir, { recursive: true });
  const file = path.join(config.avatarDir, `voice-${crypto.randomBytes(8).toString("hex")}.mp3`);
  const res = await designVoice({ description, text: String(input?.text ?? "") || undefined, outFile: file });
  // The voice id appears exactly once, here. Persist it beside the audio or a
  // refresh loses the voice, not just the clip.
  writeVoiceSidecar(file, { voiceId: res.voiceId, description, provider: "segmind", seconds: res.seconds });
  return {
    file: path.basename(file),
    url: `/api/avatar/${encodeURIComponent(path.basename(file))}`,
    seconds: res.seconds,
    voiceId: res.voiceId,
  };
};

/**
 * Clone a voice from a sample and hand back the id to put on a persona.
 *
 * The sample is either one this tool generated (`file`) or one the operator
 * uploaded (`sampleBase64`) — a recording of their own voice, say. Both land in
 * the avatar library first, because the ARCHIVED CLIP is the durable asset: the
 * cloned model itself lives inside ElevenLabs and cannot be exported, so losing
 * the sample means the voice is only ever rentable from one vendor.
 */
const avatarCloneVoice: Handler = async (input) => {
  const name = String(input?.name ?? "").trim();
  if (!name) throw new ZiteError({ code: "BAD_REQUEST", message: "Name the voice so you can find it later." });

  let sampleFile: string;
  if (input?.sampleBase64) {
    const raw = String(input.sampleBase64).replace(/^data:[^;]+;base64,/, "");
    const bytes = Buffer.from(raw, "base64");
    if (!bytes.length) throw new ZiteError({ code: "BAD_REQUEST", message: "That audio file is empty." });
    fs.mkdirSync(config.avatarDir, { recursive: true });
    const ext = String(input?.sampleMime ?? "").includes("wav") ? "wav" : "mp3";
    sampleFile = path.join(config.avatarDir, `voice-${crypto.randomBytes(8).toString("hex")}.${ext}`);
    fs.writeFileSync(sampleFile, bytes);
  } else {
    // A basename inside avatarDir, never a path — same rule as the portrait.
    const base = path.basename(String(input?.file ?? ""));
    sampleFile = path.join(config.avatarDir, base);
    if (!base || !fs.existsSync(sampleFile)) {
      throw new ZiteError({ code: "BAD_REQUEST", message: "That voice sample is no longer available — generate a new one." });
    }
  }

  const { voiceId } = await cloneVoice({ sampleFile, name, description: String(input?.description ?? "") || undefined });
  return {
    voiceId,
    sampleFile: path.basename(sampleFile),
    sampleUrl: `/api/avatar/${encodeURIComponent(path.basename(sampleFile))}`,
  };
};

/**
 * A voice sample's sidecar: what it is, and — critically — the voice id it
 * belongs to.
 *
 * The audio alone is not enough. A DESIGNED voice exists on the account under
 * an id that appears exactly once, in the response that created it; lose that
 * and the clip is just a recording of a voice you can no longer speak with.
 * The sidecar is what makes a past design still usable after a refresh.
 */
function writeVoiceSidecar(file: string, meta: Record<string, unknown>): void {
  try {
    fs.writeFileSync(`${file}.json`, JSON.stringify({ ...meta, createdAt: Date.now() }, null, 2));
  } catch {
    /* the sample is still usable without it — never fail a paid call over this */
  }
}

function readVoiceSidecar(file: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(`${file}.json`, "utf8"));
  } catch {
    return {};
  }
}

/** Every voice sample generated or designed so far, newest first. */
const avatarListVoiceSamples: Handler = async (input) => {
  const limit = Number.isFinite(Number(input?.limit)) ? Math.max(1, Number(input.limit)) : 40;
  if (!fs.existsSync(config.avatarDir)) return { samples: [] };

  const locked = new Set(
    avatarStore.listPersonas().map((p) => path.basename(p.voiceSampleFile || "")).filter(Boolean),
  );

  const samples = fs
    .readdirSync(config.avatarDir)
    .filter((f) => /^voice-[a-f0-9]+\.(mp3|wav)$/i.test(f))
    .map((f) => {
      const full = path.join(config.avatarDir, f);
      const stat = fs.statSync(full);
      const meta = readVoiceSidecar(full);
      return {
        file: f,
        url: `/api/avatar/${encodeURIComponent(f)}`,
        createdAt: meta.createdAt ?? stat.mtimeMs,
        bytes: stat.size,
        inUse: locked.has(f),
        // Length is what you actually compare voices on; bytes is noise.
        seconds: Number(meta.seconds ?? 0),
        voiceId: meta.voiceId ?? null,
        label: String(meta.description ?? meta.voice ?? "Voice sample"),
        kind: meta.voiceId ? "designed" : "sample",
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  return { samples };
};

const avatarDeleteVoiceSample: Handler = async (input) => {
  const base = path.basename(String(input?.file ?? ""));
  if (!/^voice-[a-f0-9]+\.(mp3|wav)$/i.test(base)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That is not a voice sample." });
  }
  if (avatarStore.listPersonas().some((p) => path.basename(p.voiceSampleFile || "") === base)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That sample belongs to a persona — delete the persona instead." });
  }
  fs.rmSync(path.join(config.avatarDir, base), { force: true });
  fs.rmSync(path.join(config.avatarDir, `${base}.json`), { force: true });
  return { deleted: true };
};

/**
 * Every portrait rolled so far, newest first.
 *
 * A roll costs real money and ninety seconds, and until now it existed only in
 * React state — a refresh threw away a face the operator had paid for and might
 * have wanted. The files were on disk the whole time; nothing was listing them.
 *
 * `inUse` marks the ones already locked into a persona so they are not offered
 * as if they were spare candidates.
 */
const avatarListPortraits: Handler = async (input) => {
  const limit = Number.isFinite(Number(input?.limit)) ? Math.max(1, Number(input.limit)) : 40;
  if (!fs.existsSync(config.avatarDir)) return { portraits: [] };

  const locked = new Set(avatarStore.listPersonas().map((p) => path.basename(p.portraitFile)));

  const portraits = fs
    .readdirSync(config.avatarDir)
    .filter((f) => /^persona-[a-f0-9]+\.(png|jpg|jpeg|webp)$/i.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(config.avatarDir, f));
      return {
        file: f,
        url: `/api/avatar/${encodeURIComponent(f)}`,
        createdAt: stat.mtimeMs,
        bytes: stat.size,
        inUse: locked.has(f),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  return { portraits };
};

/** Throw away a roll that is not locked into a persona. */
const avatarDeletePortrait: Handler = async (input) => {
  const base = path.basename(String(input?.file ?? ""));
  if (!/^persona-[a-f0-9]+\.(png|jpg|jpeg|webp)$/i.test(base)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That is not a portrait roll." });
  }
  // Refuse to delete a face a persona is still built on — the persona would be
  // left pointing at nothing and every future render would fail.
  if (avatarStore.listPersonas().some((p) => path.basename(p.portraitFile) === base)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That portrait belongs to a persona — delete the persona instead." });
  }
  fs.rmSync(path.join(config.avatarDir, base), { force: true });
  return { deleted: true };
};

/**
 * Improve a portrait you already like, instead of rolling the dice again.
 *
 * The operator says what they want changed in plain words; `buildEditPrompt`
 * turns that into an instruction that changes only that and defends the
 * identity of the face. The result is saved as a NEW roll, so the original
 * survives in the gallery and a bad edit costs one call, not a persona.
 */
const avatarEditPortrait: Handler = async (input) => {
  const instruction = String(input?.instruction ?? "").trim();
  if (!instruction) throw new ZiteError({ code: "BAD_REQUEST", message: "Say what you want changed." });

  const base = path.basename(String(input?.file ?? ""));
  const sourceFile = path.join(config.avatarDir, base);
  if (!base || !fs.existsSync(sourceFile)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That portrait is no longer available — pick another roll." });
  }

  const portrait = await editPortrait({
    sourceFile,
    instruction,
    aspect: coercePortraitAspect(input?.aspect),
    mediumId: String(input?.mediumId ?? ""),
    quality: input?.quality === "low" || input?.quality === "medium" ? input.quality : "high",
  });
  return {
    file: path.basename(portrait.file),
    url: `/api/avatar/${encodeURIComponent(path.basename(portrait.file))}`,
    mime: portrait.mime,
    prompt: portrait.prompt,
  };
};


// ── Persona → character sheet → any room ─────────────────────────────────────
// The point of the pair: a persona is ONE photograph, so putting them in a new
// room means inventing every angle the photograph does not show — and inventing
// is where a face drifts into someone else. The sheet turns "imagine this person
// from another angle" into "copy the one you were shown".

/** Build (or rebuild) the twenty-view sheet for a saved persona. */
const avatarCharacterSheet: Handler = async (input) => {
  const personaId = String(input?.personaId ?? "").trim();
  const persona = personaId ? avatarStore.getPersona(personaId) : null;
  if (!persona) throw new ZiteError({ code: "BAD_REQUEST", message: "Pick a persona first." });
  try {
    const sheet = await generateCharacterSheet({ sourceFile: persona.portraitFile });
    // Replace rather than accumulate: one persona has one current sheet, and
    // the old file is dead weight the moment a new one exists.
    if (persona.sheetFile && persona.sheetFile !== sheet.file) {
      try { fs.rmSync(persona.sheetFile, { force: true }); } catch { /* already gone */ }
    }
    avatarStore.setPersonaSheet(persona.id, sheet.file);
    return { persona: avatarStore.getPersona(persona.id), sheetUrl: `/api/avatar/${encodeURIComponent(path.basename(sheet.file))}` };
  } catch (e) {
    throw new ZiteError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
  }
};

/**
 * Put a saved persona into a room — returns a PREVIEW, not a persona.
 *
 * Deliberately the same shape avatarPreviewPortrait returns, so a placement
 * drops into the existing roll-until-you-like-it flow and can be locked in as a
 * new persona. The alternative — mutating the persona's portrait in place —
 * would mean changing room destroys the version that worked.
 */
const avatarPlaceInRoom: Handler = async (input) => {
  const personaId = String(input?.personaId ?? "").trim();
  const roomId = String(input?.roomId ?? "").trim();
  const persona = personaId ? avatarStore.getPersona(personaId) : null;
  if (!persona) throw new ZiteError({ code: "BAD_REQUEST", message: "Pick a persona first." });
  if (!roomId) throw new ZiteError({ code: "BAD_REQUEST", message: "Pick a room to put them in." });
  try {
    const placed = await placeInRoom({
      sheetFile: persona.sheetFile || null,
      portraitFile: persona.portraitFile,
      roomId,
    });
    return {
      file: path.basename(placed.file),
      url: `/api/avatar/${encodeURIComponent(path.basename(placed.file))}`,
      mime: placed.mime,
      prompt: placed.prompt,
      // Surfaced so the UI can say "made from the sheet" vs "made from the one
      // portrait" — the difference decides how much the face is likely to drift.
      usedSheet: placed.usedSheet,
      roomId,
    };
  } catch (e) {
    throw new ZiteError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
  }
};

/** Lock a previewed portrait in as a reusable persona. */
const avatarCreatePersona: Handler = async (input) => {
  const name = String(input?.name ?? "").trim();
  const file = String(input?.file ?? "").trim();
  if (!name) throw new ZiteError({ code: "BAD_REQUEST", message: "Give the persona a name." });
  if (!file) throw new ZiteError({ code: "BAD_REQUEST", message: "Generate a portrait first." });

  // `file` comes from the browser, so it is only ever a basename inside
  // avatarDir — never a path. Anything else is rejected rather than resolved.
  const base = path.basename(file);
  const portraitFile = path.join(config.avatarDir, base);
  if (base !== file || !fs.existsSync(portraitFile)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That portrait is no longer available — generate a new one." });
  }

  const ttsProvider = coerceTtsProvider(input?.ttsProvider);
  return {
    persona: avatarStore.createPersona({
      name,
      lookPrompt: String(input?.lookPrompt ?? ""),
      // Kept on the persona so every future video returns to the same room.
      roomId: String(input?.roomId ?? ""),
      scenePrompt: String(input?.scenePrompt ?? "").trim() || DEFAULT_SCENE_PROMPT,
      portraitFile,
      portraitMime: base.endsWith(".jpg") ? "image/jpeg" : "image/png",
      ttsProvider,
      ttsVoice: String(input?.ttsVoice ?? "").trim() || defaultVoice(ttsProvider),
      // The clip the voice was cloned from. Stored on the persona so the voice
      // can be re-created elsewhere later — the cloned model itself is not ours.
      voiceSampleFile: input?.voiceSampleFile
        ? path.join(config.avatarDir, path.basename(String(input.voiceSampleFile)))
        : "",
    }),
  };
};

const avatarUpdatePersona: Handler = async (input) => {
  const id = String(input?.id ?? "");
  const persona = avatarStore.updatePersona(id, {
    name: input?.name !== undefined ? String(input.name).trim() : undefined,
    scenePrompt: input?.scenePrompt !== undefined ? String(input.scenePrompt) : undefined,
    ttsProvider: input?.ttsProvider !== undefined ? String(input.ttsProvider) : undefined,
    ttsVoice: input?.ttsVoice !== undefined ? String(input.ttsVoice) : undefined,
  });
  if (!persona) throw new ZiteError({ code: "NOT_FOUND", message: "Persona not found." });
  return { persona };
};

/** Deletes the persona AND every video made from it — the UI must confirm. */
const avatarDeletePersona: Handler = async (input) => ({
  deleted: avatarStore.deletePersona(String(input?.id ?? "")),
});

/** Start a render. Returns immediately; the UI polls avatarVideoStatus. */
const avatarStartVideo: Handler = async (input) => {
  const segRaw = Number(input?.segmentSeconds);
  try {
    const id = startAvatarVideo({
      personaId: String(input?.personaId ?? ""),
      title: String(input?.title ?? "").trim(),
      script: String(input?.script ?? ""),
      provider: coerceAvatarProvider(input?.provider),
      resolution: coerceAvatarResolution(input?.resolution),
      segmentSeconds: Number.isFinite(segRaw) && segRaw > 0 ? Math.floor(segRaw) : 0,
      seed: Number.isFinite(Number(input?.seed)) ? Number(input.seed) : undefined,
    });
    return { videoId: id };
  } catch (e: any) {
    // Everything startVideo throws is a precondition the operator can fix
    // (missing key, no persona, empty script) — surface it as BAD_REQUEST so
    // the UI shows the message instead of a generic failure.
    throw new ZiteError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
  }
};

const avatarVideoStatus: Handler = async (input) => {
  const video = avatarStore.getVideo(String(input?.videoId ?? ""));
  if (!video) throw new ZiteError({ code: "NOT_FOUND", message: "Render not found." });
  return { video };
};

const avatarListVideos: Handler = async (input) => ({
  videos: avatarStore.listVideos(Number.isFinite(Number(input?.limit)) ? Number(input.limit) : 100),
  totalSpendUsd: avatarStore.totalSpendUsd(),
});

/**
 * Retry a failed render. Resumes: the narration already paid for is reused and
 * segments that were accepted keep their provider task ids, so a run that died
 * on an out-of-credit error costs nothing extra to finish.
 */
const avatarRetryVideo: Handler = async (input) => {
  const id = String(input?.videoId ?? "");
  if (!retryAvatarVideo(id)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That render is not in a state that can be retried." });
  }
  return { retried: true };
};

const avatarCancelVideo: Handler = async (input) => ({
  canceled: cancelAvatarVideo(String(input?.videoId ?? "")),
});

const avatarDeleteVideo: Handler = async (input) => ({
  deleted: avatarStore.deleteVideo(String(input?.videoId ?? "")),
});

export const HANDLERS: Record<string, Handler> = {
  avatarStatus,
  avatarEstimate,
  avatarPreviewPortrait,
  avatarEditPortrait,
  avatarPreviewVoice,
  avatarDesignVoice,
  avatarCloneVoice,
  avatarListPortraits,
  avatarListVoiceSamples,
  avatarDeleteVoiceSample,
  avatarDeletePortrait,
  avatarCharacterSheet,
  avatarPlaceInRoom,
  avatarCreatePersona,
  avatarUpdatePersona,
  avatarDeletePersona,
  avatarStartVideo,
  avatarVideoStatus,
  avatarListVideos,
  avatarCancelVideo,
  avatarRetryVideo,
  avatarDeleteVideo,
};
