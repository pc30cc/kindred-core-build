/**
 * Canned responses for anonymous visitors (I-08) and in the conversation's
 * language (I-14).
 *
 * I-08 — most visitors are anonymous. An operator typed /hello and Enter,
 * and the visitor read «سلام {{contact.name}}، ممنون که پیام دادید!»: an
 * unknown value left the placeholder in place and nothing checked before
 * sending. Now a variable without a value takes its default
 * (`{{contact.name|default:"…"}}`) or is left out with its space; a
 * placeholder that still cannot resolve (a typo) is caught before sending;
 * the editor shows what an anonymous visitor would read.
 *
 * I-14 — replies were ranked by the operator's panel language, so on
 * RESPOK an English panel answering a Turkish widget saw English first.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import en from '@/i18n/locales/en';
import { interpolate, unresolvedPlaceholders, type InterpolationContext } from '@/components/canned-responses/interpolation';
import { conversationReplyLocale, detectReplyLocale, replyLocaleOf } from '@/lib/inboxLanguage';

function bundleT(bundle: unknown) {
  return (key: string): string => {
    let current: unknown = bundle;
    for (const part of key.split('.')) current = (current as Record<string, unknown> | undefined)?.[part];
    return typeof current === 'string' ? current : key;
  };
}

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: bundleT(en), dir: 'ltr', locale: 'en' }) }));
vi.mock('@/hooks/usePlatformRegion', () => ({ usePlatformRegion: () => ({ allowedLocales: ['en', 'fa', 'tr'], canSwitchLanguage: true }) }));

// The form's switch measures itself (Radix); jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const { CannedResponseForm } = await import('@/components/canned-responses/CannedResponseForm');

afterEach(cleanup);

const anonymous: InterpolationContext = {
  contact: { name: null, email: null },
  workspace: { name: 'Acme' },
  agent: { name: 'Sara Karimi', email: 'sara@acme.test' },
};

describe('a variable without a value never reaches the visitor as braces', () => {
  it('is left out, with the space before a comma or a full stop', () => {
    expect(interpolate('Hi {{contact.name}}, thanks for writing!', anonymous)).toBe('Hi, thanks for writing!');
    expect(interpolate('سلام {{contact.name}}، ممنون که پیام دادید!', anonymous)).toBe('سلام، ممنون که پیام دادید!');
    expect(interpolate('Hello {{contact.name}}!', anonymous)).toBe('Hello!');
    expect(interpolate('Dear {{ contact.name }} team', anonymous)).toBe('Dear team');
    expect(interpolate('{{contact.name}} welcome to {{workspace.name}}', anonymous)).toBe('welcome to Acme');
  });

  it('takes its default when it has one, in either quote style', () => {
    expect(interpolate('Hi {{contact.name|default:"there"}}, thanks!', anonymous)).toBe('Hi there, thanks!');
    expect(interpolate("سلام {{ contact.name | default: 'دوست عزیز' }}، خوش آمدید", anonymous)).toBe('سلام دوست عزیز، خوش آمدید');
    expect(interpolate('Hi {{contact.name|fallback:"friend"}}', anonymous)).toBe('Hi friend');
  });

  it('a real value wins over the default', () => {
    const known = { ...anonymous, contact: { name: 'Ali', email: 'ali@x.test' } };
    expect(interpolate('Hi {{contact.name|default:"there"}}, {{contact.email}}', known)).toBe('Hi Ali, ali@x.test');
    expect(interpolate('— {{agent.first_name}}', known)).toBe('— Sara');
  });

  it('an unknown variable stays for the operator to see, and blocks the send', () => {
    const typo = interpolate('Hi {{contact.nmae}}, thanks', anonymous);
    expect(typo).toBe('Hi {{contact.nmae}}, thanks');
    expect(unresolvedPlaceholders(typo)).toEqual(['{{contact.nmae}}']);
    expect(unresolvedPlaceholders('Hi, thanks')).toEqual([]);
    // Braces of another kind (a template the operator talks about) are not ours.
    expect(unresolvedPlaceholders('Use {{order.id}} in your theme')).toEqual([]);
  });
});

describe('the canned response editor', () => {
  it('shows what an anonymous visitor reads, and how to give a default', () => {
    render(<CannedResponseForm defaultLocale="en" submitLabel="Save" onSubmit={() => {}} onCancel={() => {}} />);
    const body = document.getElementById('cr-body') as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'Hi {{contact.name}}, welcome to {{workspace.name}}!' } });
    const anon = document.querySelector('[data-canned="preview-anonymous"]');
    expect(anon?.textContent).toBe('Hi, welcome to Acme Support!');
    expect(document.body.textContent).toContain('{{contact.name|default:"there"}}');
    // Without a contact variable there is nothing to show.
    fireEvent.change(body, { target: { value: 'Thanks for waiting.' } });
    expect(document.querySelector('[data-canned="preview-anonymous"]')).toBeNull();
  });
});

describe('the language a conversation is answered in', () => {
  it('reads the visitor\'s own words', () => {
    expect(detectReplyLocale('سلام، سفارشم کی می‌رسد؟')).toBe('fa');
    expect(detectReplyLocale('Merhaba, siparişim ne zaman gelir?')).toBe('tr');
    expect(detectReplyLocale('Hi, where is my order?')).toBe('en');
    expect(detectReplyLocale('A1234')).toBeNull();
    expect(detectReplyLocale('👍')).toBeNull();
  });

  it('visitor first, then the widget\'s language, the workspace\'s, the operator\'s', () => {
    // RESPOK: an English panel, a Turkish widget, a Turkish visitor.
    expect(conversationReplyLocale({ visitorTexts: ['Teşekkürler, iyi günler'], widgetLocale: 'tr', operatorLocale: 'en' })).toBe('tr');
    // The visitor wrote nothing readable yet: the widget's language.
    expect(conversationReplyLocale({ visitorTexts: ['👍'], widgetLocale: 'tr', operatorLocale: 'en' })).toBe('tr');
    expect(conversationReplyLocale({ visitorTexts: [], widgetLocale: 'auto', workspaceLocale: 'fa-IR', operatorLocale: 'en' })).toBe('fa');
    expect(conversationReplyLocale({ widgetLocale: null, workspaceLocale: 'de', operatorLocale: 'tr' })).toBe('tr');
    // A Persian visitor on an English widget is answered in Persian.
    expect(conversationReplyLocale({ visitorTexts: ['ممنون'], widgetLocale: 'en', operatorLocale: 'en' })).toBe('fa');
    expect(replyLocaleOf('auto')).toBeNull();
  });
});
