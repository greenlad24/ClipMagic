/**
 * Browser-based video renderer — the AUTHORITATIVE export path.
 *
 * Renders narration video + image/video overlays + subtitles + music
 * onto a canvas and records with MediaRecorder.
 *
 * FPS: Targets 30fps via captureStream(30). Actual fps depends on browser
 * scheduling — this is best-effort, not deterministic CFR. Motion timing
 * is visually correct (real-time capture).
 *
 * Screencast reliability:
 * - Every overlay clip is pre-validated (fetch + decode) before render starts
 * - Failed clips are reported with exact shot ID + reason
 * - Export is aborted if required screencasts cannot load
 *
 * Narrator-first pacing:
 * - Non-talking-head shots may have showNarratorFirst + overlayDelaySeconds metadata
 * - The narrator stays visible for that delay before the overlay enters
 * - clipStartOffset / clipEndOffset control the exact promo segment shown
 */

import { TimelineShot, SubtitleEvent, CameraKeyframe } from '@/components/timeline/types';

export interface RenderProgress {
  pct: number;   // 0–1
  label: string;
}

export interface PreflightResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
  /** Per-shot diagnostics for overlay clips */
  clipReport: ClipDiagnostic[];
}

export interface ClipDiagnostic {
  shotId: string;
  shotType: string;
  caption: string;
  clipUrl: string;
  status: 'ok' | 'missing' | 'unreachable' | 'error';
  detail: string;
}

export interface RenderDiagnostics {
  targetFps: number;
  actualMode: string;
  videoDurationSeconds: number;
  wallTimeSeconds: number;
  totalOverlayShots: number;
  overlaysLoaded: number;
  overlaysFailed: number;
  failedShots: Array<{ shotId: string; shotType: string; reason: string }>;
  outputSizeMB: number;
  outputFormat: string;
}

const WIDTH  = 720;
const HEIGHT = 1280;
const FPS    = 30;

const MIN_VALID_BYTES = 1024;
const OVERLAY_FADE_IN = 0.15;

function getSupportedMimeType(): string {
  const candidates = [
    'video/mp4; codecs="avc1.42E01E,opus"',
    'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4',
    'video/webm; codecs="vp9,opus"',
    'video/webm; codecs="vp8,opus"',
    'video/webm',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) ?? '';
}

export function formatLabel(mimeType: string): 'MP4' | 'WebM' {
  return mimeType.includes('mp4') ? 'MP4' : 'WebM';
}

