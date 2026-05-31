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

export async function uploadFile(args: UploadFileArgs): Promise<UploadFileResult> {
  const form = new FormData();
  form.append("files", toBlob(args.data), args.filename);
  const res = await fetch("/api/uploads", { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { files: Array<{ id: string; url: string }> };
  const f = json.files[0];
  return { fileUrl: f.url, fileId: f.id };
}
