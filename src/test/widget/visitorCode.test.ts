/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double is intentionally untyped. */
/**
 * server/services/widget/visitorCode.ts — generation, alphabet, uniqueness.
 */
import { describe, it, expect } from 'vitest';
import {
  VISITOR_CODE_ALPHABET,
  VISITOR_CODE_LENGTH,
  generateVisitorCode,
  generateUniqueVisitorCode,
  isVisitorCodeConflict,
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

function fakeSb(existingCodes: Set<string>): any {
  return {
    from(table: string) {
      expect(table).toBe('contacts');
      let eqCol: string | null = null;
      let eqVal: any = null;
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: any) {
          if (col === 'visitor_code') { eqCol = col; eqVal = val; }
          return chain;
        },
        limit() { return chain; },
        maybeSingle: async () => {
          if (eqCol === 'visitor_code' && existingCodes.has(eqVal)) {
            return { data: { id: 'existing-contact' } };
          }
          return { data: null };
        },
      };
      return chain;
    },
  };
}

describe('generateUniqueVisitorCode', () => {
  it('CASE 7: returns a code not already used in the workspace', async () => {
    const sb = fakeSb(new Set());
    const code = await generateUniqueVisitorCode(sb, 'ws1');
    expect(code).not.toBeNull();
    expect(code).toHaveLength(4);
  });

  it('retries past a collision instead of returning the taken code', async () => {
    let calls = 0;
    const sb: any = {
      from() {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          limit() { return chain; },
          maybeSingle: async () => {
            calls++;
            // First two attempts "collide", third is free.
            return { data: calls <= 2 ? { id: 'taken' } : null };
          },
        };
        return chain;
      },
    };
    const code = await generateUniqueVisitorCode(sb, 'ws1');
    expect(code).not.toBeNull();
    expect(calls).toBe(3);
  });

  it('gives up gracefully (returns null, never throws) after repeated collisions', async () => {
    const sb: any = {
      from() {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          limit() { return chain; },
          maybeSingle: async () => ({ data: { id: 'always-taken' } }),
        };
        return chain;
      },
    };
    const code = await generateUniqueVisitorCode(sb, 'ws1');
    expect(code).toBeNull();
  });

  it('never blocks/throws when the lookup itself fails', async () => {
    const sb: any = { from() { throw new Error('db down'); } };
    await expect(generateUniqueVisitorCode(sb, 'ws1')).resolves.toBeNull();
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
