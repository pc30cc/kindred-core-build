import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  AlertCircle, Bell, Building2, Check, Clock, EyeOff, HelpCircle,
  LogOut, Sparkles, UserCog, UserPlus, ChevronDown,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/features/auth/AuthContext';
import { useProfile } from '@/hooks/useProfile';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAvailability, updateAvailability } from '@/lib/availability-api';
import { toast } from '@/hooks/use-toast';

/**
 * Account menu — moved out of the sidebar footer into the top bar.
 * Same actions as before, but anchored to the end of the header and
 * opening downwards.
 */
export function UserMenu() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();
  const { platformName } = useBrandingContext();
  const wsPath = useWorkspacePath();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const queryClient = useQueryClient();
  const { data: availability } = useQuery({
    queryKey: ['availability', 'me'],
    queryFn: fetchAvailability,
    enabled: !!user,
    staleTime: 30_000,
  });
  const invisible = !!availability?.prefs?.force_offline;
  const toggleInvisible = useMutation({
    mutationFn: () => updateAvailability({ force_offline: !invisible }),
    onSuccess: (res) => {
      queryClient.setQueryData(['availability', 'me'], res);
      queryClient.invalidateQueries({ queryKey: ['team-presence'] });
      toast({
        title: res.prefs.force_offline ? 'Invisible mode enabled' : 'Invisible mode disabled',
      });
    },
    onError: (err: any) =>
      toast({ title: 'Failed to update status', description: err?.message, variant: 'destructive' }),
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const userName = (user?.metadata?.full_name as string) || user?.email?.split('@')[0] || '';
  const userEmail = user?.email || '';
  const avatarUrl = (profile?.avatar_url as string | null | undefined) || '';

  const item = 'flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors text-start';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-border/60 bg-card/60 py-1 ps-1 pe-2 shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/60"
      >
        <span className="relative">
          <Avatar className="h-7 w-7 ring-2 ring-primary/15">
            {avatarUrl ? <AvatarImage src={avatarUrl} alt={userName} /> : null}
            <AvatarFallback className="bg-primary/10 text-[11px] font-semibold text-primary">
              {userName.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-success" />
        </span>
        <span className="hidden max-w-[140px] truncate text-xs font-medium text-foreground md:block">
          {userName}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute end-0 top-full z-50 mt-2 w-72 max-h-[75vh] overflow-y-auto rounded-xl border border-border bg-popover py-1 shadow-2xl animate-fade-in">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Avatar className="h-10 w-10 shrink-0">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={userName} /> : null}
              <AvatarFallback className="bg-primary text-sm font-bold text-primary-foreground">
                {userName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{userName}</p>
              <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
            </div>
          </div>

          {!user?.emailVerified && (
            <button className={cn(item, 'text-warning')}>
              <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
              <span className="font-medium text-warning">{t('auth.verifyEmail')}</span>
            </button>
          )}

          <div className="my-1 border-t border-border" />

          <RouterLink to={wsPath('/settings/notifications')} onClick={() => setOpen(false)} className={item}>
            <Bell className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.viewAlerts') || 'View alerts'}</span>
          </RouterLink>
          <button
            onClick={() => toggleInvisible.mutate()}
            disabled={toggleInvisible.isPending || !availability}
            className={cn(item, 'disabled:cursor-not-allowed disabled:opacity-60')}
          >
            <EyeOff className={cn('h-4 w-4', invisible ? 'text-primary' : 'text-muted-foreground')} />
            <span className="flex-1">{t('nav.invisibleMode') || 'Invisible mode'}</span>
            {invisible && <Check className="h-4 w-4 shrink-0 text-primary" />}
          </button>
          <RouterLink to={wsPath('/settings/availability')} onClick={() => setOpen(false)} className={item}>
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.availability') || 'Availability settings'}</span>
          </RouterLink>

          <div className="my-1 border-t border-border" />

          <RouterLink to={wsPath('/settings/profile')} onClick={() => setOpen(false)} className={item}>
            <UserCog className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.manageAccount') || 'Manage account'}</span>
          </RouterLink>
          <RouterLink to={wsPath('/settings/general')} onClick={() => setOpen(false)} className={item}>
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.workspaceSettings') || 'Workspace settings'}</span>
          </RouterLink>
          <RouterLink to={wsPath('/team')} onClick={() => setOpen(false)} className={item}>
            <UserPlus className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.inviteOperator') || 'Invite an operator'}</span>
          </RouterLink>

          <div className="my-1 border-t border-border" />

          <RouterLink to={wsPath('/knowledge-base')} onClick={() => setOpen(false)} className={item}>
            <HelpCircle className="h-4 w-4 text-primary" />
            <span className="font-medium text-primary">
              {t('nav.getHelp') || `Get help using ${platformName}`}
            </span>
          </RouterLink>
          <button className={item}>
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.whatsNew') || "What's new?"}</span>
          </button>

          <div className="my-1 border-t border-border" />

          <button
            onClick={() => { setOpen(false); signOut(); }}
            className={cn(item, 'text-destructive hover:bg-destructive/10')}
          >
            <LogOut className="h-4 w-4" />
            <span className="text-destructive">{t('auth.logout')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
