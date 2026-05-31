import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from 'zite-auth-sdk';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Film, Settings } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
  breadcrumb?: string;
}

export default function Layout({ children, rightSlot, breadcrumb }: LayoutProps) {
  const { user, isLoading, loginWithRedirect, logout } = useAuth();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!isLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [isLoading, user, loginWithRedirect]);

  if (isLoading || !user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Film className="w-8 h-8 text-primary animate-pulse" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border sticky top-0 z-50 bg-background/95 backdrop-blur">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <Film className="w-5 h-5 text-primary" />
              <span className="font-bold text-base tracking-tight text-foreground">ShortStack</span>
            </Link>
            {breadcrumb && (
              <>
                <span className="text-muted-foreground text-sm">/</span>
                <span className="text-muted-foreground text-sm truncate max-w-48">{breadcrumb}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            {rightSlot}
            <Link
              to="/setup"
              title="Service Setup"
              className={`p-1.5 rounded-lg transition-colors ${pathname === '/setup' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
            >
              <Settings className="w-4 h-4" />
            </Link>
            <span className="text-xs text-muted-foreground hidden sm:block">{user.email}</span>
            <Button variant="ghost" size="sm" onClick={() => logout()} className="text-xs">
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
