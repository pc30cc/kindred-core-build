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
  Loader2, AlertCircle, CheckCircle2, Eye, UserPlus, Crown,
  ChevronDown, ChevronRight, Mail, Search, Settings2, ArrowRight,
} from 'lucide-react';

import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeamPresence, presenceMap } from '@/hooks/useTeamPresence';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { supabase } from '@/lib/supabase';
import {
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listDepartmentMembers, setDepartmentMembers,
  getFallbackPolicy, updateFallbackPolicy, getDepartmentDiagnostics,
  type Department, type DepartmentChannel,
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
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';

/**
 * Customer-facing roles. The same role identifiers are still stored in
 * `workspace_members.role` — we just group them visually so this page only
 * surfaces the people who interact with visitors.
 */
const CUSTOMER_FACING_ROLES = [
  'agent',
  'team_lead',
  'support_agent',
  'sales_agent',
] as const;

const ROLE_BADGE: Record<string, string> = {
  owner: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  team_lead: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  agent: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  sales_agent: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  support_agent: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
};

const ROLE_LABEL: Record<string, string> = {
  team_lead: 'Team Lead',
  agent: 'Agent',
  support_agent: 'Support Agent',
  sales_agent: 'Sales Agent',
  owner: 'Owner',
};

function roleLabel(r: string) {
  return ROLE_LABEL[r] ?? r;
}

export default function TeamDepartmentsPage() {
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
    qc.invalidateQueries({ queryKey: ['workspace-departments-diag', wsId] });
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
    onSuccess: () => { toast.success('Department deleted'); invalidateDepts(); },
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
    () => allMembers.filter((m: any) =>
      m.role === 'owner' || (CUSTOMER_FACING_ROLES as readonly string[]).includes(m.role),
    ),
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

  const updateMemberRole = useMutation({
    mutationFn: async ({ memberId, newRole }: { memberId: string; newRole: string }) => {
      const { error } = await supabase
        .from('workspace_members')
        .update({ role: newRole as any })
        .eq('id', memberId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Role updated');
      qc.invalidateQueries({ queryKey: ['ws-members', wsId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMember = useMutation({
    mutationFn: async (memberId: string) => {
      const { error } = await supabase.from('workspace_members').delete().eq('id', memberId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Member removed');
      qc.invalidateQueries({ queryKey: ['ws-members', wsId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ─── Advanced (collapsed) ─── */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [diagChannel, setDiagChannel] = useState<DepartmentChannel>('chat');
  const { data: fallback } = useQuery({
    queryKey: ['workspace-departments-fallback', wsId],
    queryFn: () => getFallbackPolicy(wsId!),
    enabled: !!wsId && advancedOpen,
  });
  const { data: diagnostics } = useQuery({
    queryKey: ['workspace-departments-diag', wsId, diagChannel],
    queryFn: () => getDepartmentDiagnostics(wsId!, diagChannel),
    enabled: !!wsId && advancedOpen,
    refetchInterval: advancedOpen ? 15_000 : false,
  });
  const updateFallback = useMutation({
    mutationFn: (patch: Partial<NonNullable<typeof fallback>>) =>
      updateFallbackPolicy(wsId!, patch as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-departments-fallback', wsId] });
      qc.invalidateQueries({ queryKey: ['workspace-departments-diag', wsId] });
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
            Team & Departments
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            Manage the people who handle visitors and the departments that
            decide where chats and calls get routed. Internal staff (billing,
            SEO, analytics, developers) live on{' '}
            <Link to={wsPath('/settings/staff-access')} className="text-primary hover:underline">
              Staff Access
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
              Departments
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Routing groups for visitors. Toggle channels per department.
            </p>
          </div>
          <Button onClick={() => setShowCreateDept(true)} size="sm">
            <Plus className="h-4 w-4 me-2" /> New department
          </Button>
        </div>

        <Card className="p-0 overflow-hidden border-border/60">
          {loadingDepts ? (
            <div className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" /></div>
          ) : departments.length === 0 ? (
            <div className="p-10 text-center">
              <Building2 className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
              <p className="font-medium text-foreground">No departments yet</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-sm mx-auto">
                Your workspace works without departments — every conversation goes to the General Pool.
                Add one only if you want to route by team.
              </p>
              <Button variant="outline" onClick={() => setShowCreateDept(true)}>
                <Plus className="h-4 w-4 me-2" /> Create first department
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {departments.map((d) => (
                <div key={d.id} className="p-4 flex items-center gap-4 hover:bg-muted/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground truncate">{d.name}</span>
                      {!d.enabled && <Badge variant="outline" className="text-[10px]">Disabled</Badge>}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      {d.chat_enabled && <span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" /> Chat</span>}
                      {d.audio_enabled && <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> Audio</span>}
                      {d.video_enabled && <span className="flex items-center gap-1"><Video className="h-3 w-3" /> Video</span>}
                      {!d.chat_enabled && !d.audio_enabled && !d.video_enabled && (
                        <span className="italic">No channels enabled</span>
                      )}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setMembersFor(d)}>
                    <Users className="h-4 w-4 me-1" /> Members
                  </Button>
                  <Switch
                    checked={d.enabled}
                    onCheckedChange={(v) => toggleEnabled.mutate({ id: d.id, enabled: v })}
                  />
                  <Button variant="ghost" size="sm" onClick={() => setEditingDept(d)}>Edit</Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => { if (confirm(`Delete department "${d.name}"?`)) removeDept.mutate(d.id); }}
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
              Team members
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Customer-facing members. Assign departments inline. Members
              with no department fall into the General Pool.
            </p>
          </div>
          <Button onClick={() => setShowInvite(true)} size="sm">
            <UserPlus className="h-4 w-4 me-2" /> Invite member
          </Button>
        </div>

        <Card className="overflow-hidden border-border/60">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div className="text-xs text-muted-foreground">
              {customerMembers.length} member{customerMembers.length === 1 ? '' : 's'}
            </div>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name or email"
                className="pl-9 h-9 text-xs"
              />
            </div>
          </div>

          {loadingMembers ? (
            <div className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" /></div>
          ) : visibleMembers.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-12">
              {search ? 'No members match your search.' : 'No customer-facing members yet.'}
            </p>
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
                      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
                        <span className="text-sm font-semibold text-primary">
                          {(m.profile?.full_name || m.profile?.email || '?').charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <span
                        aria-hidden
                        title={isOnline ? 'Online' : 'Offline'}
                        className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-background ${isOnline ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">
                          {m.profile?.full_name || '—'}
                        </span>
                        {isCurrent && <Badge variant="outline" className="text-[9px] px-1.5 py-0">you</Badge>}
                        {isOwner && <Crown className="w-3.5 h-3.5 text-amber-400" />}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{m.profile?.email}</p>
                    </div>

                    {/* Customer-facing role badge */}
                    <Badge className={`text-[10px] px-2 py-0.5 border ${ROLE_BADGE[m.role] || 'bg-secondary text-muted-foreground border-border'}`}>
                      {roleLabel(m.role)}
                    </Badge>

                    {/* Department membership */}
                    <button
                      type="button"
                      onClick={() => setEditDeptsFor({
                        userId: m.user_id,
                        name: m.profile?.full_name || m.profile?.email || 'member',
                      })}
                      title={userDepts.length ? userDepts.join(', ') : 'No department — receives via General Pool'}
                      className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-border transition-colors max-w-[200px]"
                    >
                      <Building2 className="w-3 h-3 shrink-0" />
                      <span className="truncate">
                        {userDepts.length === 0
                          ? 'General Pool'
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
                          {CUSTOMER_FACING_ROLES.map(r => (
                            <DropdownMenuItem
                              key={r}
                              onClick={() => updateMemberRole.mutate({ memberId: m.id, newRole: r })}
                              className={m.role === r ? 'bg-primary/10' : ''}
                            >
                              Change to {roleLabel(r)}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuItem
                            onClick={() => removeMember.mutate(m.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="w-3.5 h-3.5 me-2" />
                            Remove member
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

      {/* ═══════════ Advanced — Routing diagnostics + fallback ═══════════ */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <Card className="border-border/60">
          <CollapsibleTrigger asChild>
            <button className="w-full flex items-center justify-between px-5 py-4 text-start hover:bg-muted/30 transition-colors">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="text-sm font-semibold text-foreground">Advanced routing</div>
                  <div className="text-xs text-muted-foreground">
                    Fallback policy, diagnostics, and hidden-department reasons
                  </div>
                </div>
              </div>
              {advancedOpen
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border/60 p-5 space-y-6">
              {/* Fallback policy */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Fallback policy</h3>
                <p className="text-xs text-muted-foreground mb-3">
                  Order tried when no eligible department member is available:
                  General Pool → Owner → Queue → Callback → Offline.
                </p>
                {!fallback ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <div className="space-y-2">
                    <ToggleRow
                      label="Enable owner fallback"
                      checked={fallback.owner_fallback_enabled}
                      onChange={(v) => updateFallback.mutate({ owner_fallback_enabled: v })}
                    />
                    <div className="ms-6 space-y-2 opacity-90">
                      <ToggleRow
                        label="Owner answers chat"
                        checked={fallback.owner_fallback_for_chat}
                        disabled={!fallback.owner_fallback_enabled}
                        onChange={(v) => updateFallback.mutate({ owner_fallback_for_chat: v })}
                      />
                      <ToggleRow
                        label="Owner answers audio calls"
                        checked={fallback.owner_fallback_for_audio}
                        disabled={!fallback.owner_fallback_enabled}
                        onChange={(v) => updateFallback.mutate({ owner_fallback_for_audio: v })}
                      />
                      <ToggleRow
                        label="Owner answers video calls"
                        checked={fallback.owner_fallback_for_video}
                        disabled={!fallback.owner_fallback_enabled}
                        onChange={(v) => updateFallback.mutate({ owner_fallback_for_video: v })}
                      />
                    </div>
                    <ToggleRow
                      label="Use General Pool when no department selected"
                      checked={fallback.general_pool_enabled}
                      onChange={(v) => updateFallback.mutate({ general_pool_enabled: v })}
                    />
                  </div>
                )}
              </div>

              {/* Diagnostics */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-foreground">Routing diagnostics</h3>
                  <Select value={diagChannel} onValueChange={(v) => setDiagChannel(v as any)}>
                    <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="chat">Chat</SelectItem>
                      <SelectItem value="audio">Audio</SelectItem>
                      <SelectItem value="video">Video</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {diagnostics && (
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center gap-4 text-muted-foreground text-xs">
                      <span>Visible: <strong className="text-foreground">{diagnostics.visible_departments.length}</strong></span>
                      <span>Hidden: <strong className="text-foreground">{diagnostics.hidden_departments.length}</strong></span>
                      <span>General Pool: <strong className="text-foreground">{diagnostics.general_pool_size}</strong></span>
                    </div>
                    {diagnostics.visible_departments.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Visible</p>
                        {diagnostics.visible_departments.map((v) => (
                          <div key={v.id} className="flex items-center gap-2 text-xs">
                            <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                            <span className="text-foreground">{v.name}</span>
                            <span className="text-muted-foreground">
                              {v.available_count} available · {v.member_count} eligible
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {diagnostics.hidden_departments.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Hidden</p>
                        {diagnostics.hidden_departments.map((h) => (
                          <div key={h.id} className="flex items-center gap-2 text-xs">
                            <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-foreground">{h.name}</span>
                            <Badge variant="outline" className="text-[10px]">{h.reason}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Pointer to Staff Access */}
      <Card className="p-4 border-border/60 bg-muted/20">
        <div className="flex items-start gap-3 text-sm">
          <ArrowRight className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-muted-foreground">
            <span className="text-foreground font-medium">Need to give billing, SEO, or analytics access?</span>{' '}
            Manage internal staff and non-customer-facing permissions on{' '}
            <Link to={wsPath('/settings/staff-access')} className="text-primary hover:underline">
              Staff Access
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
  const [form, setForm] = useState({
    name: department?.name || '',
    enabled: department?.enabled ?? true,
    chat_enabled: department?.chat_enabled ?? true,
    audio_enabled: department?.audio_enabled ?? false,
    video_enabled: department?.video_enabled ?? false,
    sort_order: department?.sort_order ?? 0,
  });

  const save = useMutation({
    mutationFn: () => mode === 'create'
      ? createDepartment(workspaceId, form)
      : updateDepartment(workspaceId, department!.id, form),
    onSuccess: () => {
      toast.success(mode === 'create' ? 'Department created' : 'Department updated');
      onSaved(); onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New department' : 'Edit department'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label>Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Sales, Support, Billing"
            />
          </div>
          <div>
            <Label>Sort order</Label>
            <Input
              type="number"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="space-y-2">
            <Label>Channels</Label>
            <ToggleRow label="Chat" checked={form.chat_enabled}
              onChange={(v) => setForm({ ...form, chat_enabled: v })} />
            <ToggleRow label="Audio calls" checked={form.audio_enabled}
              onChange={(v) => setForm({ ...form, audio_enabled: v })} />
            <ToggleRow label="Video calls" checked={form.video_enabled}
              onChange={(v) => setForm({ ...form, video_enabled: v })} />
          </div>
          <ToggleRow label="Enabled" checked={form.enabled}
            onChange={(v) => setForm({ ...form, enabled: v })} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!form.name.trim() || save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />} Save
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
  const { data: members = [] } = useWorkspaceMembers(workspaceId);
  const { data: assigned = [] } = useQuery({
    queryKey: ['department-members', workspaceId, department.id],
    queryFn: () => listDepartmentMembers(workspaceId, department.id),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const sel = useMemo(() => selected ?? new Set(assigned), [selected, assigned]);

  const save = useMutation({
    mutationFn: () => setDepartmentMembers(workspaceId, department.id, Array.from(sel)),
    onSuccess: () => { toast.success('Members updated'); onSaved(); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (uid: string) => {
    const next = new Set(sel);
    next.has(uid) ? next.delete(uid) : next.add(uid);
    setSelected(next);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Members of {department.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 max-h-[50vh] overflow-y-auto py-2">
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No workspace members yet.
            </p>
          ) : (
            members.map((m: any) => (
              <label key={m.user_id}
                className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/40 cursor-pointer">
                <Checkbox checked={sel.has(m.user_id)} onCheckedChange={() => toggle(m.user_id)} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">{m.full_name || m.email}</div>
                  <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                </div>
                <Badge variant="outline" className="text-[10px]">{m.role}</Badge>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />} Save
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
  const { data: assignedIds = [] } = useQuery({
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
  const sel = useMemo(() => draft ?? new Set(assignedIds), [draft, assignedIds]);

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
      toast.success('Departments updated');
      queryClient.invalidateQueries({ queryKey: ['ws-departments-overview', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['ws-department-member-assignments', workspaceId, memberUserId] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (id: string) => {
    const next = new Set(sel);
    next.has(id) ? next.delete(id) : next.add(id);
    setDraft(next);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Departments for {memberName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1 max-h-[50vh] overflow-y-auto py-2">
          {departments.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No departments exist yet. Create one above to assign members.
            </p>
          ) : (
            departments.map((d: any) => (
              <label key={d.id}
                className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/40 cursor-pointer">
                <Checkbox checked={sel.has(d.id)} onCheckedChange={() => toggle(d.id)} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">{d.name}</div>
                  {!d.enabled && (
                    <div className="text-[10px] text-muted-foreground">Disabled</div>
                  )}
                </div>
              </label>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground border-t border-border/60 pt-3">
          A member with no departments stays in the General Pool.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Shared invite dialog (also used by Staff Access) */

const CUSTOMER_INVITE_ROLES = ['agent', 'support_agent', 'sales_agent', 'team_lead'];
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
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const roles = mode === 'customer' ? CUSTOMER_INVITE_ROLES : STAFF_INVITE_ROLES;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roles[0]);
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
      toast.success('Invitation link copied');
      queryClient.invalidateQueries({ queryKey: ['ws-invitations', workspaceId] });
      // Best-effort email
      if (email.trim() && API_BASE) {
        try {
          const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
          await fetch(`${API_BASE}/api/email/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
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
            {mode === 'customer' ? 'Invite team member' : 'Invite staff'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs">Email (optional)</Label>
            <Input type="email" value={email} dir="ltr"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="text-left text-xs" />
            <p className="text-[10px] text-muted-foreground mt-1">
              If provided, an invitation email is sent automatically.
            </p>
          </div>
          <div>
            <Label className="text-xs">
              {mode === 'customer' ? 'Customer-facing role' : 'Internal access role'}
            </Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {roles.map(r => (
                  <SelectItem key={r} value={r}>
                    {r.replace(/_/g, ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {link && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-1">
              <p className="text-xs text-foreground">Invitation link (copied to clipboard):</p>
              <Input value={link} readOnly dir="ltr" className="font-mono text-[11px]" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending
              ? <Loader2 className="h-4 w-4 me-2 animate-spin" />
              : <Mail className="h-4 w-4 me-2" />}
            Generate invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}