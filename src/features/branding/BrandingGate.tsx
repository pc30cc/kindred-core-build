/**
 * BrandingGate: Wraps app routes to auto-load branding from the current workspace.
 * Prevents the need to manually pass branding={null} from App.tsx.
 */
import React from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useBranding } from '@/hooks/useBranding';
import { BrandingProvider } from './BrandingContext';

export function BrandingGate({ children }: { children: React.ReactNode }) {
  const workspace = useCurrentWorkspace();
  const { data: branding, isLoading } = useBranding(workspace?.id);

  return (
    <BrandingProvider branding={branding ?? null} isLoading={isLoading}>
      {children}
    </BrandingProvider>
  );
}
