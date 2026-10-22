/**
 * Two wordings of chat routing that said something else than the rules
 * (docs/operations/CHAT_ROUTING.md):
 *
 *   - "Away from desk" (an operator's own choice, migration 282: nothing new
 *     comes to them) and idle (no activity for a few minutes: a fallback
 *     tier) route differently, and each now has its own name in fa, en and
 *     tr: the account menu's dot, a teammate's presence (told apart by the
 *     server's reason), the transfer picker, the dashboard, and the
 *     Conversation assignment help, which describes the idle tier, not the
 *     choice;
 *   - the Team & departments note on chats without a department: they reach
 *     every team member, in a department or not (the Persian and Turkish
 *     read as "conversations without a department, whether they have one or
 *     not").
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { CHOICE_KEYS, myStatusKeys } from '@/lib/myOperatorStatus';
import { presenceHintKey, presenceLabelKey, presenceLabelOf } from '@/lib/presenceState';
import { transferCandidates } from '@/lib/inboxTransfer';
import type { OperatorPresence } from '@/lib/availability-api';

const LOCALES = { en, fa, tr } as const;
/** A dotted key's value in a locale table. */
function value(table: unknown, key: string): string {
  const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], table);
  if (typeof v !== 'string') throw new Error(`no string at ${key}`);
  return v;
}

describe('idle and "Away from desk" have names of their own', () => {
  it('the account menu: the idle dot is not named as the choice, in every language', () => {
    const idle = myStatusKeys('away')!;
    const chosen = myStatusKeys('manual_away')!;
    expect(chosen.label).toBe(CHOICE_KEYS.away.label);
    for (const [loc, table] of Object.entries(LOCALES)) {
      expect(value(table, idle.label), loc).not.toBe(value(table, chosen.label));
      expect(value(table, idle.hint), loc).not.toBe(value(table, chosen.hint));
    }
    expect(value(fa, idle.label)).toBe('بی‌فعالیت');
    expect(value(fa, chosen.label)).toBe('دور از میز');
    expect(value(en, idle.label)).toBe('Idle');
    expect(value(tr, idle.label)).toBe('Boşta');
  });

  it('a teammate\'s presence is told apart by the server\'s reason; without one it names both', () => {
    const row = (presence_state: OperatorPresence['presence_state'], reason: string): OperatorPresence =>
      ({ user_id: 'u', state: 'online', presence_state, reason });
    expect(presenceLabelOf(row('away', 'manual_away'))).toBe('manualAway');
    expect(presenceLabelOf(row('away', 'inactive'))).toBe('idle');
    expect(presenceLabelOf(row('away', ''))).toBe('away');
    expect(presenceLabelOf(row('active', 'available'))).toBe('active');
    for (const [loc, table] of Object.entries(LOCALES)) {
      const names = ['idle', 'manualAway', 'away'].map((l) => value(table, presenceLabelKey(l as 'idle')));
      expect(new Set(names).size, loc).toBe(3);
      for (const l of ['idle', 'manualAway', 'away'] as const) expect(value(table, presenceHintKey(l)), loc).toBeTruthy();
      // The choice's own name is the account menu's.
      expect(value(table, presenceLabelKey('manualAway')), loc).toBe(value(table, 'nav.statusAway'));
    }
  });

  it('the transfer picker and the dashboard say which one it is', () => {
    const members = [
      { user_id: 'a', role: 'agent', full_name: 'A', email: null },
      { user_id: 'b', role: 'agent', full_name: 'B', email: null },
    ];
    const presence: OperatorPresence[] = [
      { user_id: 'a', state: 'online', presence_state: 'away', reason: 'manual_away' },
      { user_id: 'b', state: 'online', presence_state: 'away', reason: 'inactive' },
    ];
    const list = transferCandidates(members, presence, {});
    expect(list.map((c) => [c.userId, c.presence, c.manualAway])).toEqual([['a', 'idle', true], ['b', 'idle', false]]);
    for (const [loc, table] of Object.entries(LOCALES)) {
      expect(value(table, 'inbox.operatorAway'), loc).toBe(value(table, 'nav.statusAway'));
      expect(value(table, 'inbox.operatorIdle'), loc).toBe(value(table, 'nav.statusIdle'));
      expect(value(table, 'dashboard.statusAway'), loc).toBe(value(table, 'nav.statusAway'));
      expect(value(table, 'dashboard.statusIdle'), loc).toBe(value(table, 'nav.statusIdle'));
    }
  });

  it('the Conversation assignment help describes the idle tier, and says the choice gets nothing new', () => {
    const help = (table: unknown) => value(table, 'widgetPage.behavior.assignment.available');
    // Persian: the fallback tier is idleness, never «دور از میز» as a state.
    expect(help(fa)).toContain('بی‌فعالیت');
    expect(help(fa)).not.toContain('دور از میز است');
    expect(help(fa)).toContain('«دور از میز» را انتخاب کرده گفتگوی تازه نمی‌گیرد');
    expect(help(en)).toContain('idle for less than 30 minutes');
    expect(help(en)).toContain('chose Away from desk gets no new chats');
    expect(help(tr)).toContain('boşta');
    expect(help(tr)).toContain('Masadan uzakta seçen operatöre yeni sohbet gelmez');
  });
});

describe('Team & departments: chats without a department', () => {
  it('reach every team member, in a department or not', () => {
    // The members are the ones "in a department or not", never the chats.
    expect(fa.teamDept.generalPoolNote).toContain('به همهٔ اعضای تیم می‌رسند، چه عضو دپارتمانی باشند چه نه');
    expect(fa.teamDept.generalPoolNote).not.toContain('چه دپارتمان داشته باشند');
    expect(tr.teamDept.generalPoolNote).toContain('bir departmanda olsun ya da olmasın, ekibin tüm üyelerine gider');
    expect(tr.teamDept.generalPoolNote).not.toContain('departmanı olsun olmasın');
    expect(en.teamDept.generalPoolNote).toContain('go to every team member, in a department or not');
  });
});
