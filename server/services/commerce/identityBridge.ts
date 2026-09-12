/**
 * Customer identity bridge (docs/commerce/SECURITY.md §Customer identity
 * bridge, spec §27). The plugin signs a short-lived assertion proving a
 * WooCommerce-logged-in visitor's identity; the browser is NEVER trusted to
 * submit a raw customer_id. Verified assertions bind to the existing
 * widget visitor session (server/services/widget/visitorIdentity.ts) via
 * commerce_customer_links — no new visitor-identity mechanism.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { CommerceError } from '../../../shared/commerce/types.js';
import { readInstallationSecret } from './credentials.js';

const ASSERTION_MAX_AGE_MS = 2 * 60 * 1000; // the plugin issues a fresh one every load — matches spec's "short-lived (2 minute)"
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface CustomerContextAssertion {
  installation_id: string;
  external_customer_id: string;
  issued_at: number; // epoch seconds
  expires_at: number; // epoch seconds
  nonce: string;
  audience: 'webyar-widget';
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a plugin-issued `<payload_b64url>.<hmac_hex>` assertion and, on
 * success, binds the visitor to the store's customer for LINK_TTL_MS.
 * Never trusts anything in the payload until the signature (keyed by the
 * installation's OWN secret, looked up server-side, never client-supplied)
 * checks out.
 */
export async function verifyAndBindCustomerContext(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  visitorId: string,
  rawAssertion: string,
): Promise<{ externalCustomerId: string }> {
  const parts = rawAssertion.split('.');
  if (parts.length !== 2) throw new CommerceError('identity_expired', 'malformed assertion');
  const [payloadB64, signatureHex] = parts;

  let payload: CustomerContextAssertion;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw new CommerceError('identity_expired', 'malformed assertion payload');
  }

  if (payload.audience !== 'webyar-widget') throw new CommerceError('identity_expired', 'wrong audience');
  if (payload.installation_id !== (await connectionInstallationId(config, connectionId))) {
    throw new CommerceError('identity_expired', 'assertion issued for a different installation');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.expires_at < nowSeconds) throw new CommerceError('identity_expired', 'assertion expired');
  if (nowSeconds - payload.issued_at > ASSERTION_MAX_AGE_MS / 1000 + 30) {
    throw new CommerceError('identity_expired', 'assertion too old');
  }

  const secret = await readInstallationSecret(config, payload.installation_id);
  if (!secret) throw new CommerceError('commerce_not_connected', 'no installation credential');

  const expectedSignature = createHmac('sha256', secret).update(payloadB64).digest('hex');
  if (!constantTimeEquals(expectedSignature, signatureHex)) {
    throw new CommerceError('identity_expired', 'invalid assertion signature');
  }

  // Replay guard — same nonce cache as request signing, direction 'inbound'.
  const sb = getServiceClient(config);
  const { error: nonceError } = await sb.from('commerce_nonce_cache').insert({
    installation_id: payload.installation_id,
    direction: 'inbound',
    nonce: `customer-context:${payload.nonce}`,
  });
  if (nonceError) throw new CommerceError('identity_expired', 'assertion replay detected');

  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  const { error } = await sb.from('commerce_customer_links').insert({
    workspace_id: workspaceId,
    connection_id: connectionId,
    external_customer_id: payload.external_customer_id,
    visitor_id: visitorId,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`customer link write failed: ${error.message}`);

  return { externalCustomerId: payload.external_customer_id };
}

async function connectionInstallationId(config: ServerConfig, connectionId: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('commerce_connections').select('installation_id').eq('id', connectionId).maybeSingle();
  return data?.installation_id ?? null;
}
