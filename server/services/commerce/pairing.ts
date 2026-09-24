/**
 * OAuth-style authorization-code + PKCE pairing (docs/commerce/SECURITY.md
 * §Pairing). No Consumer-Key/Secret copy-paste flow, no static global Web
 * Yar secret embedded in the plugin.
 *
 * Reuses the Telegram connector's "stage → externally verify → atomically
 * promote" shape (server/services/channels/telegram/setup.ts) for
 * credential issuance, and the existing plugin_secrets envelope
 * (server/services/commerce/credentials.ts) for storage.
 */
import { randomBytes, createHash } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { checkOutboundUrl } from '../../../shared/net/hostGuard.js';
import { CommerceError } from '../../../shared/commerce/types.js';
import { installPlugin } from '../plugins/state.js';
import { storeInstallationSecret } from './credentials.js';
import { getProviderDescriptor, isKnownProvider } from './connectors/registry.js';
import { OpenCartConnector, claimUpdateNudge, isOlderConnector } from './connectors/opencart.js';
import { writeCommerceAudit } from './audit.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

export class PairingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha256Base64Url(input: string): string {
  return base64url(createHash('sha256').update(input).digest());
}

/**
 * A billing system such as WHMCS is often installed under a path
 * (https://example.com/billing). The origin alone cannot address its API, so
 * the base URL is captured too — but it must live on the very origin being
 * paired, carry no query/fragment/credentials, and use a plain path.
 */
export function normalizeStoreBaseUrl(storeOrigin: string, storeBaseUrl: string | null | undefined): string {
  const origin = new URL(storeOrigin).origin;
  if (!storeBaseUrl) return origin;
  let base: URL;
  try {
    base = new URL(storeBaseUrl);
  } catch {
    throw new PairingError('invalid_base_url', 'store_base_url must be a valid URL');
  }
  if (base.origin !== origin) throw new PairingError('invalid_base_url', 'store_base_url must be on store_origin');
  if (base.search || base.hash || base.username || base.password) {
    throw new PairingError('invalid_base_url', 'store_base_url must be a plain URL');
  }
  const path = base.pathname.replace(/\/+$/, '');
  if (path.length > 200 || !/^(\/[A-Za-z0-9._~-]+)*$/.test(path) || path.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new PairingError('invalid_base_url', 'store_base_url path is not allowed');
  }
  return `${origin}${path}`;
}

/** Step 1 — plugin registers its pairing intent server-to-server before opening the browser. */
export async function registerPairingRequest(
  config: ServerConfig,
  input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    storeOrigin: string;
    provider?: string;
    /** Path-addressed providers: WHMCS System URL, OpenCart store base URL. */
    storeBaseUrl?: string | null;
    /** OpenCart: which store of the installation, and its version. */
    externalStoreId?: string | null;
    platformVersion?: string | null;
  },
): Promise<{ expiresAt: string }> {
  const provider = input.provider ?? 'woocommerce';
  if (!isKnownProvider(provider)) throw new PairingError('invalid_provider', 'unknown provider');
  if (!input.state || input.state.length < 16 || input.state.length > 200) {
    throw new PairingError('invalid_state', 'state must be 16-200 chars');
  }
  if (!input.codeChallenge || input.codeChallenge.length < 32) {
    throw new PairingError('invalid_challenge', 'code_challenge missing or too short');
  }

  let redirect: URL;
  let origin: URL;
  try {
    redirect = new URL(input.redirectUri);
    origin = new URL(input.storeOrigin);
  } catch {
    throw new PairingError('invalid_redirect', 'redirect_uri/store_origin must be valid URLs');
  }
  if (redirect.protocol !== 'https:') throw new PairingError('invalid_redirect', 'redirect_uri must be https');
  // Exact redirect validation: the callback must land back on the SAME
  // origin that is being paired — never an arbitrary third-party redirect.
  if (redirect.origin !== origin.origin) throw new PairingError('invalid_redirect', 'redirect_uri must match store_origin');

  const ssrf = await checkOutboundUrl(input.storeOrigin);
  if (ssrf.ok === false) throw new PairingError('unsafe_origin', `store_origin rejected: ${ssrf.reason}`);

  // Only a provider that is addressed by path (WHMCS) records a base URL. The
  // WooCommerce insert stays byte-for-byte what it was, so a database that
  // has not run the WHMCS migration yet keeps pairing stores unchanged.
  const normalizedBase = provider === 'woocommerce' ? null : normalizeStoreBaseUrl(origin.origin, input.storeBaseUrl);
  // OpenCart builds `<base>index.php?route=…` URLs, so its base keeps the
  // trailing slash.
  const baseUrl = provider === 'opencart' && normalizedBase ? `${normalizedBase}/` : normalizedBase;
  if (provider === 'opencart') {
    // One OpenCart install can serve several stores; each pairs on its own,
    // and every later call is scoped to exactly this store.
    if (!input.externalStoreId || !/^\d{1,9}$/.test(input.externalStoreId)) throw new PairingError('invalid_store', 'external_store_id required');
    if (!input.storeBaseUrl) throw new PairingError('invalid_store', 'store_url required');
  }

  const sb = getServiceClient(config);
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  const { error } = await sb.from('commerce_pairing_requests').insert({
    state: input.state,
    code_challenge: input.codeChallenge,
    redirect_uri: input.redirectUri,
    provider_type: provider,
    requested_origin: origin.origin,
    expires_at: expiresAt,
    ...(baseUrl ? { requested_base_url: baseUrl } : {}),
    ...(provider === 'opencart'
      ? { external_store_id: input.externalStoreId, platform_version: (input.platformVersion ?? '').slice(0, 20) || null }
      : {}),
  });
  if (error) throw new Error(`pairing register failed: ${error.message}`);
  return { expiresAt };
}

