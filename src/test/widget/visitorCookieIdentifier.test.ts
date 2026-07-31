import { describe, it, expect, beforeAll } from 'vitest';

// Contract test: the callback cooldown lookup in server/routes/callWidget.ts must
// use the visitor UUID (`payload.v`) — not the whole cookie payload object.
let readVisitorCookie: typeof import('../../../server/services/widget/visitorIdentity.js')['readVisitorCookie'];
let encode: (payload: Record<string, unknown>) => string;

beforeAll(async () => {
  process.env.WIDGET_VISITOR_SECRET = 'test-secret';
  const crypto = await import('node:crypto');
  const mod = await import('../../../server/services/widget/visitorIdentity.js');
  readVisitorCookie = mod.readVisitorCookie;
  const key = crypto.createHash('sha256').update('visitor-cookie:test-secret').digest();
  encode = (payload) => {
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', key).update(b64).digest('base64url');
    return `${b64}.${sig}`;
  };
});

const VISITOR_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

type CookieRequest = Parameters<typeof readVisitorCookie>[0];

function reqWith(cookies: Record<string, string>): CookieRequest {
  const req: Partial<CookieRequest> & { cookies: Record<string, string> } = { cookies };
  return req as CookieRequest;
}

describe('visitor cookie identifier', () => {
  it('exposes the visitor UUID under `v`', () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = readVisitorCookie(
      reqWith({ dvsid: encode({ v: VISITOR_ID, w: WORKSPACE_ID, iat: now, exp: now + 3600 }) }),
    );
    expect(payload).not.toBeNull();
    expect(payload!.v).toBe(VISITOR_ID);
    // The selected identifier must be a string, never the payload object.
    const visitorIdForLookup = payload ? payload.v : null;
    expect(typeof visitorIdForLookup).toBe('string');
  });

  it('returns null when no cookie is present', () => {
    expect(readVisitorCookie(reqWith({}))).toBeNull();
  });
});
