/**
 * Drop-in replacement for Zite's `zite-auth-sdk`.
 *
 * The self-hosted ClipMagic has no login (per deployment choice). To keep the
 * original components — which call `useAuth()` and expect a logged-in user —
 * working unchanged, this returns a fixed single local user and makes
 * login/logout no-ops.
 */

export interface AuthUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

const LOCAL_USER: AuthUser = {
  id: "local",
  email: "you@clipmagic.local",
  firstName: "ClipMagic",
  lastName: "User",
};

export interface UseAuthResult {
  user: AuthUser | null;
  isLoading: boolean;
  loginWithRedirect: (opts?: { redirectUrl?: string }) => void;
  logout: (opts?: { returnTo?: string }) => void;
}

export function useAuth(): UseAuthResult {
  return {
    user: LOCAL_USER,
    isLoading: false,
    loginWithRedirect: () => {},
    logout: () => {},
  };
}
