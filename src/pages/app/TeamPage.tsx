/**
 * /team surface.
 *
 * Owners are redirected to the canonical Team & Departments settings page
 * (the single shared InvitationManagement implementation).
 * Everyone else (admins, agents, viewers) gets a read-only member directory:
 * no management, no invites, no messaging — just who is on the team.
 */
import { useMemo } from 'react';
import { Navigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { useTeamPresence, presenceMap } from '@/hooks/useTeamPresence';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

function initials(name?: string | null, email?: string | null) {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export default function TeamPage() {
  const { t, dir } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: role, isPending } = useWorkspaceRole(workspace?.id);
  const { data: members = [], isLoading } = useWorkspaceMembers(workspace?.id);
  const { data: presence } = useTeamPresence(workspace?.id);
  const pMap = useMemo(() => presenceMap((presence as any)?.presence), [presence]);

  if (isPending) return <div className="h-full w-full" />;
  if (isWorkspaceAdmin(role)) return <Navigate to="../settings/team-departments" replace />;

  return (
    <div className="h-full w-full overflow-hidden p-6" dir={dir}>
      <Card className="mx-auto flex h-full max-w-3xl flex-col overflow-hidden border-border/60">
        <div className="flex items-center gap-2 border-b border-border/60 px-5 py-4">
          <Users className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-base font-semibold text-foreground">
            {(t as any)('team.title') || 'Team'}
          </h1>
          <span className="ms-auto text-xs text-muted-foreground">{members.length}</span>
        </div>

        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">…</div>
          ) : members.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              {(t as any)('team.noMembers') || '—'}
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {members.map(m => {
                const online = (pMap.get(m.user_id) as any)?.state === 'online';
                return (
                  <li key={m.user_id} className="flex items-center gap-3 px-5 py-3">
                    <div className="relative">
                      <Avatar className="h-9 w-9">
                        {m.avatar_url && <AvatarImage src={m.avatar_url} alt="" />}
                        <AvatarFallback className="text-xs">
                          {initials(m.full_name, m.email)}
                        </AvatarFallback>
                      </Avatar>
                      <span
                        className={cn(
                          'absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-background',
                          online ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                        )}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {m.full_name || m.email || '—'}
                      </p>
                      {m.email && (
                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                      )}
                    </div>
                    <Badge variant="secondary" className="text-[11px]">
                      {(t as any)(`team.${m.role}`) || m.role}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </Card>
    </div>
  );
}
