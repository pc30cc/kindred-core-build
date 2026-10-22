/**
 * Who has the conversation, and the transfer picker.
 *
 * Lives in the Inbox sidebar's Details card (ConversationActionPanel). The
 * picker lists, in this order:
 *   - "Assign to me", when this operator may take it;
 *   - operators: the owner and the chat team only, never staff or a
 *     suspended member, each with presence and departments (inboxTransfer.ts);
 *   - departments: the enabled chat departments, with how many of their
 *     operators are online — routing then picks the operator there;
 *   - "Unassign", which sends it back to the queue (and routing).
 * What is offered follows the role (inboxAccess.ts: supervisors move anyone's
 * conversation, everyone else takes an unassigned one or hands on their own);
 * the server enforces the same rules and answers 409 when someone else
 * changed the assignment since this panel read it.
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Building2, Check, Loader2, Search, UserCheck, UserMinus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { useTeamPresence } from '@/hooks/useTeamPresence';
import { useInboxDepartments } from '@/hooks/useInboxDepartments';
import { useUpdateConversation } from '@/hooks/useConversations';
import { AssignmentError, conversationsApi } from '@/lib/conversations-api';
import { assignmentActions } from '@/lib/inboxAccess';
import {
  departmentTargets, matchesTransferQuery, memberName, operatorDot, transferCandidates,
} from '@/lib/inboxTransfer';
import { PresenceDot } from '@/components/inbox/PresenceIndicator';

type T = (key: string, vars?: Record<string, string>) => string;

interface Props {
  workspaceId: string;
  conversationId: string;
  assignedTo: string | null;
  departmentId?: string | null;
  departmentName?: string | null;
  viewerId: string | null | undefined;
  viewerRole: string | null | undefined;
  t: T;
  dir: 'ltr' | 'rtl';
  locale?: string;
}

/** The message a refused assignment change shows. */
export function assignmentErrorText(err: unknown, t: T): string {
  if (err instanceof AssignmentError) {
    if (err.conflict) return t('inbox.assignmentChanged');
    if (err.code === 'not_allowed' || err.code === 'inbox_not_allowed') return t('inbox.transferNotAllowed');
    if (err.status === 400) return t('inbox.transferInvalidTarget');
  }
  return t('inbox.transferFailed');
}

