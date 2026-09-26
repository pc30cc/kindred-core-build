import { describe, expect, it } from 'vitest';
import { MAX_CONVERSATION_IDS, isConversationId, parseConversationIds } from './conversationIds.js';

const A = '0b8c7a52-9a1e-4a8e-9f4e-1d2c3b4a5f60';
const B = '1c9d8b63-ab2f-4b9f-a05f-2e3d4c5b6a71';

describe('parseConversationIds', () => {
  it('is null when absent: the ordinary list', () => {
    expect(parseConversationIds(undefined)).toEqual({ ok: true, ids: null });
    expect(parseConversationIds(null)).toEqual({ ok: true, ids: null });
  });

  it('reads a comma-separated list, deduplicated and lower-cased', () => {
    expect(parseConversationIds(`${A}, ${B},${A.toUpperCase()}`)).toEqual({ ok: true, ids: [A, B] });
  });

  it('refuses anything that is not a list of UUIDs', () => {
    for (const raw of ['', ' , ', 'abc', `${A},not-a-uuid`, ['x'], 42]) {
      expect(parseConversationIds(raw).ok).toBe(false);
    }
  });

  it('refuses more ids than one request may name', () => {
    const many = Array.from({ length: MAX_CONVERSATION_IDS + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');
    expect(parseConversationIds(many).ok).toBe(false);
  });
});

describe('isConversationId', () => {
  it('accepts a UUID and nothing else', () => {
    expect(isConversationId(A)).toBe(true);
    for (const v of ['inbox-counts', 'inbox-tab-counts', '', undefined, 7]) expect(isConversationId(v)).toBe(false);
  });
});
