/**
 * Pure bookkeeping for resumable chunked uploads — no fs, no HTTP, so it is
 * trivially unit-testable. The route layer (routes/uploads.ts) owns the actual
 * disk IO and ties these helpers to a per-uploadId temp directory.
 *
 * The invariant that makes a TRUNCATED file impossible: an upload is only ever
 * finalized once `allChunksPresent` is true AND the assembled byte total equals
 * the size the client declared at `init`. Until then nothing is exposed.
 */

/** Default chunk size the server advertises to clients (8 MB). */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/** How long an incomplete upload may sit before the reaper deletes its temp dir. */
export const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface UploadSession {
  uploadId: string;
  filename: string;
  /** Total bytes the client promised to send. */
  totalSize: number;
  /** Number of chunks the client will send. */
  totalChunks: number;
  /** Bytes per chunk (the last chunk may be smaller). */
  chunkSize: number;
  /** Received byte length for each chunk index (undefined = not yet received). */
  received: Map<number, number>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Plan the chunk layout for a file of `totalSize` bytes at `chunkSize`.
 * Returns the chunk count and the expected byte length of a given index — the
 * single source of truth shared by `init` validation and `append` validation.
 */
export function planChunks(totalSize: number, chunkSize: number): {
  totalChunks: number;
  chunkSize: number;
} {
  if (!Number.isInteger(totalSize) || totalSize < 0) {
    throw new Error(`invalid totalSize: ${totalSize}`);
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`invalid chunkSize: ${chunkSize}`);
  }
  const totalChunks = totalSize === 0 ? 0 : Math.ceil(totalSize / chunkSize);
  return { totalChunks, chunkSize };
}

/** Byte offset where chunk `index` starts. */
export function chunkOffset(index: number, chunkSize: number): number {
  return index * chunkSize;
}

/** Expected byte length of chunk `index` for a file of `totalSize` bytes. */
export function expectedChunkLength(
  index: number,
  totalSize: number,
  chunkSize: number,
): number {
  const start = index * chunkSize;
  if (start >= totalSize) return 0;
  return Math.min(chunkSize, totalSize - start);
}

export function createSession(args: {
  uploadId: string;
  filename: string;
  totalSize: number;
  totalChunks: number;
  chunkSize: number;
  now?: number;
}): UploadSession {
  const now = args.now ?? Date.now();
  return {
    uploadId: args.uploadId,
    filename: args.filename,
    totalSize: args.totalSize,
    totalChunks: args.totalChunks,
    chunkSize: args.chunkSize,
    received: new Map(),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Validate an incoming chunk against the session BEFORE it is written. Returns
 * the expected byte length so the caller can confirm the body matches.
 * Throws a readable Error on any mismatch (bad index, wrong size).
 */
export function validateChunk(
  session: UploadSession,
  index: number,
  byteLength: number,
): number {
  if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
    throw new Error(
      `chunk index ${index} out of range (0..${session.totalChunks - 1})`,
    );
  }
  const expected = expectedChunkLength(index, session.totalSize, session.chunkSize);
  if (byteLength !== expected) {
    throw new Error(
      `chunk ${index} size mismatch: got ${byteLength} bytes, expected ${expected}`,
    );
  }
  return expected;
}

/**
 * Record a successfully written chunk. Idempotent: re-appending the same index
 * with the same length is a no-op (so a client retry of an already-stored chunk
 * can never corrupt the assembled file).
 */
export function recordChunk(
  session: UploadSession,
  index: number,
  byteLength: number,
  now?: number,
): void {
  session.received.set(index, byteLength);
  session.updatedAt = now ?? Date.now();
}

/** True once every chunk index has been received. */
export function allChunksPresent(session: UploadSession): boolean {
  if (session.received.size !== session.totalChunks) return false;
  for (let i = 0; i < session.totalChunks; i++) {
    if (!session.received.has(i)) return false;
  }
  return true;
}

/** Sum of received chunk byte lengths — must equal totalSize to finalize. */
export function receivedBytes(session: UploadSession): number {
  let sum = 0;
  for (const len of session.received.values()) sum += len;
  return sum;
}

/**
 * Final gate before exposing the assembled file. Throws unless every chunk is
 * present and the byte total matches what the client declared at init.
 */
export function assertComplete(session: UploadSession): void {
  if (!allChunksPresent(session)) {
    const missing: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.received.has(i)) missing.push(i);
    }
    throw new Error(
      `upload incomplete: missing chunk(s) ${missing.slice(0, 20).join(", ")}${
        missing.length > 20 ? "…" : ""
      }`,
    );
  }
  const got = receivedBytes(session);
  if (got !== session.totalSize) {
    throw new Error(
      `upload size mismatch: assembled ${got} bytes, expected ${session.totalSize}`,
    );
  }
}

/** Indices still missing (used to report progress / what to retry). */
export function missingChunks(session: UploadSession): number[] {
  const missing: number[] = [];
  for (let i = 0; i < session.totalChunks; i++) {
    if (!session.received.has(i)) missing.push(i);
  }
  return missing;
}

/** True if a session has been idle longer than the TTL (reaper target). */
export function isStale(session: UploadSession, ttlMs = UPLOAD_TTL_MS, now = Date.now()): boolean {
  return now - session.updatedAt > ttlMs;
}
