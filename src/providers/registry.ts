// ============================================
// PROVIDER REGISTRY
// Central registry for all provider types.
// Supports: register, resolve (global → workspace override → fallback), health checks.
// ============================================

import type {
  AuthProvider,
  DatabaseProvider,
  RealtimeProvider,
  EmailProvider,
  AIProvider,
  StorageProvider,
  SearchProvider,
  NotificationProvider,
  CacheProvider,
  FeatureFlagProvider,
  WidgetDeliveryProvider,
} from '@/types/providers';
import type { BillingProvider, CaptchaProvider, CDNProvider } from '@/types/providers-extended';

// All supported provider type keys
export const PROVIDER_TYPE_KEYS = [
  'auth', 'database', 'realtime', 'email', 'ai', 'storage',
  'search', 'notification', 'cache', 'feature_flag',
  'widget', 'billing', 'captcha', 'cdn',
] as const;

export type ProviderTypeKey = typeof PROVIDER_TYPE_KEYS[number];

// Map provider type keys to their interface types
export interface ProviderTypeMap {
  auth: AuthProvider;
  database: DatabaseProvider;
  realtime: RealtimeProvider;
  email: EmailProvider;
  ai: AIProvider;
  storage: StorageProvider;
  search: SearchProvider;
  notification: NotificationProvider;
  cache: CacheProvider;
  feature_flag: FeatureFlagProvider;
  widget: WidgetDeliveryProvider;
  billing: BillingProvider;
  captcha: CaptchaProvider;
  cdn: CDNProvider;
}

export type ProviderHealth = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface RegisteredProvider<T = unknown> {
  name: string;
  type: ProviderTypeKey;
  instance: T;
  priority: number; // lower = higher priority (0 = default/fallback)
  healthCheck?: () => Promise<ProviderHealth>;
  meta?: Record<string, unknown>;
}

interface ProviderEntry {
  providers: Map<string, RegisteredProvider>;
  activeProviderName: string | null;
}

/**
 * ProviderRegistry is the single source of truth for all provider instances.
 * 
 * Resolution order:
 * 1. Workspace-level override (if set)
 * 2. Global active provider (set by admin)
 * 3. Fallback: highest-priority registered provider
 * 4. Noop/stub provider (if registered as fallback)
 */
export class ProviderRegistry {
  private entries = new Map<ProviderTypeKey, ProviderEntry>();
  private workspaceOverrides = new Map<string, Map<ProviderTypeKey, string>>(); // wsId → type → providerName
  private healthCache = new Map<string, { health: ProviderHealth; checkedAt: number }>();
  private listeners = new Set<() => void>();

  private getOrCreateEntry(type: ProviderTypeKey): ProviderEntry {
    if (!this.entries.has(type)) {
      this.entries.set(type, { providers: new Map(), activeProviderName: null });
    }
    return this.entries.get(type)!;
  }

  /**
   * Register a provider implementation.
   */
  register<K extends ProviderTypeKey>(
    type: K,
    name: string,
    instance: ProviderTypeMap[K],
    options: {
      priority?: number;
      healthCheck?: () => Promise<ProviderHealth>;
      meta?: Record<string, unknown>;
    } = {}
  ): void {
    const entry = this.getOrCreateEntry(type);
    entry.providers.set(name, {
      name,
      type,
      instance,
      priority: options.priority ?? 10,
      healthCheck: options.healthCheck,
      meta: options.meta,
    });
    this.notify();
  }

  /**
   * Unregister a provider.
   */
  unregister(type: ProviderTypeKey, name: string): void {
    const entry = this.entries.get(type);
    if (entry) {
      entry.providers.delete(name);
      if (entry.activeProviderName === name) {
        entry.activeProviderName = null;
      }
      this.notify();
    }
  }

  /**
   * Set the globally active provider for a type.
   */
  setActive(type: ProviderTypeKey, name: string): void {
    const entry = this.getOrCreateEntry(type);
    if (!entry.providers.has(name)) {
      console.warn(`[ProviderRegistry] Cannot activate unknown provider: ${type}/${name}`);
      return;
    }
    entry.activeProviderName = name;
    this.notify();
  }

