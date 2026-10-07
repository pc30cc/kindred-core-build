/**
 * What the Art shell offers, and when: the header's pills, the "More" menu,
 * the phone drawer and the inbox's queue bar.
 *
 * Source of truth: src/components/layout/AppSidebar.tsx. Every entry here and
 * the rule that shows it (the plan section via useWorkspaceSections, the
 * workspace role, Super Admin, the inbox queue rules, the channel inboxes from
 * the plugin catalog) is the sidebar's, with the same paths and the same
 * `nav.<key>` labels, so switching the panel theme never changes what a member
 * can reach. Change a rule there, change it here.
 *
 * Only the order differs: a top bar shows as many pills as fit and folds the
 * rest into "More", so the entries are listed by how often they are used.
 */
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, Ban, BarChart3, BookOpen, Bot, Check, Clock, Eye, Inbox,
  LayoutDashboard, Mail, MessageSquare, Package, PhoneCall, Plug, Radar,
  Settings, Sparkles, UserCog, Users,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useInboxCounts } from '@/hooks/useConversations';
import { useWorkspaceSections } from '@/hooks/useWorkspaceSections';
import type { AppSection } from '@/lib/planAccess';
import {
  aiQueueVisible,
  channelInboxVisible,
  colleaguesQueueVisible,
  needsHumanQueueVisible,
} from '@/lib/planAccess';
import { pluginsApi } from '@/lib/plugins-api';
import { channelLabel, type ChannelKey } from '@/components/inbox/ChannelBadge';

export interface ArtNavItem {
  key: string;
  label: string;
  /** Full path, already scoped to the workspace. */
  to: string;
  icon: LucideIcon;
  active: boolean;
  /** Shown as a count badge when above zero. */
  badge?: number;
}

export interface ArtQueueItem extends ArtNavItem {
  /** Status queues, the internal inbox, then the channel inboxes. */
  group: 'status' | 'internal' | 'channel';
  tone?: 'urgent';
}

type Entry = { key: string; path: string; icon: LucideIcon; section?: AppSection };

// Top-level destinations by priority; a plan-gated one carries its section.
const PRIMARY: Entry[] = [
  { key: 'dashboard', path: '', icon: LayoutDashboard },
  { key: 'inbox', path: '/inbox', icon: Inbox },
  { key: 'contacts', path: '/contacts', icon: Users, section: 'contacts' },
  { key: 'visitors', path: '/visitors', icon: Eye, section: 'visitors' },
  { key: 'aiAgent', path: '/ai-agent', icon: Sparkles, section: 'aiAgent' },
  // Knowledge Base and Team are core products: never plan-gated.
  { key: 'knowledgeBase', path: '/knowledge-base', icon: BookOpen },
  { key: 'callCenter', path: '/call-center', icon: PhoneCall, section: 'callCenter' },
  { key: 'emailInbox', path: '/email', icon: Mail, section: 'emailInbox' },
  { key: 'seo', path: '/seo', icon: Radar, section: 'seo' },
  { key: 'webAnalytics', path: '/analytics', icon: BarChart3, section: 'webAnalytics' },
  { key: 'team', path: '/team', icon: UserCog },
];

// The sidebar's bottom group (its "search" entry is the header's search pill).
const UTILITY: Entry[] = [
  { key: 'widget', path: '/widget', icon: Package, section: 'widget' },
  { key: 'plugins', path: '/plugins', icon: Plug, section: 'plugins' },
];

