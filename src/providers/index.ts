export { selfHostedAuthProvider } from './selfHosted/auth';
export { supabaseDatabaseProvider } from './supabase/database';
export { supabaseRealtimeProvider } from './supabase/realtime';
export { createApiEmailProvider } from './email/api';
export { providerRegistry, PROVIDER_TYPE_KEYS } from './registry';
export type { ProviderTypeKey, ProviderTypeMap, ProviderHealth, RegisteredProvider } from './registry';
export { bootstrapProviders } from './bootstrap';
export {
  syncProvidersFromDB,
  setGlobalDefaultProvider,
  getGlobalDefaultProvider,
  removeGlobalDefaultProvider,
  getAllGlobalDefaults,
  testProviderConnection,
  getFallbackLog,
  logFallback,
} from './sync';
export {
  ProviderContextProvider,
  useProvider,
  useActiveProviderName,
  useRegisteredProviders,
  useProviderSummary,
  useAuthProvider,
  useDatabaseProvider,
  useRealtimeProvider,
  useEmailProvider,
  useAIProvider,
  useStorageProvider,
  useBillingProvider,
  useSmsProvider,
} from './ProviderContext';
