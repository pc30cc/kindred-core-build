/**
 * Native (iOS) contact profile — a phone-first replacement for the desktop
 * contact detail page: hero card, channel chips, info group and chat history.
 */
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Mail, Phone, MapPin, Building2, Calendar, MessageSquare } from 'lucide-react';

import { useTranslation } from '@/i18n';
import { useContact, useContactConversations } from '@/hooks/useContacts';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { getDisplayName, getCompanyFromMetadata, getLocalizedLocation } from '@/features/contacts/utils';
import { formatDate, formatRelative } from '@/lib/date';
import { Skeleton } from '@/components/ui/skeleton';
import { MobileScreen, MobileGroup, MobileRow } from './MobileScreen';

export default function MobileContactDetailPage() {
  const { t, locale, dir } = useTranslation();
  const navigate = useNavigate();
  const { slug, id } = useParams<{ slug: string; id: string }>();

  const { data: contact, isLoading } = useContact(id);
  const { data: conversations } = useContactConversations(id);

  const BackIcon = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const name = contact ? getDisplayName(contact as any, t as any, locale as any) : '';
  const company = contact ? getCompanyFromMetadata(contact as any) : null;
  const location = contact ? getLocalizedLocation(contact as any, locale as any) : null;

  return (
    <MobileScreen
      compact
      centered
      title={t('nav.profile')}
      leading={
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-full p-1.5 text-primary transition-transform active:scale-90"
          aria-label="Back"
        >
          <BackIcon className="h-7 w-7" />
        </button>
      }
      bodyClassName="pb-10"
    >
      {isLoading || !contact ? (
        <div className="space-y-3 px-4 pt-4">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      ) : (
        <>
          <div className="px-4 pt-4">
            <div className="flex items-center gap-4 rounded-2xl bg-card p-4 shadow-[0_1px_2px_hsl(220_40%_20%/0.06),0_8px_24px_-16px_hsl(220_40%_20%/0.35)]">
              <ContactAvatar
                name={(contact as any).name}
                email={(contact as any).email}
                avatarUrl={(contact as any).avatar_url}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[19px] font-bold text-foreground">{name}</p>
                {(contact as any).email && (
                  <p className="truncate text-[14px] text-muted-foreground" dir="ltr">
                    {(contact as any).email}
                  </p>
                )}
                {(contact as any).phone && (
                  <p className="truncate text-[14px] text-muted-foreground" dir="ltr">
                    {(contact as any).phone}
                  </p>
                )}
              </div>
            </div>
          </div>

          <MobileGroup title={t('contacts.tabInfo')}>
            {(contact as any).email && (
              <MobileRow icon={Mail} label={t('contacts.email')} value={<span dir="ltr">{(contact as any).email}</span>} />
            )}
            {(contact as any).phone && (
              <MobileRow icon={Phone} label={t('contacts.phone')} value={<span dir="ltr">{(contact as any).phone}</span>} />
            )}
            {company && <MobileRow icon={Building2} label={t('contacts.company')} value={company} />}
            {location && <MobileRow icon={MapPin} label={t('contacts.location')} value={`${location.flag ?? ''} ${location.label ?? ''}`.trim()} />}
            <MobileRow
              icon={Calendar}
              label={t('contacts.createdAt')}
              value={formatDate((contact as any).created_at)}
            />
          </MobileGroup>

          <MobileGroup title={t('contacts.conversationHistory')}>
            {(conversations ?? []).length === 0 ? (
              <p className="px-4 py-4 text-[14px] text-muted-foreground">
                {t('contacts.noConversations')}
              </p>
            ) : (
              (conversations ?? []).map((c: any) => (
                <MobileRow
                  key={c.id}
                  icon={MessageSquare}
                  onClick={() => navigate(`/${slug}/inbox/${c.id}`)}
                  label={(c.subject || '').trim() || t('contacts.conversationUntitled')}
                  value={formatRelative(c.updated_at || c.created_at)}
                />
              ))
            )}
          </MobileGroup>
        </>
      )}
    </MobileScreen>
  );
}