export function useArtNav() {
  const { t } = useTranslation();
  const location = useLocation();
  const wsPath = useWorkspacePath();
  const { workspace } = useActiveWorkspace();
  const { data: isGlobalAdmin } = useIsGlobalAdmin();
  const { data: inboxCounts } = useInboxCounts(workspace?.id);
  const sections = useWorkspaceSections();
  const { plan } = sections;

  // Same query (and cache entry) as the sidebar's channel inboxes.
  const { data: pluginCatalog } = useQuery({
    queryKey: ['sidebar-plugin-channels', workspace?.id],
    enabled: !!workspace?.id && sections.isAdmin,
    staleTime: 60_000,
    queryFn: async () => (await pluginsApi.catalog(workspace!.id)).items || [],
  });

  const isActive = (subPath: string) => {
    if (subPath === '') return location.pathname === wsPath('');
    return location.pathname.includes(subPath);
  };

  const label = (key: string) => t(`nav.${key}` as TranslationKey);
  // Until the plan snapshot is known a plan-gated entry is not offered at all.
  const offered = (entry: Entry) => !entry.section || sections.visible(entry.section);
  const toItem = (entry: Entry): ArtNavItem => ({
    key: entry.key,
    label: label(entry.key),
    to: wsPath(entry.path),
    icon: entry.icon,
    active: isActive(entry.path),
  });

  const needsHuman = inboxCounts?.needs_human ?? 0;
  const primary = PRIMARY.filter(offered).map((entry) =>
    entry.key === 'inbox' ? { ...toItem(entry), badge: needsHuman } : toItem(entry),
  );

  const settingsPath = sections.isAdmin ? '/settings/general' : '/settings/profile';
  const settings: ArtNavItem = {
    key: 'settings',
    label: label('settings'),
    to: wsPath(settingsPath),
    icon: Settings,
    active: isActive('/settings'),
  };
  const utility = UTILITY.filter(offered).map(toItem);

  // The inbox's queues, shown while the inbox is open.
  const onInbox = isActive('/inbox');
  const queues: ArtQueueItem[] = [];
  if (onInbox) {
    const sp = new URLSearchParams(location.search);
    const q = sp.get('queue');
    const f = sp.get('filter');
    const st = sp.get('status');
    const ch = sp.get('channel');
    const queue = (
      key: string,
      search: string,
      text: string,
      icon: LucideIcon,
      active: boolean,
      extra: Partial<ArtQueueItem> = {},
    ): ArtQueueItem => ({
      key,
      label: text,
      to: wsPath(`/inbox${search}`),
      icon,
      active,
      group: 'status',
      ...extra,
    });

    queues.push(queue('open', '', t('inbox.open') || 'Open', MessageSquare, !q && !f && !ch && (!st || st === 'open')));
    if (aiQueueVisible(sections, inboxCounts?.automated ?? 0)) {
      queues.push(queue('automated', '?queue=automated', t('inbox.aiTab') || 'AI', Bot, q === 'automated', {
        badge: inboxCounts?.automated ?? 0,
      }));
    }
    if (needsHumanQueueVisible(plan)) {
      queues.push(queue('needs_human', '?filter=needs_human', t('inbox.needsHuman') || 'Needs human', AlertCircle, f === 'needs_human', {
        badge: needsHuman,
        tone: 'urgent',
      }));
    }
    queues.push(queue('pending', '?status=pending', t('inbox.pending') || 'Pending', Clock, !q && !f && st === 'pending'));
    queues.push(queue('resolved', '?status=resolved', t('inbox.resolved') || 'Resolved', Check, !q && !f && st === 'resolved'));
    queues.push(queue('spam', '?queue=spam', t('inbox.spamInbox') || 'Spam', Ban, q === 'spam', {
      badge: inboxCounts?.spam ?? 0,
    }));
    if (colleaguesQueueVisible(plan)) {
      queues.push(queue('colleagues', '?filter=colleagues', t('inbox.colleagues') || 'Colleagues', Users, f === 'colleagues', {
        group: 'internal',
      }));
    }
    for (const p of pluginCatalog || []) {
      if (!channelInboxVisible(p, plan)) continue;
      const key = (p.slug || p.id).toLowerCase();
      queues.push(queue(`channel:${key}`, `?channel=${encodeURIComponent(key)}`,
        channelLabel(key as ChannelKey) || p.slug || p.id, MessageSquare, ch === key, { group: 'channel' }));
    }
  }

  return {
    /** False until the plan snapshot is known; gated entries wait for it. */
    ready: sections.ready,
    primary,
    utility,
    settings,
    /** Platform admins also get the way to Super Admin. */
    superAdmin: !!isGlobalAdmin,
    /** Workspace admins can create workspaces and invite operators. */
    isWorkspaceAdmin: sections.isAdmin,
    onInbox,
    queues,
  };
}

export type ArtNav = ReturnType<typeof useArtNav>;
