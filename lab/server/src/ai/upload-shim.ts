/**
 * Shim for `zite-file-upload-sdk` used by some bundled backend utilities
 * (e.g. tacticalBroll). On the server, "uploads" mean writing bytes into the
 * local uploads dir and returning a served URL.
 */
import { nanoid } from "nanoid";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";
import { db } from "../db/index.js";

export async function uploadFile(args: {
  data: Blob | Buffer | ArrayBuffer | Uint8Array;
  filename: string;
}): Promise<{ fileUrl: string; fileId: string }> {
  const id = nanoid();
  const ext = path.extname(args.filename) || "";
  const stored = `${id}${ext}`;
  const abs = path.join(config.uploadsDir, stored);

  let buf: Buffer;
  const d: any = args.data;
  if (Buffer.isBuffer(d)) buf = d;
  else if (d instanceof ArrayBuffer) buf = Buffer.from(d);
  else if (d?.arrayBuffer) buf = Buffer.from(await d.arrayBuffer());
  else buf = Buffer.from(d);

  fs.writeFileSync(abs, buf);
  db.prepare(
    `INSERT INTO files (id, original, stored, mime, kind, size, duration, width, height, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, args.filename, stored, null, "other", buf.length, null, null, null, Date.now());

  const base = config.publicBaseUrl ? config.publicBaseUrl.replace(/\/+$/, "") : "";
  return { fileUrl: `${base}/api/uploads/${id}`, fileId: id };
}
