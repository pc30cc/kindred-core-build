import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { ChannelIdentityCard, channelLabel, resolveChannelKey } from '@/components/inbox/ChannelBadge';

/**
 * An operator of another workspace writing to the platform's own team is a
 * channel of its own (docs/PLATFORM_SUPPORT.md): `platform_support` on the
 * conversation and on the contact, shown as "Site user". Before it had a key
 * it fell through to 'widget', and the inbox hides the badge for the widget,
 * so the team could not tell these people from visitors on the website.
 */

/** Resolves a dotted key the way the app's lookup does: the key itself on a miss. */
function translator(bundle: Record<string, unknown>) {
  return (key: string) => {
    let current: unknown = bundle;
    for (const part of key.split('.')) current = (current as Record<string, unknown> | undefined)?.[part];
    return typeof current === 'string' ? current : key;
  };
}
const T = {
  en: translator(en as Record<string, unknown>),
  fa: translator(fa as Record<string, unknown>),
  tr: translator(tr as Record<string, unknown>),
};

describe('resolveChannelKey', () => {
  it('knows platform support from the conversation, the contact, or the contact\'s source', () => {
    expect(resolveChannelKey({ channel: 'platform_support' })).toBe('platform_support');
    expect(resolveChannelKey({}, { channel: 'platform_support' })).toBe('platform_support');
    expect(resolveChannelKey(null, { source: 'platform_support' })).toBe('platform_support');
    expect(resolveChannelKey({ channel: 'PLATFORM_SUPPORT' })).toBe('platform_support');
  });

  it('lets the conversation\'s channel win over the contact\'s', () => {
    // A widget visitor adopted as an operator keeps the conversations they had.
    expect(resolveChannelKey({ channel: 'telegram' }, { channel: 'platform_support' })).toBe('telegram');
  });

  it('still falls back to the widget for anything it does not know', () => {
    expect(resolveChannelKey()).toBe('widget');
    expect(resolveChannelKey({ channel: 'carrier_pigeon' })).toBe('widget');
    // Names on Object.prototype are not channels.
    expect(resolveChannelKey({ channel: 'constructor' })).toBe('widget');
    expect(resolveChannelKey({ source: 'toString' })).toBe('widget');
  });
});

describe('channelLabel', () => {
  it('calls platform support "Site user" in every language', () => {
    expect(channelLabel('platform_support', T.en)).toBe('Site user');
    expect(channelLabel('platform_support', T.fa)).toBe('کاربر سایت');
    expect(channelLabel('platform_support', T.tr)).toBe('Site kullanıcısı');
  });

  it('has an English label without a translator, and never shows a raw key', () => {
    expect(channelLabel('platform_support')).toBe('Site user');
    expect(channelLabel('platform_support', (key) => key)).toBe('Site user');
    expect(channelLabel('widget', T.fa)).toBe('ویجت چت');
    expect(channelLabel('telegram', T.fa)).toBe('Telegram');
  });
});

describe('ChannelIdentityCard for a site user', () => {
  const metadata = {
    source: 'platform_support',
    channel: 'platform_support',
    platform_user_id: 'u-1',
    platform_workspace_id: 'w-1',
    platform_workspace_name: 'فروشگاه نمونه',
  };

  it('shows the workspace they wrote from', () => {
    render(<ChannelIdentityCard metadata={metadata} t={T.en} />);
    expect(screen.getByText('Site user')).toBeTruthy();
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('فروشگاه نمونه')).toBeTruthy();
  });

  it('labels the rows in the reader\'s language', () => {
    render(<ChannelIdentityCard metadata={metadata} t={T.fa} dir="rtl" />);
    expect(screen.getByText('کاربر سایت')).toBeTruthy();
    expect(screen.getByText('فضای کاری')).toBeTruthy();
  });

  it('leaves out what it does not know', () => {
    render(<ChannelIdentityCard metadata={{ channel: 'platform_support' }} t={T.tr} />);
    expect(screen.getByText('Site kullanıcısı')).toBeTruthy();
    expect(screen.queryByText('Çalışma alanı')).toBeNull();
  });
});
