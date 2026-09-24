/**
 * The only path from Web Yar to a WHMCS installation.
 *
 * Order of operations for every read (cheapest refusal first, nothing sent
 * to WHMCS that a local rule already forbids):
 *
 *   1. connection usable (not revoked / disconnected / incompatible)
 *   2. capability negotiated by the addon
 *   3. owner permission on the connection (Settings → WHMCS)
 *   4. plan entitlement (existing, in-process cached)
 *   5. per-turn call budget
 *   6. cache — PUBLIC catalogue: served within TTL.
 *              PRIVATE account data: served only after a live
 *              `session.check` in THIS turn confirmed the grant and the WHMCS
 *              user's permission, and only when the question did not ask for
 *              the current state explicitly. A failed check drops every
 *              cached entry of that grant; there is no stale fallback.
 *   7. circuit breaker, rate limits, concurrency caps (whmcs/guard.ts)
 *   8. the signed call (connectors/whmcs.ts), coalesced with any identical
 *      call already in flight
 *
 * Health is written only when it CHANGES (breaker opens/closes, credential
 * refused) and `last_seen_at` at most once per LAST_SEEN_MIN_INTERVAL_MS per
 * connection — never once per successful read.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { CommerceError, type CommerceCapability } from '../../../../shared/commerce/types.js';
import type {
  WhmcsConnectionPermission,
  WhmcsGrantRef,
  WhmcsOp,
  WhmcsUserPermission,
} from '../../../../shared/commerce/whmcs.js';
import { checkEntitlementFromDB } from '../../../middleware/featureGating.js';
import { readInstallationSecret } from '../credentials.js';
import type { CommerceConnectionRow } from '../gateway.js';
import { WhmcsConnector, WhmcsHttpError, type WhmcsTransport } from '../connectors/whmcs.js';
import { BoundedTtlCache } from './cache.js';
import { CircuitBreaker, ConcurrencyLimiter, TokenBucketLimiter } from './guard.js';
import { normalizeSession, type LinkScope } from './normalize.js';
import { getWhmcsPolicy, invalidateWhmcsPolicy } from './policy.js';
import { WHMCS_PUBLIC_RESOURCES, type WhmcsAccountResource } from '../../../../shared/commerce/whmcs.js';

// ── Bounds (documented in docs/commerce/WHMCS.md §Limits) ─────────────────
export const WHMCS_MAX_CALLS_PER_TURN = 3;
export const WHMCS_TURN_DEADLINE_MS = 6_000;
export const PUBLIC_CATALOG_TTL_MS = 5 * 60_000;
export const PRIVATE_TTL_MS: Record<WhmcsAccountResource, number> = {
  services: 60_000,
  domains: 120_000,
  invoices: 15_000,
  orders: 60_000,
  tickets: 30_000,
};
const LAST_SEEN_MIN_INTERVAL_MS = 15 * 60_000;

const OP_CAPABILITY: Record<WhmcsOp, CommerceCapability | null> = {
  'health': null,
  'content.announcements': 'content.announcements.read',
  'content.knowledgebase': 'content.knowledgebase.read',
  'content.networkstatus': 'content.networkstatus.read',
  'catalog.search': 'catalog.read',
  'catalog.browse': 'catalog.read',
  'session.check': 'identity.grant',
  'services.list': 'account.services.read',
  'services.get': 'account.services.read',
  'domains.list': 'account.domains.read',
  'domains.get': 'account.domains.read',
  'invoices.list': 'account.invoices.read',
  'invoices.get': 'account.invoices.read',
  'orders.list': 'account.orders.read',
  'orders.get': 'account.orders.read',
  'tickets.list': 'account.tickets.read',
  'tickets.get': 'account.tickets.read',
};

function entitlementFor(permission: WhmcsConnectionPermission): string {
  if (permission === 'catalog' || WHMCS_PUBLIC_RESOURCES.some((p) => p === permission)) return 'commerce_catalog';
  if (permission === 'orders') return 'commerce_orders';
  return 'commerce_customer_history';
}

// ── Process-wide, bounded state ───────────────────────────────────────────
const cache = new BoundedTtlCache<unknown>({
  maxEntries: 2_000,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 32 * 1024,
  maxInflight: 1_000,
});
const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 30_000, maxKeys: 5_000 });
const installationRate = new TokenBucketLimiter({ capacity: 60, refillPerSecond: 1, maxKeys: 5_000 });
const identityRate = new TokenBucketLimiter({ capacity: 12, refillPerSecond: 0.2, maxKeys: 20_000 });
const installationConcurrency = new ConcurrencyLimiter({ max: 4, maxKeys: 5_000 });
const identityConcurrency = new ConcurrencyLimiter({ max: 2, maxKeys: 20_000 });
const lastSeenWritten = new Map<string, number>();

export function whmcsRuntimeStats() {
  return {
    cache: cache.snapshot(),
    breakers: breaker.size(),
    rateKeys: installationRate.size() + identityRate.size(),
    concurrencyKeys: installationConcurrency.size() + identityConcurrency.size(),
    lastSeenKeys: lastSeenWritten.size,
  };
}

/** Test hook — never called by production code. */
export function __resetWhmcsRuntimeForTests(): void {
  invalidateWhmcsPolicy();
  cache.clear();
  lastSeenWritten.clear();
  breaker.clear();
  installationRate.clear();
  identityRate.clear();
}

