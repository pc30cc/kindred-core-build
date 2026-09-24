/**
 * WHMCS identity: from a signed assertion minted inside a logged-in WHMCS
 * client-area page to a binding Web Yar can use for one conversation.
 *
 * Two different things, kept apart on purpose:
 *
 *   1. INTRODUCTION — "this widget visitor is WHMCS user U, currently acting
 *      for client account C, under grant G". That is what the assertion
 *      proves, once, for at most ASSERTION_MAX_TTL_S. It is stored as ONE
 *      row per (connection, visitor) in `commerce_customer_links`.
 *
 *   2. AUTHORIZATION TO READ — decided by the WHMCS addon itself on every
 *      private read: grant G must still be live (not logged out, not
 *      replaced by an account switch, not idle-expired), U must still hold
 *      the needed permission on C, and the row must belong to C. A binding
 *      in Web Yar is never enough on its own, however recent.
 *
 * Cost: a page load that re-presents the SAME grant for the SAME visitor is
 * idempotent — it reads, verifies and returns with zero writes and no nonce
 * row (a replay of it can grant nothing new). Only a real change (first bind,
 * new grant after login/switch, different user) spends a nonce row plus one
 * link write, and only a first bind for a user touches the contact.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { CommerceError } from '../../../../shared/commerce/types.js';
import { WHMCS_ASSERTION_PREFIX, WHMCS_PROVIDER, type WhmcsGrantRef } from '../../../../shared/commerce/whmcs.js';
import { readInstallationSecret } from '../credentials.js';
import { ensureVisitorContact } from '../../widget/anonymousContact.js';

/** Longest an assertion may claim to live (exp - iat). */
export const ASSERTION_MAX_TTL_S = 600;
/** Oldest an assertion may be when it arrives (now - iat). */
export const ASSERTION_MAX_AGE_S = 600;
/** Tolerated clock skew between WHMCS and Web Yar. */
export const ASSERTION_CLOCK_SKEW_S = 60;
/**
 * Upper bound on how long a binding row is considered at all. Authority never
 * comes from this — every read is re-authorized by WHMCS — it only bounds how
 * long a stale row can make Web Yar bother asking.
 */
export const LINK_TTL_MS = 12 * 60 * 60 * 1000;
/** Refresh the row's expiry only when less than this is left (write-on-change, not per page). */
const LINK_REFRESH_BELOW_MS = 6 * 60 * 60 * 1000;

const HEX = /^[a-f0-9]+$/;
const DIGITS = /^\d{1,12}$/;

const payloadSchema = z.object({
  v: z.literal(1),
  typ: z.literal('whmcs.identity'),
  iss: z.string().uuid(),
  wid: z.string().uuid(),
  aud: z.literal('webyar-widget'),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  jti: z.string().min(16).max(64).regex(HEX),
  gid: z.string().length(32).regex(HEX),
  uid: z.string().regex(DIGITS),
  cid: z.string().regex(DIGITS),
  sub: z.string().min(16).max(64).regex(HEX),
  name: z.string().max(120).optional(),
  email: z.string().email().max(254).optional(),
});

export type WhmcsAssertionPayload = z.infer<typeof payloadSchema>;

export function isWhmcsAssertion(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.startsWith(`${WHMCS_ASSERTION_PREFIX}.`);
}

function fail(message: string): never {
  throw new CommerceError('identity_expired', message);
}

function hexEquals(a: string, b: string): boolean {
  if (!HEX.test(a) || !HEX.test(b) || a.length !== b.length || a.length % 2) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Structural + temporal checks that need no secret. Split out so the order
 * of checks is testable: nothing is looked up for an assertion that is
 * malformed, expired, over-long or aimed at another workspace.
 */
export function parseWhmcsAssertion(raw: string, workspaceId: string, nowSeconds = Math.floor(Date.now() / 1000)): {
  payload: WhmcsAssertionPayload;
  signedPart: string;
  signature: string;
} {
  if (typeof raw !== 'string' || raw.length > 4000) fail('malformed assertion');
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== WHMCS_ASSERTION_PREFIX) fail('malformed assertion');
  const [, payloadB64, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || signature.length !== 64) fail('malformed assertion');

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    fail('malformed assertion payload');
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) fail('assertion does not match schema');
  const payload = parsed.data;

  if (payload.wid !== workspaceId) fail('assertion issued for another workspace');
  if (payload.exp <= payload.iat) fail('assertion has no lifetime');
  if (payload.exp - payload.iat > ASSERTION_MAX_TTL_S) fail('assertion lifetime too long');
  if (payload.iat > nowSeconds + ASSERTION_CLOCK_SKEW_S) fail('assertion issued in the future');
  if (payload.exp < nowSeconds - ASSERTION_CLOCK_SKEW_S) fail('assertion expired');
  if (nowSeconds - payload.iat > ASSERTION_MAX_AGE_S + ASSERTION_CLOCK_SKEW_S) fail('assertion too old');

  return { payload, signedPart: `${WHMCS_ASSERTION_PREFIX}.${payloadB64}`, signature };
}

