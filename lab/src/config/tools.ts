import {
  Wand2,
  Layers,
  Scissors,
  HardDrive,
  Send,
  FileText,
  type LucideIcon,
} from 'lucide-react';

/**
 * The ClipMagic tool registry.
 *
 * Single source of truth for the launcher hub on `/`. To add a future tool,
 * append one entry here — the hub grid renders straight from this array. No
 * other file needs to change for a new tile to appear.
 *
 * - `status: 'live'`        → whole card links to `route`.
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
  /** Destination route — required for live tools, omitted for coming-soon. */
  route?: string;
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
    status: 'coming-soon',
    accent: 'pink',
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

/** Tailwind classes per accent — icon foreground + soft tinted background. */
export const ACCENT_CLASSES: Record<ToolAccent, { icon: string; bg: string }> = {
  primary: { icon: 'text-primary', bg: 'bg-primary/10' },
  blue: { icon: 'text-[hsl(var(--chart-2))]', bg: 'bg-[hsl(var(--chart-2))]/10' },
  green: { icon: 'text-[hsl(var(--chart-3))]', bg: 'bg-[hsl(var(--chart-3))]/10' },
  purple: { icon: 'text-[hsl(var(--chart-4))]', bg: 'bg-[hsl(var(--chart-4))]/10' },
  pink: { icon: 'text-[hsl(var(--chart-5))]', bg: 'bg-[hsl(var(--chart-5))]/10' },
};
