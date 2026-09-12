/**
 * GMAIL PUB/SUB PUSH — the entry point for "new mail arrived" notifications.
 *
 * Deliberately NOT part of the existing Channels Gateway
 * (`channels/server.ts`): that gateway is DB-less/secret-less by design and
 * derives its expected webhook secret from the URL path alone, which works
 * for Telegram/Meta but not here — a Pub/Sub push (a) carries the mailbox
 * identity inside the message body, not the URL, requiring a DB lookup to
 * resolve which workspace it belongs to, and (b) authenticates via a
 * Google-signed OIDC bearer JWT, not a static derivable secret. Core already
 * has DB + crypto access (the same reasoning that makes GSC's OAuth callback
 * Core-side too), so this is a small dedicated Core route instead.
 *
 * Mounted OUTSIDE both `/api` (CORS-scoped for the browser) and
 * `/internal/channels` (CORE_INTERNAL_SECRET-scoped for the Worker) — Google
 * Pub/Sub can present neither, only its own OIDC identity token.
 *
 * FIELD-MAPPING NOTE: written against Google Cloud Pub/Sub's documented push
 * subscription envelope and OIDC token contract. Could not be verified
 * against a live push in this sandboxed environment (no network access to
 * Google). Re-verify on first live test.
 */
import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import { enqueueChannelJob } from '../services/channels/jobs.js';

export const gmailPushRouter = Router();

const GOOGLE_PUBSUB_SERVICE_ACCOUNT = 'gmail-api-push@system.gserviceaccount.com';

let verifierClient: OAuth2Client | null = null;
function getVerifierClient(): OAuth2Client {
  if (!verifierClient) verifierClient = new OAuth2Client();
  return verifierClient;
}

interface PushAuthVerdict {
  ok: boolean;
  reason: string | null;
}

async function verifyPushAuth(authorizationHeader: string | undefined): Promise<PushAuthVerdict> {
  const audience = process.env.GMAIL_PUBSUB_PUSH_AUDIENCE?.trim();
  if (!audience) return { ok: false, reason: 'GMAIL_PUBSUB_PUSH_AUDIENCE is not configured' };

  const bearer = authorizationHeader?.startsWith('Bearer ') ? authorizationHeader.slice(7) : null;
  if (!bearer) return { ok: false, reason: 'missing bearer token' };

  try {
    const ticket = await getVerifierClient().verifyIdToken({ idToken: bearer, audience });
    const claims = ticket.getPayload();
    if (!claims) return { ok: false, reason: 'empty token payload' };
    if (claims.email !== GOOGLE_PUBSUB_SERVICE_ACCOUNT || claims.email_verified !== true) {
      return { ok: false, reason: 'unexpected token subject' };
    }
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message || 'token verification failed' };
  }
}

interface GmailPushNotification {
  emailAddress: string;
  historyId: number | string;
}

gmailPushRouter.post('/gmail/push', async (req: any, res) => {
  const verdict = await verifyPushAuth(req.headers?.authorization);
  if (!verdict.ok) {
    console.error(`[gmail-push] rejected: ${verdict.reason}`);
    return res.status(401).json({ error: 'invalid_push_token' });
  }

  try {
    const rawData = req.body?.message?.data;
    if (typeof rawData !== 'string' || !rawData) {
      // Malformed envelope — acknowledge anyway so Pub/Sub does not retry a
      // payload that will never parse.
      return res.status(204).end();
    }
    const decoded = JSON.parse(Buffer.from(rawData, 'base64').toString('utf8')) as Partial<GmailPushNotification>;
    const emailAddress = typeof decoded.emailAddress === 'string' ? decoded.emailAddress : null;
    if (!emailAddress) return res.status(204).end();

    const config = serverConfigOf(req);
    const sb = getServiceClient(config);
    const { data: integration } = await sb
      .from('channel_integrations')
      .select('id, workspace_id, metadata, status')
      .eq('provider', 'gmail')
      .eq('external_account_id', emailAddress)
      .eq('status', 'connected')
      .maybeSingle();

    if (!integration) {
      // Not an error: a disconnected/reconnected-elsewhere mailbox can keep
      // receiving pushes for a short window until its old watch expires.
      return res.status(204).end();
    }

    const metadata = (integration.metadata ?? {}) as Record<string, unknown>;
    const startHistoryId = typeof metadata.gmail_history_id === 'string' ? metadata.gmail_history_id : null;

    await enqueueChannelJob(sb, {
      provider: 'gmail',
      jobType: 'gmail_sync_inbox',
      workspaceId: integration.workspace_id,
      integrationId: integration.id,
      payload: { start_history_id: startHistoryId },
    });

    res.status(204).end();
  } catch (err) {
    console.error('[gmail-push] handling failed:', err);
    // Still acknowledge — a durable enqueue failure here would otherwise
    // make Pub/Sub retry the same push forever with no way to recover; the
    // watch-renewal ticker and any later push both re-trigger a sync anyway.
    res.status(204).end();
  }
});
