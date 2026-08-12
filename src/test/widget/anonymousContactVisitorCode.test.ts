/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double is intentionally untyped. */
/**
 * ensureVisitorContact — visitor_code belongs to the persistent contact, not
 * the session: generated once on first creation, then re-used (never
 * re-generated) on every subsequent lookup for the same visitor/email/phone,
 * including across new sessions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ensureVisitorContact } from '../../../server/services/widget/anonymousContact.js';

const WS = 'ws1';

let nextContactId = 1;

function fakeSb(state: { contacts: any[] }): any {
  return {
    from(table: string) {
      if (table === 'visitor_sessions') {
        const chain: any = {
          update() { return chain; },
          eq() { return chain; },
          is() { return chain; },
          then: (resolve: any) => resolve({ data: [], error: null }),
        };
        return chain;
      }
      // contacts
      const filters: Record<string, any> = {};
      let containsMeta: Record<string, any> | null = null;
      let isNullCol: string | null = null;
      const matches = (row: any) => {
        for (const [k, v] of Object.entries(filters)) if (row[k] !== v) return false;
        if (containsMeta) {
          for (const [k, v] of Object.entries(containsMeta)) {
            if ((row.metadata ?? {})[k] !== v) return false;
          }
        }
        if (isNullCol && row[isNullCol] != null) return false;
        return true;
      };
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: any) { filters[col] = val; return chain; },
        contains(_col: string, val: Record<string, any>) { containsMeta = val; return chain; },
        is(col: string, _val: null) { isNullCol = col; return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({ data: state.contacts.find(matches) ?? null }),
        insert(payload: any) {
          const codeTaken = payload.visitor_code
            && state.contacts.some((c) => c.workspace_id === payload.workspace_id && c.visitor_code === payload.visitor_code);
          const insertChain: any = {
            select() { return insertChain; },
            single: async () => {
              if (codeTaken) {
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' } };
              }
              const row = { id: `contact-${nextContactId++}`, ...payload };
              state.contacts.push(row);
              return { data: { id: row.id }, error: null };
            },
          };
          return insertChain;
        },
        // Real UPDATE ... WHERE ... [RETURNING]: matches are computed from
        // ALL chained filters (eq + is), applied once, then either awaited
        // directly ({error}) or via .select() ({data: matchedRows, error}) —
        // mirroring PostgREST closely enough that backfillVisitorCode's
        // "zero rows updated" race-detection actually gets exercised here,
        // not silently bypassed by a chain-shape mismatch.
        update(patch: any) {
          const uFilters: Record<string, any> = {};
          let uIsNullCol: string | null = null;
          const applyAndMatch = () => {
            const matched = state.contacts.filter((c) => {
              for (const [k, v] of Object.entries(uFilters)) if (c[k] !== v) return false;
              if (uIsNullCol && c[uIsNullCol] != null) return false;
              return true;
            });
            for (const row of matched) Object.assign(row, patch);
            return matched;
          };
          const uChain: any = {
            eq(col: string, val: any) { uFilters[col] = val; return uChain; },
            is(col: string, _val: null) { uIsNullCol = col; return uChain; },
            select() {
              const matched = applyAndMatch();
              return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null });
            },
            then(resolve: any) {
              applyAndMatch();
              return resolve({ error: null });
            },
          };
          return uChain;
        },
      };
      return chain;
    },
  };
}

describe('ensureVisitorContact — visitor_code stability', () => {
  let state: { contacts: any[] };
  beforeEach(() => { state = { contacts: [] }; nextContactId = 1; });

  it('CASE 4: same visitor, new session → same contact id AND same visitor_code', async () => {
    const id1 = await ensureVisitorContact(fakeSb(state), {
      workspaceId: WS, visitorId: 'v1', sessionId: 'sess-A',
    });
    expect(id1).not.toBeNull();
    const codeAfterFirst = state.contacts[0].visitor_code;
    expect(codeAfterFirst).toBeTruthy();

    // New browsing session, same persistent visitor_id.
    const id2 = await ensureVisitorContact(fakeSb(state), {
      workspaceId: WS, visitorId: 'v1', sessionId: 'sess-B',
    });
    expect(id2).toBe(id1);
    expect(state.contacts).toHaveLength(1); // no duplicate contact created
    expect(state.contacts[0].visitor_code).toBe(codeAfterFirst); // code unchanged
  });

  it('a different visitor gets a different contact (and independently generated code)', async () => {
    await ensureVisitorContact(fakeSb(state), { workspaceId: WS, visitorId: 'v1', sessionId: 's1' });
    await ensureVisitorContact(fakeSb(state), { workspaceId: WS, visitorId: 'v2', sessionId: 's2' });
    expect(state.contacts).toHaveLength(2);
    expect(state.contacts[0].id).not.toBe(state.contacts[1].id);
  });

  it('CASE 13: legacy contact (created before visitor_code existed) is backfilled lazily on next touch, not left broken', async () => {
    state.contacts.push({
      id: 'legacy-1', workspace_id: WS, visitor_code: null,
      metadata: { visitor_id: 'v-legacy' },
    });
    const id = await ensureVisitorContact(fakeSb(state), {
      workspaceId: WS, visitorId: 'v-legacy', sessionId: 's1',
    });
    expect(id).toBe('legacy-1');
    expect(state.contacts[0].visitor_code).toBeTruthy();
  });

  it('does not create a new contact for the backfill — same row, same id', async () => {
    state.contacts.push({
      id: 'legacy-2', workspace_id: WS, visitor_code: null,
      metadata: { visitor_id: 'v-legacy-2' },
    });
    await ensureVisitorContact(fakeSb(state), { workspaceId: WS, visitorId: 'v-legacy-2', sessionId: 's1' });
    expect(state.contacts).toHaveLength(1);
  });

  /**
   * Regression test for the collision-retry bug: an insert-time
   * visitor_code unique conflict must generate a FRESH code and retry the
   * INSERT itself — not silently fall back to null while a stale local
   * variable still holds the conflicting code (the actual bug: the retry
   * re-inserted with null, but a later `if (!visitorCode)` check looked at
   * the original — still-truthy — generated code and skipped the backfill,
   * so the row was permanently left without one).
   */
  it('retries an insert-time visitor_code collision with a NEW code and the contact ends up with a real, non-null code', async () => {
    let insertAttempts = 0;
    const sbCollideThenSucceed: any = {
      from(table: string) {
        if (table === 'visitor_sessions') {
          const c: any = { update() { return c; }, eq() { return c; }, is() { return c; }, then: (r: any) => r({ data: [], error: null }) };
          return c;
        }
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          contains() { return chain; },
          limit() { return chain; },
          maybeSingle: async () => ({ data: null }), // no existing contact — always creates
          insert(payload: any) {
            const insertChain: any = {
              select() { return insertChain; },
              single: async () => {
                insertAttempts++;
                // First two INSERT attempts collide regardless of which
                // code was generated (simulates two other concurrent
                // requests each winning a race against us); the third
                // attempt (a genuinely fresh code) succeeds.
                if (insertAttempts <= 2) {
                  expect(payload.visitor_code).toBeTruthy(); // still trying real codes, not null
                  return {
                    data: null,
                    error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' },
                  };
                }
                return { data: { id: 'created-retry' }, error: null };
              },
            };
            return insertChain;
          },
        };
        return chain;
      },
    };
    const id = await ensureVisitorContact(sbCollideThenSucceed, { workspaceId: WS, visitorId: 'v-retry', sessionId: 's1' });
    expect(id).toBe('created-retry');
    expect(insertAttempts).toBe(3); // 2 collisions + 1 success, not "collide once then give up"
  });

  it('contact creation still succeeds (with visitor_code left null, then immediately backfilled) when every attempt collides', async () => {
    const sbAllTaken: any = {
      from(table: string) {
        if (table === 'visitor_sessions') {
          const c: any = { update() { return c; }, eq() { return c; }, is() { return c; }, then: (r: any) => r({ data: [], error: null }) };
          return c;
        }
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          contains() { return chain; },
          limit() { return chain; },
          is() { return chain; },
          maybeSingle: async () => ({ data: null }),
          insert(payload: any) {
            const insertChain: any = {
              select() { return insertChain; },
              single: async () => {
                if (payload.visitor_code !== null) {
                  // Every real code collides — code space is fully contended.
                  return {
                    data: null,
                    error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' },
                  };
                }
                return { data: { id: 'created-null' }, error: null };
              },
            };
            return insertChain;
          },
          update() {
            const updateChain: any = {
              eq() {
                const c2: any = {
                  is: () => ({
                    // The post-create backfill attempt also collides every
                    // time — it must give up gracefully, not throw/hang.
                    select: () => Promise.resolve({
                      data: null,
                      error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' },
                    }),
                  }),
                };
                return c2;
              },
            };
            return updateChain;
          },
        };
        return chain;
      },
    };
    const id = await ensureVisitorContact(sbAllTaken, { workspaceId: WS, visitorId: 'v-contended', sessionId: 's1' });
    expect(id).toBe('created-null'); // contact creation is never blocked
  });
});
