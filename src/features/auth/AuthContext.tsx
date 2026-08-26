import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { AuthProvider, AuthSession, AuthUser } from '@/types/providers';
import { selfHostedAuthProvider } from '@/providers/selfHosted/auth';
import { toast } from '@/lib/toast';

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

// Default to the first-party backend — can be swapped via props
export function AuthContextProvider({
  children,
  provider = selfHostedAuthProvider,
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
    // Only clear local session state when the provider actually confirms
    // the server-side session is gone — otherwise a real gs_session cookie
    // could remain valid while the UI falsely shows the user as signed
    // out (see src/providers/selfHosted/auth.ts's signOut() for why a
    // non-2xx response or a network failure is never treated as success).
    const { error } = await provider.signOut();
    if (error) {
      toast.error(error.message || 'Failed to sign out. Please try again.');
      return;
    }
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
    // During HMR, context can briefly be null — return safe loading defaults
    const noop = async () => ({ error: null }) as never;
    return {
      user: null, session: null, isLoading: true,
      signUp: noop, signIn: noop, signOut: async () => {},
      resetPasswordRequest: noop, updatePassword: noop,
    } as unknown as AuthContextValue;
  }
  return ctx;
}
