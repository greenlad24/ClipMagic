/**
 * Drop-in replacement for Zite's `zite-file-upload-sdk`.
 *
 * The original `uploadFile({ data, filename })` returned `{ fileUrl }`. Here it
 * streams the blob to the self-hosted server's uncapped upload endpoint and
 * returns the served URL, so the 25MB Zite cap is gone and storage is local.
 *
 * Two paths, picked by size:
 *   • Small files (≤ CHUNKED_THRESHOLD) → one multipart POST to /api/uploads.
 *   • Large files (>  CHUNKED_THRESHOLD) → the chunked, resumable API: the file
 *     is split into CHUNK_BYTES pieces, each sent (and RETRIED with backoff)
 *     independently. The server only exposes the assembled file once every byte
 *     has arrived, so a dropped connection can never yield a truncated upload.
 */

export interface UploadFileArgs {
  data: Blob | File | ArrayBuffer | Uint8Array;
  filename: string;
  /** Optional upload-progress callback: fraction 0..1 of bytes sent. */
  onProgress?: (fraction: number) => void;
}

export interface UploadFileResult {
  fileUrl: string;
  fileId: string;
}

function toBlob(data: UploadFileArgs["data"]): Blob {
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data]);
  if (data instanceof Uint8Array) return new Blob([data]);
  return new Blob([data as BlobPart]);
}

/** Files larger than this use the chunked, resumable path. */
export const CHUNKED_THRESHOLD = 10 * 1024 * 1024; // 10 MB
/** Chunk size for the resumable path. */
export const CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB
/** How many chunks may be in flight at once. */
const CHUNK_CONCURRENCY = 3;
/** Per-chunk retry attempts before giving up the whole upload. */
const CHUNK_RETRIES = 3;
/** Stall watchdog per request: abort if no bytes move for this long. */
const STALL_MS = 60_000;

// ── Single-POST path (small files) ──────────────────────────────────────────

/**
 * Upload via XMLHttpRequest (not fetch) so we get REAL upload progress and can
 * detect a stalled connection. A bare fetch() reports nothing while the body
 * streams, so a slow/large file looks frozen on "Uploading…" forever and a
 * mid-flight stall never surfaces. Here:
 *   • upload.onprogress drives the caller's progress %;
 *   • a watchdog aborts with a clear error if NO bytes move for STALL_MS;
 *   • network errors / non-2xx responses reject with a readable message.
 */
async function uploadSinglePost(blob: Blob, filename: string, onProgress?: (f: number) => void): Promise<UploadFileResult> {
  const form = new FormData();
  form.append("files", blob, filename);

  return new Promise<UploadFileResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let lastTick = Date.now();

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      fn();
    };

    // Abort if the upload makes no progress for STALL_MS (frozen connection).
    const watchdog = setInterval(() => {
      if (Date.now() - lastTick > STALL_MS) {
        try { xhr.abort(); } catch { /* ignore */ }
        finish(() => reject(new Error("Upload stalled — no data sent for 60s. Check your connection and try again.")));
      }
    }, 5_000);

    xhr.open("POST", "/api/uploads");

    xhr.upload.onprogress = (e) => {
      lastTick = Date.now();
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.upload.onerror = () =>
      finish(() => reject(new Error("Upload failed — network error while sending the file.")));
    xhr.onerror = () => finish(() => reject(new Error("Upload failed — network error.")));
    xhr.onabort = () => finish(() => reject(new Error("Upload canceled.")));

    xhr.onload = () =>
      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const json = JSON.parse(xhr.responseText) as { files: Array<{ id: string; url: string }> };
            const f = json.files?.[0];
            if (!f) { reject(new Error("Upload finished but the server returned no file.")); return; }
            onProgress?.(1);
            resolve({ fileUrl: f.url, fileId: f.id });
          } catch {
            reject(new Error("Upload finished but the server response was unreadable."));
          }
        } else {
          reject(new Error(`Upload failed (${xhr.status}): ${(xhr.responseText || "server error").slice(0, 200)}`));
        }
      });

    xhr.send(form);
  });
}

// ── Chunked, resumable path (large files) ──────────────────────────────────

