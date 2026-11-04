// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the database test double is intentionally untyped. */
/**
 * Channels audit (2026-11-04), the smaller fixes:
 *   - an inbound receipt left 'processing' by a Core killed mid-way is
 *     reclaimed after its lease, unless its message was already stored;
 *   - a secret compared against a header with non-ASCII bytes answers false
 *     instead of throwing;
 *   - a mailbox OAuth state is consumed only by the member who started it;
 *   - deleting a workspace's conversations cancels its queued chat replies;
 *   - the Yahoo IMAP poll has bounded timeouts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const tables = vi.hoisted(() => ({ rows: new Map<string, Row[]>() }));

/** A small PostgREST-like client over in-memory rows: eq/is filters, update, select. */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' = 'select';
      let values: Row = {};
      let countRequested = false;
      const rows = () => tables.rows.get(table) ?? [];
      const run = () => {
        const hit = rows().filter((r) => filters.every((f) => f(r)));
        if (op === 'update') for (const r of hit) Object.assign(r, values);
        return hit;
      };
      const b: any = {
        select() { return b; },
        update(v: Row, opts?: { count?: string }) { op = 'update'; values = v; countRequested = !!opts?.count; return b; },
        eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b; },
        is(col: string, v: unknown) { filters.push((r) => (r[col] ?? null) === v); return b; },
        in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(r[col])); return b; },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then(resolve: (v: unknown) => void) {
          const hit = run();
          resolve({ data: hit, error: null, ...(countRequested ? { count: hit.length } : {}) });
        },
      };
      return b;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => fakeClient(),
  getAnonClient: () => fakeClient(),
}));

const { inboundReclaimVerdict, INBOUND_CLAIM_LEASE_MS } = await import('../../../server/services/channels/inboundProcessing.js');
const { safeSecretEqual } = await import('../../../shared/channels/webhookSecret.js');
const { constantTimeEquals } = await import('../../../server/lib/internalAuth.js');
const { consumeMailOAuthState, readMailOAuthState } = await import('../../../server/services/channels/mailOAuthState.js');
const { CHAT_OUTBOUND_JOB_TYPES, cancelWorkspaceChatReplies } = await import('../../../server/services/channels/jobs.js');
const { YAHOO_IMAP_TIMEOUTS } = await import('../../../channels/mail/yahoo/client.js');

const config = {} as any;

beforeEach(() => {
  tables.rows.clear();
});

describe('an abandoned inbound claim', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('is reclaimed once its lease is over and no message was stored', () => {
    expect(inboundReclaimVerdict({ status: 'processing', payload: { claimed_at: ago(INBOUND_CLAIM_LEASE_MS + 1000) }, message_id: null }, now)).toBe('abandoned');
  });

  it('is a duplicate while the lease runs: another request is processing it', () => {
    expect(inboundReclaimVerdict({ status: 'processing', payload: { claimed_at: ago(10_000) }, message_id: null }, now)).toBe('duplicate');
  });

  it('is never reclaimed once its message exists (no second copy)', () => {
    expect(inboundReclaimVerdict({ status: 'processing', payload: { claimed_at: ago(INBOUND_CLAIM_LEASE_MS * 10) }, message_id: 'm-1' }, now)).toBe('duplicate');
  });

  it('falls back to the creation time for receipts written before the claim time was kept', () => {
    expect(inboundReclaimVerdict({ status: 'processing', payload: {}, created_at: ago(INBOUND_CLAIM_LEASE_MS * 2), message_id: null }, now)).toBe('abandoned');
  });

  it('keeps the existing rules: failed is reclaimed, processed is a duplicate', () => {
    expect(inboundReclaimVerdict({ status: 'failed' }, now)).toBe('failed');
    expect(inboundReclaimVerdict({ status: 'processed', created_at: ago(INBOUND_CLAIM_LEASE_MS * 2) }, now)).toBe('duplicate');
    expect(inboundReclaimVerdict(null, now)).toBe('duplicate');
  });
});

