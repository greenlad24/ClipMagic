/**
 * Chromium locator for the Auto-Screencast capture engine.
 *
 * The screencast engine drives a headless Chromium via puppeteer-core. We REUSE
 * whatever Chromium the container already has — never download one. The wrinkle
 * this module handles: the configured REMOTION_BROWSER_EXECUTABLE can point at a
 * *wrapper* that isn't actually launchable here (e.g. Ubuntu's
 * /usr/bin/chromium-browser snap shim, which exits with "requires the chromium
 * snap"). So we build an ORDERED candidate list and let the caller launch the
 * first that works and remember it.
 *
 * Candidates, in priority order:
 *   1. CAPTURE_BROWSER_EXECUTABLE / REMOTION_BROWSER_EXECUTABLE (explicit config)
 *   2. A Chromium Remotion already downloaded under server node_modules
 *      (.remotion/.chromium/.../chrome) — a real, verified binary in the image.
 *   3. A Playwright-style /opt browser if present.
 *   4. Common system paths (/usr/bin/chromium, google-chrome, …).
 *
 * Flags + the static path list are CONSTANTS at the top of the file so they're
 * trivial to tweak for a different container.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Chromium launch flags. Headless in a container with no sandbox (we run as root
 * in Docker) and with /dev/shm worked around — the same hardening every headless
 * Chromium needs on a small box. Tweak here if a host needs different flags.
 */
export const CHROMIUM_ARGS: string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  // This is a SCREENSHOT tool, not a browser session — never enter or transmit
  // anything. Ignoring cert errors lets us still capture a page behind a
  // TLS-intercepting proxy / self-signed cert instead of failing the whole shot.
  "--ignore-certificate-errors",
];

/** Static system paths to try last (the snap shim is last — often non-functional). */
const SYSTEM_CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/usr/bin/chromium-browser",
];

/** Scan known roots for a Remotion-downloaded Chromium binary. */
function remotionChromiumCandidates(): string[] {
  const out: string[] = [];
  // Remotion stores its managed browser as
  // <node_modules>/.remotion/.chromium/<platform>/chrome-linux/chrome.
  const roots = [
    path.resolve(config.serverRoot, "node_modules", ".remotion", ".chromium"),
    path.resolve(config.serverRoot, "..", "remotion", "node_modules", ".remotion", ".chromium"),
    path.resolve(config.dataDir, ".remotion-chromium", "chrome"),
  ];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const platform of fs.readdirSync(root)) {
        const exe = path.join(root, platform, "chrome-linux", "chrome");
        if (fs.existsSync(exe)) out.push(exe);
      }
    } catch {
      /* ignore unreadable roots */
    }
  }
  return out;
}

/**
 * Ordered, de-duplicated list of Chromium executables to TRY. The caller
 * launches the first that works. We only stat-check DISCOVERED paths (explicit
 * env values are kept even if existence can't be confirmed, since a PATH-relative
 * name may still resolve at launch).
 */
export function chromiumCandidates(): string[] {
  const explicit = [
    process.env.CAPTURE_BROWSER_EXECUTABLE,
    process.env.REMOTION_BROWSER_EXECUTABLE,
  ].filter((p): p is string => !!p);

  const ordered = [...explicit, ...remotionChromiumCandidates(), ...SYSTEM_CHROMIUM_PATHS];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of ordered) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (explicit.includes(p) || fs.existsSync(p)) out.push(p);
  }
  return out;
}

/**
 * True when at least one Chromium candidate exists on disk — the cheap probe
 * getServiceStatus uses to report `screencastConfigured`. (Whether it actually
 * LAUNCHES is only knowable at capture time; existence is the honest fast read.)
 */
export function chromiumAvailable(): boolean {
  return chromiumCandidates().some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}