export function fileExtension(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function lerpKfs(kfs: CameraKeyframe[], t: number) {
  if (!kfs.length) return { zoom: 1, panX: 0, panY: 0 };
  if (t <= kfs[0].t) return kfs[0];
  for (let i = 1; i < kfs.length; i++) {
    if (t <= kfs[i].t) {
      const r = (t - kfs[i - 1].t) / (kfs[i].t - kfs[i - 1].t);
      return {
        zoom: lerp(kfs[i - 1].zoom, kfs[i].zoom, r),
        panX: lerp(kfs[i - 1].panX, kfs[i].panX, r),
        panY: lerp(kfs[i - 1].panY, kfs[i].panY, r),
      };
    }
  }
  return kfs[kfs.length - 1];
}

function isImageUrl(url: string): boolean {
  if (url.startsWith('data:image/')) return true;
  const clean = url.split('?')[0].toLowerCase();
  return /\.(png|jpg|jpeg|webp|gif|avif|bmp|svg)$/.test(clean);
}

function mimeFromUrl(url: string): string {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.mp4'))  return 'video/mp4';
  if (clean.endsWith('.webm')) return 'video/webm';
  if (clean.endsWith('.mov'))  return 'video/quicktime';
  if (clean.endsWith('.png'))  return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.gif'))  return 'image/gif';
  if (clean.endsWith('.webp')) return 'image/webp';
  return '';
}

async function tryFetchBlobUrl(url: string, timeoutMs = 30000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const raw = await res.blob();
    const mime = mimeFromUrl(url) || raw.type;
    const blob = mime && raw.type !== mime ? new Blob([raw], { type: mime }) : raw;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

async function loadVideo(
  url: string,
  timeoutMs = 30000,
  onBlobFetched?: (blobUrl: string) => void,
): Promise<{ el: HTMLVideoElement; blobUrl: string | null } | null> {
  const blobUrl = await tryFetchBlobUrl(url, timeoutMs * 0.6);
  const src = blobUrl ?? url;
  if (blobUrl && onBlobFetched) onBlobFetched(blobUrl);
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    if (!blobUrl) v.crossOrigin = 'anonymous';
    const t = setTimeout(() => resolve(null), timeoutMs * 0.4);
    v.onloadeddata = () => { clearTimeout(t); resolve({ el: v, blobUrl }); };
    v.onerror      = () => { clearTimeout(t); resolve(null); };
    v.src = src;
  });
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  const blobUrl = await tryFetchBlobUrl(url, 15000);

  if (blobUrl) {
    return new Promise(resolve => {
      const img = new Image();
      const t = setTimeout(() => resolve(null), 12000);
      img.onload  = () => { clearTimeout(t); resolve(img); };
      img.onerror = () => { clearTimeout(t); resolve(null); };
      img.src = blobUrl;
    });
  }

  // Try with crossOrigin first
  const withCors = await new Promise<HTMLImageElement | null>(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const t = setTimeout(() => resolve(null), 8000);
    img.onload  = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
  if (withCors) return withCors;

  // Fallback: no crossOrigin (taints canvas but still renders)
  console.warn(`[export] Loading image ${url.slice(0, 60)} without crossOrigin (CORS fallback)`);
  return new Promise(resolve => {
    const img = new Image();
    const t = setTimeout(() => resolve(null), 10000);
    img.onload  = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
}

async function loadOverlayVideo(url: string): Promise<HTMLVideoElement | null> {
  const blobUrl = await tryFetchBlobUrl(url, 20000);

  // If we have a blob URL, it's same-origin — no CORS issues
  if (blobUrl) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      const t = setTimeout(() => resolve(null), 20000);
      v.onloadeddata = () => { clearTimeout(t); resolve(v); };
      v.onerror      = () => { clearTimeout(t); resolve(null); };
      v.src = blobUrl;
    });
  }

  // No blob URL (fetch failed, likely CORS).
  // Try with crossOrigin first (keeps canvas clean).
  const withCors = await new Promise<HTMLVideoElement | null>(resolve => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const t = setTimeout(() => resolve(null), 12000);
    v.onloadeddata = () => { clearTimeout(t); resolve(v); };
    v.onerror      = () => { clearTimeout(t); resolve(null); };
    v.src = url;
  });
  if (withCors) return withCors;

  // Fallback: load WITHOUT crossOrigin (taints canvas but captureStream still works)
  console.warn(`[export] Loading ${url.slice(0, 60)} without crossOrigin (CORS fallback)`);
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const t = setTimeout(() => resolve(null), 15000);
    v.onloadeddata = () => { clearTimeout(t); resolve(v); };
    v.onerror      = () => { clearTimeout(t); resolve(null); };
    v.src = url;
  });
}

