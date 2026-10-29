// ============================================
// PROVIDER BOOTSTRAP
// Registers all default (Supabase + stub) providers at app startup.
// Email is the server's own: the browser sends no mail.
// ============================================

import { providerRegistry } from './registry';
import { selfHostedAuthProvider } from './selfHosted/auth';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
import {
  stubDatabaseProvider,
  stubRealtimeProvider,
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
        const API_BASE = RESOLVED_API_BASE;
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

  // The legacy Supabase Auth provider (src/providers/supabase/auth.ts) has
  // been deleted from runtime source entirely — it is not registered here,
  // so syncProvidersFromDB() (called on every app start) can never resolve
  // a `default_auth_provider` DB row to it, no matter what that row
  // contains. There is deliberately no "registered but inactive" auth
  // entry: that shape was itself the accidental-reactivation risk — a
  // stray/attacker-written app_runtime_config row naming 'supabase' would
  // have silently flipped providerRegistry's active auth provider with no
  // UI ever surfacing the change.
  //
  // --- Database / Realtime: owned by the server ---
  // The browser has no database client at all: every read and write goes
  // through the Express API, which reaches PostgreSQL through DATABASE_URL
  // (server/db) — a self-hosted PostgreSQL or a Supabase project used purely
  // as a database. These entries exist so Super Admin → Providers shows what
  // is in use and can probe it; nothing resolves them to run queries.
  providerRegistry.register('database', 'self-hosted', stubDatabaseProvider, {
    priority: 0,
    healthCheck: async () => {
      try {
        const res = await fetch(`${RESOLVED_API_BASE}/api/health/database`, { credentials: 'include' });
        return res.ok ? 'healthy' : 'down';
      } catch {
        return 'down';
      }
    },
    meta: {
      vendor: 'self-hosted',
      builtIn: true,
      description: 'PostgreSQL behind the server API (DATABASE_URL) — the browser holds no database credentials.',
    },
  });

  providerRegistry.register('realtime', 'self-hosted', stubRealtimeProvider, {
    priority: 0,
    meta: {
      vendor: 'self-hosted',
      builtIn: true,
      description: 'Resolved per workspace by the server: Centrifugo, Supabase Realtime (when configured) or polling.',
    },
  });

  // --- Email: owned by the server ---
  // The browser sends no mail. The server sends every platform mail itself,
  // for something that happened (a reset, an invitation, a receipt), through
  // the provider chosen in Super Admin → Providers → Email. This entry exists
  // so Super Admin → Providers shows what is in use and can probe it, like
  // the database's; it has nothing to send with (the stub refuses). The
  // browser's own sender, which posted any recipient and body to
  // /api/email/send-channel, is gone with that route.
  providerRegistry.register('email', 'self-hosted', stubEmailProvider, {
    priority: 0,
    healthCheck: async () => {
      try {
        const res = await fetch(`${RESOLVED_API_BASE}/api/email/health`);
        return res.ok ? 'healthy' : 'down';
      } catch {
        return 'down';
      }
    },
    meta: {
      vendor: 'self-hosted',
      builtIn: true,
      description: 'Sent by the server through the provider chosen in Super Admin → Providers → Email; the browser sends no mail.',
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
  providerRegistry.setActive('database', 'self-hosted');
  providerRegistry.setActive('realtime', 'self-hosted');
  providerRegistry.setActive('email', 'self-hosted');
  providerRegistry.setActive('map_tiles', 'osm');

  console.info('[Providers] Bootstrap complete:', providerRegistry.getSummary());
}
