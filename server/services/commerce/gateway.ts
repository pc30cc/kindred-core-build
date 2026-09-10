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
import { recordCommerceToolAudit } from './audit.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';

export type CommercePermissionKey =
  | 'products' | 'prices' | 'stock' | 'orders'
  | 'order_status' | 'tracking' | 'customer_history' | 'coupons';

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
}

const CALL_DEADLINE_MS = 5_000;

export async function getConnectionForWorkspace(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
): Promise<CommerceConnectionRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_connections')
    .select('id, workspace_id, installation_id, provider_type, store_id, approved_origin, capabilities, permissions, health, catalog_ready, revoked_at, protocol_version')
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
    .select('id, workspace_id, installation_id, provider_type, store_id, approved_origin, capabilities, permissions, health, catalog_ready, revoked_at, protocol_version')
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

  try {
    const connection = await getConnectionForWorkspace(config, workspaceId, connectionId);
    if (!connection) throw new CommerceError('commerce_not_connected', 'no such connection for this workspace');

    assertUsable(connection);
    assertCapability(connection, options.capability);
    if (options.permission) assertPermission(connection, options.permission);
    await assertEntitled(config, workspaceId, options.permission);
    if (!connection.catalog_ready) throw new CommerceError('catalog_syncing', 'initial catalog sync not complete');

    const secret = await readInstallationSecret(config, connection.installation_id);
    if (!secret) throw new CommerceError('commerce_not_connected', 'no installation credential on file');

    const connector = resolveConnector(connection.provider_type, {
      origin: connection.approved_origin,
      installationId: connection.installation_id,
      secret,
    });

    const ctx: CommerceConnectorContext = {
      workspaceId,
      connectionId,
      installationId: connection.installation_id,
      capabilities: connection.capabilities as CommerceCapability[],
      correlationId,
      deadlineAt: Date.now() + CALL_DEADLINE_MS,
    };

    const result = await fn(connector, ctx);
    success = true;
    return result;
  } catch (err) {
    if (err instanceof CommerceError) {
      safeErrorCode = err.code;
      throw err;
    }
    safeErrorCode = 'commerce_invalid_response';
    throw new CommerceError('commerce_invalid_response', err instanceof Error ? err.message : String(err));
  } finally {
    await recordCommerceToolAudit(config, {
      workspaceId,
      connectionId,
      conversationId: options.conversationId ?? null,
      correlationId,
      toolName: options.toolName,
      durationMs: Date.now() - startedAt,
      success,
      safeErrorCode,
    });
  }
}
