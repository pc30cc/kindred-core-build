// @vitest-environment node
/**
 * The widget's team (shared/widgetTeam.ts), the one rule GET /config and the
 * dashboard's preview follow:
 *
 *   - the first four members to join (`created_at`, then the user id),
 *     whatever order the rows come in; an unreadable stamp joins last;
 *   - the stack's name is the member's own; without one (or with nothing
 *     that shows) the widget's word for an operator in its language, never
 *     an English «Operator» on a Persian or Turkish widget;
 *   - no letter: the agent's face is a person's silhouette (owner,
 *     2026-10-24), so the module picks none.
 */
import { describe, expect, it } from 'vitest';
import * as widgetTeam from '../../../shared/widgetTeam';
import {
  WIDGET_TEAM_NAME_FALLBACK,
  WIDGET_TEAM_SIZE,
  isWidgetTeamMember,
  onlineFirst,
  widgetTeamMembers,
  widgetTeamName,
} from '../../../shared/widgetTeam';

const row = (user_id: string, created_at: string | null) => ({ user_id, created_at });

describe('the team: who receives chats', () => {
  it('the owner and team members, not staff, a suspended member, one not receiving chats or a paused seat', () => {
    for (const role of ['owner', 'agent', 'team_lead', 'support_agent', 'sales_agent']) {
      expect(isWidgetTeamMember({ role }), role).toBe(true);
    }
    for (const role of ['admin', 'marketing_manager', 'seo_manager', 'analyst', 'developer', 'billing', 'viewer', null, undefined]) {
      expect(isWidgetTeamMember({ role }), String(role)).toBe(false);
    }
    expect(isWidgetTeamMember({ role: 'agent', suspended_at: '2026-10-01T00:00:00Z' })).toBe(false);
    expect(isWidgetTeamMember({ role: 'owner', receives_chats: false })).toBe(false);
    expect(isWidgetTeamMember({ role: 'agent', receives_chats: null, seat_locked: false })).toBe(true);
    expect(isWidgetTeamMember({ role: 'agent', seat_locked: true })).toBe(false);
  });
});

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

  it('no letter: the agent\'s face is a silhouette, so nothing here picks an initial (not even the workspace\'s)', () => {
    expect(Object.keys(widgetTeam).filter((k) => /initial|letter/i.test(k))).toEqual([]);
  });
});