  /**
   * Set a workspace-level override.
   */
  setWorkspaceOverride(workspaceId: string, type: ProviderTypeKey, providerName: string): void {
    if (!this.workspaceOverrides.has(workspaceId)) {
      this.workspaceOverrides.set(workspaceId, new Map());
    }
    this.workspaceOverrides.get(workspaceId)!.set(type, providerName);
    this.notify();
  }

  /**
   * Remove a workspace-level override.
   */
  removeWorkspaceOverride(workspaceId: string, type: ProviderTypeKey): void {
    this.workspaceOverrides.get(workspaceId)?.delete(type);
    this.notify();
  }

  /**
   * Resolve the active provider for a given type.
   * Resolution: workspace override → global active → highest priority fallback
   */
  resolve<K extends ProviderTypeKey>(type: K, workspaceId?: string): ProviderTypeMap[K] | null {
    const entry = this.entries.get(type);
    if (!entry || entry.providers.size === 0) return null;

    // 1. Workspace override
    if (workspaceId) {
      const overrideName = this.workspaceOverrides.get(workspaceId)?.get(type);
      if (overrideName && entry.providers.has(overrideName)) {
        return entry.providers.get(overrideName)!.instance as ProviderTypeMap[K];
      }
    }

    // 2. Global active
    if (entry.activeProviderName && entry.providers.has(entry.activeProviderName)) {
      return entry.providers.get(entry.activeProviderName)!.instance as ProviderTypeMap[K];
    }

    // 3. Fallback: lowest priority number
    const sorted = [...entry.providers.values()].sort((a, b) => a.priority - b.priority);
    return (sorted[0]?.instance as ProviderTypeMap[K]) ?? null;
  }

  /**
   * Get all registered providers for a type.
   */
  getProviders(type: ProviderTypeKey): RegisteredProvider[] {
    const entry = this.entries.get(type);
    if (!entry) return [];
    return [...entry.providers.values()];
  }

  /**
   * Get the active provider name for a type.
   */
  getActiveName(type: ProviderTypeKey, workspaceId?: string): string | null {
    if (workspaceId) {
      const override = this.workspaceOverrides.get(workspaceId)?.get(type);
      if (override) return override;
    }
    return this.entries.get(type)?.activeProviderName ?? null;
  }

  /**
   * Check health of a specific provider.
   */
  async checkHealth(type: ProviderTypeKey, name: string): Promise<ProviderHealth> {
    const entry = this.entries.get(type);
    const provider = entry?.providers.get(name);
    if (!provider?.healthCheck) return 'unknown';

    const cacheKey = `${type}:${name}`;
    const cached = this.healthCache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt < 30_000) {
      return cached.health;
    }

    try {
      const health = await provider.healthCheck();
      this.healthCache.set(cacheKey, { health, checkedAt: Date.now() });
      return health;
    } catch {
      this.healthCache.set(cacheKey, { health: 'down', checkedAt: Date.now() });
      return 'down';
    }
  }

  /**
   * Check health of all providers for a type.
   */
  async checkAllHealth(type: ProviderTypeKey): Promise<Record<string, ProviderHealth>> {
    const providers = this.getProviders(type);
    const results: Record<string, ProviderHealth> = {};
    await Promise.all(
      providers.map(async (p) => {
        results[p.name] = await this.checkHealth(type, p.name);
      })
    );
    return results;
  }

  /**
   * Subscribe to registry changes.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  /**
   * Get a summary of all registered providers and their status.
   */
  getSummary(): Record<ProviderTypeKey, {
    registered: string[];
    active: string | null;
  }> {
    const summary = {} as Record<ProviderTypeKey, { registered: string[]; active: string | null }>;
    for (const type of PROVIDER_TYPE_KEYS) {
      const entry = this.entries.get(type);
      summary[type] = {
        registered: entry ? [...entry.providers.keys()] : [],
        active: entry?.activeProviderName ?? null,
      };
    }
    return summary;
  }
}

// Singleton instance
export const providerRegistry = new ProviderRegistry();
