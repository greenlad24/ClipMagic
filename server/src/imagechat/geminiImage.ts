/**
 * The Gemini image models, and how to get an image back out of a response.
 *
 * In the lab this lived in `thumbnails/nanoBanana.ts` + `thumbnails/imageProviders.ts`
 * alongside the Thumbnail Designer's own machinery (a thumbnail output
 * directory, provider selection, 4K request config, edit-result shaping). None
 * of that is reachable from the avatar path, which calls `generateChatImage()`
 * and gets base64 back, so only these pieces were carried over.
 *
 * Each model id is isolated behind one env-overridable constant so a Google
 * rename is a config change rather than a rebuild — Google has renamed these
 * before.
 */

/** Gemini 2.5 Flash Image ("Nano Banana") — the cheap, fast image model. */
export const NANO_BANANA_MODEL = process.env.NANO_BANANA_MODEL || "gemini-2.5-flash-image";

/**
 * Gemini 3 Pro Image ("Nano Banana Pro") — the sharpest, best-likeness option
 * and the one every avatar image step actually uses. Portraits, the 20-view
 * character sheet and room placement all go through this: likeness is the whole
 * job, and the flash models drift.
 */
export const NANO_BANANA_PRO_MODEL = process.env.NANO_BANANA_PRO_MODEL || "gemini-3-pro-image";

/** Gemini 3.1 Flash Image — a newer flash alternative, selectable in the UI. */
export const NANO_BANANA_FLASH_31_MODEL =
  process.env.NANO_BANANA_FLASH_31_MODEL || "gemini-3.1-flash-image";

/** One input image for a generate/edit call: raw bytes + its mime type. */
export interface EditImage {
  data: Buffer;
  mimeType: string;
}

/**
 * Pull the generated image out of a Gemini response.
 *
 * Two wrinkles the naive version gets wrong: the API returns `inline_data` or
 * `inlineData` depending on the surface, and a thinking model emits INTERMEDIATE
 * images marked `thought: true`. The last non-thought part is the real output —
 * take the last thought image only if there is nothing else, so a response that
 * is all thinking still yields something rather than null.
 */
export function extractInlineImage(json: any): { data: Buffer; mimeType: string } | null {
  const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
  const toImg = (p: any): { data: Buffer; mimeType: string } | null => {
    const inline = p?.inline_data ?? p?.inlineData;
    if (!inline?.data) return null;
    return {
      data: Buffer.from(inline.data, "base64"),
      mimeType: inline.mime_type ?? inline.mimeType ?? "image/png",
    };
  };
  let finalImg: { data: Buffer; mimeType: string } | null = null;
  let lastImg: { data: Buffer; mimeType: string } | null = null;
  for (const p of parts) {
    const img = toImg(p);
    if (!img) continue;
    lastImg = img;
    if (p?.thought !== true) finalImg = img; // the final image is not a "thought"
  }
  return finalImg ?? lastImg ?? null;
}