// ── Per-turn context ──────────────────────────────────────────────────────
export interface WhmcsTurnMetrics {
  httpCalls: number;
  cacheHits: number;
  coalesced: number;
  accessChecks: number;
  bytesIn: number;
  errors: string[];
}

export interface WhmcsTurnContext {
  config: ServerConfig;
  workspaceId: string;
  connection: CommerceConnectionRow;
  correlationId: string;
  deadlineAt: number;
  metrics: WhmcsTurnMetrics;
  /** Set once a live access check (or a live private read) succeeded this turn. */
  accessConfirmed?: { grantId: string; permissions: WhmcsUserPermission[] } | null;
  secret?: string | null;
  connectorFactory?: (transport: WhmcsTransport) => WhmcsConnector;
}

export function createWhmcsTurnContext(
  config: ServerConfig,
  workspaceId: string,
  connection: CommerceConnectionRow,
  opts: { correlationId?: string; deadlineMs?: number; connectorFactory?: (t: WhmcsTransport) => WhmcsConnector } = {},
): WhmcsTurnContext {
  return {
    config,
    workspaceId,
    connection,
    correlationId: opts.correlationId ?? randomUUID(),
    deadlineAt: Date.now() + (opts.deadlineMs ?? WHMCS_TURN_DEADLINE_MS),
    metrics: { httpCalls: 0, cacheHits: 0, coalesced: 0, accessChecks: 0, bytesIn: 0, errors: [] },
    accessConfirmed: null,
    connectorFactory: opts.connectorFactory,
  };
}

export function linkScopeOf(connection: CommerceConnectionRow): LinkScope {
  return { origin: connection.approved_origin, baseUrl: String(connection.store_id || connection.approved_origin).replace(/\/+$/, '') };
}

// ── Gates ─────────────────────────────────────────────────────────────────
function assertConnectionUsable(connection: CommerceConnectionRow): void {
  if (connection.revoked_at || connection.health === 'disconnected') throw new CommerceError('commerce_not_connected', 'not connected');
  if (connection.health === 'protocol_mismatch') throw new CommerceError('protocol_mismatch', 'incompatible protocol version');
  if (connection.health === 'plugin_outdated') throw new CommerceError('connector_outdated', 'addon too old');
}

async function assertEntitled(ctx: WhmcsTurnContext, permission: WhmcsConnectionPermission): Promise<void> {
  const { config, workspaceId } = ctx;
  for (const feature of ['commerce', entitlementFor(permission)]) {
    const r = await checkEntitlementFromDB(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, feature, {
      selfHostBillingUnlimited: config.selfHostBillingUnlimited,
    });
    if (!r.allowed) throw new CommerceError('commerce_permission_denied', `${feature} not entitled on this plan`);
  }
}

