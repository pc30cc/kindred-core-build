/**
 * The widget-facing commerce endpoints, exercised through real Express.
 *
 * `/api/widget/commerce/identity` and `/api/widget/commerce/guest-verification`
 * are mounted AFTER `app.use('/api/widget', …, widgetRouter)`, so every request
 * to them passes through widgetRouter's middleware before falling through. One
 * of those middlewares writes the visitor id from the `dvsid` cookie INTO THE
 * BODY for older handlers that read it from there — and both routers validate
 * with `.strict()`, which rejects unknown keys.
 *
 * The result was that every well-formed request from a real visitor failed as
 * `invalid_request`. It reproduced exactly against the live API: the SAME body,
 * with and without the cookie.
 *
 *   with dvsid    → 400 {"error":"invalid_request"}
 *   without dvsid → 200 {"ok":true,"linked":true,"externalCustomerId":"2"}
 *
 * Every real visitor carries that cookie, so in production the customer
 * identity bridge and the whole guest order-verification flow were
 * unreachable — while a synthetic test that skipped the cookie passed.
 *
 * So the request here is shaped the way the shim leaves it, not the way the
 * client sent it.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const CONN = 'a22e727a-c3e8-4ae9-b548-9cd8ec3f1b2a';
const VISITOR = '3dab70d2-fce1-4b18-a77f-78c1f062f66d';

vi.mock('../../../server/services/widget/visitorIdentity.js', () => ({
  resolveVisitorIdentity: () => ({ visitorId: VISITOR }),
}));
vi.mock('../../../server/services/commerce/identityBridge.js', () => ({
  verifyAndBindCustomerContext: async () => ({ externalCustomerId: '2' }),
}));

const { commerceIdentityRouter } = await import('../../../server/routes/commerce/identity.js');

/** The same mount shape server/index.ts uses, shim included. */
function app() {
  const a = express();
  a.use(express.json());
  // widgetRouter's compatibility shim, verbatim in effect: the visitor id
  // from the signed cookie is written into the body of anything under
  // /api/widget, including requests that fall through to another router.
  a.use('/api/widget', (req, _res, next) => {
    if (req.body && typeof req.body === 'object' && !req.body.visitor_id) req.body.visitor_id = VISITOR;
    next();
  });
  a.use('/api/widget/commerce/identity', (req, _res, next) => { (req as any).serverConfig = {}; next(); }, commerceIdentityRouter);
  return a;
}

const post = (body: unknown) => request(app()).post('/api/widget/commerce/identity').send(body as any);

describe('a widget request that the visitor-id shim has already rewritten', () => {
  it('is accepted, not rejected as invalid_request', async () => {
    const res = await post({ workspaceId: WS, connectionId: CONN, assertion: 'signed.assertion.value' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, linked: true, externalCustomerId: '2' });
  });

  it('is accepted without a connection id too', async () => {
    const res = await post({ workspaceId: WS, assertion: 'signed.assertion.value' });
    expect(res.status).toBe(200);
  });

  it('still rejects a key the CLIENT invented', async () => {
    // Only the server's own injected key is forgiven; strict() has to keep
    // doing its job for everything else.
    const res = await post({ workspaceId: WS, connectionId: CONN, assertion: 'signed.assertion.value', isAdmin: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
  });

  it('still rejects a body that is genuinely malformed', async () => {
    const res = await post({ workspaceId: 'not-a-uuid', assertion: 'signed.assertion.value' });
    expect(res.status).toBe(400);
  });

  it('still rejects an assertion that is too short to be one', async () => {
    const res = await post({ workspaceId: WS, assertion: 'x' });
    expect(res.status).toBe(400);
  });
});
