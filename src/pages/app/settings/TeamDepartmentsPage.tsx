/**
 * Team & Departments — Customer-facing operations hub.
 *
 * This is the primary place a workspace owner manages everything related
 * to people who handle visitors:
 *
 *   • Section A — Departments (routing groups: Sales, Support, Demo…)
 *   • Section B — Team Members (customer-facing roles only)
 *   • Advanced — Fallback policy + routing diagnostics (collapsed)
 *
 * Internal/non-customer-facing roles (billing, SEO, analytics, developer,
 * marketing, viewer, admin) live on /settings/staff-access. The mental
 * model is intentionally split:
 *
 *   Team & Departments → who handles customers, where they get routed
 *   Staff Access       → who handles internal workspace work
 *
 * No backend logic is rewritten — this page composes the existing
 * workspace_departments / workspace_department_members tables and the
 * existing role/permission system.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Building2, Plus, Trash2, Users, MessageSquare, Phone, Video,
  Loader2, UserPlus, Crown,
  Mail, Search, Settings2, ArrowRight,
} from 'lucide-react';

import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { useTeamPresence, presenceMap } from '@/hooks/useTeamPresence';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { supabase } from '@/lib/supabase';
import {
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listDepartmentMembers, setDepartmentMembers,
  type Department,
} from '@/lib/workspace-departments-api';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/**
 * Customer-facing roles are stored in `workspace_members.role` but are
 * intentionally NOT exposed in this UI. Workspace owners think in terms of
 * "team members" and "departments" — not raw role taxonomy. The base role
 * (`agent`) is assigned silently when inviting from this page.
 *
 * Legacy role values (`team_lead`, `support_agent`, `sales_agent`) are
 * normalized to a single "customer-facing" pool for UI purposes — the owner
 * sees them as plain team members regardless of the historical role string
 * stored in the database.
 */
export const CUSTOMER_FACING_ROLES = [
  'agent',
  'team_lead',
  'support_agent',
  'sales_agent',
] as const;

/**
 * UI-only predicate. Owner is always treated as customer-facing because they
 * can answer chats/calls. All legacy customer-facing role values collapse
 * into this one bucket so the UX stays unified.
 */
export function isCustomerFacingRole(role: string | null | undefined): boolean {
  if (!role) return false;
  if (role === 'owner') return true;
  return (CUSTOMER_FACING_ROLES as readonly string[]).includes(role);
}

