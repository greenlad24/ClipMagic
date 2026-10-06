import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

/**
 * Extract a small mono 16kHz MP3 of the source's audio for transcription.
 * Returns the bytes + a filename/type suitable for the Groq form upload.
 * Throws if the source has no decodable audio.
 */
export function extractAudioForTranscription(
  srcPath: string,
): Promise<{ buffer: Buffer; name: string; type: string }> {
  const out = path.join(config.tmpDir, `cutaudio_${randomUUID()}.mp3`);
  const args = [
    "-y", "-i", srcPath,
    "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "libmp3lame", "-q:a", "5",
    out,
    "-loglevel", "error",
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`ffmpeg audio extract failed to start: ${e.message}`)));
    p.on("close", (code) => {
      if (code !== 0) {
        try { fs.rmSync(out, { force: true }); } catch { /* */ }
        return reject(new Error(`ffmpeg audio extract exited ${code}: ${err.slice(-400)}`));
      }
      try {
        const buffer = fs.readFileSync(out);
        resolve({ buffer, name: "narration.mp3", type: "audio/mpeg" });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        try { fs.rmSync(out, { force: true }); } catch { /* */ }
      }
    });
  });
}
