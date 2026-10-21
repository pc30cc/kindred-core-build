/**
 * The two rules Widget → Appearance, GET /config and the live preview share:
 * the widget's colour (shared/widgetColor.ts, W-10, W-14) and its built-in
 * texts (shared/widgetTextDefaults.ts, W-07, W-13).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  WIDGET_COLOR_PATTERN, WIDGET_UNCUSTOMISED_COLOR, widgetAccentColor, widgetBrandColor, widgetOwnColor, widgetWireColor,
} from '../../../shared/widgetColor';
import { UNCUSTOMISED_PRIMARY_COLOR } from '../../../shared/webyarBrand';
import {
  WIDGET_TEXT_DEFAULTS, isAuthoredWidgetText, resolveWelcomeMessage, widgetTextDefault, widgetTextValue,
} from '../../../shared/widgetTextDefaults';

describe('shared/widgetColor', () => {
  it('a colour of its own is #RRGGBB, upper-case; the seed, nothing and anything else is none', () => {
    expect(widgetOwnColor('#0ea5e9')).toBe('#0EA5E9');
    expect(widgetOwnColor(' #10B981 ')).toBe('#10B981');
    for (const v of [null, undefined, '', '#3B82F6', '#3b82f6', 'red', '#12', '#abc', '#1234567', 7]) expect(widgetOwnColor(v), String(v)).toBeNull();
    expect(WIDGET_COLOR_PATTERN.test('#AbCdEf')).toBe(true);
  });

  it('the seed is the one every widget file reads as uncustomised', () => {
    expect(WIDGET_UNCUSTOMISED_COLOR).toBe(UNCUSTOMISED_PRIMARY_COLOR);
    const loader = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
    expect(loader).toContain(`var KIT_UNCUSTOMISED_COLOR = "${WIDGET_UNCUSTOMISED_COLOR.toLowerCase()}"`);
  });

  it('the brand colour per kit, and what visitors see', () => {
    expect(widgetBrandColor('iran')).toBe('#0B7D6C');
    expect(widgetBrandColor('respok')).toBe('#16142B');
    expect(widgetBrandColor(null)).toBe(WIDGET_UNCUSTOMISED_COLOR);
    expect(widgetAccentColor(null, 'iran')).toBe('#0B7D6C');
    expect(widgetAccentColor('#EF4444', 'iran')).toBe('#EF4444');
  });

  it('on the wire: its own, else the branding\'s, else the seed', () => {
    expect(widgetWireColor('#ef4444', '#445566')).toBe('#EF4444');
    expect(widgetWireColor(null, '#445566')).toBe('#445566');
    expect(widgetWireColor(null, '#3B82F6')).toBe(WIDGET_UNCUSTOMISED_COLOR);
    expect(widgetWireColor('red', null)).toBe(WIDGET_UNCUSTOMISED_COLOR);
  });
});

describe('shared/widgetTextDefaults', () => {
  it('a text somebody wrote is not empty and not an English seed, in any language', () => {
    expect(isAuthoredWidgetText('Hello! How can we help you?', 'welcome')).toBe(false);
    expect(isAuthoredWidgetText('  how can we help you? ', 'welcome')).toBe(false);
    expect(isAuthoredWidgetText('', 'welcome')).toBe(false);
    expect(isAuthoredWidgetText('Hi there', 'welcome')).toBe(true);
    expect(widgetTextValue('Hello! How can we help you?', 'welcome')).toBe('');
    expect(widgetTextValue('سلام', 'welcome')).toBe('سلام');
  });

  it('the welcome: own, else the platform\'s, else the built-in one in the widget\'s language', () => {
    expect(resolveWelcomeMessage('Hi there', 'Platform', 'fa')).toBe('Hi there');
    expect(resolveWelcomeMessage(null, 'به فروشگاه خوش آمدید', 'tr')).toBe('به فروشگاه خوش آمدید');
    expect(resolveWelcomeMessage('Hello! How can we help you?', 'Hello! How can we help you?', 'fa')).toBe(WIDGET_TEXT_DEFAULTS.fa.welcome);
    expect(resolveWelcomeMessage(null, null, 'fa-IR')).toBe(WIDGET_TEXT_DEFAULTS.fa.welcome);
    expect(resolveWelcomeMessage(null, null, 'de')).toBe(WIDGET_TEXT_DEFAULTS.en.welcome);
  });

  it('the pill\'s first text is in the widget\'s language, whatever the dashboard speaks', () => {
    expect(widgetTextDefault('pill', 'fa')).toBe('سؤالی دارید؟ بپرسید');
    expect(widgetTextDefault('pill', 'tr')).toBe('Sorunuz mu var? Sorun');
    expect(widgetTextDefault('pill', undefined)).toBe('Questions? Ask us');
  });
});