export function signWhmcsAssertion(secret: string, signedPart: string): string {
  return createHmac('sha256', secret).update(signedPart).digest('hex');
}

export interface WhmcsBindOutcome {
  linked: true;
  /** False when nothing had to be written (same grant, same visitor). */
  changed: boolean;
  connectionId: string;
}

interface LinkRow {
  id: string;
  grant_ref: string | null;
  external_user_id: string | null;
  external_customer_id: string;
  subject_since: string | null;
  revoked_at: string | null;
  expires_at: string;
}

export async function verifyAndBindWhmcsIdentity(
  config: ServerConfig,
  workspaceId: string,
  visitorId: string,
  rawAssertion: string,
): Promise<WhmcsBindOutcome> {
  const { payload, signedPart, signature } = parseWhmcsAssertion(rawAssertion, workspaceId);
  const sb = getServiceClient(config);

  // The installation named in the payload, in THIS workspace, still live, and
  // a WHMCS one. Never "the newest connection".
  const { data: connection, error: connError } = await sb
    .from('commerce_connections')
    .select('id, installation_id, provider_type, revoked_at')
    .eq('workspace_id', workspaceId)
    .eq('installation_id', payload.iss)
    .eq('provider_type', WHMCS_PROVIDER)
    .is('revoked_at', null)
    .maybeSingle();
  if (connError) throw new Error(`commerce connection read failed: ${connError.message}`);
  if (!connection) throw new CommerceError('commerce_not_connected', 'no live WHMCS connection for this installation');

  const secret = await readInstallationSecret(config, payload.iss);
  if (!secret) throw new CommerceError('commerce_not_connected', 'no installation credential');
  if (!hexEquals(signWhmcsAssertion(secret, signedPart), signature.toLowerCase())) fail('invalid assertion signature');

  const { data: existing, error: linkError } = await sb
    .from('commerce_customer_links')
    .select('id, grant_ref, external_user_id, external_customer_id, subject_since, revoked_at, expires_at')
    .eq('connection_id', connection.id)
    .eq('visitor_id', visitorId)
    .not('grant_ref', 'is', null)
    .maybeSingle();
  if (linkError) throw new Error(`customer link read failed: ${linkError.message}`);
  const link = existing as LinkRow | null;
  const now = Date.now();

  const sameGrant = !!link
    && link.grant_ref === payload.gid
    && link.external_user_id === payload.uid
    && link.external_customer_id === payload.cid
    && !link.revoked_at;
  if (sameGrant && new Date(link!.expires_at).getTime() - now > LINK_REFRESH_BELOW_MS) {
    // Idempotent fast path: nothing changes, nothing is written.
    return { linked: true, changed: false, connectionId: connection.id };
  }

  // A real change. From here the assertion is single-use: a replay of THIS
  // assertion (e.g. lifted from a page by someone else) cannot re-bind.
  const { error: nonceError } = await sb.from('commerce_nonce_cache').insert({
    installation_id: payload.iss,
    direction: 'inbound',
    nonce: `whmcs-identity:${payload.jti}`,
  });
  if (nonceError) fail('assertion replay detected');

  const sameSubject = !!link && link.external_user_id === payload.uid && link.external_customer_id === payload.cid;
  const nowIso = new Date(now).toISOString();
  const row = {
    grant_ref: payload.gid,
    external_user_id: payload.uid,
    external_customer_id: payload.cid,
    verified_at: nowIso,
    expires_at: new Date(now + LINK_TTL_MS).toISOString(),
    revoked_at: null,
    // The moment this (user, client account) pair took over the visitor.
    // Conversation turns older than this belong to a different subject and
    // are kept out of the prompt of account questions (whmcsRunner).
    subject_since: sameSubject && link?.subject_since ? link.subject_since : nowIso,
    updated_at: nowIso,
  };

  if (link) {
    const { error } = await sb.from('commerce_customer_links').update(row).eq('id', link.id).eq('connection_id', connection.id);
    if (error) throw new Error(`customer link write failed: ${error.message}`);
  } else {
    const { error } = await sb.from('commerce_customer_links').insert({
      ...row,
      workspace_id: workspaceId,
      connection_id: connection.id,
      visitor_id: visitorId,
    });
    if (error) throw new Error(`customer link write failed: ${error.message}`);
  }

  // One grant, one visitor. If this grant was bound to another widget visitor
  // (another browser profile that lost its cookie, or an assertion lifted from
  // a page), that binding stops here; the legitimate browser's next page load
  // re-binds with a fresh single-use assertion. Slow path only.
  await sb
    .from('commerce_customer_links')
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq('connection_id', connection.id)
    .eq('grant_ref', payload.gid)
    .neq('visitor_id', visitorId)
    .is('revoked_at', null);

  // The contact is keyed on the WHMCS USER (their own email), never on the
  // client account: two users of one shared company account stay two people.
  // Only on the first bind of this user to this visitor; a visitor that was
  // bound to a DIFFERENT user is not merged into that user's contact.
  const firstBindForUser = !link;
  if (firstBindForUser && (payload.email || payload.name)) {
    await ensureVisitorContact(sb, {
      workspaceId,
      visitorId,
      name: payload.name ?? null,
      email: payload.email ?? null,
      phone: null,
    }).catch((err) => {
      console.warn('[commerce.whmcs.identity] contact upsert failed:', err instanceof Error ? err.message : err);
      return null;
    });
  }

  return { linked: true, changed: true, connectionId: connection.id };
}

