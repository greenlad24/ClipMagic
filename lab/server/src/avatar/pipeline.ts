/**
 * Avatar Narrator — the run.
 *
 *   script → TTS → publish portrait+audio → provider job(s) → download → stitch
 *
 * Two shapes, one code path:
 *
 *   CONTINUOUS (default, segmentSeconds = 0)
 *     One provider job for the whole narration. InfiniteTalk accepts up to 10
 *     minutes of audio per job, and one job means one unbroken performance —
 *     no seam where the presenter resets to the portrait pose. This is the mode
 *     that looks real, and it is the default for that reason.
 *
 *   FAST (segmentSeconds > 0)
 *     The script is split and the chunks render in PARALLEL. The provider needs
 *     ~20 seconds of wall time per second of 720p video, so a 3-minute
 *     continuous render is an hour of waiting while six 30-second chunks is
 *     nearer fifteen minutes. It costs slightly more (every job bills a 5-second
 *     minimum) and you can see the joins. Worth it for drafts, not for the take
 *     you publish.
 *
 * WALL TIME IS THE DEFINING CONSTRAINT and it shapes everything below: runs are
 * long enough that a deploy will land in the middle of one. So state lives in
 * SQLite rather than memory, the provider's task id is persisted the moment it
 * exists, and `resumeInterrupted()` re-attaches to jobs still running on the
 * provider's side after a restart instead of abandoning an hour of paid render.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import * as store from "../db/avatar.js";
import { getProvider } from "./providers.js";
import { publishForProvider, revoke } from "./publicAssets.js";
import { roomPlateFile } from "./rooms.js";
import { synthesize, probeDuration } from "./tts.js";
import {
  NARRATION_WPM,
  maxJobSeconds,
  estimateScriptSeconds,
  videoCostUsd,
  type AvatarProviderId,
  type AvatarResolution,
} from "./types.js";

/** How often to ask the provider whether a job is done. */
const POLL_INTERVAL_MS = Number.parseInt(process.env.AVATAR_POLL_INTERVAL_MS || "15000", 10);

/**
 * Give up on a single job after this long. Generous on purpose: 20s of wall time
 * per second of video means a legitimate 10-minute narration can run for hours,
 * and killing a job we have already paid for is the worst possible outcome.
 */
const JOB_TIMEOUT_MS = Number.parseInt(process.env.AVATAR_JOB_TIMEOUT_MS || String(6 * 60 * 60 * 1000), 10);

/** Ids the operator has asked to stop. Checked at every await point. */
const canceled = new Set<string>();

/**
 * Retry a failed run, resuming rather than restarting.
 *
 * Every stage persists what it bought — the narration mp3, the provider task
 * id, the downloaded clip — and every stage skips work that is already done.
 * So a run that died at submit because the account was out of credit costs
 * nothing extra to retry: the TTS is reused, segments that were accepted keep
 * their task ids, and only the segments that never got submitted are sent.
 *
 * Failed SEGMENTS are reset to pending; their task id is cleared because a
 * provider job that failed cannot be polled back to life.
 */
export function retryVideo(id: string): boolean {
  const v = store.getVideo(id);
  if (!v) return false;
  if (v.status !== "failed" && v.status !== "canceled") return false;

  for (const seg of store.segmentRows(id)) {
    if (seg.status === "failed") {
      store.updateSegment(seg.id, { status: "pending", providerTask: null, error: null });
    }
  }

  canceled.delete(id);
  store.updateVideo(id, { status: "queued", phase: "Retrying", error: null, progress: 0.02 });
  void runVideo(id).catch(() => {});
  return true;
}

export function cancelVideo(id: string): boolean {
  const v = store.getVideo(id);
  if (!v || v.status === "done" || v.status === "failed" || v.status === "canceled") return false;
  canceled.add(id);
  store.updateVideo(id, { status: "canceled", phase: "Canceled", error: "Canceled by operator" });
  return true;
}

class Canceled extends Error {
  constructor() {
    super("canceled");
  }
}

