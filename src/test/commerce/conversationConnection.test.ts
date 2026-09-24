/**
 * Which STORE a turn is about when a workspace has several (two OpenCart
 * stores, say). connectionSelection.ts decides first: the page's own site,
 * then the only store; ambiguous selects nothing. resolveConversationConnection
 * adds one tiebreaker for the ambiguous case only: the store this visitor is
 * signed in to. It never falls back to "the newest".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCountingSupabase } from './helpers/countingSupabase';

const WS = 'ws-1';
const fake = createCountingSupabase();
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fake.client }));

const { resolveConversationConnection } = await import('../../../server/services/commerce/gateway.js');
const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;

function store(id: string, origin: string, created: string) {
  return {
    id, workspace_id: WS, installation_id: `inst-${id}`, provider_type: 'opencart', store_id: `${origin}/`, approved_origin: origin,
    capabilities: [], permissions: {}, health: 'connected', catalog_ready: false, revoked_at: null, protocol_version: 'webyar-commerce/1',
    created_at: created, external_store_id: '0', platform_version: '4.1.0.4', last_error_at: null,
  };
}

const future = new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  fake.db.commerce_connections = [store('a', 'https://a.example', '2026-01-01'), store('b', 'https://b.example', '2026-09-01')];
  fake.db.conversations = [{ id: 'conv', workspace_id: WS, visitor_session_id: 'visitor' }];
  fake.db.commerce_customer_links = [];
  fake.reset();
});

describe('several stores in one workspace', () => {
  it('the page the visitor is on decides, whatever they are signed in to', async () => {
    fake.db.commerce_customer_links = [{ workspace_id: WS, connection_id: 'b', visitor_id: 'visitor', expires_at: future, verified_at: future }];
    const c = await resolveConversationConnection(CONFIG, WS, { conversationId: 'conv', pageOrigin: 'https://a.example', pagePath: '/' });
    expect(c?.id).toBe('a');
    // Settled by the connection list alone: no conversation or link read.
    expect(fake.total()).toMatchObject({ select: 1 });
  });

  it('no page context: the store the visitor is signed in to breaks the tie', async () => {
    fake.db.commerce_customer_links = [{ workspace_id: WS, connection_id: 'a', visitor_id: 'visitor', expires_at: future, verified_at: future }];
    const c = await resolveConversationConnection(CONFIG, WS, { conversationId: 'conv' });
    expect(c?.id).toBe('a');
  });

  it('no page context and no link: nothing is selected — never "the newest"', async () => {
    expect(await resolveConversationConnection(CONFIG, WS, { conversationId: 'conv' })).toBeNull();
  });

  it('an expired link is no tiebreaker', async () => {
    fake.db.commerce_customer_links = [{ workspace_id: WS, connection_id: 'a', visitor_id: 'visitor', expires_at: '2020-01-01T00:00:00Z', verified_at: '2020-01-01T00:00:00Z' }];
    expect(await resolveConversationConnection(CONFIG, WS, { conversationId: 'conv' })).toBeNull();
  });

  it('a turn that reads nothing private skips the link lookup', async () => {
    fake.db.commerce_customer_links = [{ workspace_id: WS, connection_id: 'a', visitor_id: 'visitor', expires_at: future, verified_at: future }];
    expect(await resolveConversationConnection(CONFIG, WS, { conversationId: 'conv', skipLinkLookup: true })).toBeNull();
    expect(fake.total()).toMatchObject({ select: 1 });
  });
});

describe('one store', () => {
  it('is selected with one read and no link lookup', async () => {
    fake.db.commerce_connections = [store('a', 'https://a.example', '2026-01-01')];
    const c = await resolveConversationConnection(CONFIG, WS, { conversationId: 'conv' });
    expect(c?.id).toBe('a');
    expect(fake.total()).toMatchObject({ select: 1 });
  });
});