function assertOwnerPermission(connection: CommerceConnectionRow, permission: WhmcsConnectionPermission): void {
  if (connection.permissions?.[permission] !== true) {
    throw new CommerceError('commerce_permission_denied', `permission not granted: ${permission}`);
  }
}

function assertCapability(connection: CommerceConnectionRow, op: WhmcsOp): void {
  const cap = OP_CAPABILITY[op];
  if (cap && !(connection.capabilities ?? []).includes(cap)) {
    throw new CommerceError('commerce_permission_denied', `capability not negotiated: ${cap}`);
  }
}

// ── Cache keys ────────────────────────────────────────────────────────────
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/** installation | workspace | identity | owner-permission set | op | normalized input. */
export function whmcsCacheKey(
  connection: CommerceConnectionRow,
  workspaceId: string,
  grant: WhmcsGrantRef | null,
  op: WhmcsOp,
  params: Record<string, unknown>,
): string {
  const who = grant ? `g:${grant.grantId}:u:${grant.userId}:c:${grant.clientId}` : 'public';
  const perms = digest(stableJson(connection.permissions ?? {}));
  return `whmcs|${connection.installation_id}|${workspaceId}|${who}|${perms}|${op}|${digest(stableJson(params))}`;
}

function grantPrefix(connection: CommerceConnectionRow, workspaceId: string, grant: WhmcsGrantRef): string {
  return `whmcs|${connection.installation_id}|${workspaceId}|g:${grant.grantId}:`;
}

export function dropGrantCache(connection: CommerceConnectionRow, workspaceId: string, grant: WhmcsGrantRef): void {
  cache.deletePrefix(grantPrefix(connection, workspaceId, grant));
}

// ── Health, written on change only ────────────────────────────────────────
async function writeHealth(ctx: WhmcsTurnContext, patch: Record<string, unknown>): Promise<void> {
  try {
    await getServiceClient(ctx.config)
      .from('commerce_connections')
      .update(patch)
      .eq('id', ctx.connection.id)
      .eq('workspace_id', ctx.workspaceId);
  } catch (err) {
    console.warn('[commerce.whmcs] health write failed:', err instanceof Error ? err.message : err);
  }
}

function noteSuccess(ctx: WhmcsTurnContext): void {
  const key = ctx.connection.installation_id;
  const recovered = breaker.onSuccess(key);
  const now = Date.now();
  const last = lastSeenWritten.get(ctx.connection.id) ?? 0;
  const healthChanged = recovered !== null || (ctx.connection.health !== 'connected' && ctx.connection.health !== 'degraded');
  if (!healthChanged && now - last < LAST_SEEN_MIN_INTERVAL_MS) return;
  lastSeenWritten.delete(ctx.connection.id);
  lastSeenWritten.set(ctx.connection.id, now);
  if (lastSeenWritten.size > 5_000) lastSeenWritten.delete(lastSeenWritten.keys().next().value as string);
  const iso = new Date(now).toISOString();
  void writeHealth(ctx, {
    last_seen_at: iso,
    last_success_at: iso,
    ...(healthChanged ? { health: 'connected' } : {}),
  });
}

function noteFailure(ctx: WhmcsTurnContext, err: CommerceError): void {
  const iso = new Date().toISOString();
  if (err instanceof WhmcsHttpError && err.status === 401 && ctx.connection.health !== 'authentication_error') {
    // The addon refused OUR signature: a credential problem, surfaced once.
    // (A 403 — a section the WHMCS admin switched off — is not one.)
    void writeHealth(ctx, { health: 'authentication_error', last_error_code: err.code, last_error_at: iso });
    return;
  }
  if (err.code === 'commerce_live_unavailable' || err.code === 'commerce_timeout') {
    if (breaker.onFailure(ctx.connection.installation_id) === 'opened') {
      void writeHealth(ctx, { health: 'offline', last_error_code: err.code, last_error_at: iso });
    }
  }
}

