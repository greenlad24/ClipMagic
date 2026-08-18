/**
 * The sticker SOUND EFFECT for the Meme/Sticker editor.
 *
 * A quiet pop under each sticker as it slaps on. Two halves live here: making
 * the sound, and mixing it into the composite at the right instants.
 *
 * THREE SOUNDS CAN BE IN FORCE, most specific first: `MEME_SFX_PATH` (a
 * server-side pin), the sound the user UPLOADED on the Sticker page, then the
 * built-in default. Whichever it is, it is conformed to 48kHz stereo and
 * normalised to the same peak, so the volume dial means one thing throughout.
 *
 * AN UPLOAD CAN BE RE-SPED. The audio as it arrived is kept alongside the
 * conformed copy, so changing the rate re-derives from the original instead of
 * re-processing what is already playing — rates stay absolute rather than
 * compounding, and the trim/fade/normalise treatment is identical either way.
 *
 * THE DEFAULT IS SYNTHESISED, NOT SHIPPED. There is no audio asset in this repo
 * and no licence to worry about — the slap is generated once by ffmpeg from an
 * expression and cached on disk forever after. See SFX_EXPRESSION for how it is
 * built, and why an earlier descending-chirp version read as cheap.
 *
 * IT MUST STAY UNDER THE NARRATION. The default gain is 0.18 linear (≈ −15dB),
 * which puts the peak around −18dBFS against narration loudness-normalised to
 * −14 LUFS. It reads as an accent, never as a competing sound. `MEME_SFX_VOLUME`
 * tunes it and `MEME_SFX=off` disables it outright.
 *
 * THE MIX DETAIL THAT MATTERS: the pops are mixed with `amix` at `normalize=0`
 * AND `dropout_transition=0`. Without the first, amix would divide every input's
 * level by the input count and duck the narration. Without the second, amix
 * ramps its gain back up over 2 seconds each time a short input ENDS — so every
 * pop would be followed by two seconds of the narration swelling. Both are
 * silent, plausible-sounding bugs, hence this note.
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { probe } from "../render/ffmpeg.js";

/** Linear gain for the pop in the final mix — an accent, not a sound cue. */
export const DEFAULT_SFX_VOLUME = 0.18;

/** Length of the generated slap, seconds (short so it never smears a word). */
export const SFX_DURATION_SECONDS = 0.35;

/**
 * The ffmpeg `aevalsrc` expression for the built-in slap. Three summed layers,
 * which is how a real slap is actually built:
 *   • crack — broadband noise decaying at e^-42t: the contact itself. This is
 *     the layer the ORIGINAL sound was missing, and the reason it read as a
 *     cheap 8-bit "boop" rather than as something hitting a surface.
 *   • body  — a 165Hz tone at e^-30t, the weight behind the hand.
 *   • tick  — a second noise burst gone in ~15ms, sharpening the attack edge.
 * `random(0)` and `random(1)` draw from separate noise streams so the two bursts
 * are genuinely uncorrelated.
 */
export const SFX_EXPRESSION =
  "0.95*(2*random(0)-1)*exp(-42*t)+0.55*sin(2*PI*165*t)*exp(-30*t)+0.3*(2*random(1)-1)*exp(-260*t)";

/**
 * Tone-shaping applied to the raw expression (trailing comma — it is spliced
 * into a filter chain). The presence lift at 3.2kHz is what makes the crack
 * read as contact, and the short `aecho` is a few milliseconds of ROOM: without
 * it a synthesised impact sounds like a synthesiser, with it it sounds recorded.
 */
export const SFX_FILTERS =
  "highpass=f=120,equalizer=f=3200:width_type=o:width=1.6:g=5,lowpass=f=11000," +
  "aecho=0.9:0.35:7|17:0.22|0.1,";

/** Is the sticker sound effect switched on? (`MEME_SFX=off` turns it off.) */
export function sfxEnabled(): boolean {
  return (process.env.MEME_SFX || "on").toLowerCase() !== "off";
}

/**
 * The mix gain, clamped to a sane range. Pure so the "quiet by default, and
 * never loud enough to fight the narration" promise is unit-testable.
 */
