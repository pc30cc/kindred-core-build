/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double is intentionally untyped. */
/**
 * mergeVisitorIdentity's contact-creation path also assigns visitor_code —
 * this is the second (identification-triggered) contact-creation entry
 * point alongside ensureVisitorContact's anonymous one, and previously
 * didn't set anon_code at all. See server/services/widget/identityMerge.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../server/services/geo/index.js', () => ({
  resolveVisitorGeo: async () => ({
    country: null, country_code: null, region: null, city: null,
    latitude: null, longitude: null, timezone: null, source: 'none',
  }),
}));

const WS = 'ws1';

function fakeSupabase(state: { contacts: any[] }): any {
  return {
    from(table: string) {
      if (table === 'widget_settings') {
        const c: any = { select() { return c; }, eq() { return c; }, maybeSingle: async () => ({ data: null }) };
        return c;
      }
      if (table === 'visitor_sessions') {
        const c: any = {
          select() { return c; }, eq() { return c; }, not() { return c; },
          order() { return c; }, limit() { return c; }, is() { return c; }, update() { return c; },
          maybeSingle: async () => ({ data: null }),
        };
        return c;
      }
      // contacts
      let lookingUpByVisitorCode = false;
      const chain: any = {
        select() { return chain; },
        eq(col: string) { if (col === 'visitor_code') lookingUpByVisitorCode = true; return chain; },
        contains() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => (lookingUpByVisitorCode ? { data: null } : { data: null }),
        insert(payload: any) {
          const insertChain: any = {
            select() { return insertChain; },
            single: async () => {
              const row = { id: `contact-${state.contacts.length + 1}`, ...payload };
              state.contacts.push(row);
              return { data: { id: row.id }, error: null };
            },
          };
          return insertChain;
        },
        update(patch: any) {
          const updateChain: any = {
            eq(_col: string, val: any) {
              const row = state.contacts.find((c) => c.id === val);
              if (row) Object.assign(row, patch);
              return { then: (resolve: any) => resolve({ error: null }) };
            },
          };
          return updateChain;
        },
      };
      return chain;
    },
    rpc: async () => ({ data: { conversations_merged: 0 }, error: null }),
  };
}

describe('mergeVisitorIdentity — new contact gets a visitor_code', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assigns a visitor_code on the contact-creation path (previously only ensureVisitorContact did)', async () => {
    const { mergeVisitorIdentity } = await import('../../../server/services/widget/identityMerge.js');
    const state = { contacts: [] as any[] };
    const supabase = fakeSupabase(state);

    const result = await mergeVisitorIdentity({} as any, supabase, {
      workspaceId: WS,
      visitorId: 'v-new',
      identity: { name: 'Ali Ahmadi', email: null, phone: null },
      method: 'prechat',
    });

    expect(result.isNewContact).toBe(true);
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0].visitor_code).toBeTruthy();
    expect(state.contacts[0].visitor_code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    expect(state.contacts[0].name).toBe('Ali Ahmadi');
  });

  it('never persists the literal placeholder "Visitor" as name — uses null when no real name is known', async () => {
    const { mergeVisitorIdentity } = await import('../../../server/services/widget/identityMerge.js');
    const state = { contacts: [] as any[] };
    const supabase = fakeSupabase(state);

    // email-only identification: no name submitted.
    const result = await mergeVisitorIdentity({} as any, supabase, {
      workspaceId: WS,
      visitorId: 'v-email-only',
      identity: { name: null, email: 'ali@example.com', phone: null },
      method: 'email',
    });

    expect(result.isNewContact).toBe(true);
    expect(state.contacts[0].name).toBeNull();
    expect(state.contacts[0].name).not.toBe('Visitor');
  });

  it('retries an insert-time visitor_code collision with a new code (same bug/fix as ensureVisitorContact)', async () => {
    const { mergeVisitorIdentity } = await import('../../../server/services/widget/identityMerge.js');
    const state = { contacts: [] as any[] };
    const supabase = fakeSupabase(state);
    let insertAttempts = 0;

    const originalFrom = supabase.from.bind(supabase);
    supabase.from = (table: string) => {
      if (table !== 'contacts') return originalFrom(table);
      const real = originalFrom(table);
      return {
        ...real,
        insert(payload: any) {
          insertAttempts++;
          if (insertAttempts <= 2) {
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' },
                }),
              }),
            };
          }
          return real.insert(payload);
        },
      };
    };

    const result = await mergeVisitorIdentity({} as any, supabase, {
      workspaceId: WS,
      visitorId: 'v-collide',
      identity: { name: 'Sara Karimi', email: null, phone: null },
      method: 'prechat',
    });

    expect(result.isNewContact).toBe(true);
    expect(insertAttempts).toBe(3);
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0].visitor_code).toBeTruthy();
  });
});
