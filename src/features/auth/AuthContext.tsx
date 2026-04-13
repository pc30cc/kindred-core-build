import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { AuthProvider, AuthSession, AuthUser } from '@/types/providers';
import { supabaseAuthProvider } from '@/providers';

interface AuthContextValue {
  user: AuthUser | null;
  session: AuthSession | null;
  isLoading: boolean;
  signUp: AuthProvider['signUp'];
  signIn: AuthProvider['signIn'];
  signOut: () => Promise<void>;
  resetPasswordRequest: AuthProvider['resetPasswordRequest'];
  updatePassword: AuthProvider['updatePassword'];
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Default to Supabase — can be swapped via props
export function AuthContextProvider({
  children,
  provider = supabaseAuthProvider,
}: {
  children: React.ReactNode;
  provider?: AuthProvider;
}) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = provider.onAuthStateChange((s) => {
      setSession(s);
      setIsLoading(false);
    });

    provider.getSession().then((s) => {
      setSession(s);
      setIsLoading(false);
    });

    return unsubscribe;
  }, [provider]);

  const handleSignOut = useCallback(async () => {
    await provider.signOut();
    setSession(null);
  }, [provider]);

  return (
    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        session,
        isLoading,
        signUp: provider.signUp.bind(provider),
        signIn: provider.signIn.bind(provider),
        signOut: handleSignOut,
        resetPasswordRequest: provider.resetPasswordRequest.bind(provider),
        updatePassword: provider.updatePassword.bind(provider),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // During HMR, context can briefly be null — return safe defaults instead of crashing
    return { user: null, session: null, loading: true, signOut: async () => {} } as AuthContextValue;
  }
  return ctx;
}
