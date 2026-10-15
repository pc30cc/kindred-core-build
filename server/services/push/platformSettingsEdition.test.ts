import { describe, expect, it } from 'vitest';
import {
  ANDROID_MESSAGES_CHANNEL,
  DEFAULT_TEMPLATES,
  defaultPushTemplates,
  normalizePushSettings,
  pushPlatformDefaults,
  renderTemplate,
} from './platformSettings.js';

/**
 * The private-mode push title ("Webyar" for WebYar's apps) is the edition's
 * brand: the platform's own name (`{{brand}}`) in the International edition,
 * also when a cloned row stored WebYar's shipped templates. Iran: untouched.
 */
describe('push templates — per edition', () => {
  // What WebYar's row holds once its Notifications page was saved: the shipped set.
  const saved = { templates: structuredClone(DEFAULT_TEMPLATES) };

  it('the Iranian edition (and an unknown one) sends what was stored, as always', () => {
    expect(normalizePushSettings(saved, 'iran').templates).toEqual(DEFAULT_TEMPLATES);
    expect(normalizePushSettings(saved, null).templates).toEqual(DEFAULT_TEMPLATES);
    const { title } = renderTemplate(normalizePushSettings(saved, 'iran'), 'new_message', 'en', false, {}, 'iran');
    expect(title).toBe('Webyar');
  });

  it("the International edition never sends WebYar's name, even from WebYar's stored templates", () => {
    const settings = normalizePushSettings(saved, 'international');
    expect(settings.templates).toEqual(defaultPushTemplates('international'));
    const { title } = renderTemplate(settings, 'mention', 'fa', false, { brand: 'RESPOK' }, 'international');
    expect(title).toBe('RESPOK');
  });

  it("keeps the International edition's own copy, and replaces only a line that names WebYar", () => {
    const own = {
      templates: {
        new_message: {
          title: { default: '{{sender}} wrote', en: '{{sender}} wrote' },
          body: { default: '{{preview}}', en: 'New message in Webyar' },
          privateTitle: { default: 'RESPOK', fa: 'وب‌یار' },
        },
      },
    };
    const t = normalizePushSettings(own, 'international').templates.new_message;
    expect(t.title).toEqual({ default: '{{sender}} wrote', en: '{{sender}} wrote' });
    expect(t.body).toEqual({ default: '{{preview}}', en: '{{preview}}' });
    expect(t.privateTitle).toEqual({ default: 'RESPOK', fa: '{{brand}}' });
  });
});

/**
 * The Android channel a push names is the one the edition's own app creates:
 * WebYar's app keeps `webyar_messages` (its operators' notification settings
 * hang on it); RESPOK's app is brand-neutral and has `messages` only.
 */
describe('Android notification channel — per edition', () => {
  it('the Iranian edition (and an unknown one) keeps what was stored, as always', () => {
    expect(pushPlatformDefaults('iran').android_channel_id).toBe('webyar_messages');
    expect(pushPlatformDefaults(null).android_channel_id).toBe('webyar_messages');
    expect(normalizePushSettings({ android_channel_id: 'webyar_messages' }, 'iran').android_channel_id).toBe('webyar_messages');
    expect(normalizePushSettings({ android_channel_id: 'custom' }, null).android_channel_id).toBe('custom');
    expect(normalizePushSettings({}, 'iran').android_channel_id).toBe('webyar_messages');
  });

  it("the International edition never names WebYar's channel, even from a cloned row", () => {
    expect(pushPlatformDefaults('international').android_channel_id).toBe('messages');
    expect(normalizePushSettings({ android_channel_id: 'webyar_messages' }, 'international').android_channel_id).toBe('messages');
    expect(normalizePushSettings({}, 'international').android_channel_id).toBe('messages');
    expect(ANDROID_MESSAGES_CHANNEL.international).toBe('messages');
  });

  it('keeps a channel the International edition chose itself', () => {
    expect(normalizePushSettings({ android_channel_id: 'alerts' }, 'international').android_channel_id).toBe('alerts');
  });
});
