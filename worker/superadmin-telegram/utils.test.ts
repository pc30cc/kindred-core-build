import { describe, expect, it } from 'vitest';
import {
  InMemoryRateGate,
  isAuthorizedPrivateMessage,
  normalizeQuestion,
  parseAllowedUserIds,
  splitTelegramText,
} from './utils.js';

describe('superadmin telegram bot guards', () => {
  it('parses only numeric allow-listed Telegram user ids', () => {
    expect([...parseAllowedUserIds('123, 456, nope, -1')]).toEqual(['123', '456']);
  });

  it('allows only private non-bot messages from the allow-list', () => {
    const allowed = new Set(['123']);
    expect(isAuthorizedPrivateMessage({
      from: { id: 123 },
      chat: { id: 123, type: 'private' },
    }, allowed)).toBe(true);
    expect(isAuthorizedPrivateMessage({
      from: { id: 123 },
      chat: { id: -99, type: 'group' },
    }, allowed)).toBe(false);
    expect(isAuthorizedPrivateMessage({
      from: { id: 999 },
      chat: { id: 999, type: 'private' },
    }, allowed)).toBe(false);
    expect(isAuthorizedPrivateMessage({
      from: { id: 123, is_bot: true },
      chat: { id: 123, type: 'private' },
    }, allowed)).toBe(false);
  });

  it('bounds questions and strips NUL bytes', () => {
    expect(normalizeQuestion('  hi\u0000there  ', 7)).toBe('hithere');
  });

  it('splits Telegram replies below the safe size', () => {
    const chunks = splitTelegramText('a '.repeat(3000), 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });

  it('rate limits entirely in memory', () => {
    const gate = new InMemoryRateGate(2, 1000);
    expect(gate.allow('u', 1000)).toBe(true);
    expect(gate.allow('u', 1100)).toBe(true);
    expect(gate.allow('u', 1200)).toBe(false);
    expect(gate.allow('u', 2101)).toBe(true);
  });
});
