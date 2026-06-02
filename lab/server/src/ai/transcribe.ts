/**
 * Groq Whisper transcription.
 *
 * Groq exposes an OpenAI-compatible audio endpoint, so we POST the audio as
 * multipart/form-data and request verbose_json with word-level timestamps —
 * the exact shape the original pipeline consumes ({ text, duration, words }).
 *
 * whisper-large-v3-turbo matches the accuracy of the previous whisper-1 setup
 * at ~10x lower cost, and keeps all timestamps the kinetic-subtitle / beat
 * alignment logic depends on.
 */
import { aiConfig } from "./config.js";
import { recordGroqTranscription } from "./runAccounting.js";

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptResult {
  text: string;
  duration: number;
  words: TranscriptWord[];
}

export async function transcribeWithGroq(opts: {
  data: Buffer;
  name: string;
  type: string;
  wantWords: boolean;
  language?: string;
}): Promise<TranscriptResult> {
  if (!aiConfig.groqApiKey) {
    throw new Error(
      "GROQ_API_KEY is not set. Add it to the server environment to enable transcription."
    );
  }

  const form = new FormData();
  const blob = new Blob([opts.data], { type: opts.type || "audio/wav" });
  form.append("file", blob, opts.name || "audio.wav");
  form.append("model", aiConfig.groqModel);
  form.append("response_format", "verbose_json");
  if (opts.wantWords) form.append("timestamp_granularities[]", "word");
  if (opts.language) form.append("language", opts.language);

  const t0 = Date.now();
  const res = await fetch(`${aiConfig.groqBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aiConfig.groqApiKey}` },
    body: form,
  });
  const transcribeMs = Date.now() - t0;

  const json = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(
      `Groq transcription error (${res.status}): ${json?.error?.message || JSON.stringify(json)}`
    );
  }

  // Groq returns words as { word, start, end }. Normalize defensively.
  const words: TranscriptWord[] = Array.isArray(json.words)
    ? json.words.map((w: any) => ({
        word: w.word ?? w.text ?? "",
        start: Number(w.start) || 0,
        end: Number(w.end) || 0,
      }))
    : [];

  const duration =
    typeof json.duration === "number"
      ? json.duration
      : words.length
      ? words[words.length - 1].end
      : 0;

  // Record the real transcription for the per-run optimization report (priced
  // per minute of audio — the actual billing unit for Whisper).
  recordGroqTranscription({ model: aiConfig.groqModel, audioSeconds: duration, ms: transcribeMs });

  return { text: json.text ?? "", duration, words };
}
