import {
  Wand2,
  Layers,
  Scissors,
  HardDrive,
  Send,
  FileText,
  Sticker,
  type LucideIcon,
} from 'lucide-react';

/**
 * The ClipMagic tool registry.
 *
 * Single source of truth for the launcher hub on `/`. To add a future tool,
 * append one entry here — the hub grid renders straight from this array. No
 * other file needs to change for a new tile to appear.
 *
 * - `status: 'live'`        → whole card links to `route` (in-app) or, when
 *   `external` is set, opens `href` in a new browser tab.
 * - `status: 'coming-soon'` → card is muted, non-clickable, shows a badge.
 *
 * `accent` maps to a chart-* theme token (see `src/index.css`) so each tool
 * gets an on-brand hue for its icon without hardcoding hex.
 */

export type ToolStatus = 'live' | 'coming-soon';

export type ToolAccent = 'primary' | 'blue' | 'green' | 'purple' | 'pink';

export interface ToolDefinition {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** In-app destination route — used for live tools that are pages here. */
  route?: string;
  /**
   * External live tools (e.g. a separately self-hosted service like Postiz)
   * open a URL in a new tab instead of navigating in-app. The URL is resolved
   * at runtime (see `resolvePostizUrl`), so `href` is filled in by the hub.
   */
  external?: boolean;
  /** Resolved external URL — set at runtime for `external` tools. */
  href?: string;
  status: ToolStatus;
  accent: ToolAccent;
  /** Short hint shown under the description (e.g. format, scope). */
  detail?: string;
}

export const TOOLS: ToolDefinition[] = [
  {
    id: 'short',
    title: 'Short-form creator',
    description: 'Turn a narration into a formula-locked 9:16 Short — beat-synced cuts, screencasts, captions.',
    icon: Wand2,
    route: '/create',
    status: 'live',
    accent: 'primary',
    detail: 'Single video',
  },
  {
    id: 'bulk',
    title: 'Bulk videos',
    description: 'Drop a batch of narrations and render many Shorts in one run, fully automated.',
    icon: Layers,
    route: '/bulk',
    status: 'live',
    accent: 'blue',
    detail: 'Batch pipeline',
  },
  {
    id: 'cutter',
    title: 'Narration Cutter',
    description: 'Strip silences, fillers and bad takes from raw narration in one pass.',
    icon: Scissors,
    route: '/cutter',
    status: 'live',
    accent: 'green',
    detail: 'Clean-up pass',
  },
  {
    id: 'meme',
    title: 'Sticker Shorts',
    description: 'Clean narration + popping captions, with funny AI stickers that pop in below the captions to land the joke.',
    icon: Sticker,
    route: '/meme',
    status: 'live',
    accent: 'pink',
    detail: 'Commentary / meme',
  },
  {
    id: 'storage',
    title: 'Storage manager',
    description: 'Browse, download and clean up every file your renders have produced.',
    icon: HardDrive,
    route: '/storage',
    status: 'live',
    accent: 'purple',
    detail: 'Files & media',
  },
  {
    id: 'postiz',
    title: 'Social poster',
    description: 'Schedule and publish your finished Shorts across social platforms with Postiz.',
    icon: Send,
    // Live only once Postiz is self-hosted and configured — the hub resolves the
    // URL at runtime from the server (see `resolvePostizUrl`) and, when it isn't
    // configured, downgrades this tile to "coming soon" so it never opens a dead
    // link. Open Postiz in a NEW TAB (it's a separate app on its own port).
    external: true,
    status: 'live',
    accent: 'pink',
    detail: 'Self-hosted',
  },
  {
    id: 'longform',
    title: 'Long-form editor',
    description: 'Edit full-length, horizontal videos with the same AI-directed workflow.',
    icon: FileText,
    status: 'coming-soon',
    accent: 'blue',
  },
];

/**
 * Resolve the Postiz URL for the hub tile from the server's service status.
 *
 * Postiz runs as a separate self-hosted container on its own port, so its URL
 * isn't known at build time. The server reports it via `getServiceStatus`:
 *   - `postizUrl` — an explicit origin (e.g. `https://social.example.com`);
 *     used as-is when set.
 *   - `postizPort` — just the port; we derive `http://<current-host>:<port>`
 *     from the browser's location so the same config works on any host IP.
 *
 * Returns `null` when Postiz isn't configured — the hub then keeps the tile as
 * "coming soon" so clicking it can never open a dead link.
 */
export function resolvePostizUrl(status: {
  postizConfigured?: boolean;
  postizUrl?: string;
  postizPort?: string;
} | null | undefined): string | null {
  if (!status?.postizConfigured) return null;
  if (status.postizUrl) return status.postizUrl;
  if (status.postizPort) {
    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    return `http://${host}:${status.postizPort}`;
  }
  return null;
}

/** Tailwind classes per accent — icon foreground + soft tinted background. */
export const ACCENT_CLASSES: Record<ToolAccent, { icon: string; bg: string }> = {
  primary: { icon: 'text-primary', bg: 'bg-primary/10' },
  blue: { icon: 'text-[hsl(var(--chart-2))]', bg: 'bg-[hsl(var(--chart-2))]/10' },
  green: { icon: 'text-[hsl(var(--chart-3))]', bg: 'bg-[hsl(var(--chart-3))]/10' },
  purple: { icon: 'text-[hsl(var(--chart-4))]', bg: 'bg-[hsl(var(--chart-4))]/10' },
  pink: { icon: 'text-[hsl(var(--chart-5))]', bg: 'bg-[hsl(var(--chart-5))]/10' },
};