export function sfxVolume(raw = process.env.MEME_SFX_VOLUME): number {
  const v = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(v) || v < 0) return DEFAULT_SFX_VOLUME;
  // A hard ceiling of 0.6: above that the pop starts masking speech, which is
  // never what "a sound effect when it shows" is asking for.
  return Math.min(0.6, v);
}

/**
 * Sound files live under OUTPUTS (not the private data dir) so the Sticker page
 * can preview them over /api/outputs — hearing the sound before a render is the
 * whole point of letting someone choose one.
 */
function sfxDir(): string {
  const dir = path.join(config.outputsDir, "sfx");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
/** The generated default. */
function sfxPath(): string {
  return path.join(sfxDir(), "sticker-pop.wav");
}
/** The user's own uploaded sound, conformed to the mix (see installCustomSfx). */
function customSfxPath(): string {
  return path.join(sfxDir(), "custom.wav");
}
/** What the uploaded sound was called + when, for the UI. */
function customMetaPath(): string {
  return path.join(config.dataDir, "meme-sfx.json");
}
/**
 * The uploaded audio as it arrived, kept so SPEED can be changed later without
 * asking for the file again. It lives in the private data dir rather than under
 * outputs because nothing ever plays it: the page previews the conformed sound,
 * and a file in outputs is fair game for the storage manager to sweep up.
 */
function customSourcePath(): string {
  return path.join(config.dataDir, "meme-sfx-source.wav");
}

function ffmpegRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${tail}`)),
    );
  });
}

/** Run ffmpeg and return its stderr (where the analysis filters report). */
function ffmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let out = "";
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

// ── The user's own sound ─────────────────────────────────────────────────────

/** Longest an uploaded sound may play — beyond this it smears over the edit. */
export const MAX_CUSTOM_SECONDS = 2.0;
/** Every sound, generated or uploaded, is normalised to this peak. */
export const TARGET_PEAK_DBFS = -3;

/**
 * How much of the upload is kept as the re-speedable source. Generous, because
 * a slow-down needs headroom the conformed 2s copy would not have — but bounded,
 * because someone will eventually hand this a feature film.
 */
export const MAX_SOURCE_SECONDS = 12;
/** Playback rates the sound may be set to. Below 0.5 it drags, above 3 it ticks. */
export const MIN_SFX_SPEED = 0.5;
export const MAX_SFX_SPEED = 3;
export const DEFAULT_SFX_SPEED = 1;

/** Coerce anything the client sends into a rate we will actually run. */
export function clampSpeed(raw: unknown): number {
  const v = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_SFX_SPEED;
  return Math.min(MAX_SFX_SPEED, Math.max(MIN_SFX_SPEED, Number(v.toFixed(3))));
}

/**
 * The `atempo` chain for a rate.
 *
 * atempo changes TEMPO WITHOUT PITCH — the sound gets tighter and snappier but
 * keeps the timbre that made it worth choosing. (A tape-style speed-up, which
 * also raises pitch, would be `asetrate`; it turns a slap into a click.)
 *
 * One instance is only reliable across ffmpeg builds within 0.5–2.0, so a rate
 * outside that is split into equal factors — two at √r — rather than trusting a
 * newer ffmpeg's wider range.
 */
export function atempoChain(speed: number): string {
  const r = clampSpeed(speed);
  if (Math.abs(r - 1) < 0.001) return "";
  if (r <= 2) return `atempo=${r.toFixed(3)}`;
  const each = Math.sqrt(r);
  return `atempo=${each.toFixed(3)},atempo=${each.toFixed(3)}`;
}

export interface CustomSfxMeta {
  /** The file the user chose, for display. */
  name: string;
  /** When it was installed (epoch ms). */
  uploadedAt: number;
  /** Length after conforming, seconds. */
  seconds: number;
  /** True when the upload was longer than MAX_CUSTOM_SECONDS and got trimmed. */
  trimmed: boolean;
  /** Playback rate in force, 1 = as uploaded. */
  speed: number;
  /** Length of the retained source, seconds — what speed is applied to. */
  sourceSeconds: number;
}

function readCustomMeta(): CustomSfxMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(customMetaPath(), "utf8"));
    if (raw && typeof raw.name === "string") {
      // Sounds installed before speed existed have no `speed` — they are 1×.
      return {
        ...raw,
        speed: clampSpeed(raw.speed ?? DEFAULT_SFX_SPEED),
        sourceSeconds: Number(raw.sourceSeconds ?? raw.seconds ?? 0),
      } as CustomSfxMeta;
    }
  } catch {
    /* no meta = no custom sound */
  }
  return null;
}

/** True peak of an audio file in dBFS, read from astats (0 for an unreadable file). */
async function truePeakDbfs(file: string): Promise<number> {
  // NOT volumedetect: its histogram tops out at 0 dB, so a float file that peaks
  // above full scale reads as exactly 0.0 and normalises to a clipped result.
  const err = await ffmpegStderr([
    "-hide_banner", "-i", file,
    "-af", "astats=measure_perchannel=none:measure_overall=Peak_level",
    "-f", "null", "-",
  ]);
  const m = /Peak level dB:\s*(-?[\d.]+)/.exec(err);
  return m ? Number.parseFloat(m[1]) : 0;
}

/**
 * Install an uploaded sound as THE sticker sound.
 *
 * The upload is CONFORMED rather than used as-is, because the mix downstream is
 * unforgiving: `amix` needs a matching sample rate and channel layout, and the
 * `MEME_SFX_VOLUME` dial is only meaningful if every sound starts from the same
 * level. So we re-encode to 48kHz stereo, trim to MAX_CUSTOM_SECONDS with a
 * short fade so a trim can't click, and normalise the peak to TARGET_PEAK_DBFS —
 * the same treatment the generated pop gets. A video file is fine as a source;
 * its audio track is taken.
 *
 * Throws (with a message meant for the user) when the file has no audio.
 */
export async function installCustomSfx(
  sourceFile: string,
  displayName: string,
  speed: unknown = DEFAULT_SFX_SPEED,
): Promise<CustomSfxMeta> {
  const meta = await probe(sourceFile);
  if (!meta.hasAudio) {
    throw new Error("That file has no audio track — pick a sound file (or a video with sound).");
  }

  // Keep the audio as it arrived (48kHz stereo, but untrimmed, unfaded and at
  // its own level) so the rate can be changed later without another upload.
  // FLOAT, because normalising a quiet source later would also amplify the
  // quantisation noise a 16-bit intermediate would have added.
  fs.mkdirSync(path.dirname(customSourcePath()), { recursive: true });
  await ffmpegRun([
    "-y", "-v", "error",
    "-i", sourceFile,
    "-vn",
    "-t", String(MAX_SOURCE_SECONDS),
    "-af", "aformat=channel_layouts=stereo:sample_fmts=fltp",
    "-ar", "48000",
    "-c:a", "pcm_f32le",
    customSourcePath(),
  ]);

  const sourceSeconds = Math.min(meta.duration || MAX_SOURCE_SECONDS, MAX_SOURCE_SECONDS);
  return conformCustomSfx({
    displayName: displayName.slice(0, 120),
    speed: clampSpeed(speed),
    sourceSeconds,
    uploadedAt: Date.now(),
  });
}

/**
 * Render the stored source into the sound the mix actually uses, at a rate.
 *
 * Everything that makes an upload safe to mix happens here: the speed change,
 * the trim, the anti-click fade and the peak normalisation. Splitting it out of
 * installCustomSfx is what lets the rate change without a re-upload — and it
 * means a re-speed gets the identical treatment a fresh upload does, rather than
 * compounding processing on an already-conformed file.
 */
async function conformCustomSfx(opts: {
  displayName: string;
  speed: number;
  sourceSeconds: number;
  uploadedAt: number;
}): Promise<CustomSfxMeta> {
  const speed = clampSpeed(opts.speed);
  const tempo = atempoChain(speed);

  // Speed is applied FIRST, so the trim bounds what will actually be heard:
  // 3 seconds at 1.5× is 2 seconds of output and needs no trim at all.
  const spedSeconds = opts.sourceSeconds / speed;
  const seconds = Math.min(spedSeconds || MAX_CUSTOM_SECONDS, MAX_CUSTOM_SECONDS);
  const fadeAt = Math.max(0, seconds - 0.03);

  const workFile = path.join(config.tmpDir, `sfx_in_${Date.now()}.wav`);
  fs.mkdirSync(config.tmpDir, { recursive: true });
  try {
    // Pass 1 — conform, in FLOAT so nothing clips before we have measured it.
    await ffmpegRun([
      "-y", "-v", "error",
      "-i", customSourcePath(),
      "-vn",
      "-t", seconds.toFixed(3),
      "-af",
      [
        tempo,
        "aformat=channel_layouts=stereo:sample_fmts=fltp",
        `afade=t=out:st=${fadeAt.toFixed(3)}:d=0.03`,
      ].filter(Boolean).join(","),
      "-ar", "48000",
      "-c:a", "pcm_f32le",
      workFile,
    ]);

    // Pass 2 — bring the peak to the house level and write the real file.
    const peak = await truePeakDbfs(workFile);
    const gain = TARGET_PEAK_DBFS - peak;
    await ffmpegRun([
      "-y", "-v", "error",
      "-i", workFile,
      "-af", `volume=${gain.toFixed(2)}dB`,
      "-ar", "48000",
      "-c:a", "pcm_s16le",
      customSfxPath(),
    ]);

    const installed: CustomSfxMeta = {
      name: opts.displayName,
      uploadedAt: opts.uploadedAt,
      seconds: Number(seconds.toFixed(3)),
      trimmed: spedSeconds > MAX_CUSTOM_SECONDS + 0.01,
      speed,
      sourceSeconds: Number(opts.sourceSeconds.toFixed(3)),
    };
    fs.writeFileSync(customMetaPath(), JSON.stringify(installed, null, 2));
    console.log(
      `[meme] sticker sound set to "${installed.name}" ` +
        `(${installed.seconds}s${installed.trimmed ? ", trimmed" : ""}` +
        `${speed !== 1 ? `, ${speed}× speed` : ""}, ` +
        `${gain.toFixed(1)}dB to reach ${TARGET_PEAK_DBFS}dBFS)`,
    );
    return installed;
  } finally {
    fs.rm(workFile, { force: true }, () => {});
  }
}

/**
 * Change how fast the uploaded sound plays, without asking for the file again.
 *
 * Re-derives from the retained source, so rates do not compound: going 1.5× then
 * 2× gives 2× of the original, not 3×.
 */
export async function setCustomSfxSpeed(rawSpeed: unknown): Promise<CustomSfxMeta> {
  const meta = readCustomMeta();
  if (!meta) throw new Error("There is no uploaded sound to speed up — upload one first.");

  // A sound installed before the source was retained still has its conformed
  // copy. Promote that to be the source: it is the only original we have, and
  // from then on rate changes are non-destructive like any other.
  if (!fs.existsSync(customSourcePath())) {
    if (!fs.existsSync(customSfxPath())) {
      throw new Error("That sound is no longer on disk — upload it again.");
    }
    await ffmpegRun([
      "-y", "-v", "error",
      "-i", customSfxPath(),
      "-af", "aformat=channel_layouts=stereo:sample_fmts=fltp",
      "-ar", "48000",
      "-c:a", "pcm_f32le",
      customSourcePath(),
    ]);
    // The conformed copy is at the CURRENT rate, so it is the new 1× baseline.
    meta.sourceSeconds = meta.seconds;
    meta.speed = DEFAULT_SFX_SPEED;
    console.log("[meme] promoted the conformed sticker sound to be its own source");
  }

  // The source is always the 1× baseline, so the rate is absolute: asking for
  // 1.5× after 2× gives 1.5× of the upload, not 3×.
  return conformCustomSfx({
    displayName: meta.name,
    speed: clampSpeed(rawSpeed),
    sourceSeconds: meta.sourceSeconds || meta.seconds,
    uploadedAt: meta.uploadedAt,
  });
}

/** Drop the uploaded sound and go back to the generated pop. */
export function clearCustomSfx(): void {
  fs.rm(customSfxPath(), { force: true }, () => {});
  fs.rm(customMetaPath(), { force: true }, () => {});
  fs.rm(customSourcePath(), { force: true }, () => {});
  console.log("[meme] sticker sound reset to the generated default");
}

export interface StickerSoundState {
  /** "custom" when the user uploaded one, else the generated pop. */
  mode: "default" | "custom" | "env";
  /** Display name of the current sound. */
  name: string;
  /** URL the page can play to preview it, or null if it isn't generated yet. */
  previewUrl: string | null;
  /** The mix gain in force (MEME_SFX_VOLUME). */
  volume: number;
  /** False when MEME_SFX=off — no sound is mixed at all. */
  enabled: boolean;
  /** Details of the uploaded sound, when there is one. */
  custom: CustomSfxMeta | null;
  /** Longest an upload may be before it's trimmed, seconds. */
  maxSeconds: number;
  /** Playback rate of the uploaded sound (1 for the built-in). */
  speed: number;
  /** The rates the page may offer. */
  minSpeed: number;
  maxSpeed: number;
}

/**
 * What the Sticker page shows: which sound is in force, and where to hear it.
 * Generates the default pop if it isn't on disk yet, so the preview always has
 * something to play.
 */
export async function stickerSoundState(): Promise<StickerSoundState> {
  const custom = readCustomMeta();
  const hasCustomFile = fs.existsSync(customSfxPath());
  const envPath = (process.env.MEME_SFX_PATH || "").trim();

  // Make sure whichever sound is in force actually exists to be previewed.
  await ensureStickerSfx();

  if (envPath && fs.existsSync(envPath)) {
    return {
      mode: "env",
      name: path.basename(envPath),
      previewUrl: null, // outside the served tree — it is a server-side override
      volume: sfxVolume(),
      enabled: sfxEnabled(),
      custom,
      maxSeconds: MAX_CUSTOM_SECONDS,
      speed: custom?.speed ?? DEFAULT_SFX_SPEED,
      minSpeed: MIN_SFX_SPEED,
      maxSpeed: MAX_SFX_SPEED,
    };
  }
  if (custom && hasCustomFile) {
    return {
      mode: "custom",
      name: custom.name,
      previewUrl: "/api/outputs/sfx/custom.wav",
      volume: sfxVolume(),
      enabled: sfxEnabled(),
      custom,
      maxSeconds: MAX_CUSTOM_SECONDS,
      speed: custom?.speed ?? DEFAULT_SFX_SPEED,
      minSpeed: MIN_SFX_SPEED,
      maxSpeed: MAX_SFX_SPEED,
    };
  }
  return {
    mode: "default",
    name: "Built-in slap",
    previewUrl: fs.existsSync(sfxPath()) ? "/api/outputs/sfx/sticker-pop.wav" : null,
    volume: sfxVolume(),
    enabled: sfxEnabled(),
    custom,
    maxSeconds: MAX_CUSTOM_SECONDS,
    speed: DEFAULT_SFX_SPEED,
    minSpeed: MIN_SFX_SPEED,
    maxSpeed: MAX_SFX_SPEED,
  };
}

/**
 * Resolve the sound file to use, generating the default on first call.
 *
 * Precedence, most specific first:
 *   1. `MEME_SFX_PATH` — a server-side override, for pinning a sound in compose.
 *   2. The sound the user uploaded on the Sticker page (conformed to the mix).
 *   3. The generated default.
 * A missing file at any level falls through to the next rather than failing the
 * render. Returns null only when the effect is disabled or synthesis failed, in
 * which case the composite simply carries the base audio through as before.
 */
export async function ensureStickerSfx(): Promise<string | null> {
  if (!sfxEnabled()) return null;

  const override = (process.env.MEME_SFX_PATH || "").trim();
  if (override) {
    if (fs.existsSync(override)) return override;
    console.warn(`[meme] MEME_SFX_PATH not found (${override}) — falling through`);
  }

  if (fs.existsSync(customSfxPath())) return customSfxPath();

  const file = sfxPath();
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;

  const workFile = path.join(config.tmpDir, "sfx_default_build.wav");
  fs.mkdirSync(config.tmpDir, { recursive: true });
  try {
    // Pass 1 — synthesise in FLOAT. The tone-shaping EQ boosts by several dB, so
    // converting to s16 first would clip the transient before it is measured.
    await ffmpegRun([
      "-y", "-v", "error",
      "-f", "lavfi",
      "-i", `aevalsrc=${SFX_EXPRESSION}:d=${SFX_DURATION_SECONDS}:s=48000`,
      "-af",
      // Stereo so it mixes with the narration bed without a layout negotiation;
      // the fade kills the tail discontinuity.
      `aformat=channel_layouts=stereo:sample_fmts=fltp,${SFX_FILTERS}` +
        `afade=t=out:st=${(SFX_DURATION_SECONDS - 0.03).toFixed(3)}:d=0.03`,
      "-c:a", "pcm_f32le",
      workFile,
    ]);
    // Pass 2 — normalise to the same house peak an uploaded sound gets, so the
    // MEME_SFX_VOLUME dial means the same thing whichever sound is in force.
    const peak = await truePeakDbfs(workFile);
    await ffmpegRun([
      "-y", "-v", "error",
      "-i", workFile,
      "-af", `volume=${(TARGET_PEAK_DBFS - peak).toFixed(2)}dB`,
      "-c:a", "pcm_s16le",
      file,
    ]);
    console.log(`[meme] generated the built-in sticker slap → ${file}`);
    return file;
  } catch (e) {
    console.warn(
      `[meme] could not generate the sticker sound — rendering silent stickers: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

export interface SfxMixPlan {
  /** filter_complex fragments to append (in order). */
  filters: string[];
  /** The label carrying the mixed audio (map this instead of the base stream). */
  outLabel: string;
}

/**
 * Build the filter_complex fragments that drop one pop at each sticker start and
 * mix them under the base audio.
 *
 * PURE — no ffmpeg, no disk — so the delays, the gain and (above all) the amix
 * flags documented at the top of this file are unit-testable without rendering.
 *
 * @param starts          sticker start times in seconds (output timeline).
 * @param sfxInputIndex   ffmpeg input index of the sound file.
 * @param baseAudioLabel  the base video's audio stream (e.g. "0:a").
 * @param volume          linear gain for each pop.
 */
export function buildSfxMix(opts: {
  starts: number[];
  sfxInputIndex: number;
  baseAudioLabel: string;
  volume: number;
  outLabel?: string;
}): SfxMixPlan | null {
  const { starts, sfxInputIndex, baseAudioLabel, volume } = opts;
  const outLabel = opts.outLabel ?? "sfxout";
  const usable = starts.filter((s) => Number.isFinite(s) && s >= 0);
  if (usable.length === 0 || volume <= 0) return null;

  const filters: string[] = [];
  const branches = usable.map((_, i) => `sfx${i}`);
  filters.push(`[${sfxInputIndex}:a]asplit=${usable.length}${branches.map((b) => `[${b}]`).join("")}`);

  const delayed = usable.map((start, i) => {
    const ms = Math.round(start * 1000);
    // all=1 delays every channel by the same amount (without it, only the first
    // channel is delayed and the pop arrives split across the stereo field).
    filters.push(`[${branches[i]}]adelay=${ms}:all=1,volume=${volume}[sfxd${i}]`);
    return `sfxd${i}`;
  });

  filters.push(
    `[${baseAudioLabel}]${delayed.map((d) => `[${d}]`).join("")}` +
      // normalize=0: keep the narration at its own level (see the file header).
      // dropout_transition=0: no 2s gain ramp after each short pop ends.
      // duration=first: the mix ends with the narration, not with a pop.
      `amix=inputs=${delayed.length + 1}:normalize=0:dropout_transition=0:duration=first,` +
      // The base render is already loudness-normalised to a −1.0dBTP ceiling, so
      // ADDING anything to it can cross 0dBFS where a pop lands on a narration
      // peak. The limiter catches only those coincidences and is inaudible
      // everywhere else — cheaper than ducking the pop below usefulness.
      `alimiter=limit=0.97[${outLabel}]`,
  );

  return { filters, outLabel };
}
