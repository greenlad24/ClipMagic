/**
 * Deal Organizer — who is signed in.
 *
 * Replaces Zite's `useAuth` (legacyAuth → zitejs/auth). The Lab's sign-in gate
 * already guarantees a session before these pages load, so this only reads the
 * identity for the sidebar's user block. Same shape the layout was written
 * against (firstName / lastName / email).
 */
import { useEffect, useState } from 'react';

export interface DealOrgUser { email: string; firstName: string | null; lastName: string | null }

let cached: DealOrgUser | null = null;

export function useAuth() {
  const [user, setUser] = useState<DealOrgUser | null>(cached);
  const [isLoading, setIsLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((d) => {
        if (!alive || !d?.email) return;
        const parts = String(d.name ?? '').trim().split(/\s+/).filter(Boolean);
        cached = { email: String(d.email), firstName: parts[0] ?? null, lastName: parts.slice(1).join(' ') || null };
        setUser(cached);
      })
      .catch(() => {})
      .finally(() => alive && setIsLoading(false));
    return () => { alive = false; };
  }, []);

  return {
    user,
    isLoading,
    loginWithRedirect: (_opts?: { redirectUrl?: string }) => { window.location.href = '/auth/google'; },
  };
}
