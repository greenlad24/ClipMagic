import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Upload a video from the computer as a creative edit's source — the client of
 * server/src/aieditor/uploads.ts (POST create → PUT ?offset=N chunks → POST complete).
 *
 * 3–12 GB 4K files: 32 MB chunks sent one after another with XHR (upload progress inside a
 * chunk), a failed chunk retried 3× with back-off (1 s, 3 s, 9 s), a 409 answered by
 * continuing from the server's `received` (so a retried chunk is never appended twice).
 * The upload id is kept in localStorage: after a page refresh Jake picks the same file
 * again and it continues where it stopped (matched by name + size + last-modified).
 */

export const CHUNK_BYTES = 32 * 1024 * 1024;
export const MAX_BYTES = 20 * 1024 ** 3;
export const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'];
const LS_KEY = 'autoEditor.sourceUpload';
const BACKOFF_MS = [1000, 3000, 9000];

export type UploadStatus = 'idle' | 'uploading' | 'done' | 'error' | 'interrupted';

export interface SourceUploadState {
  status: UploadStatus;
  uploadId: string | null;
  name: string;
  size: number;
  received: number;
  /** bytes per second over the last few seconds */
  rate: number | null;
  etaSec: number | null;
  error: string | null;
  /** 1–3 while a failed chunk is being retried */
  retry: number;
}

interface Saved {
  uploadId: string;
  name: string;
  size: number;
  lastModified: number;
}

const EMPTY: SourceUploadState = {
  status: 'idle', uploadId: null, name: '', size: 0, received: 0, rate: null, etaSec: null, error: null, retry: 0,
};

function load(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    return v && typeof v.uploadId === 'string' ? (v as Saved) : null;
  } catch {
    return null;
  }
}
function save(v: Saved | null) {
  try {
    if (v) localStorage.setItem(LS_KEY, JSON.stringify(v));
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* a convenience only */
  }
}

class HttpError extends Error {
  status: number;
  body: { error?: string; received?: number };
  constructor(status: number, body: { error?: string; received?: number }) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  });
  if (res.status === 401) {
    window.location.href = '/auth/google';
    throw new Error('Sign-in required');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, json);
  return json as T;
}

interface Meta {
  uploadId: string;
  name: string;
  size: number;
  received: number;
  complete: boolean;
}

/** One chunk over XHR (fetch has no upload progress). Resolves with the server's meta. */
function putChunk(
  url: string, blob: Blob, onBytes: (n: number) => void, xhrRef: { current: XMLHttpRequest | null },
): Promise<Meta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      xhrRef.current = null;
      let body: any = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        body = {};
      }
      if (xhr.status === 401) {
        window.location.href = '/auth/google';
        reject(new Error('Sign-in required'));
      } else if (xhr.status >= 200 && xhr.status < 300) resolve(body as Meta);
      else reject(new HttpError(xhr.status, body));
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      reject(new HttpError(0, { error: 'Network error' }));
    };
    xhr.onabort = () => {
      xhrRef.current = null;
      reject(new DOMException('aborted', 'AbortError'));
    };
    xhr.send(blob);
  });
}

export function checkFile(file: File): string | null {
  const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  if (!VIDEO_EXTS.includes(ext)) return `Only video files: ${VIDEO_EXTS.join(', ')}.`;
  if (file.size <= 0) return 'The file is empty.';
  if (file.size > MAX_BYTES) return 'Up to 20 GB per file.';
  return null;
}

