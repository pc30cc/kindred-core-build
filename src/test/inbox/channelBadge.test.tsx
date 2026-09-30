import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import {
  ChannelBadge, ChannelIdentityCard, channelLabel, resolveChannelKey,
} from '@/components/inbox/ChannelBadge';
import { resolveClientPlatform } from '@/components/inbox/clientPlatform';

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

describe('the app a site user wrote from', () => {
  it('is read from the conversation first, then the contact', () => {
    expect(resolveClientPlatform({ client_platform: 'android' })).toBe('android');
    expect(resolveClientPlatform({ client_platform: 'ios' }, { client_platform: 'android' })).toBe('ios');
    expect(resolveClientPlatform({}, { client_platform: 'macos' })).toBe('macos');
    expect(resolveClientPlatform(null, { client_platform: ' Windows ' })).toBe('windows');
    expect(resolveClientPlatform({ client_platform: 'linux' }, { client_platform: 'web' })).toBe('web');
  });

  it('is unknown rather than guessed', () => {
    expect(resolveClientPlatform()).toBeNull();
    expect(resolveClientPlatform({ client_platform: 'linux' })).toBeNull();
    expect(resolveClientPlatform({ client_platform: 42 })).toBeNull();
    expect(resolveClientPlatform({ client_platform: 'constructor' })).toBeNull();
  });

  it('follows "Site user", untranslated like any product name, in every language', () => {
    expect(channelLabel('platform_support', T.en, 'android')).toBe('Site user · Android');
    expect(channelLabel('platform_support', T.fa, 'android')).toBe('کاربر سایت · Android');
    expect(channelLabel('platform_support', T.tr, 'android')).toBe('Site kullanıcısı · Android');
    expect(channelLabel('platform_support', T.en, 'ios')).toBe('Site user · iOS');
    expect(channelLabel('platform_support', T.en, 'macos')).toBe('Site user · macOS');
    expect(channelLabel('platform_support', T.en, 'windows')).toBe('Site user · Windows');
    expect(channelLabel('platform_support', T.en, 'web')).toBe('Site user · Web');
  });

  it('leaves the plain label when unknown, and other channels alone', () => {
    expect(channelLabel('platform_support', T.en, null)).toBe('Site user');
    expect(channelLabel('platform_support', T.en)).toBe('Site user');
    expect(channelLabel('telegram', T.en, 'android')).toBe('Telegram');
  });

  it('is on the badge beside the name', () => {
    render(<ChannelBadge channel="platform_support" t={T.fa} clientPlatform="android" size="xs" />);
    expect(screen.getByText('کاربر سایت · Android')).toBeTruthy();
    expect(screen.getByTitle('کاربر سایت · Android')).toBeTruthy();
  });
});

describe('ChannelIdentityCard for a site user', () => {
  const metadata = {
    source: 'platform_support',
    channel: 'platform_support',
    platform_user_id: 'u-1',
    platform_workspace_id: 'w-1',
    platform_workspace_name: 'فروشگاه نمونه',
    client_platform: 'ios',
  };

  it('shows the workspace and the app they wrote from', () => {
    render(<ChannelIdentityCard metadata={metadata} t={T.en} />);
    expect(screen.getByText('Site user')).toBeTruthy();
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('فروشگاه نمونه')).toBeTruthy();
    expect(screen.getByText('App')).toBeTruthy();
    expect(screen.getByText('iOS')).toBeTruthy();
  });

  it('labels the rows in the reader\'s language', () => {
    render(<ChannelIdentityCard metadata={metadata} t={T.fa} dir="rtl" />);
    expect(screen.getByText('کاربر سایت')).toBeTruthy();
    expect(screen.getByText('فضای کاری')).toBeTruthy();
    expect(screen.getByText('اپ')).toBeTruthy();
  });

  it('leaves out what it does not know', () => {
    render(<ChannelIdentityCard metadata={{ channel: 'platform_support' }} t={T.tr} />);
    expect(screen.getByText('Site kullanıcısı')).toBeTruthy();
    expect(screen.queryByText('Çalışma alanı')).toBeNull();
    expect(screen.queryByText('Uygulama')).toBeNull();
  });

  it('shows no app row for other channels', () => {
    render(<ChannelIdentityCard metadata={{ channel: 'telegram', client_platform: 'android' }} t={T.en} />);
    expect(screen.queryByText('App')).toBeNull();
  });
});
