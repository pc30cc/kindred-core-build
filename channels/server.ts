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
 * It scales horizontally and can be restarted at any time; durability lives
 * in Core's Postgres queue, not here.
 */

import express from 'express';
import { deriveChannelWebhookSecret, safeSecretEqual } from '../shared/channels/webhookSecret.js';

const PORT = parseInt(process.env.CHANNELS_PORT || process.env.PORT || '3011', 10);
const SIGNING_KEY = (process.env.CHANNELS_WEBHOOK_SIGNING_KEY || '').trim();
const CORE_INTERNAL_SECRET = (process.env.CORE_INTERNAL_SECRET || '').trim();
const CORE_INTERNAL_BASE_URL = (process.env.CORE_INTERNAL_BASE_URL || '').trim().replace(/\/+$/, '');
const MAX_BODY_BYTES = 1_048_576; // Telegram updates are small; cap hard.
const FORWARD_TIMEOUT_MS = 10_000;

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
 * POST /hooks/telegram/:publicIntegrationId
 *
 * The expected secret is derived from the URL's public integration id — no
 * database round trip, so a flood of bogus ids costs nothing and leaks
 * nothing. Failures always return a bare 401 with no discriminating detail.
 */
app.post('/hooks/telegram/:publicIntegrationId', async (req, res) => {
  const publicIntegrationId = String(req.params.publicIntegrationId || '');
  if (!publicIntegrationId || publicIntegrationId.length > 128) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let expected: string;
  try {
    expected = deriveChannelWebhookSecret(SIGNING_KEY, 'telegram', publicIntegrationId);
  } catch {
    return res.status(503).json({ error: 'Gateway not configured' });
  }

  const presented = req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!safeSecretEqual(presented, expected)) {
    // Do not log the presented value.
    console.warn('[channels-gateway] rejected telegram webhook: secret mismatch');
    return res.status(401).json({ error: 'Unauthorized' });
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

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      console.error(`[channels-gateway] core ingest failed [${response.status}]: ${detail}`);
      // 5xx tells Telegram to retry; 4xx from Core means the update is not
      // deliverable and retrying will not help.
      return res.status(response.status >= 500 ? 502 : 200).json({ ok: response.status < 500 });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[channels-gateway] core ingest transport error:', (err as Error).message);
    return res.status(502).json({ ok: false });
  } finally {
    clearTimeout(timer);
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`[channels-gateway] listening on :${PORT} → core ${CORE_INTERNAL_BASE_URL}`);
});
