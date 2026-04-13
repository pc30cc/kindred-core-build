// ============================================
// STUB / NOOP PROVIDER IMPLEMENTATIONS
// Used as fallback defaults when no real provider is configured.
// Each stub logs warnings and returns safe empty values.
// ============================================

import type {
  AuthProvider, DatabaseProvider, RealtimeProvider, EmailProvider,
  AIProvider, StorageProvider, SearchProvider, NotificationProvider,
  CacheProvider, FeatureFlagProvider, WidgetDeliveryProvider, SmsProvider,
} from '@/types/providers';
import type { BillingProvider, CaptchaProvider, CDNProvider } from '@/types/providers-extended';

const warn = (provider: string, method: string) =>
  console.warn(`[StubProvider] ${provider}.${method}() called — no real provider configured.`);

const err = (provider: string) =>
  new Error(`No ${provider} provider configured. Please configure one in Admin → Providers.`);

// --- Auth Stub ---
export const stubAuthProvider: AuthProvider = {
  async signUp() { warn('auth', 'signUp'); return { user: null, error: err('auth') }; },
  async signIn() { warn('auth', 'signIn'); return { session: null, error: err('auth') }; },
  async signOut() { warn('auth', 'signOut'); return { error: null }; },
  async getSession() { warn('auth', 'getSession'); return null; },
  async resetPasswordRequest() { warn('auth', 'resetPasswordRequest'); return { error: err('auth') }; },
  async updatePassword() { warn('auth', 'updatePassword'); return { error: err('auth') }; },
  onAuthStateChange() { warn('auth', 'onAuthStateChange'); return () => {}; },
};

// --- Database Stub ---
export const stubDatabaseProvider: DatabaseProvider = {
  async query() { warn('database', 'query'); return { data: null, error: err('database') }; },
  async getById() { warn('database', 'getById'); return { data: null, error: err('database') }; },
  async insert() { warn('database', 'insert'); return { data: null, error: err('database') }; },
  async update() { warn('database', 'update'); return { data: null, error: err('database') }; },
  async delete() { warn('database', 'delete'); return { data: null, error: err('database') }; },
  async rpc() { warn('database', 'rpc'); return { data: null, error: err('database') }; },
};

// --- Realtime Stub ---
export const stubRealtimeProvider: RealtimeProvider = {
  channel() {
    warn('realtime', 'channel');
    return { subscribe() {}, unsubscribe() {}, on() { return this; } };
  },
  removeChannel() { warn('realtime', 'removeChannel'); },
  onPresenceSync() { warn('realtime', 'onPresenceSync'); return () => {}; },
  async trackPresence() { warn('realtime', 'trackPresence'); },
};

// --- Email Stub ---
export const stubEmailProvider: EmailProvider = {
  async send() { warn('email', 'send'); return { id: '', error: err('email') }; },
  async sendBatch() { warn('email', 'sendBatch'); return { ids: [], error: err('email') }; },
};

// --- SMS Stub ---
export const stubSmsProvider: SmsProvider = {
  async send() { warn('sms', 'send'); return { id: '', error: err('sms') }; },
  async sendBatch() { warn('sms', 'sendBatch'); return { ids: [], error: err('sms') }; },
};

// --- AI Stub ---
export const stubAIProvider: AIProvider = {
  async complete() { warn('ai', 'complete'); return { text: '', error: err('ai') }; },
  async embed() { warn('ai', 'embed'); return { vector: [], error: err('ai') }; },
};

// --- Storage Stub ---
export const stubStorageProvider: StorageProvider = {
  async upload() { warn('storage', 'upload'); return { data: null, error: err('storage') }; },
  async download() { warn('storage', 'download'); return { data: null, error: err('storage') }; },
  getPublicUrl() { warn('storage', 'getPublicUrl'); return ''; },
  async delete() { warn('storage', 'delete'); return { data: null, error: err('storage') }; },
  async list() { warn('storage', 'list'); return { data: null, error: err('storage') }; },
};

// --- Search Stub ---
export const stubSearchProvider: SearchProvider = {
  async search() { warn('search', 'search'); return { results: [], error: err('search') }; },
  async index() { warn('search', 'index'); return { error: err('search') }; },
};

// --- Notification Stub ---
export const stubNotificationProvider: NotificationProvider = {
  async send() { warn('notification', 'send'); return { error: err('notification') }; },
  async sendBatch() { warn('notification', 'sendBatch'); return { error: err('notification') }; },
  async getForUser() { warn('notification', 'getForUser'); return { notifications: [], error: err('notification') }; },
  async markRead() { warn('notification', 'markRead'); return { error: err('notification') }; },
};

// --- Cache Stub (in-memory, non-persistent) ---
const memCache = new Map<string, { value: unknown; expiresAt: number }>();

export const stubCacheProvider: CacheProvider = {
  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = memCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      memCache.delete(key);
      return null;
    }
    return entry.value as T;
  },
  async set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    memCache.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
    });
  },
  async delete(key: string): Promise<void> { memCache.delete(key); },
  async flush(): Promise<void> { memCache.clear(); },
};

// --- Feature Flag Stub ---
export const stubFeatureFlagProvider: FeatureFlagProvider = {
  async isEnabled() { return false; },
  async getAll() { return {}; },
};

// --- Widget Delivery Stub ---
export const stubWidgetDeliveryProvider: WidgetDeliveryProvider = {
  async getConfig() { warn('widget', 'getConfig'); return { data: null, error: err('widget') }; },
  async validateOrigin() { warn('widget', 'validateOrigin'); return false; },
};

// --- Billing Stub ---
export const stubBillingProvider: BillingProvider = {
  async getPlans() { warn('billing', 'getPlans'); return { data: [], error: null }; },
  async getSubscription() { warn('billing', 'getSubscription'); return { data: null, error: null }; },
  async createCheckoutSession() { warn('billing', 'createCheckoutSession'); return { data: null, error: err('billing') }; },
  async createPortalSession() { warn('billing', 'createPortalSession'); return { data: null, error: err('billing') }; },
  async cancelSubscription() { warn('billing', 'cancelSubscription'); return { data: null, error: err('billing') }; },
  async isFeatureAvailable() { return true; }, // default: all features available
  async getUsage() { return { data: null, error: err('billing') }; },
};

// --- Captcha Stub ---
export const stubCaptchaProvider: CaptchaProvider = {
  getSiteKey() { return ''; },
  getScriptUrl() { return ''; },
  async verify() { return { success: true }; }, // default: always pass
  isEnabled() { return false; },
};

// --- CDN Stub ---
export const stubCDNProvider: CDNProvider = {
  getBaseUrl() { return ''; },
  async purge() { warn('cdn', 'purge'); return { data: null, error: err('cdn') }; },
  getAssetUrl(path: string) { return path; },
  async upload() { warn('cdn', 'upload'); return { data: null, error: err('cdn') }; },
};
