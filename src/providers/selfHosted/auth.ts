/**
 * First-party auth provider — implements the same `AuthProvider` interface
 * as the old `supabaseAuthProvider` (src/providers/supabase/auth.ts), but
 * talks to this app's own backend (server/routes/auth.ts,
 * server/routes/auth-email.ts) instead of Supabase Auth/GoTrue.
 *
 * Identity lives in an HttpOnly `gs_session` cookie the browser can't read —
 * every request just needs `credentials: 'include'`, which every fetch()
 * call in this codebase now sets. `getSession()` therefore always asks the
 * backend (GET /api/auth/session) rather than reading local/session storage.
 *
 * `AuthSession.accessToken` is part of the shared `AuthProvider` interface
 * (originally modeled on Supabase's session shape) but is never a real,
 * usable credential here — nothing should read it to authenticate a
 * request. It's a fixed non-secret placeholder so existing code that only
 * checks truthiness (`session?.accessToken`) keeps working without change.
 */
import type { AuthProvider, AuthUser, AuthSession, SignUpParams, SignInParams } from '@/types/providers';
import { authSignUp, API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/authFetch';
import { isNativePlatform } from '@/lib/native';
import {
  clearMobileSessionToken,
  hydrateMobileSession,
  setMobileSessionToken,
} from '@/lib/mobileSession';

interface BackendUser {
  id: string;
  email: string;
  emailVerified?: boolean;
  email_confirmed_at?: string | null;
  fullName?: string | null;
  created_at?: string;
}

function mapUser(u: BackendUser | null | undefined): AuthUser | null {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email ?? '',
    emailVerified: !!(u.emailVerified ?? u.email_confirmed_at),
    metadata: u.fullName ? { full_name: u.fullName } : {},
    createdAt: u.created_at ?? '',
  };
}

function mapSession(u: BackendUser | null | undefined): AuthSession | null {
  const user = mapUser(u);
  if (!user) return null;
  return { user, accessToken: 'cookie' };
}

type Listener = (session: AuthSession | null) => void;
const listeners = new Set<Listener>();
function notify(session: AuthSession | null) {
  for (const l of listeners) l(session);
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await authFetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export const selfHostedAuthProvider: AuthProvider = {
  async signUp(params: SignUpParams) {
    try {
      const data = await authSignUp({
        email: params.email,
        password: params.password,
        website: params.website,
        fullName: params.fullName,
        locale: params.locale,
        metadata: params.metadata,
      });
      return { user: mapUser(data.user as BackendUser), error: null };
    } catch (error) {
      return { user: null, error: error instanceof Error ? error : new Error('Signup failed') };
    }
  },

  async signIn({ email, password }: SignInParams) {
    try {
      // Native clients ask the SAME login endpoint for a Bearer-transport
      // session; the server runs the identical security flow and returns the
      // opaque token in the body instead of a cookie.
      const native = isNativePlatform();
      const { ok, json } = await postJson('/api/auth/login', {
        email,
        password,
        ...(native ? { client: 'mobile' as const } : {}),
      });
      if (!ok) {
        const message = json?.error || 'Login failed';
        const err = new Error(message) as Error & { passwordSetupRequired?: boolean };
        if (json?.passwordSetupRequired) err.passwordSetupRequired = true;
        return { session: null, error: err };
      }
      if (native && typeof json?.sessionToken === 'string') {
        await setMobileSessionToken(json.sessionToken);
      }
      const session = mapSession(json.user);
      notify(session);
      return { session, error: null };
    } catch (error) {
      return { session: null, error: error instanceof Error ? error : new Error('Login failed') };
    }
  },

  // Because the session lives in an HttpOnly cookie the browser can't read
  // or delete on its own, "signed out" is only true once the SERVER
  // confirms the gs_session was revoked — clearing local state on a failed
  // or unreachable logout request would report a signed-out UI while a
  // real, still-valid session cookie remains usable (e.g. by anyone else
  // with access to this browser). POST /api/auth/logout
  // (server/routes/auth.ts) is idempotent — it 200s whether or not there
  // was a session to revoke — so any 2xx response is proof there is no
  // longer a live server-side session for this browser, and any non-2xx
  // response, or the request never completing at all, is proof of nothing
  // and must be reported as a failure instead.
  async signOut() {
    let ok: boolean;
    let status: number;
    let json: any;
    try {
      const res = await authFetch(`${API_BASE}/api/auth/logout`, { method: 'POST' });
      ok = res.ok;
      status = res.status;
      json = await res.json().catch(() => ({}));
    } catch (error) {
      // Network failure — no proof the server-side session was revoked.
      return { error: error instanceof Error ? error : new Error('Logout request failed') };
    }

    if (!ok) {
      const message = json?.error || `Logout failed (HTTP ${status})`;
      return { error: new Error(message) };
    }

    // Only a CONFIRMED server-side revocation clears the Keychain token —
    // never a network error or timeout.
    await clearMobileSessionToken();
    notify(null);
    return { error: null };
  },

  async getSession() {
    try {
      // Native: make sure the Keychain token is loaded before the first
      // authenticated request of the launch.
      await hydrateMobileSession();
      const res = await authFetch(`${API_BASE}/api/auth/session`, { cache: 'no-store' });
      // A transport/HTTP failure is NOT a logout: the stored token stays put
      // and the next attempt (or a later app launch) can succeed.
      if (!res.ok) return null;
      const body = await res.json();
      return mapSession(body?.user);
    } catch {
      return null;
    }
  },

  async resetPasswordRequest(email: string) {
    try {
      const { ok, json } = await postJson('/api/auth-email/send-reset', { email });
      return { error: ok ? null : new Error(json?.error || 'Failed to send reset email') };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error('Failed to send reset email') };
    }
  },

  async updatePassword() {
    // Not reachable in practice: the reset-password flow goes through
    // /api/auth-email/reset-password with a token (src/lib/auth-email-api.ts,
    // used directly by ResetPasswordPage), and the logged-in "change
    // password" flow goes through /api/account/change-password (which needs
    // the current password — a parameter this generic interface method
    // doesn't carry). No caller in this codebase invokes
    // useAuth().updatePassword(); this exists only to satisfy the
    // AuthProvider interface.
    return { error: new Error('Not implemented — use the reset-password or change-password flow directly.') };
  },

  onAuthStateChange(callback: (session: AuthSession | null) => void) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },

  async verifyEmail(token: string) {
    try {
      const { ok, json } = await postJson('/api/auth-email/verify-email', { token });
      return { error: ok ? null : new Error(json?.error || 'Verification failed') };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error('Verification failed') };
    }
  },
};
