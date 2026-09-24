/**
 * Commerce Gateway — the ONLY path from anywhere in Web Yar to a merchant's
 * store. Resolves the tenant-scoped connection, enforces capability +
 * owner-permission gates, enforces the per-call deadline, builds the
 * connector, and normalizes every failure into the safe error taxonomy
 * (shared/commerce/types.ts CommerceErrorCode) before it can reach a caller.
 *
 * TENANT ISOLATION: every lookup here takes workspaceId AND connectionId (or
 * installationId) and the DB query is scoped on BOTH — a connection id that
 * belongs to another workspace resolves to "not found", never "found, wrong
 * tenant". See src/test/security/commerceTenantIsolation.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  CommerceError,
  type CommerceCapability,
  type CommerceConnectorContext,
} from '../../../shared/commerce/types.js';
import { readInstallationSecret } from './credentials.js';
import { resolveConnector } from './connectors/registry.js';
import { recordCommerceToolAudit, type CommerceToolAuditRow } from './audit.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { providerProfile } from './providers.js';
import { connectionGuard } from './liveGuard.js';

export type CommercePermissionKey =
  | 'products' | 'prices' | 'stock' | 'orders'
  | 'order_status' | 'tracking' | 'customer_history' | 'coupons' | 'reviews';

export interface CommerceConnectionRow {
  id: string;
  workspace_id: string;
  installation_id: string;
  provider_type: string;
  store_id: string;
  approved_origin: string;
  capabilities: string[];
  permissions: Record<CommercePermissionKey, boolean>;
  health: string;
  catalog_ready: boolean;
  revoked_at: string | null;
  protocol_version: string;
  /** Direct connectors (OpenCart): the store inside the installation. */
  external_store_id?: string | null;
  platform_version?: string | null;
  last_error_at?: string | null;
}

const CALL_DEADLINE_MS = 5_000;

export const CONNECTION_COLUMNS = 'id, workspace_id, installation_id, provider_type, store_id, approved_origin, capabilities, permissions, health, catalog_ready, revoked_at, protocol_version, external_store_id, platform_version, last_error_at';

export async function getConnectionForWorkspace(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
): Promise<CommerceConnectionRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_connections')
    .select(CONNECTION_COLUMNS)
    .eq('id', connectionId)
    .eq('workspace_id', workspaceId) // tenant scoping — never trust connectionId alone
    .maybeSingle();
  if (error) throw new Error(`commerce connection read failed: ${error.message}`);
  return (data as CommerceConnectionRow | null) ?? null;
}

export async function getActiveConnectionForWorkspace(
  config: ServerConfig,
  workspaceId: string,
): Promise<CommerceConnectionRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_connections')
    .select(CONNECTION_COLUMNS)
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`commerce connection read failed: ${error.message}`);
  return (data as CommerceConnectionRow | null) ?? null;
}

function assertUsable(connection: CommerceConnectionRow): void {
  if (connection.revoked_at) throw new CommerceError('commerce_not_connected', 'installation revoked');
  if (connection.health === 'disconnected') throw new CommerceError('commerce_not_connected', 'not connected');
  if (connection.health === 'protocol_mismatch') throw new CommerceError('protocol_mismatch', 'incompatible protocol version');
  if (connection.health === 'plugin_outdated') throw new CommerceError('connector_outdated', 'plugin version too old');
}

function assertCapability(connection: CommerceConnectionRow, capability: CommerceCapability): void {
  if (!connection.capabilities?.includes(capability)) {
    throw new CommerceError('commerce_permission_denied', `capability not negotiated: ${capability}`);
  }
}

/** Owner-controlled permission gate — enforced here, never only hidden in UI (spec §30). */
export function assertPermission(connection: CommerceConnectionRow, permission: CommercePermissionKey): void {
  if (connection.permissions?.[permission] !== true) {
    throw new CommerceError('commerce_permission_denied', `permission not granted: ${permission}`);
  }
}

/** Maps an owner permission to the plan-level entitlement family that must ALSO allow it (spec §46). */
function entitlementFeatureFor(permission: CommercePermissionKey): string {
  switch (permission) {
    case 'orders':
    case 'order_status':
    case 'tracking':
      return 'commerce_orders';
    case 'customer_history':
      return 'commerce_customer_history';
    default:
      return 'commerce_catalog';
  }
}

/** Plan-level module gate only — used before ANY commerce read, including reads served from Web Yar's own index. */
export async function assertCommerceModuleEntitled(config: ServerConfig, workspaceId: string): Promise<void> {
  const moduleResult = await checkEntitlementFromDB(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'commerce', {
    selfHostBillingUnlimited: config.selfHostBillingUnlimited,
  });
  if (!moduleResult.allowed) throw new CommerceError('commerce_permission_denied', 'commerce module not entitled on this plan');
}