// ── The call ──────────────────────────────────────────────────────────────
async function liveCall(
  ctx: WhmcsTurnContext,
  op: WhmcsOp,
  params: Record<string, unknown>,
  grant: WhmcsGrantRef | null,
): Promise<unknown> {
  if (ctx.metrics.httpCalls >= WHMCS_MAX_CALLS_PER_TURN) throw new CommerceError('rate_limited', 'per-turn WHMCS call budget exhausted');
  if (Date.now() >= ctx.deadlineAt) throw new CommerceError('commerce_timeout', 'WHMCS turn deadline exceeded');

  const installKey = ctx.connection.installation_id;
  const identityKey = grant ? `${installKey}:${grant.grantId}` : null;
  if (!breaker.allow(installKey)) throw new CommerceError('commerce_live_unavailable', 'WHMCS temporarily unavailable (circuit open)');
  if (!installationRate.take(installKey) || (identityKey && !identityRate.take(identityKey))) {
    throw new CommerceError('rate_limited', 'WHMCS request rate limit');
  }
  const releaseInstall = installationConcurrency.acquire(installKey);
  if (!releaseInstall) throw new CommerceError('rate_limited', 'WHMCS concurrency limit');
  const releaseIdentity = identityKey ? identityConcurrency.acquire(identityKey) : () => {};
  if (!releaseIdentity) {
    releaseInstall();
    throw new CommerceError('rate_limited', 'WHMCS concurrency limit');
  }

  try {
    if (ctx.secret === undefined) ctx.secret = await readInstallationSecret(ctx.config, ctx.connection.installation_id);
    if (!ctx.secret) throw new CommerceError('commerce_not_connected', 'no installation credential on file');
    const transport: WhmcsTransport = {
      origin: ctx.connection.approved_origin,
      baseUrl: linkScopeOf(ctx.connection).baseUrl,
      installationId: ctx.connection.installation_id,
      secret: ctx.secret,
    };
    const connector = ctx.connectorFactory ? ctx.connectorFactory(transport) : new WhmcsConnector(transport);
    ctx.metrics.httpCalls += 1;
    const result = await connector.call(op, params, { deadlineAt: ctx.deadlineAt, correlationId: ctx.correlationId, grant });
    ctx.metrics.httpCalls += result.attempts - 1;
    ctx.metrics.bytesIn += result.bytes;
    if (!op.startsWith('content.')) noteSuccess(ctx);
    else breaker.onSuccess(installKey);
    return result.data;
  } catch (err) {
    const safe = err instanceof CommerceError ? err : new CommerceError('commerce_invalid_response', 'WHMCS call failed');
    if (!op.startsWith('content.')) noteFailure(ctx, safe);
    else if (safe.code === 'commerce_live_unavailable' || safe.code === 'commerce_timeout') breaker.onFailure(ctx.connection.installation_id);
    throw safe;
  } finally {
    releaseIdentity();
    releaseInstall();
  }
}

export interface WhmcsReadRequest<T> {
  op: WhmcsOp;
  params: Record<string, unknown>;
  permission: WhmcsConnectionPermission;
  /** Required for every account op; absent for the public catalogue. */
  grant?: WhmcsGrantRef | null;
  /** The WHMCS user permission this read needs on the client account. */
  userPermission?: WhmcsUserPermission | null;
  /** The visitor asked for the CURRENT state: bypass the private cache. */
  freshOnly?: boolean;
  normalize: (data: unknown) => T;
}

export interface WhmcsReadResult<T> {
  value: T;
  source: 'live' | 'cache';
  ageMs: number;
}

/**
 * Confirms, live, that the grant still stands and what the WHMCS user may
 * see. At most once per turn; its answer gates every cached private value
 * served in that turn.
 */
