/**
 * AI News Stream — who is signed in.
 *
 * The Lab's sign-in gate already guarantees a session before any of these
 * pages load, so this only reads the identity (for the header) and offers
 * sign-out. Same shape the pages were written against.
 */
import { useEffect, useState } from 'react';

export interface NewsUser { email: string; name: string | null }

let cached: NewsUser | null = null;

export function useAuth() {
  const [user, setUser] = useState<NewsUser | null>(cached);
  const [isLoading, setIsLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.email) { cached = { email: String(d.email), name: d.name ?? null }; setUser(cached); }
      })
      .catch(() => {})
      .finally(() => alive && setIsLoading(false));
    return () => { alive = false; };
  }, []);

  return {
    user,
    isLoading,
    loginWithRedirect: (_opts?: { redirectUrl?: string }) => { window.location.href = '/auth/google'; },
    logout: () => { window.location.href = '/auth/logout'; },
  };
}
