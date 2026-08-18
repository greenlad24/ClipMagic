/**
 * Public asset drop for provider fetches.
 *
 * WHY THIS EXISTS: the avatar/lipsync APIs take `image_url` and `audio_url` and
 * fetch them with their own HTTP client. That client has no Google session, so
 * every route behind `requireSession` — which is all of them — is a 302 to a
 * login page as far as kie.ai is concerned. The portrait and the narration have
 * to be reachable without a cookie or the provider cannot see them.
 *
 * THE TRADE, STATED PLAINLY: files published here are readable by anyone who
 * has the URL. The protection is unguessability — a 32-hex-character random
 * directory name (128 bits, same order as a UUIDv4) — plus a TTL sweep. That is
 * the standard "capability URL" pattern and it is appropriate for exactly what
 * goes here: a synthetic portrait and a TTS clip that are both about to be
 * published as a video anyway.
 *
 * RULES, so this stays a small hole and not a large one:
 *   • Only ever publish provider INPUTS. Never a user upload, never a DB
 *     export, never anything from uploadsDir/outputsDir.
 *   • Publish a COPY. Nothing here is a symlink into the real data dirs, so a
 *     path-traversal bug in the static handler cannot walk into them.
 *   • Everything expires (config.publicAssetTtlMs, default 24h) and is swept on
 *     every publish, so the window is hours rather than forever.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

/** URL prefix this drop is mounted at, BEFORE the auth gate. See index.ts. */
export const PUBLIC_ASSET_ROUTE = "/public-assets";

function ensureDir(): string {
  fs.mkdirSync(config.publicAssetsDir, { recursive: true });
  return config.publicAssetsDir;
}

/**
 * Sanitise a caller-supplied basename down to something that cannot escape its
 * token directory. The token already makes the path unguessable; this makes it
 * unambiguous.
 */
function safeName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base && base !== "." && base !== ".." ? base.slice(0, 80) : "asset";
}

/**
 * Delete token directories older than the TTL. Called on every publish rather
 * than on a timer: publishes are the only thing that creates work here, so they
 * are the natural place to pay for it, and there is no interval to leak on a
 * hot reload. Best-effort — a sweep failure must never fail a render.
 */
export function pruneExpired(now = Date.now()): number {
  const root = ensureDir();
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      const st = fs.statSync(dir);
      if (now - st.mtimeMs > config.publicAssetTtlMs) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* raced with another sweep — fine */
    }
  }
  return removed;
}

export interface PublishedAsset {
  /** Absolute URL handed to the provider. */
  url: string;
  /** On-disk path of the published copy, so the caller can revoke it early. */
  file: string;
  /** The random directory name — the capability itself. */
  token: string;
}

/**
 * Copy `sourceFile` into the public drop under a fresh random token and return
 * the absolute URL a provider can fetch.
 *
 * Requires `config.publicBaseUrl` (PUBLIC_BASE_URL). Without it we cannot build
 * an absolute URL that resolves from the open internet, and a relative one would
 * fail inside the provider with a confusing error — so this throws early with
 * the actionable message instead.
 */
export function publishForProvider(sourceFile: string, displayName?: string): PublishedAsset {
  const base = (config.publicBaseUrl || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "PUBLIC_BASE_URL is not set. The avatar provider fetches the portrait and narration by URL, " +
        "so this server needs to know its own public origin (e.g. https://lab.example.com).",
    );
  }

  pruneExpired();

  const root = ensureDir();
  const token = crypto.randomBytes(16).toString("hex");
  const dir = path.join(root, token);
  fs.mkdirSync(dir, { recursive: true });

  const name = safeName(displayName ?? path.basename(sourceFile));
  const file = path.join(dir, name);
  fs.copyFileSync(sourceFile, file);

  return {
    url: `${base}${PUBLIC_ASSET_ROUTE}/${token}/${encodeURIComponent(name)}`,
    file,
    token,
  };
}

/**
 * Withdraw a published asset the moment the provider is done with it, rather
 * than waiting out the TTL. Best-effort by design: the sweep is the backstop.
 */
export function revoke(token: string): void {
  if (!/^[a-f0-9]{32}$/.test(token)) return;
  try {
    fs.rmSync(path.join(config.publicAssetsDir, token), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}
