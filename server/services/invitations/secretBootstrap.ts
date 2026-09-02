/**
 * WORKSPACE INVITATIONS — self-hosted secret bootstrap.
 *
 * The invitation outbox refuses to send anything when
 * `INVITATION_LINK_SECRET` / `INVITATION_OTP_PEPPER` are absent: the delivery
 * job fails closed with DERIVATION_KEY_UNAVAILABLE and the operator only sees
 * "the e-mail was never sent". On a self-hosted deployment that env pair is
 * frequently unset, so this module provisions durable server-side key material
 * ONCE and keeps it in the operator's own database (`app_runtime_config`,
 * service-role only, never exposed through PostgREST to anon/authenticated).
 *
 * Explicit environment variables always win — this is a fallback, not an
 * override, so an operator-managed key ring or rotation stays authoritative.
 */

import crypto from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const CONFIG_KEY = 'invitation_secret_material';

function freshSecret(): string {
  // 32 raw bytes -> 64 hex chars, comfortably above the 32-byte minimum the
  // key-ring validator enforces.
  return crypto.randomBytes(32).toString('hex');
}

export interface InvitationSecretBootstrapResult {
  linkSecret: 'env' | 'database' | 'generated';
  otpPepper: 'env' | 'database' | 'generated';
}

export async function ensureInvitationSecrets(
  config: ServerConfig,
): Promise<InvitationSecretBootstrapResult> {
  const envLink = process.env.INVITATION_LINK_SECRET?.trim();
  const envOtp = process.env.INVITATION_OTP_PEPPER?.trim();
  if (envLink && envOtp) {
    return { linkSecret: 'env', otpPepper: 'env' };
  }

  const sb = getServiceClient(config);

  const read = async (): Promise<Record<string, string> | null> => {
    const { data } = await sb
      .from('app_runtime_config')
      .select('value')
      .eq('key', CONFIG_KEY)
      .maybeSingle();
    const value = (data as any)?.value;
    return value && typeof value === 'object' ? (value as Record<string, string>) : null;
  };

  let stored = await read();

  if (!stored?.link_secret || !stored?.otp_pepper) {
    const candidate = {
      link_secret: stored?.link_secret || freshSecret(),
      otp_pepper: stored?.otp_pepper || freshSecret(),
    };
    // Concurrent containers may race here; the unique key makes the first
    // writer authoritative and every other process re-reads the winner.
    await sb.from('app_runtime_config').upsert(
      { key: CONFIG_KEY, value: candidate },
      { onConflict: 'key', ignoreDuplicates: true },
    );
    stored = (await read()) || candidate;
  }

  const result: InvitationSecretBootstrapResult = {
    linkSecret: envLink ? 'env' : 'database',
    otpPepper: envOtp ? 'env' : 'database',
  };

  if (!envLink) process.env.INVITATION_LINK_SECRET = stored.link_secret;
  if (!envOtp) process.env.INVITATION_OTP_PEPPER = stored.otp_pepper;

  return result;
}
