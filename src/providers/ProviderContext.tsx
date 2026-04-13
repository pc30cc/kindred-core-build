// ============================================
// PROVIDER CONTEXT
// React context that exposes the provider registry to the component tree.
// Provides type-safe hooks for each provider type.
// Syncs provider configs from DB on mount.
// ============================================

import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { providerRegistry, type ProviderTypeKey, type ProviderTypeMap } from './registry';
import { bootstrapProviders } from './bootstrap';
import { syncProvidersFromDB } from './sync';

// Ensure providers are bootstrapped before any React rendering
bootstrapProviders();

interface ProviderContextValue {
  resolve: <K extends ProviderTypeKey>(type: K, workspaceId?: string) => ProviderTypeMap[K] | null;
  getActiveName: (type: ProviderTypeKey, workspaceId?: string) => string | null;
  getProviders: (type: ProviderTypeKey) => ReturnType<typeof providerRegistry.getProviders>;
  checkHealth: typeof providerRegistry.checkHealth;
  getSummary: typeof providerRegistry.getSummary;
}

const ProviderContext = createContext<ProviderContextValue | null>(null);

export function ProviderContextProvider({ children }: { children: React.ReactNode }) {
  // Re-render consumers when registry changes
  const _version = useSyncExternalStore(
    (cb) => providerRegistry.subscribe(cb),
    () => Date.now(),
  );

  // Sync provider configs from DB on mount
  useEffect(() => {
    syncProvidersFromDB();
  }, []);

  const value = useMemo<ProviderContextValue>(() => ({
    resolve: (type, wsId) => providerRegistry.resolve(type, wsId),
    getActiveName: (type, wsId) => providerRegistry.getActiveName(type, wsId),
    getProviders: (type) => providerRegistry.getProviders(type),
    checkHealth: providerRegistry.checkHealth.bind(providerRegistry),
    getSummary: providerRegistry.getSummary.bind(providerRegistry),
  }), [_version]);

  return (
    <ProviderContext.Provider value={value}>
      {children}
    </ProviderContext.Provider>
  );
}

// --- Typed hooks ---

function useProviderContext(): ProviderContextValue {
  const ctx = useContext(ProviderContext);
  if (!ctx) throw new Error('useProvider* must be used within ProviderContextProvider');
  return ctx;
}

export function useProvider<K extends ProviderTypeKey>(
  type: K,
  workspaceId?: string
): ProviderTypeMap[K] | null {
  const { resolve } = useProviderContext();
  return resolve(type, workspaceId);
}

export function useActiveProviderName(type: ProviderTypeKey, workspaceId?: string): string | null {
  const { getActiveName } = useProviderContext();
  return getActiveName(type, workspaceId);
}

export function useRegisteredProviders(type: ProviderTypeKey) {
  const { getProviders } = useProviderContext();
  return getProviders(type);
}

export function useProviderSummary() {
  const { getSummary } = useProviderContext();
  return getSummary();
}

// --- Convenience typed hooks for common providers ---

export function useAuthProvider(workspaceId?: string) {
  return useProvider('auth', workspaceId);
}

export function useDatabaseProvider(workspaceId?: string) {
  return useProvider('database', workspaceId);
}

export function useRealtimeProvider(workspaceId?: string) {
  return useProvider('realtime', workspaceId);
}

export function useEmailProvider(workspaceId?: string) {
  return useProvider('email', workspaceId);
}

export function useAIProvider(workspaceId?: string) {
  return useProvider('ai', workspaceId);
}

export function useStorageProvider(workspaceId?: string) {
  return useProvider('storage', workspaceId);
}

export function useBillingProvider(workspaceId?: string) {
  return useProvider('billing', workspaceId);
}
