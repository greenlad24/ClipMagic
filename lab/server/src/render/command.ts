import { resolveInput } from "./resolve.js";

/**
 * Rendi-compatible command path.
 *
 * Rendi accepts a single FFmpeg command string using {{in_0}} / {{out_1}}
 * placeholders plus an input_files map of remote URLs. Our existing frontend
 * adapter (src/utils/rendiAdapter.ts) already emits exactly this. To make the
 * self-hosted server a drop-in Rendi replacement, we parse that same command
 * here, resolve every {{key}} placeholder to a local path, and produce argv for
 * spawning the local ffmpeg binary.
 */

/**
 * Shell-like tokenizer. Splits on whitespace but keeps quoted regions intact
 * and strips the surrounding quotes (spawn passes argv literally, so the quotes
 * Rendi/CLI would need must be removed). Single quotes inside double quotes —
 * e.g. drawtext text='...' inside -filter_complex "..." — are preserved.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true; // an empty quoted string is still a token
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (has || cur.length > 0) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur.length > 0) tokens.push(cur);
  return tokens;
}

const PLACEHOLDER = /^\{\{\s*([\w.-]+)\s*\}\}$/;

export interface ResolveCommandResult {
  args: string[];
  outputKeys: string[];
}

/**
 * Turn a Rendi command string + input map + output map into local argv.
 * `inputFiles[key]` may be a file id, an upload URL, a remote URL, or a path
 * (see resolveInput). `outputs[key]` is an absolute local destination path.
 */
export async function resolveCommand(
  command: string,
  inputFiles: Record<string, string>,
  outputs: Record<string, string>
): Promise<ResolveCommandResult> {
  const rawTokens = tokenize(command);
  const args: string[] = [];
  const usedOutputs: string[] = [];

  for (const tok of rawTokens) {
    const m = tok.match(PLACEHOLDER);
    if (!m) {
      args.push(tok);
      continue;
    }
    const key = m[1];
    if (key in outputs) {
      args.push(outputs[key]);
      usedOutputs.push(key);
    } else if (key in inputFiles) {
      args.push(await resolveInput(inputFiles[key]));
    } else {
      throw new Error(`Command references unknown placeholder {{${key}}}`);
    }
  }

  // Ensure ffmpeg emits machine-readable progress on stdout.
  if (!args.includes("-progress")) {
    args.push("-progress", "pipe:1", "-nostats");
  }
  return { args, outputKeys: usedOutputs };
}