export type WhmcsBinding =
  | { state: 'bound'; linkId: string; grant: WhmcsGrantRef; subjectSince: string | null }
  | { state: 'revoked'; linkId: string; revokedAt: string | null }
  | { state: 'none' };

/**
 * The binding for a conversation's visitor on one connection. Two indexed
 * reads; used only on turns that actually ask about the account.
 */
export async function resolveWhmcsBinding(
  config: ServerConfig,
  input: { workspaceId: string; connectionId: string; conversationId: string | null },
): Promise<WhmcsBinding> {
  if (!input.conversationId) return { state: 'none' };
  const sb = getServiceClient(config);
  const { data: conv } = await sb
    .from('conversations')
    .select('visitor_session_id')
    .eq('id', input.conversationId)
    .eq('workspace_id', input.workspaceId)
    .maybeSingle();
  const visitorId = conv?.visitor_session_id;
  if (!visitorId) return { state: 'none' };

  const { data } = await sb
    .from('commerce_customer_links')
    .select('id, grant_ref, external_user_id, external_customer_id, subject_since, revoked_at, expires_at')
    .eq('connection_id', input.connectionId)
    .eq('visitor_id', visitorId)
    .not('grant_ref', 'is', null)
    .maybeSingle();
  const link = data as LinkRow | null;
  if (!link) return { state: 'none' };
  if (link.revoked_at) return { state: 'revoked', linkId: link.id, revokedAt: link.revoked_at };
  if (new Date(link.expires_at).getTime() <= Date.now() || !link.grant_ref || !link.external_user_id) {
    return { state: 'revoked', linkId: link.id, revokedAt: link.expires_at };
  }
  return {
    state: 'bound',
    linkId: link.id,
    grant: { grantId: link.grant_ref, userId: link.external_user_id, clientId: link.external_customer_id },
    subjectSince: link.subject_since,
  };
}

/**
 * WHMCS said the grant is gone (logout, account switch, idle expiry, user
 * removed). Recorded once — a state change, not a per-read write — so later
 * turns stop asking until the visitor presents a fresh assertion.
 */
export async function markWhmcsLinkRevoked(config: ServerConfig, linkId: string, connectionId: string): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    await getServiceClient(config)
      .from('commerce_customer_links')
      .update({ revoked_at: nowIso, updated_at: nowIso })
      .eq('id', linkId)
      .eq('connection_id', connectionId)
      .is('revoked_at', null);
  } catch (err) {
    console.warn('[commerce.whmcs.identity] revoke mark failed:', err instanceof Error ? err.message : err);
  }
}
