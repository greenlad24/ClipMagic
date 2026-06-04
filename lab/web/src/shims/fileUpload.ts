/**
 * Drop-in replacement for Zite's `zite-file-upload-sdk`.
 *
 * The original `uploadFile({ data, filename })` returned `{ fileUrl }`. Here it
 * streams the blob to the self-hosted server's uncapped upload endpoint and
 * returns the served URL, so the 25MB Zite cap is gone and storage is local.
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

/**
 * Upload via XMLHttpRequest (not fetch) so we get REAL upload progress and can
 * detect a stalled connection. A bare fetch() reports nothing while the body
 * streams, so a slow/large file looks frozen on "Uploading…" forever and a
 * mid-flight stall never surfaces. Here:
 *   • upload.onprogress drives the caller's progress %;
 *   • a watchdog aborts with a clear error if NO bytes move for STALL_MS;
 *   • network errors / non-2xx responses reject with a readable message.
 */
const STALL_MS = 60_000;

export async function uploadFile(args: UploadFileArgs): Promise<UploadFileResult> {
  const form = new FormData();
  form.append("files", toBlob(args.data), args.filename);

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
      if (e.lengthComputable) args.onProgress?.(e.loaded / e.total);
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
            args.onProgress?.(1);
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
