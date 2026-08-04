import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, Bell, Building2, Check, Clock, EyeOff, HelpCircle,
  LogOut, Sparkles, UserCog, UserPlus,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useI18n } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { useProfile } from '@/hooks/useProfile';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { fetchAvailability, updateAvailability } from '@/lib/availability-api';
import { cn } from '@/lib/utils';

/** Account avatar + dropdown menu, rendered in the top bar. */
export function UserAccountMenu() {
  const { t: tRaw } = useI18n();
  const t = tRaw as unknown as (key: string) => string;
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();
  const { platformName } = useBrandingContext();
  const wsPath = useWorkspacePath();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const { data: availability } = useQuery({
    queryKey: ['availability', 'me'],
    queryFn: fetchAvailability,
  });
  const invisible = !!availability?.prefs?.force_offline;
  const toggleInvisible = useMutation({
    mutationFn: () => updateAvailability({ force_offline: !invisible }),
    onSuccess: (res) => queryClient.setQueryData(['availability', 'me'], res),
  });

  const userName =
    (user?.metadata?.full_name as string) || user?.email?.split('@')[0] || '';
  const userEmail = user?.email || '';
  const avatarUrl =
    (profile?.avatar_url as string | null | undefined) ||
    (user?.metadata?.avatar_url as string | undefined) ||
    '';

  const itemCls =
    'flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors text-start';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        title={userName}
        className="flex items-center gap-2.5 rounded-full border border-border/60 bg-card/60 py-1 ps-1 pe-3 shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/60"
      >
        <span className="relative">
          <Avatar className="h-8 w-8 ring-2 ring-primary/15">
            {avatarUrl ? <AvatarImage src={avatarUrl} alt={userName} /> : null}
            <AvatarFallback className="bg-primary/10 text-[11px] font-semibold text-primary">
              {userName.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-success" />
        </span>
        <span className="hidden min-w-0 leading-tight md:block text-start">
          <span className="block max-w-[150px] truncate text-xs font-medium text-foreground">{userName}</span>
          <span className="block max-w-[150px] truncate text-[11px] text-muted-foreground">{userEmail}</span>
        </span>
      </button>

      {open && (
        <div className="absolute end-0 top-full mt-2 z-50 w-72 bg-popover border border-border rounded-xl shadow-2xl py-1 animate-fade-in max-h-[75vh] overflow-y-auto">
          <div className="px-4 py-3 border-b border-border flex items-center gap-3">
            <Avatar className="w-10 h-10 shrink-0">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={userName} /> : null}
              <AvatarFallback className="bg-primary text-sm font-bold text-primary-foreground">
                {userName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">{userName}</p>
              <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
            </div>
          </div>

          <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm hover:bg-accent transition-colors">
            <AlertCircle className="h-4 w-4 text-warning shrink-0" />
            <span className="text-warning font-medium">{t('auth.verifyEmail')}</span>
          </button>

          <div className="border-t border-border my-1" />

          <button className={itemCls}>
            <Bell className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.viewAlerts') || 'View alerts'}</span>
          </button>
          <button
            onClick={() => toggleInvisible.mutate()}
            disabled={toggleInvisible.isPending || !availability}
            className={cn(itemCls, 'disabled:opacity-60 disabled:cursor-not-allowed')}
          >
            <EyeOff className={cn('h-4 w-4', invisible ? 'text-primary' : 'text-muted-foreground')} />
            <span className="flex-1 text-start">
              {invisible ? 'Disable invisible mode' : (t('nav.invisibleMode') || 'Enable invisible mode')}
            </span>
            {invisible && <Check className="h-4 w-4 text-primary shrink-0" />}
          </button>
          <RouterLink to={wsPath('/settings/availability')} onClick={() => setOpen(false)} className={itemCls}>
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.availability') || 'Availability settings'}</span>
          </RouterLink>

          <div className="border-t border-border my-1" />

          <RouterLink to={wsPath('/settings/profile')} onClick={() => setOpen(false)} className={itemCls}>
            <UserCog className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.manageAccount') || 'Manage account'}</span>
          </RouterLink>
          <RouterLink to={wsPath('/settings/general')} onClick={() => setOpen(false)} className={itemCls}>
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.workspaceSettings') || 'Workspace settings'}</span>
          </RouterLink>
          <RouterLink to={wsPath('/team')} onClick={() => setOpen(false)} className={itemCls}>
            <UserPlus className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.inviteOperator') || 'Invite an operator'}</span>
          </RouterLink>

          <div className="border-t border-border my-1" />

          <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm hover:bg-accent transition-colors text-start">
            <HelpCircle className="h-4 w-4 text-primary" />
            <span className="text-primary font-medium">{t('nav.getHelp') || `Get help using ${platformName}`}</span>
          </button>
          <button className={itemCls}>
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span>{t('nav.whatsNew') || "What's new?"}</span>
          </button>

          <div className="border-t border-border my-1" />

          <button
            onClick={() => { setOpen(false); signOut(); }}
            className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors text-start"
          >
            <LogOut className="h-4 w-4" />
            <span>{t('auth.logout')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