/** Plan entitlement gate — separate from, and in addition to, the owner permission toggle above. */
async function assertEntitled(config: ServerConfig, workspaceId: string, permission: CommercePermissionKey | undefined): Promise<void> {
  await assertCommerceModuleEntitled(config, workspaceId);

  if (permission) {
    const feature = entitlementFeatureFor(permission);
    const featureResult = await checkEntitlementFromDB(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, feature, {
      selfHostBillingUnlimited: config.selfHostBillingUnlimited,
    });
    if (!featureResult.allowed) throw new CommerceError('commerce_permission_denied', `${feature} not entitled on this plan`);
  }
}

export interface GatewayCallOptions {
  capability: CommerceCapability;
  permission?: CommercePermissionKey;
  toolName: string;
  conversationId?: string | null;
  correlationId?: string;
  /**
   * When given, the audit row is appended here instead of being inserted on
   * its own, so a turn's calls are written in ONE multi-row INSERT by the
   * caller (see flushCommerceToolAudit). Every call is still recorded.
   */
  auditSink?: CommerceToolAuditRow[];
  /** Overrides CALL_DEADLINE_MS, e.g. with what is left of a turn's budget. */
  deadlineAt?: number;
  /** Pre-resolved row (already workspace-scoped) to skip a second SELECT. */
  connection?: CommerceConnectionRow;
}

/**
 * Runs one connector call under the full gate stack: usability, capability,
 * permission, bounded deadline, safe-error normalization, and audit
 * recording. Every commerce tool goes through this — there is no other
 * path to a connector instance.
 */
export async function withCommerceConnector<T>(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  options: GatewayCallOptions,
  fn: (connector: ReturnType<typeof resolveConnector>, ctx: CommerceConnectorContext) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const correlationId = options.correlationId ?? randomUUID();
  let success = false;
  let safeErrorCode: string | null = null;

  let connection: CommerceConnectionRow | null = null;
  try {
    connection = options.connection && options.connection.id === connectionId && options.connection.workspace_id === workspaceId
      ? options.connection
      : await getConnectionForWorkspace(config, workspaceId, connectionId);
    if (!connection) throw new CommerceError('commerce_not_connected', 'no such connection for this workspace');

    assertUsable(connection);
    assertCapability(connection, options.capability);
    if (options.permission) assertPermission(connection, options.permission);
    await assertEntitled(config, workspaceId, options.permission);
    const direct = providerProfile(connection.provider_type).searchStrategy === 'direct';
    // `catalog_ready` means "Web Yar's own index is usable". A direct
    // connector has no index — it reads the store per question — so the
    // gate does not apply to it (and must not make it look unavailable).
    if (!direct && !connection.catalog_ready) throw new CommerceError('catalog_syncing', 'initial catalog sync not complete');

    const secret = await readInstallationSecret(config, connection.installation_id);
    if (!secret) throw new CommerceError('commerce_not_connected', 'no installation credential on file');

    const connector = resolveConnector(connection.provider_type, {
      origin: connection.approved_origin,
      installationId: connection.installation_id,
      secret,
      storeUrl: connection.store_id,
      externalStoreId: connection.external_store_id ?? null,
      platformVersion: connection.platform_version ?? null,
    });

    const ctx: CommerceConnectorContext = {
      workspaceId,
      connectionId,
      installationId: connection.installation_id,
      capabilities: connection.capabilities as CommerceCapability[],
      correlationId,
      deadlineAt: options.deadlineAt ?? Date.now() + CALL_DEADLINE_MS,
    };

    // Live stores get a concurrency cap and a circuit breaker per connection.
    const result = direct ? await connectionGuard.run(connection.id, () => fn(connector, ctx)) : await fn(connector, ctx);
    success = true;
    if (direct) void observeDirectHealth(config, connection, null);
    return result;
  } catch (err) {
    if (err instanceof CommerceError) {
      safeErrorCode = err.code;
      if (connection && providerProfile(connection.provider_type).searchStrategy === 'direct') void observeDirectHealth(config, connection, err.code);
      throw err;
    }
    safeErrorCode = 'commerce_invalid_response';
    throw new CommerceError('commerce_invalid_response', err instanceof Error ? err.message : String(err));
  } finally {
    const row: CommerceToolAuditRow = {
      workspaceId,
      connectionId,
      conversationId: options.conversationId ?? null,
      correlationId,
      toolName: options.toolName,
      durationMs: Date.now() - startedAt,
      success,
      safeErrorCode,
      liveRevalidated: success && !!connection && providerProfile(connection.provider_type).searchStrategy === 'direct',
    };
    if (options.auditSink) options.auditSink.push(row);
    else await recordCommerceToolAudit(config, row);
  }
}