function checkCanceled(id: string): void {
  if (canceled.has(id)) throw new Canceled();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-500)}`)),
    );
  });
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading the rendered clip failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("The provider returned an empty video file.");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

// ── Script splitting ─────────────────────────────────────────────────────────

/**
 * Split a script into roughly-equal chunks of `targetSeconds` of speech, never
 * breaking a sentence. Duration is estimated from the word count — the real
 * durations are measured after TTS, and the only thing this has to get right is
 * "roughly this long", because a chunk that overshoots still renders, it just
 * costs a little more.
 *
 * `hardLimitSeconds` is different in kind: it is the provider's per-job ceiling,
 * and a chunk over it does NOT render — it is rejected after we have already
 * paid to voice it. So where `targetSeconds` politely declines to break a
 * sentence, the hard limit will break one. Leave it Infinity to keep the old
 * "sentences are sacred" behaviour.
 */
export function splitScript(script: string, targetSeconds: number, hardLimitSeconds = Infinity): string[] {
  const text = script.trim();
  if (!text) return [];
  const total = estimateScriptSeconds(text);
  if (targetSeconds <= 0 || total <= targetSeconds) return enforceHardLimit([text], hardLimitSeconds);

  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  let cur: string[] = [];
  let curSeconds = 0;

  for (const s of sentences) {
    const secs = estimateScriptSeconds(s);
    // Close the chunk when adding this sentence would overshoot — but never emit
    // an empty one, so a single over-long sentence becomes its own chunk.
    if (cur.length && curSeconds + secs > targetSeconds) {
      out.push(cur.join(" "));
      cur = [];
      curSeconds = 0;
    }
    cur.push(s);
    curSeconds += secs;
  }
  if (cur.length) out.push(cur.join(" "));
  return enforceHardLimit(out, hardLimitSeconds);
}

/**
 * Cut anything still over the provider's ceiling. At WaveSpeed's 600s this
 * never fires; at kie.ai's 15s it fires often, because 15 seconds of speech is
 * about 37 words and plenty of ordinary sentences run longer than that.
 *
 * A clause boundary is the least audible place to cut — the reader already
 * pauses there — so commas and semicolons are tried before falling back to
 * counting words, which is the cut of last resort.
 */
function enforceHardLimit(chunks: string[], limitSeconds: number): string[] {
  if (!Number.isFinite(limitSeconds) || limitSeconds <= 0) return chunks;
  const out: string[] = [];
  for (const chunk of chunks) {
    if (estimateScriptSeconds(chunk) <= limitSeconds) {
      out.push(chunk);
      continue;
    }
    out.push(...packPieces(splitClauses(chunk), limitSeconds));
  }
  return out;
}

/** Clause-sized pieces, punctuation kept so the narration still reads right. */
function splitClauses(text: string): string[] {
  return text.match(/[^,;:—–]+[,;:—–]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

/** Greedily pack pieces up to the ceiling; a piece that alone exceeds it is cut on words. */
function packPieces(pieces: string[], limitSeconds: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let curSeconds = 0;
  const flush = () => {
    if (cur.length) out.push(cur.join(" "));
    cur = [];
    curSeconds = 0;
  };

  for (const piece of pieces) {
    const secs = estimateScriptSeconds(piece);
    if (secs > limitSeconds) {
      flush();
      out.push(...splitWords(piece, limitSeconds));
      continue;
    }
    if (cur.length && curSeconds + secs > limitSeconds) flush();
    cur.push(piece);
    curSeconds += secs;
  }
  flush();
  return out;
}

function splitWords(text: string, limitSeconds: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const perChunk = Math.max(1, Math.floor((limitSeconds / 60) * NARRATION_WPM));
  const out: string[] = [];
  for (let i = 0; i < words.length; i += perChunk) out.push(words.slice(i, i + perChunk).join(" "));
  return out;
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface StartInput {
  personaId: string;
  title: string;
  script: string;
  provider: AvatarProviderId;
  resolution: AvatarResolution;
  /** 0 = one continuous job (default). >0 = parallel chunks of ~this many seconds. */
  segmentSeconds: number;
  seed?: number;
}

/**
 * Create the run and start it. Returns as soon as the rows exist — the work
 * happens in the background and the UI polls `getVideo`.
 */
export function startVideo(input: StartInput): string {
  const persona = store.getPersona(input.personaId);
  if (!persona) throw new Error("Persona not found.");

  const provider = getProvider(input.provider);
  if (!provider.configured()) {
    throw new Error(`${provider.label} is not configured — add its API key in Settings → Avatar Narrator.`);
  }
  if (!input.script.trim()) throw new Error("The script is empty.");

  const videoId = store.createVideo({
    personaId: input.personaId,
    title: input.title || "Untitled narration",
    script: input.script,
    provider: input.provider,
    resolution: input.resolution,
  });

  // The provider's ceiling wins over whatever the operator asked for: asking
  // for one continuous take on kie.ai does not make kie.ai accept one, it just
  // gets the job rejected after the narration is already paid for.
  const cap = maxJobSeconds(input.provider);
  const target = input.segmentSeconds > 0 ? Math.min(input.segmentSeconds, cap) : cap;
  const chunks = splitScript(input.script, target, cap);
  chunks.forEach((text, idx) => store.createSegment({ videoId, idx, text }));

  // Fire and forget: a failure inside the run is recorded on the row, so an
  // unhandled rejection here would only be able to duplicate that. What it must
  // never do is take the server down.
  void runVideo(videoId, input.seed).catch(() => {});
  return videoId;
}

async function runVideo(videoId: string, seed?: number): Promise<void> {
  try {
    await voiceSegments(videoId);
    await submitSegments(videoId, seed);
    await awaitAndStitch(videoId);
  } catch (e: any) {
    if (e instanceof Canceled) {
      canceled.delete(videoId);
      return;
    }
    store.updateVideo(videoId, {
      status: "failed",
      phase: "Failed",
      error: String(e?.message ?? e).slice(0, 1000),
    });
  } finally {
    canceled.delete(videoId);
  }
}

/** Stage 1 — voice every segment, and record the real measured duration. */
async function voiceSegments(videoId: string): Promise<void> {
  const video = store.getVideo(videoId);
  if (!video) throw new Error("Run vanished.");
  const persona = store.getPersona(video.personaId);
  if (!persona) throw new Error("Persona was deleted while the run was starting.");

  store.updateVideo(videoId, { status: "voicing", phase: "Writing the narration", progress: 0.02 });

  const segments = store.segmentRows(videoId);
  let ttsCost = 0;
  let totalSeconds = 0;

  for (let i = 0; i < segments.length; i++) {
    checkCanceled(videoId);
    const seg = segments[i];

    // Already voiced on an earlier attempt: the money is spent and the file is
    // on disk, so a retry must not buy it twice. This is what makes retrying a
    // failed render cheap instead of a fresh bill.
    if (seg.audioFile && fs.existsSync(seg.audioFile) && seg.seconds > 0) {
      totalSeconds += seg.seconds;
      store.updateSegment(seg.id, { status: "pending" });
      store.updateVideo(videoId, {
        phase: `Reusing narration ${i + 1}/${segments.length}`,
        progress: 0.02 + 0.18 * ((i + 1) / segments.length),
      });
      continue;
    }

    store.updateSegment(seg.id, { status: "voicing" });

    const outFile = path.join(config.avatarDir, `${videoId}-seg${String(seg.idx).padStart(3, "0")}.mp3`);
    const result = await synthesize({
      script: seg.text,
      provider: persona.ttsProvider,
      voice: persona.ttsVoice,
      outFile,
      onProgress: (done, total) => {
        const within = total ? done / total : 0;
        store.updateVideo(videoId, {
          phase: `Voicing ${i + 1}/${segments.length}`,
          progress: 0.02 + 0.18 * ((i + within) / segments.length),
        });
      },
    });

    // The split above works off estimated word-rate duration; this is the real
    // measured one. A slow read can push a chunk past the provider's ceiling,
    // and that job would be rejected after we had already paid to voice it.
    const cap = maxJobSeconds(video.provider);
    if (result.seconds > cap) {
      throw new Error(
        `Segment ${seg.idx + 1} came out at ${Math.round(result.seconds)}s of narration, past ${getProvider(video.provider).label}'s ` +
          `${cap}s per-job limit. Shorten the script, or pick shorter chunks so it renders as several jobs.`,
      );
    }

    store.updateSegment(seg.id, { status: "pending", audioFile: outFile, seconds: result.seconds });
    ttsCost += result.costUsd;
    totalSeconds += result.seconds;
  }

  // With one segment the narration IS the run's audio, so surface it directly —
  // it's what the operator wants to preview before committing to a paid render.
  const single = segments.length === 1 ? store.segmentRows(videoId)[0] : null;
  store.updateVideo(videoId, {
    audioFile: single?.audioFile ?? null,
    audioSeconds: totalSeconds,
    costUsd: ttsCost,
    progress: 0.2,
  });
}

