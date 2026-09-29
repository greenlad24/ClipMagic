/**
 * AI News Stream — the product modes the shell can switch between.
 *
 * A mode is one self-contained workflow with its own route, page and state
 * hook. Today there is one: the Daily Show (collect → curate → build → go
 * live). A future mode is added by appending an entry here, adding its route
 * in App.tsx and its folder under src/news/<mode>/ — nothing in the shell or
 * in the Daily Show changes. See src/news/DESIGN.md ("Where Deep Dive plugs
 * in").
 *
 * Only list a mode here once its page exists: every entry renders as a live
 * tab in the top bar.
 */
import type { LucideIcon } from 'lucide-react';
import { Radio } from 'lucide-react';

export interface NewsMode {
  id: string;
  label: string;
  /** Route the tab links to. Pages under this prefix mark the tab active. */
  path: string;
  icon: LucideIcon;
  description: string;
}

export const NEWS_MODES: NewsMode[] = [
  {
    id: 'daily',
    label: 'Daily Show',
    path: '/news-gatherer/dashboard',
    icon: Radio,
    description: "Collect today's AI news, pick the stories, build the deck, go live.",
  },
];

export const SETTINGS_PATH = '/news-gatherer/settings';
