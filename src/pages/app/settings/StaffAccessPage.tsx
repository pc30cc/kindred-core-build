/**
 * Staff Access — Internal / non-customer-facing workspace members.
 *
 * For people who do NOT primarily handle visitor conversations:
 *   • billing / finance
 *   • SEO
 *   • analytics
 *   • marketing
 *   • developers
 *   • internal admins
 *   • viewers
 *
 * Department/routing concepts are intentionally absent here. Customer-facing
 * members (agents, support, sales, team leads) are managed on
 * /settings/team-departments.
 *
 * Backend reuse: this page reads/writes the same `workspace_members` table
 * and uses the same `workspace_invitations` flow as the legacy Team page —
 * no schema changes, no new APIs.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Shield, UserPlus, Search, Crown, Loader2, Trash2, Settings2,
  ArrowRight, Users,
} from 'lucide-react';

import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';
import { supabase } from '@/lib/supabase';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { InviteMemberDialog } from './TeamDepartmentsPage';

/**
 * Internal/staff role identifiers. These map 1:1 to the existing role
 * column on workspace_members — we just present them in a dedicated page.
 * "owner" is shown for completeness when the workspace owner also appears
 * here, but is not invitable from this page.
 */
const STAFF_ROLES = [
  'admin',
  'marketing_manager',
  'seo_manager',
  'analyst',
  'developer',
  'billing',
  'viewer',
] as const;

const ROLE_BADGE: Record<string, string> = {
  owner: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  admin: 'bg-primary/10 text-primary border-primary/20',
  marketing_manager: 'bg-pink-500/10 text-pink-400 border-pink-500/20',
  seo_manager: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  analyst: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  developer: 'bg-lime-500/10 text-lime-400 border-lime-500/20',
  billing: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  viewer: 'bg-secondary text-muted-foreground border-border',
};

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  marketing_manager: 'Marketing',
  seo_manager: 'SEO',
  analyst: 'Analyst',
  developer: 'Developer',
  billing: 'Billing',
  viewer: 'Viewer',
  owner: 'Owner',
};

const ROLE_ACCESS_HINT: Record<string, string> = {
  admin: 'Workspace settings, team management, all reports',
  marketing_manager: 'Campaigns, contacts, marketing reports',
  seo_manager: 'SEO dashboard, keywords, pages',
  analyst: 'Reports, visitor analytics',
  developer: 'API, webhooks, widget configuration',
  billing: 'Billing dashboard, subscriptions, invoices',
  viewer: 'Read-only access',
  owner: 'Full workspace access',
};

export default function StaffAccessPage() {
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const wsPath = useWorkspacePath();
  const wsId = workspace?.id;
  const qc = useQueryClient();

  const { data: allMembers = [], isLoading } = useQuery({
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

  const staffMembers = useMemo(
    () => allMembers.filter((m: any) =>
      m.role === 'owner' || (STAFF_ROLES as readonly string[]).includes(m.role),
    ),
    [allMembers],
  );

  const [search, setSearch] = useState('');
  const visible = staffMembers.filter((m: any) =>
    !search ||
    m.profile?.full_name?.toLowerCase().includes(search.toLowerCase()) ||
    m.profile?.email?.toLowerCase().includes(search.toLowerCase()),
  );

  const updateRole = useMutation({
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

  const [showInvite, setShowInvite] = useState(false);

  if (!workspace) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Shield className="h-6 w-6" />
            Staff Access
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            Internal members who handle billing, SEO, analytics, marketing,
            development, or workspace administration — but do{' '}
            <span className="text-foreground font-medium">not</span>{' '}
            answer customer chats or calls. For customer-facing team and
            department routing, open{' '}
            <Link to={wsPath('/settings/team-departments')} className="text-primary hover:underline">
              Team & Departments
            </Link>.
          </p>
        </div>
        <Button onClick={() => setShowInvite(true)} size="sm">
          <UserPlus className="h-4 w-4 me-2" /> Invite staff
        </Button>
      </div>

      {/* Access types overview */}
      <Card className="border-border/60">
        <div className="border-b border-border/60 px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Access types</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Each access type maps to an internal permission bundle.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
          {STAFF_ROLES.map(role => (
            <div key={role}
              className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex items-center justify-between mb-1">
                <Badge className={`text-[10px] px-2 py-0.5 border ${ROLE_BADGE[role]}`}>
                  {ROLE_LABEL[role]}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  {staffMembers.filter((m: any) => m.role === role).length} member(s)
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{ROLE_ACCESS_HINT[role]}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Staff list */}
      <Card className="overflow-hidden border-border/60">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="text-xs text-muted-foreground">
            {staffMembers.length} staff member{staffMembers.length === 1 ? '' : 's'}
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

        {isLoading ? (
          <div className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" /></div>
        ) : visible.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-12">
            {search ? 'No staff member matches your search.' : 'No internal staff members yet. Invite someone to get started.'}
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {visible.map((m: any) => {
              const isOwner = m.role === 'owner';
              const isCurrent = m.user_id === user?.id;
              return (
                <div key={m.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors">
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="text-sm font-semibold text-primary">
                      {(m.profile?.full_name || m.profile?.email || '?').charAt(0).toUpperCase()}
                    </span>
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
                  <div className="hidden md:block text-right">
                    <Badge className={`text-[10px] px-2 py-0.5 border ${ROLE_BADGE[m.role] || 'bg-secondary text-muted-foreground border-border'}`}>
                      {ROLE_LABEL[m.role] ?? m.role}
                    </Badge>
                    <div className="text-[10px] text-muted-foreground mt-1 max-w-[260px] truncate">
                      {ROLE_ACCESS_HINT[m.role] ?? '—'}
                    </div>
                  </div>
                  {!isOwner && !isCurrent && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Settings2 className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {STAFF_ROLES.map(r => (
                          <DropdownMenuItem
                            key={r}
                            onClick={() => updateRole.mutate({ memberId: m.id, newRole: r })}
                            className={m.role === r ? 'bg-primary/10' : ''}
                          >
                            Change to {ROLE_LABEL[r]}
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

      <Card className="p-4 border-border/60 bg-muted/20">
        <div className="flex items-start gap-3 text-sm">
          <ArrowRight className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-muted-foreground">
            <span className="text-foreground font-medium">Looking for agents, support, or sales people?</span>{' '}
            Customer-facing members and department routing live on{' '}
            <Link to={wsPath('/settings/team-departments')} className="text-primary hover:underline">
              Team & Departments
              <Users className="inline h-3 w-3 ms-1" />
            </Link>.
          </div>
        </div>
      </Card>

      {showInvite && wsId && (
        <InviteMemberDialog
          workspaceId={wsId}
          workspaceName={workspace.name}
          inviterEmail={user?.email || ''}
          mode="staff"
          onClose={() => setShowInvite(false)}
        />
      )}
    </div>
  );
}