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
import { toast } from '@/lib/toast';
import {
  Shield, UserPlus, Search, Crown, Loader2, Trash2, Settings2,
  ArrowRight, Users,
} from 'lucide-react';

import { useTranslation } from '@/i18n';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { InviteMemberDialog } from './TeamDepartmentsPage';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

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

const API_BASE = RESOLVED_API_BASE;

// Member management goes through the backend (gs_session cookie +
// service_role) rather than direct supabase.from() calls — see
// server/routes/workspaceMembers.ts and TeamPage.tsx's equivalent helper.
async function staffApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

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

export default function StaffAccessPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const wsPath = useWorkspacePath();
  const wsId = workspace?.id;
  const qc = useQueryClient();

  const { data: allMembers = [], isLoading } = useQuery({
    queryKey: ['ws-members', wsId],
    queryFn: async () => {
      const { members } = await staffApi<{ members: any[] }>(`/api/workspace-members?workspaceId=${wsId}`);
      return members;
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
      await staffApi(`/api/workspace-members/${memberId}?workspaceId=${wsId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
    },
    onSuccess: () => {
      toast.success(t('staffAccess.roleUpdated'));
      qc.invalidateQueries({ queryKey: ['ws-members', wsId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMember = useMutation({
    mutationFn: async (memberId: string) => {
      // Offboarding is destructive: a transport retry must replay the
      // committed result, so the requestId is stable per logical removal.
      await staffApi(`/api/workspace-members/${memberId}?workspaceId=${wsId}`, {
        method: 'DELETE',
        body: JSON.stringify({ requestId: requestIds.get(`offboard:${wsId}:${memberId}`) }),
      });
    },
    onSettled: (_d, _e, memberId) => requestIds.reset(`offboard:${wsId}:${memberId}`),
    onSuccess: () => {
      toast.success(t('staffAccess.memberRemoved'));
      qc.invalidateQueries({ queryKey: ['ws-members', wsId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [showInvite, setShowInvite] = useState(false);

  const roleLabel = (role: string) =>
    t(`staffAccess.roles.${role}` as Parameters<typeof t>[0]);
  const roleHint = (role: string) =>
    t(`staffAccess.hints.${role}` as Parameters<typeof t>[0]);
  const teamLink = (
    <Link to={wsPath('/settings/team-departments')} className="text-primary hover:underline">
      {t('staffAccess.teamLink')}
    </Link>
  );
  const [subtitleBefore, subtitleAfter] = t('staffAccess.subtitleLink').split('{{link}}');

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
            {t('staffAccess.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            {t('staffAccess.subtitle')}{' '}
            {subtitleBefore}{teamLink}{subtitleAfter}
          </p>
        </div>
        <Button onClick={() => setShowInvite(true)} size="sm">
          <UserPlus className="h-4 w-4 me-2" /> {t('staffAccess.inviteStaff')}
        </Button>
      </div>

      {/* Access types overview */}
      <Card className="border-border/60">
        <div className="border-b border-border/60 px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('staffAccess.accessTypes')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('staffAccess.accessTypesHint')}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
          {STAFF_ROLES.map(role => (
            <div key={role}
              className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex items-center justify-between mb-1">
                <Badge className={`text-[10px] px-2 py-0.5 border ${ROLE_BADGE[role]}`}>
                  {roleLabel(role)}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  {(() => {
                    const c = staffMembers.filter((m: any) => m.role === role).length;
                    return t(c === 1 ? 'staffAccess.memberCount_one' : 'staffAccess.memberCount_other', { count: String(c) });
                  })()}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{roleHint(role)}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Staff list */}
      <Card className="overflow-hidden border-border/60">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="text-xs text-muted-foreground">
            {t(staffMembers.length === 1 ? 'staffAccess.staffCount_one' : 'staffAccess.staffCount_other', { count: String(staffMembers.length) })}
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('staffAccess.searchPlaceholder')}
              className="ps-9 h-9 text-xs"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" /></div>
        ) : visible.length === 0 ? (
          <div className="py-12 text-center">
            {search ? (
              <p className="text-sm text-muted-foreground">{t('staffAccess.noSearchResults')}</p>
            ) : (
              <>
                <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
                  <Shield className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="font-medium text-foreground">{t('staffAccess.emptyTitle')}</p>
                <p className="text-sm text-muted-foreground mt-1.5 mb-5 max-w-sm mx-auto">
                  {t('staffAccess.emptyHint')}
                </p>
                <Button variant="outline" onClick={() => setShowInvite(true)}>
                  <UserPlus className="h-4 w-4 me-2" /> {t('staffAccess.inviteStaff')}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {visible.map((m: any) => {
              const isOwner = m.role === 'owner';
              const isCurrent = m.user_id === user?.id;
              return (
                <div key={m.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors">
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
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
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {m.profile?.full_name || '—'}
                      </span>
                      {isCurrent && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{t('staffAccess.youBadge')}</Badge>}
                      {isOwner && <Crown className="w-3.5 h-3.5 text-amber-400" />}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{m.profile?.email}</p>
                  </div>
                  <div className="hidden md:block text-end">
                    <Badge className={`text-[10px] px-2 py-0.5 border ${ROLE_BADGE[m.role] || 'bg-secondary text-muted-foreground border-border'}`}>
                      {roleLabel(m.role)}
                    </Badge>
                    <div className="text-[10px] text-muted-foreground mt-1 max-w-[260px] truncate">
                      {roleHint(m.role)}
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
                            {t('staffAccess.changeTo', { role: roleLabel(r) })}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuItem
                          onClick={() => removeMember.mutate(m.id)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="w-3.5 h-3.5 me-2" />
                          {t('staffAccess.removeMember')}
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
            <span className="text-foreground font-medium">{t('staffAccess.footerTitle')}</span>{' '}
            {t('staffAccess.footerText')}{' '}
            <Link to={wsPath('/settings/team-departments')} className="text-primary hover:underline inline-flex items-center gap-1">
              {t('staffAccess.teamLink')}
              <Users className="h-3 w-3" />
            </Link>
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