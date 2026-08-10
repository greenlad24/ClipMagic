/**
 * Read one of OUR OWN media files for the bundled pipeline (aliased to the bare
 * specifier `clipmagic-local-files` — see scripts/build-pipeline.mjs, the same
 * mechanism as `clipmagic-run-accounting`).
 *
 * The app source in lab/src was written for a browser, so it reached its media
 * with `fetch(project.audioUrl)`. Bundled into the server that became an HTTP
 * round-trip from the box to itself — and every way of writing that url has now
 * stopped working, for three different reasons:
 *
 *   "/api/uploads/<id>"                    → Node's fetch rejects a relative URL
 *                                            ("Failed to parse URL from …").
 *                                            This is what "choose from storage"
 *                                            stores, via listStorage.
 *   "https://lab.jakedaw.com/api/…"        → 401. /api/uploads sits behind the
 *                                            API_TOKEN gate and a self-fetch
 *                                            carries no token.
 *   "http://139.59.250.178:9090/api/…"     → ECONNREFUSED. Older uploads recorded
 *                                            the raw droplet URL, back when 9090
 *                                            was published; it is 127.0.0.1-only
 *                                            now.
 *
 * All three name a file already sitting on this filesystem, so the round-trip
 * was never buying anything — it was dragging multi-gigabyte narration videos
 * through our own reverse proxy to reach the local disk. `resolveInput` maps
 * every one of those forms (its uploads/outputs match is substring-based, so an
 * absolute self-URL resolves locally too) to a path, and still downloads a
 * genuinely remote URL to the cache. So this is strictly more capable than the
 * fetch it replaces, and immune to both the auth gate and the closed port.
 */
import fs from "node:fs";
import { resolveInput } from "../render/resolve.js";

/** Does this ref name a file of OURS (rather than a third-party asset)? */
function isOurMediaUrl(ref: string): boolean {
  return /\/(?:api\/)?(?:uploads|outputs)\//.test(ref);
}

/**
 * Resolve `ref` — an upload/output URL (relative or absolute), a bare file id,
 * a local path, or a remote URL — and return its bytes. Throws if it cannot be
 * resolved, which the caller turns into the project's error state.
 */
export async function readProjectMedia(ref: string): Promise<Buffer> {
  try {
    const abs = await resolveInput(ref);
    return await fs.promises.readFile(abs);
  } catch (e) {
    // resolveInput falls through to a remote download when one of OUR urls has
    // no local file — so a project whose upload was deleted long ago reports
    // "fetch failed", which reads like a network problem and sends you looking
    // in the wrong place. Say what actually happened.
    if (isOurMediaUrl(ref)) {
      throw new Error(
        `the media for this project is no longer on disk (${ref}) — it was deleted from storage, so there is nothing left to transcribe`,
      );
    }
    throw e;
  }
}
