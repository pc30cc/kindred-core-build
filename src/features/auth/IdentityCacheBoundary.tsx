/**
 * Clears every client-side cache when the signed-in identity changes.
 *
 * Without this, logging out as an operator and back in as an owner keeps the
 * previous user's react-query entries (workspace role, memberships,
 * entitlements, ...) alive, so the UI keeps rendering the operator's
 * restrictions until a hard refresh. Role-derived gating must never survive an
 * identity switch.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './AuthContext';

export function IdentityCacheBoundary({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const queryClient = useQueryClient();
  const lastIdentity = useRef<string | null | undefined>(undefined);

  const identity = user?.id ?? null;

  useEffect(() => {
    if (isLoading) return;
    if (lastIdentity.current === undefined) {
      lastIdentity.current = identity;
      return;
    }
    if (lastIdentity.current !== identity) {
      lastIdentity.current = identity;
      queryClient.cancelQueries();
      queryClient.clear();
    }
  }, [identity, isLoading, queryClient]);

  return <>{children}</>;
}

export default IdentityCacheBoundary;
