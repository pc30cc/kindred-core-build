import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { useTeamPresence, presenceMap } from '@/hooks/useTeamPresence';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { IdentityListSkeleton } from '@/components/common/IdentitySkeleton';
import { toast } from '@/lib/toast';
import {
  Users, UserPlus, Shield, Loader2, Copy, Trash2,
  Crown, MoreHorizontal, Mail, Clock, Search, UserCog,
  Ban, RotateCcw, CheckCircle2, Building2,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE;

// Team/invitation management goes through the backend (gs_session cookie
// + service_role) rather than direct supabase.from() calls — the
// dashboard's browser session no longer carries a Supabase Auth JWT, so
// auth.uid()-scoped RLS on a direct query would silently return/write
// nothing. See server/routes/workspaceMembers.ts.
async function teamApi<T>(path: string, options?: RequestInit): Promise<T> {
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

const roleColors: Record<string, string> = {
  owner: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  admin: 'bg-primary/10 text-primary border-primary/20',
  team_lead: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  agent: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  sales_agent: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  support_agent: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  marketing_manager: 'bg-pink-500/10 text-pink-400 border-pink-500/20',
  seo_manager: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  analyst: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  developer: 'bg-lime-500/10 text-lime-400 border-lime-500/20',
  billing: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  viewer: 'bg-secondary text-muted-foreground border-border',
};

const assignableRoles = [
  'admin', 'team_lead', 'agent', 'sales_agent', 'support_agent',
  'marketing_manager', 'seo_manager', 'analyst', 'developer', 'billing', 'viewer',
];

const allRolesWithOwner = ['owner', ...assignableRoles];

const rolePermissionKeys: Record<string, string[]> = {
  owner: ['permFullAccess', 'permTeamManagement', 'permSettings', 'permBilling', 'permDeleteWorkspace'],
  admin: ['permTeamManagement', 'permSettings', 'permReports', 'permCrm', 'permCampaigns'],
  team_lead: ['permManageOperators', 'permTeamReports', 'permAssignConversations', 'permCrm'],
  agent: ['permConversations', 'permContacts', 'permKnowledgeBase'],
  sales_agent: ['permCrm', 'permPipeline', 'permContacts', 'permConversations'],
  support_agent: ['permConversations', 'permContacts', 'permKnowledgeBase'],
  marketing_manager: ['permCampaigns', 'permContacts', 'permReports'],
  seo_manager: ['permSeoDashboard', 'permKeywords', 'permPages'],
  analyst: ['permReports', 'permVisitorAnalytics'],
  developer: ['permApi', 'permWebhook', 'permWidget'],
  billing: ['permBillingDashboard', 'permSubscriptions', 'permInvoices', 'permPayments'],
  viewer: ['permViewOnly'],
};

type ExpirationOption = '10d' | '20d' | '30d' | '1m' | 'none' | 'custom';

function getExpiresAt(option: ExpirationOption, customDate?: string): string | null {
  const now = new Date();
  switch (option) {
    case '10d': return new Date(now.getTime() + 10 * 86400000).toISOString();
    case '20d': return new Date(now.getTime() + 20 * 86400000).toISOString();
    case '30d': return new Date(now.getTime() + 30 * 86400000).toISOString();
    case '1m': {
      const d = new Date(now);
      d.setMonth(d.getMonth() + 1);
      return d.toISOString();
    }
    case 'none': return null;
    case 'custom': return customDate ? new Date(customDate).toISOString() : null;
    default: return new Date(now.getTime() + 30 * 86400000).toISOString();
  }
}

export default function TeamPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const queryClient = useQueryClient();

  const [activeSection, setActiveSection] = useState<'members' | 'invitations'>('members');
  const [inviteRole, setInviteRole] = useState('agent');
  const [inviteExpiration, setInviteExpiration] = useState<ExpirationOption>('30d');
  const [inviteCustomDate, setInviteCustomDate] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [editDeptsFor, setEditDeptsFor] = useState<{
    memberId: string;
    userId: string;
    name: string;
  } | null>(null);

  const wsId = workspace?.id;

  // Live operator presence (online/offline dot + label).
  const { data: presenceData, isPending: presencePending } = useTeamPresence(wsId);
  const presenceByUser = presenceMap(presenceData?.presence);

  const getRoleLabel = (role: string) => {
    return (t as any)(`team.${role}`) || role;
  };

  // Fetch members (with profile + department names joined server-side)
  const { data: members = [], isLoading } = useQuery({
    queryKey: ['ws-members', wsId],
    queryFn: async () => {
      const { members } = await teamApi<{ members: any[] }>(
        `/api/workspace-members?workspaceId=${wsId}`,
      );
      return members;
    },
    enabled: !!wsId,
  });

  // Fetch invitations
  const { data: invitations = [] } = useQuery({
    queryKey: ['ws-invitations', wsId],
    queryFn: async () => {
      const { invitations } = await teamApi<{ invitations: any[] }>(
        `/api/workspace-members/invitations?workspaceId=${wsId}`,
      );
      return invitations;
    },
    enabled: !!wsId,
  });

  const deptsByUser = new Map<string, string[]>(
    (members as any[]).map((m: any) => [m.user_id, m.department_names ?? []]),
  );

  // Generate invite
  const generateInvite = useMutation({
    mutationFn: async () => {
      const expiresAt = getExpiresAt(inviteExpiration, inviteCustomDate);
      const { invitation } = await teamApi<{ invitation: any }>('/api/workspace-members/invitations', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: wsId,
          role: inviteRole,
          invitedEmail: inviteEmail.trim() || null,
          expiresAt: expiresAt || null,
        }),
      });
      return invitation;
    },
    onSuccess: (data: any) => {
      const link = `${window.location.origin}/auth/invite?token=${data.token}`;
      setInviteLink(link);
      navigator.clipboard.writeText(link);
      toast.success(t('team.inviteCreated'));

      // Send invitation email if email is provided
      if (inviteEmail.trim() && API_BASE) {
        sendInviteEmail(data.token, inviteEmail.trim(), data.role);
      }

      queryClient.invalidateQueries({ queryKey: ['ws-invitations'] });
      setInviteEmail('');
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Send invite email via self-hosted backend
  const sendInviteEmail = async (token: string, email: string, role: string) => {
    try {
      const link = `${window.location.origin}/auth/invite?token=${token}`;
      await fetch(`${API_BASE}/api/email/send`, {credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: wsId,
          to: email,
          subject: `You've been invited to ${workspace?.name}`,
          html: buildInviteEmailHtml(workspace?.name || '', role, user?.email || '', link),
          from: undefined, // Let backend resolve from config
        }),
      });
    } catch (err) {
      console.warn('[team] Failed to send invite email:', err);
    }
  };

  // Revoke invite
  const revokeInvite = useMutation({
    mutationFn: async (id: string) => {
      await teamApi(`/api/workspace-members/invitations/${id}?workspaceId=${wsId}`, { method: 'PATCH' });
    },
    onSuccess: () => {
      toast.success(t('team.inviteRevoked'));
      queryClient.invalidateQueries({ queryKey: ['ws-invitations'] });
    },
  });

  // Delete invite
  const deleteInvite = useMutation({
    mutationFn: async (id: string) => {
      await teamApi(`/api/workspace-members/invitations/${id}?workspaceId=${wsId}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      toast.success(t('team.inviteDeleted'));
      queryClient.invalidateQueries({ queryKey: ['ws-invitations'] });
    },
  });

  // Resend invite email
  const resendInviteEmail = useMutation({
    mutationFn: async (inv: any) => {
      if (!inv.invited_email) throw new Error('No email associated with this invitation');
      await sendInviteEmail(inv.token, inv.invited_email, inv.role);
    },
    onSuccess: () => {
      toast.success(t('team.inviteResent'));
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Update member role
  const updateMemberRole = useMutation({
    mutationFn: async ({ memberId, newRole }: { memberId: string; newRole: string }) => {
      await teamApi(`/api/workspace-members/${memberId}?workspaceId=${wsId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
    },
    onSuccess: () => {
      toast.success(t('team.roleUpdated'));
      queryClient.invalidateQueries({ queryKey: ['ws-members'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Remove member
  const removeMember = useMutation({
    mutationFn: async (memberId: string) => {
      await teamApi(`/api/workspace-members/${memberId}?workspaceId=${wsId}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      toast.success(t('team.memberRemoved'));
      queryClient.invalidateQueries({ queryKey: ['ws-members'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const filteredMembers = members.filter((m: any) =>
    !searchQuery ||
    m.profile?.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.profile?.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const roleStats = assignableRoles.reduce((acc, role) => {
    acc[role] = members.filter((m: any) => m.role === role).length;
    return acc;
  }, {} as Record<string, number>);
  roleStats['owner'] = members.filter((m: any) => m.role === 'owner').length;

  // Split invitations
  const activeInvites = invitations.filter((inv: any) => {
    const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
    return !expired && !inv.revoked_at;
  });
  const inactiveInvites = invitations.filter((inv: any) => {
    const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
    return expired || inv.revoked_at;
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
      {/* Header — mirrors Account Information */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('team.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('team.subtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          {members.length} {t('team.totalMembers').toLowerCase()}
        </div>
      </div>

      {/* Section Tabs */}
      <nav className="flex items-center gap-1 border-b border-border/60">
        {[
          { key: 'members',     icon: Users,  label: t('team.tabMembers'),     badge: 0 },
          { key: 'invitations', icon: Mail,   label: t('team.tabInvitations'), badge: activeInvites.length },
        ].map(tab => {
          const active = activeSection === tab.key;
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveSection(tab.key as any)}
              className={cn(
                'relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors',
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
              {tab.badge > 0 && (
                <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
                  {tab.badge}
                </span>
              )}
              {active && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
              )}
            </button>
          );
        })}
      </nav>

      {/* ═══════════ Members Tab ═══════════ */}
      {activeSection === 'members' && (
        <>
          {/* Stats Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard icon={Users} label={t('team.totalMembers')} value={members.length} />
            <StatCard icon={Crown} label={t('team.admins')} value={members.filter((m: any) => ['owner', 'admin'].includes(m.role)).length} />
            <StatCard icon={UserCog} label={t('team.operators')} value={roleStats['agent'] || 0} />
            <StatCard icon={Mail} label={t('team.activeInvites')} value={activeInvites.length} />
          </div>

          {/* Members List */}
          <Card className="overflow-hidden border-border/60 shadow-sm">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
              <h2 className="text-base font-semibold text-foreground">{t('team.membersList')}</h2>
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('team.searchMember')}
                  className="pl-9 h-9 text-xs"
                />
              </div>
            </div>

            {isLoading || presencePending ? (
              <IdentityListSkeleton rows={5} avatarClassName="h-10 w-10" rowClassName="px-6 py-4" />
            ) : (
              <div className="divide-y divide-border/60">
                {filteredMembers.map((m: any) => {
                  const isOwner = m.role === 'owner';
                  const isCurrentUser = m.user_id === user?.id;
                  const presence = presenceByUser.get(m.user_id);
                  const state = presence?.state;
                  const isOnline = state === 'online';
                  const isAway = state === 'away' || state === 'idle';
                  const statusLabel = isOnline
                    ? t('dashboard.statusOnline')
                    : isAway
                    ? t('dashboard.statusAway')
                    : t('dashboard.statusOffline');
                  return (
                    <div key={m.id} className="flex items-center gap-4 px-6 py-4 hover:bg-muted/40 transition-colors">
                      <ContactAvatar
                        name={m.profile?.full_name}
                        email={m.profile?.email}
                        avatarUrl={m.profile?.avatar_url}
                        size="md"
                        presence={isOnline ? 'online' : isAway ? 'idle' : 'offline'}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{m.profile?.full_name || t('team.noName')}</span>
                          {isCurrentUser && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{t('team.you')}</Badge>}
                          {isOwner && <Crown className="w-3.5 h-3.5 text-amber-400" />}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs text-muted-foreground truncate">{m.profile?.email}</p>
                          <span className={`text-[10px] font-medium ${isOnline ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                            • {statusLabel}
                          </span>
                        </div>
                      </div>
                      <Badge className={`text-[10px] px-2 py-0.5 border ${roleColors[m.role] || roleColors.viewer}`}>
                        {getRoleLabel(m.role)}
                      </Badge>
                      <MemberDepartmentsCell
                        deptNames={deptsByUser.get(m.user_id) ?? []}
                        onManage={() => setEditDeptsFor({
                          memberId: m.id,
                          userId: m.user_id,
                          name: m.profile?.full_name || m.profile?.email || 'member',
                        })}
                      />
                      {!isOwner && !isCurrentUser && (
                        <MemberActions
                          currentRole={m.role}
                          getRoleLabel={getRoleLabel}
                          onChangeRole={(newRole) => updateMemberRole.mutate({ memberId: m.id, newRole })}
                          onRemove={() => removeMember.mutate(m.id)}
                          t={t}
                        />
                      )}
                    </div>
                  );
                })}
                {filteredMembers.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground py-12">{t('team.noMembers')}</p>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {/* ═══════════ Invitations Tab ═══════════ */}
      {activeSection === 'invitations' && (
        <>
          {/* Create Invitation */}
          <Card className="overflow-hidden border-border/60 shadow-sm">
            <div className="border-b border-border/60 px-6 py-4 flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-primary" />
              <h2 className="text-base font-semibold text-foreground">{t('team.inviteNew')}</h2>
            </div>
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                <div className="space-y-2">
                  <Label className="text-xs">{t('team.inviteEmail')}</Label>
                  <Input
                    type="email"
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    placeholder="user@example.com"
                    dir="ltr"
                    className="text-left text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">{t('team.inviteEmailHint')}</p>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">{t('team.inviteRole')}</Label>
                  <Select value={inviteRole} onValueChange={setInviteRole}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {assignableRoles.map(r => (
                        <SelectItem key={r} value={r}>{getRoleLabel(r)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">{t('team.inviteExpiration')}</Label>
                  <Select value={inviteExpiration} onValueChange={(v) => setInviteExpiration(v as ExpirationOption)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10d">{t('team.expire10Days')}</SelectItem>
                      <SelectItem value="20d">{t('team.expire20Days')}</SelectItem>
                      <SelectItem value="30d">{t('team.expire30Days')}</SelectItem>
                      <SelectItem value="1m">{t('team.expire1Month')}</SelectItem>
                      <SelectItem value="none">{t('team.expireNone')}</SelectItem>
                      <SelectItem value="custom">{t('team.expireCustom')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {inviteExpiration === 'custom' && (
                  <div className="space-y-2">
                    <Label className="text-xs">&nbsp;</Label>
                    <Input
                      type="datetime-local"
                      value={inviteCustomDate}
                      onChange={e => setInviteCustomDate(e.target.value)}
                      dir="ltr"
                      className="text-left text-xs"
                    />
                  </div>
                )}
              </div>
              <Button onClick={() => generateInvite.mutate()} disabled={generateInvite.isPending} className="w-full sm:w-auto gap-2">
                {generateInvite.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                {t('team.generateLink')}
              </Button>
              {inviteLink && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/5 border border-primary/20">
                  <Input value={inviteLink} readOnly dir="ltr" className="text-left font-mono text-xs flex-1" />
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(inviteLink); toast.success(t('team.linkCopied')); }}>
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </Card>

          {/* Active Invitations */}
          <Card className="overflow-hidden border-border/60 shadow-sm">
            <div className="border-b border-border/60 px-6 py-4">
              <h2 className="text-base font-semibold text-foreground">{t('team.activeInvitations')}</h2>
            </div>
            {activeInvites.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-12">{t('team.noInvitations')}</p>
            ) : (
              <div className="divide-y divide-border/60">
                {activeInvites.map((inv: any) => (
                  <InvitationRow
                    key={inv.id}
                    inv={inv}
                    getRoleLabel={getRoleLabel}
                    onCopy={() => { navigator.clipboard.writeText(`${window.location.origin}/auth/invite?token=${inv.token}`); toast.success(t('team.linkCopied')); }}
                    onRevoke={() => revokeInvite.mutate(inv.id)}
                    onResend={inv.invited_email ? () => resendInviteEmail.mutate(inv) : undefined}
                    onDelete={() => deleteInvite.mutate(inv.id)}
                    t={t}
                    active
                  />
                ))}
              </div>
            )}
          </Card>

          {/* Expired / Revoked Invitations */}
          {inactiveInvites.length > 0 && (
            <Card className="overflow-hidden border-border/60 shadow-sm">
              <div className="border-b border-border/60 px-6 py-4">
                <h2 className="text-base font-semibold text-foreground">{t('team.expiredInvitations')}</h2>
              </div>
              <div className="divide-y divide-border/60">
                {inactiveInvites.map((inv: any) => (
                  <InvitationRow
                    key={inv.id}
                    inv={inv}
                    getRoleLabel={getRoleLabel}
                    onCopy={() => {}}
                    onRevoke={() => {}}
                    onDelete={() => deleteInvite.mutate(inv.id)}
                    t={t}
                    active={false}
                  />
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {/* Member departments dialog (assignment from Team page) */}
      {editDeptsFor && wsId && (
        <MemberDepartmentsDialog
          workspaceId={wsId}
          memberUserId={editDeptsFor.userId}
          memberName={editDeptsFor.name}
          onClose={() => setEditDeptsFor(null)}
        />
      )}
    </div>
  );
}

/* ─── Helpers ─── */

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4 transition-colors hover:border-border">
      <div className="flex items-center gap-2 text-muted-foreground mb-1.5">
        <Icon className="w-3.5 h-3.5" />
        <span className="text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function InvitationRow({ inv, getRoleLabel, onCopy, onRevoke, onResend, onDelete, t, active }: {
  inv: any;
  getRoleLabel: (r: string) => string;
  onCopy: () => void;
  onRevoke: () => void;
  onResend?: () => void;
  onDelete: () => void;
  t: (key: string) => string;
  active: boolean;
}) {
  const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
  const revoked = !!inv.revoked_at;
  const statusLabel = revoked ? t('team.inviteRevoked_status') :
                      expired ? t('team.inviteExpired') :
                      t('team.inviteActive');

  return (
    <div className="flex items-center gap-4 px-5 py-3 hover:bg-muted/50 transition-colors">
      <div className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-emerald-500' : 'bg-destructive'}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-muted-foreground truncate">...{inv.token.slice(-16)}</span>
          {inv.invited_email && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Mail className="w-3 h-3" />
              {inv.invited_email}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{getRoleLabel(inv.role)}</span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {inv.expires_at
              ? new Date(inv.expires_at).toLocaleDateString()
              : t('team.expireNone')
            }
          </span>
          {inv.use_count > 0 && (
            <>
              <span>•</span>
              <span>{inv.use_count} {t('team.uses')}</span>
            </>
          )}
        </div>
      </div>
      <Badge variant={active ? 'outline' : 'secondary'} className="text-[10px] shrink-0">
        {statusLabel}
      </Badge>
      <div className="flex gap-1 shrink-0">
        {active && (
          <>
            <button
              onClick={onCopy}
              className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              title={t('common.copy')}
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            {onResend && (
              <button
                onClick={onResend}
                className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                title={t('team.resendEmail')}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onRevoke}
              className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title={t('team.revokeInvite')}
            >
              <Ban className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        <button
          onClick={onDelete}
          className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          title={t('common.delete')}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function MemberActions({ currentRole, getRoleLabel, onChangeRole, onRemove, t }: {
  currentRole: string;
  getRoleLabel: (role: string) => string;
  onChangeRole: (role: string) => void;
  onRemove: () => void;
  t: (key: string) => string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {assignableRoles.map(role => (
          <DropdownMenuItem
            key={role}
            onClick={() => onChangeRole(role)}
            className={currentRole === role ? 'bg-primary/10' : ''}
          >
            {t('team.changeTo')} {getRoleLabel(role)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          onClick={onRemove}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span className="ms-2">{t('team.removeMember')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function buildInviteEmailHtml(workspaceName: string, role: string, inviterEmail: string, link: string) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1a1a1a; margin-bottom: 16px;">You've been invited to join ${workspaceName}</h2>
      <p style="color: #555; font-size: 14px; line-height: 1.6;">
        <strong>${inviterEmail}</strong> has invited you to join <strong>${workspaceName}</strong> as <strong>${role}</strong>.
      </p>
      <div style="margin: 24px 0;">
        <a href="${link}" style="display: inline-block; padding: 12px 24px; background-color: #3b82f6; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
          Accept Invitation
        </a>
      </div>
      <p style="color: #999; font-size: 12px;">
        If you can't click the button, copy this link:<br/>
        <a href="${link}" style="color: #3b82f6; word-break: break-all;">${link}</a>
      </p>
    </div>
  `;
}

/**
 * Compact pill that summarises which departments a member belongs to.
 * "General Pool" is shown when the member has no department assignment —
 * matching the routing semantics in `server/services/calls/departments.ts`.
 */
function MemberDepartmentsCell({
  deptNames,
  onManage,
}: {
  deptNames: string[];
  onManage: () => void;
}) {
  const summary =
    deptNames.length === 0
      ? 'General Pool'
      : deptNames.length === 1
        ? deptNames[0]
        : `${deptNames[0]} +${deptNames.length - 1}`;
  return (
    <button
      type="button"
      onClick={onManage}
      title={deptNames.length ? deptNames.join(', ') : 'Not assigned to any department — receives via General Pool'}
      className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-border transition-colors max-w-[160px]"
    >
      <Building2 className="w-3 h-3 shrink-0" />
      <span className="truncate">{summary}</span>
    </button>
  );
}

/**
 * Inline dialog that lets owners/admins assign a member to zero, one, or
 * multiple departments without leaving the Team page. Writes go through
 * the same `workspace_department_members` table the Departments page uses,
 * so cache invalidation, RLS, and routing semantics stay in sync.
 */
function MemberDepartmentsDialog({
  workspaceId,
  memberUserId,
  memberName,
  onClose,
}: {
  workspaceId: string;
  memberUserId: string;
  memberName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const { data: departments = [], isLoading: loadingDepts } = useQuery({
    queryKey: ['ws-departments-list', workspaceId],
    queryFn: async () => {
      const { departments } = await teamApi<{ departments: any[] }>(
        `/api/workspace-departments/${workspaceId}`,
      );
      return departments ?? [];
    },
  });

  const { data: assignedIds = [], isLoading: loadingAssign } = useQuery({
    queryKey: ['ws-department-member-assignments', workspaceId, memberUserId],
    queryFn: async () => {
      const { department_ids } = await teamApi<{ department_ids: string[] }>(
        `/api/workspace-members/user/${memberUserId}/departments?workspaceId=${workspaceId}`,
      );
      return department_ids ?? [];
    },
  });

  const [selected, setSelected] = useState<Set<string> | null>(null);
  const sel: Set<string> = selected ?? new Set<string>(assignedIds);

  const save = useMutation({
    mutationFn: async () => {
      await teamApi(`/api/workspace-members/user/${memberUserId}/departments?workspaceId=${workspaceId}`, {
        method: 'PUT',
        body: JSON.stringify({ department_ids: Array.from(sel) }),
      });
    },
    onSuccess: () => {
      toast.success('Department assignments updated');
      queryClient.invalidateQueries({ queryKey: ['ws-departments-overview', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['ws-department-member-assignments', workspaceId, memberUserId] });
      // Keep Departments page in sync.
      queryClient.invalidateQueries({ queryKey: ['workspace-departments', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['workspace-departments-diag', workspaceId] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  function toggle(id: string) {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  const loading = loadingDepts || loadingAssign;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Departments — {memberName}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2 mb-1">
          Choose zero or more departments. Members with no assignment stay
          in the General Pool and receive routed conversations there.
        </p>
        <div className="max-h-[360px] overflow-y-auto py-2 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : departments.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No departments yet. Create them in Departments settings.
            </p>
          ) : (
            departments.map((d: any) => (
              <label
                key={d.id}
                className="flex items-center gap-3 p-2 rounded hover:bg-accent/40 cursor-pointer"
              >
                <Checkbox
                  checked={sel.has(d.id)}
                  onCheckedChange={() => toggle(d.id)}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{d.name}</p>
                </div>
                {!d.enabled && (
                  <Badge variant="outline" className="text-[10px]">Disabled</Badge>
                )}
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || loading}>
            {save.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
