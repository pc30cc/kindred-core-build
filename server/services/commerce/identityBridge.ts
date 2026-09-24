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
import { isDirectProvider } from './providers.js';

const ASSERTION_MAX_AGE_MS = 2 * 60 * 1000; // the plugin issues a fresh one every load — matches spec's "short-lived (2 minute)"
const LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** A re-bind of the SAME customer and session within this window writes nothing. */
const LINK_REFRESH_AFTER_MS = LINK_TTL_MS / 2;
const MAX_SESSION_REF_LENGTH = 1_000;

export interface BindResult {
  externalCustomerId: string;
  /** 'unchanged' = no database write happened beyond the replay nonce. */
  outcome: 'created' | 'unchanged' | 'refreshed' | 'switched';
}

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
  /**
   * OpenCart (direct connectors): the store inside the installation, the
   * customer group the store applies, and an OPAQUE session reference the
   * store encrypted with a key Web Yar does not have. Web Yar stores and
   * returns it; the store re-validates the live session behind it on every
   * private read.
   */
  provider?: string;
  store_id?: string;
  customer_group_id?: string;
  session_ref?: string;
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
  opts: { requestOrigin?: string | null } = {},
): Promise<BindResult> {
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

  const connection = await resolveConnection(config, workspaceId, connectionId, typeof payload.installation_id === 'string' ? payload.installation_id : null);
  if (!connection) throw new CommerceError('commerce_not_connected', 'no active connection for this workspace');
  if (payload.installation_id !== connection.installation_id) {
    throw new CommerceError('identity_expired', 'assertion issued for a different installation');
  }
  const direct = isDirectProvider(connection.provider_type);
  if (direct) {
    // Bound to the exact store of a multi-store install…
    if (String(payload.store_id ?? '') !== String(connection.external_store_id ?? '')) {
      throw new CommerceError('identity_expired', 'assertion issued for a different store');
    }
    if (typeof payload.session_ref !== 'string' || !payload.session_ref || payload.session_ref.length > MAX_SESSION_REF_LENGTH) {
      throw new CommerceError('identity_expired', 'assertion carries no session reference');
    }
    // …and to the store's own pages. The browser sets Origin; a cloned or
    // copied shop on another host cannot introduce customers through it.
    if (opts.requestOrigin && !sameOrigin(opts.requestOrigin, connection.approved_origin)) {
      throw new CommerceError('identity_expired', 'assertion posted from another origin');
    }
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

  const now = Date.now();
  const expiresAt = new Date(now + LINK_TTL_MS).toISOString();
  const externalCustomerId = String(payload.external_customer_id);
  const sessionRef = direct ? String(payload.session_ref) : null;
  const customerGroupId = direct && payload.customer_group_id ? String(payload.customer_group_id).slice(0, 20) : null;

  // ONE link per (connection, visitor), updated in place. It used to be one
  // INSERT per page view of a signed-in shopper; now a repeat of the same
  // identity writes nothing until the link is half-way to expiry.
  const { data: existing } = await sb
    .from('commerce_customer_links')
    .select('id, external_customer_id, session_ref, expires_at, private_cutoff_at')
    .eq('connection_id', connection.id)
    .eq('visitor_id', visitorId)
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let outcome: BindResult['outcome'];
  if (!existing) {
    const { error } = await sb.from('commerce_customer_links').insert({
      workspace_id: workspaceId,
      connection_id: connection.id,
      external_customer_id: externalCustomerId,
      visitor_id: visitorId,
      expires_at: expiresAt,
      session_ref: sessionRef,
      customer_group_id: customerGroupId,
    });
    if (error) throw new Error(`customer link write failed: ${error.message}`);
    outcome = 'created';
  } else {
    const row = existing as { id: string; external_customer_id: string; session_ref: string | null; expires_at: string; private_cutoff_at: string | null };
    const sameCustomer = row.external_customer_id === externalCustomerId;
    const live = new Date(row.expires_at).getTime() > now;
    if (sameCustomer && live && (row.session_ref ?? null) === sessionRef && new Date(row.expires_at).getTime() - now > LINK_REFRESH_AFTER_MS) {
      return { externalCustomerId, outcome: 'unchanged' };
    }
    const { error } = await sb.from('commerce_customer_links').update({
      external_customer_id: externalCustomerId,
      session_ref: sessionRef,
      customer_group_id: customerGroupId,
      verified_at: new Date(now).toISOString(),
      expires_at: expiresAt,
      updated_at: new Date(now).toISOString(),
      // A different customer in the same browser: nothing the previous one
      // was told may reach this customer's prompt.
      private_cutoff_at: sameCustomer ? row.private_cutoff_at : new Date(now).toISOString(),
    }).eq('id', row.id);
    if (error) throw new Error(`customer link write failed: ${error.message}`);
    outcome = sameCustomer ? 'refreshed' : 'switched';
    if (sameCustomer) return { externalCustomerId, outcome };
  }

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

  return { externalCustomerId, outcome };
}

/**
 * The storefront says nobody is signed in any more (logout seen by the
 * loader). Ends this visitor's links in the workspace and records the cutoff
 * so earlier private answers are not fed back into later prompts. The store
 * would refuse the dead session anyway; this also stops the conversation
 * from carrying the previous customer's context. One UPDATE, only on a
 * transition.
 */
export async function unbindCustomerContext(config: ServerConfig, workspaceId: string, visitorId: string): Promise<{ ended: number }> {
  const sb = getServiceClient(config);
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from('commerce_customer_links')
    .update({ expires_at: nowIso, private_cutoff_at: nowIso, updated_at: nowIso })
    .eq('workspace_id', workspaceId)
    .eq('visitor_id', visitorId)
    .gt('expires_at', nowIso)
    .select('id');
  if (error) throw new Error(`customer link end failed: ${error.message}`);
  return { ended: Array.isArray(data) ? data.length : 0 };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
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
  installationId: string | null = null,
): Promise<{ id: string; installation_id: string; provider_type?: string; external_store_id?: string | null; approved_origin?: string } | null> {
  const sb = getServiceClient(config);
  const base = () => sb
    .from('commerce_connections')
    .select('id, installation_id, provider_type, external_store_id, approved_origin')
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null);
  if (connectionId) {
    const { data } = await base().eq('id', connectionId).maybeSingle();
    return (data as { id: string; installation_id: string; provider_type?: string; external_store_id?: string | null; approved_origin?: string } | null) ?? null;
  }
  // With several stores in one workspace the installation named in the
  // payload picks the row (its secret is still what verifies the signature);
  // otherwise the newest row, exactly as before.
  if (installationId) {
    const { data: byInstallation } = await base().eq('installation_id', installationId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (byInstallation) return byInstallation as { id: string; installation_id: string; provider_type?: string; external_store_id?: string | null; approved_origin?: string };
  }
  const { data } = await base().order('created_at', { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string; installation_id: string; provider_type?: string; external_store_id?: string | null; approved_origin?: string } | null) ?? null;
}
