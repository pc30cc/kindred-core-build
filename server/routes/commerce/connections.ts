/**
 * Workspace-authenticated Commerce connection management — the backend for
 * Settings → Commerce → WooCommerce (src/pages/app/settings). Every route
 * goes through authorizeWorkspaceAccess; every DB query is scoped by
 * workspaceId. No route here ever returns a decrypted secret.
 */
import { Router, type Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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
import { enqueueSyncJob } from '../../services/commerce/sync.js';
import { isDirectProvider } from '../../services/commerce/providers.js';
import { getProviderDescriptor } from '../../services/commerce/connectors/registry.js';

export const commerceConnectionsRouter = Router({ mergeParams: true });

/**
 * "Check connection" makes a live call to the merchant's server, so it is
 * bounded twice: per caller (this limiter) and per connection (the
 * single-flight map below — ten clicks while one check is running share that
 * one check instead of starting ten).
 */
const testLimiter = rateLimit({
  windowMs: 60_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.workspaceId}:${req.params.connectionId}:${ipKeyGenerator(req.ip ?? '')}`,
});
const MAX_INFLIGHT_CHECKS = 200;
const inflightChecks = new Map<string, Promise<void>>();

function checkOnce(config: ServerConfig, workspaceId: string, connectionId: string): Promise<void> {
  const key = `${workspaceId}:${connectionId}`;
  const existing = inflightChecks.get(key);
  if (existing) return existing;
  if (inflightChecks.size >= MAX_INFLIGHT_CHECKS) return runCapabilityHandshake(config, connectionId, { workspaceId });
  const p = runCapabilityHandshake(config, connectionId, { workspaceId }).finally(() => inflightChecks.delete(key));
  inflightChecks.set(key, p);
  return p;
}

function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig: ServerConfig }).serverConfig;
}

const CONNECTION_FIELDS =
  'id, provider_type, store_id, approved_origin, protocol_version, connector_version, woocommerce_version, wordpress_version, hpos_enabled, capabilities, permissions, health, catalog_ready, direct_live_read, last_seen_at, last_success_at, last_event_at, last_live_read_at, last_sync_at, last_error_code, last_error_at, created_at, rotated_at, external_store_id, platform_version, last_health_check_at';

/**
 * `platform_version` (WHMCS version) arrives with the WHMCS migration. Read
 * with `*` and projected here so a database that has not run it yet still
 * serves the WooCommerce panel exactly as before.
 */
const RESPONSE_FIELDS = [...CONNECTION_FIELDS.split(',').map((f) => f.trim()), 'platform_version', 'store_name'];
function project(row: Record<string, unknown>, extra: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of [...RESPONSE_FIELDS, ...extra]) if (f in row) out[f] = row[f];
  return out;
}

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
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'internal_error' });
  res.json({ connections: (data ?? []).map((row: Record<string, unknown>) => project(row)) });
});

commerceConnectionsRouter.get('/:workspaceId/commerce/connections/:connectionId', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;

  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb
    .from('commerce_connections')
    .select('*')
    .eq('id', req.params.connectionId)
    .eq('workspace_id', req.params.workspaceId) // tenant scoping
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'internal_error' });
  if (!data) return res.status(404).json({ error: 'not_found' });

  // A live-queried provider has no product index and no sync jobs — do not
  // spend two queries proving it.
  if (getProviderDescriptor(String(data.provider_type))?.usesCatalogIndex === false) {
    return res.json({ connection: project(data, ['workspace_id']), productCount: null, lastSyncJob: null });
  }

  const [{ count: productCount }, { data: syncJobs }] = await Promise.all([
    sb.from('commerce_products').select('id', { count: 'exact', head: true }).eq('connection_id', data.id),
    sb.from('commerce_sync_jobs').select('job_type, status, created_at').eq('connection_id', data.id).order('created_at', { ascending: false }).limit(1),
  ]);

  res.json({ connection: project(data, ['workspace_id']), productCount: productCount ?? 0, lastSyncJob: syncJobs?.[0] ?? null });
});

commerceConnectionsRouter.post('/:workspaceId/commerce/connections/:connectionId/disconnect', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const connectionId = z.string().uuid().safeParse(req.params.connectionId);
  if (!connectionId.success) return res.status(400).json({ error: 'invalid_connection_id' });
  try {
    await disconnectConnection(serverConfigOf(req), req.params.workspaceId, connectionId.data, auth.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[commerce] disconnect failed:', err);
    res.status(500).json({ error: 'disconnect_failed' });
  }
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

commerceConnectionsRouter.post('/:workspaceId/commerce/connections/:connectionId/test', testLimiter, async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const config = serverConfigOf(req);
  // A direct store is never polled; its manual check is also bounded across
  // replicas (the per-caller limiter above is per process).
  const { data: target } = await getServiceClient(config)
    .from('commerce_connections')
    .select('provider_type, last_health_check_at')
    .eq('id', req.params.connectionId)
    .eq('workspace_id', req.params.workspaceId)
    .maybeSingle();
  // A row outside this workspace falls through to the workspace-scoped
  // handshake below, which refuses it (and the 404 after it).
  if (target && isDirectProvider(String(target.provider_type))) {
    const lastCheckAt = (target as { last_health_check_at?: string | null }).last_health_check_at;
    const last = lastCheckAt ? new Date(lastCheckAt).getTime() : 0;
    if (Date.now() - last < MANUAL_CHECK_MIN_INTERVAL_MS) {
      return res.status(429).json({ error: 'check_rate_limited', retryAfterSeconds: Math.ceil((MANUAL_CHECK_MIN_INTERVAL_MS - (Date.now() - last)) / 1000) });
    }
  }
  // Workspace-scoped: the handshake only ever touches this workspace's own
  // connection (it used to accept any connection id it was given).
  await checkOnce(config, req.params.workspaceId, req.params.connectionId);

  // Report what the check actually observed, stamped with when — the panel
  // shows this instead of guessing a live state from an old row.
  const { data } = await getServiceClient(config)
    .from('commerce_connections')
    .select('health, last_error_code, last_success_at, last_error_at')
    .eq('id', req.params.connectionId)
    .eq('workspace_id', req.params.workspaceId)
    .maybeSingle();
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: data.health === 'connected', health: data.health, lastErrorCode: data.last_error_code ?? null, checkedAt: new Date().toISOString() });
});

commerceConnectionsRouter.post('/:workspaceId/commerce/connections/:connectionId/sync', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const { data: target } = await getServiceClient(serverConfigOf(req))
    .from('commerce_connections')
    .select('provider_type')
    .eq('id', req.params.connectionId)
    .eq('workspace_id', req.params.workspaceId)
    .maybeSingle();
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (getProviderDescriptor(String(target.provider_type))?.usesCatalogIndex === false) {
    return res.status(400).json({ error: 'sync_not_applicable' });
  }
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
  // WHMCS sections (shared/commerce/whmcs.ts WHMCS_CONNECTION_PERMISSIONS).
  // `orders` above is shared by both providers.
  catalog: z.boolean().optional(),
  announcements: z.boolean().optional(),
  knowledgebase: z.boolean().optional(),
  networkstatus: z.boolean().optional(),
  services: z.boolean().optional(),
  domains: z.boolean().optional(),
  invoices: z.boolean().optional(),
  tickets: z.boolean().optional(),
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