/** A single chunk's PUT, with per-chunk progress reporting via XHR. */
export interface ChunkSender {
  (args: {
    uploadId: string;
    index: number;
    blob: Blob;
    onProgress: (loaded: number) => void;
  }): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Backoff delay (ms) before retry attempt `attempt` (1-based). */
export function backoffDelay(attempt: number): number {
  // 500ms, 1s, 2s … with a little jitter so parallel chunks don't thunder.
  const base = 500 * Math.pow(2, attempt - 1);
  return base + Math.floor(Math.random() * 250);
}

/**
 * Send one chunk with retries + exponential backoff. Resumes THAT chunk only —
 * never the whole file. Throws once retries are exhausted.
 */
export async function sendChunkWithRetry(args: {
  uploadId: string;
  index: number;
  blob: Blob;
  onProgress: (loaded: number) => void;
  send: ChunkSender;
  retries?: number;
  onBackoff?: (ms: number) => Promise<void>;
}): Promise<void> {
  const retries = args.retries ?? CHUNK_RETRIES;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await args.send({ uploadId: args.uploadId, index: args.index, blob: args.blob, onProgress: args.onProgress });
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        // Reset this chunk's reported progress; it'll re-send from zero.
        args.onProgress(0);
        const ms = backoffDelay(attempt);
        await (args.onBackoff ? args.onBackoff(ms) : sleep(ms));
      }
    }
  }
  throw new Error(
    `Chunk ${args.index + 1} failed after ${retries} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/** Plan how a file of `size` bytes splits into chunks of `chunkSize`. */
export function planClientChunks(size: number, chunkSize: number): Array<{ index: number; start: number; end: number }> {
  const out: Array<{ index: number; start: number; end: number }> = [];
  for (let start = 0, i = 0; start < size; start += chunkSize, i++) {
    out.push({ index: i, start, end: Math.min(start + chunkSize, size) });
  }
  return out;
}

/** The real network ChunkSender, backed by XHR (for progress + stall watchdog). */
const xhrChunkSender: ChunkSender = ({ uploadId, index, blob, onProgress }) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let lastTick = Date.now();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      fn();
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastTick > STALL_MS) {
        try { xhr.abort(); } catch { /* ignore */ }
        finish(() => reject(new Error("chunk stalled — no data for 60s")));
      }
    }, 5_000);

    xhr.open("PUT", `/api/uploads/chunked/${uploadId}/${index}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      lastTick = Date.now();
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.upload.onerror = () => finish(() => reject(new Error("network error sending chunk")));
    xhr.onerror = () => finish(() => reject(new Error("network error")));
    xhr.onabort = () => finish(() => reject(new Error("chunk aborted")));
    xhr.onload = () =>
      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(blob.size);
          resolve();
        } else if (xhr.status >= 400 && xhr.status < 500 && xhr.status !== 408 && xhr.status !== 429) {
          // A 4xx (other than timeout/too-many-requests) is a permanent error —
          // retrying won't help, so surface it immediately.
          reject(new Error(`server rejected chunk (${xhr.status}): ${(xhr.responseText || "").slice(0, 160)}`));
        } else {
          reject(new Error(`chunk failed (${xhr.status})`));
        }
      });
    xhr.send(blob);
  });

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
  if (!res.ok) throw new Error(json?.error || `request failed (${res.status})`);
  return json;
}

/**
 * Drive a chunked, resumable upload of `blob`. Aggregates bytes-sent across all
 * chunks into a single 0..1 progress fraction. `send` is injectable for tests.
 */
export async function uploadChunked(
  blob: Blob,
  filename: string,
  opts: {
    onProgress?: (fraction: number) => void;
    send?: ChunkSender;
    chunkBytes?: number;
    concurrency?: number;
  } = {},
): Promise<UploadFileResult> {
  const send = opts.send ?? xhrChunkSender;
  const requestedChunk = opts.chunkBytes ?? CHUNK_BYTES;
  const concurrency = opts.concurrency ?? CHUNK_CONCURRENCY;
  const total = blob.size;

  // init — server decides the authoritative chunk size.
  const init = await postJson("/api/uploads/chunked/init", {
    filename,
    size: total,
    chunkSize: requestedChunk,
  });
  const uploadId: string = init.uploadId;
  const chunkSize: number = init.chunkSize || requestedChunk;
  if (!uploadId) throw new Error("Upload init failed — server returned no uploadId.");

  const plan = planClientChunks(total, chunkSize);
  // Per-chunk bytes-sent, aggregated into overall progress.
  const sent = new Array<number>(plan.length).fill(0);
  const report = () => {
    if (!opts.onProgress) return;
    let s = 0;
    for (const n of sent) s += n;
    opts.onProgress(total > 0 ? Math.min(1, s / total) : 1);
  };

  // Bounded-parallelism worker pool over the chunk plan.
  let next = 0;
  let failed: unknown = null;
  async function worker() {
    while (true) {
      if (failed) return;
      const i = next++;
      if (i >= plan.length) return;
      const part = plan[i];
      const slice = blob.slice(part.start, part.end);
      try {
        await sendChunkWithRetry({
          uploadId,
          index: part.index,
          blob: slice,
          onProgress: (loaded) => {
            sent[part.index] = Math.min(loaded, part.end - part.start);
            report();
          },
          send,
        });
        sent[part.index] = part.end - part.start;
        report();
      } catch (e) {
        failed = e;
        return;
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.max(1, Math.min(concurrency, plan.length || 1)); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (failed) {
    // Best-effort cleanup of the partial upload on the server.
    void postJson(`/api/uploads/chunked/${uploadId}/abort`, {}).catch(() => {});
    throw failed instanceof Error ? failed : new Error(String(failed));
  }

  // complete — server verifies all bytes, assembles, probes, returns the file.
  const done = await postJson(`/api/uploads/chunked/${uploadId}/complete`, {
    mime: (blob as File).type || "application/octet-stream",
  });
  const f = done.file || done.files?.[0];
  if (!f) throw new Error("Upload finished but the server returned no file.");
  opts.onProgress?.(1);
  return { fileUrl: f.url, fileId: f.id };
}

// ── Public entry ────────────────────────────────────────────────────────────

export async function uploadFile(args: UploadFileArgs): Promise<UploadFileResult> {
  const blob = toBlob(args.data);
  if (blob.size > CHUNKED_THRESHOLD) {
    return uploadChunked(blob, args.filename, { onProgress: args.onProgress });
  }
  return uploadSinglePost(blob, args.filename, args.onProgress);
}
