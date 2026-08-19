/**
 * Access Profiles — Workspace permission overview.
 *
 * Read-only catalog of role/permission bundles available in this workspace.
 * Members are assigned an Access Profile from the Team page; routing is
 * handled separately on the Departments page. This page intentionally
 * keeps zero routing semantics so the IA stays clean:
 *   Team           → who is in my workspace
 *   Access Profiles → what they can access
 *   Departments     → where visitors get routed
 */
import { Link } from 'react-router-dom';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Shield, Crown, Users, ArrowRight } from 'lucide-react';

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

const profileOrder = [
  'owner', 'admin', 'team_lead', 'agent', 'sales_agent', 'support_agent',
  'marketing_manager', 'seo_manager', 'analyst', 'developer', 'billing', 'viewer',
];

const profilePermissionKeys: Record<string, string[]> = {
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

export default function AccessProfilesPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const wsPath = useWorkspacePath();
  const wsId = workspace?.id;

  const { data: members = [] } = useWorkspaceMembers(wsId);

  const getProfileLabel = (role: string) =>
    (t as any)(`team.${role}`) || role;

  const counts = profileOrder.reduce<Record<string, number>>((acc, role) => {
    acc[role] = members.filter((m: any) => m.role === role).length;
    return acc;
  }, {});

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Shield className="h-6 w-6" />
            Access Profiles
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            Permission bundles that define what a member can access in this
            workspace (inbox, billing, settings, voice/video, analytics…).
            Profiles do <span className="font-medium text-foreground">not</span> control
            visitor routing — that lives in <Link to={wsPath('/settings/departments')} className="text-primary hover:underline">Departments</Link>.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={wsPath('/settings/team')}>
            <Users className="h-4 w-4 me-2" />
            Manage in Team
          </Link>
        </Button>
      </div>

      <Card className="overflow-hidden border-border/60 shadow-sm">
        <div className="border-b border-border/60 px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">Available profiles</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Assign one of these to each team member from the Team page.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-6">
          {profileOrder.map(role => (
            <div
              key={role}
              className="rounded-lg border border-border/60 bg-background p-5 transition-colors hover:border-border"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Badge className={`text-xs px-2.5 py-1 border ${roleColors[role] || roleColors.viewer}`}>
                    {getProfileLabel(role)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    ({counts[role] || 0} members)
                  </span>
                </div>
                {role === 'owner' && <Crown className="w-4 h-4 text-amber-500" />}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(profilePermissionKeys[role] || []).map(permKey => (
                  <span
                    key={permKey}
                    className="text-[10px] px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground border border-border/50"
                  >
                    {(t as any)(`team.${permKey}`)}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5 border-border/60 bg-muted/20">
        <div className="flex items-start gap-3">
          <ArrowRight className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground mb-1">Looking for visitor routing?</p>
            <p>
              Departments (Sales, Support, Billing…) decide which team
              receives an incoming chat or call. Open{' '}
              <Link to={wsPath('/settings/departments')} className="text-primary hover:underline">
                Departments
              </Link>{' '}
              to configure routing, channel policy, and fallbacks.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
