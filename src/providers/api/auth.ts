/**
 * API-based Auth Provider — all auth goes through our self-hosted backend.
 * NO direct Supabase Auth calls from the browser.
 */

import type { AuthProvider, AuthUser, AuthSession, SignUpParams, SignInParams } from '@/types/providers';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include', // Send cookies for session
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  const body = await res.json().catch(() => ({ error: res.statusText }));

  if (!res.ok) {
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return body as T;
}

function mapApiUser(u: any): AuthUser | null {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email ?? '',
    emailVerified: !!u.emailVerified,
    metadata: u.metadata ?? {},
    createdAt: u.createdAt ?? '',
  };
}

// Polling-based auth state — since we use cookies, we poll /session
let currentUser: AuthUser | null = null;
let stateListeners: Array<(session: AuthSession | null) => void> = [];
let sessionPollInterval: ReturnType<typeof setInterval> | null = null;

function notifyListeners(user: AuthUser | null) {
  const session: AuthSession | null = user
    ? { user, accessToken: 'cookie-session', refreshToken: undefined, expiresAt: undefined }
    : null;
  for (const listener of stateListeners) {
    listener(session);
  }
}

async function fetchSession(): Promise<AuthSession | null> {
  try {
    const data = await apiRequest<{ authenticated: boolean; user: any }>('/api/auth-email/session');
    if (data.authenticated && data.user) {
      const user = mapApiUser(data.user);
      currentUser = user;
      return user ? { user, accessToken: 'cookie-session', refreshToken: undefined, expiresAt: undefined } : null;
    }
    currentUser = null;
    return null;
  } catch {
    currentUser = null;
    return null;
  }
}

function startPolling() {
  if (sessionPollInterval) return;
  sessionPollInterval = setInterval(async () => {
    const oldUser = currentUser;
    await fetchSession();
    // Only notify if user changed
    if (oldUser?.id !== currentUser?.id) {
      notifyListeners(currentUser);
    }
  }, 60_000); // Poll every 60s
}

function stopPolling() {
  if (sessionPollInterval) {
    clearInterval(sessionPollInterval);
    sessionPollInterval = null;
  }
}

export const apiAuthProvider: AuthProvider = {
  async signUp({ email, password, metadata }: SignUpParams) {
    try {
      const data = await apiRequest<{ success: boolean; user: any; message: string }>('/api/auth-email/signup', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          fullName: metadata?.full_name || metadata?.fullName || '',
        }),
      });
      return { user: mapApiUser(data.user), error: null };
    } catch (err: any) {
      return { user: null, error: new Error(err.message) };
    }
  },

  async signIn({ email, password }: SignInParams) {
    try {
      const data = await apiRequest<{ success: boolean; user: any; message: string }>('/api/auth-email/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const user = mapApiUser(data.user);
      currentUser = user;
      if (user) {
        const session: AuthSession = { user, accessToken: 'cookie-session' };
        notifyListeners(user);
        startPolling();
        return { session, error: null };
      }
      return { session: null, error: null };
    } catch (err: any) {
      return { session: null, error: new Error(err.message) };
    }
  },

  async signOut() {
    try {
      await apiRequest<{ success: boolean }>('/api/auth-email/logout', { method: 'POST' });
      currentUser = null;
      notifyListeners(null);
      stopPolling();
      return { error: null };
    } catch (err: any) {
      return { error: new Error(err.message) };
    }
  },

  async getSession() {
    const session = await fetchSession();
    if (session) startPolling();
    return session;
  },

  async resetPasswordRequest(email: string) {
    try {
      await apiRequest<{ success: boolean }>('/api/auth-email/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      return { error: null };
    } catch (err: any) {
      return { error: new Error(err.message) };
    }
  },

  async updatePassword(newPassword: string) {
    try {
      // Check if there's a reset token in the URL
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token') || undefined;

      await apiRequest<{ success: boolean }>('/api/auth-email/update-password', {
        method: 'POST',
        body: JSON.stringify({ password: newPassword, token }),
      });
      return { error: null };
    } catch (err: any) {
      return { error: new Error(err.message) };
    }
  },

  onAuthStateChange(callback: (session: AuthSession | null) => void) {
    stateListeners.push(callback);
    startPolling();
    return () => {
      stateListeners = stateListeners.filter((l) => l !== callback);
      if (stateListeners.length === 0) stopPolling();
    };
  },

  async verifyEmail(token: string) {
    try {
      await apiRequest<{ success: boolean }>(`/api/auth-email/verify-email?token=${encodeURIComponent(token)}`);
      return { error: null };
    } catch (err: any) {
      return { error: new Error(err.message) };
    }
  },
};