export interface PairingRequestView {
  state: string;
  redirectUri: string;
  requestedOrigin: string;
  providerType: string;
  storeUrl?: string | null;
  expiresAt: string;
  expired: boolean;
  alreadyAuthorized: boolean;
}

export async function getPairingRequest(config: ServerConfig, state: string): Promise<PairingRequestView | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_pairing_requests')
    .select('state, redirect_uri, requested_origin, provider_type, expires_at, authorized_at, consumed_at, requested_base_url')
    .eq('state', state)
    .maybeSingle();
  if (error) throw new Error(`pairing lookup failed: ${error.message}`);
  if (!data) return null;
  return {
    state: data.state,
    redirectUri: data.redirect_uri,
    requestedOrigin: data.requested_origin,
    providerType: data.provider_type,
    storeUrl: (data as { requested_base_url?: string | null }).requested_base_url ?? null,
    expiresAt: data.expires_at,
    expired: new Date(data.expires_at).getTime() < Date.now() || !!data.consumed_at,
    alreadyAuthorized: !!data.authorized_at,
  };
}

const PERMISSION_KEYS = ['products', 'prices', 'stock', 'orders', 'order_status', 'tracking', 'customer_history', 'coupons', 'reviews'] as const;

/** Only known keys, only booleans — the consent screen's body is user input. */
export function sanitizePermissions(raw: Record<string, unknown> | null | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of PERMISSION_KEYS) if (typeof raw?.[key] === 'boolean') out[key] = raw[key] as boolean;
  return out;
}

/** Step 2 — an authenticated, authorized Web Yar user approves the pairing for a workspace. */
export async function approvePairingRequest(
  config: ServerConfig,
  input: { state: string; workspaceId: string; userId: string; permissions: Record<string, boolean> },
): Promise<{ redirectUrl: string }> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_pairing_requests')
    .select('state, redirect_uri, expires_at, consumed_at, authorized_at')
    .eq('state', input.state)
    .maybeSingle();
  if (error) throw new Error(`pairing lookup failed: ${error.message}`);
  if (!data) throw new PairingError('not_found', 'pairing request not found');
  if (data.consumed_at) throw new PairingError('already_used', 'this pairing request was already completed');
  if (new Date(data.expires_at).getTime() < Date.now()) throw new PairingError('expired', 'pairing request expired');

  const authorizationCode = base64url(randomBytes(32));
  const codeHash = createHash('sha256').update(authorizationCode).digest('hex');

  const { error: updateError } = await sb
    .from('commerce_pairing_requests')
    .update({
      workspace_id: input.workspaceId,
      authorized_by: input.userId,
      authorization_code_hash: codeHash,
      authorized_at: new Date().toISOString(),
      permissions: sanitizePermissions(input.permissions),
    })
    .eq('state', input.state)
    .is('consumed_at', null); // never re-authorize an already-consumed request
  if (updateError) throw new Error(`pairing approve failed: ${updateError.message}`);

  await writeCommerceAudit(config, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    action: 'commerce.pairing.approved',
    entityType: 'commerce_pairing',
    entityId: input.state,
  });

  const redirect = new URL(data.redirect_uri);
  redirect.searchParams.set('code', authorizationCode);
  redirect.searchParams.set('state', input.state);
  return { redirectUrl: redirect.toString() };
}

