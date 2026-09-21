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
import { ensureVisitorContact } from '../widget/anonymousContact.js';

const ASSERTION_MAX_AGE_MS = 2 * 60 * 1000; // the plugin issues a fresh one every load — matches spec's "short-lived (2 minute)"
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface CustomerContextAssertion {
  installation_id: string;
  external_customer_id: string;
  /**
   * Who the shopper is, as the store knows them. Signed with everything
   * else, so a browser can read these but cannot change them. Absent from
   * assertions issued by plugin builds older than this field.
   */
  email?: string;
  name?: string;
  phone?: string;
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
  connectionId: string | null,
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

  const connection = await resolveConnection(config, workspaceId, connectionId);
  if (!connection) throw new CommerceError('commerce_not_connected', 'no active connection for this workspace');
  if (payload.installation_id !== connection.installation_id) {
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
    connection_id: connection.id,
    external_customer_id: payload.external_customer_id,
    visitor_id: visitorId,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`customer link write failed: ${error.message}`);

  // Being signed in to the shop IS the verification — the store already
  // knows this person — so the conversation is filed under the real customer
  // instead of an anonymous visitor. Best effort on purpose: the link above
  // is what makes order questions answerable, and it must not be undone
  // because a contact row could not be written.
  await ensureVisitorContact(sb, {
    workspaceId,
    visitorId,
    name: payload.name ?? null,
    email: payload.email ?? null,
    phone: payload.phone ?? null,
  }).catch((err) => {
    console.warn('[commerce.identity] contact upsert failed:', err instanceof Error ? err.message : err);
    return null;
  });

  return { externalCustomerId: payload.external_customer_id };
}

/**
 * The connection this assertion belongs to.
 *
 * The caller MAY name one, and the plugin does when it knows its own
 * connection id — but it must not have to. A store paired before the plugin
 * began storing that id has no way to learn it, and there is no endpoint that
 * would tell it; requiring the id would leave the identity bridge silently
 * inert on every such store forever.
 *
 * Nothing is lost by resolving it here. The id never carried any authority of
 * its own: the assertion payload names its installation, only that
 * installation's secret can sign it, and that signature is verified against
 * the secret this server looks up for itself. The id was only ever a
 * cross-check — so it stays one when supplied, and is derived when it is not.
 *
 * Two things this does that accepting the caller's id did not:
 * the connection must belong to the workspace being bound into (an id from
 * another workspace used to be written straight into the link row), and it
 * must not be revoked. And when it is derived, it is derived exactly as
 * `getActiveConnectionForWorkspace` derives it for the AI stage — newest
 * un-revoked connection — so the link is guaranteed to be written where the
 * reader will later look for it.
 */
async function resolveConnection(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string | null,
): Promise<{ id: string; installation_id: string } | null> {
  const sb = getServiceClient(config);
  const base = sb
    .from('commerce_connections')
    .select('id, installation_id')
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null);
  const { data } = connectionId
    ? await base.eq('id', connectionId).maybeSingle()
    : await base.order('created_at', { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string; installation_id: string } | null) ?? null;
}
