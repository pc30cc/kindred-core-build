/**
 * Operator events stay off the visitor's channel (contract §6a).
 *
 * The visitor's widget subscribes to ws:<ws>:conv:<cid>. publishOperatorEvent
 * used to publish every operator `event` there as well as on the inbox
 * channel, so private-note previews, tag changes and assignee ids reached the
 * visitor's browser: the widget's drivers drop those kinds, but devtools show
 * them. Now:
 *
 *  - every operator event goes, whole, to the operator-only inbox channel
 *    (where the inbox list, an open thread and the apps hear it);
 *  - only a kind the widget acts on (WIDGET_EVENT_FIELDS: call:ended) also
 *    goes to the conversation channel, cut down to the fields the widget
 *    reads;
 *  - the note routes publish ids, never the note's text;
 *  - the list of widget kinds is pinned to what the drivers forward and the
 *    fields to what the widget's handler reads, and no other server code
 *    puts an `event` envelope on a conversation channel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const published = vi.hoisted(() => [] as Array<{ channel: string; envelope: { type: string; payload: Record<string, unknown> } }>);
vi.mock('../../../server/services/realtime/resolvePublisher.js', () => ({
  resolvePublisher: async () => ({
    vendor: 'centrifugo',
    publish: async (channel: string, envelope: { type: string; payload: Record<string, unknown> }) => {
      published.push({ channel, envelope });
      return { ok: true };
    },
  }),
}));

const { publishOperatorEvent, WIDGET_EVENT_FIELDS, widgetEventPayload } = await import('../../../server/services/realtime/publish.js');

const WS = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const CONV_CHANNEL = `ws:${WS}:conv:${CID}`;
const INBOX = `ws:${WS}:inbox`;

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

beforeEach(() => { published.length = 0; });

describe('publishOperatorEvent', () => {
  // Every kind the server publishes through it today (server/ call sites).
  const OPERATOR_ONLY: Array<Record<string, unknown>> = [
    { kind: 'note_added', note_id: 'n1', created_at: '2026-10-18T00:00:00Z' },
    { kind: 'note_deleted', note_id: 'n1', created_at: '2026-10-18T00:00:00Z' },
    { kind: 'conversation_updated', changes: { tags: { added: ['vip'], removed: [] }, assigned_to: { from: null, to: OP } } },
    { kind: 'conversation_resolved', changes: { status: { from: 'open', to: 'resolved' } } },
    { kind: 'conversation_reopened', changes: { status: { from: 'resolved', to: 'open' } } },
    { kind: 'timeline_event', event_id: 'e1', event_type: 'tag_added', actor_type: 'agent' },
    { kind: 'spam_changed', is_spam: true },
    { kind: 'ai_handoff_requested' },
    { kind: 'ai_human_takeover' },
    { kind: 'ai_suggestion_created', suggestion_id: 's1' },
    { kind: 'ai_suggestion_updated', suggestion_id: 's1', status: 'used' },
    { kind: 'call_invitation_changed', invitation_id: 'i1', status: 'pending', channel: 'audio', expires_at: null },
    { kind: 'contact_updated', contact_id: 'ct1' },
  ];

  it.each(OPERATOR_ONLY.map((p) => [p.kind as string, p]))('%s: the inbox channel only, whole', async (_kind, extra) => {
    const payload = { conversation_id: CID, workspace_id: WS, actor_id: OP, ...extra } as Parameters<typeof publishOperatorEvent>[1];
    await publishOperatorEvent({} as never, payload);
    expect(published).toEqual([{ channel: INBOX, envelope: { type: 'event', payload } }]);
  });

  it('call:ended: whole on the inbox channel, and the widget\'s fields alone on the conversation channel', async () => {
    const payload = {
      kind: 'call:ended', conversation_id: CID, workspace_id: WS, actor_id: OP, call_session_id: 'call-1',
      ended_by: 'operator', reason: 'operator_ended', duration_seconds: 135, ended_at: '2026-10-18T10:00:00Z',
    } as unknown as Parameters<typeof publishOperatorEvent>[1];
    await publishOperatorEvent({} as never, payload);
    const byChannel = Object.fromEntries(published.map((p) => [p.channel, p.envelope]));
    expect(Object.keys(byChannel).sort()).toEqual([CONV_CHANNEL, INBOX].sort());
    expect(byChannel[INBOX]).toEqual({ type: 'event', payload });
    expect(byChannel[CONV_CHANNEL]).toEqual({
      type: 'event',
      payload: { kind: 'call:ended', call_session_id: 'call-1', ended_by: 'operator', duration_seconds: 135, ended_at: '2026-10-18T10:00:00Z' },
    });
  });

  it('skipConversationChannel leaves out even a widget kind; a mailbox signal stays inbox-only', async () => {
    await publishOperatorEvent({} as never, { kind: 'call:ended' as never, conversation_id: CID, workspace_id: WS, call_session_id: 'c' }, { skipConversationChannel: true });
    await publishOperatorEvent({} as never, { kind: 'email_mailbox_changed', conversation_id: '', workspace_id: WS }, { skipConversationChannel: true });
    expect(published.map((p) => p.channel)).toEqual([INBOX, INBOX]);
  });

  it('a kind is a widget kind only by its own name (no prototype keys)', () => {
    for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(widgetEventPayload({ kind: kind as never, conversation_id: CID, workspace_id: WS })).toBeNull();
    }
  });
});

describe('what the visitor channel may carry is what the widget reads', () => {
  /** `p.kind === '…'` comparisons in a driver's `event` branch. */
  const kindsIn = (src: string) => new Set([...src.matchAll(/\.kind === '([^']+)'/g)].map((m) => m[1]));

  it('the drivers act on exactly the widget kinds (plus call:incoming, which routes/calls.ts publishes itself)', () => {
    const expected = new Set([...Object.keys(WIDGET_EVENT_FIELDS), 'call:incoming']);
    for (const driver of ['public/widget/runtime-rt-centrifugo.js', 'public/widget/runtime-rt-supabase.js']) {
      expect(kindsIn(read(driver)), driver).toEqual(expected);
    }
  });

  it('call:ended carries the fields handleServerCallEnded reads, and nothing else', () => {
    const runtime = read('public/widget/runtime.js');
    const start = runtime.indexOf('function handleServerCallEnded(payload)');
    expect(start).toBeGreaterThan(-1);
    const body = runtime.slice(start, runtime.indexOf('\n    }\n', start));
    const reads = new Set([...body.matchAll(/payload\.([a-z_]+)/g)].map((m) => m[1]));
    // `call_id` is an older name of call_session_id the handler still accepts; nothing publishes it.
    reads.delete('call_id');
    expect(new Set(WIDGET_EVENT_FIELDS['call:ended'].filter((f) => f !== 'kind'))).toEqual(reads);
  });

  it('no other server code puts an `event` envelope on a conversation channel', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(relative(process.cwd(), p));
      }
    };
    walk(join(process.cwd(), 'server'));
    const withEventEnvelope = files.filter((f) => /type:\s*'event'/.test(read(f))).sort();
    expect(withEventEnvelope).toEqual([
      // call:incoming, which the widget's drivers act on (it rings the visitor).
      'server/routes/calls.ts',
      // ws:<ws>:queue (operators' call queue), not a conversation channel.
      'server/services/calls/callbacks.ts',
      'server/services/calls/queue.ts',
      // This module: publishOperatorEvent, team, support and visitor events.
      'server/services/realtime/publish.ts',
      'server/services/webAnalytics/eventsService.ts',
    ]);
    expect(read('server/services/calls/queue.ts')).toContain('return `ws:${workspaceId}:queue`;');
    expect(read('server/services/calls/callbacks.ts')).toContain('return `ws:${workspaceId}:queue`;');
    // eventsService's `type: 'event'` is a funnel step, not an envelope.
    expect(read('server/services/webAnalytics/eventsService.ts')).not.toMatch(/publish/);
  });
});

