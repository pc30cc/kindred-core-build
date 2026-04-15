import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import {
  Users, UserPlus, Shield, Loader2, Copy, Trash2,
  Crown, MoreHorizontal, Mail, Clock, Search, UserCog,
} from 'lucide-react';

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

export default function TeamPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const queryClient = useQueryClient();

  const [activeSection, setActiveSection] = useState<'members' | 'roles'>('members');
  const [inviteRole, setInviteRole] = useState('agent');
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [inviteLink, setInviteLink] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const wsId = workspace?.id;

  const getRoleLabel = (role: string) => {
    const key = role as keyof typeof t;
    return (t as any)(`team.${role}`) || role;
  };

  // Fetch members
  const { data: members = [], isLoading } = useQuery({
    queryKey: ['ws-members', wsId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_members')
        .select('id, role, created_at, user_id')
        .eq('workspace_id', wsId!);
      if (error) throw error;
      if (!data) return [];
      const userIds = data.map(m => m.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email, avatar_url')
        .in('id', userIds);
      return data.map(m => ({
        ...m,
        profile: profiles?.find(p => p.id === m.user_id),
      }));
    },
    enabled: !!wsId,
  });

  // Fetch invitations
  const { data: invitations = [] } = useQuery({
    queryKey: ['ws-invitations', wsId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_invitations')
        .select('*')
        .eq('workspace_id', wsId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!wsId,
  });

  // Generate invite
  const generateInvite = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from('workspace_invitations')
        .insert({
          workspace_id: wsId!,
          role: inviteRole as any,
          created_by: user!.id,
          max_uses: inviteMaxUses,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      const link = `${window.location.origin}/auth/invite?token=${data.token}`;
      setInviteLink(link);
      navigator.clipboard.writeText(link);
      toast.success(t('team.linkCopied'));
      queryClient.invalidateQueries({ queryKey: ['ws-invitations'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Delete invite
  const deleteInvite = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('workspace_invitations').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(t('team.inviteDeleted'));
      queryClient.invalidateQueries({ queryKey: ['ws-invitations'] });
    },
  });

  // Update member role
  const updateMemberRole = useMutation({
    mutationFn: async ({ memberId, newRole }: { memberId: string; newRole: string }) => {
      const { error } = await supabase
        .from('workspace_members')
        .update({ role: newRole as any })
        .eq('id', memberId);
      if (error) throw error;
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
      const { error } = await supabase.from('workspace_members').delete().eq('id', memberId);
      if (error) throw error;
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

  if (!workspace) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('team.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('team.subtitle')}</p>
        </div>
        <span className="text-sm text-muted-foreground">
          {members.length} {t('team.totalMembers').toLowerCase()}
        </span>
      </div>

      {/* Section Tabs */}
      <div className="flex items-center gap-2 p-1 rounded-xl bg-secondary/50 border border-border w-fit">
        <button
          onClick={() => setActiveSection('members')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeSection === 'members' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
          }`}
        >
          <Users className="w-4 h-4" />{t('team.tabMembers')}
        </button>
        <button
          onClick={() => setActiveSection('roles')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeSection === 'roles' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
          }`}
        >
          <Shield className="w-4 h-4" />{t('team.tabRoles')}
        </button>
      </div>

      {activeSection === 'members' && (
        <>
          {/* Stats Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard icon={Users} label={t('team.totalMembers')} value={members.length} />
            <StatCard icon={Crown} label={t('team.admins')} value={members.filter((m: any) => ['owner', 'admin'].includes(m.role)).length} />
            <StatCard icon={UserCog} label={t('team.operators')} value={roleStats['agent'] || 0} />
            <StatCard icon={Mail} label={t('team.activeInvites')} value={invitations.filter((inv: any) => new Date(inv.expires_at) > new Date()).length} />
          </div>

          {/* Invite Section */}
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-primary" />
                <h3 className="text-sm font-semibold">{t('team.inviteNew')}</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
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
                  <Label className="text-xs">{t('team.inviteMaxUses')}</Label>
                  <Select value={String(inviteMaxUses)} onValueChange={v => setInviteMaxUses(Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">{t('team.inviteMax1')}</SelectItem>
                      <SelectItem value="5">{t('team.inviteMax5')}</SelectItem>
                      <SelectItem value="10">{t('team.inviteMax10')}</SelectItem>
                      <SelectItem value="0">{t('team.inviteMaxUnlimited')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-2 flex items-end">
                  <Button onClick={() => generateInvite.mutate()} disabled={generateInvite.isPending} className="w-full gap-2">
                    {generateInvite.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                    {t('team.generateLink')}
                  </Button>
                </div>
              </div>
              {inviteLink && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/5 border border-primary/20">
                  <Input value={inviteLink} readOnly dir="ltr" className="text-left font-mono text-xs flex-1" />
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(inviteLink); toast.success(t('team.linkCopied')); }}>
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Members List */}
          <Card>
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 border-b border-border">
              <h3 className="text-sm font-semibold">{t('team.membersList')}</h3>
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('team.searchMember')}
                  className="pl-9 text-xs"
                />
              </div>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filteredMembers.map((m: any) => {
                  const isOwner = m.role === 'owner';
                  const isCurrentUser = m.user_id === user?.id;
                  return (
                    <div key={m.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/50 transition-colors">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <span className="text-sm font-semibold text-primary">
                          {(m.profile?.full_name || m.profile?.email || '?').charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{m.profile?.full_name || t('team.noName')}</span>
                          {isCurrentUser && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{t('team.you')}</Badge>}
                          {isOwner && <Crown className="w-3.5 h-3.5 text-amber-400" />}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{m.profile?.email}</p>
                      </div>
                      <Badge className={`text-[10px] px-2 py-0.5 border ${roleColors[m.role] || roleColors.viewer}`}>
                        {getRoleLabel(m.role)}
                      </Badge>
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
                  <p className="text-center text-muted-foreground py-8">{t('team.noMembers')}</p>
                )}
              </div>
            )}
          </Card>

          {/* Active Invitations */}
          {invitations.length > 0 && (
            <Card>
              <div className="p-4 border-b border-border">
                <h3 className="text-sm font-semibold">{t('team.inviteLinks')}</h3>
              </div>
              <div className="divide-y divide-border">
                {invitations.map((inv: any) => {
                  const expired = new Date(inv.expires_at) < new Date();
                  const exhausted = inv.max_uses > 0 && inv.use_count >= inv.max_uses;
                  const active = !expired && !exhausted;
                  return (
                    <div key={inv.id} className="flex items-center gap-4 px-5 py-3 hover:bg-muted/50 transition-colors">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-emerald-500' : 'bg-destructive'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-mono text-muted-foreground truncate">...{inv.token.slice(-16)}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span>{getRoleLabel(inv.role)}</span>
                          <span>•</span>
                          <span>{inv.use_count}/{inv.max_uses || '∞'} {t('team.uses')}</span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {new Date(inv.expires_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                      <Badge variant={active ? 'outline' : 'secondary'} className="text-[10px] shrink-0">
                        {expired ? t('team.inviteExpired') : exhausted ? t('team.inviteExhausted') : t('team.inviteActive')}
                      </Badge>
                      <div className="flex gap-1 shrink-0">
                        {active && (
                          <button
                            onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/auth/invite?token=${inv.token}`); toast.success(t('team.linkCopied')); }}
                            className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => deleteInvite.mutate(inv.id)}
                          className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </>
      )}

      {activeSection === 'roles' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('team.rolesDesc')}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {allRolesWithOwner.map(role => (
              <Card key={role}>
                <CardContent className="p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Badge className={`text-xs px-2.5 py-1 border ${roleColors[role] || roleColors.viewer}`}>
                        {getRoleLabel(role)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        ({roleStats[role] || 0} {t('team.membersCount')})
                      </span>
                    </div>
                    {role === 'owner' && <Crown className="w-4 h-4 text-amber-400" />}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(rolePermissionKeys[role] || []).map(permKey => (
                      <span key={permKey} className="text-[10px] px-2 py-0.5 rounded-full bg-secondary/50 text-muted-foreground border border-border/50">
                        {(t as any)(`team.${permKey}`)}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Helpers ─── */
function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <Icon className="w-4 h-4" />
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
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
