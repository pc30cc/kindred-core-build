// ============================================
// PROVIDER INTERFACES
// All business logic depends on these interfaces,
// never on vendor-specific SDKs directly.
// ============================================

// --- Auth Provider ---
export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface SignUpParams {
  email: string;
  password: string;
  website: string;
  fullName?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
  redirectTo?: string;
}

export interface SignInParams {
  email: string;
  password: string;
}

export interface AuthProvider {
  signUp(params: SignUpParams): Promise<{ user: AuthUser | null; error: Error | null }>;
  signIn(params: SignInParams): Promise<{ session: AuthSession | null; error: Error | null }>;
  signOut(): Promise<{ error: Error | null }>;
  getSession(): Promise<AuthSession | null>;
  resetPasswordRequest(email: string, redirectTo?: string): Promise<{ error: Error | null }>;
  updatePassword(newPassword: string): Promise<{ error: Error | null }>;
  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void;
  verifyEmail?(token: string): Promise<{ error: Error | null }>;
}

// --- Database Provider ---
export interface QueryOptions {
  table: string;
  select?: string;
  filters?: Record<string, unknown>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
  offset?: number;
}

export interface MutationResult<T = unknown> {
  data: T | null;
  error: Error | null;
}

export interface DatabaseProvider {
  query<T = unknown>(options: QueryOptions): Promise<MutationResult<T[]>>;
  getById<T = unknown>(table: string, id: string, select?: string): Promise<MutationResult<T>>;
  insert<T = unknown>(table: string, data: Partial<T>): Promise<MutationResult<T>>;
  update<T = unknown>(table: string, id: string, data: Partial<T>): Promise<MutationResult<T>>;
  delete(table: string, id: string): Promise<MutationResult<null>>;
  rpc<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<MutationResult<T>>;
}

// --- Realtime Provider ---
export interface RealtimeChannel {
  subscribe(): void;
  unsubscribe(): void;
  on(event: string, callback: (payload: unknown) => void): RealtimeChannel;
}

export interface RealtimeProvider {
  channel(name: string): RealtimeChannel;
  removeChannel(channel: RealtimeChannel): void;
  onPresenceSync(channel: string, callback: (state: Record<string, unknown>) => void): () => void;
  trackPresence(channel: string, data: Record<string, unknown>): Promise<void>;
}

// --- Email Provider ---
/**
 * A message the dashboard asks the backend to send.
 *
 * No `from` and no `replyTo`: the sender identity comes from the platform
 * email provider (Super Admin → Providers → Email) and the backend now
 * rejects a request that tries to supply one. Leaving them on this type
 * would only let a future caller write code the server answers with a 400.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  templateId?: string;
  templateData?: Record<string, unknown>;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<{ id: string; error: Error | null }>;
  sendBatch(messages: EmailMessage[]): Promise<{ ids: string[]; error: Error | null }>;
}

// --- Storage Provider ---
export interface StorageFile {
  name: string;
  size: number;
  type: string;
  url: string;
  path: string;
  createdAt: string;
}

export interface StorageProvider {
  upload(bucket: string, path: string, file: File | Blob): Promise<MutationResult<StorageFile>>;
  download(bucket: string, path: string): Promise<MutationResult<Blob>>;
  getPublicUrl(bucket: string, path: string): string;
  delete(bucket: string, paths: string[]): Promise<MutationResult<null>>;
  list(bucket: string, prefix?: string): Promise<MutationResult<StorageFile[]>>;
}

// --- AI Provider ---
export interface AICompletionParams {
  model?: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AIProvider {
  complete(params: AICompletionParams): Promise<{ text: string; error: Error | null }>;
  embed(text: string): Promise<{ vector: number[]; error: Error | null }>;
}

// --- Search Provider ---
export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SearchProvider {
  search(index: string, query: string, options?: { limit?: number; filters?: Record<string, unknown> }): Promise<{ results: SearchResult[]; error: Error | null }>;
  index(indexName: string, documents: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>): Promise<{ error: Error | null }>;
}

// --- Notification Provider ---
export interface NotificationPayload {
  userId: string;
  title: string;
  body: string;
  type: 'info' | 'warning' | 'error' | 'success';
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationProvider {
  send(payload: NotificationPayload): Promise<{ error: Error | null }>;
  sendBatch(payloads: NotificationPayload[]): Promise<{ error: Error | null }>;
  getForUser(userId: string, options?: { limit?: number; unreadOnly?: boolean }): Promise<{ notifications: NotificationPayload[]; error: Error | null }>;
  markRead(notificationId: string): Promise<{ error: Error | null }>;
}

// --- Cache Provider ---
export interface CacheProvider {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  flush(): Promise<void>;
}

// --- Feature Flag Provider ---
export interface FeatureFlagProvider {
  isEnabled(flag: string, context?: Record<string, unknown>): Promise<boolean>;
  getAll(context?: Record<string, unknown>): Promise<Record<string, boolean>>;
}

// --- Widget Delivery Provider ---
export interface WidgetConfig {
  workspaceId: string;
  enabled: boolean;
  branding: {
    primaryColor: string;
    launcherText?: string;
    welcomeMessage?: string;
    logoUrl?: string;
  };
  locale: string;
  features: {
    chat: boolean;
    knowledgeBase: boolean;
    visitorTracking: boolean;
  };
  allowedOrigins: string[];
}

export interface WidgetDeliveryProvider {
  getConfig(workspaceId: string, origin: string): Promise<MutationResult<WidgetConfig>>;
  validateOrigin(workspaceId: string, origin: string): Promise<boolean>;
}

// --- SMS Provider ---
export interface SmsMessage {
  to: string;
  body: string;
  from?: string;
  templateId?: string;
  templateData?: Record<string, unknown>;
}

export interface SmsProvider {
  send(message: SmsMessage): Promise<{ id: string; error: Error | null }>;
  sendBatch(messages: SmsMessage[]): Promise<{ ids: string[]; error: Error | null }>;
  getBalance?(): Promise<{ balance: number; currency: string; error: Error | null }>;
}
