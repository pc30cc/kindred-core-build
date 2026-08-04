import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Inbox, Users, Eye, BookOpen, Package, Settings, Sparkles,
  PhoneCall, UserCog, CreditCard, Rocket, Shield,
} from 'lucide-react';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList,
} from '@/components/ui/command';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';

/**
 * Global quick-navigation palette (Cmd/Ctrl + K).
 * Presentational only — it navigates to routes the operator can already reach.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const { data: isAdmin } = useIsGlobalAdmin();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const items = [
    { key: 'overview', icon: Rocket, path: '' },
    { key: 'inbox', icon: Inbox, path: '/inbox' },
    { key: 'aiAgent', icon: Sparkles, path: '/ai-agent' },
    { key: 'callCenter', icon: PhoneCall, path: '/call-center' },
    { key: 'visitors', icon: Eye, path: '/visitors' },
    { key: 'contacts', icon: Users, path: '/contacts' },
    { key: 'knowledgeBase', icon: BookOpen, path: '/knowledge-base' },
    { key: 'team', icon: UserCog, path: '/team' },
    { key: 'widget', icon: Package, path: '/widget' },
    { key: 'billing', icon: CreditCard, path: '/billing' },
    { key: 'settings', icon: Settings, path: '/settings/general' },
  ] as const;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder={t('common.searchEverything') || 'Search…'} />
      <CommandList>
        <CommandEmpty>{t('common.noResults') || 'No results'}</CommandEmpty>
        <CommandGroup heading={t('nav.settings')}>
          {items.map((item) => (
            <CommandItem
              key={item.key}
              value={`${item.key} ${t(`nav.${item.key}` as any)}`}
              onSelect={() => go(wsPath(item.path))}
            >
              <item.icon className="me-2 h-4 w-4 text-muted-foreground" />
              <span>{t(`nav.${item.key}` as any)}</span>
            </CommandItem>
          ))}
          {isAdmin && (
            <CommandItem value="super admin" onSelect={() => go('/admin')}>
              <Shield className="me-2 h-4 w-4 text-muted-foreground" />
              <span>Super Admin</span>
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