export interface ExchangeResult {
  installationId: string;
  connectionId: string;
  installationSecret: string;
  workspaceId: string;
  storeId: string;
  protocolVersion: string;
  providerType: string;
  /** False for a live-queried provider (WHMCS): no catalogue sync is queued. */
  usesCatalogIndex: boolean;
}

/** Step 3 — server-to-server code exchange using the PKCE verifier. */
export async function exchangePairingCode(
  config: ServerConfig,
  input: { state: string; code: string; codeVerifier: string },
): Promise<ExchangeResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_pairing_requests')
    .select('*')
    .eq('state', input.state)
    .maybeSingle();
  if (error) throw new Error(`pairing lookup failed: ${error.message}`);
  if (!data) throw new PairingError('not_found', 'pairing request not found');
  if (data.consumed_at) throw new PairingError('already_used', 'authorization code already used');
  const descriptor = getProviderDescriptor(String(data.provider_type ?? 'woocommerce'));
  if (!descriptor) throw new PairingError('invalid_provider', 'unknown provider');
  if (!data.authorized_at || !data.workspace_id || !data.authorized_by) {
    throw new PairingError('not_authorized', 'pairing was not approved');
  }
  if (new Date(data.expires_at).getTime() < Date.now()) throw new PairingError('expired', 'authorization code expired');
  if (Date.now() - new Date(data.authorized_at).getTime() > AUTHORIZATION_CODE_TTL_MS) {
    throw new PairingError('expired', 'authorization code expired');
  }

  const codeHash = createHash('sha256').update(input.code).digest('hex');
  if (codeHash !== data.authorization_code_hash) throw new PairingError('invalid_code', 'invalid authorization code');

  const computedChallenge = sha256Base64Url(input.codeVerifier);
  if (computedChallenge !== data.code_challenge) throw new PairingError('invalid_verifier', 'PKCE verification failed');

  // Single-use: consume atomically before creating anything. A concurrent
  // duplicate exchange loses this race and gets already_used.
  const { data: consumed, error: consumeError } = await sb
    .from('commerce_pairing_requests')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', data.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle();
  if (consumeError) throw new Error(`pairing consume failed: ${consumeError.message}`);
  if (!consumed) throw new PairingError('already_used', 'authorization code already used');

  // WooCommerce: one site per workspace installation (instance 'default').
  // OpenCart: one installation PER STORE — a multi-store shop connecting two
  // stores to one workspace must get two installations, two secrets and two
  // connections, or the second pairing would silently take over the first.
  const instanceKey = descriptor.providerType === 'opencart'
    ? `store:${createHash('sha256').update(String(data.requested_base_url ?? data.requested_origin)).digest('hex').slice(0, 24)}`
    : 'default';
  const installation = await installPlugin(config, data.workspace_id, descriptor.pluginId, data.authorized_by, instanceKey);
  const installationSecret = base64url(randomBytes(32));
  await storeInstallationSecret(config, installation.id, installationSecret, 'live');

  // One store (origin) = one active connection. store_id is the approved
  // origin itself — stable, unique per site, and requires no plugin-side
  // identifier generation. A provider without a catalogue index (WHMCS,
  // OpenCart) uses its base URL instead, which is still on — and re-checked
  // against — that origin; for OpenCart that keeps two stores of one install
  // on one host apart, with the numeric OpenCart store id alongside.
  const storeId = descriptor.usesCatalogIndex
    ? data.requested_origin
    : String(data.requested_base_url || data.requested_origin);
  const { data: connectionRow, error: connError } = await sb
    .from('commerce_connections')
    .upsert(
      {
        workspace_id: data.workspace_id,
        installation_id: installation.id,
        provider_type: descriptor.providerType,
        store_id: storeId,
        approved_origin: data.requested_origin,
        protocol_version: 'webyar-commerce/1',
        capabilities: [],
        health: 'reconnecting',
        catalog_ready: false,
        revoked_at: null,
        ...(descriptor.providerType === 'opencart' ? { external_store_id: data.external_store_id, platform_version: data.platform_version ?? null } : {}),
        // A provider with its own permission model (WHMCS) starts from its
        // defaults. Otherwise the owner's consent-screen choice, when one was
        // made; otherwise the column default.
        ...(descriptor.defaultPermissions
          ? { permissions: descriptor.defaultPermissions }
          : data.permissions && typeof data.permissions === 'object' && Object.keys(data.permissions).length
            ? { permissions: data.permissions }
            : {}),
      },
      { onConflict: 'installation_id' },
    )
    .select('id')
    .single();
  if (connError) throw new Error(`connection create failed: ${connError.message}`);

  await writeCommerceAudit(config, {
    workspaceId: data.workspace_id,
    userId: data.authorized_by,
    action: 'commerce.pairing.exchanged',
    entityType: 'commerce_connection',
    entityId: installation.id,
  });

  return {
    installationId: installation.id,
    connectionId: connectionRow.id,
    installationSecret,
    workspaceId: data.workspace_id,
    storeId,
    protocolVersion: 'webyar-commerce/1',
    providerType: descriptor.providerType,
    usesCatalogIndex: descriptor.usesCatalogIndex,
  };
}

