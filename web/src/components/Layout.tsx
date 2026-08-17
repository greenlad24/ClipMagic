import { Link } from 'react-router-dom';
import { Film } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
  breadcrumb?: string;
}

/**
 * App shell. The original in the lab wrapped this in a Google Sign-In gate
 * (`zite-auth-sdk`) because it fronted a multi-tool app on a public domain.
 * This build is single-user and local, so the gate is gone and the props
 * contract is all that survives — the page passes `breadcrumb`/`rightSlot`
 * unchanged.
 */
export default function Layout({ children, rightSlot, breadcrumb }: LayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border sticky top-0 z-50 bg-background/95 backdrop-blur">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <Film className="w-5 h-5 text-primary" />
              <span className="font-bold text-base tracking-tight text-foreground">
                Avatar Narrator
              </span>
            </Link>
            {breadcrumb && (
              <>
                <span className="text-muted-foreground text-sm">/</span>
                <span className="text-muted-foreground text-sm truncate max-w-48">{breadcrumb}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">{rightSlot}</div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
