/**
 * Native (iOS) inbox list.
 *
 * A phone-first rewrite of the desktop three-column Inbox: one scrollable
 * list of conversations, a greeting header, live search and quick filters.
 * Opening a row pushes the thread screen (MobileConversationPage).
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search, Inbox as InboxIcon, Bot, CheckCircle2, MessageCircle, X } from 'lucide-react';

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

type MobileFilter = 'open' | 'ai' | 'resolved';

const FILTERS: { key: MobileFilter; queue: InboxQueue; status?: string; icon: typeof InboxIcon }[] = [
  { key: 'open', queue: 'main', status: 'open', icon: MessageCircle },
  { key: 'ai', queue: 'automated', icon: Bot },
  { key: 'resolved', queue: 'main', status: 'resolved', icon: CheckCircle2 },
];

export default function MobileInboxPage() {
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const workspace = useCurrentWorkspace();

  const [filter, setFilter] = useState<MobileFilter>('open');
  const [query, setQuery] = useState('');

  const active = FILTERS.find((f) => f.key === filter)!;
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

  const unreadTotal = (conversations ?? []).reduce(
    (sum: number, c: any) => sum + (c.unread_count || 0),
    0,
  );

  const FILTER_LABEL: Record<MobileFilter, string> = {
    open: t('inbox.open'),
    ai: t('inbox.aiManaged'),
    resolved: t('inbox.resolved'),
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <header className="shrink-0 px-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-3 bg-gradient-to-b from-primary/10 to-transparent">
        <p className="text-[13px] font-medium text-primary/80">Welcome Back To</p>
        <h1 className="text-[26px] font-bold tracking-tight text-foreground leading-tight">
          WebYar Ai
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {unreadTotal > 0
            ? `${unreadTotal} ${t('inbox.unread')}`
            : workspace?.name || ''}
        </p>

        {/* Search */}
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('inbox.search')}
            className="h-11 w-full rounded-2xl border border-border bg-card ps-10 pe-10 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute end-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground active:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Filter chips */}
        <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full px-3.5 h-9 text-[14px] font-medium transition-colors',
                filter === f.key
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-card border border-border text-muted-foreground',
              )}
            >
              <f.icon className="h-4 w-4" />
              {FILTER_LABEL[f.key]}
            </button>
          ))}
        </div>
      </header>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
        {isLoading ? (
          <div className="space-y-2 pt-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-2xl bg-card p-3">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 pt-24 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <InboxIcon className="h-8 w-8 text-primary" />
            </div>
            <p className="text-[15px] text-muted-foreground">{t('inbox.emptyNoConversations')}</p>
          </div>
        ) : (
          <ul className="space-y-2 pt-2">
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
                    className={cn(
                      'flex w-full items-center gap-3 rounded-2xl border p-3 text-start transition-colors active:bg-muted',
                      unread > 0 ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-card',
                    )}
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
                      <div className="flex items-center gap-2">
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
                      <div className="mt-1 flex items-center gap-2">
                        <p
                          className={cn(
                            'truncate text-[14px]',
                            unread > 0 ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {last?.sender_type === 'agent' ? '↩ ' : ''}
                          {last?.body || '—'}
                        </p>
                        {unread > 0 && (
                          <span className="ms-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
                            {unread}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5">
                        <ChannelBadge channel={channel} t={t as any} size="xs" />
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