function drawCoverFit(ctx: CanvasRenderingContext2D, src: HTMLImageElement | HTMLVideoElement, x: number, y: number, w: number, h: number) {
  const sw = src instanceof HTMLVideoElement ? src.videoWidth  : src.naturalWidth;
  const sh = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight;
  if (!sw || !sh) { ctx.drawImage(src, x, y, w, h); return; }
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawSubtitle(
  ctx: CanvasRenderingContext2D,
  sub: SubtitleEvent,
  W: number,
  H: number,
  placement: 'center' | 'bottom-left' = 'center',
) {
  const baseFontSize = placement === 'bottom-left' ? Math.round(H * 0.026) : Math.round(H * 0.036);
  const emphFontSize = Math.round(baseFontSize * 1.38);
  const maxLineW = placement === 'bottom-left' ? W * 0.90 : W * 0.86;
  const ACCENT = '#c084fc';

  type WordItem = { text: string; emphasis: boolean; fontSize: number };
  const items: WordItem[] = sub.words.map(w => ({
    text: w.text,
    emphasis: w.emphasis,
    fontSize: w.emphasis ? emphFontSize : baseFontSize,
  }));

  type RenderedLine = { items: WordItem[]; lineH: number; totalW: number };
  const lines: RenderedLine[] = [];
  let curItems: WordItem[] = [];
  let curW = 0;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    ctx.font = `bold ${item.fontSize}px sans-serif`;
    const spacing = idx < items.length - 1 ? 6 : 0;
    const tw = ctx.measureText(item.text).width + spacing;
    if (curW + tw > maxLineW && curItems.length > 0) {
      const lineH = Math.max(...curItems.map(i => i.fontSize)) * 1.35;
      lines.push({ items: curItems, lineH, totalW: curW });
      curItems = [item]; curW = tw;
    } else {
      curItems.push(item); curW += tw;
    }
  }
  if (curItems.length > 0) {
    const lineH = Math.max(...curItems.map(i => i.fontSize)) * 1.35;
    lines.push({ items: curItems, lineH, totalW: curW });
  }

  const totalH = lines.reduce((sum, l) => sum + l.lineH, 0);

  const startX = placement === 'bottom-left' ? W * 0.04 : 0;
  let y = placement === 'bottom-left'
    ? H * 0.88 - totalH
    : H * 0.5 - totalH / 2;

  ctx.save();
  for (const line of lines) {
    const x0 = placement === 'bottom-left' ? startX : (W - line.totalW) / 2;
    let x = x0;
    const midY = y + line.lineH / 2;

    for (let wi = 0; wi < line.items.length; wi++) {
      const item = line.items[wi];
      ctx.font = `bold ${item.fontSize}px sans-serif`;
      const spacing = wi < line.items.length - 1 ? 6 : 0;
      const tw = ctx.measureText(item.text).width + spacing;

      ctx.shadowColor = 'rgba(0,0,0,0.98)';
      ctx.shadowBlur  = 14;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = item.emphasis ? ACCENT : '#ffffff';
      ctx.fillText(item.text, x, midY);
      x += tw;
    }
    y += line.lineH;
  }
  ctx.restore();
}

// ── Shot metadata parsing ─────────────────────────────────────────────────────

interface OverlayMeta {
  clipStartOffset: number;
  clipEndOffset: number;       // 0 = no end clamp
  overlayDelay: number;        // seconds to wait (narrator-first pacing)
  showNarratorFirst: boolean;
  returnToNarrator: boolean;   // return to narrator before beat ends
  narratorReturnLead: number;  // seconds before beat end to cut back to narrator
  isRequiredTacticalBroll: boolean;
}

function parseOverlayMeta(uiLabelsJson: string | undefined): OverlayMeta {
  const defaults: OverlayMeta = {
    clipStartOffset: 0, clipEndOffset: 0, overlayDelay: 0,
    showNarratorFirst: false, returnToNarrator: false, narratorReturnLead: 0,
    isRequiredTacticalBroll: false,
  };
  if (!uiLabelsJson) return defaults;
  try {
    const lbl = JSON.parse(uiLabelsJson);
    return {
      clipStartOffset: typeof lbl.clipStartOffset === 'number' ? lbl.clipStartOffset : 0,
      clipEndOffset: typeof lbl.clipEndOffset === 'number' ? lbl.clipEndOffset : 0,
      overlayDelay: (lbl.showNarratorFirst && typeof lbl.overlayDelaySeconds === 'number') ? lbl.overlayDelaySeconds : 0,
      showNarratorFirst: lbl.showNarratorFirst === true,
      returnToNarrator: lbl.returnToNarratorBeforeEnd === true,
      narratorReturnLead: typeof lbl.narratorReturnLeadSeconds === 'number' ? lbl.narratorReturnLeadSeconds : 0,
      isRequiredTacticalBroll: lbl.isRequiredTacticalBroll === true || lbl.isRequiredTacticalSlot === true,
    };
  } catch {
    return defaults;
  }
}

type OverlayPhase = 'narrator-first' | 'overlay-visible' | 'narrator-return';

