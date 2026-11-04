/**
 * One store has one active connection across all workspaces, and pairing
 * proves nothing about who controls the store. A claim therefore counts only
 * once a signed handshake with the store succeeded (`last_success_at`):
 *   - a workspace that paired a shop it does not own is pushed aside by the
 *     shop's real owner, instead of blocking them for good (a 500 on the
 *     unique index);
 *   - a store another workspace has proven is refused clearly, and the
 *     pairing code is not spent;
 *   - re-pairing in the same workspace changes nothing about this.
 * Real pairing code; only the database, plugin state and secrets are faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFakeDb, type FakeDb } from './support/fakeSupabase';

const SHOP = 'https://victimshop.example.com';
const ATTACKER_WS = '11111111-1111-4111-8111-111111111111';
const OWNER_WS = '22222222-2222-4222-8222-222222222222';

let db: FakeDb;
const revokedSecrets: string[] = [];
const statuses: Array<[string, string]> = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => db.client }));
vi.mock('../../../shared/net/hostGuard.js', () => ({ checkOutboundUrl: async () => ({ ok: true }) }));
vi.mock('../../../server/services/commerce/audit.js', () => ({ writeCommerceAudit: async () => {} }));
vi.mock('../../../server/lib/cacheBus.js', () => ({ publishCacheInvalidation: () => {} }));
vi.mock('../../../server/services/plugins/state.js', () => ({
  installPlugin: async (_c: unknown, workspaceId: string) => ({ id: `inst-${workspaceId}` }),
  setInstallationStatus: async (_c: unknown, id: string, status: string) => { statuses.push([id, status]); },
}));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  storeInstallationSecret: async () => {},
  revokeInstallationSecrets: async (_c: unknown, id: string) => { revokedSecrets.push(id); },
  readInstallationSecret: async () => null,
}));

const pairing = await import('../../../server/services/commerce/pairing.js');
const CONFIG = {} as Parameters<typeof pairing.registerPairingRequest>[0];

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = b64url(createHash('sha256').update(VERIFIER).digest());
let n = 0;

async function pair(workspaceId: string) {
  const state = `state-${++n}-0123456789abcdef`;
  await pairing.registerPairingRequest(CONFIG, {
    state, codeChallenge: CHALLENGE, redirectUri: `${SHOP}/wp-admin/admin.php?page=webyar-callback`, storeOrigin: SHOP,
  });
  const { redirectUrl } = await pairing.approvePairingRequest(CONFIG, { state, workspaceId, userId: `user-${workspaceId}`, permissions: {} });
  const code = new URL(redirectUrl).searchParams.get('code') as string;
  return { state, exchange: () => pairing.exchangePairingCode(CONFIG, { state, code, codeVerifier: VERIFIER }) };
}

const active = () => (db.tables.commerce_connections ?? []).filter((c) => !c.revoked_at);

beforeEach(() => {
  db = createFakeDb({});
  revokedSecrets.length = 0;
  statuses.length = 0;
});

describe('who holds a store', () => {
  it('a workspace that paired a shop it does not own is pushed aside by the shop\'s owner', async () => {
    await (await pair(ATTACKER_WS)).exchange();
    expect(active()).toHaveLength(1);
    // The attacker's connection never completes a handshake: the shop holds
    // no secret for it.

    const out = await (await pair(OWNER_WS)).exchange();
    expect(out.workspaceId).toBe(OWNER_WS);
    expect(active()).toEqual([expect.objectContaining({ workspace_id: OWNER_WS, store_id: SHOP })]);
    const squat = db.tables.commerce_connections.find((c) => c.workspace_id === ATTACKER_WS)!;
    expect(squat.revoked_at).toBeTruthy();
    expect(revokedSecrets).toEqual([`inst-${ATTACKER_WS}`]);
    expect(statuses).toEqual([[`inst-${ATTACKER_WS}`, 'uninstalled']]);
  });

  it('a store another workspace has proven is refused, and the code is not spent', async () => {
    await (await pair(OWNER_WS)).exchange();
    // The owner's handshake succeeded.
    db.tables.commerce_connections[0].last_success_at = new Date().toISOString();

    const attempt = await pair(ATTACKER_WS);
    await expect(attempt.exchange()).rejects.toMatchObject({ code: 'store_already_connected' });
    expect(active()).toEqual([expect.objectContaining({ workspace_id: OWNER_WS })]);
    expect(revokedSecrets).toEqual([]);
    const request = db.tables.commerce_pairing_requests.find((r) => r.state === attempt.state)!;
    expect(request.consumed_at ?? null).toBeNull();
  });

  it('re-pairing in the same workspace keeps its own connection', async () => {
    await (await pair(OWNER_WS)).exchange();
    db.tables.commerce_connections[0].last_success_at = new Date().toISOString();
    await (await pair(OWNER_WS)).exchange();
    expect(active()).toHaveLength(1);
    expect(revokedSecrets).toEqual([]);
  });
});
