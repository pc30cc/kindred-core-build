import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, Bell, EyeOff, Check, Clock, UserCog, Building2,
  UserPlus, HelpCircle, Sparkles, LogOut, ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/features/auth/AuthContext';
import { useProfile } from '@/hooks/useProfile';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { fetchAvailability, updateAvailability } from '@/lib/availability-api';
import { toast } from '@/hooks/use-toast';

/** Account menu shown in the top bar — full profile actions in a dropdown. */
export function UserMenu() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();
  const { platformName } = useBrandingContext();
  const wsPath = useWorkspacePath();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: availability } = useQuery({
    queryKey: ['availability', 'me'],
    queryFn: fetchAvailability,
    staleTime: 30_000,
  });
  const invisible = !!(availability as any)?.prefs?.force_offline;
  const toggleInvisible = useMutation({
    mutationFn: () => updateAvailability({ force_offline: !invisible }),
    onSuccess: (res) => {
      queryClient.setQueryData(['availability', 'me'], res);
      toast({
        title: !invisible
          ? (t('nav.invisibleMode') as string)
          : (t('nav.availability') as string),
      });
    },
    onError: () => toast({ title: 'Error', variant: 'destructive' }),
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const fullName =
    ((profile as any)?.full_name as string | null | undefined)?.trim() ||
    ((user as any)?.metadata?.full_name as string | undefined)?.trim() ||
    '';
  const userEmail = (user?.email as string | undefined) || '';
  const userName = fullName || userEmail.split('@')[0] || '';
  const emailVerified = !!(user as any)?.emailVerified;
  const userAvatarUrl = ((profile as any)?.avatar_url as string | null | undefined) || '';

  const itemCls =
    'flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 rounded-2xl border border-border/60 bg-muted/40 px-2.5 py-2 transition-colors hover:bg-muted"
      >
        <div className="relative">
          <Avatar className="h-10 w-10 shrink-0">
            {userAvatarUrl ? <AvatarImage src={userAvatarUrl} alt={userName} /> : null}
            <AvatarFallback className="bg-primary text-xs font-bold text-primary-foreground">
              {userName.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-success" />
        </div>
        <div className="hidden min-w-0 text-start leading-tight lg:block">
          <p className="max-w-[150px] truncate text-sm font-bold text-foreground">
            {(t('nav.userProfile') as string) || 'User profile'}
          </p>
          <p className="max-w-[150px] truncate text-[11px] text-muted-foreground">{userName}</p>
        </div>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute end-0 top-full z-50 mt-2 max-h-[75vh] w-[300px] overflow-y-auto rounded-xl border border-border bg-popover py-1 shadow-2xl animate-fade-in">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Avatar className="h-10 w-10 shrink-0">
              {userAvatarUrl ? <AvatarImage src={userAvatarUrl} alt={userName} /> : null}
              <AvatarFallback className="bg-primary text-sm font-bold text-primary-foreground">
                {userName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-foreground">{userName}</p>
              <p className="truncate text-xs text-muted-foreground" dir="ltr">{userEmail}</p>
            </div>
          </div>

          {!emailVerified && (
            <>
              <RouterLink
                to="/auth/verify-email"
                onClick={() => setOpen(false)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-accent"
              >
                <AlertCircle className="h-5 w-5 shrink-0 text-warning" />
                <span className="font-medium text-warning">{t('auth.verifyEmail')}</span>
              </RouterLink>
              <div className="my-1 border-t border-border" />
            </>
          )}

          <RouterLink to={wsPath('/settings/notifications')} onClick={() => setOpen(false)} className={itemCls}>
            <Bell className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.viewAlerts') || 'View alerts'}</span>
          </RouterLink>
          <button
            onClick={() => toggleInvisible.mutate()}
            disabled={toggleInvisible.isPending || !availability}
            className={cn(itemCls, 'disabled:cursor-not-allowed disabled:opacity-60')}
          >
            <EyeOff className={cn('h-5 w-5', invisible ? 'text-primary' : 'text-muted-foreground')} />
            <span className="flex-1 text-start">{t('nav.invisibleMode') || 'Invisible mode'}</span>
            {invisible && <Check className="h-4 w-4 shrink-0 text-primary" />}
          </button>
          <RouterLink to={wsPath('/settings/availability')} onClick={() => setOpen(false)} className={itemCls}>
            <Clock className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.availability') || 'Availability settings'}</span>
          </RouterLink>

          <div className="my-1 border-t border-border" />

          <RouterLink to={wsPath('/settings/profile')} onClick={() => setOpen(false)} className={itemCls}>
            <UserCog className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.manageAccount') || 'Manage account'}</span>
          </RouterLink>
          <RouterLink to={wsPath('/settings/general')} onClick={() => setOpen(false)} className={itemCls}>
            <Building2 className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.workspaceSettings') || 'Workspace settings'}</span>
          </RouterLink>
          <RouterLink to={wsPath('/team')} onClick={() => setOpen(false)} className={itemCls}>
            <UserPlus className="h-5 w-5 text-muted-foreground" />
            <span>{t('nav.inviteOperator') || 'Invite an operator'}</span>
          </RouterLink>

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
