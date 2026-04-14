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

function buildApiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

async function apiFetch(url: string, options: RequestInit): Promise<any> {
  const res = await fetch(url, options);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('سرور بکند در دسترس نیست. لطفاً مطمئن شوید سرور سلف‌هاست در حال اجراست.');
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}

export const supabaseAuthProvider: AuthProvider = {
  async signUp({ email, password, metadata }: SignUpParams) {
    try {
      const body = await apiFetch(buildApiUrl('/api/auth-email/signup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          fullName: (metadata as any)?.full_name || '',
          locale: document.documentElement.lang || 'en',
        }),
      });
      return {
        user: body.user ? { id: body.user.id, email: body.user.email, emailVerified: false, metadata: {}, createdAt: '' } : null,
        error: null,
      };
    } catch (err: any) {
      return { user: null, error: new Error(err.message || 'Signup failed') };
    }
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

  async resetPasswordRequest(email: string) {
    try {
      await apiFetch(buildApiUrl('/api/auth-email/reset-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          locale: document.documentElement.lang || 'en',
        }),
      });
      return { error: null };
    } catch (err: any) {
      return { error: new Error(err.message || 'Reset failed') };
    }
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