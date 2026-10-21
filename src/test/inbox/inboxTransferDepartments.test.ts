/**
 * The transfer picker's lists and the Inbox's department badge and filter.
 *
 * The old "Assignee" list was every member in server order, staff and
 * suspended members included, with nothing to say who was at their desk;
 * there was no "send to a department"; and a conversation's department was
 * nowhere in the Inbox, so Sales and Support shared one undifferentiated list.
 */
import { describe, expect, it } from 'vitest';
import {
  departmentTargets, matchesTransferQuery, operatorDot, transferCandidates, type TransferMember,
} from '@/lib/inboxTransfer';
import {
  departmentFilterOptions, departmentNameOf, matchesDepartmentFilter, NO_DEPARTMENT,
} from '@/lib/inboxDepartments';
import type { OperatorPresence } from '@/lib/availability-api';
import type { InboxDepartment } from '@/lib/workspace-departments-api';

const member = (user_id: string, role: string, extra: Partial<TransferMember> = {}): TransferMember => ({
  user_id, role, full_name: user_id.toUpperCase(), email: `${user_id}@example.com`, ...extra,
});
const here = (user_id: string, presence_state: OperatorPresence['presence_state']): OperatorPresence => ({
  user_id, state: presence_state === 'active' ? 'online' : 'offline', presence_state, reason: '',
});

const MEMBERS: TransferMember[] = [
  member('zed', 'agent'),
  member('amy', 'support_agent', { department_names: ['Support'] }),
  member('owner', 'owner'),
  member('lead', 'team_lead', { department_names: ['Sales', 'Support'] }),
  member('billing', 'billing'),
  member('seo', 'seo_manager'),
  member('admin', 'admin'),
  member('gone', 'agent', { suspended_at: '2026-10-01T00:00:00Z' }),
  member('paused', 'sales_agent', { seat_locked: true }),
];
const PRESENCE = [here('zed', 'away'), here('lead', 'active'), here('billing', 'active'), here('gone', 'active')];

describe('operators in the picker', () => {
  it('are the owner and the chat team only: no staff, no suspended member, no paused seat', () => {
    const ids = transferCandidates(MEMBERS, PRESENCE, {}).map((c) => c.userId);
    expect(ids.sort()).toEqual(['amy', 'lead', 'owner', 'zed']);
  });

  it('come at their desk first, then away, then the rest by name', () => {
    expect(transferCandidates(MEMBERS, PRESENCE, {}).map((c) => [c.userId, c.presence])).toEqual([
      ['lead', 'online'],
      ['zed', 'idle'],
      ['amy', 'offline'],
      ['owner', 'offline'],
    ]);
  });

  it('carry their departments, and say who is looking and who has it', () => {
    const list = transferCandidates(MEMBERS, PRESENCE, { viewerId: 'amy', assignedTo: 'zed' });
    expect(list.find((c) => c.userId === 'lead')?.departments).toEqual(['Sales', 'Support']);
    expect(list.find((c) => c.userId === 'amy')?.isViewer).toBe(true);
    expect(list.find((c) => c.userId === 'zed')?.isCurrent).toBe(true);
    expect(list.filter((c) => c.isCurrent || c.isViewer)).toHaveLength(2);
  });

  it('read presence from the teammate-facing state, and from an older server too', () => {
    expect(operatorDot({ state: 'online', presence_state: 'active' })).toBe('online');
    expect(operatorDot({ state: 'online', presence_state: 'away' })).toBe('idle');
    expect(operatorDot({ state: 'online', presence_state: 'disconnected' })).toBe('offline');
    expect(operatorDot({ state: 'online' })).toBe('online');
    expect(operatorDot(undefined)).toBe('offline');
  });

  it('are found by name or department, whatever the case and accents', () => {
    expect(matchesTransferQuery('sup', 'Amy', 'Support')).toBe(true);
    expect(matchesTransferQuery('ZÉD', 'zed')).toBe(true);
    expect(matchesTransferQuery('', 'anything')).toBe(true);
    expect(matchesTransferQuery('sales', 'Amy', 'Support')).toBe(false);
  });
});

describe('departments in the picker', () => {
  const DIRECTORY: InboxDepartment[] = [
    { id: 'd-sales', name: 'Sales', enabled: true, chat_enabled: true, member_ids: ['lead', 'paused'] },
    { id: 'd-support', name: 'Support', enabled: true, chat_enabled: true, member_ids: ['amy', 'lead', 'zed', 'billing', 'gone'] },
    { id: 'd-calls', name: 'Calls only', enabled: true, chat_enabled: false, member_ids: ['zed'] },
    { id: 'd-off', name: 'Old', enabled: false, chat_enabled: true, member_ids: ['zed'] },
  ];

  it('are the enabled chat departments, each with how many of its operators are connected', () => {
    expect(departmentTargets(DIRECTORY, MEMBERS, PRESENCE, 'd-support')).toEqual([
      // The paused seat does not count.
      { id: 'd-sales', name: 'Sales', onlineCount: 1, isCurrent: false },
      // Staff and suspended members do not count; away does.
      { id: 'd-support', name: 'Support', onlineCount: 2, isCurrent: true },
    ]);
  });

  it('are none when the directory could not be read', () => {
    expect(departmentTargets(undefined, MEMBERS, PRESENCE)).toEqual([]);
  });
});

describe('the department of a conversation in the list', () => {
  const byId = new Map([['d-sales', 'Sales']]);

  it('is its own name, else the directory\'s, else nothing', () => {
    expect(departmentNameOf({ department_id: 'd-sales', department_name: 'Ventas' }, byId)).toBe('Ventas');
    expect(departmentNameOf({ department_id: 'd-sales', department_name: null }, byId)).toBe('Sales');
    expect(departmentNameOf({ department_id: null, department_name: 'Stray' }, byId)).toBeNull();
    // A server that does not send departments yet.
    expect(departmentNameOf({}, byId)).toBeNull();
  });

  it('narrows the list to one department, or to the conversations with none', () => {
    const rows = [{ id: 1, department_id: 'd-sales' }, { id: 2, department_id: null }, { id: 3 }];
    const pick = (f: string | null) => rows.filter((r) => matchesDepartmentFilter(r, f)).map((r) => r.id);
    expect(pick(null)).toEqual([1, 2, 3]);
    expect(pick('d-sales')).toEqual([1]);
    expect(pick(NO_DEPARTMENT)).toEqual([2, 3]);
    expect(pick('d-unknown')).toEqual([]);
  });

  it('is offered in the filter for every department, and for one only a conversation still names', () => {
    const directory: InboxDepartment[] = [
      { id: 'd-sales', name: 'Sales', enabled: true, chat_enabled: true, member_ids: [] },
      { id: 'd-old', name: 'Old', enabled: false, chat_enabled: true, member_ids: [] },
    ];
    const rows = [
      { department_id: 'd-sales', department_name: 'Sales' },
      { department_id: 'd-gone', department_name: 'Removed since' },
      { department_id: null },
    ];
    expect(departmentFilterOptions(directory, rows)).toEqual([
      { id: 'd-sales', name: 'Sales' },
      { id: 'd-old', name: 'Old' },
      { id: 'd-gone', name: 'Removed since' },
    ]);
    expect(departmentFilterOptions(undefined, undefined)).toEqual([]);
  });
});
