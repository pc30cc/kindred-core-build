/**
 * The dashboard's own languages (shared/panelLanguages.ts): the Super Admin
 * picks which languages the panel may be shown in, which one it opens in and
 * whether a switcher is shown. In the Iranian edition this no longer locks
 * the panel to Persian, and it never changes the brand or the edition
 * (owner, 2026-10-31).
 */
import { describe, it, expect } from 'vitest';
import { panelLanguagesFor } from '../../../shared/panelLanguages';
import { brandTokensFor } from '../../../shared/brand';
import { resolveEdition } from '../../../shared/edition';

describe('panelLanguagesFor', () => {
  it("WebYar's settings on 2026-10-31 (iran, {fa}, fa, single_language) give a Persian panel without a switcher, as before", () => {
    expect(panelLanguagesFor({ region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' })).toEqual({
      locales: ['fa'],
      defaultLocale: 'fa',
      switcher: false,
    });
  });

  it("WebYar's row as saved on 2026-10-31 07:58 UTC (iran, {fa,tr,ar,en}, fa, single_language): still Persian only, no switcher", () => {
    const row = { region_mode: 'iran', active_locales: ['fa', 'tr', 'ar', 'en'], default_locale: 'fa', site_mode: 'single_language' };
    expect(panelLanguagesFor(row)).toEqual({ locales: ['fa'], defaultLocale: 'fa', switcher: false });
    // Showing the switcher alone offers the two ticked dashboard languages too
    // (Arabic is branding text only).
    expect(panelLanguagesFor({ ...row, site_mode: 'multi_language' })).toEqual({
      locales: ['fa', 'tr', 'en'],
      defaultLocale: 'fa',
      switcher: true,
    });
  });

  it("RESPOK's settings on 2026-10-31 (multi, {en,tr}, en, multi_language) keep English and Turkish with a switcher, as before", () => {
    expect(panelLanguagesFor({ region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' })).toEqual({
      locales: ['en', 'tr'],
      defaultLocale: 'en',
      switcher: true,
    });
  });

  it('Iran with English as the default and the switcher hidden: an English panel only', () => {
    expect(panelLanguagesFor({ region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'single_language' })).toEqual({
      locales: ['en'],
      defaultLocale: 'en',
      switcher: false,
    });
  });

  it('Iran with Turkish as the default and the switcher shown: every active language, Turkish first to open', () => {
    expect(panelLanguagesFor({ region_mode: 'iran', active_locales: ['fa', 'en', 'tr'], default_locale: 'tr', site_mode: 'multi_language' })).toEqual({
      locales: ['fa', 'en', 'tr'],
      defaultLocale: 'tr',
      switcher: true,
    });
  });

  it('the language never changes the edition or the brand: an English WebYar panel is still WebYar', () => {
    const settings = { region_mode: 'iran', active_locales: ['en'], default_locale: 'en', site_mode: 'single_language' };
    expect(panelLanguagesFor(settings).defaultLocale).toBe('en');
    expect(resolveEdition(settings.region_mode)).toBe('iran');
    expect(brandTokensFor('iran', 'en').brand).toBe('Webyar');
    expect(brandTokensFor('iran', 'tr').supportEmail).toBe('info@webyar.ai');
  });

  it('Iran with no language picked is Persian', () => {
    expect(panelLanguagesFor({ region_mode: 'iran', active_locales: null, default_locale: 'en' })).toEqual({
      locales: ['fa'],
      defaultLocale: 'fa',
      switcher: false,
    });
  });

  it('a default outside the active languages gives way to the first of them', () => {
    expect(panelLanguagesFor({ region_mode: 'iran', active_locales: ['tr', 'fa'], default_locale: 'en' }).defaultLocale).toBe('tr');
  });

  it('languages the panel is not translated into are ignored, region tags read as their base language', () => {
    expect(panelLanguagesFor({ region_mode: 'multi', active_locales: ['de', 'fa-IR', 'en', 'fa'], default_locale: 'de' })).toEqual({
      locales: ['fa', 'en'],
      defaultLocale: 'fa',
      switcher: true,
    });
  });

  it('Türkiye and Global still pin one language, whatever else is stored', () => {
    const stored = { active_locales: ['en', 'fa', 'tr'], default_locale: 'fa', site_mode: 'multi_language' };
    expect(panelLanguagesFor({ ...stored, region_mode: 'turkey' })).toEqual({ locales: ['tr'], defaultLocale: 'tr', switcher: false });
    expect(panelLanguagesFor({ ...stored, region_mode: 'global' })).toEqual({ locales: ['en'], defaultLocale: 'en', switcher: false });
  });

  it('no settings at all read as Multi with every language, English first', () => {
    expect(panelLanguagesFor(null)).toEqual({ locales: ['en', 'fa', 'tr'], defaultLocale: 'en', switcher: true });
  });

  it('only an explicit single_language hides the switcher (the column default is multi_language)', () => {
    const base = { region_mode: 'multi', active_locales: ['en', 'fa'], default_locale: 'en' };
    expect(panelLanguagesFor(base).switcher).toBe(true);
    expect(panelLanguagesFor({ ...base, site_mode: null }).switcher).toBe(true);
    expect(panelLanguagesFor({ ...base, site_mode: 'single_language' })).toEqual({ locales: ['en'], defaultLocale: 'en', switcher: false });
  });
});
