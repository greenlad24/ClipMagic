/**
 * OpenAI-compatible shim — Stage 2 of the self-host migration.
 *
 * The original ClipMagic pipeline (src/api/runPipeline.ts etc.) was written
 * against the OpenAI SDK:
 *     import OpenAI, { toFile } from 'openai';
 *     const client = new OpenAI({ baseURL, apiKey });
 *     client.audio.transcriptions.create({ model, file, response_format, ... })
 *     client.chat.completions.create({ model, messages, response_format })
 *
 * Instead of rewriting that logic, we alias the `openai` import to this module
 * at bundle time (esbuild) and route:
 *   - transcription  -> Groq Whisper (whisper-large-v3-turbo), word timestamps
 *   - chat           -> Anthropic Claude, tiered (Opus director / Sonnet
 *                       research / Haiku fast) — see claude.ts.
 *
 * So the pipeline behaves exactly as written, but with the chosen providers.
 */
import { transcribeWithGroq } from "./transcribe.js";
import { claudeChatJSON, claudeChat } from "./claude.js";

export interface ShimFile {
  __isShimFile: true;
  data: Buffer;
  name: string;
  type: string;
}

/** Drop-in for openai's `toFile` — keeps bytes + metadata for the upload. */
export async function toFile(
  data: Buffer | Uint8Array | ArrayBuffer,
  name: string,
  opts?: { type?: string }
): Promise<ShimFile> {
  const buf =
    data instanceof Buffer
      ? data
      : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from((data as Uint8Array).buffer ?? data);
  return { __isShimFile: true, data: buf, name, type: opts?.type || "application/octet-stream" };
}

interface TranscriptionParams {
  model: string;
  file: ShimFile | { data?: Buffer; name?: string; type?: string };
  response_format?: string;
  timestamp_granularities?: string[];
  language?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatParams {
  model: string;
  messages: ChatMessage[];
  response_format?: { type?: string };
  temperature?: number;
  max_tokens?: number;
}

interface ChatCompletion {
  choices: Array<{ message: { content: string; role: "assistant" } }>;
}

/** Minimal drop-in for `new OpenAI({...})`. Constructor args are ignored. */
export default class OpenAI {
  audio = {
    transcriptions: {
      create: async (params: TranscriptionParams): Promise<unknown> => {
        const file = params.file as ShimFile;
        return transcribeWithGroq({
          data: file.data,
          name: file.name,
          type: file.type,
          wantWords:
            params.response_format === "verbose_json" ||
            (params.timestamp_granularities?.includes("word") ?? false),
          language: params.language,
        });
      },
    },
  };

  chat = {
    completions: {
      create: async (params: ChatParams): Promise<ChatCompletion> => {
        const wantJson = params.response_format?.type === "json_object";
        const system = params.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n\n");
        const turns = params.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
        const content = wantJson
          ? await claudeChatJSON({ model: params.model, system, messages: turns })
          : await claudeChat({ model: params.model, system, messages: turns });
        return { choices: [{ message: { content, role: "assistant" } }] };
      },
    },
  };

  constructor(_opts?: { baseURL?: string; apiKey?: string }) {
    /* args intentionally ignored — providers configured via env */
  }
}
