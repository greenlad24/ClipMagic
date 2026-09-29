/**
 * AI News Stream — the workspace shell (top bar + mode tabs) for the
 * back-office pages: the Daily Show dashboard and Settings.
 *
 * Styled with the Lab's own dark tokens, like every other Lab tool. The
 * presentation pages (present/notes, display, audience, teleprompter) do NOT
 * use this shell and keep their own light palette via useNewsTheme.
 */
import { useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FlaskConical, LogOut, Settings } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '../auth';
import { NEWS_MODES, SETTINGS_PATH } from './modes';

interface Props {
  children: ReactNode;
  /** Page title for the browser tab. */
  title?: string;
}

export default function NewsShell({ children, title }: Props) {
  const { pathname } = useLocation();
  const { user, isLoading, loginWithRedirect, logout } = useAuth();

  useEffect(() => {
    if (!isLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [isLoading, user, loginWithRedirect]);

  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} · AI News Stream` : 'AI News Stream';
    return () => { document.title = prev; };
  }, [title]);

  const onSettings = pathname.startsWith(SETTINGS_PATH);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex h-12 items-center gap-2 px-3 sm:px-5">
          <Link to="/" className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors" title="Back to the Lab">
            <FlaskConical className="h-4 w-4 text-primary" />
            <span className="hidden text-sm font-bold tracking-tight text-foreground sm:inline">The Lab</span>
          </Link>
          <span className="text-sm text-muted-foreground">/</span>
          <span className="truncate text-sm font-medium text-foreground">AI News Stream</span>

          <nav className="ml-3 flex items-center gap-1" aria-label="Modes">
            {NEWS_MODES.map((m) => {
              const active = pathname.startsWith(m.path);
              const Icon = m.icon;
              return (
                <Link
                  key={m.id}
                  to={m.path}
                  title={m.description}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {m.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <Link
              to={SETTINGS_PATH}
              title="Settings"
              aria-current={onSettings ? 'page' : undefined}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
                onSettings ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Settings className="h-4 w-4" />
              <span className="hidden md:inline">Settings</span>
            </Link>
            {user && (
              <>
                <span className="hidden text-xs text-muted-foreground lg:block ml-2">{user.email}</span>
                <button
                  onClick={() => logout()}
                  title={`Sign out (${user.email})`}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {isLoading || !user ? (
        <div className="space-y-3 px-5 py-6">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-16 w-full" />
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
