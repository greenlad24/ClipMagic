import {
  BookOpen,
  Search,
  Wand2,
  Layers,
  Scissors,
  HardDrive,
  Send,
  FileText,
  Sticker,
  CalendarClock,
  Image as ImageIcon,
  Sparkles,
  TrendingUp,
  PenLine,
  MessagesSquare,
  MessageCircle,
  Clapperboard,
  Bot,
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
  /**
   * In-app settings route for tools that need configuration (e.g. Postiz keys).
   * When set, the tile shows a small "Configure" affordance that navigates here
   * without triggering the card's primary action. Available even for tools that
   * are otherwise "coming soon" (you configure first, then it goes live).
   */
  configureRoute?: string;
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
    // Manage the Postiz container's keys (core config + per-platform OAuth) from
    // the suite, write-only, with a one-click restart to apply them.
    configureRoute: '/settings/postiz',
  },
  {
    id: 'whatsapp',
    title: 'WhatsApp Scheduler',
    description: 'Schedule WhatsApp messages by typing /s in any chat — the linked device sends them later, even while your phone sleeps.',
    icon: MessageCircle,
    // Served INSIDE the Lab at /wa, behind the auth gate — the server reverse-
    // proxies it to the sidecar container. `external` (not `route`) because /wa is
    // a full-page load handled server-side, not an in-app React route.
    external: true,
    href: '/wa',
    status: 'live',
    accent: 'green',
    detail: 'Self-hosted',
  },
  {
    id: 'bulk-scheduler',
    title: 'Bulk Scheduler',
    description: 'Bulk-select rendered Shorts and schedule SEO-optimized, per-platform posts into Postiz at the best times.',
    icon: CalendarClock,
    route: '/bulk-scheduler',
    status: 'live',
    accent: 'green',
    detail: 'Schedule to social',
    // Needs the Postiz public API key (set in the same write-only Postiz settings).
    configureRoute: '/settings/postiz',
  },
  {
    id: 'thumbnail-designer',
    title: 'Thumbnail Designer',
    description: 'Recreate top-performing YouTube thumbnails with your own character, plus SEO-first titles, description and tags.',
    icon: ImageIcon,
    route: '/thumbnail-designer',
    status: 'live',
    accent: 'purple',
    detail: 'AI thumbnails',
    // Needs the Gemini + YouTube keys (set in the same write-only Postiz settings).
    configureRoute: '/settings/postiz',
  },
  {
    id: 'image-generator',
    title: 'AI Image Generator',
    description: 'Chat to generate or edit images with Nano Banana — describe what you want, upload images to restyle or combine. Every generation is saved to your History.',
    icon: Sparkles,
    route: '/image-generator',
    status: 'live',
    accent: 'blue',
    detail: 'Nano Banana chat',
    // Reuses the same Gemini key as the Thumbnail Designer.
    configureRoute: '/settings/postiz',
  },
  {
    id: 'keyword-research',
    title: 'Keyword Research',
    description:
      'Find high-volume YouTube keywords and untapped market gaps in your niche — demand vs competition scoring, related keywords, clusters and who dominates each.',
    icon: TrendingUp,
    route: '/keyword-research',
    status: 'live',
    accent: 'green',
    detail: 'YouTube SEO',
    // Needs the YouTube Data API key (set in the same write-only Postiz settings).
    configureRoute: '/settings/postiz',
  },
  {
    id: 'script-generator',
    title: 'Script Generator',
    description:
      'Turn a video idea into a full Jake Dawson YouTube script — research, outline, all four hook formulas, and a section-by-section script, written on Opus 4.8.',
    icon: PenLine,
    route: '/script-generator',
    status: 'live',
    accent: 'primary',
    detail: 'Opus 4.8 scripts',
    // Needs the Anthropic key (set in the same write-only Postiz settings).
    configureRoute: '/settings/postiz',
  },
  {
    id: 'skool',
    title: 'Skool Manager',
    description:
      'Builds and rearranges your Skool classroom — courses, lessons and the videos in them, written in your voice.',
    icon: BookOpen,
    route: '/skool',
    status: 'live',
    accent: 'primary',
    detail: 'Classroom builder',
  },
  {
    id: 'skool-agent',
    title: 'Skool Agent',
    description:
      'Writes community posts on a schedule, grounded in your rebuilt courses and what you say in the videos. Runs unattended — everything it writes waits here for you.',
    icon: Bot,
    route: '/skool/agent',
    status: 'live',
    accent: 'primary',
    detail: 'Autonomous poster',
  },
  {
    id: 'engagement',
    title: 'Engagement Manager',
    description:
      'Monitor comments & DMs across your connected channels in one inbox — starting with YouTube.',
    icon: MessagesSquare,
    route: '/engagement',
    status: 'live',
    accent: 'blue',
    detail: 'Comment inbox',
    // Needs the YouTube Data API key (set in the same write-only Postiz settings).
    configureRoute: '/settings/postiz',
  },
  {
    id: 'video-planner',
    title: 'Video Planner',
    description:
      'Drop an edited narration and get the second-by-second visual plan — which screencast, which title, which stock shot, and exactly when.',
    icon: Clapperboard,
    route: '/video-planner',
    status: 'live',
    accent: 'blue',
    detail: 'Long-form planning',
    // Needs the Anthropic key (planning) and Groq (transcription fallback),
    // both set in the same write-only Postiz settings.
    configureRoute: '/settings/postiz',
  },
  {
    id: 'channel-audit',
    title: 'Channel Audit',
    description:
      'Point it at a channel and get the market, the competitors, what its titles and thumbnails have in common, where it stands — and a better title for every video.',
    icon: Search,
    route: '/channel-audit',
    status: 'live',
    accent: 'purple',
    detail: 'Strategy',
    configureRoute: '/settings/postiz',
  },
  {
    id: 'longform',
    title: 'Long-form editor',
    description:
      'Execute a plan end to end — capture the screencasts, cut the timeline, render the finished 16:9 video. Builds on the Video Planner.',
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
