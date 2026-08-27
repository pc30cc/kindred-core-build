/**
 * CHANNELS GATEWAY — a separate deployable (Dockerfile.channels).
 *
 * Responsibilities, and nothing else:
 *   1. Terminate provider webhooks on a public HTTPS URL.
 *   2. Verify authenticity with the DERIVED per-integration secret.
 *   3. Forward the raw envelope to Core's authenticated internal ingest.
 *
 * Deliberate non-capabilities (enforced by construction, not by convention):
 *   - No database client, no SUPABASE_SERVICE_ROLE_KEY.
 *   - No PLUGIN_SECRETS_MASTER_KEY, no bot tokens, no decryption.
 *   - No business logic: it never creates contacts, conversations or messages.
 *
 * DELIVERY SEMANTICS: only explicitly classified PERMANENT conditions are
 * acknowledged with 200. Everything else — transport failures, Core 5xx,
 * misconfiguration, unclassified 4xx — returns non-2xx so Telegram retries.
 */

import express from 'express';
import { deriveChannelWebhookSecret, safeSecretEqual } from '../shared/channels/webhookSecret.js';
import { classifyCoreResponse } from './delivery.js';

const PORT = parseInt(process.env.CHANNELS_PORT || process.env.PORT || '3011', 10);
const SIGNING_KEY = (process.env.CHANNELS_WEBHOOK_SIGNING_KEY || '').trim();
const CORE_INTERNAL_SECRET = (process.env.CORE_INTERNAL_SECRET || '').trim();
const CORE_INTERNAL_BASE_URL = (process.env.CORE_INTERNAL_BASE_URL || '').trim().replace(/\/+$/, '');
const MAX_BODY_BYTES = 1_048_576; // Telegram updates are small; cap hard.
const FORWARD_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 3_000;

// Fail fast and loudly: a gateway without these cannot be secure.
for (const [name, value] of [
  ['CHANNELS_WEBHOOK_SIGNING_KEY', SIGNING_KEY],
  ['CORE_INTERNAL_SECRET', CORE_INTERNAL_SECRET],
  ['CORE_INTERNAL_BASE_URL', CORE_INTERNAL_BASE_URL],
] as const) {
  if (!value) {
    console.error(`[channels-gateway] missing required env var: ${name}`);
    process.exit(1);
  }
}

// Refuse to boot if someone hands the gateway credentials it must never hold.
for (const forbidden of ['SUPABASE_SERVICE_ROLE_KEY', 'PLUGIN_SECRETS_MASTER_KEY']) {
  if (process.env[forbidden]) {
    console.error(
      `[channels-gateway] ${forbidden} must NOT be provided to the gateway — it has no database or credential access by design`,
    );
    process.exit(1);
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: MAX_BODY_BYTES }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'channels-gateway', ts: new Date().toISOString() });
});

/**
 * Readiness: configuration present AND Core internal API reachable with our
 * shared secret. Never echoes the secret, the URL credentials or Core bodies.
 */
app.get('/ready', async (_req, res) => {
  const configured = !!SIGNING_KEY && !!CORE_INTERNAL_SECRET && !!CORE_INTERNAL_BASE_URL;
  if (!configured) {
    return res.status(503).json({ ready: false, reason: 'not_configured' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READY_TIMEOUT_MS);
  try {
    const response = await fetch(`${CORE_INTERNAL_BASE_URL}/internal/channels/ready`, {
      headers: { Authorization: `Bearer ${CORE_INTERNAL_SECRET}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return res.status(503).json({ ready: false, reason: `core_status_${response.status}` });
    }
    return res.json({ ready: true, service: 'channels-gateway', core: 'reachable' });
  } catch {
    return res.status(503).json({ ready: false, reason: 'core_unreachable' });
  } finally {
    clearTimeout(timer);
  }
});

/**
 * POST /hooks/telegram/:publicIntegrationId
 *
 * The expected secret is derived from the URL's public integration id — no
 * database round trip, so a flood of bogus ids costs nothing and leaks
 * nothing. Failures always return a bare 401 with no discriminating detail.
 */
app.post('/hooks/telegram/:publicIntegrationId', async (req, res) => {
  const publicIntegrationId = String(req.params.publicIntegrationId || '');
  if (!publicIntegrationId || publicIntegrationId.length > 128) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let expected: string;
  try {
    expected = deriveChannelWebhookSecret(SIGNING_KEY, 'telegram', publicIntegrationId);
  } catch {
    // Misconfiguration is NOT the provider's fault: retryable.
    return res.status(503).json({ error: 'gateway_not_configured' });
  }

  const presented = req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!safeSecretEqual(presented, expected)) {
    // Do not log the presented value.
    console.warn('[channels-gateway] rejected telegram webhook: secret mismatch');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    const response = await fetch(`${CORE_INTERNAL_BASE_URL}/internal/channels/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CORE_INTERNAL_SECRET}`,
      },
      body: JSON.stringify({
        provider: 'telegram',
        public_integration_id: publicIntegrationId,
        update: req.body ?? {},
        received_at: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    // Read ONLY a machine error code; raw Core bodies are never logged or
    // returned, so internal details cannot leak through the gateway.
    let errorCode: string | null = null;
    if (!response.ok) {
      try {
        const parsed = (await response.json()) as { error?: unknown };
        errorCode = typeof parsed?.error === 'string' ? parsed.error.slice(0, 64) : null;
      } catch {
        errorCode = null;
      }
    }

    const decision = classifyCoreResponse(response.status, errorCode);
    if (decision === 'ack') {
      return res.status(200).json({ ok: true });
    }

    console.error(
      `[channels-gateway] core ingest not acknowledged (status=${response.status} code=${errorCode ?? 'none'})`,
    );
    return res.status(502).json({ error: 'ingest_unavailable' });
  } catch (err) {
    const reason = (err as Error).name === 'AbortError' ? 'timeout' : 'transport_error';
    console.error(`[channels-gateway] core ingest ${reason}`);
    return res.status(502).json({ error: 'ingest_unavailable' });
  } finally {
    clearTimeout(timer);
  }
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[channels-gateway] listening on :${PORT} → core ${CORE_INTERNAL_BASE_URL}`);
  });
}

export default app;
