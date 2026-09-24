/**
 * Workspace-authenticated Commerce connection management — the backend for
 * Settings → Commerce → WooCommerce (src/pages/app/settings). Every route
 * goes through authorizeWorkspaceAccess; every DB query is scoped by
 * workspaceId. No route here ever returns a decrypted secret.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { authorizeWorkspaceAccess } from '../../lib/workspaceAuth.js';
import { checkModuleAccess } from '../../middleware/featureGating.js';
import {
  disconnectConnection,
  rotateConnectionCredential,
  updateConnectionPermissions,
} from '../../services/commerce/lifecycle.js';
import { runCapabilityHandshake } from '../../services/commerce/pairing.js';
import { getConnectionForWorkspace } from '../../services/commerce/gateway.js';
import { enqueueSyncJob } from '../../services/commerce/sync.js';
import { isDirectProvider, providerProfile } from '../../services/commerce/providers.js';

export const commerceConnectionsRouter = Router({ mergeParams: true });

function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig?: ServerConfig }).serverConfig as ServerConfig;
}

const CONNECTION_FIELDS =
  'id, provider_type, store_id, approved_origin, protocol_version, connector_version, woocommerce_version, wordpress_version, hpos_enabled, capabilities, permissions, health, catalog_ready, direct_live_read, last_seen_at, last_success_at, last_event_at, last_live_read_at, last_sync_at, last_error_code, last_error_at, created_at, rotated_at, external_store_id, platform_version, last_health_check_at';

commerceConnectionsRouter.get('/:workspaceId/commerce/connections', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const config = serverConfigOf(req);
  if (!auth.isAdmin) {
    const gate = await checkModuleAccess(config.supabaseUrl, config.supabaseServiceRoleKey, req.params.workspaceId, 'commerce');
    if (!gate.allowed) return res.status(403).json({ error: 'commerce_not_entitled' });
  }

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_connections')
    .select(CONNECTION_FIELDS)
    .eq('workspace_id', req.params.workspaceId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'internal_error' });
  res.json({ connections: data ?? [] });
});

commerceConnectionsRouter.get('/:workspaceId/commerce/connections/:connectionId', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;

  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb
    .from('commerce_connections')
    .select(`${CONNECTION_FIELDS}, workspace_id`)
    .eq('id', req.params.connectionId)
    .eq('workspace_id', req.params.workspaceId) // tenant scoping
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'internal_error' });
  if (!data) return res.status(404).json({ error: 'not_found' });

  const [{ count: productCount }, { data: syncJobs }] = await Promise.all([
    sb.from('commerce_products').select('id', { count: 'exact', head: true }).eq('connection_id', data.id),
    sb.from('commerce_sync_jobs').select('job_type, status, created_at').eq('connection_id', data.id).order('created_at', { ascending: false }).limit(1),
  ]);

  res.json({ connection: data, productCount: productCount ?? 0, lastSyncJob: syncJobs?.[0] ?? null });
});

commerceConnectionsRouter.post('/:workspaceId/commerce/connections/:connectionId/disconnect', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  await disconnectConnection(serverConfigOf(req), req.params.workspaceId, req.params.connectionId, auth.userId);
  res.json({ ok: true });
});

commerceConnectionsRouter.post('/:workspaceId/commerce/connections/:connectionId/rotate', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  try {
    // The new secret is not returned here — rotation happens plugin-side
    // through a fresh pairing-style credential push, this endpoint only
    // invalidates the old one. (Full re-pairing UX is documented as a
    // known limitation — see the engineering report.)
    await rotateConnectionCredential(serverConfigOf(req), req.params.workspaceId, req.params.connectionId, auth.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'rotate_failed' });
  }
});

/** Manual "check connection" for a direct (never-polled) store: once a minute, across replicas. */
const MANUAL_CHECK_MIN_INTERVAL_MS = 60_000;

commerceConnectionsRouter.post('/:workspaceId/commerce/connections/:connectionId/test', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const config = serverConfigOf(req);
  // Scoped to the caller's workspace: a connection id from another workspace
  // is "not found", never refreshed.
  const connection = await getConnectionForWorkspace(config, req.params.workspaceId, req.params.connectionId).catch(() => null);
  if (!connection) return res.status(404).json({ error: 'not_found' });
  if (isDirectProvider(connection.provider_type)) {
    const sb = getServiceClient(config);
    const { data } = await sb.from('commerce_connections').select('last_health_check_at').eq('id', connection.id).maybeSingle();
    const lastCheckAt = (data as { last_health_check_at?: string | null } | null)?.last_health_check_at;
    const last = lastCheckAt ? new Date(lastCheckAt).getTime() : 0;
    if (Date.now() - last < MANUAL_CHECK_MIN_INTERVAL_MS) {
      return res.status(429).json({ error: 'check_rate_limited', retryAfterSeconds: Math.ceil((MANUAL_CHECK_MIN_INTERVAL_MS - (Date.now() - last)) / 1000) });
    }
  }
  await runCapabilityHandshake(config, connection.id);
  res.json({ ok: true });
});

commerceConnectionsRouter.post('/:workspaceId/commerce/connections/:connectionId/sync', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const connection = await getConnectionForWorkspace(serverConfigOf(req), req.params.workspaceId, req.params.connectionId).catch(() => null);
  if (!connection) return res.status(404).json({ error: 'not_found' });
  // Direct connectors keep no catalogue in Web Yar — there is nothing to sync.
  if (!providerProfile(connection.provider_type).catalogSync) return res.status(400).json({ error: 'sync_not_applicable' });
  try {
    const job = await enqueueSyncJob(serverConfigOf(req), req.params.workspaceId, req.params.connectionId, 'manual_resync');
    res.json({ ok: true, jobId: job?.id ?? null });
  } catch (err) {
    res.status(409).json({ error: 'sync_already_running' });
  }
});

const permissionsSchema = z.object({
  products: z.boolean().optional(),
  prices: z.boolean().optional(),
  stock: z.boolean().optional(),
  orders: z.boolean().optional(),
  order_status: z.boolean().optional(),
  tracking: z.boolean().optional(),
  customer_history: z.boolean().optional(),
  coupons: z.boolean().optional(),
  // Separate switch for public reviews (read live by direct connectors).
  reviews: z.boolean().optional(),
}).strict();

commerceConnectionsRouter.patch('/:workspaceId/commerce/connections/:connectionId/permissions', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = permissionsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
  try {
    await updateConnectionPermissions(serverConfigOf(req), req.params.workspaceId, req.params.connectionId, auth.userId, parsed.data);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'update_failed' });
  }
});
