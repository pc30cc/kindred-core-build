import React, { createContext, useContext } from 'react';
import type { WorkspaceBranding } from '@/types/models';

interface BrandingContextValue {
  branding: WorkspaceBranding | null;
  platformName: string;
  isLoading: boolean;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: null,
  platformName: 'Platform',
  isLoading: true,
});

export function BrandingProvider({
  children,
  branding,
  isLoading = false,
}: {
  children: React.ReactNode;
  branding: WorkspaceBranding | null;
  isLoading?: boolean;
}) {
  const platformName = branding?.platform_name || 'Platform';

  return (
    <BrandingContext.Provider value={{ branding, platformName, isLoading }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBrandingContext() {
  return useContext(BrandingContext);
}
