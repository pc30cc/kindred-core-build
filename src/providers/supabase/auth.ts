import { supabase } from '@/lib/supabase';
import type { AuthProvider, AuthUser, AuthSession, SignUpParams, SignInParams } from '@/types/providers';
import { authSignUp } from '@/lib/api';

function mapUser(u: any): AuthUser | null {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email ?? '',
    // Use our custom metadata flag — email_confirm:true is set at signup
    // just to allow login; real verification is tracked in user_metadata.
    emailVerified: !!(u.user_metadata?.email_verified),
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

export const supabaseAuthProvider: AuthProvider = {
  async signUp({ email, password, fullName, metadata, redirectTo }: SignUpParams) {
    void redirectTo;

    try {
      const data = await authSignUp({
        email,
        password,
        website: metadata?.website as string,
        fullName,
        locale: (metadata?.locale as string | undefined),
        metadata,
      });

      return { user: mapUser(data.user), error: null };
    } catch (error) {
      return { user: null, error: error instanceof Error ? error : new Error('Signup failed') };
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

  async resetPasswordRequest(email: string, redirectTo?: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo ?? `${window.location.origin}/auth/reset-password`,
    });
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
