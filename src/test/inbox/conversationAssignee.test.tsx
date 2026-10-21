/**
 * The Inbox's transfer picker (ConversationAssignee), rendered: what each
 * role is offered, who is listed, and which route each choice calls.
 *
 * It replaced a Select of every workspace member that any member could use
 * on any conversation (staff and suspended members listed, no presence, no
 * department, no conflict handling).
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastSpy }));

const fixtures = vi.hoisted(() => ({
  members: [] as unknown[],
  presence: [] as unknown[],
  departments: [] as unknown[],
}));
vi.mock('@/hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => ({ data: fixtures.members, isLoading: false }),
}));
vi.mock('@/hooks/useTeamPresence', () => ({
  useTeamPresence: () => ({ data: { presence: fixtures.presence } }),
}));
vi.mock('@/hooks/useInboxDepartments', () => ({
  useInboxDepartments: () => ({ data: fixtures.departments }),
}));

const { ConversationAssignee } = await import('@/components/inbox/ConversationAssignee');
const { conversationsApi, AssignmentError } = await import('@/lib/conversations-api');

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const t = (key: string, vars?: Record<string, string>) => (vars ? `${key}${JSON.stringify(vars)}` : key);

function draw(props: { assignedTo: string | null; viewerId: string; viewerRole: string; departmentId?: string | null }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const view = render(
    <QueryClientProvider client={qc}>
      <ConversationAssignee
        workspaceId={WS}
        conversationId={CONV}
        assignedTo={props.assignedTo}
        departmentId={props.departmentId ?? null}
        departmentName={null}
        viewerId={props.viewerId}
        viewerRole={props.viewerRole}
        t={t}
        dir="ltr"
      />
    </QueryClientProvider>,
  );
  return { ...view, qc, invalidate };
}

const picker = () => document.querySelector('[data-inbox="transfer-picker"]') as HTMLElement | null;
const option = (key: string) => document.querySelector(`[data-transfer="${key}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  toastSpy.mockReset();
  fixtures.members = [
    { user_id: 'lead', role: 'team_lead', full_name: 'Lena Lead', email: null, department_names: ['Sales'] },
    { user_id: 'amy', role: 'support_agent', full_name: 'Amy', email: null, department_names: ['Support'] },
    { user_id: 'zed', role: 'agent', full_name: 'Zed', email: null },
    { user_id: 'bill', role: 'billing', full_name: 'Bill Billing', email: null },
    { user_id: 'gone', role: 'agent', full_name: 'Gone Away', email: null, suspended_at: '2026-10-01T00:00:00Z' },
  ];
  fixtures.presence = [
    { user_id: 'zed', state: 'online', presence_state: 'active', reason: '' },
    { user_id: 'amy', state: 'online', presence_state: 'away', reason: '' },
  ];
  fixtures.departments = [
    { id: 'd-sales', name: 'Sales', enabled: true, chat_enabled: true, member_ids: ['lead'] },
    { id: 'd-support', name: 'Support', enabled: true, chat_enabled: true, member_ids: ['amy', 'zed'] },
    { id: 'd-calls', name: 'Calls', enabled: true, chat_enabled: false, member_ids: ['zed'] },
  ];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a team lead on a colleague\'s conversation', () => {
  it('lists operators with presence and departments, never staff or a suspended member', () => {
    draw({ assignedTo: 'amy', viewerId: 'lead', viewerRole: 'team_lead' });
    expect(screen.getByText('Amy')).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-inbox="transfer-toggle"]')!);
    const list = picker()!;
    expect(option('me')).not.toBeNull();
    expect(option('user:zed')).not.toBeNull();
    expect(option('user:amy')!.disabled).toBe(true); // already hers
    expect(option('user:bill')).toBeNull();
    expect(option('user:gone')).toBeNull();
    // The viewer is offered as "Assign to me", not twice.
    expect(option('user:lead')).toBeNull();
    // At their desk first.
    const order = [...list.querySelectorAll('[data-transfer^="user:"]')].map((el) => el.getAttribute('data-transfer'));
    expect(order).toEqual(['user:zed', 'user:amy']);
    expect(within(option('user:amy')!).getByText('Support')).toBeInTheDocument();
    // Chat departments only, with who is connected.
    expect(option('department:d-calls')).toBeNull();
    expect(within(option('department:d-support')!).getByText('inbox.transferDepartmentOnline{"count":"2"}')).toBeInTheDocument();
    expect(option('unassign')).not.toBeNull();
  });

  it('hands it to an operator through the transfer route', async () => {
    const transfer = vi.spyOn(conversationsApi, 'transfer').mockResolvedValue({});
    const { invalidate } = draw({ assignedTo: 'amy', viewerId: 'lead', viewerRole: 'team_lead' });
    fireEvent.click(document.querySelector('[data-inbox="transfer-toggle"]')!);
    fireEvent.click(option('user:zed')!);
    await waitFor(() => expect(transfer).toHaveBeenCalledWith({ workspace_id: WS, conversation_id: CONV, user_id: 'zed' }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: 'inbox.transferDone{"name":"Zed"}' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations', WS] });
    expect(picker()).toBeNull();
  });

  it('hands it to a department, for routing to pick the operator', async () => {
    const transfer = vi.spyOn(conversationsApi, 'transfer').mockResolvedValue({});
    draw({ assignedTo: 'amy', viewerId: 'lead', viewerRole: 'team_lead' });
    fireEvent.click(document.querySelector('[data-inbox="transfer-toggle"]')!);
    fireEvent.click(option('department:d-sales')!);
    await waitFor(() => expect(transfer).toHaveBeenCalledWith({ workspace_id: WS, conversation_id: CONV, department_id: 'd-sales' }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: 'inbox.transferToDepartmentDone{"name":"Sales"}' }));
  });

  it('says so when somebody else changed it meanwhile (409), and reads the list again', async () => {
    vi.spyOn(conversationsApi, 'transfer').mockRejectedValue(new AssignmentError('assignment_changed', 409, 'zed'));
    const { invalidate } = draw({ assignedTo: 'amy', viewerId: 'lead', viewerRole: 'team_lead' });
    fireEvent.click(document.querySelector('[data-inbox="transfer-toggle"]')!);
    fireEvent.click(option('user:zed')!);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: 'inbox.assignmentChanged', variant: 'destructive' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations', WS] });
  });

  it('sends it back to the queue, telling the server whose it was', async () => {
    const patch = vi.spyOn(conversationsApi, 'patchConversation').mockResolvedValue({
      ok: true,
      conversation: { id: CONV, workspace_id: WS, status: 'open', priority: 'normal', assigned_to: null, tags: [], updated_at: '' },
    });
    draw({ assignedTo: 'amy', viewerId: 'lead', viewerRole: 'team_lead' });
    fireEvent.click(document.querySelector('[data-inbox="transfer-toggle"]')!);
    fireEvent.click(option('unassign')!);
    await waitFor(() => expect(patch).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: WS, conversation_id: CONV, assigned_to: null, expected_assigned_to: 'amy',
    })));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: 'inbox.unassignedDone' }));
  });
});

describe('an operator of the team', () => {
  it('takes an unassigned conversation with the atomic claim, and is offered nothing else', async () => {
    const claim = vi.spyOn(conversationsApi, 'claim').mockResolvedValue({ assigned_to: 'zed' });
    const transfer = vi.spyOn(conversationsApi, 'transfer');
    draw({ assignedTo: null, viewerId: 'zed', viewerRole: 'agent' });
    fireEvent.click(document.querySelector('[data-inbox="transfer-toggle"]')!);
    expect(document.querySelectorAll('[data-transfer^="user:"], [data-transfer^="department:"], [data-transfer="unassign"]')).toHaveLength(0);
    fireEvent.click(option('me')!);
    await waitFor(() => expect(claim).toHaveBeenCalledWith({ workspace_id: WS, conversation_id: CONV }));
    expect(transfer).not.toHaveBeenCalled();
  });

  it('hands on their own conversation to a colleague or a department', () => {
    draw({ assignedTo: 'zed', viewerId: 'zed', viewerRole: 'agent' });
    fireEvent.click(document.querySelector('[data-inbox="transfer-toggle"]')!);
    expect(option('me')).toBeNull();
    expect(option('user:amy')).not.toBeNull();
    expect(option('department:d-sales')).not.toBeNull();
    expect(option('unassign')).not.toBeNull();
  });

  it('cannot move a colleague\'s conversation, and is told who can', () => {
    draw({ assignedTo: 'amy', viewerId: 'zed', viewerRole: 'agent' });
    expect(document.querySelector('[data-inbox="transfer-toggle"]')).toBeNull();
    expect(document.querySelector('[data-inbox="transfer-not-allowed"]')!.textContent).toBe('inbox.transferNotAllowed');
  });

  it('is told the department the visitor chose', () => {
    draw({ assignedTo: 'zed', viewerId: 'zed', viewerRole: 'agent', departmentId: 'd-support' });
    expect(document.querySelector('[data-inbox="assignee-department"]')!.textContent).toBe('inbox.department: Support');
  });
});
