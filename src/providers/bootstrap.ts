// ============================================
// PROVIDER BOOTSTRAP
// Registers all default (Supabase + stub) providers at app startup.
// Real provider implementations are registered here as they are built.
// ============================================

import { providerRegistry } from './registry';
import { supabaseAuthProvider } from './supabase/auth';
import { supabaseDatabaseProvider } from './supabase/database';
import { supabaseRealtimeProvider } from './supabase/realtime';
import { createEdgeFunctionEmailProvider } from './email/edge-function';
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
} from './stubs';

let bootstrapped = false;

/**
 * Register all default providers.
 * Called once at app startup.
 * Supabase implementations get priority 0 (default).
 * Edge function providers get priority 5.
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

  // --- Email: Edge Function provider (routes through send-email edge function) ---
  // Register a generic "edge-function" email provider.
  // The edge function itself resolves the actual vendor (Resend/SendGrid/SMTP)
  // based on DB config. This is a workspace-aware factory, so we register
  // a default instance. Real workspace-scoped instances are created on demand.
  const defaultEmailProvider = createEdgeFunctionEmailProvider('__default__');
  providerRegistry.register('email', 'edge-function', defaultEmailProvider, {
    priority: 5,
    healthCheck: async () => {
      // Health check: invoke the edge function with a dry-run
      try {
        // We can't easily health-check without a real workspace, so return unknown
        return 'unknown';
      } catch {
        return 'down';
      }
    },
    meta: {
      vendor: 'edge-function',
      builtIn: true,
      description: 'Routes email via edge function → Resend/SendGrid/SMTP based on DB config',
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
  providerRegistry.setActive('email', 'edge-function');

  console.info('[Providers] Bootstrap complete:', providerRegistry.getSummary());
}
