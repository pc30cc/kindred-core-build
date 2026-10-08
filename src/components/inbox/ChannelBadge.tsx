/**
 * Channel origin presentation — one source of truth for "where did this
 * person write from" across Inbox, Contacts list and the contact drawer.
 *
 * Channel is stored by the canonical inbound pipeline on both
 * `conversations.metadata.channel` and `contacts.metadata.channel`.
 * `platform_support` is an operator of another workspace writing to the
 * platform's own team (docs/PLATFORM_SUPPORT.md): shown as "Site user", with
 * the app they wrote from when it is known ("Site user · Android").
 */
import { MessageSquare, Send, Mail, Phone, MessageCircle, Instagram, AtSign, LifeBuoy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CLIENT_PLATFORM_NAMES, resolveClientPlatform, type ClientPlatform } from './clientPlatform';

export type ChannelKey =
  | 'telegram'
  | 'bale'
  | 'whatsapp'
  | 'instagram'
  | 'x'
  | 'email'
  | 'phone'
  | 'platform_support'
  | 'widget';

const META: Record<ChannelKey, { icon: typeof Send; label: string; className: string }> = {
  telegram: {
    icon: Send,
    label: 'Telegram',
    className: 'bg-[hsl(200_90%_50%/0.12)] text-[hsl(200_90%_40%)] border-[hsl(200_90%_50%/0.25)]',
  },
  bale: {
    icon: Send,
    label: 'بله',
    className: 'bg-[hsl(150_60%_45%/0.12)] text-[hsl(150_60%_32%)] border-[hsl(150_60%_45%/0.25)]',
  },
  whatsapp: {
    icon: MessageCircle,
    label: 'WhatsApp',
    className: 'bg-success/10 text-success border-success/25',
  },
  instagram: {
    icon: Instagram,
    label: 'Instagram',
    className: 'bg-[hsl(330_75%_55%/0.12)] text-[hsl(330_75%_45%)] border-[hsl(330_75%_55%/0.25)]',
  },
  x: {
    icon: AtSign,
    label: 'X (Twitter)',
    className: 'bg-[hsl(0_0%_9%/0.08)] text-[hsl(0_0%_9%)] border-[hsl(0_0%_9%/0.2)] dark:bg-white/10 dark:text-white dark:border-white/20',
  },
  email: { icon: Mail, label: 'Email', className: 'bg-secondary text-muted-foreground border-border' },

  phone: { icon: Phone, label: 'Phone', className: 'bg-secondary text-muted-foreground border-border' },
  platform_support: {
    icon: LifeBuoy,
    label: 'Site user',
    className: 'bg-[hsl(262_70%_58%/0.12)] text-[hsl(262_60%_48%)] border-[hsl(262_70%_58%/0.25)]',
  },
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
    if (Object.prototype.hasOwnProperty.call(META, raw)) return raw as ChannelKey;
  }
  return 'widget';
}


/** Channels whose name is a word, not a brand, and so is translated. */
const LABEL_KEYS: Partial<Record<ChannelKey, string>> = {
  widget: 'contacts.sourceChat',
  platform_support: 'contacts.sourcePlatformSupport',
};

/**
 * The channel's name. For platform support, `clientPlatform` adds the app
 * the operator wrote from ("Site user · Android"); other channels ignore it.
 */
export function channelLabel(
  channel: ChannelKey,
  t?: (k: string) => string | undefined,
  clientPlatform?: ClientPlatform | null,
): string {
  const key = LABEL_KEYS[channel];
  const translated = key ? t?.(key) : undefined;
  // The i18n lookup answers a missing key with the key itself.
  const label = translated && translated !== key ? translated : META[channel].label;
  return channel === 'platform_support' && clientPlatform
    ? `${label} · ${CLIENT_PLATFORM_NAMES[clientPlatform]}`
    : label;
}

export function ChannelBadge({
  channel,
  t,
  clientPlatform,
  size = 'sm',
  className,
}: {
  channel: ChannelKey;
  t?: (k: string) => string | undefined;
  /** Platform support only: the app the operator wrote from (`resolveClientPlatform`). */
  clientPlatform?: ClientPlatform | null;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const meta = META[channel];
  const Icon = meta.icon;
  const label = channelLabel(channel, t, clientPlatform);
  return (
    <span
      // Theme hook (src/themes/art/inbox.css): Art draws channel chips as
      // neutral pills and keeps the channel's colour on the icon only.
      data-channel-badge={channel}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap',
        size === 'xs' ? 'px-1.5 py-[1px] text-[10px]' : 'px-2 py-0.5 text-[11px]',
        meta.className,
        className,
      )}
      title={label}
    >
      <Icon className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      {label}
    </span>
  );
}

/** Small icon-only variant for dense rows. */
export function ChannelIcon({ channel, className }: { channel: ChannelKey; className?: string }) {
  const Icon = META[channel].icon;
  return <Icon className={cn('w-3.5 h-3.5', className)} />;
}

type ChannelMeta = Record<string, unknown> | null | undefined;

/**
 * Provider-side identity rows (Telegram username, id, language, premium).
 * For a platform-support contact: the workspace and the app the operator
 * wrote from — their email is on the contact itself.
 */
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
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const channel = resolveChannelKey(meta);
  if (channel === 'widget') return null;

  // `auto` for names people typed, which may be Persian; `ltr` for handles and ids.
  const rows: Array<{ label: string; value: string; valueDir?: 'ltr' | 'auto' }> = [];
  if (channel === 'platform_support') {
    const workspaceName = typeof meta.platform_workspace_name === 'string' ? meta.platform_workspace_name.trim() : '';
    if (workspaceName) rows.push({ label: t('contacts.platformWorkspace') || 'Workspace', value: workspaceName, valueDir: 'auto' });
    const clientPlatform = resolveClientPlatform(meta);
    if (clientPlatform) rows.push({ label: t('contacts.platformClient') || 'App', value: CLIENT_PLATFORM_NAMES[clientPlatform] });
  }
  if (meta.channel_username) rows.push({ label: t('contacts.username') || 'Username', value: `@${meta.channel_username}` });
  if (meta.channel_user_id) rows.push({ label: t('contacts.channelUserId') || 'User ID', value: String(meta.channel_user_id) });
  if (meta.channel_language) rows.push({ label: t('contacts.channelLanguage') || 'Language', value: String(meta.channel_language) });
  if (meta.channel_is_premium) rows.push({ label: 'Premium', value: '✓' });

  return (
    <div data-inbox-fact="channel" className={cn('rounded-xl border border-border/50 bg-card/60 divide-y divide-border/20', className)} dir={dir}>
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[11.5px] text-muted-foreground">{t('contacts.channel') || 'Channel'}</span>
        <ChannelBadge channel={channel} t={t} />
      </div>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="text-[11.5px] text-muted-foreground shrink-0">{row.label}</span>
          <bdi dir={row.valueDir ?? 'ltr'} className="text-[12.5px] font-medium text-foreground truncate">{row.value}</bdi>
        </div>
      ))}
    </div>
  );
}
