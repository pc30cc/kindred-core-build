/**
 * Meta (WhatsApp Cloud / Instagram Messaging) webhook authenticity.
 *
 * Meta signs every webhook POST with the APP SECRET of the Meta app the
 * webhook is subscribed on: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of
 * the raw request body>`. The Channels Gateway is deliberately credential-free,
 * so it cannot check this itself; it forwards the exact raw body bytes and the
 * header to Core's `/ingest`, and Core — which can decrypt the integration's
 * credential envelope — verifies it here.
 *
 * Secret sources, most specific first:
 *   1. `app_secret` inside the integration's encrypted credential envelope
 *      (optional field accepted by the WhatsApp / Instagram connect forms);
 *   2. `META_APP_SECRET` env (comma-separated list), for deployments where
 *      every Meta integration rides the platform's own Meta app(s).
 *
 * When NO secret is configured the webhook is still accepted (authenticity
 * then rests on the unguessable public integration id in the callback path,
 * as before) and a warning is logged once per integration — so existing
 * integrations keep working until an operator configures a secret. Once a
 * secret IS configured, a missing or wrong signature is rejected.
 */
import crypto from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { pluginCryptoReady, readPluginSecret } from '../plugins/secrets.js';
import { botProvider } from '../../../shared/channels/botProviders.js';

/** Dialects whose webhooks carry `X-Hub-Signature-256`. */
export function isMetaSignedDialect(dialect: string): boolean {
  return dialect === 'whatsapp-cloud' || dialect === 'instagram-graph';
}

/**
 * Constant-time verification of `sha256=<hex>` against any of `secrets`.
 * False for a missing/malformed header or an empty secret list.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | null | undefined, secrets: string[]): boolean {
  if (!header || !secrets.length) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1].toLowerCase(), 'hex');
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    // Evaluate every candidate (no early exit) to keep timing uniform.
    if (expected.length === presented.length && crypto.timingSafeEqual(expected, presented)) ok = true;
  }
  return ok;
}

/** Extracts the optional `app_secret` from a decrypted credential envelope. */
export function appSecretFromCredential(credential: string | null | undefined): string | null {
  if (!credential) return null;
  try {
    const parsed = JSON.parse(credential);
    const secret = typeof parsed?.app_secret === 'string' ? parsed.app_secret.trim() : '';
    return secret || null;
  } catch {
    return null;
  }
}

export function platformMetaAppSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.META_APP_SECRET || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The app secret(s) a given Meta integration's webhooks must be signed with.
 * An empty list means "not configured" (legacy accept-with-warning mode).
 */
export async function resolveMetaAppSecrets(
  config: ServerConfig,
  integration: { installation_id: string; provider: string },
): Promise<string[]> {
  if (pluginCryptoReady(config)) {
    const credential = await readPluginSecret(
      config,
      integration.installation_id,
      botProvider(integration.provider).secretKeys.live,
    );
    const own = appSecretFromCredential(credential);
    if (own) return [own];
  }
  return platformMetaAppSecrets();
}

const warnedUnsigned = new Set<string>();

/** Logs (once per integration per process) that a Meta webhook was accepted unsigned. */
export function warnUnverifiedMetaWebhook(integrationId: string, provider: string): void {
  if (warnedUnsigned.has(integrationId)) return;
  warnedUnsigned.add(integrationId);
  console.warn(
    `[internal-channels] ${provider} webhook for integration ${integrationId} accepted WITHOUT X-Hub-Signature-256 ` +
      'verification: no Meta app secret is configured. Add `app_secret` to the integration credential ' +
      '(reconnect with the App Secret) or set META_APP_SECRET to enforce signed webhooks.',
  );
}
