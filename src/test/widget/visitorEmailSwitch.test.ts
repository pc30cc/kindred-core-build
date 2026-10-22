// @vitest-environment node
/**
 * No email to visitors while the platform's switch is off
 * (shared/visitorEmail.ts, VISITOR_EMAIL_FEATURES_ENABLED = false; owner,
 * 2026-10-21), with the real switch:
 *
 *   - the transcript by email: every template's option reads off, GET …/csat
 *     offers no transcript, POST …/transcript answers 403
 *     `transcript_disabled` before any read or mail;
 *   - the away thread's email step: POST /identity/offline-email answers 403
 *     `visitor_email_disabled` and merges nothing; /config carries no
 *     `visitorEmail`, so runtime-late.js draws no step (awayThread.test.ts).
 *
 * The features themselves, switched on, stay covered where they were
 * (afterChatRoutes, afterChatServer, identityAwayRoutes, awayThread).
 */
import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

type Next = () => void;
const merges = vi.hoisted(() => [] as unknown[]);

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => { throw new Error('no database read expected'); },
}));
vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: Next) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: Next) => next(),
}));
vi.mock('../../../server/services/widget/identityMerge.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/identityMerge.js')>()),
  mergeVisitorIdentity: async (...args: unknown[]) => { merges.push(args); return { contactId: 'k', isNewContact: true, conversationsMerged: 0 }; },
}));
vi.mock('../../../server/services/email/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/email/index.js')>()),
  sendEmail: async () => { throw new Error('no mail expected'); },
  isEmailProviderConfigured: async () => true,
}));

const { VISITOR_EMAIL_FEATURES_ENABLED } = await import('../../../shared/visitorEmail.js');
const { resolveChatTemplateCatalog, resolveChatTemplateOptions } = await import('../../../shared/chatTemplateCatalog.js');
const { emailVisitorTranscript, transcriptAvailability } = await import('../../../server/services/visitorTranscript.js');
const { widgetIdentityRouter } = await import('../../../server/routes/widgetIdentity.js');

const CONFIG = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const OWNED = { id: CONV, contact_id: 'k1' } as never;

describe('visitor email is switched off', () => {
  it('is the shipped value', () => {
    expect(VISITOR_EMAIL_FEATURES_ENABLED).toBe(false);
  });

  it('the transcript option reads off for Templates 1 and 2, whatever the Super Admin and the workspace stored', () => {
    const catalog = resolveChatTemplateCatalog('iran', {
      default: 't2',
      items: { t1: { enabled: true, options: { transcriptEmail: true } }, t2: { enabled: true, options: { transcriptEmail: true } } },
    });
    expect(resolveChatTemplateOptions(catalog, 't1', { transcriptEmail: true }).transcriptEmail).toBe(false);
    expect(resolveChatTemplateOptions(catalog, 't2', { transcriptEmail: true }).transcriptEmail).toBe(false);
  });

  it('GET …/csat offers no transcript and POST …/transcript is refused (403 transcript_disabled), before any read or mail', async () => {
    await expect(transcriptAvailability(CONFIG, { workspaceId: WS, conversation: OWNED, humanAnswered: true }))
      .resolves.toEqual({ available: false, to: null, reason: 'disabled' });
    await expect(emailVisitorTranscript(CONFIG, { workspaceId: WS, conversation: OWNED, locale: 'fa' }))
      .resolves.toEqual({ ok: false, status: 403, error: 'transcript_disabled' });
  });

  it('POST /identity/offline-email (the away email step) is refused: 403 visitor_email_disabled, nothing merged', async () => {
    const app = express();
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: CONFIG }); next(); });
    app.use(express.json());
    app.use('/api/widget/identity', widgetIdentityRouter);
    const server = http.createServer(app).listen(0);
    try {
      const payload = JSON.stringify({ workspace_id: WS, conversation_id: CONV, email: 'ali@example.com' });
      const answer = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/widget/identity/offline-email', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      expect(answer).toEqual({ status: 403, body: { error: 'visitor_email_disabled' } });
      expect(merges).toEqual([]);
    } finally {
      server.close();
    }
  });
});
