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
        update(patch: any) {
          const updateChain: any = {
            eq(col: string, val: any) {
              const row = state.contacts.find((c) => c[col] === val);
              if (row && (!isNullCol || row[isNullCol] == null)) Object.assign(row, patch);
              return { then: (resolve: any) => resolve({ error: null }) };
            },
          };
          return updateChain;
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

  it('contact creation still succeeds (with visitor_code left null) when every generated code is already taken', async () => {
    const sbAllTaken: any = {
      from(table: string) {
        if (table === 'visitor_sessions') {
          const c: any = { update() { return c; }, eq() { return c; }, is() { return c; }, then: (r: any) => r({ data: [], error: null }) };
          return c;
        }
        let lookingUpByVisitorCode = false;
        const chain: any = {
          select() { return chain; },
          eq(col: string) { if (col === 'visitor_code') lookingUpByVisitorCode = true; return chain; },
          contains() { return chain; },
          limit() { return chain; },
          // The visitor_id lookup (no match, so a new contact gets created)
          // returns null; only the visitor_code uniqueness pre-check reports
          // "taken" → generator exhausts its attempts and returns null →
          // insert proceeds with visitor_code: null.
          maybeSingle: async () => (lookingUpByVisitorCode ? { data: { id: 'someone-else' } } : { data: null }),
          insert(payload: any) {
            expect(payload.visitor_code).toBeNull();
            const insertChain: any = {
              select() { return insertChain; },
              single: async () => ({ data: { id: 'created-1' }, error: null }),
            };
            return insertChain;
          },
        };
        return chain;
      },
    };
    const id = await ensureVisitorContact(sbAllTaken, { workspaceId: WS, visitorId: 'v-new', sessionId: 's1' });
    expect(id).toBe('created-1');
  });
});
