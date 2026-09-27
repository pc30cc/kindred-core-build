/**
 * Team chat in realtime.
 *
 * Every team-chat write tells the operators it concerns on their OWN channel
 * (`ws:<workspace>:user:<id>`), as ids only; and the only token an operator
 * can get for such a channel is for their own — the user id comes from the
 * session, never from the request.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-team-realtime';
process.env.REALTIME_CHANNEL_SECRET = 'realtime-channel-secret-for-tests-0123456789';

const WS = '11111111-1111-4111-8111-111111111111';
const ME = '33333333-3333-4333-8333-333333333333';
const PEER = '44444444-4444-4444-8444-444444444444';
const MSG = '55555555-5555-4555-8555-555555555555';

// ── The session: always ME, whatever the body says ──────────────────
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: ME, isAdmin: false, role: 'agent' }),
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
}));

// ── A database that answers just what the team-chat writes ask ──────
const writes: Array<{ table: string; op: string; values?: unknown }> = [];
vi.mock('../../../server/supabase.js', () => {
  const client = {
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let op = 'select';
      let values: unknown;
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) b[m] = () => b;
      b.insert = (v: unknown) => { op = 'insert'; values = v; return b; };
      b.update = (v: unknown) => { op = 'update'; values = v; return b; };
      b.maybeSingle = async () => ({ data: null, error: null });
      b.single = async () => {
        writes.push({ table, op, values });
        return {
          data: { id: MSG, sender_id: ME, recipient_id: PEER, body: 'hi', attachment_id: null, reply_to_id: null, read_at: null, created_at: new Date().toISOString() },
          error: null,
        };
      };
      // `await sb.from(..).update(..).eq(..)…` resolves the builder itself.
      b.then = (resolve: (v: unknown) => void) => { writes.push({ table, op, values }); resolve({ data: null, error: null }); };
      return b;
    },
  };
  return { getServiceClient: () => client };
});

// ── A publisher that records instead of sending ─────────────────────
const published: Array<{ channel: string; envelope: { type: string; payload: Record<string, unknown> } }> = [];
vi.mock('../../../server/services/realtime/resolvePublisher.js', () => ({
  resolvePublisher: async () => ({
    vendor: 'centrifugo',
    publish: async (channel: string, envelope: { type: string; payload: Record<string, unknown> }) => {
      published.push({ channel, envelope });
      return { ok: true };
    },
  }),
}));

const { realtimeRouter } = await import('../../../server/routes/realtime.js');
const { teamChatRouter } = await import('../../../server/routes/teamChat.js');
const { publishTeamEvent } = await import('../../../server/services/realtime/publish.js');
const { deriveSupabaseTopic } = await import('../../../server/services/realtime/channelTopic.js');
const { buildOperatorUserChannelName } = await import('../../../server/services/realtime/types.js');

const config = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'ANON_KEY',
  supabaseServiceRoleKey: 'SERVICE_KEY',
  corsOrigins: [],
};
const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = config;
  next();
});
app.use(express.json());
app.use('/api/realtime', realtimeRouter);
app.use('/api/team-chat', teamChatRouter);

interface Reply { status: number; body: Record<string, unknown> | null }

function post(path: string, body: unknown): Promise<Reply> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      const payload = JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            let parsed: Record<string, unknown> | null = null;
            try { parsed = JSON.parse(data); } catch { /* noop */ }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.write(payload);
      req.end();
    });
  });
}

/** Publishes are fire-and-forget: let them land before looking. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  published.length = 0;
  writes.length = 0;
});

describe('POST /api/realtime/operator-user-subscribe', () => {
  it("hands the operator their own channel's topic", async () => {
    const res = await post('/api/realtime/operator-user-subscribe', { workspace_id: WS, transport: 'supabase' });
    expect(res.status).toBe(200);
    const own = buildOperatorUserChannelName(WS, ME);
    expect(own).toBe(`ws:${WS}:user:${ME}`);
    expect(res.body?.channel).toBe(own);
    expect(res.body?.topic).toBe(deriveSupabaseTopic(own, 'operator'));
  });

  it('ignores a user id named in the body', async () => {
    const res = await post('/api/realtime/operator-user-subscribe', { workspace_id: WS, transport: 'supabase', user_id: PEER });
    expect(res.status).toBe(200);
    expect(res.body?.channel).toBe(`ws:${WS}:user:${ME}`);
    expect(JSON.stringify(res.body)).not.toContain(PEER);
  });

  it('refuses a request without a workspace', async () => {
    const res = await post('/api/realtime/operator-user-subscribe', { transport: 'supabase' });
    expect(res.status).toBe(400);
  });
});

describe('publishTeamEvent', () => {
  it("reaches each operator once, on their own channel, and carries no text", async () => {
    await publishTeamEvent(config as never, [PEER, ME, PEER, ''], {
      kind: 'team_message', workspace_id: WS, message_id: MSG, sender_id: ME, recipient_id: PEER,
    });
    expect(published.map((p) => p.channel).sort()).toEqual([`ws:${WS}:user:${ME}`, `ws:${WS}:user:${PEER}`].sort());
    for (const { envelope } of published) {
      expect(envelope.type).toBe('event');
      expect(envelope.payload.kind).toBe('team_message');
      expect(envelope.payload).not.toHaveProperty('body');
    }
  });

  it('publishes nothing when there is nobody to tell', async () => {
    await publishTeamEvent(config as never, [], { kind: 'team_read', workspace_id: WS, peer_id: PEER });
    expect(published).toHaveLength(0);
  });
});

describe('team-chat writes announce themselves', () => {
  it('a send tells the recipient and the sender, with ids only', async () => {
    const res = await post('/api/team-chat/messages', { workspace_id: WS, recipient_id: PEER, body: 'hi' });
    expect(res.status).toBe(200);
    await settle();
    expect(published.map((p) => p.channel).sort()).toEqual([`ws:${WS}:user:${ME}`, `ws:${WS}:user:${PEER}`].sort());
    const payload = published[0].envelope.payload;
    expect(payload).toMatchObject({ kind: 'team_message', workspace_id: WS, message_id: MSG, sender_id: ME, recipient_id: PEER });
    expect(JSON.stringify(published)).not.toContain('"hi"');
  });

  it("a read tells the reader's own devices, and nobody else", async () => {
    const res = await post('/api/team-chat/read', { workspace_id: WS, peer_id: PEER });
    expect(res.status).toBe(200);
    await settle();
    expect(published).toHaveLength(1);
    expect(published[0].channel).toBe(`ws:${WS}:user:${ME}`);
    expect(published[0].envelope.payload).toMatchObject({ kind: 'team_read', workspace_id: WS, peer_id: PEER });
  });
});
