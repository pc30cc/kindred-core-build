import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Inbox, Users, Eye, BookOpen, Package, Settings, Sparkles,
  PhoneCall, UserCog, CreditCard, Rocket, Shield, Radar, BarChart3, Mail, Plug,
} from 'lucide-react';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList,
} from '@/components/ui/command';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useWorkspaceSections } from '@/hooks/useWorkspaceSections';
import type { AppSection } from '@/lib/planAccess';

/**
 * Global quick-navigation palette (Cmd/Ctrl + K).
 * It offers exactly the sections the sidebar offers — the same plan, role
 * and platform rules (useWorkspaceSections) — never a section the member
 * would only be refused at.
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

  const sections = useWorkspaceSections();
  type Item = { key: string; icon: typeof Inbox; path: string; section?: AppSection };
  const all: Item[] = [
    { key: 'overview', icon: Rocket, path: '' },
    { key: 'inbox', icon: Inbox, path: '/inbox' },
    { key: 'aiAgent', icon: Sparkles, path: '/ai-agent', section: 'aiAgent' },
    { key: 'callCenter', icon: PhoneCall, path: '/call-center', section: 'callCenter' },
    { key: 'visitors', icon: Eye, path: '/visitors', section: 'visitors' },
    { key: 'contacts', icon: Users, path: '/contacts', section: 'contacts' },
    { key: 'seo', icon: Radar, path: '/seo', section: 'seo' },
    { key: 'webAnalytics', icon: BarChart3, path: '/analytics', section: 'webAnalytics' },
    { key: 'emailInbox', icon: Mail, path: '/email', section: 'emailInbox' },
    { key: 'knowledgeBase', icon: BookOpen, path: '/knowledge-base' },
    { key: 'team', icon: UserCog, path: '/team' },
    { key: 'widget', icon: Package, path: '/widget', section: 'widget' },
    { key: 'plugins', icon: Plug, path: '/plugins', section: 'plugins' },
    { key: 'billing', icon: CreditCard, path: '/billing', section: 'billing' },
    { key: 'settings', icon: Settings, path: sections.isAdmin ? '/settings/general' : '/settings/profile' },
  ];
  const items = all.filter((item) => !item.section || sections.visible(item.section));

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder={t('common.searchEverything') || 'Search…'} />
      <CommandList>
        <CommandEmpty>{t('common.noResults') || 'No results'}</CommandEmpty>
        <CommandGroup heading={t('nav.settings')}>
          {items.map((item) => (
            <CommandItem
              key={item.key}
              value={`${item.key} ${t(`nav.${item.key}` as TranslationKey)}`}
              onSelect={() => go(wsPath(item.path))}
            >
              <item.icon className="me-2 h-4 w-4 text-muted-foreground" />
              <span>{t(`nav.${item.key}` as TranslationKey)}</span>
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
