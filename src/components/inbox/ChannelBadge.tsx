/**
 * Channel origin presentation — one source of truth for "where did this
 * person write from" across Inbox, Contacts list and the contact drawer.
 *
 * Channel is stored by the canonical inbound pipeline on both
 * `conversations.metadata.channel` and `contacts.metadata.channel`.
 */
import { MessageSquare, Send, Mail, Phone, MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ChannelKey = 'telegram' | 'whatsapp' | 'email' | 'phone' | 'widget';

const META: Record<ChannelKey, { icon: typeof Send; label: string; className: string }> = {
  telegram: {
    icon: Send,
    label: 'Telegram',
    className: 'bg-[hsl(200_90%_50%/0.12)] text-[hsl(200_90%_40%)] border-[hsl(200_90%_50%/0.25)]',
  },
  whatsapp: {
    icon: MessageCircle,
    label: 'WhatsApp',
    className: 'bg-success/10 text-success border-success/25',
  },
  email: { icon: Mail, label: 'Email', className: 'bg-secondary text-muted-foreground border-border' },
  phone: { icon: Phone, label: 'Phone', className: 'bg-secondary text-muted-foreground border-border' },
  widget: {
    icon: MessageSquare,
    label: 'Chat widget',
    className: 'bg-primary/10 text-primary border-primary/20',
  },
};

/** Reads the channel from a conversation/contact metadata blob. */
export function resolveChannelKey(...sources: Array<unknown>): ChannelKey {
  for (const src of sources) {
    const meta = (src ?? {}) as Record<string, unknown>;
    const raw = String(meta.channel ?? meta.source ?? '').toLowerCase();
    if (raw in META) return raw as ChannelKey;
  }
  return 'widget';
}

export function channelLabel(channel: ChannelKey, t?: (k: string) => string | undefined): string {
  if (channel === 'widget') return t?.('contacts.sourceChat') || META.widget.label;
  return META[channel].label;
}

export function ChannelBadge({
  channel,
  t,
  size = 'sm',
  className,
}: {
  channel: ChannelKey;
  t?: (k: string) => string | undefined;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const meta = META[channel];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap',
        size === 'xs' ? 'px-1.5 py-[1px] text-[10px]' : 'px-2 py-0.5 text-[11px]',
        meta.className,
        className,
      )}
      title={channelLabel(channel, t)}
    >
      <Icon className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      {channelLabel(channel, t)}
    </span>
  );
}

/** Small icon-only variant for dense rows. */
export function ChannelIcon({ channel, className }: { channel: ChannelKey; className?: string }) {
  const Icon = META[channel].icon;
  return <Icon className={cn('w-3.5 h-3.5', className)} />;
}

type ChannelMeta = Record<string, unknown> | null | undefined;

/** Provider-side identity rows (Telegram username, id, language, premium). */
export function ChannelIdentityCard({
  metadata,
  t,
  dir = 'ltr',
  className,
}: {
  metadata: ChannelMeta;
  t: (k: string) => string | undefined;
  dir?: 'rtl' | 'ltr';
  className?: string;
}) {
  const meta = (metadata ?? {}) as Record<string, any>;
  const channel = resolveChannelKey(meta);
  if (channel === 'widget') return null;

  const rows: Array<{ label: string; value: string }> = [];
  if (meta.channel_username) rows.push({ label: t('contacts.username') || 'Username', value: `@${meta.channel_username}` });
  if (meta.channel_user_id) rows.push({ label: t('contacts.channelUserId') || 'User ID', value: String(meta.channel_user_id) });
  if (meta.channel_language) rows.push({ label: t('contacts.channelLanguage') || 'Language', value: String(meta.channel_language) });
  if (meta.channel_is_premium) rows.push({ label: 'Premium', value: '✓' });

  return (
    <div className={cn('rounded-xl border border-border/50 bg-card/60 divide-y divide-border/20', className)} dir={dir}>
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[11.5px] text-muted-foreground">{t('contacts.channel') || 'Channel'}</span>
        <ChannelBadge channel={channel} t={t} />
      </div>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="text-[11.5px] text-muted-foreground shrink-0">{row.label}</span>
          <bdi dir="ltr" className="text-[12.5px] font-medium text-foreground truncate">{row.value}</bdi>
        </div>
      ))}
    </div>
  );
}
