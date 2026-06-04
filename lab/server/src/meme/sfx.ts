/**
 * Sticker pop SFX for the Meme/Sticker editor.
 *
 * SOURCE / LICENSE: the SFX is SYNTHESIZED procedurally with ffmpeg — a short
 * sine "blip" with a fast pitch drop + exponential decay envelope. It is NOT a
 * sampled/recorded sound and is generated entirely from ffmpeg's own oscillators,
 * so there is NO copyrighted audio, NO bundled asset, and NO network fetch (the
 * earlier-run hang was network/Chromium; this is a single local audio-only
 * ffmpeg call, cached). The result is effectively CC0 — we created it from a
 * waveform formula.
 *
 * The clip is built ONCE per process and cached on disk, then mixed into the
 * final audio at each sticker's start time (adelay + amix) by the meme stage.
 */
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";
import { runFfmpeg } from "../render/ffmpeg.js";

/** Length of the pop, seconds — short, punchy, never lingering under the voice. */
export const SFX_DURATION_SEC = 0.22;

const AUDIO_SR = 44100;

let cachedPath: string | null = null;
let buildPromise: Promise<string> | null = null;

/**
 * The ffmpeg argv that synthesizes the pop into `out`. Pure (no side effects) so
 * the filtergraph is unit-testable. A descending sine (a "pop"/"blip") with a
 * sharp attack and exponential decay so it reads as a clean UI pop, not a tone.
 */
export function buildPopArgs(out: string): string[] {
  // A short sine whose amplitude decays exponentially (the classic "pop"
  // envelope), high-passed a touch so it sits as a crisp blip. `aevalsrc` lets us
  // bake the pitch drop + decay directly into the waveform without a sample.
  const expr =
    `0.9*exp(-t*26)*sin(2*PI*t*(880-1400*t))`; // descending pitch, fast decay
  return [
    "-y",
    "-hide_banner",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${expr}:s=${AUDIO_SR}:d=${SFX_DURATION_SEC}`,
    "-af",
    "highpass=f=180,aformat=sample_fmts=fltp:channel_layouts=stereo",
    "-c:a",
    "pcm_s16le",
    out,
  ];
}

/**
 * Build the audio-mix filtergraph that lays a pop SFX at each sticker start time
 * over the base video's audio. PURE so the filtergraph can be unit-tested without
 * ffmpeg.
 *
 * Layout: input 0 is the base video (its audio = [0:a]); the SFX file is repeated
 * once per sticker start at input indices `sfxInputStart … +N-1`. Each SFX copy
 * is delayed by its sticker's start time (adelay, milliseconds, both channels)
 * and gained to `volume`, then amix'd with the base audio. normalize=0 keeps the
 * base narration+music at full level and the pops at exactly `volume`.
 *
 * Returns the filter segments plus the final audio label to map. If there are no
 * starts it returns an empty filter list and the base audio label unchanged.
 */
export function buildSfxAudioFilters(opts: {
  baseAudioLabel: string;
  startTimes: number[];
  sfxInputStart: number;
  volume: number;
}): { filters: string[]; audioLabel: string } {
  const { baseAudioLabel, startTimes, sfxInputStart, volume } = opts;
  if (startTimes.length === 0) {
    return { filters: [], audioLabel: baseAudioLabel };
  }
  const filters: string[] = [];
  const mixLabels: string[] = [`[${baseAudioLabel}]`];
  startTimes.forEach((start, i) => {
    const inputIdx = sfxInputStart + i;
    const delayMs = Math.max(0, Math.round(start * 1000));
    const lbl = `sfx${i}`;
    // adelay=ms|ms for stereo; volume scales the pop; aformat keeps the mix sane.
    filters.push(
      `[${inputIdx}:a]adelay=${delayMs}|${delayMs},volume=${volume},` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[${lbl}]`,
    );
    mixLabels.push(`[${lbl}]`);
  });
  // duration=first → the mix length follows the base audio (so trailing pops are
  // clipped at the video end); normalize=0 → keep each input at its own level.
  filters.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0[aout_sfx]`,
  );
  return { filters, audioLabel: "aout_sfx" };
}

/**
 * Build (once) and return the path to the synthesized pop WAV. Cached on disk and
 * in-memory; concurrent callers share one build. Returns null on any failure so
 * the caller can simply skip the SFX (never blocks the render).
 */
export async function getStickerPop(): Promise<string | null> {
  if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
  if (buildPromise) return buildPromise.catch(() => null);

  const out = path.join(config.tmpDir, "meme_sticker_pop.wav");
  if (fs.existsSync(out)) {
    cachedPath = out;
    return out;
  }
  buildPromise = (async () => {
    await runFfmpeg(buildPopArgs(out), SFX_DURATION_SEC);
    cachedPath = out;
    return out;
  })();
  try {
    return await buildPromise;
  } catch (e) {
    console.warn(
      `[meme] sticker SFX synth failed — skipping pop: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  } finally {
    buildPromise = null;
  }
}
