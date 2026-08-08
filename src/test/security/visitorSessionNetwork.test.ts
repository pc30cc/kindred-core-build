/**
 * visitor_sessions network identity: privacy gate + no-null-IP session rows.
 *
 * Exercises server/services/widget/crossWidgetIdentity.ts against a fake
 * Supabase client so we can assert the exact columns written.
 */
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import {
  ensureVisitorSessionRow,
  resolveSessionNetworkContext,
} from '../../../server/services/widget/crossWidgetIdentity';
import { lookupMaxmindLocal } from '../../../server/services/geo/maxmindLocal';

const WS = '00000000-0000-0000-0000-000000000001';
const VISITOR = 'v_abc';
const PUBLIC_CLIENT = '185.23.45.67';

function proxiedReq(ip = PUBLIC_CLIENT): Request {
  return {
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: '10.0.0.5' } as any,
  } as unknown as Request;
}

/** Minimal chainable Supabase stub. Records every insert/update payload. */
function fakeSb(opts: { storeRawIp: boolean; existingSessionId?: string | null }) {
  const writes: Array<{ table: string; op: 'insert' | 'update'; payload: any }> = [];
  const sb: any = {
    from(table: string) {
      const chain: any = {
        _payload: null as any,
        select() { return chain; },
        eq() { return chain; },
        is() { return chain; },
        not() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        insert(payload: any) { writes.push({ table, op: 'insert', payload }); chain._payload = payload; return chain; },
        update(payload: any) { writes.push({ table, op: 'update', payload }); return Promise.resolve({ data: null }) as any; },
        async maybeSingle() {
          if (table === 'widget_settings') return { data: { store_raw_ip: opts.storeRawIp } };
          if (table === 'visitor_sessions') {
            if (chain._payload) return { data: { id: 'new-session' } };
            return { data: opts.existingSessionId ? { id: opts.existingSessionId } : null };
          }
          return { data: null };
        },
      };
      // `update(...)` must still be chainable with `.eq(...)` in the helper.
      chain.update = (payload: any) => {
        writes.push({ table, op: 'update', payload });
        return { eq: () => Promise.resolve({ data: null }) };
      };
      return chain;
    },
  };
  return { sb, writes };
}

describe('resolveSessionNetworkContext', () => {
  it('hashes the IP and persists the raw one when store_raw_ip = true', async () => {
    const { sb } = fakeSb({ storeRawIp: true });
    const net = await resolveSessionNetworkContext(sb, proxiedReq(), WS);
    expect(net.ipHash).toMatch(/^[0-9a-f]{16}$/);
    expect(net.ipRaw).toBe(PUBLIC_CLIENT);
    expect(net.rawIp).toBe(PUBLIC_CLIENT);
  });

  it('never persists the raw IP when store_raw_ip = false, but keeps it in memory for geo', async () => {
    const { sb } = fakeSb({ storeRawIp: false });
    const net = await resolveSessionNetworkContext(sb, proxiedReq(), WS);
    expect(net.ipRaw).toBeNull();
    expect(net.ipHash).toMatch(/^[0-9a-f]{16}$/);
    expect(net.rawIp).toBe(PUBLIC_CLIENT); // in-request only → geo still works
  });

  it('yields no hash at all when no public IP can be resolved', async () => {
    const { sb } = fakeSb({ storeRawIp: true });
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
    const net = await resolveSessionNetworkContext(sb, req, WS);
    expect(net.ipHash).toBeNull();
    expect(net.ipRaw).toBeNull();
  });
});

describe('ensureVisitorSessionRow', () => {
  it('creates the session WITH its network identity (no ip_hash = null rows)', async () => {
    const { sb, writes } = fakeSb({ storeRawIp: true });
    const net = await resolveSessionNetworkContext(sb, proxiedReq(), WS);
    await ensureVisitorSessionRow(sb, WS, VISITOR, '/pricing', 'call_widget', net);
    const insert = writes.find((w) => w.table === 'visitor_sessions' && w.op === 'insert');
    expect(insert).toBeTruthy();
    expect(insert!.payload.ip_hash).toBe(net.ipHash);
    expect(insert!.payload.ip_raw).toBe(PUBLIC_CLIENT);
  });

  it('back-fills the network identity on an EXISTING session', async () => {
    const { sb, writes } = fakeSb({ storeRawIp: true, existingSessionId: 'sess-1' });
    const net = await resolveSessionNetworkContext(sb, proxiedReq(), WS);
    await ensureVisitorSessionRow(sb, WS, VISITOR, '/docs', 'chat_widget', net);
    const update = writes.find((w) => w.table === 'visitor_sessions' && w.op === 'update');
    expect(update!.payload.ip_hash).toBe(net.ipHash);
    expect(update!.payload.ip_raw).toBe(PUBLIC_CLIENT);
    expect(update!.payload.last_seen_at).toBeTruthy();
  });

  it('clears a previously stored raw IP once store_raw_ip is turned off', async () => {
    const { sb, writes } = fakeSb({ storeRawIp: false, existingSessionId: 'sess-1' });
    const net = await resolveSessionNetworkContext(sb, proxiedReq(), WS);
    await ensureVisitorSessionRow(sb, WS, VISITOR, '/docs', 'chat_widget', net);
    const update = writes.find((w) => w.table === 'visitor_sessions' && w.op === 'update');
    expect(update!.payload.ip_raw).toBeNull();
    expect(update!.payload.ip_hash).toBe(net.ipHash);
  });
});

describe('MaxMind local boundary', () => {
  it('fails soft (null) when the MMDB file is not mounted', async () => {
    await expect(
      lookupMaxmindLocal('/nonexistent/GeoLite2-City.mmdb', PUBLIC_CLIENT),
    ).resolves.toBeNull();
  });
});