/**
 * Runs the capability handshake and flips the connection to a usable state.
 * Called once right after exchange, and periodically by the sync worker's
 * heartbeat reconciliation. Never throws — a failed handshake just leaves
 * the connection in a non-connected health state for the next attempt.
 */
export async function runCapabilityHandshake(
  config: ServerConfig,
  connectionId: string,
  opts: { workspaceId?: string } = {},
): Promise<void> {
  const sb = getServiceClient(config);
  let query = sb
    .from('commerce_connections')
    .select('id, installation_id, approved_origin, store_id, provider_type, workspace_id, revoked_at, health, external_store_id, platform_version')
    .eq('id', connectionId);
  // A dashboard caller names the workspace it is authorized for; the handshake
  // must then only ever touch that workspace's own connection.
  if (opts.workspaceId) query = query.eq('workspace_id', opts.workspaceId);
  const { data: connection, error } = await query.maybeSingle();
  if (error || !connection || connection.revoked_at) return;
  if (connection.provider_type === 'opencart') return runOpenCartHandshake(config, connection as Parameters<typeof runOpenCartHandshake>[1]);

  const descriptor = getProviderDescriptor(String(connection.provider_type ?? 'woocommerce'));
  if (!descriptor) return;

  try {
    const { readInstallationSecret } = await import('./credentials.js');
    const secret = await readInstallationSecret(config, connection.installation_id);
    if (!secret) {
      await sb.from('commerce_connections').update({ health: 'authentication_error' }).eq('id', connectionId);
      return;
    }

    const handshake = await descriptor.handshake(
      {
        origin: connection.approved_origin,
        baseUrl: String(connection.store_id || connection.approved_origin),
        installationId: connection.installation_id,
        secret,
      },
      {
        workspaceId: connection.workspace_id,
        connectionId: connection.id,
        installationId: connection.installation_id,
        capabilities: [],
        correlationId: `handshake-${connectionId}`,
        deadlineAt: Date.now() + 8000,
      },
    );

    const health = handshake.protocolVersion !== 'webyar-commerce/1'
      ? 'protocol_mismatch'
      : handshake.schemaOk === false ? 'degraded' : 'connected';
    const now = new Date().toISOString();
    const common = {
      connector_version: handshake.connectorVersion,
      capabilities: handshake.capabilities,
      protocol_version: handshake.protocolVersion,
      health,
      last_seen_at: now,
      last_success_at: now,
      ...(handshake.schemaOk === false ? { last_error_code: 'schema_unsupported', last_error_at: now } : {}),
    };
    const providerFields = descriptor.usesCatalogIndex
      ? {
          woocommerce_version: handshake.woocommerceVersion ?? null,
          wordpress_version: handshake.wordpressVersion ?? null,
          hpos_enabled: handshake.hposEnabled ?? null,
          // NEVER raised here. `commerce_connections.catalog_ready` means "Web
          // Yar's own product index is usable", which only a completed sync can
          // establish (sync.ts). The handshake field of the same name is the
          // STORE answering a different question — "can I serve my catalogue?" —
          // and the connector plugin answers it with a constant true. Copying it
          // across raised the flag at pairing time, before a single product had
          // been indexed, so the `catalog_syncing` guard in gateway.ts and the
          // AI runner never fired and the assistant answered from an empty index
          // as though the catalogue were complete.
          //
          // The reverse still applies: a store that reports it CANNOT serve its
          // catalogue invalidates whatever we indexed from it, so that lowers
          // the flag immediately.
          ...(handshake.catalogReady === false ? { catalog_ready: false } : {}),
        }
      : { platform_version: handshake.platformVersion };
    await sb
      .from('commerce_connections')
      .update({ ...common, ...providerFields })
      .eq('id', connectionId);
  } catch (err) {
    const code = err instanceof CommerceError ? err.code : 'commerce_live_unavailable';
    await sb
      .from('commerce_connections')
      .update({
        // A billing connection that is refused outright has a credential
        // problem, not an outage; the store family keeps its original
        // `offline` so nothing about WooCommerce health reporting changes.
        health: descriptor.family === 'billing' && code === 'commerce_permission_denied' ? 'authentication_error' : 'offline',
        last_error_code: code,
        last_error_at: new Date().toISOString(),
      })
      .eq('id', connectionId);
  }
}