export function ConversationAssignee({
  workspaceId, conversationId, assignedTo, departmentId, departmentName,
  viewerId, viewerRole, t, dir, locale,
}: Props) {
  const qc = useQueryClient();
  const { data: members = [], isLoading: membersLoading } = useWorkspaceMembers(workspaceId);
  const { data: team } = useTeamPresence(workspaceId);
  const { data: departments } = useInboxDepartments(workspaceId);
  const updateConv = useUpdateConversation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const actions = assignmentActions(viewerRole, viewerId, assignedTo);
  const canAct = actions.take || actions.transfer || actions.unassign;
  const presence = team?.presence;

  const assignee = useMemo(() => {
    if (!assignedTo) return null;
    const m = members.find((x) => x.user_id === assignedTo);
    return {
      name: m ? memberName(m) : assignedTo.slice(0, 8),
      dot: operatorDot(presence?.find((p) => p.user_id === assignedTo)),
    };
  }, [assignedTo, members, presence]);

  const operators = useMemo(
    () => transferCandidates(members, presence, { viewerId, assignedTo, locale })
      .filter((c) => !(actions.take && c.isViewer))
      .filter((c) => matchesTransferQuery(query, c.name, ...c.departments)),
    [members, presence, viewerId, assignedTo, locale, actions.take, query],
  );
  const depts = useMemo(
    () => departmentTargets(departments, members, presence, departmentId)
      .filter((d) => matchesTransferQuery(query, d.name)),
    [departments, members, presence, departmentId, query],
  );
  const currentDepartment = departmentName
    ?? (departmentId ? departments?.find((d) => d.id === departmentId)?.name ?? null : null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
    void qc.invalidateQueries({ queryKey: ['inbox-counts', workspaceId] });
    void qc.invalidateQueries({ queryKey: ['inbox-tab-counts', workspaceId] });
    void qc.invalidateQueries({ queryKey: ['conversation-timeline', conversationId, workspaceId] });
    void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
  };

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      toast({ title: done });
      setOpen(false);
      setQuery('');
    } catch (err) {
      toast({ title: assignmentErrorText(err, t), variant: 'destructive' });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const assignToMe = () => {
    if (!viewerId) return;
    const me = members.find((m) => m.user_id === viewerId);
    const done = t('inbox.transferDone', { name: me ? memberName(me) : t('inbox.you') });
    // Unassigned: the atomic claim (409 when somebody was quicker).
    if (!assignedTo) return run(() => conversationsApi.claim({ workspace_id: workspaceId, conversation_id: conversationId }), done);
    return run(() => conversationsApi.transfer({
      workspace_id: workspaceId, conversation_id: conversationId, user_id: viewerId, expected_assigned_to: assignedTo,
    }), done);
  };
  const toOperator = (userId: string, name: string) =>
    run(
      () => conversationsApi.transfer({
        workspace_id: workspaceId, conversation_id: conversationId, user_id: userId, expected_assigned_to: assignedTo,
      }),
      t('inbox.transferDone', { name }),
    );
  const toDepartment = (id: string, name: string) =>
    run(
      () => conversationsApi.transfer({
        workspace_id: workspaceId, conversation_id: conversationId, department_id: id, expected_assigned_to: assignedTo,
      }),
      t('inbox.transferToDepartmentDone', { name }),
    );
  const unassign = () =>
    run(
      () => updateConv.mutateAsync({
        id: conversationId,
        workspace_id: workspaceId,
        assigned_to: null,
        expected_assigned_to: assignedTo,
      }),
      t('inbox.unassignedDone'),
    );

  const nothingFound = open && actions.transfer && !operators.length && !depts.length && !!query.trim();

  return (
    <div data-inbox="assignee" className="px-3 py-2 space-y-1.5" dir={dir}>
      <span className="text-[10px] text-muted-foreground">{t('inbox.assignee') || 'Assignee'}</span>
      <div className="flex items-center gap-1.5">
        <div data-inbox="assignee-current" className="flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px] font-medium text-foreground">
          {assignee ? (
            <>
              <PresenceDot state={assignee.dot} size={8} />
              <span className="truncate">{assignee.name}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{t('inbox.unassigned') || 'Unassigned'}</span>
          )}
        </div>
        {canAct && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-inbox="transfer-toggle"
            aria-expanded={open}
            className="h-7 shrink-0 gap-1 px-2 text-[11px]"
            disabled={busy || membersLoading}
            onClick={() => setOpen((v) => !v)}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowLeftRight className="h-3 w-3" />}
            {t('inbox.transfer')}
          </Button>
        )}
      </div>
      {currentDepartment && (
        <div data-inbox="assignee-department" className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
          <Building2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{t('inbox.department')}: {currentDepartment}</span>
        </div>
      )}
      {!canAct && assignedTo && assignedTo !== viewerId && (
        <p data-inbox="transfer-not-allowed" className="text-[10.5px] leading-snug text-muted-foreground">
          {t('inbox.transferNotAllowed')}
        </p>
      )}

      {open && canAct && (
        <div data-inbox="transfer-picker" className="mt-1 space-y-1.5 rounded-lg border border-border/60 bg-background/60 p-1.5">
          {actions.transfer && (
            <div className="relative">
              <Search className="pointer-events-none absolute start-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('inbox.transferSearch')}
                aria-label={t('inbox.transferSearch')}
                className="h-7 ps-6 text-[11px]"
                dir={dir}
              />
            </div>
          )}

          {actions.take && (
            <PickerItem dataKey="me" disabled={busy} onClick={assignToMe}>
              <UserCheck className="h-3.5 w-3.5 text-primary" />
              <span className="flex-1 truncate font-semibold">{t('inbox.transferToMe')}</span>
            </PickerItem>
          )}

          {actions.transfer && operators.length > 0 && (
            <PickerGroup label={t('inbox.transferOperators')} icon={Users}>
              {operators.map((c) => (
                <PickerItem
                  key={c.userId}
                  dataKey={`user:${c.userId}`}
                  disabled={busy || c.isCurrent}
                  onClick={() => toOperator(c.userId, c.name)}
                >
                  <PresenceDot
                    state={c.presence}
                    size={8}
                    title={c.presence === 'online' ? t('inbox.online')
                      : c.presence === 'idle' ? t(c.manualAway ? 'inbox.operatorAway' : 'inbox.operatorIdle') : t('inbox.offline')}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {c.name}{c.isViewer ? ` (${t('inbox.you')})` : ''}
                    </span>
                    {c.departments.length > 0 && (
                      <span className="block truncate text-[10px] text-muted-foreground">{c.departments.join(dir === 'rtl' ? '، ' : ', ')}</span>
                    )}
                  </span>
                  {c.isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </PickerItem>
              ))}
            </PickerGroup>
          )}

          {actions.transfer && depts.length > 0 && (
            <PickerGroup label={t('inbox.transferDepartments')} icon={Building2}>
              {depts.map((d) => (
                <PickerItem
                  key={d.id}
                  dataKey={`department:${d.id}`}
                  disabled={busy}
                  onClick={() => toDepartment(d.id, d.name)}
                  title={t('inbox.transferDepartmentHint')}
                >
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <span className={cn('shrink-0 text-[10px]', d.onlineCount > 0 ? 'text-success' : 'text-muted-foreground')}>
                    {t('inbox.transferDepartmentOnline', { count: String(d.onlineCount) })}
                  </span>
                  {d.isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </PickerItem>
              ))}
            </PickerGroup>
          )}

          {nothingFound && (
            <p className="px-1.5 py-1 text-[10.5px] text-muted-foreground">{t('inbox.transferNoResults')}</p>
          )}

          {actions.unassign && (
            <PickerItem dataKey="unassign" disabled={busy} onClick={unassign}>
              <UserMinus className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">{t('inbox.transferUnassign')}</span>
            </PickerItem>
          )}
        </div>
      )}
    </div>
  );
}

function PickerGroup({ label, icon: Icon, children }: { label: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="space-y-0.5">
      <div className="flex items-center gap-1 px-1.5 pt-1 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      {children}
    </div>
  );
}

function PickerItem({ dataKey, disabled, onClick, title, children }: {
  dataKey: string;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-transfer={dataKey}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[11.5px] text-foreground transition-colors hover:bg-secondary/70 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
