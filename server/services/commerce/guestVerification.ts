/**
 * Guest order verification — backend primitives on top of the Generic
 * Verification Core (server/services/verification/), purpose
 * `commerce_order_lookup` (server/services/verification/types.ts). No
 * second OTP system was built (spec §29).
 *
 * Flow: contact-match against the LIVE order first (never trust order
 * number alone) → only on a match does a real OTP get issued → verifying
 * the OTP yields a short-lived proof token that authorizes exactly that
 * order for exactly this workspace.
 *
 * KNOWN LIMITATION (see the engineering report): these are tested,
 * working REST primitives; the AI conversation stage does not yet parse a
 * verification code back out of a chat reply to complete this flow
 * end-to-end inside the widget. An unverified guest asking about an order
 * today deterministically gets `identity_required` (safe), rather than
 * being walked through OTP collection inline in chat.
 */
import type { ServerConfig } from '../../config.js';
import { CommerceError, type CommerceConnectorContext } from '../../../shared/commerce/types.js';
import { getConnectionForWorkspace } from './gateway.js';
import { readInstallationSecret } from './credentials.js';
import { getProviderDescriptor, resolveConnector } from './connectors/registry.js';
import {
  requestVerificationChallenge,
  verifyVerificationChallenge,
} from '../verification/service.js';

export interface StartGuestVerificationInput {
  workspaceId: string;
  connectionId: string;
  externalOrderId: string;
  channel: 'email' | 'sms';
  destination: string; // email address or phone number, as the visitor typed it
  idempotencyKey: string;
  ipAddress?: string;
}

export async function startGuestOrderVerification(config: ServerConfig, input: StartGuestVerificationInput) {
  const connection = await getConnectionForWorkspace(config, input.workspaceId, input.connectionId);
  if (!connection || connection.revoked_at) throw new CommerceError('commerce_not_connected', 'not connected');

  const secret = await readInstallationSecret(config, connection.installation_id);
  if (!secret) throw new CommerceError('commerce_not_connected', 'no installation credential');

  // Guest order verification is a STORE-family flow (an order number plus the
  // contact on that order). A billing connection has no such lookup; it is
  // refused here rather than handed to the wrong connector.
  if (getProviderDescriptor(connection.provider_type)?.family !== 'store') {
    throw new CommerceError('commerce_permission_denied', 'guest order verification is not available for this connection');
  }
  const connector = resolveConnector(connection.provider_type, { origin: connection.approved_origin, installationId: connection.installation_id, secret });
  const ctx: CommerceConnectorContext = {
    workspaceId: input.workspaceId, connectionId: connection.id, installationId: connection.installation_id,
    capabilities: connection.capabilities as CommerceConnectorContext['capabilities'], correlationId: `guest-verify-${input.externalOrderId}`, deadlineAt: Date.now() + 8000,
  };

  // Contact-match FIRST — a boolean only, never unmasked order details
  // (spec §29). Only a match may cause a real OTP to be sent.
  const match = await connector.verifyOrderContactMatch(ctx, {
    externalOrderId: input.externalOrderId,
    email: input.channel === 'email' ? input.destination : undefined,
    phone: input.channel === 'sms' ? input.destination : undefined,
  });
  if (!match.matched) throw new CommerceError('order_access_denied', 'contact does not match this order');

  return requestVerificationChallenge(config, {
    purpose: 'commerce_order_lookup',
    channel: input.channel,
    destination: input.destination,
    subjectKind: 'commerce_order',
    subjectRef: `${connection.id}:${input.externalOrderId}`,
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
    requester: { ipAddress: input.ipAddress ?? null },
  });
}

export interface ConfirmGuestVerificationInput {
  workspaceId: string;
  connectionId: string;
  externalOrderId: string;
  channel: 'email' | 'sms';
  handle: string;
  code: string;
  requestId: string;
}

/** Returns a short-lived proof token scoped to exactly this (connection, order). */
export async function confirmGuestOrderVerification(config: ServerConfig, input: ConfirmGuestVerificationInput) {
  const result = await verifyVerificationChallenge(config, {
    purpose: 'commerce_order_lookup',
    channel: input.channel,
    handle: input.handle,
    code: input.code,
    requestId: input.requestId,
    subjectRef: `${input.connectionId}:${input.externalOrderId}`,
    workspaceId: input.workspaceId,
    requester: { ipAddress: null },
  });
  if (!result.ok) throw new CommerceError('identity_required', result.reason || 'invalid_code');
  return { proofToken: result.proofToken };
}
