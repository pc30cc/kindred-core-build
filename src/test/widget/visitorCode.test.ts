/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double is intentionally untyped. */
/**
 * server/services/widget/visitorCode.ts — generation, alphabet, and the
 * race-safe insert/backfill retry helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  VISITOR_CODE_ALPHABET,
  VISITOR_CODE_LENGTH,
  generateVisitorCode,
  isVisitorCodeConflict,
  insertContactWithVisitorCode,
  backfillVisitorCode,
} from '../../../server/services/widget/visitorCode.js';

describe('generateVisitorCode', () => {
  it('never contains ambiguous characters (0/O, 1/I/L)', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateVisitorCode();
      for (const ch of ['0', 'O', '1', 'I', 'L']) {
        expect(code).not.toContain(ch);
      }
    }
  });

  it('is uppercase alphanumeric only, of the configured length', () => {
    const code = generateVisitorCode();
    expect(code).toHaveLength(VISITOR_CODE_LENGTH);
    for (const ch of code) expect(VISITOR_CODE_ALPHABET).toContain(ch);
  });

  it('is not sequential / predictable across calls', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateVisitorCode()));
    // With a 31^4 keyspace, 50 draws colliding or forming a sequence is
    // astronomically unlikely — this just guards against a static/counter bug.
    expect(codes.size).toBeGreaterThan(40);
  });
});

describe('isVisitorCodeConflict', () => {
  it('true only for a 23505 unique_violation naming visitor_code', () => {
    expect(isVisitorCodeConflict({ code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" ... visitor_code' })).toBe(true);
  });
  it('false for other constraint violations or error codes', () => {
    expect(isVisitorCodeConflict({ code: '23505', message: 'duplicate key value violates unique constraint on email' })).toBe(false);
    expect(isVisitorCodeConflict({ code: '23503', message: 'foreign key visitor_code' })).toBe(false);
    expect(isVisitorCodeConflict(null)).toBe(false);
    expect(isVisitorCodeConflict(undefined)).toBe(false);
  });
});

function fakeInsertOnly(behavior: (payload: any, attempt: number) => { data: any; error: any }): any {
  let attempt = 0;
  return {
    from(table: string) {
      expect(table).toBe('contacts');
      return {
        insert(payload: any) {
          attempt++;
          const result = behavior(payload, attempt);
          return { select: () => ({ single: async () => result }) };
        },
      };
    },
  };
}

describe('insertContactWithVisitorCode', () => {
  it('CASE 7: succeeds on the first attempt when there is no collision', async () => {
    const sb = fakeInsertOnly((payload) => ({ data: { id: 'c1', visitor_code: payload.visitor_code }, error: null }));
    const { data, error } = await insertContactWithVisitorCode(sb, (code) => ({ visitor_code: code }), 'id, visitor_code');
    expect(error).toBeNull();
    expect(data.id).toBe('c1');
    expect(data.visitor_code).toBeTruthy();
  });

  it('retries with a FRESH code on a genuine visitor_code collision, and the row ends up with a real (non-null) code', async () => {
    const seenCodes: (string | null)[] = [];
    const sb = fakeInsertOnly((payload, attempt) => {
      seenCodes.push(payload.visitor_code);
      if (attempt <= 2) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' } };
      }
      return { data: { id: 'c2', visitor_code: payload.visitor_code }, error: null };
    });
    const { data, error } = await insertContactWithVisitorCode(sb, (code) => ({ visitor_code: code }), 'id, visitor_code');
    expect(error).toBeNull();
    expect(data.visitor_code).toBeTruthy();
    expect(seenCodes).toHaveLength(3);
    // Every attempt used a real, non-null code — not silently null after the
    // first collision (the original bug).
    for (const c of seenCodes) expect(c).toBeTruthy();
    // And they were actually different codes (not retrying with the same one).
    expect(new Set(seenCodes).size).toBeGreaterThan(1);
  });

  it('does not retry on a non-collision error — returns it immediately', async () => {
    const sb = fakeInsertOnly(() => ({ data: null, error: { code: '23502', message: 'null value in column "workspace_id"' } }));
    const { data, error } = await insertContactWithVisitorCode(sb, (code) => ({ visitor_code: code }), 'id');
    expect(data).toBeNull();
    expect(error.code).toBe('23502');
  });

  it('falls back to visitor_code: null (and still creates the contact) when every attempt collides, then backfills it', async () => {
    let backfillAttempts = 0;
    const sb: any = {
      from(table: string) {
        expect(table).toBe('contacts');
        return {
          insert(payload: any) {
            return {
              select: () => ({
                single: async () => {
                  if (payload.visitor_code !== null) {
                    return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' } };
                  }
                  return { data: { id: 'c3' }, error: null };
                },
              }),
            };
          },
          update() {
            return {
              eq: () => ({
                is: () => {
                  backfillAttempts++;
                  // Backfill succeeds on its first try in this scenario.
                  return Promise.resolve({ error: null });
                },
              }),
            };
          },
        };
      },
    };
    const { data, error } = await insertContactWithVisitorCode(sb, (code) => ({ visitor_code: code }), 'id');
    expect(error).toBeNull();
    expect(data.id).toBe('c3');
    expect(data.visitor_code).toBeTruthy(); // backfilled, not left null
    expect(backfillAttempts).toBe(1);
  });
});

describe('backfillVisitorCode', () => {
  it('CASE 13: assigns a code to a row that currently has none', async () => {
    let updatedWith: string | null = null;
    const sb: any = {
      from() {
        return {
          update(patch: any) {
            updatedWith = patch.visitor_code;
            return { eq: () => ({ is: () => Promise.resolve({ error: null }) }) };
          },
        };
      },
    };
    const code = await backfillVisitorCode(sb, 'contact-1');
    expect(code).toBeTruthy();
    expect(updatedWith).toBe(code);
  });

  it('retries with a new code on a genuine collision', async () => {
    let attempt = 0;
    const sb: any = {
      from() {
        return {
          update() {
            return {
              eq: () => ({
                is: () => {
                  attempt++;
                  if (attempt <= 2) {
                    return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' } });
                  }
                  return Promise.resolve({ error: null });
                },
              }),
            };
          },
        };
      },
    };
    const code = await backfillVisitorCode(sb, 'contact-2');
    expect(code).toBeTruthy();
    expect(attempt).toBe(3);
  });

  it('gives up gracefully (returns null, never throws) after repeated collisions', async () => {
    const sb: any = {
      from() {
        return {
          update() {
            return {
              eq: () => ({
                is: () => Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' } }),
              }),
            };
          },
        };
      },
    };
    await expect(backfillVisitorCode(sb, 'contact-3')).resolves.toBeNull();
  });

  it('never blocks/throws when the update itself throws', async () => {
    const sb: any = { from() { throw new Error('db down'); } };
    await expect(backfillVisitorCode(sb, 'contact-4')).resolves.toBeNull();
  });
});