/** Stage 2 — publish the inputs and submit every segment to the provider. */
async function submitSegments(videoId: string, seed?: number): Promise<void> {
  const video = store.getVideo(videoId);
  if (!video) throw new Error("Run vanished.");
  const persona = store.getPersona(video.personaId);
  if (!persona) throw new Error("Persona was deleted mid-run.");

  const provider = getProvider(video.provider);
  store.updateVideo(videoId, { status: "rendering", phase: "Submitting to " + provider.label, progress: 0.22 });

  // The portrait is published once and shared by every segment — it is the same
  // file, and one capability URL is one thing to revoke.
  const portrait = publishForProvider(persona.portraitFile, `portrait${path.extname(persona.portraitFile) || ".png"}`);
  // The room plate rides with every segment so each one opens and ends in the
  // same studio. Published once alongside the portrait, for the same reason:
  // one file, one capability URL, one thing to revoke. A persona with no plate
  // (or whose plate has been deleted) simply sends no room and the engine falls
  // back to the room described in the portrait — degraded, never broken.
  const roomFile = roomPlateFile(persona.roomId);
  const roomAsset = roomFile ? publishForProvider(roomFile, `room${path.extname(roomFile) || ".png"}`) : null;
  const audioTokens: string[] = [];

  try {
    const segments = store.segmentRows(videoId);
    for (const seg of segments) {
      checkCanceled(videoId);
      if (seg.providerTask) continue; // already submitted (resume path)
      if (!seg.audioFile) throw new Error(`Segment ${seg.idx + 1} has no narration audio.`);

      const audio = publishForProvider(seg.audioFile, `narration-${seg.idx}.mp3`);
      audioTokens.push(audio.token);

      const taskId = await provider.submit({
        imageUrl: portrait.url,
        roomUrl: roomAsset?.url,
        audioUrl: audio.url,
        prompt: persona.scenePrompt,
        resolution: video.resolution,
        seed,
        // The MEASURED narration length, not the estimate. A generative engine
        // builds a clip of exactly this many seconds, so an estimate that runs
        // short would cut the script off mid-sentence.
        seconds: seg.seconds,
        // Segmind defaults to 16:9; "adaptive" follows the portrait instead, so
        // a 9:16 persona is not letterboxed into a landscape frame.
        aspect: "adaptive",
        // The words themselves, for engines that speak rather than lipsync.
        speech: seg.text,
      });

      store.updateSegment(seg.id, {
        status: "submitted",
        providerTask: taskId,
        costUsd: videoCostUsd(video.provider, video.resolution, seg.seconds),
      });
    }
  } catch (e) {
    // Only the portrait is revoked on failure — the audio capabilities may
    // belong to jobs that DID submit and are now being fetched.
    revoke(portrait.token);
    throw e;
  }

  // Deliberately NOT revoking here: the provider fetches the URLs asynchronously,
  // sometimes minutes after accepting the job. The TTL sweep in publicAssets.ts
  // is what cleans these up, and it is the only safe cleaner.
  void audioTokens;
}