function getOverlayPhase(beatElapsed: number, beatDuration: number, meta: OverlayMeta): OverlayPhase {
  if (beatElapsed < meta.overlayDelay) return 'narrator-first';
  if (meta.returnToNarrator && meta.narratorReturnLead > 0) {
    const returnStart = beatDuration - meta.narratorReturnLead;
    if (beatElapsed >= returnStart) return 'narrator-return';
  }
  return 'overlay-visible';
}

// ── Preflight Validation (strict — validates each clip) ───────────────────────

/** Check if a URL is reachable. Tries fetch first; on CORS failure, falls back to media element probe. */
async function checkClipReachable(url: string): Promise<string | null> {
  // Step 1: Try fetch (may fail due to CORS on uploads.zite.com etc.)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return `HTTP ${res.status}`;
    const cl = res.headers.get('content-length');
    if (cl && parseInt(cl) === 0) return 'Empty file (0 bytes)';
    return null; // fetch succeeded
  } catch {
    // fetch failed (likely CORS) — fall through to media element probe
  }

  // Step 2: Fall back to <video> or <img> element load WITHOUT crossOrigin
  // (crossOrigin='anonymous' triggers CORS enforcement on media elements too;
  //  omitting it lets the browser load the media freely — canvas gets tainted
  //  but captureStream + MediaRecorder still works)
  return new Promise<string | null>((resolve) => {
    const isImg = isImageUrl(url);
    const timeout = setTimeout(() => resolve('Timeout (media probe, 20s)'), 20000);

    if (isImg) {
      const img = new Image();
      // No crossOrigin — avoids CORS enforcement on the element
      img.onload = () => { clearTimeout(timeout); resolve(null); };
      img.onerror = () => { clearTimeout(timeout); resolve('Image URL is not reachable'); };
      img.src = url;
    } else {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      // No crossOrigin — avoids CORS enforcement on the element
      v.onloadeddata = () => { clearTimeout(timeout); resolve(null); };
      v.onerror = () => { clearTimeout(timeout); resolve('Video URL is not reachable'); };
      v.src = url;
    }
  });
}

export async function preflightValidation(
  narrationUrl: string | undefined,
  shots: TimelineShot[],
  subtitles: SubtitleEvent[],
  duration: number,
  onProgress?: (label: string) => void,
): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const clipReport: ClipDiagnostic[] = [];

  if (!narrationUrl) {
    errors.push('No narration video URL — cannot export.');
  }

  const mimeType = getSupportedMimeType();
  if (!mimeType) {
    errors.push('Your browser does not support any MediaRecorder format. Please use Google Chrome.');
  }

  if (duration <= 0) {
    errors.push('Duration is 0 — nothing to export.');
  }

  if (subtitles.length === 0 && duration > 3) {
    warnings.push('No subtitles found — the export will have no captions.');
  }

  const errorShots = shots.filter(s => s.captureStatus === 'Error');
  if (errorShots.length > 0) {
    warnings.push(`${errorShots.length} shot${errorShots.length > 1 ? 's' : ''} have Error status.`);
  }

  // ── Validate each overlay clip ──────────────────────────────────────────────
  const overlayShots = shots.filter(s => s.shotType !== 'Talking Head');
  let clipIndex = 0;

  for (const s of overlayShots) {
    clipIndex++;
    const caption = (s.caption ?? '').slice(0, 60);
    const shotType = s.shotType ?? 'Unknown';

    if (!s.clipUrl) {
      // Shot has no clip at all
      if (s.captureStatus === 'Done') {
        // captureStatus says Done but no URL — something is wrong
        errors.push(`Shot ${s.id.slice(0, 8)} (${shotType}): captureStatus is "Done" but clipUrl is empty.`);
        clipReport.push({ shotId: s.id, shotType, caption, clipUrl: '', status: 'missing', detail: 'captureStatus=Done but no clipUrl' });
      } else {
        errors.push(`Shot ${s.id.slice(0, 8)} (${shotType}): no clip URL. Generate media before exporting.`);
        clipReport.push({ shotId: s.id, shotType, caption, clipUrl: '', status: 'missing', detail: 'No clipUrl — generate media first' });
      }
      continue;
    }

    // Validate reachability
    onProgress?.(`Validating clip ${clipIndex}/${overlayShots.length}…`);
    const err = await checkClipReachable(s.clipUrl);
    if (err) {
      errors.push(`Shot ${s.id.slice(0, 8)} (${shotType}): clip unreachable — ${err}`);
      clipReport.push({ shotId: s.id, shotType, caption, clipUrl: s.clipUrl, status: 'unreachable', detail: err });
    } else {
      // Validate clip offset sanity
      const meta = parseOverlayMeta(s.uiLabelsJson);
      if (meta.clipEndOffset > 0 && meta.clipStartOffset >= meta.clipEndOffset) {
        warnings.push(`Shot ${s.id.slice(0, 8)} (${shotType}): clipStartOffset (${meta.clipStartOffset}) >= clipEndOffset (${meta.clipEndOffset}) — clip may not render correctly.`);
      }
      clipReport.push({ shotId: s.id, shotType, caption, clipUrl: s.clipUrl, status: 'ok', detail: 'Reachable' });
    }
  }

  return { ok: errors.length === 0, warnings, errors, clipReport };
}