// ─── The note routes: ids only, on the inbox channel ────────────────────────
type Row = Record<string, unknown>;
const tables = vi.hoisted(() => ({} as Record<string, Row[]>));
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows = (tables[table] ||= []);
      const filters: Array<(r: Row) => boolean> = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
        in: () => b,
        order: () => b,
        maybeSingle: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
        insert: (row: Row) => {
          const inserted = { id: 'note-1', created_at: '2026-10-18T10:00:00Z', updated_at: null, ...row };
          rows.push(inserted);
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
        delete: () => {
          const d: Record<string, unknown> = { eq: () => d, then: (res: (v: unknown) => unknown) => res({ error: null, count: 1 }) };
          return d;
        },
        then: (res: (v: unknown) => unknown) => res({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
      };
      return b;
    },
  }),
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: OP }),
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({ recordConversationEvent: async () => ({ ok: true }) }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyInboundMessage: async () => undefined }));
vi.mock('../../../server/services/storage/urlResolver.js', () => ({ hydrateUserAvatars: async (_c: unknown, rows: unknown) => rows }));

describe('the note routes', () => {
  it('POST and DELETE publish the note\'s ids on the inbox channel, never its text, never on the conversation channel', async () => {
    const { conversationNotesRouter } = await import('../../../server/routes/conversationNotes.js');
    const app = express();
    app.use((req, _res, next) => { (req as unknown as Row).serverConfig = {}; next(); });
    app.use(express.json());
    app.use('/api/conversations', conversationNotesRouter);
    const server = http.createServer(app).listen(0);
    const call = (method: string, path: string, body?: unknown) => new Promise<number>((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request({
        host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
    try {
      tables.conversations = [{ id: CID, workspace_id: WS }];
      tables.conversation_notes = [];
      const secret = 'The customer threatened to sue; refund quietly';
      expect(await call('POST', `/api/conversations/${CID}/notes`, { workspace_id: WS, body: secret })).toBe(200);
      tables.conversation_notes = [{ id: 'note-1', conversation_id: CID, workspace_id: WS, author_id: OP }];
      expect(await call('DELETE', `/api/conversations/${CID}/notes/note-1?workspace_id=${WS}`)).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(published.map((p) => [p.channel, p.envelope.payload.kind])).toEqual([[INBOX, 'note_added'], [INBOX, 'note_deleted']]);
      expect(JSON.stringify(published)).not.toContain('sue');
      expect(Object.keys(published[0].envelope.payload).sort()).toEqual(['actor_id', 'conversation_id', 'created_at', 'kind', 'note_id', 'workspace_id']);
    } finally {
      server.close();
    }
  });
});
