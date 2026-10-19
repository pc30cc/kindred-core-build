// @vitest-environment node
/**
 * The widget's team and the agent face's letter (shared/widgetTeam.ts), the
 * one rule GET /config and the dashboard's picker and preview follow:
 *
 *   - the first four members to join (`created_at`, then the user id),
 *     whatever order the rows come in; an unreadable stamp joins last;
 *   - the stack's name is the member's own; without one (or with nothing
 *     that shows) the widget's word for an operator in its language, never
 *     an English «Operator» on a Persian or Turkish widget;
 *   - the letter: online first, the first character that shows of the
 *     stack's names (as t1's lead face draws it), else the workspace's name.
 */
import { describe, expect, it } from 'vitest';
import {
  WIDGET_TEAM_NAME_FALLBACK,
  WIDGET_TEAM_SIZE,
  agentFaceInitial,
  onlineFirst,
  widgetTeamMembers,
  widgetTeamName,
} from '../../../shared/widgetTeam';

const row = (user_id: string, created_at: string | null) => ({ user_id, created_at });

describe('the team: the first four to join', () => {
  it('in the order they joined, whatever order the rows come in', () => {
    const rows = [
      row('e', '2026-10-05T09:00:00+00:00'),
      row('b', '2026-10-01T09:00:00.25+00:00'),
      row('a', '2026-10-01T09:00:00+00:00'),
      row('d', '2026-10-03T09:00:00+00:00'),
      row('c', '2026-10-02T09:00:00Z'),
    ];
    expect(WIDGET_TEAM_SIZE).toBe(4);
    expect(widgetTeamMembers(rows).map((r) => r.user_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(widgetTeamMembers([...rows].reverse()).map((r) => r.user_id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a tie by the stored text, then by user id; an unreadable stamp last; no user id, no member', () => {
    const rows = [
      row('9', '2026-10-01T09:00:00.000002+00:00'),
      row('8', '2026-10-01T09:00:00.000001+00:00'),
      row('2', '2026-10-01T09:00:00+00:00'),
      row('1', '2026-10-01T09:00:00+00:00'),
      row('0', null),
      { user_id: null, created_at: '2020-01-01T00:00:00Z' },
    ];
    expect(widgetTeamMembers(rows).map((r) => r.user_id)).toEqual(['1', '2', '8', '9']);
    expect(widgetTeamMembers([row('z', null), row('w', 'not a date'), row('y', null), row('x', '2026-01-01T00:00:00Z')]).map((r) => r.user_id))
      .toEqual(['x', 'y', 'z', 'w']);
    expect(widgetTeamMembers([])).toEqual([]);
  });

  it('keeps every other field of the row', () => {
    const [first] = widgetTeamMembers([{ user_id: 'u', created_at: null, full_name: 'سارا', email: 'sara@example.com' }]);
    expect(first).toEqual({ user_id: 'u', created_at: null, full_name: 'سارا', email: 'sara@example.com' });
  });
});

describe('names and the letter', () => {
  it('the stack names a member without a name of their own in the widget\'s language, never by their email', () => {
    expect(widgetTeamName('سارا', 'fa')).toBe('سارا');
    expect(widgetTeamName(null, 'fa')).toBe('اپراتور');
    expect(widgetTeamName('', 'tr')).toBe('Operatör');
    expect(widgetTeamName(undefined, 'en')).toBe('Operator');
    expect(WIDGET_TEAM_NAME_FALLBACK).toEqual({ en: 'Operator', fa: 'اپراتور', tr: 'Operatör' });
    // A region tag, an unknown language or none: its base, else English.
    expect(widgetTeamName(null, 'fa-IR')).toBe('اپراتور');
    expect(widgetTeamName(null, 'TR')).toBe('Operatör');
    expect(widgetTeamName(null, 'de')).toBe('Operator');
    expect(widgetTeamName(null, 'constructor')).toBe('Operator');
    expect(widgetTeamName(null, null)).toBe('Operator');
  });

  it('a name with nothing that shows is no name; one that starts with a mark keeps it', () => {
    for (const blank of ['  ', '\u200c', '\u200f', '\u200e\u00a0', '\u0000', '\u0301']) {
      expect(widgetTeamName(blank, 'fa'), JSON.stringify(blank)).toBe('اپراتور');
    }
    expect(widgetTeamName('\u200fسارا', 'fa')).toBe('\u200fسارا');
  });

  it('online first, the team\'s order otherwise', () => {
    const team = [{ id: 1, online: false }, { id: 2, online: true }, { id: 3, online: false }, { id: 4, online: true }];
    expect(onlineFirst(team).map((m) => m.id)).toEqual([2, 4, 1, 3]);
    expect(team.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  });

  it('the letter: the first online member\'s stack name, the placeholder included; else the workspace', () => {
    expect(agentFaceInitial([{ name: 'Reza', online: false }, { name: 'سارا', online: true }], 'Acme')).toBe('س');
    // A nameless operator leads: their stack name's letter, in the widget's language.
    expect(agentFaceInitial([{ name: widgetTeamName(null, 'fa'), online: true }, { name: 'Reza', online: true }], 'Acme')).toBe('ا');
    expect(agentFaceInitial([{ name: widgetTeamName(null, 'tr'), online: true }], 'Acme')).toBe('O');
    expect(agentFaceInitial([], 'Acme')).toBe('A');
    expect(agentFaceInitial([], null)).toBe('');
  });

  it('the letter is a character that shows: a mark before a name (an RLM, a ZWNJ) is passed over', () => {
    expect(agentFaceInitial([{ name: '\u200fسارا', online: true }], 'Acme')).toBe('س');
    expect(agentFaceInitial([{ name: '\ufeffSara', online: true }], 'Acme')).toBe('S');
    expect(agentFaceInitial([{ name: '\u200c', online: true }, { name: 'Reza', online: true }], 'Acme')).toBe('R');
    expect(agentFaceInitial([{ name: '\u200e\u00a0', online: true }], '\u202bنیلوفر')).toBe('ن');
    // A whole code point, as before.
    expect(agentFaceInitial([{ name: '👩‍💻 Sara', online: true }], 'Acme')).toBe('👩');
  });
});
