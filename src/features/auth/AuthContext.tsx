import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { AuthUser } from '@/types/providers';
import {
  authLogin,
  authSignUp,
  authGetMe,
  authLogout,
  setSessionToken,
  type AuthUserResponse,
} from '@/lib/auth-email-api';

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  signUp: (params: {
    email: string;
    password: string;
    website?: string;
    fullName?: string;
    locale?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ user: AuthUser | null; error: Error | null }>;
  signIn: (params: { email: string; password: string }) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function mapUser(u: AuthUserResponse | null): AuthUser | null {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    emailVerified: !!u.emailVerified,
    metadata: u.metadata ?? {},
    createdAt: u.createdAt ?? '',
  };
}

export function AuthContextProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Bootstrap: load current user from backend session
  useEffect(() => {
    let cancelled = false;
    authGetMe()
      .then((res) => {
        if (!cancelled) {
          setUser(mapUser(res.user));
        }
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleSignUp = useCallback(async (params: {
    email: string;
    password: string;
    website?: string;
    fullName?: string;
    locale?: string;
    metadata?: Record<string, unknown>;
  }) => {
    try {
      const result = await authSignUp(params);
      const mapped = mapUser(result.user);
      setUser(mapped);
      return { user: mapped, error: null };
    } catch (err) {
      return { user: null, error: err instanceof Error ? err : new Error('Signup failed') };
    }
  }, []);

  const handleSignIn = useCallback(async (params: { email: string; password: string }) => {
    try {
      const result = await authLogin(params);
      setUser(mapUser(result.user));
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error('Login failed') };
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      await authLogout();
    } catch {
      // Clear local state even if backend call fails
    }
    setUser(null);
    setSessionToken(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const res = await authGetMe();
      setUser(mapUser(res.user));
    } catch {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        signUp: handleSignUp,
        signIn: handleSignIn,
        signOut: handleSignOut,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // During HMR, context can briefly be null — return safe loading defaults
    return {
      user: null,
      isLoading: true,
      signUp: async () => ({ user: null, error: null }),
      signIn: async () => ({ error: null }),
      signOut: async () => {},
      refreshUser: async () => {},
    } as unknown as AuthContextValue;
  }
  return ctx;
}