async function confirmAccess(ctx: WhmcsTurnContext, grant: WhmcsGrantRef): Promise<WhmcsUserPermission[]> {
  if (ctx.accessConfirmed?.grantId === grant.grantId) return ctx.accessConfirmed.permissions;
  assertCapability(ctx.connection, 'session.check');
  ctx.metrics.accessChecks += 1;
  const key = `whmcs-session|${ctx.connection.installation_id}|${grant.grantId}|${grant.userId}|${grant.clientId}`;
  const { promise, shared } = cache.coalesce(key, () => liveCall(ctx, 'session.check', {}, grant));
  if (shared) ctx.metrics.coalesced += 1;
  let raw: unknown;
  try {
    raw = await promise;
  } catch (err) {
    // WHMCS answers a logged-out / switched / expired grant with 403: that
    // must purge what was cached under it just like `valid: false` does.
    if (err instanceof CommerceError && (err.code === 'identity_expired' || err.code === 'account_permission_denied')) {
      dropGrantCache(ctx.connection, ctx.workspaceId, grant);
    }
    throw err;
  }
  const state = normalizeSession(raw);
  if (!state.valid) {
    dropGrantCache(ctx.connection, ctx.workspaceId, grant);
    throw new CommerceError('identity_expired', 'WHMCS grant no longer valid');
  }
  ctx.accessConfirmed = { grantId: grant.grantId, permissions: state.permissions };
  return state.permissions;
}

export async function whmcsRead<T>(ctx: WhmcsTurnContext, req: WhmcsReadRequest<T>): Promise<WhmcsReadResult<T>> {
  const { connection, workspaceId } = ctx;
  const grant = req.grant ?? null;
  const isContent = WHMCS_PUBLIC_RESOURCES.some((p) => p === req.permission);
  const isPrivate = !isContent && req.permission !== 'catalog';
  const platform = await getWhmcsPolicy(ctx.config);
  if (!platform.enabled || platform.sections[req.permission] === false) {
    throw new CommerceError('commerce_permission_denied', 'disabled by platform');
  }

  assertConnectionUsable(connection);
  assertCapability(connection, req.op);
  assertOwnerPermission(connection, req.permission);
  if (isPrivate && !grant) throw new CommerceError('identity_required', 'no WHMCS identity bound');
  await assertEntitled(ctx, req.permission);

  const key = whmcsCacheKey(connection, workspaceId, grant, req.op, req.params);
  const ttl = req.permission === 'knowledgebase' ? 10 * 60_000 : isPrivate ? PRIVATE_TTL_MS[req.permission as keyof typeof PRIVATE_TTL_MS] : PUBLIC_CATALOG_TTL_MS;

  // Network visibility can require login and change at any time. Always check
  // WHMCS live; concurrent identical reads are still coalesced.
  if (!req.freshOnly && req.permission !== 'networkstatus') {
    const hit = cache.get(key);
    if (hit) {
      if (isPrivate) {
        // Never serve private data on the strength of a TTL alone.
        const permissions = await confirmAccess(ctx, grant!);
        if (req.userPermission && !permissions.includes(req.userPermission)) {
          dropGrantCache(connection, workspaceId, grant!);
          throw new CommerceError('account_permission_denied', `WHMCS user lacks ${req.userPermission}`);
        }
      }
      ctx.metrics.cacheHits += 1;
      return { value: hit.value as T, source: 'cache', ageMs: hit.ageMs };
    }
  }

  const { promise, shared } = cache.coalesce(key, async () => {
    const data = await liveCall(ctx, req.op, req.params, grant);
    return req.normalize(data);
  });
  if (shared) ctx.metrics.coalesced += 1;
  let value: T;
  try {
    value = (await promise) as T;
  } catch (err) {
    if (grant && err instanceof CommerceError && (err.code === 'identity_expired' || err.code === 'account_permission_denied')) {
      dropGrantCache(connection, workspaceId, grant);
    }
    throw err;
  }
  if (req.permission !== 'networkstatus') cache.set(key, value, ttl, Buffer.byteLength(JSON.stringify(value ?? null), 'utf8'));
  return { value, source: 'live', ageMs: 0 };
}
