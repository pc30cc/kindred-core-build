// ============================================
// PROVIDER BOOTSTRAP
// Registers all default (Supabase + stub) providers at app startup.
// Email uses self-hosted API provider — NO Edge Functions.
// ============================================

import { providerRegistry } from './registry';
import { supabaseAuthProvider } from './supabase/auth';
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

  // --- Core providers (Supabase implementations) ---
  providerRegistry.register('auth', 'supabase', supabaseAuthProvider, {
    priority: 0,
    healthCheck: async () => {
      try {
        await supabaseAuthProvider.getSession();
        return 'healthy';
      } catch {
        return 'down';
      }
    },
    meta: { vendor: 'supabase', builtIn: true },
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

  // Set active defaults for core providers
  providerRegistry.setActive('auth', 'supabase');
  providerRegistry.setActive('database', 'supabase');
  providerRegistry.setActive('realtime', 'supabase');
  providerRegistry.setActive('email', 'api');

  console.info('[Providers] Bootstrap complete:', providerRegistry.getSummary());
}