export default function TeamDepartmentsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const wsPath = useWorkspacePath();
  const wsId = workspace?.id;
  const qc = useQueryClient();

  /* ─── Departments ─── */
  const { data: departments = [], isLoading: loadingDepts } = useQuery({
    queryKey: ['workspace-departments', wsId],
    queryFn: () => listDepartments(wsId!),
    enabled: !!wsId,
  });

  const [showCreateDept, setShowCreateDept] = useState(false);
  const [editingDept, setEditingDept] = useState<Department | null>(null);
  const [membersFor, setMembersFor] = useState<Department | null>(null);

  const invalidateDepts = () => {
    qc.invalidateQueries({ queryKey: ['workspace-departments', wsId] });
    qc.invalidateQueries({ queryKey: ['ws-departments-overview', wsId] });
  };

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateDepartment(wsId!, id, { enabled }),
    onSuccess: invalidateDepts,
    onError: (e: Error) => toast.error(e.message),
  });

  const removeDept = useMutation({
    mutationFn: (id: string) => deleteDepartment(wsId!, id),
    onSuccess: () => { toast.success(t('teamDept.toastDeptDeleted')); invalidateDepts(); },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ─── Members (customer-facing only) ─── */
  const { data: allMembers = [], isLoading: loadingMembers } = useQuery({
    queryKey: ['ws-members', wsId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_members')
        .select('id, role, created_at, user_id')
        .eq('workspace_id', wsId!);
      if (error) throw error;
      if (!data) return [];
      const userIds = data.map((m: any) => m.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email, avatar_url')
        .in('id', userIds);
      return data.map((m: any) => ({
        ...m,
        profile: profiles?.find((p: any) => p.id === m.user_id),
      }));
    },
    enabled: !!wsId,
  });

  const customerMembers = useMemo(
    () => allMembers.filter((m: any) => isCustomerFacingRole(m.role)),
    [allMembers],
  );

  /* ─── Department assignments per user ─── */
  const { data: deptsData } = useQuery({
    queryKey: ['ws-departments-overview', wsId],
    queryFn: async () => {
      const [{ data: depts }, { data: assigns }] = await Promise.all([
        supabase.from('workspace_departments').select('id, name').eq('workspace_id', wsId!),
        supabase.from('workspace_department_members').select('user_id, department_id').eq('workspace_id', wsId!),
      ]);
      return { departments: depts ?? [], assignments: assigns ?? [] };
    },
    enabled: !!wsId,
  });

  const deptNameById = new Map<string, string>(
    (deptsData?.departments ?? []).map((d: any) => [d.id, d.name]),
  );
  const deptsByUser = new Map<string, string[]>();
  for (const a of deptsData?.assignments ?? []) {
    const list = deptsByUser.get(a.user_id) ?? [];
    const name = deptNameById.get(a.department_id);
    if (name) list.push(name);
    deptsByUser.set(a.user_id, list);
  }

  /* ─── Presence + filters ─── */
  const { data: presenceData } = useTeamPresence(wsId);
  const presenceByUser = presenceMap(presenceData?.presence);

  const [search, setSearch] = useState('');
  const visibleMembers = customerMembers.filter((m: any) =>
    !search ||
    m.profile?.full_name?.toLowerCase().includes(search.toLowerCase()) ||
    m.profile?.email?.toLowerCase().includes(search.toLowerCase()),
  );

  /* ─── Member actions ─── */
  const [editDeptsFor, setEditDeptsFor] = useState<{ userId: string; name: string } | null>(null);
  const [showInvite, setShowInvite] = useState(false);

  const removeMember = useMutation({
    mutationFn: async (memberId: string) => {
      const { error } = await supabase.from('workspace_members').delete().eq('id', memberId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(t('teamDept.toastMemberRemoved'));
      qc.invalidateQueries({ queryKey: ['ws-members', wsId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!workspace) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Users className="h-6 w-6" />
            {t('teamDept.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            {t('teamDept.subtitleBefore')}
            <Link to={wsPath('/settings/staff-access')} className="text-primary hover:underline">
              {t('teamDept.staffAccess')}
            </Link>.
          </p>
        </div>
      </div>

      {/* ═══════════ Section A — Departments ═══════════ */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              {t('teamDept.departments')}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('teamDept.departmentsHint')}
            </p>
          </div>
          <Button onClick={() => setShowCreateDept(true)} size="sm">
            <Plus className="h-4 w-4 me-2" /> {t('teamDept.newDepartment')}
          </Button>
        </div>

        <Card className="p-0 overflow-hidden border-border/60">
          {loadingDepts ? (
            <div className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" /></div>
          ) : departments.length === 0 ? (
            <div className="p-12 text-center">
              <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
                <Building2 className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="font-medium text-foreground">{t('teamDept.noDepartments')}</p>
              <p className="text-sm text-muted-foreground mt-1.5 mb-5 max-w-sm mx-auto">
                {t('teamDept.noDepartmentsHint')}
              </p>
              <Button variant="outline" onClick={() => setShowCreateDept(true)}>
                <Plus className="h-4 w-4 me-2" /> {t('teamDept.newDepartment')}
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {departments.map((d) => (
                <div key={d.id} className="p-4 flex items-center gap-4 hover:bg-muted/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground truncate">{d.name}</span>
                      {!d.enabled && <Badge variant="outline" className="text-[10px]">{t('teamDept.disabledBadge')}</Badge>}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      {d.chat_enabled && <span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" /> {t('teamDept.chLiveChat')}</span>}
                      {d.tickets_enabled && <span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" /> {t('teamDept.chTickets')}</span>}
                      {d.audio_enabled && <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {t('teamDept.chWidgetVoice')}</span>}
                      {d.video_enabled && <span className="flex items-center gap-1"><Video className="h-3 w-3" /> {t('teamDept.chWidgetVideo')}</span>}
                      {d.cc_voice_enabled && <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {t('teamDept.chCcVoice')}</span>}
                      {d.cc_video_enabled && <span className="flex items-center gap-1"><Video className="h-3 w-3" /> {t('teamDept.chCcVideo')}</span>}
                      {d.cc_callback_enabled && <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {t('teamDept.chCcCallback')}</span>}
                      {!d.chat_enabled && !d.tickets_enabled && !d.audio_enabled && !d.video_enabled
                        && !d.cc_voice_enabled && !d.cc_video_enabled && !d.cc_callback_enabled && (
                        <span className="italic">{t('teamDept.noChannels')}</span>
                      )}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setMembersFor(d)}>
                    <Users className="h-4 w-4 me-1" /> {t('teamDept.membersBtn')}
                  </Button>
                  <Switch
                    checked={d.enabled}
                    onCheckedChange={(v) => toggleEnabled.mutate({ id: d.id, enabled: v })}
                  />
                  <Button variant="ghost" size="sm" onClick={() => setEditingDept(d)}>{t('teamDept.editBtn')}</Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => { if (confirm(t('teamDept.deleteDeptConfirm', { name: d.name }))) removeDept.mutate(d.id); }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      {/* ═══════════ Section B — Team Members ═══════════ */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              {t('teamDept.teamMembers')}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('teamDept.teamMembersHint')}
            </p>
          </div>
          <Button onClick={() => setShowInvite(true)} size="sm">
            <UserPlus className="h-4 w-4 me-2" /> {t('teamDept.inviteMember')}
          </Button>
        </div>

        <Card className="overflow-hidden border-border/60">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div className="text-xs text-muted-foreground">
              {t('teamDept.memberCount', { count: String(customerMembers.length) })}
            </div>
            <div className="relative w-full max-w-xs">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('teamDept.searchPlaceholder')}
                className="ps-9 h-9 text-xs"
              />
            </div>
          </div>

          {loadingMembers ? (
            <div className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" /></div>
          ) : visibleMembers.length === 0 ? (
            <div className="py-12 text-center">
              {search ? (
                <p className="text-sm text-muted-foreground">{t('teamDept.noSearchResults')}</p>
              ) : (
                <>
                  <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
                    <UserPlus className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="font-medium text-foreground">{t('teamDept.noMembers')}</p>
                  <p className="text-sm text-muted-foreground mt-1.5 mb-5 max-w-sm mx-auto">
                    {t('teamDept.noMembersHint')}
                  </p>
                  <Button variant="outline" onClick={() => setShowInvite(true)}>
                    <UserPlus className="h-4 w-4 me-2" /> {t('teamDept.inviteMember')}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {visibleMembers.map((m: any) => {
                const isOwner = m.role === 'owner';
                const isCurrent = m.user_id === user?.id;
                const presence = presenceByUser.get(m.user_id);
                const isOnline = presence?.state === 'online';
                const userDepts = deptsByUser.get(m.user_id) ?? [];
                return (
                  <div key={m.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors">
                    <div className="relative shrink-0">
                      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                        {m.profile?.avatar_url ? (
                          <img
                            src={m.profile.avatar_url}
                            alt={m.profile?.full_name || m.profile?.email || ''}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <span className="text-sm font-semibold text-primary">
                            {(m.profile?.full_name || m.profile?.email || '?').charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span
                        aria-hidden
                        title={isOnline ? t('teamDept.online') : t('teamDept.offline')}
                        className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-background ${isOnline ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">
                          {m.profile?.full_name || '—'}
                        </span>
                        {isCurrent && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{t('teamDept.youBadge')}</Badge>}
                        {isOwner && <Crown className="w-3.5 h-3.5 text-amber-400" />}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{m.profile?.email}</p>
                    </div>

                    {/* Department membership */}
                    <button
                      type="button"
                      onClick={() => setEditDeptsFor({
                        userId: m.user_id,
                        name: m.profile?.full_name || m.profile?.email || 'member',
                      })}
                      title={userDepts.length ? userDepts.join(', ') : t('teamDept.noDeptTooltip')}
                      className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-border transition-colors max-w-[200px]"
                    >
                      <Building2 className="w-3 h-3 shrink-0" />
                      <span className="truncate">
                        {userDepts.length === 0
                          ? t('teamDept.generalPool')
                          : userDepts.length === 1
                            ? userDepts[0]
                            : `${userDepts[0]} +${userDepts.length - 1}`}
                      </span>
                    </button>

                    {!isOwner && !isCurrent && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <Settings2 className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => setEditDeptsFor({
                              userId: m.user_id,
                              name: m.profile?.full_name || m.profile?.email || 'member',
                            })}
                          >
                            <Building2 className="w-3.5 h-3.5 me-2" />
                            {t('teamDept.manageDepartments')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => removeMember.mutate(m.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="w-3.5 h-3.5 me-2" />
                            {t('teamDept.removeMember')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </section>

      {/* Pointer to Staff Access */}
      <Card className="p-4 border-border/60 bg-muted/20">
        <div className="flex items-start gap-3 text-sm">
          <ArrowRight className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-muted-foreground">
            <span className="text-foreground font-medium">{t('teamDept.pointerTitle')}</span>{' '}
            {t('teamDept.pointerTextBefore')}
            <Link to={wsPath('/settings/staff-access')} className="text-primary hover:underline">
              {t('teamDept.staffAccess')}
            </Link>.
          </div>
        </div>
      </Card>

      {/* Dialogs */}
      {showCreateDept && wsId && (
        <DepartmentDialog mode="create" workspaceId={wsId}
          onClose={() => setShowCreateDept(false)} onSaved={invalidateDepts} />
      )}
      {editingDept && wsId && (
        <DepartmentDialog mode="edit" department={editingDept} workspaceId={wsId}
          onClose={() => setEditingDept(null)} onSaved={invalidateDepts} />
      )}
      {membersFor && wsId && (
        <DeptMembersDialog department={membersFor} workspaceId={wsId}
          onClose={() => setMembersFor(null)} onSaved={invalidateDepts} />
      )}
      {editDeptsFor && wsId && (
        <MemberDepartmentsDialog
          workspaceId={wsId}
          memberUserId={editDeptsFor.userId}
          memberName={editDeptsFor.name}
          onClose={() => setEditDeptsFor(null)}
        />
      )}
      {showInvite && wsId && (
        <InviteMemberDialog
          workspaceId={wsId}
          workspaceName={workspace.name}
          inviterEmail={user?.email || ''}
          mode="customer"
          onClose={() => setShowInvite(false)}
        />
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* Helpers                                                       */
/* ──────────────────────────────────────────────────────────── */

function ToggleRow({
  label, checked, onChange, disabled,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className={`text-xs ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function DepartmentDialog({
  mode, department, workspaceId, onClose, onSaved,
}: {
  mode: 'create' | 'edit';
  department?: Department;
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: department?.name || '',
    enabled: department?.enabled ?? true,
    chat_enabled: department?.chat_enabled ?? true,
    audio_enabled: department?.audio_enabled ?? false,
    video_enabled: department?.video_enabled ?? false,
    sort_order: department?.sort_order ?? 0,
    tickets_enabled: department?.tickets_enabled ?? false,
    cc_voice_enabled: department?.cc_voice_enabled ?? false,
    cc_video_enabled: department?.cc_video_enabled ?? false,
    cc_callback_enabled: department?.cc_callback_enabled ?? false,
  });

  const save = useMutation({
    mutationFn: () => mode === 'create'
      ? createDepartment(workspaceId, form)
      : updateDepartment(workspaceId, department!.id, form),
    onSuccess: () => {
      toast.success(mode === 'create' ? t('teamDept.toastDeptCreated') : t('teamDept.toastDeptUpdated'));
      onSaved(); onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('teamDept.dlgNewDept') : t('teamDept.dlgEditDept')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('teamDept.fieldName')}</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('teamDept.namePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('teamDept.sortOrder')}</Label>
            <Input
              type="number"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) || 0 })}
            />
            <p className="text-[11px] text-muted-foreground">{t('teamDept.sortOrderHint')}</p>
          </div>
          <div className="space-y-2.5 rounded-md border border-border/60 bg-muted/20 p-3">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t('teamDept.grpMessaging')}</Label>
            <ToggleRow label={t('teamDept.chLiveChat')} checked={form.chat_enabled}
              onChange={(v) => setForm({ ...form, chat_enabled: v })} />
            <ToggleRow label={t('teamDept.chTickets')} checked={form.tickets_enabled}
              onChange={(v) => setForm({ ...form, tickets_enabled: v })} />
          </div>
          <div className="space-y-2.5 rounded-md border border-border/60 bg-muted/20 p-3">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t('teamDept.grpWidgetCalls')}</Label>
            <p className="text-[11px] text-muted-foreground -mt-1">
              {t('teamDept.grpWidgetCallsHint')}
            </p>
            <ToggleRow label={t('teamDept.tgWidgetVoice')} checked={form.audio_enabled}
              onChange={(v) => setForm({ ...form, audio_enabled: v })} />
            <ToggleRow label={t('teamDept.tgWidgetVideo')} checked={form.video_enabled}
              onChange={(v) => setForm({ ...form, video_enabled: v })} />
          </div>
          <div className="space-y-2.5 rounded-md border border-border/60 bg-muted/20 p-3">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t('teamDept.grpCallCenter')}</Label>
            <p className="text-[11px] text-muted-foreground -mt-1">
              {t('teamDept.grpCallCenterHint')}
            </p>
            <ToggleRow label={t('teamDept.tgCcVoice')} checked={form.cc_voice_enabled}
              onChange={(v) => setForm({ ...form, cc_voice_enabled: v })} />
            <ToggleRow label={t('teamDept.tgCcVideo')} checked={form.cc_video_enabled}
              onChange={(v) => setForm({ ...form, cc_video_enabled: v })} />
            <ToggleRow label={t('teamDept.tgCcCallback')} checked={form.cc_callback_enabled}
              onChange={(v) => setForm({ ...form, cc_callback_enabled: v })} />
          </div>
          <div className="rounded-md border border-border/60 p-3">
            <ToggleRow label={t('teamDept.deptEnabled')} checked={form.enabled}
              onChange={(v) => setForm({ ...form, enabled: v })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('teamDept.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={!form.name.trim() || save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />} {t('teamDept.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeptMembersDialog({
  department, workspaceId, onClose, onSaved,
}: {
  department: Department;
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { data: allWsMembers = [] } = useWorkspaceMembers(workspaceId);
  // Departments are customer-facing routing buckets, so the picker only
  // surfaces customer-facing members. Internal staff (billing, SEO,
  // analytics, developer, marketing, viewer, admin) live on Staff Access
  // and must never appear here.
  const members = useMemo(
    () => allWsMembers.filter((m) => isCustomerFacingRole(m.role)),
    [allWsMembers],
  );
  const { data: assigned = [] } = useQuery({
    queryKey: ['department-members', workspaceId, department.id],
    queryFn: () => listDepartmentMembers(workspaceId, department.id),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const sel = useMemo(() => selected ?? new Set(assigned), [selected, assigned]);

  const save = useMutation({
    mutationFn: () => setDepartmentMembers(workspaceId, department.id, Array.from(sel)),
    onSuccess: () => { toast.success(t('teamDept.toastMembersUpdated')); onSaved(); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (uid: string) => {
    const next = new Set<string>(sel);
    next.has(uid) ? next.delete(uid) : next.add(uid);
    setSelected(next);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('teamDept.dlgDeptMembersTitle', { name: department.name })}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2">
          {t('teamDept.dlgDeptMembersHint')}
        </p>
        <div className="space-y-1 max-h-[50vh] overflow-y-auto py-2">
          {members.length === 0 ? (
            <div className="text-center py-8">
              <Users className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
              <p className="text-sm font-medium text-foreground">{t('teamDept.noMembers')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('teamDept.dlgNoMembersHint')}
              </p>
            </div>
          ) : (
            members.map((m: any) => (
              <label key={m.user_id}
                className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/40 cursor-pointer">
                <Checkbox checked={sel.has(m.user_id)} onCheckedChange={() => toggle(m.user_id)} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">{m.full_name || m.email}</div>
                  <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                </div>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('teamDept.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />} {t('teamDept.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberDepartmentsDialog({
  workspaceId, memberUserId, memberName, onClose,
}: {
  workspaceId: string;
  memberUserId: string;
  memberName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: departments = [] } = useQuery({
    queryKey: ['ws-departments-list', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_departments')
        .select('id, name, enabled')
        .eq('workspace_id', workspaceId)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: assignedIds = [] as string[] } = useQuery<string[]>({
    queryKey: ['ws-department-member-assignments', workspaceId, memberUserId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_department_members')
        .select('department_id')
        .eq('workspace_id', workspaceId)
        .eq('user_id', memberUserId);
      if (error) throw error;
      return (data ?? []).map((r: any) => r.department_id);
    },
  });

  const [draft, setDraft] = useState<Set<string> | null>(null);
  const sel = useMemo<Set<string>>(
    () => draft ?? new Set<string>(assignedIds),
    [draft, assignedIds],
  );

  const save = useMutation({
    mutationFn: async () => {
      const current = new Set(assignedIds);
      const next = sel;
      const toAdd = [...next].filter(id => !current.has(id));
      const toRemove = [...current].filter(id => !next.has(id));
      if (toAdd.length) {
        const { error } = await supabase.from('workspace_department_members').insert(
          toAdd.map(department_id => ({ workspace_id: workspaceId, department_id, user_id: memberUserId })),
        );
        if (error) throw error;
      }
      if (toRemove.length) {
        const { error } = await supabase.from('workspace_department_members')
          .delete()
          .eq('workspace_id', workspaceId)
          .eq('user_id', memberUserId)
          .in('department_id', toRemove);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(t('teamDept.toastDeptsUpdated'));
      queryClient.invalidateQueries({ queryKey: ['ws-departments-overview', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['ws-department-member-assignments', workspaceId, memberUserId] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (id: string) => {
    const next = new Set<string>(sel);
    next.has(id) ? next.delete(id) : next.add(id);
    setDraft(next);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('teamDept.dlgAssignDepts', { name: memberName })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1 max-h-[50vh] overflow-y-auto py-2">
          {departments.length === 0 ? (
            <div className="text-center py-8">
              <Building2 className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
              <p className="text-sm font-medium text-foreground">{t('teamDept.noDepartments')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('teamDept.dlgNoDeptsHint')}
              </p>
            </div>
          ) : (
            departments.map((d: any) => (
              <label key={d.id}
                className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/40 cursor-pointer">
                <Checkbox checked={sel.has(d.id)} onCheckedChange={() => toggle(d.id)} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">{d.name}</div>
                  {!d.enabled && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">{t('teamDept.disabledBadge')}</div>
                  )}
                </div>
              </label>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground border-t border-border/60 pt-3">
          {t('teamDept.generalPoolNote')}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('teamDept.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />} {t('teamDept.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Shared invite dialog (also used by Staff Access) */

/**
 * Hardened default for customer-facing invites. Workspace owners never see or
 * choose a role from Team & Departments — every customer-facing member is
 * created with this single base operator role. Department membership is the
 * only visible concept. Do not replace this with `roles[0]`-style indexing.
 */
export const DEFAULT_CUSTOMER_FACING_ROLE = 'agent' as const;

const STAFF_INVITE_ROLES = ['admin', 'marketing_manager', 'seo_manager', 'analyst', 'developer', 'billing', 'viewer'];

export function InviteMemberDialog({
  workspaceId, workspaceName, inviterEmail, mode, onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  inviterEmail: string;
  mode: 'customer' | 'staff';
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // Customer-facing members all share one base operator role
  // (DEFAULT_CUSTOMER_FACING_ROLE). The raw role taxonomy is intentionally
  // hidden from workspace owners — they only think in terms of "team members"
  // and "departments". Staff Access keeps the role selector because internal
  // permission bundles are the correct mental model there.
  const staffRoles = STAFF_INVITE_ROLES;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(
    mode === 'customer' ? DEFAULT_CUSTOMER_FACING_ROLE : staffRoles[0],
  );
  const [link, setLink] = useState('');
  const API_BASE = import.meta.env.VITE_API_BASE_URL;

  const create = useMutation({
    mutationFn: async () => {
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      const { data, error } = await supabase
        .from('workspace_invitations')
        .insert({
          workspace_id: workspaceId,
          role: role as any,
          created_by: user!.id,
          max_uses: 0,
          invited_email: email.trim() || null,
          expires_at: expiresAt,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async (inv: any) => {
      const url = `${window.location.origin}/auth/invite?token=${inv.token}`;
      setLink(url);
      navigator.clipboard.writeText(url);
      toast.success(t('teamDept.toastInviteCopied'));
      queryClient.invalidateQueries({ queryKey: ['ws-invitations', workspaceId] });
      // Best-effort email
      if (email.trim() && API_BASE) {
        try {
          const { data: sessionData } = await supabase.auth.getSession();
          const accessToken = sessionData.session?.access_token || '';
          await fetch(`${API_BASE}/api/email/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({
              workspaceId, to: email.trim(),
              subject: `You've been invited to ${workspaceName}`,
              html: `<p><strong>${inviterEmail}</strong> invited you to <strong>${workspaceName}</strong> as <strong>${role}</strong>.</p><p><a href="${url}">Accept invitation</a></p>`,
            }),
          });
        } catch (e) { console.warn('[invite] email send failed', e); }
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'customer' ? t('teamDept.dlgInviteTeam') : t('teamDept.dlgInviteStaff')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('teamDept.emailOptional')}</Label>
            <Input type="email" value={email} dir="ltr"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="text-left text-xs" />
            <p className="text-[11px] text-muted-foreground">
              {t('teamDept.emailHint')}
            </p>
          </div>
          {mode === 'staff' ? (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('teamDept.internalAccess')}</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {staffRoles.map(r => (
                    <SelectItem key={r} value={r}>
                      {r.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-[11px] text-muted-foreground leading-relaxed">
              {t('teamDept.customerInviteNote')}
            </div>
          )}
          {link && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-1.5">
              <p className="text-xs font-medium text-foreground">{t('teamDept.inviteLinkCopiedTitle')}</p>
              <Input value={link} readOnly dir="ltr" className="font-mono text-[11px]" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('teamDept.close')}</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending
              ? <Loader2 className="h-4 w-4 me-2 animate-spin" />
              : <Mail className="h-4 w-4 me-2" />}
            {link ? t('teamDept.generateAnother') : t('teamDept.generateInvite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}