/** A degraded store is re-marked at most this often, so failures are not a write storm. */
const HEALTH_WRITE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Health for direct connectors comes from the requests the AI actually
 * makes — there is no heartbeat. Writes happen only on a TRANSITION
 * (connected → degraded after a transport failure, anything → connected on
 * success), never per successful read, and a failing store is written at most
 * once per HEALTH_WRITE_MIN_INTERVAL_MS. Best effort; never throws.
 */
export async function observeDirectHealth(config: ServerConfig, connection: CommerceConnectionRow, errorCode: string | null): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const now = new Date();
    if (errorCode === null) {
      if (connection.health === 'connected') return;
      if (!['degraded', 'offline', 'reconnecting'].includes(connection.health)) return;
      await sb.from('commerce_connections').update({ health: 'connected', last_success_at: now.toISOString(), last_seen_at: now.toISOString() }).eq('id', connection.id).eq('health', connection.health);
      connection.health = 'connected';
      return;
    }
    if (errorCode !== 'commerce_live_unavailable' && errorCode !== 'commerce_timeout') return;
    const last = connection.last_error_at ? new Date(connection.last_error_at).getTime() : 0;
    if (connection.health !== 'connected' && now.getTime() - last < HEALTH_WRITE_MIN_INTERVAL_MS) return;
    await sb.from('commerce_connections').update({ health: 'degraded', last_error_code: errorCode, last_error_at: now.toISOString() }).eq('id', connection.id);
    connection.health = 'degraded';
    connection.last_error_at = now.toISOString();
  } catch {
    // observability only
  }
}

/**
 * Which connection a conversation is about — never just "the newest one in
 * the workspace" when anything better is known:
 *
 *   1. the one whose store matches the page the visitor is on (a shop with
 *      several stores in one workspace shows the widget on each of them),
 *   2. the connection this visitor is signed in to (a live identity link),
 *   3. the only active connection of the workspace,
 *   4. otherwise the newest active one (the pre-existing behaviour, kept so a
 *      workspace with several legacy stores still gets catalogue answers).
 *
 * All candidates are this workspace's own rows; a link or page origin can
 * only choose AMONG them. Private reads additionally require the identity
 * link to be on the chosen connection, and the store re-validates it.
 */
export async function resolveConversationConnection(
  config: ServerConfig,
  workspaceId: string,
  hints: { visitorId?: string | null; conversationId?: string | null; pageUrl?: string | null; skipLinkLookup?: boolean },
): Promise<CommerceConnectionRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_connections')
    .select(CONNECTION_COLUMNS)
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`commerce connection read failed: ${error.message}`);
  const rows = (data ?? []) as CommerceConnectionRow[];
  if (rows.length <= 1) return rows[0] ?? null;

  if (hints.pageUrl) {
    try {
      const page = new URL(hints.pageUrl);
      const byOrigin = rows.filter((r) => { try { return new URL(r.approved_origin).origin === page.origin; } catch { return false; } });
      // Several stores of one OpenCart install can share an origin; the
      // longest matching store path wins.
      const byPath = byOrigin
        .filter((r) => { try { return page.pathname.startsWith(new URL(r.store_id).pathname); } catch { return false; } })
        .sort((a, b) => b.store_id.length - a.store_id.length);
      if (byPath[0]) return byPath[0];
      if (byOrigin[0]) return byOrigin[0];
    } catch { /* not a URL — ignore */ }
  }

  // A turn that will not read anything private (no intent) does not need
  // the visitor's link to pick a store; skip two reads.
  if (hints.skipLinkLookup) return rows[0];

  let visitorId = hints.visitorId ?? null;
  if (!visitorId && hints.conversationId) {
    const { data: conv } = await sb.from('conversations').select('visitor_session_id').eq('id', hints.conversationId).eq('workspace_id', workspaceId).maybeSingle();
    const convRow = (conv ?? {}) as { visitor_session_id?: string | null };
    visitorId = convRow.visitor_session_id ?? null;
  }
  if (visitorId) {
    const { data: link } = await sb
      .from('commerce_customer_links')
      .select('connection_id')
      .eq('workspace_id', workspaceId)
      .eq('visitor_id', visitorId)
      .gte('expires_at', new Date().toISOString())
      .order('verified_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const linkedId = ((link ?? {}) as { connection_id?: string }).connection_id;
    const linked = rows.find((r) => r.id === linkedId);
    if (linked) return linked;
  }

  return rows[0];
}
