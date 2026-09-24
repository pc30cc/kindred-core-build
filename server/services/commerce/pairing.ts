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
import { WooCommerceConnector } from './connectors/woocommerce.js';
import { OpenCartConnector } from './connectors/opencart.js';
import { writeCommerceAudit } from './audit.js';
import { providerProfile, COMMERCE_PROVIDERS } from './providers.js';

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

/** Step 1 — plugin registers its pairing intent server-to-server before opening the browser. */
export async function registerPairingRequest(
  config: ServerConfig,
  input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    storeOrigin: string;
    provider?: string;
    /** Direct connectors (OpenCart): which store of the installation, its base URL and version. */
    externalStoreId?: string | null;
    storeUrl?: string | null;
    platformVersion?: string | null;
  },
): Promise<{ expiresAt: string }> {
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

  const provider = input.provider ?? 'woocommerce';
  if (!COMMERCE_PROVIDERS.includes(provider)) throw new PairingError('invalid_provider', 'unknown commerce provider');
  let storeUrl: string | null = null;
  if (provider === 'opencart') {
    // One OpenCart install can serve several stores; each pairs on its own,
    // and every later call is scoped to exactly this store.
    if (!input.externalStoreId || !/^\d{1,9}$/.test(input.externalStoreId)) throw new PairingError('invalid_store', 'external_store_id required');
    try {
      const u = new URL(input.storeUrl ?? '');
      if (u.origin !== origin.origin || u.protocol !== 'https:' || u.search || u.hash) throw new Error('mismatch');
      storeUrl = u.toString().endsWith('/') ? u.toString() : `${u.toString()}/`;
    } catch {
      throw new PairingError('invalid_store', 'store_url must be an https URL on store_origin');
    }
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
    ...(provider === 'opencart'
      ? { external_store_id: input.externalStoreId, store_url: storeUrl, platform_version: (input.platformVersion ?? '').slice(0, 20) || null }
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
    .select('state, redirect_uri, requested_origin, provider_type, expires_at, authorized_at, consumed_at, store_url')
    .eq('state', state)
    .maybeSingle();
  if (error) throw new Error(`pairing lookup failed: ${error.message}`);
  if (!data) return null;
  return {
    state: data.state,
    redirectUri: data.redirect_uri,
    requestedOrigin: data.requested_origin,
    providerType: data.provider_type,
    storeUrl: (data as any).store_url ?? null,
    expiresAt: data.expires_at,
    expired: new Date(data.expires_at).getTime() < Date.now() || !!data.consumed_at,
    alreadyAuthorized: !!data.authorized_at,
  };
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
  providerType?: string;
}

/** Step 3 — server-to-server code exchange using the PKCE verifier. */
export async function exchangePairingCode(
  config: ServerConfig,
  input: { state: string; code: string; codeVerifier: string },
): Promise<ExchangeResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_pairing_requests')
    .select('id, state, code_challenge, provider_type, requested_origin, workspace_id, authorized_by, authorization_code_hash, expires_at, authorized_at, consumed_at, external_store_id, store_url, platform_version')
    .eq('state', input.state)
    .maybeSingle();
  if (error) throw new Error(`pairing lookup failed: ${error.message}`);
  if (!data) throw new PairingError('not_found', 'pairing request not found');
  if (data.consumed_at) throw new PairingError('already_used', 'authorization code already used');
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

  const direct = providerProfile(data.provider_type).searchStrategy === 'direct';
  // WooCommerce: one site per workspace installation (instance 'default').
  // OpenCart: one installation PER STORE — a multi-store shop connecting two
  // stores to one workspace must get two installations, two secrets and two
  // connections, or the second pairing would silently take over the first.
  const instanceKey = data.provider_type === 'opencart'
    ? `store:${createHash('sha256').update(String(data.store_url ?? data.requested_origin)).digest('hex').slice(0, 24)}`
    : 'default';
  const installation = await installPlugin(config, data.workspace_id, providerProfile(data.provider_type).pluginId, data.authorized_by, instanceKey);
  const installationSecret = base64url(randomBytes(32));
  await storeInstallationSecret(config, installation.id, installationSecret, 'live');

  // One store = one active connection. For WooCommerce store_id is the
  // approved origin itself; for OpenCart it is the store's base URL (unique
  // per store even when stores of one install share a host), with the
  // numeric OpenCart store id alongside.
  const { data: connectionRow, error: connError } = await sb
    .from('commerce_connections')
    .upsert(
      {
        workspace_id: data.workspace_id,
        installation_id: installation.id,
        provider_type: data.provider_type,
        store_id: direct && data.store_url ? data.store_url : data.requested_origin,
        approved_origin: data.requested_origin,
        protocol_version: 'webyar-commerce/1',
        capabilities: [],
        health: 'reconnecting',
        catalog_ready: false,
        revoked_at: null,
        ...(direct ? { external_store_id: data.external_store_id, platform_version: data.platform_version ?? null } : {}),
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
    storeId: direct && data.store_url ? data.store_url : data.requested_origin,
    protocolVersion: 'webyar-commerce/1',
    providerType: data.provider_type,
  };
}

/**
 * Runs the capability handshake and flips the connection to a usable state.
 * Called once right after exchange, and periodically by the sync worker's
 * heartbeat reconciliation. Never throws — a failed handshake just leaves
 * the connection in a non-connected health state for the next attempt.
 */
export async function runCapabilityHandshake(config: ServerConfig, connectionId: string): Promise<void> {
  const sb = getServiceClient(config);
  const { data: connection, error } = await sb
    .from('commerce_connections')
    .select('id, installation_id, approved_origin, workspace_id, revoked_at, provider_type, store_id, external_store_id, platform_version')
    .eq('id', connectionId)
    .maybeSingle();
  if (error || !connection || connection.revoked_at) return;
  if (connection.provider_type === 'opencart') return runOpenCartHandshake(config, connection as any);

  try {
    const { readInstallationSecret } = await import('./credentials.js');
    const secret = await readInstallationSecret(config, connection.installation_id);
    if (!secret) {
      await sb.from('commerce_connections').update({ health: 'authentication_error' }).eq('id', connectionId);
      return;
    }

    const connector = new WooCommerceConnector({
      origin: connection.approved_origin,
      installationId: connection.installation_id,
      secret,
    });
    const handshake = await connector.negotiateCapabilities({
      workspaceId: connection.workspace_id,
      connectionId: connection.id,
      installationId: connection.installation_id,
      capabilities: [],
      correlationId: `handshake-${connectionId}`,
      deadlineAt: Date.now() + 8000,
    });

    const health = handshake.protocolVersion !== 'webyar-commerce/1' ? 'protocol_mismatch' : 'connected';
    await sb
      .from('commerce_connections')
      .update({
        connector_version: handshake.connectorVersion,
        woocommerce_version: handshake.woocommerceVersion,
        wordpress_version: handshake.wordpressVersion,
        hpos_enabled: handshake.hposEnabled,
        capabilities: handshake.capabilities,
        protocol_version: handshake.protocolVersion,
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
        health,
        last_seen_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
      })
      .eq('id', connectionId);
  } catch (err) {
    await sb
      .from('commerce_connections')
      .update({
        health: 'offline',
        last_error_code: err instanceof CommerceError ? err.code : 'commerce_live_unavailable',
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
  } catch (err) {
    await sb.from('commerce_connections').update({
      health: 'offline',
      last_error_code: err instanceof CommerceError ? err.code : 'commerce_live_unavailable',
      last_error_at: now,
      last_health_check_at: now,
    }).eq('id', connection.id);
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
