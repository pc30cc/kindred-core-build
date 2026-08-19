// ============================================
// PROVIDER BOOTSTRAP
// Registers all default (Supabase + stub) providers at app startup.
// Email uses self-hosted API provider — NO Edge Functions.
// ============================================

import { providerRegistry } from './registry';
import { supabaseAuthProvider } from './supabase/auth';
import { selfHostedAuthProvider } from './selfHosted/auth';
import { supabaseDatabaseProvider } from './supabase/database';
import { supabaseRealtimeProvider } from './supabase/realtime';
import { createApiEmailProvider } from './email/api';
import {
  stubEmailProvider,
  stubAIProvider,
  stubStorageProvider,
  stubSearchProvider,
  stubNotificationProvider,
  stubCacheProvider,
  stubFeatureFlagProvider,
  stubWidgetDeliveryProvider,
  stubBillingProvider,
  stubCaptchaProvider,
  stubCDNProvider,
  stubSmsProvider,
  stubGeoEnrichmentProvider,
  stubMapTilesProvider,
  osmMapTilesProvider,
} from './stubs';

let bootstrapped = false;

/**
 * Register all default providers.
 * Called once at app startup.
 * Supabase implementations get priority 0 (default).
 * Self-hosted API providers get priority 5.
 * Stubs get priority 100 (fallback).
 */
export function bootstrapProviders(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  // --- Auth: self-hosted session-cookie provider (server/routes/auth.ts) ---
  // Dashboard authentication is first-party as of the auth migration —
  // Supabase Auth/GoTrue is no longer this app's identity root of trust.
  providerRegistry.register('auth', 'self-hosted', selfHostedAuthProvider, {
    priority: 0,
    healthCheck: async () => {
      try {
        const API_BASE = import.meta.env.VITE_API_BASE_URL;
        const res = await fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' });
        return res.ok || res.status === 401 ? 'healthy' : 'down';
      } catch {
        return 'down';
      }
    },
    meta: {
      vendor: 'self-hosted',
      builtIn: true,
      description: 'First-party session-cookie auth — Supabase Auth/GoTrue is not used for dashboard identity.',
    },
  });

  // Retained for reference/inspection only — never activated. Supabase
  // Auth/GoTrue is not this app's dashboard identity root of trust.
  providerRegistry.register('auth', 'supabase', supabaseAuthProvider, {
    priority: 100,
    healthCheck: async () => {
      try {
        await supabaseAuthProvider.getSession();
        return 'healthy';
      } catch {
        return 'down';
      }
    },
    meta: { vendor: 'supabase', builtIn: true, description: 'Legacy — superseded by the self-hosted auth provider.' },
  });

  providerRegistry.register('database', 'supabase', supabaseDatabaseProvider, {
    priority: 0,
    healthCheck: async () => {
      try {
        await supabaseDatabaseProvider.rpc('admin_count_profiles');
        return 'healthy';
      } catch {
        return 'degraded';
      }
    },
    meta: { vendor: 'supabase', builtIn: true },
  });

  providerRegistry.register('realtime', 'supabase', supabaseRealtimeProvider, {
    priority: 0,
    meta: { vendor: 'supabase', builtIn: true },
  });

  // --- Email: Self-hosted API provider ---
  // Routes through the self-hosted backend server (server/routes/email.ts).
  // The backend resolves the actual vendor (Resend/SendGrid/SMTP) from DB config.
  const defaultEmailProvider = createApiEmailProvider('__default__');
  providerRegistry.register('email', 'api', defaultEmailProvider, {
    priority: 5,
    healthCheck: async () => {
      try {
        const API_BASE = import.meta.env.VITE_API_BASE_URL;
        const res = await fetch(`${API_BASE}/api/email/health`);
        return res.ok ? 'healthy' : 'down';
      } catch {
        return 'down';
      }
    },
    meta: {
      vendor: 'self-hosted',
      builtIn: true,
      description: 'Routes email via self-hosted backend → Resend/SendGrid/SMTP based on DB config',
    },
  });

  // Stub email as fallback
  providerRegistry.register('email', 'stub', stubEmailProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true, description: 'No-op email — configure a real provider' },
  });

  providerRegistry.register('ai', 'stub', stubAIProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  providerRegistry.register('sms', 'stub', stubSmsProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  providerRegistry.register('storage', 'stub', stubStorageProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  providerRegistry.register('search', 'stub', stubSearchProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  providerRegistry.register('notification', 'stub', stubNotificationProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  providerRegistry.register('cache', 'memory', stubCacheProvider, {
    priority: 50,
    meta: { vendor: 'in-memory', builtIn: true, description: 'In-memory cache — not persistent' },
  });

  providerRegistry.register('feature_flag', 'stub', stubFeatureFlagProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  providerRegistry.register('widget', 'stub', stubWidgetDeliveryProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  providerRegistry.register('billing', 'stub', stubBillingProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  providerRegistry.register('captcha', 'stub', stubCaptchaProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  providerRegistry.register('cdn', 'stub', stubCDNProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true },
  });

  // --- Geo Enrichment: stub fallback (centroid only, server-side resolution) ---
  providerRegistry.register('geo_enrichment', 'stub', stubGeoEnrichmentProvider, {
    priority: 100,
    meta: {
      vendor: 'stub',
      builtIn: true,
      description: 'No external IP→geo lookup. Centroid fallback always available server-side.',
    },
  });

  // --- Map Tiles: OpenStreetMap default (no key) + stub no-map fallback ---
  providerRegistry.register('map_tiles', 'osm', osmMapTilesProvider, {
    priority: 0,
    meta: {
      vendor: 'openstreetmap',
      builtIn: true,
      description: 'OpenStreetMap public tiles. No API key required. Best for simple installs.',
      // Legacy registry name kept for backwards compatibility — schema renamed to osm_public.
      aliasOf: 'osm_public',
    },
  });
  // Register the same instance under the new schema name so admin UI lookups
  // by `osm_public` resolve to the working OSM provider.
  providerRegistry.register('map_tiles', 'osm_public', osmMapTilesProvider, {
    priority: 0,
    meta: {
      vendor: 'openstreetmap',
      builtIn: true,
      description: 'OpenStreetMap public tiles. No API key required. Best for simple installs.',
    },
  });
  providerRegistry.register('map_tiles', 'stub', stubMapTilesProvider, {
    priority: 100,
    meta: { vendor: 'stub', builtIn: true, description: 'No-map fallback' },
  });

  // Set active defaults for core providers
  providerRegistry.setActive('auth', 'self-hosted');
  providerRegistry.setActive('database', 'supabase');
  providerRegistry.setActive('realtime', 'supabase');
  providerRegistry.setActive('email', 'api');
  providerRegistry.setActive('map_tiles', 'osm');

  console.info('[Providers] Bootstrap complete:', providerRegistry.getSummary());
}