/**
 * Stage 3 — wait for every segment, download the clips, join them.
 *
 * Separated from stages 1–2 so `resumeInterrupted()` can re-enter here after a
 * restart: by this point the provider holds the jobs and the task ids are in the
 * database, so all that is left is waiting, which is idempotent.
 */
async function awaitAndStitch(videoId: string): Promise<void> {
  const video = store.getVideo(videoId);
  if (!video) throw new Error("Run vanished.");
  const provider = getProvider(video.provider);

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let pendingIds = store.segmentRows(videoId).filter((s) => s.status !== "done").map((s) => s.id);

  while (pendingIds.length) {
    checkCanceled(videoId);
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${Math.round(JOB_TIMEOUT_MS / 60000)} minutes waiting for ${provider.label}. ` +
          `The job may still finish on their side — check your provider dashboard before re-running.`,
      );
    }

    const segments = store.segmentRows(videoId);
    const stillPending: string[] = [];

    for (const seg of segments) {
      if (seg.status === "done") continue;
      if (!seg.providerTask) {
        store.updateSegment(seg.id, { status: "failed", error: "Never submitted" });
        throw new Error(`Segment ${seg.idx + 1} was never submitted.`);
      }

      const state = await provider.poll(seg.providerTask);
      if (state.status === "pending") {
        stillPending.push(seg.id);
        continue;
      }
      if (state.status === "failed") {
        store.updateSegment(seg.id, { status: "failed", error: state.error.slice(0, 500) });
        throw new Error(`${provider.label} failed on segment ${seg.idx + 1}: ${state.error}`);
      }

      const clip = path.join(config.avatarDir, `${videoId}-clip${String(seg.idx).padStart(3, "0")}.mp4`);
      if (state.videoFile) {
        // The provider answered synchronously and already has the bytes (see
        // Segmind in providers.ts) — move them into the library rather than
        // re-fetching a clip we are holding.
        fs.mkdirSync(path.dirname(clip), { recursive: true });
        fs.renameSync(state.videoFile, clip);
      } else if (state.videoUrl) {
        await download(state.videoUrl, clip);
      } else {
        throw new Error(`${provider.label} reported segment ${seg.idx + 1} done with neither a URL nor a file.`);
      }
      store.updateSegment(seg.id, { status: "done", clipFile: clip });
    }

    const done = segments.length - stillPending.length;
    store.updateVideo(videoId, {
      phase: `Rendering ${done}/${segments.length} on ${provider.label}`,
      // 0.25 → 0.9 across the render, which is where nearly all the wall time is.
      progress: 0.25 + 0.65 * (segments.length ? done / segments.length : 0),
    });

    pendingIds = stillPending;
    if (pendingIds.length) await sleep(POLL_INTERVAL_MS);
  }

  await stitch(videoId);
}

/** Join the segment clips into the finished MP4. */
async function stitch(videoId: string): Promise<void> {
  const video = store.getVideo(videoId);
  if (!video) throw new Error("Run vanished.");
  const provider = getProvider(video.provider);
  const segments = store.segmentRows(videoId);
  const rendered = segments.filter((s) => !!s.clipFile);
  if (!rendered.length) throw new Error("No rendered clips to assemble.");

  /**
   * Put the narration back on the picture.
   *
   * Only for engines that DO NOT make their own audio.
   *
   * A generative engine (Seedance) speaks the words itself and syncs the mouth
   * to what it produced; our TTS was only ever the voice it was told to
   * imitate. Muxing that TTS over the result would replace a synchronised
   * track with an unsynchronised one — which is exactly how the lips came to
   * drift on the first render. A lipsync engine is the opposite case: it is
   * driven by our audio, so putting the same track back is correct.
   *
   * Done per segment rather than once over the finished cut, because clip and
   * narration lengths differ by a frame or two and joining first would let that
   * error accumulate until the mouth and the voice visibly part company.
   */
  const voiced: string[] = [];

  if (provider.producesAudio) {
    // The engine produced its OWN audio, synchronised to the mouth it drew.
    // Replacing that with our separately-timed TTS is exactly what puts the
    // lips out of sync — here the narration was a VOICE REFERENCE, not the
    // soundtrack, and the clip is already finished.
    voiced.push(...rendered.map((r) => r.clipFile!));
  } else {
  for (const seg of rendered) {
    const clip = seg.clipFile!;
    if (!seg.audioFile || !fs.existsSync(seg.audioFile)) {
      voiced.push(clip);
      continue;
    }
    const out = path.join(config.avatarDir, `${videoId}-voiced${String(seg.idx).padStart(3, "0")}.mp4`);
    await runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", clip,
      "-i", seg.audioFile,
      // Take the picture from the clip and the sound from our narration, and
      // drop any audio the model happened to include.
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      // Whichever runs out first ends the segment — otherwise a clip that is a
      // beat longer than its line leaves a frozen face over silence.
      "-shortest",
      out,
    ]);
    voiced.push(out);
  }
  }

  const clips = voiced;

  const finalFile = path.join(config.avatarDir, `${videoId}.mp4`);
  store.updateVideo(videoId, { status: "stitching", phase: "Assembling the final cut", progress: 0.92 });

  if (clips.length === 1) {
    // Nothing to join. Re-mux rather than copy the file so the output is always
    // a faststart MP4 that plays in the browser without downloading fully.
    await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", clips[0], "-c", "copy", "-movflags", "+faststart", finalFile]);
  } else {
    // Every clip came from the same model at the same resolution, but "same
    // settings" is not "same encoder state" — concat with -c copy produces
    // audio drift often enough that re-encoding once is the honest choice.
    const list = path.join(config.avatarDir, `${videoId}-concat.txt`);
    fs.writeFileSync(list, clips.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    try {
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", list,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        finalFile,
      ]);
    } finally {
      fs.rmSync(list, { force: true });
    }
  }

  const seconds = await probeDuration(finalFile);
  // cost_usd currently holds the TTS spend recorded at stage 1; the render is
  // billed per segment. Summing them here is what makes the row the whole bill.
  const ttsCost = store.getVideo(videoId)?.costUsd ?? 0;
  const renderCost = segments.reduce((sum, s) => sum + s.costUsd, 0);

  store.updateVideo(videoId, {
    status: "done",
    phase: "Done",
    progress: 1,
    videoFile: finalFile,
    audioSeconds: seconds || undefined,
    costUsd: ttsCost + renderCost,
    error: null,
  });
}

/**
 * Re-attach to runs that a restart interrupted.
 *
 * A render costs real money and takes up to an hour, so abandoning one because
 * the container restarted is the wrong default. Anything that had already
 * reached the provider (task ids persisted) goes back to waiting; anything that
 * died before submitting has paid only for TTS and is marked failed, because
 * re-submitting automatically could double-charge without the operator asking.
 */
export function resumeInterrupted(): { resumed: number; failed: number } {
  let resumed = 0;
  let failed = 0;

  for (const v of store.listVideos(500)) {
    if (v.status !== "rendering" && v.status !== "stitching" && v.status !== "voicing" && v.status !== "queued") continue;

    const segments = store.segmentRows(v.id);
    const submitted = segments.filter((s) => s.providerTask);

    if (submitted.length && submitted.length === segments.length) {
      resumed++;
      store.updateVideo(v.id, { phase: "Reconnecting after restart" });
      void awaitAndStitch(v.id).catch((e: any) => {
        store.updateVideo(v.id, {
          status: "failed",
          phase: "Failed",
          error: String(e?.message ?? e).slice(0, 1000),
        });
      });
    } else {
      failed++;
      store.updateVideo(v.id, {
        status: "failed",
        phase: "Interrupted",
        error: "The server restarted before this run reached the provider. Nothing was charged for rendering — start it again.",
      });
    }
  }

  return { resumed, failed };
}