describe('secret comparison', () => {
  it('answers false for a same-length header with non-ASCII bytes instead of throwing', () => {
    const expected = 'abcdef';
    const presented = 'abcdé'.padEnd(6, 'x'); // 6 characters, 7 bytes
    expect(presented.length).toBe(expected.length);
    expect(() => safeSecretEqual(presented, expected)).not.toThrow();
    expect(safeSecretEqual(presented, expected)).toBe(false);
    expect(() => constantTimeEquals(presented, expected)).not.toThrow();
    expect(constantTimeEquals(presented, expected)).toBe(false);
  });

  it('still matches equal secrets and refuses missing ones', () => {
    expect(safeSecretEqual('s3cret', 's3cret')).toBe(true);
    expect(safeSecretEqual(null, 's3cret')).toBe(false);
    expect(constantTimeEquals('s3cret', 's3cret')).toBe(true);
    expect(constantTimeEquals(undefined, 's3cret')).toBe(false);
  });
});

describe('a mailbox OAuth state', () => {
  const state = (extra: Row = {}) => ({
    provider: 'gmail',
    token: 'state-token-1',
    workspace_id: 'ws-attacker',
    installation_id: 'inst-1',
    initiated_by: 'user-attacker',
    consumed_at: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  });

  it('is not consumed by a member who did not start it (the consent link sent to someone else)', async () => {
    tables.rows.set('channel_oauth_states', [state()]);
    expect(await consumeMailOAuthState(config, 'gmail', 'state-token-1', 'user-victim')).toBeNull();
    expect(tables.rows.get('channel_oauth_states')![0].consumed_at).toBeNull();
  });

  it('is consumed once, by the member who started it', async () => {
    tables.rows.set('channel_oauth_states', [state()]);
    const row = await consumeMailOAuthState(config, 'gmail', 'state-token-1', 'user-attacker');
    expect(row?.workspace_id).toBe('ws-attacker');
    expect(await consumeMailOAuthState(config, 'gmail', 'state-token-1', 'user-attacker')).toBeNull();
  });

  it('is unusable when expired or for the other provider', async () => {
    tables.rows.set('channel_oauth_states', [state({ expires_at: new Date(Date.now() - 1000).toISOString() })]);
    expect(await readMailOAuthState(config, 'gmail', 'state-token-1')).toBeNull();
    tables.rows.set('channel_oauth_states', [state()]);
    expect(await readMailOAuthState(config, 'yahoo', 'state-token-1')).toBeNull();
  });
});

describe('deleting a workspace\'s conversations', () => {
  it('cancels its queued chat replies, and nothing else', async () => {
    tables.rows.set('channel_jobs', [
      { id: 'j1', workspace_id: 'ws-1', status: 'pending', job_type: 'telegram_outbound_message' },
      { id: 'j2', workspace_id: 'ws-1', status: 'pending', job_type: 'whatsapp_outbound_media' },
      { id: 'j3', workspace_id: 'ws-1', status: 'pending', job_type: 'yahoo_outbound_message' },
      { id: 'j4', workspace_id: 'ws-1', status: 'pending', job_type: 'telegram_inbound_event' },
      { id: 'j5', workspace_id: 'ws-2', status: 'pending', job_type: 'telegram_outbound_message' },
      { id: 'j6', workspace_id: 'ws-1', status: 'running', job_type: 'bale_outbound_message' },
    ]);
    await cancelWorkspaceChatReplies(fakeClient() as any, 'ws-1');
    const status = Object.fromEntries(tables.rows.get('channel_jobs')!.map((j) => [j.id, j.status]));
    expect(status).toEqual({ j1: 'cancelled', j2: 'cancelled', j3: 'pending', j4: 'pending', j5: 'pending', j6: 'running' });
  });

  it('names every chat channel\'s replies and no mailbox', () => {
    expect([...CHAT_OUTBOUND_JOB_TYPES].sort()).toEqual([
      'bale_outbound_media', 'bale_outbound_message',
      'instagram_outbound_media', 'instagram_outbound_message',
      'telegram_outbound_media', 'telegram_outbound_message',
      'whatsapp_outbound_media', 'whatsapp_outbound_message',
      'x_outbound_media', 'x_outbound_message',
    ]);
  });
});

describe('the Yahoo IMAP poll', () => {
  it('cannot hold the worker past its job lease', () => {
    expect(YAHOO_IMAP_TIMEOUTS.socketTimeout).toBeLessThan(120_000);
    expect(YAHOO_IMAP_TIMEOUTS.connectionTimeout).toBeLessThan(120_000);
  });
});
