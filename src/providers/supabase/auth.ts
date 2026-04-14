/**
 * Supabase auth provider — DEPRECATED for login/session.
 * Auth is now fully backend-driven via /api/auth-email/*.
 * This file is kept only for backward compatibility of the provider interface.
 * Real auth is handled by AuthContext.tsx which uses auth-email-api.ts directly.
 */

import type { AuthProvider, AuthUser, AuthSession, SignUpParams, SignInParams } from '@/types/providers';

// Stub provider — all methods throw or return empty.
// The actual auth flow bypasses the provider interface entirely.
export const supabaseAuthProvider: AuthProvider = {
  async signUp(_params: SignUpParams) {
    throw new Error('Use AuthContext.signUp instead — auth is backend-driven');
  },

  async signIn(_params: SignInParams) {
    throw new Error('Use AuthContext.signIn instead — auth is backend-driven');
  },

  async signOut() {
    throw new Error('Use AuthContext.signOut instead — auth is backend-driven');
  },

  async getSession() {
    return null;
  },

  async resetPasswordRequest(_email: string, _redirectTo?: string) {
    throw new Error('Use auth-email-api.sendResetEmail instead');
  },

  async updatePassword(_newPassword: string) {
    throw new Error('Use auth-email-api.resetPasswordWithToken instead');
  },

  onAuthStateChange(_callback: (session: AuthSession | null) => void) {
    // No-op — sessions are backend-driven
    return () => {};
  },
};
