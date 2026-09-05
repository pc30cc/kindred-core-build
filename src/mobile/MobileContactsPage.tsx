/**
 * Native (iOS) contacts list — phone-first replacement for the desktop table.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Users, ChevronLeft, ChevronRight } from 'lucide-react';

import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useContacts } from '@/hooks/useContacts';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { getDisplayName, timeAgo } from '@/features/contacts/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { MobileScreen } from './MobileScreen';
import { MobileSearchField } from './MobileSearchField';

export default function MobileContactsPage() {
  const { t, dir, locale } = useTranslation();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const workspace = useCurrentWorkspace();
  const { data: contacts, isLoading } = useContacts(workspace?.id);
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const list = contacts ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c: any) =>
      [c.name, c.email, c.phone].some((v: string | null) => (v || '').toLowerCase().includes(q)),
    );
  }, [contacts, query]);

  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  return (
    <MobileScreen
      title={t('nav.contacts')}
      subtitle={contacts ? `${contacts.length}` : undefined}
      toolbar={<MobileSearchField value={query} onChange={setQuery} placeholder={t('contacts.searchPlaceholder')} />}
      bodyClassName="pb-[104px]"
    >
      {isLoading ? (
        <div className="space-y-2 px-4 pt-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-2xl bg-card p-3">
              <Skeleton className="h-11 w-11 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Users} label={t('contacts.emptyTitle')} />
      ) : (
        <ul className="mt-3 overflow-hidden border-y border-border bg-card divide-y divide-border">
          {rows.map((c: any) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => navigate(`/${slug}/contacts/${c.id}`)}
                className="flex w-full items-center gap-3 px-4 py-3 text-start active:bg-muted"
              >
                <ContactAvatar name={c.name} email={c.email} avatarUrl={c.avatar_url} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[16px] font-semibold text-foreground">
                    {getDisplayName(c as any, t as any, locale as any)}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground" dir="ltr">
                    {c.email || c.phone || '—'}
                  </p>
                </div>
                {c.last_seen_at && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {timeAgo(c.last_seen_at)}
                  </span>
                )}
                <Chevron className="h-4 w-4 shrink-0 text-muted-foreground/60" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </MobileScreen>
  );
}

export function EmptyState({
  icon: Icon,
  label,
}: {
  icon: typeof Users;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-8 pt-24 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
        <Icon className="h-8 w-8 text-primary" />
      </div>
      <p className="text-[15px] text-muted-foreground">{label}</p>
    </div>
  );
}
