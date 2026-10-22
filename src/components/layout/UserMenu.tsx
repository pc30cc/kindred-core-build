import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Check, Clock, UserCog, Building2,
  UserPlus, HelpCircle, Sparkles, LogOut, ChevronDown, ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { OperatorAvatarFallback } from '@/components/ui/operator-avatar-fallback';
import { useAuth } from '@/features/auth/AuthContext';
import { useProfile } from '@/hooks/useProfile';
import { useWorkspacePath, useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { fetchAvailability, updateAvailability } from '@/lib/availability-api';
import { useTeamPresence } from '@/hooks/useTeamPresence';
import {
  MY_STATUS_DOT_CLASS, manualChoiceOf, myOperatorStatus, myStatusKeys, prefsForChoice,
} from '@/lib/myOperatorStatus';
import { isRoutableChatRole } from '../../../shared/chatRoles';
import { toast } from '@/hooks/use-toast';

/** A translation, or '' when the key is missing (the translator answers with the key). */
function word(t: (key: string) => string, key: string): string {
  const text = t(key);
  return text && text !== key ? text : '';
}

/** Account menu shown in the top bar — full profile actions in a dropdown. */
export function UserMenu() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();
  const { platformName } = useBrandingContext();
  const wsPath = useWorkspacePath();
  const currentWorkspace = useCurrentWorkspace();
  const { data: wsRole } = useWorkspaceRole(currentWorkspace?.id);
  const isWsAdmin = isWorkspaceAdmin(wsRole);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: availability } = useQuery({
    queryKey: ['availability', 'me'],
    queryFn: () => fetchAvailability(),
    staleTime: 30_000,
  });
  // R-26: the dot says what is true — offline by hand, outside their own
  // schedule, idle ("away"), not connected, or online — for the members who
  // receive chats (the owner and the chat team). Staff are never given
  // chats, so they have no status here.
  const hasChatStatus = isRoutableChatRole(wsRole);
  const { data: teamPresence } = useTeamPresence(hasChatStatus ? currentWorkspace?.id : undefined);
  const myPresence = teamPresence?.presence?.find((p) => p.user_id === user?.id) ?? null;
  const status = myOperatorStatus(availability, myPresence);
  const statusKeys = myStatusKeys(status);
  const statusLabel = statusKeys ? word(t, statusKeys.label) : '';
  const statusHint = statusKeys ? word(t, statusKeys.hint) : '';
  const manualChoice = manualChoiceOf(availability);
  const setStatus = useMutation({
    mutationFn: (choice: 'online' | 'offline') => updateAvailability(prefsForChoice(choice)),
    onSuccess: (res, choice) => {
      queryClient.setQueryData(['availability', 'me'], res);
      queryClient.invalidateQueries({ queryKey: ['team-presence'] });
      // Online by hand, but the schedule keeps them offline right now: say so.
      const scheduleClosed = choice === 'online' && res.status?.state === 'offline';
      toast({
        title: word(t, choice === 'online' ? 'nav.statusNowOnline' : 'nav.statusNowOffline'),
        description: word(t, scheduleClosed ? 'nav.statusOutsideScheduleHint' : choice === 'online' ? 'nav.statusOnlineHint' : 'nav.statusOfflineHint'),
      });
    },
    onError: (err: unknown) => toast({
      title: word(t, 'nav.statusChangeFailed'),
      description: err instanceof Error ? err.message : undefined,
      variant: 'destructive',
    }),
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const metaName = user?.metadata?.full_name;
  const fullName =
    profile?.full_name?.trim() ||
    (typeof metaName === 'string' ? metaName.trim() : '') ||
    '';
  const userEmail = user?.email || '';
  const userName = fullName || userEmail.split('@')[0] || '';
  const userAvatarUrl = profile?.avatar_url || '';

  const itemCls =
    'flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 rounded-2xl px-1 py-1 transition-colors"
      >
        <div className="relative">
          <Avatar className="h-10 w-10 shrink-0">
            {userAvatarUrl ? <AvatarImage src={userAvatarUrl} alt={userName} /> : null}
            <OperatorAvatarFallback />
          </Avatar>
          {hasChatStatus && status !== 'unknown' && (
            <span
              data-my-status={status}
              className={cn('absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-background', MY_STATUS_DOT_CLASS[status])}
              title={statusLabel}
              aria-label={statusLabel}
              role="img"
            />
          )}
        </div>
        <div className="hidden min-w-0 text-start leading-tight lg:block">
          <p className="max-w-[150px] truncate text-sm font-bold text-foreground">
            {(t('nav.userProfile') as string) || 'User profile'}
          </p>
          <p className="max-w-[150px] truncate text-[11px] text-muted-foreground">{userName}</p>
        </div>
        <ChevronDown strokeWidth={3} className={cn('h-6 w-6 text-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute end-0 top-full z-50 mt-2 max-h-[75vh] w-[300px] overflow-y-auto rounded-xl border border-border bg-popover py-1 shadow-2xl animate-fade-in">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Avatar className="h-10 w-10 shrink-0">
              {userAvatarUrl ? <AvatarImage src={userAvatarUrl} alt={userName} /> : null}
              <OperatorAvatarFallback />
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-foreground">{userName}</p>
              <p className="truncate text-xs text-muted-foreground" dir="ltr">{userEmail}</p>
            </div>
          </div>




          <RouterLink to={wsPath('/settings/notifications')} onClick={() => setOpen(false)} className={itemCls}>
            <Bell className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.viewAlerts') || 'View alerts'}</span>
          </RouterLink>
          {hasChatStatus && (
            <div data-my-status-menu role="group" aria-label={word(t, 'nav.statusHeading')} className="border-y border-border py-1">
              <div className="flex items-start gap-3 px-4 py-2">
                <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', MY_STATUS_DOT_CLASS[status])} aria-hidden />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{word(t, 'nav.statusHeading')}</p>
                  <p className="text-sm font-semibold text-foreground">{statusLabel || '…'}</p>
                  {statusHint && <p className="text-[11px] leading-snug text-muted-foreground">{statusHint}</p>}
                </div>
              </div>
              {(['online', 'offline'] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="menuitemradio"
                  aria-checked={manualChoice === choice}
                  data-status-choice={choice}
                  onClick={() => { if (manualChoice !== choice) setStatus.mutate(choice); }}
                  disabled={setStatus.isPending || !availability}
                  className={cn(itemCls, 'disabled:cursor-not-allowed disabled:opacity-60')}
                >
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', choice === 'online' ? 'bg-success' : 'bg-muted-foreground/60')} aria-hidden />
                  <span className="flex-1 text-start">
                    {word(t, choice === 'online' ? 'nav.statusOnline' : 'nav.statusOffline')}
                  </span>
                  {manualChoice === choice && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              ))}
            </div>
          )}
          <RouterLink to={wsPath('/settings/availability')} onClick={() => setOpen(false)} className={itemCls}>
            <Clock className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.availability') || 'Availability settings'}</span>
          </RouterLink>

          <div className="my-1 border-t border-border" />

          <RouterLink to={wsPath('/settings/profile')} onClick={() => setOpen(false)} className={itemCls}>
            <UserCog className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.manageAccount') || 'Manage account'}</span>
          </RouterLink>
          <RouterLink to={wsPath('/settings/security')} onClick={() => setOpen(false)} className={itemCls}>
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.sessions') || 'Sessions & security'}</span>
          </RouterLink>
          {isWsAdmin && (
            <>
              <RouterLink to={wsPath('/settings/general')} onClick={() => setOpen(false)} className={itemCls}>
                <Building2 className="h-5 w-5 text-muted-foreground" />
                <span>{t('nav.workspaceSettings') || 'Workspace settings'}</span>
              </RouterLink>
              <RouterLink to={wsPath('/team')} onClick={() => setOpen(false)} className={itemCls}>
                <UserPlus className="h-5 w-5 text-muted-foreground" />
                <span>{t('nav.inviteOperator') || 'Invite an operator'}</span>
              </RouterLink>
            </>
          )}

          <div className="my-1 border-t border-border" />

          <RouterLink to={wsPath('/knowledge-base')} onClick={() => setOpen(false)} className="flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-accent">
            <HelpCircle className="h-5 w-5 text-primary" />
            <span className="font-medium text-primary">{t('nav.getHelp') || `Get help using ${platformName}`}</span>
          </RouterLink>
          <button className={itemCls}>
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.whatsNew') || "What's new?"}</span>
          </button>

          <div className="my-1 border-t border-border" />

          <button
            onClick={() => { setOpen(false); signOut(); }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
          >
            <LogOut className="h-5 w-5" />
            <span>{t('auth.logout')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
