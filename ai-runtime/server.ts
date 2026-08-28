/**
 * AI RUNTIME — a separate deployable (Dockerfile.ai).
 *
 * Deploy this on a network that CAN reach AI providers. Core (Iran /
 * restricted network) never does; it calls this service instead.
 *
 * Responsibilities, and nothing else:
 *   1. Accept authenticated internal completion / test / embedding requests.
 *   2. Talk to the AI provider (the only process in the system that may).
 *   3. Return normalized results and stable error codes.
 *
 * Deliberate non-capabilities (enforced by construction):
 *   - No database client, no SUPABASE_SERVICE_ROLE_KEY, no RLS bypass.
 *   - No persistence: provider configs arrive per request and are never stored.
 *   - No business logic: no credits, no usage logs, no conversation state.
 *   - It NEVER calls back into Core.
 */

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  AI_RUNTIME_ROUTES,
  AI_RUNTIME_CONTRACT_VERSION,
  AI_RUNTIME_SECRET_HEADER,
  AI_RUNTIME_CONTRACT_HEADER,
  type AiRuntimeErrorCode,
} from '../shared/ai/internalRoutes.js';
import { handleComplete, handleTest, handleEmbed, statusForCode, type RuntimeFailure } from '../runtime/ai/service.js';

const PORT = parseInt(process.env.AI_RUNTIME_PORT || process.env.PORT || '3021', 10);
const SECRET = (process.env.AI_RUNTIME_INTERNAL_SECRET || '').trim();
const MAX_BODY_BYTES = 2_097_152; // prompts can be large; still bounded

if (!SECRET) {
  console.error('[ai-runtime] missing required env var: AI_RUNTIME_INTERNAL_SECRET');
  process.exit(1);
}

// Refuse to boot when handed credentials this service must never hold. The
// runtime lives outside the trusted network; a leak there must not be a
// database compromise.
for (const forbidden of ['SUPABASE_SERVICE_ROLE_KEY', 'PLUGIN_SECRETS_MASTER_KEY', 'SESSION_SECRET']) {
  if (process.env[forbidden]) {
    console.error(
      `[ai-runtime] ${forbidden} must NOT be provided to the AI runtime — it has no database or credential access by design`,
    );
    process.exit(1);
  }
}
if (process.env.AI_RUNTIME_INTERNAL_SECRET === process.env.CORE_INTERNAL_SECRET && process.env.CORE_INTERNAL_SECRET) {
  console.error('[ai-runtime] AI_RUNTIME_INTERNAL_SECRET must not reuse CORE_INTERNAL_SECRET');
  process.exit(1);
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function presentedSecret(req: express.Request): string | null {
  const header = req.get(AI_RUNTIME_SECRET_HEADER);
  if (header && header.trim()) return header.trim();
  const auth = req.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim() || null;
  return null;
}

function sendError(res: express.Response, code: AiRuntimeErrorCode, message: string) {
  res.status(statusForCode(code)).json({ error: code, message, contractVersion: AI_RUNTIME_CONTRACT_VERSION });
}

function requireInternal(req: express.Request, res: express.Response): boolean {
  const presented = presentedSecret(req);
  if (!presented) {
    // No credential arrived at all — almost always a proxy stripping headers,
    // NOT a wrong value. Saying so saves hours of misdirected debugging.
    sendError(res, 'runtime_unauthorized', 'missing_credential');
    return false;
  }
  if (!constantTimeEquals(presented, SECRET)) {
    sendError(res, 'runtime_unauthorized', 'secret_mismatch');
    return false;
  }
  const advertised = req.get(AI_RUNTIME_CONTRACT_HEADER);
  if (advertised && advertised !== AI_RUNTIME_CONTRACT_VERSION) {
    sendError(
      res,
      'contract_mismatch',
      `Core advertises contract ${advertised}, runtime speaks ${AI_RUNTIME_CONTRACT_VERSION}`,
    );
    return false;
  }
  return true;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: MAX_BODY_BYTES }));

app.get(AI_RUNTIME_ROUTES.health, (_req, res) => {
  res.json({ ok: true, service: 'ai-runtime', contractVersion: AI_RUNTIME_CONTRACT_VERSION, ts: new Date().toISOString() });
});

app.get(AI_RUNTIME_ROUTES.ready, (req, res) => {
  if (!requireInternal(req, res)) return;
  res.json({
    ok: true,
    service: 'ai-runtime',
    contractVersion: AI_RUNTIME_CONTRACT_VERSION,
    routes: Object.values(AI_RUNTIME_ROUTES),
  });
});

app.post(AI_RUNTIME_ROUTES.complete, async (req, res) => {
  if (!requireInternal(req, res)) return;
  const result = await handleComplete(req.body);
  // (strictNullChecks is off for the server tsconfig, so narrow explicitly.)
  if (!result.ok) {
    const failure = result as RuntimeFailure;
    return sendError(res, failure.code, failure.message);
  }
  res.json({ ok: true, response: result.data.response });
});

app.post(AI_RUNTIME_ROUTES.test, async (req, res) => {
  if (!requireInternal(req, res)) return;
  const result = await handleTest(req.body);
  // (strictNullChecks is off for the server tsconfig, so narrow explicitly.)
  if (!result.ok) {
    const failure = result as RuntimeFailure;
    return sendError(res, failure.code, failure.message);
  }
  res.json({ ok: true, result: result.data.result });
});

app.post(AI_RUNTIME_ROUTES.embed, async (req, res) => {
  if (!requireInternal(req, res)) return;
  const result = await handleEmbed(req.body);
  // (strictNullChecks is off for the server tsconfig, so narrow explicitly.)
  if (!result.ok) {
    const failure = result as RuntimeFailure;
    return sendError(res, failure.code, failure.message);
  }
  res.json({ ok: true, vectors: result.data.vectors });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'invalid_request', message: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`[ai-runtime] listening on :${PORT} (contract ${AI_RUNTIME_CONTRACT_VERSION})`);
});