// ── Main Renderer (real-time, captureStream ~30fps) ───────────────────────────

export async function renderInBrowser(
  narrationUrl: string,
  musicUrl: string | undefined,
  shots: TimelineShot[],
  subtitles: SubtitleEvent[],
  duration: number,
  onProgress: (p: RenderProgress) => void,
  videoChunksJson?: string,
  musicVolume = 0.18,
): Promise<{ blob: Blob; diagnostics: RenderDiagnostics }> {
  const blobUrls: string[] = [];
  const track = (u: string | null) => { if (u) blobUrls.push(u); return u; };
  const renderStart = performance.now();
  const failedShots: Array<{ shotId: string; shotType: string; reason: string }> = [];

  try {
    // --- Reassemble narration from chunks (or use direct URL as fallback) ---
    let narrationVideoUrl = narrationUrl;
    let chunkUrls: string[] = [];
    try { if (videoChunksJson) chunkUrls = JSON.parse(videoChunksJson); } catch { /* */ }

    if (chunkUrls.length) {
      const buffers: ArrayBuffer[] = [];
      for (let i = 0; i < chunkUrls.length; i++) {
        onProgress({ pct: 0.01 + (i / chunkUrls.length) * 0.08, label: `Downloading chunk ${i + 1} / ${chunkUrls.length}…` });
        const res = await fetch(chunkUrls[i]);
        if (!res.ok) throw new Error(`Failed to download video chunk ${i + 1} (${res.status})`);
        buffers.push(await res.arrayBuffer());
      }
      const assembledBlob = new Blob(buffers, { type: 'video/mp4' });
      narrationVideoUrl = track(URL.createObjectURL(assembledBlob))!;
    }

    // Load narration as blob URL to prevent canvas taint
    onProgress({ pct: 0.10, label: 'Fetching narration video…' });
    let narrationBlobUrl: string | null = null;
    if (!narrationVideoUrl.startsWith('blob:')) {
      onProgress({ pct: 0.11, label: 'Downloading narration for renderer…' });
      narrationBlobUrl = await tryFetchBlobUrl(narrationVideoUrl, 60000);
      if (narrationBlobUrl) track(narrationBlobUrl);
    }
    const narrationSrc = narrationBlobUrl ?? narrationVideoUrl;

    onProgress({ pct: 0.14, label: 'Loading narration video…' });
    const narrationResult = await loadVideo(narrationSrc, 30000);
    if (!narrationResult) throw new Error('Narration video failed to load. Check your network connection.');
    const narration = narrationResult.el;

    // --- Pre-load overlay clips (strict — track failures) ---
    const clipMedia: Record<string, HTMLImageElement | HTMLVideoElement | null> = {};
    const overlayShots = shots.filter(s => s.shotType !== 'Talking Head' && s.clipUrl);
    let overlaysLoaded = 0;

    for (let i = 0; i < overlayShots.length; i++) {
      const s = overlayShots[i];
      onProgress({ pct: 0.15 + (i / Math.max(overlayShots.length, 1)) * 0.05, label: `Loading clip ${i + 1}/${overlayShots.length} (${s.shotType ?? 'overlay'})…` });
      const url = s.clipUrl!;
      const media = isImageUrl(url)
        ? await loadImage(url)
        : await loadOverlayVideo(url);
      clipMedia[s.id] = media;
      if (!media) {
        const reason = `Failed to decode ${isImageUrl(url) ? 'image' : 'video'} clip: ${url.slice(0, 80)}`;
        failedShots.push({ shotId: s.id, shotType: s.shotType ?? 'Unknown', reason });
        console.error(`[export] ✗ Shot ${s.id} (${s.shotType}): ${reason}`);
      } else {
        overlaysLoaded++;
      }
    }

    // STRICT: If any screencast clip failed to load, abort the export
    const failedScreencasts = failedShots.filter(f => {
      const shot = shots.find(s => s.id === f.shotId);
      return shot?.shotType === 'Screencast';
    });
    if (failedScreencasts.length > 0) {
      const detail = failedScreencasts.map(f => `• ${f.shotId.slice(0, 8)}: ${f.reason}`).join('\n');
      throw new Error(
        `Export aborted: ${failedScreencasts.length} Screencast clip(s) failed to load.\n${detail}\n\n` +
        'Fix these clips before exporting. Do not silently replace Screencasts with narrator.'
      );
    }

    // Warn about failed B-Roll but don't abort
    if (failedShots.length > 0) {
      console.warn(`[export] ${failedShots.length} B-Roll overlay(s) failed to load — those beats will show narrator.`);
    }

    // Build overlay metadata maps
    const overlayMetas: Record<string, OverlayMeta> = {};
    for (const s of overlayShots) {
      overlayMetas[s.id] = parseOverlayMeta(s.uiLabelsJson);
    }

    // Pre-seek each overlay video to its segment start offset
    for (const s of overlayShots) {
      const media = clipMedia[s.id];
      const meta = overlayMetas[s.id];
      if (media instanceof HTMLVideoElement && meta.clipStartOffset > 0) {
        media.currentTime = meta.clipStartOffset;
      }
    }

    // --- Set up canvas ---
    onProgress({ pct: 0.21, label: 'Setting up canvas…' });
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d')!;

    // --- Set up audio context ---
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();

    narration.muted = false;
    const narrationSrc2 = audioCtx.createMediaElementSource(narration);
    const narrationGain = audioCtx.createGain();
    narrationGain.gain.value = 1.0;
    narrationSrc2.connect(narrationGain);
    narrationGain.connect(dest);

    // --- Music (optional) ---
    let musicEl: HTMLVideoElement | null = null;
    if (musicUrl) {
      onProgress({ pct: 0.215, label: 'Loading music…' });
      const musicResult = await loadVideo(musicUrl, 15000);
      if (musicResult) {
        try {
          musicResult.el.muted = false;
          const musicSrc = audioCtx.createMediaElementSource(musicResult.el);
          const musicGain = audioCtx.createGain();
          musicGain.gain.value = musicVolume;
          musicSrc.connect(musicGain);
          musicGain.connect(dest);
          musicEl = musicResult.el;
        } catch (e) {
          console.warn('[export] Music audio setup failed:', e);
        }
      } else {
        console.warn('[export] Music track failed to load — rendering without music.');
      }
    }

    // --- Preflight: verify recorder can start ---
    const mimeType = getSupportedMimeType();
    let videoStream: MediaStream;
    try {
      videoStream = canvas.captureStream(FPS);
    } catch {
      await audioCtx.close();
      throw new Error('Your browser blocked canvas video capture. Please use Google Chrome to export.');
    }

    const audioTracks = dest.stream.getAudioTracks();
    if (audioTracks.length) videoStream.addTrack(audioTracks[0]);

    const recorder = new MediaRecorder(videoStream, mimeType ? { mimeType } : {});
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    const blobPromise = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        if (blob.size < MIN_VALID_BYTES) {
          reject(new Error(
            `Export produced an empty file (${blob.size} bytes). ` +
            'Try using Google Chrome, or check that your narration video URL is accessible.'
          ));
        } else {
          resolve(blob);
        }
      };
      recorder.onerror = (e: any) => reject(e.error ?? new Error('MediaRecorder error'));
    });

    // --- Start playback + recording ---
    recorder.start(200);
    await audioCtx.resume();
    narration.currentTime = 0;
    if (musicEl) musicEl.currentTime = 0;
    narration.play();
    musicEl?.play();

    onProgress({ pct: 0.22, label: 'Exporting…' });

    // --- Frame loop ---
    await new Promise<void>((resolve) => {
      let lastReportedSec = -1;
      let lastActiveOverlayId: string | null = null;

      const frame = () => {
        const t = narration.currentTime;

        if (narration.ended || t >= duration - 0.1) {
          narration.pause();
          musicEl?.pause();
          recorder.stop();
          resolve();
          return;
        }

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        const activeTH = shots.find(s => s.shotType === 'Talking Head' && t >= (s.startTime ?? 0) && t < (s.endTime ?? 0));

        // Find overlay candidate, applying narrator-first delay + clipEndOffset clamping
        const overlayCandidate = shots.find(s => {
          if (s.shotType === 'Talking Head' || !s.clipUrl) return false;
          if (t < (s.startTime ?? 0) || t >= (s.endTime ?? 0)) return false;
          if (!clipMedia[s.id]) return false;
          return true;
        });

        let activeOverlay: TimelineShot | undefined;
        let currentPhase: OverlayPhase | null = null;
        if (overlayCandidate) {
          const meta = overlayMetas[overlayCandidate.id];
          const beatElapsed = t - (overlayCandidate.startTime ?? 0);
          const beatDuration = (overlayCandidate.endTime ?? 0) - (overlayCandidate.startTime ?? 0);
          currentPhase = getOverlayPhase(beatElapsed, beatDuration, meta);

          let withinClipEnd = true;
          if (meta.clipEndOffset > 0 && meta.clipStartOffset > 0) {
            const clipDuration = meta.clipEndOffset - meta.clipStartOffset;
            const overlayElapsed = beatElapsed - meta.overlayDelay;
            if (overlayElapsed > clipDuration) withinClipEnd = false;
          }

          if (currentPhase === 'overlay-visible' && withinClipEnd) {
            activeOverlay = overlayCandidate;
          }
        }

        // Narration with camera keyframe zoom/pan
        let zoom = 1, panX = 0, panY = 0;
        if (activeTH?.uiLabelsJson) {
          try {
            const kfs: CameraKeyframe[] = JSON.parse(activeTH.uiLabelsJson).cameraKeyframes ?? [];
            if (kfs.length) {
              const dur = Math.max((activeTH.endTime ?? 1) - (activeTH.startTime ?? 0), 0.01);
              const kfT = Math.min(1, (t - (activeTH.startTime ?? 0)) / dur);
              ({ zoom, panX, panY } = lerpKfs(kfs, kfT));
            }
          } catch { /* */ }
        }
        if (!activeTH && overlayCandidate && !activeOverlay) {
          try {
            if (overlayCandidate.uiLabelsJson) {
              const kfs: CameraKeyframe[] = JSON.parse(overlayCandidate.uiLabelsJson).cameraKeyframes ?? [];
              if (kfs.length) {
                const dur = Math.max((overlayCandidate.endTime ?? 1) - (overlayCandidate.startTime ?? 0), 0.01);
                const kfT = Math.min(1, (t - (overlayCandidate.startTime ?? 0)) / dur);
                ({ zoom, panX, panY } = lerpKfs(kfs, kfT));
              }
            }
          } catch { /* */ }
        }

        if (zoom === 1 && panX === 0 && panY === 0) {
          drawCoverFit(ctx, narration, 0, 0, WIDTH, HEIGHT);
        } else {
          ctx.save();
          ctx.translate(WIDTH / 2 + panX * WIDTH, HEIGHT / 2 + panY * HEIGHT);
          ctx.scale(zoom, zoom);
          ctx.translate(-WIDTH / 2, -HEIGHT / 2);
          drawCoverFit(ctx, narration, 0, 0, WIDTH, HEIGHT);
          ctx.restore();
        }

        // Overlay (b-roll / screencast)
        if (activeOverlay) {
          const media = clipMedia[activeOverlay.id];
          const meta = overlayMetas[activeOverlay.id];

          if (media instanceof HTMLVideoElement && lastActiveOverlayId !== activeOverlay.id) {
            if (lastActiveOverlayId && clipMedia[lastActiveOverlayId] instanceof HTMLVideoElement) {
              (clipMedia[lastActiveOverlayId] as HTMLVideoElement).pause();
            }
            const overlayElapsed = t - (activeOverlay.startTime ?? 0) - meta.overlayDelay;
            media.currentTime = meta.clipStartOffset + Math.max(0, overlayElapsed);
            media.play().catch(() => {});
          }
          if (lastActiveOverlayId !== activeOverlay.id) lastActiveOverlayId = activeOverlay.id;

          if (media) {
            ctx.save();
            const overlayElapsed = t - (activeOverlay.startTime ?? 0) - meta.overlayDelay;
            let alpha = Math.min(1, Math.max(0, overlayElapsed / OVERLAY_FADE_IN));
            if (meta.returnToNarrator && meta.narratorReturnLead > 0) {
              const beatDuration = (activeOverlay.endTime ?? 0) - (activeOverlay.startTime ?? 0);
              const returnStart = beatDuration - meta.narratorReturnLead;
              const beatElapsed = t - (activeOverlay.startTime ?? 0);
              const fadeOutDist = returnStart - beatElapsed;
              if (fadeOutDist < OVERLAY_FADE_IN) {
                alpha = Math.min(alpha, Math.max(0, fadeOutDist / OVERLAY_FADE_IN));
              }
            }
            ctx.globalAlpha = alpha;
            drawCoverFit(ctx, media, 0, 0, WIDTH, HEIGHT);
            ctx.restore();
          }
        } else if (lastActiveOverlayId) {
          const prevMedia = clipMedia[lastActiveOverlayId];
          if (prevMedia instanceof HTMLVideoElement) prevMedia.pause();
          lastActiveOverlayId = null;
        }

        // Subtitles
        const activeSub = subtitles.find(s => t >= s.start && t <= s.end);
        if (activeSub) {
          const subtitlePlacement = activeOverlay ? 'bottom-left' : 'center';
          drawSubtitle(ctx, activeSub, WIDTH, HEIGHT, subtitlePlacement);
        }

        const sec = Math.floor(t);
        if (sec !== lastReportedSec) {
          lastReportedSec = sec;
          onProgress({ pct: 0.22 + (t / duration) * 0.68, label: `Exporting ${t.toFixed(0)}s / ${duration.toFixed(0)}s…` });
        }

        requestAnimationFrame(frame);
      };

      requestAnimationFrame(frame);

      // Safety timeout
      setTimeout(() => {
        if (recorder.state === 'recording') {
          narration.pause(); musicEl?.pause(); recorder.stop(); resolve();
        }
      }, (duration + 15) * 1000);
    });

    await audioCtx.close();
    onProgress({ pct: 0.91, label: 'Encoding complete…' });
    const blob = await blobPromise;

    const wallTimeSeconds = (performance.now() - renderStart) / 1000;
    const diagnostics: RenderDiagnostics = {
      targetFps: FPS,
      actualMode: 'browser captureStream (best-effort ~30fps)',
      videoDurationSeconds: duration,
      wallTimeSeconds,
      totalOverlayShots: overlayShots.length,
      overlaysLoaded,
      overlaysFailed: failedShots.length,
      failedShots,
      outputSizeMB: parseFloat((blob.size / 1024 / 1024).toFixed(2)),
      outputFormat: formatLabel(blob.type),
    };

    return { blob, diagnostics };

  } finally {
    for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch { /* */ } }
  }
}
