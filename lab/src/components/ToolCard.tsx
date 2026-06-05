import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, ExternalLink, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ACCENT_CLASSES, type ToolDefinition } from '@/config/tools';

interface ToolCardProps {
  tool: ToolDefinition;
}

/**
 * One equal-sized tile in the launcher hub. Live tools are full clickable
 * cards (whole card is the target, keyboard-accessible); coming-soon tools
 * render muted and non-interactive with a "Coming soon" badge.
 */
export default function ToolCard({ tool }: ToolCardProps) {
  const navigate = useNavigate();
  const accent = ACCENT_CLASSES[tool.accent];
  const isComingSoon = tool.status === 'coming-soon';
  const isExternal = !isComingSoon && !!tool.external && !!tool.href;

  const Icon = tool.icon;

  const inner = (
    <>
      <div className="flex items-start justify-between">
        <div
          className={cn(
            'flex h-12 w-12 items-center justify-center rounded-xl transition-transform duration-200',
            accent.bg,
            !isComingSoon && 'group-hover:scale-105',
          )}
        >
          <Icon className={cn('h-6 w-6', isComingSoon ? 'text-muted-foreground' : accent.icon)} />
        </div>
        {isComingSoon ? (
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
            Coming soon
          </Badge>
        ) : isExternal ? (
          <ExternalLink className="h-5 w-5 text-muted-foreground transition-all duration-200 group-hover:-translate-y-0.5 group-hover:text-foreground" />
        ) : (
          <ArrowUpRight className="h-5 w-5 text-muted-foreground transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
        )}
      </div>

      <div className="mt-5">
        <h3 className="text-base font-semibold text-foreground">{tool.title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{tool.description}</p>
      </div>

      {tool.detail && (
        <p className="mt-auto pt-4 text-xs font-medium text-muted-foreground/80">{tool.detail}</p>
      )}
    </>
  );

  const baseClasses =
    'group flex h-full flex-col rounded-2xl border border-border bg-card p-5 text-left transition-all duration-200';

  // Optional "Configure" affordance (e.g. Postiz keys). Rendered as a sibling of
  // the clickable card — never nested inside it — so the HTML stays valid and a
  // click on it navigates to settings instead of triggering the card's action.
  const configureLink = tool.configureRoute ? (
    <Link
      to={tool.configureRoute}
      aria-label={`Configure ${tool.title}`}
      title={`Configure ${tool.title}`}
      className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Settings className="h-3.5 w-3.5" />
      Configure
    </Link>
  ) : null;

  if (isComingSoon) {
    return (
      <div className="relative h-full">
        <div className={cn(baseClasses, 'h-full opacity-60 cursor-default')} aria-disabled="true">
          {inner}
        </div>
        {configureLink}
      </div>
    );
  }

  const interactiveClasses = cn(
    baseClasses,
    'hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card hover:shadow-lg hover:shadow-black/20',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  );

  // External tools (e.g. self-hosted Postiz) open in a new tab.
  const card = isExternal ? (
    <a
      href={tool.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${tool.title} in a new tab`}
      className={cn(interactiveClasses, 'h-full')}
    >
      {inner}
    </a>
  ) : (
    <button
      type="button"
      onClick={() => tool.route && navigate(tool.route)}
      aria-label={`Open ${tool.title}`}
      className={cn(interactiveClasses, 'h-full w-full')}
    >
      {inner}
    </button>
  );

  if (!configureLink) return card;

  return (
    <div className="relative h-full">
      {card}
      {configureLink}
    </div>
  );
}