/**
 * OpenCart handshake — the extension's signed `health`. Run at pairing and by
 * the (rate-limited) "check connection" action only; OpenCart connections are
 * never polled in the background. Also the clone guard: a store that now
 * reports a different base URL or store id than the one paired is marked
 * `stale_origin` and must be reconnected.
 */
async function runOpenCartHandshake(
  config: ServerConfig,
  connection: { id: string; installation_id: string; approved_origin: string; workspace_id: string; store_id: string; external_store_id: string | null; platform_version: string | null },
): Promise<void> {
  const sb = getServiceClient(config);
  const now = new Date().toISOString();
  try {
    const { readInstallationSecret } = await import('./credentials.js');
    const secret = await readInstallationSecret(config, connection.installation_id);
    if (!secret) {
      await sb.from('commerce_connections').update({ health: 'authentication_error', last_health_check_at: now }).eq('id', connection.id);
      return;
    }
    const tryVersion = async (platformVersion: string | null) => new OpenCartConnector({
      origin: connection.approved_origin,
      storeUrl: connection.store_id,
      externalStoreId: String(connection.external_store_id ?? '0'),
      installationId: connection.installation_id,
      secret,
      platformVersion,
    }).negotiateCapabilities({
      workspaceId: connection.workspace_id,
      connectionId: connection.id,
      installationId: connection.installation_id,
      capabilities: [],
      correlationId: `handshake-${connection.id}`,
      deadlineAt: Date.now() + 8000,
    });
    let handshake;
    try {
      handshake = await tryVersion(connection.platform_version);
    } catch (err) {
      // Unknown or changed major version: the other route shape, once.
      if (!(err instanceof CommerceError) || err.code !== 'commerce_invalid_response') throw err;
      handshake = await tryVersion(/^3\./.test(String(connection.platform_version ?? '')) ? '4.1' : '3.0');
    }

    const sameStore = handshake.storeId === String(connection.external_store_id ?? '')
      && !!handshake.storeUrl && normalizeBase(handshake.storeUrl) === normalizeBase(connection.store_id);
    const health = handshake.protocolVersion !== 'webyar-commerce/1' ? 'protocol_mismatch' : sameStore ? 'connected' : 'stale_origin';
    await sb.from('commerce_connections').update({
      connector_version: handshake.connectorVersion,
      platform_version: handshake.platformVersion,
      capabilities: handshake.capabilities,
      protocol_version: handshake.protocolVersion,
      health,
      last_seen_at: now,
      last_success_at: now,
      last_health_check_at: now,
    }).eq('id', connection.id);

    // An older extension that can update itself is asked to (in the
    // background; the store checks the signed release on its own).
    if (health === 'connected' && handshake.capabilities.includes('connector.update') && isOlderConnector(handshake.connectorVersion) && claimUpdateNudge(connection.installation_id)) {
      void requestOpenCartUpdate(sb, connection, secret, handshake.platformVersion ?? connection.platform_version);
    }
  } catch (err) {
    await sb.from('commerce_connections').update({
      health: 'offline',
      last_error_code: err instanceof CommerceError ? err.code : 'commerce_live_unavailable',
      last_error_at: now,
      last_health_check_at: now,
    }).eq('id', connection.id);
  }
}

async function requestOpenCartUpdate(
  sb: ReturnType<typeof getServiceClient>,
  connection: { id: string; installation_id: string; approved_origin: string; workspace_id: string; store_id: string; external_store_id: string | null },
  secret: string,
  platformVersion: string | null,
): Promise<void> {
  try {
    const result = await new OpenCartConnector({
      origin: connection.approved_origin,
      storeUrl: connection.store_id,
      externalStoreId: String(connection.external_store_id ?? '0'),
      installationId: connection.installation_id,
      secret,
      platformVersion,
    }).requestSelfUpdate({
      workspaceId: connection.workspace_id,
      connectionId: connection.id,
      installationId: connection.installation_id,
      capabilities: [],
      correlationId: `update-${connection.id}`,
      deadlineAt: Date.now() + 45_000,
    });
    if (result.status === 'updated' && result.to) {
      await sb.from('commerce_connections').update({ connector_version: result.to }).eq('id', connection.id);
    }
  } catch {
    // The next handshake (or the store's own admin-visit check) tries again.
  }
}

function normalizeBase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`.toLowerCase();
  } catch {
    return url;
  }
}
