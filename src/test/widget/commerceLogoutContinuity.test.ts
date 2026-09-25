import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createFakeDb } from '../commerce/support/fakeSupabase';
import { clearVisitorCookie, resolveVisitorIdentity } from '../../../server/services/widget/visitorIdentity';
import { createSignedContactContinuityToken } from '../../../server/services/widget/continuity';
import { resolveKnownContact } from '../../../server/services/widget/crossWidgetIdentity';

vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: vi.fn() }));
const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
function request(cookies: Record<string, string> = {}, secure = true) {
  return { cookies, headers: {}, secure } as unknown as Request;
}
function response() {
  const headers: string[] = [];
  return { headers, res: { append: (_key: string, value: string) => headers.push(value) } as unknown as Response };
}
function applyCookies(jar: Record<string, string>, headers: string[]) {
  for (const header of headers) {
    const [pair] = header.split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at);
    if (header.includes('Max-Age=0')) delete jar[name];
    else jar[name] = decodeURIComponent(pair.slice(at + 1));
  }
}
beforeEach(() => vi.stubEnv('WIDGET_SIGNING_SECRET', 'test-only-widget-signing-secret'));
afterEach(() => vi.unstubAllEnvs());

describe('commerce logout and contact continuity', () => {
  it('cannot restore the previous contact after a fresh-visitor bootstrap, while retaining its data', async () => {
    const first = response();
    const visitor = resolveVisitorIdentity(request(), first.res, WS);
    const jar: Record<string, string> = { dvcid: createSignedContactContinuityToken(WS, 'contact-a') };
    applyCookies(jar, first.headers);
    const db = createFakeDb({
      contacts: [{ id: 'contact-a', workspace_id: WS, name: 'Alice', email: 'alice@example.test', metadata: { visitor_id: visitor.visitorId } }],
      visitor_sessions: [{ id: 'session-a', workspace_id: WS, visitor_id: visitor.visitorId, contact_id: 'contact-a' }],
      conversations: [{ id: 'conversation-a', workspace_id: WS, contact_id: 'contact-a' }],
    });
    const saved = structuredClone(db.tables);
    const reset = response();
    const req = request({ ...jar });
    const next = resolveVisitorIdentity(req, reset.res, WS, { forceNew: true });
    expect(next.visitorId).not.toBe(visitor.visitorId);
    expect(req.cookies.dvcid).toBeUndefined();
    applyCookies(jar, reset.headers);
    expect(jar.dvsid).toBeTruthy();
    expect(jar.dvcid).toBeUndefined();
    const contact = await resolveKnownContact(db.client as unknown as SupabaseClient, request(jar), response().res, WS, next.visitorId, 'chat_widget');
    expect(contact).toBeNull();
    expect(db.tables.contacts).toEqual(saved.contacts);
    expect(db.tables.conversations).toEqual(saved.conversations);
    expect(db.count('rpc') + db.count('update') + db.count('delete')).toBe(0);
  });

  it.each([true, false])('explicit logout clears both cookies with matching attributes (secure=%s)', secure => {
    const out = response();
    clearVisitorCookie(out.res, request({ dvsid: 'old', dvcid: 'old-contact' }, secure));
    expect(out.headers).toHaveLength(2);
    expect(out.headers[0]).toContain('dvsid=; Path=/api; HttpOnly; Max-Age=0');
    expect(out.headers[1]).toContain('dvcid=; Path=/api; HttpOnly; Max-Age=0');
    for (const header of out.headers) {
      expect(header.includes('Partitioned')).toBe(secure);
      expect(header.includes('SameSite=None')).toBe(secure);
    }
  });

  it('ordinary reloads preserve the visitor and contact continuity', () => {
    const first = response();
    const original = resolveVisitorIdentity(request(), first.res, WS);
    const jar = { dvcid: 'existing-contact-continuity' };
    applyCookies(jar, first.headers);
    const next = response();
    expect(resolveVisitorIdentity(request(jar), next.res, WS).visitorId).toBe(original.visitorId);
    expect(next.headers).toHaveLength(1);
    expect(jar.dvcid).toBe('existing-contact-continuity');
  });
});
