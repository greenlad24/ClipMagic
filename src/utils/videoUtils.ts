import { uploadFile } from 'zite-file-upload-sdk';

const TARGET_SR = 16000;
export const CHUNK_BYTES = 20 * 1024 * 1024; // 20 MB per chunk — under Zite's 25 MB limit

/** Read a File as ArrayBuffer via FileReader */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('FileReader error: ' + (reader.error?.message ?? 'unknown')));
    reader.readAsArrayBuffer(file);
  });
}

/** Mix all channels to mono and linearly resample to TARGET_SR */
function resampleMono(buf: AudioBuffer): Float32Array {
  const ratio = buf.sampleRate / TARGET_SR;
  const len = Math.ceil(buf.length / ratio);
  const out = new Float32Array(len);
  const nch = buf.numberOfChannels;
  const chData: Float32Array[] = [];
  for (let c = 0; c < nch; c++) chData.push(buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, buf.length - 1);
    const t = src - lo;
    let s = 0;
    for (let c = 0; c < nch; c++) s += chData[c][lo] * (1 - t) + chData[c][hi] * t;
    out[i] = s / nch;
  }
  return out;
}

/** Encode Float32 PCM as a 16-bit mono WAV blob */
function makeWAV(pcm: Float32Array, sr: number): Blob {
  const n = pcm.length;
  const ab = new ArrayBuffer(44 + n * 2);
  const v = new DataView(ab);
  const ws = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/**
 * Decode the audio track of a video file and return a 16 kHz mono WAV blob.
 */
export async function extractAudio(file: File): Promise<Blob> {
  const ab = await readFileAsArrayBuffer(file);
  const ctx = new AudioContext();
  try {
    const decoded = await new Promise<AudioBuffer>((res, rej) =>
      ctx.decodeAudioData(ab, res, rej)
    );
    return makeWAV(resampleMono(decoded), TARGET_SR);
  } finally {
    await ctx.close();
  }
}

/**
 * Upload a Blob to Zite's built-in file storage.
 * Returns a permanent URL usable anywhere.
 */
export async function uploadBlobToZite(blob: Blob, filename: string): Promise<string> {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${Date.now()}_${safe}`;
  const { fileUrl } = await uploadFile({ data: blob, filename: key });
  return fileUrl;
}

/** @deprecated Use uploadBlobToZite instead */
export const uploadBlobToR2 = uploadBlobToZite;

/**
 * Upload a File in 20 MB chunks to Zite storage.
 * Each chunk is uploaded separately (stays under the 25 MB per-file limit).
 * Calls onProgress(done, total) after each chunk completes.
 * Returns an array of permanent Zite URLs in order.
 */
export async function uploadVideoChunks(
  file: File,
  onProgress: (done: number, total: number) => void,
): Promise<string[]> {
  const total = Math.ceil(file.size / CHUNK_BYTES);
  if (total === 0) throw new Error('File appears to be empty — please choose a valid video file');
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const ext = file.name.split('.').pop() ?? 'mp4';
  const urls: string[] = [];
  for (let i = 0; i < total; i++) {
    const slice = file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    const chunkName = `${baseName}_part${String(i + 1).padStart(3, '0')}.${ext}`;
    const chunkBlob = new Blob([slice], { type: file.type || 'video/mp4' });
    const url = await uploadBlobToZite(chunkBlob, chunkName);
    if (!url) throw new Error(`Chunk ${i + 1} upload returned an empty URL — please retry`);
    urls.push(url);
    onProgress(i + 1, total);
  }
  return urls;
}
