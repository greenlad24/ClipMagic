/**
 * Browser client for the self-hosted ClipMagic server.
 *
 * Replaces the old Zite file-upload SDK (which capped uploads at 25MB) and the
 * Rendi submit/poll calls. Uploads stream straight to the droplet's disk with
 * no size limit, and rendering runs locally via FFmpeg.
 *
 * Configure the base URL once, e.g. in your app entry:
 *   import { configureClipMagic } from "@/lib/clipmagicClient";
 *   configureClipMagic({ baseUrl: import.meta.env.VITE_CLIPMAGIC_URL });
 */

let BASE = "";
let TOKEN: string | null = null;

export function configureClipMagic(opts: { baseUrl: string; token?: string | null }): void {
  BASE = opts.baseUrl.replace(/\/+$/, "");
  TOKEN = opts.token ?? null;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return TOKEN ? { ...extra, Authorization: `Bearer ${TOKEN}` } : extra;
}

export interface UploadedFile {
  id: string;
  original: string;
  kind: "video" | "image" | "audio" | "other";
  mime: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  url: string;
}

/**
 * Upload one or more files. No size cap (the server streams to disk). Optionally
 * reports coarse progress via XHR for a single request; for very large sets,
 * call this in chunks of ~25 files and aggregate progress yourself.
 */
export function uploadFiles(
  files: File[],
  onProgress?: (loaded: number, total: number) => void
): Promise<UploadedFile[]> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/api/uploads`);
    if (TOKEN) xhr.setRequestHeader("Authorization", `Bearer ${TOKEN}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as { files: UploadedFile[] }).files);
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload network error"));
    xhr.send(form);
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: authHeaders({ "Content-Type": "application/json", ...(init?.headers as object) }),
  });
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ── Single render (manifest) ─────────────────────────────────────────────────
export interface RenderJobStatus {
  id: string;
  status: "queued" | "active" | "completed" | "failed" | "canceled";
  progress: number;
  error: string | null;
  outputUrl: string | null;
  durationSec: number | null;
}

export async function renderManifest(manifest: unknown, projectId?: string): Promise<string> {
  const { jobId } = await api<{ jobId: string }>("/api/render/manifest", {
    method: "POST",
    body: JSON.stringify({ manifest, projectId }),
  });
  return jobId;
}

export function getRenderStatus(jobId: string): Promise<RenderJobStatus> {
  return api<RenderJobStatus>(`/api/render/${jobId}`);
}

/** Poll a job until it reaches a terminal state. */
export async function waitForRender(
  jobId: string,
  onProgress?: (s: RenderJobStatus) => void,
  intervalMs = 1500
): Promise<RenderJobStatus> {
  for (;;) {
    const s = await getRenderStatus(jobId);
    onProgress?.(s);
    if (s.status === "completed" || s.status === "failed" || s.status === "canceled") return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Bulk batches (300+ videos) ───────────────────────────────────────────────
export interface BatchItemInput {
  name?: string;
  outputName?: string;
  manifest: unknown;
}

export interface BatchStatus {
  batch: { id: string; name: string };
  completed: number;
  failed: number;
  active: number;
  queued: number;
  items: Array<{
    id: string;
    index: number;
    name: string;
    status: string;
    progress: number;
    error: string | null;
    outputUrl: string | null;
  }>;
}

export async function createBatch(name: string, items: BatchItemInput[]): Promise<string> {
  const { batchId } = await api<{ batchId: string; count: number }>("/api/batches", {
    method: "POST",
    body: JSON.stringify({ name, items }),
  });
  return batchId;
}

export function getBatch(batchId: string): Promise<BatchStatus> {
  return api<BatchStatus>(`/api/batches/${batchId}`);
}

/** URL for the zip of all completed outputs in a batch. */
export function batchDownloadUrl(batchId: string): string {
  return `${BASE}/api/batches/${batchId}/download`;
}
