/**
 * Native (iOS) inbox list.
 *
 * Phone-first rewrite of the desktop three-column Inbox: a pinned navigation
 * bar, live search, an iOS segmented filter and one full-bleed conversation
 * list. Opening a row pushes the thread screen (MobileConversationPage).
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Inbox as InboxIcon, MoreHorizontal, Bot } from 'lucide-react';

import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useConversations, type InboxQueue } from '@/hooks/useConversations';
import { useInboxListRealtime } from '@/hooks/useInboxListRealtime';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { ChannelBadge, resolveChannelKey } from '@/components/inbox/ChannelBadge';
import { contactDisplayName } from '@/lib/contact-display';
import { formatRelative } from '@/lib/date';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MobileScreen, MobileNavButton } from './MobileScreen';
import { MobileSearchField } from './MobileSearchField';
import { MobileSegmented } from './MobileSegmented';

type MobileFilter = 'open' | 'ai' | 'resolved';

const QUEUES: Record<MobileFilter, { queue: InboxQueue; status?: string }> = {
  open: { queue: 'main', status: 'open' },
  ai: { queue: 'automated' },
  resolved: { queue: 'main', status: 'resolved' },
};

export default function MobileInboxPage() {
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const workspace = useCurrentWorkspace();

  const [filter, setFilter] = useState<MobileFilter>('open');
  const [query, setQuery] = useState('');

  const active = QUEUES[filter];
  const { data: conversations, isLoading } = useConversations(
    workspace?.id,
    active.status,
    active.queue,
  );
  useInboxListRealtime(workspace?.id);

  const rows = useMemo(() => {
    const list = conversations ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c: any) => {
      const name = contactDisplayName(c.contacts, c.id, t as any, c.visitor_country_name, locale);
      return (
        name.toLowerCase().includes(q) ||
        (c.last_message?.body || '').toLowerCase().includes(q) ||
        (c.contacts?.email || '').toLowerCase().includes(q)
      );
    });
  }, [conversations, query, t, locale]);

  return (
    <MobileScreen
      centered
      title={workspace?.name || t('nav.inbox')}
      actions={<MobileNavButton icon={MoreHorizontal} label={t('nav.settings')} onClick={() => navigate(`/${slug}/settings`)} />}
      toolbar={
        <div className="space-y-2.5">
          <MobileSearchField value={query} onChange={setQuery} placeholder={t('inbox.search')} />
          <MobileSegmented<MobileFilter>
            value={filter}
            onChange={setFilter}
            options={[
              { key: 'open', label: t('inbox.open') },
              { key: 'ai', label: t('inbox.aiManaged') },
              { key: 'resolved', label: t('inbox.resolved') },
            ]}
          />
        </div>
      }
      bodyClassName="pb-[104px]"
    >
      {isLoading ? (
        <div className="divide-y divide-border/70 bg-card">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-[52px] w-[52px] rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 pt-28 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <InboxIcon className="h-8 w-8 text-primary" />
          </div>
          <p className="text-[15px] text-muted-foreground">{t('inbox.emptyNoConversations')}</p>
        </div>
      ) : (
        <ul className="bg-card divide-y divide-border/70">
          {rows.map((c: any) => {
            const name = contactDisplayName(c.contacts, c.id, t as any, c.visitor_country_name, locale);
            const unread = c.unread_count || 0;
            const last = c.last_message;
            const channel = resolveChannelKey(c.metadata, c.contacts?.metadata);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/${slug}/inbox/${c.id}`)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-start transition-colors active:bg-muted/70"
                >
                  <ContactAvatar
                    name={c.contacts?.name}
                    email={c.contacts?.email}
                    avatarUrl={c.contacts?.avatar_url}
                    os={c.visitor_os}
                    device={c.visitor_device}
                    countryCode={c.visitor_country_code}
                    countryName={c.visitor_country_name}
                    size="lg"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          'truncate text-[16px] text-foreground',
                          unread > 0 ? 'font-bold' : 'font-semibold',
                        )}
                      >
                        {name}
                      </span>
                      <span className="ms-auto shrink-0 text-[12px] text-muted-foreground">
                        {formatRelative(last?.created_at || c.updated_at)}
                      </span>
                    </div>

                    <div className="mt-0.5 flex items-start gap-2">
                      <p
                        className={cn(
                          'line-clamp-2 flex-1 text-[14px] leading-snug',
                          unread > 0 ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {last?.sender_type === 'ai' && (
                          <Bot className="me-1 inline h-3.5 w-3.5 -translate-y-px text-primary" />
                        )}
                        {last?.sender_type === 'agent' ? '↩ ' : ''}
                        {last?.body || '—'}
                      </p>
                      {unread > 0 && (
                        <span className="mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
                          {unread}
                        </span>
                      )}
                    </div>

                    <div className="mt-1.5 flex justify-end">
                      <ChannelBadge channel={channel} t={t as any} size="xs" />
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </MobileScreen>
  );
}