export function useSourceUpload() {
  const [state, setState] = useState<SourceUploadState>(EMPTY);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const run = useRef(0); // bumps on cancel / a new file: an old loop stops
  const samples = useRef<{ t: number; b: number }[]>([]);
  const lastFile = useRef<File | null>(null);

  // a previous page's upload: done → usable as is; unfinished → pick the same file to continue
  useEffect(() => {
    const s = load();
    if (!s) return;
    call<Meta>('GET', `/api/aieditor/uploads/${s.uploadId}`)
      .then((m) => {
        if ((m as any).job) {
          save(null); // already used by a job
          return;
        }
        setState({
          ...EMPTY,
          status: m.complete ? 'done' : 'interrupted',
          uploadId: m.uploadId,
          name: m.name,
          size: m.size,
          received: m.received,
        });
      })
      .catch(() => save(null));
    return () => {
      run.current++;
      xhr.current?.abort();
    };
  }, []);

  const sample = (bytes: number) => {
    const t = performance.now() / 1000;
    const xs = samples.current;
    xs.push({ t, b: bytes });
    while (xs.length > 2 && t - xs[0].t > 6) xs.shift();
    const first = xs[0];
    const rate = t - first.t > 0.5 ? (bytes - first.b) / (t - first.t) : null;
    return rate;
  };

  const upload = useCallback(async (file: File, meta: Meta) => {
    const my = ++run.current;
    samples.current = [];
    let received = meta.received;
    setState({ ...EMPTY, status: 'uploading', uploadId: meta.uploadId, name: meta.name, size: meta.size, received });
    const url = (o: number) => `/api/aieditor/uploads/${meta.uploadId}?offset=${o}`;
    try {
      while (received < meta.size) {
        const end = Math.min(meta.size, received + CHUNK_BYTES);
        let attempt = 0;
        for (;;) {
          if (run.current !== my) return;
          try {
            const base = received;
            const m = await putChunk(url(base), file.slice(base, end), (n) => {
              if (run.current !== my) return;
              const rate = sample(base + n);
              setState((s) => ({
                ...s, received: base + n, rate: rate ?? s.rate,
                etaSec: rate ? (meta.size - base - n) / rate : s.etaSec, retry: attempt,
              }));
            }, xhr);
            received = m.received;
            break;
          } catch (e) {
            if (run.current !== my) return;
            if (e instanceof HttpError && e.status === 409 && typeof e.body.received === 'number') {
              received = e.body.received; // the server already has these bytes: continue from there
              break;
            }
            if (e instanceof HttpError && [400, 404, 413, 415, 507].includes(e.status) && e.body.received === undefined) throw e;
            if (attempt >= BACKOFF_MS.length) throw e;
            setState((s) => ({ ...s, retry: attempt + 1 }));
            await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
            attempt++;
            // ask where the server is (a chunk may have landed although the reply was lost)
            try {
              const st = await call<Meta>('GET', `/api/aieditor/uploads/${meta.uploadId}`);
              received = st.received;
            } catch {
              /* keep our offset; the PUT answers 409 if it is wrong */
            }
            if (received >= end) break;
          }
        }
        if (run.current !== my) return;
        setState((s) => ({ ...s, received, retry: 0 }));
      }
      const done = await call<Meta>('POST', `/api/aieditor/uploads/${meta.uploadId}/complete`);
      if (run.current !== my) return;
      setState((s) => ({ ...s, status: 'done', received: done.size, rate: null, etaSec: 0, retry: 0 }));
    } catch (e) {
      if (run.current !== my) return;
      setState((s) => ({ ...s, status: 'error', error: e instanceof Error ? e.message : String(e), retry: 0 }));
    }
  }, []);

  /** Upload `file` — continuing the saved upload when it is the same file. */
  const start = useCallback(async (file: File) => {
    const bad = checkFile(file);
    if (bad) {
      setState({ ...EMPTY, status: 'error', name: file.name, size: file.size, error: bad });
      return;
    }
    run.current++;
    xhr.current?.abort();
    lastFile.current = file;
    const s = load();
    if (s && s.name === file.name && s.size === file.size && s.lastModified === file.lastModified) {
      try {
        const m = await call<Meta>('GET', `/api/aieditor/uploads/${s.uploadId}`);
        if (!(m as any).job) {
          if (m.complete) {
            setState({ ...EMPTY, status: 'done', uploadId: m.uploadId, name: m.name, size: m.size, received: m.size });
            return;
          }
          void upload(file, m);
          return;
        }
      } catch {
        /* expired: start over */
      }
    } else if (s) {
      // a different file: the unfinished one is not coming back
      void call('DELETE', `/api/aieditor/uploads/${s.uploadId}`).catch(() => undefined);
      save(null);
    }
    try {
      setState({ ...EMPTY, status: 'uploading', name: file.name, size: file.size });
      const m = await call<Meta>('POST', '/api/aieditor/uploads', { name: file.name, size: file.size });
      save({ uploadId: m.uploadId, name: file.name, size: file.size, lastModified: file.lastModified });
      void upload(file, m);
    } catch (e) {
      setState({ ...EMPTY, status: 'error', name: file.name, size: file.size, error: e instanceof Error ? e.message : String(e) });
    }
  }, [upload]);

  /** Stop and throw the upload away (server folder included). */
  const cancel = useCallback(() => {
    run.current++;
    xhr.current?.abort();
    const id = state.uploadId ?? load()?.uploadId;
    if (id) void call('DELETE', `/api/aieditor/uploads/${id}`).catch(() => undefined);
    save(null);
    setState(EMPTY);
  }, [state.uploadId]);

  /** Try again with the same file (continues from what the server has). */
  const retry = useCallback(() => {
    if (lastFile.current) void start(lastFile.current);
  }, [start]);

  /** The job took it: forget it here. */
  const consumed = useCallback(() => {
    save(null);
  }, []);

  return { state, start, cancel, consumed, retry, canRetry: !!lastFile.current };
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}
