import { supabase } from '@/lib/supabase';
import type { AuthProvider, AuthUser, AuthSession, SignUpParams, SignInParams } from '@/types/providers';

function mapUser(u: any): AuthUser | null {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email ?? '',
    emailVerified: !!u.email_confirmed_at,
    metadata: u.user_metadata ?? {},
    createdAt: u.created_at ?? '',
  };
}

function mapSession(s: any): AuthSession | null {
  if (!s?.user) return null;
  return {
    user: mapUser(s.user)!,
    accessToken: s.access_token ?? '',
    refreshToken: s.refresh_token,
    expiresAt: s.expires_at,
  };
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

/**
 * Try self-hosted backend first. If unreachable, return null so caller can fallback.
 */
async function tryBackendFetch(url: string, options: RequestInit): Promise<Response | null> {
  try {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      // Backend not running — Vite returned HTML
      return null;
    }
    return res;
  } catch {
    return null;
  }
}

export const supabaseAuthProvider: AuthProvider = {
  /**
   * Signup: tries self-hosted backend first (branded email).
   * Falls back to Supabase native auth if backend is unreachable (dev/preview).
   * In production (Coolify), backend is always available.
   */
  async signUp({ email, password, metadata }: SignUpParams) {
    // 1) Try self-hosted backend
    const res = await tryBackendFetch(`${API_BASE}/api/auth-email/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        fullName: (metadata as any)?.full_name || '',
        locale: document.documentElement.lang || 'en',
      }),
    });

    if (res) {
      // Backend responded with JSON
      try {
        const body = await res.json();
        if (!res.ok) return { user: null, error: new Error(body.error || 'Signup failed') };
        return {
          user: body.user ? { id: body.user.id, email: body.user.email, emailVerified: false, metadata: {}, createdAt: '' } : null,
          error: null,
        };
      } catch {
        return { user: null, error: new Error('Invalid response from backend') };
      }
    }

    // 2) Fallback: Supabase native auth (dev/preview only)
    console.warn('[auth] Self-hosted backend unreachable, falling back to Supabase native auth');
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: metadata as Record<string, any> },
    });
    return {
      user: mapUser(data?.user),
      error: error ? new Error(error.message) : null,
    };
  },

  async signIn({ email, password }: SignInParams) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    return { session: mapSession(data?.session), error: error ? new Error(error.message) : null };
  },

  async signOut() {
    const { error } = await supabase.auth.signOut();
    return { error: error ? new Error(error.message) : null };
  },

  async getSession() {
    const { data } = await supabase.auth.getSession();
    return mapSession(data?.session);
  },

  /**
   * Password reset: tries self-hosted backend first.
   * Falls back to Supabase native if backend is unreachable.
   */
  async resetPasswordRequest(email: string) {
    const res = await tryBackendFetch(`${API_BASE}/api/auth-email/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        locale: document.documentElement.lang || 'en',
      }),
    });

    if (res) {
      try {
        const body = await res.json();
        if (!res.ok) return { error: new Error(body.error || 'Reset failed') };
        return { error: null };
      } catch {
        return { error: new Error('Invalid response from backend') };
      }
    }

    // Fallback: Supabase native
    console.warn('[auth] Self-hosted backend unreachable, falling back to Supabase native password reset');
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    return { error: error ? new Error(error.message) : null };
  },

  async updatePassword(newPassword: string) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    return { error: error ? new Error(error.message) : null };
  },

  onAuthStateChange(callback: (session: AuthSession | null) => void) {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      callback(mapSession(session));
    });
    return () => data.subscription.unsubscribe();
  },
};
