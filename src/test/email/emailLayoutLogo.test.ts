// @vitest-environment node
/**
 * The logo on a mail's band, through the real email core (renderEmailForPreview,
 * the send path's own composeMessage) and the real brand-asset rules of
 * server/services/platformBrandAssets.ts (brandAssetsFor), with only the
 * Super Admin's uploads stood in for:
 *
 *   - no upload: the edition's kit, its on-dark PNG on the band, drawn at a
 *     size made from the kit PNG's own;
 *   - a light logo only: the resolver hands its PNG for dark surfaces too,
 *     and an ink logo straight on the band would vanish, so it sits on a
 *     paper plate;
 *   - a light and a dark logo: the dark one on the band, in the box the
 *     light one's shape gives (the upload refuses a dark logo of another
 *     shape, so the two share it), whatever its own pixel size;
 *   - every time the image has a width, a height and the brand's name as its
 *     alt text, so a client that blocks images shows the name in its place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomBrandAssets } from '../../../server/services/platformBrandAssets';

const state = vi.hoisted(() => ({
  custom: null as CustomBrandAssets | null,
  branding: {} as Record<string, Record<string, unknown>>,
  domains: null as Record<string, unknown> | null,
}));

const client = vi.hoisted(() => () => ({
  from(table: string) {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      limit: () => builder,
      maybeSingle: async () => {
        if (table === 'platform_branding_localized') return { data: state.branding[filters.locale as string] ?? null, error: null };
        if (table === 'platform_domains') return { data: state.domains, error: null };
        return { data: null, error: null };
      },
    };
    return builder;
  },
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: client }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: client }));
// The uploads as the public config would hand them; the kit, the fallbacks
// and the URLs are the resolver's own rules.
vi.mock('../../../server/services/platformBrandAssets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/services/platformBrandAssets.js')>();
  return {
    ...real,
    resolveBrandAssets: async (_config: unknown, opts: { edition: 'iran' | 'international'; base: string }) =>
      real.brandAssetsFor(opts.edition, state.custom, opts.base),
  };
});

const { renderEmailForPreview } = await import('../../../server/services/email/index.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: [] } as never;
const CDN = 'https://cdn.respok.app/platform/brand';

/** An upload as customBrandAssetsFromRow reads it: the light lockup and its PNG, optionally the dark pair. */
function upload(dark: boolean): CustomBrandAssets {
  return {
    logo_light: `${CDN}/a1-logo-light.svg`,
    logo_dark: dark ? `${CDN}/b2-logo-dark.svg` : null,
    logo_png_light: `${CDN}/a1-logo-light-email.png`,
    logo_png_dark: dark ? `${CDN}/b2-logo-dark-email.png` : null,
    logo_png_width: 300,
    logo_png_height: 100,
    symbol: null,
    apple_touch_180: null,
    icon_192: null,
    icon_512: null,
  };
}

const render = (edition: 'iran' | 'international', locale: string, scheme?: 'light' | 'dark') =>
  renderEmailForPreview(CONFIG, {
    slug: 'email_test', locale, edition, scheme,
    subject: 'Test', html_body: '<h1>Test</h1><p>Hello.</p>', text_body: null, data: {},
  });

/** The band's logo: the one <img> of the document (the content holds none). */
function logoOf(html: string) {
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  expect(imgs).toHaveLength(1);
  const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(imgs[0])?.[1];
  return { tag: imgs[0], src: attr('src'), width: attr('width'), height: attr('height'), alt: attr('alt') };
}

const plateOf = (html: string) => /<td class="x-plate" bgcolor="(#[0-9A-F]{6})"[^>]*><img\b/.exec(html)?.[1] ?? null;

beforeEach(() => {
  state.custom = null;
  state.branding = { en: { platform_name: 'RESPOK' }, fa: { platform_name: 'وب‌یار' } };
  state.domains = { app_base_url: 'https://app.respok.app', canonical_base_url: 'https://respok.app' };
});

describe('no upload: the edition\'s kit', () => {
  it('RESPOK: the kit\'s on-dark PNG on the band, sized from the kit PNG (400 × 92), the name as its alt', async () => {
    const { html } = await render('international', 'en');
    const logo = logoOf(html);
    expect(logo.src).toBe('https://app.respok.app/brand/intl/email/respok-logo-dark.png');
    expect(html).not.toContain('respok-logo.png');
    // About 5,800 px² at the kit's own shape.
    expect([logo.width, logo.height]).toEqual(['159', '37']);
    expect(logo.tag).toContain('style="display:block;width:159px;height:37px;');
    expect(logo.alt).toBe('RESPOK');
    expect(plateOf(html)).toBeNull();
  });

  it('WebYar: its kit\'s on-dark PNG (360 × 139), the Persian name as its alt', async () => {
    state.domains = { app_base_url: 'https://app.webyar.ai' };
    const { html } = await render('iran', 'fa');
    const logo = logoOf(html);
    expect(logo.src).toBe('https://app.webyar.ai/brand/webyar/email/webyar-logo-dark.png');
    expect([logo.width, logo.height]).toEqual(['123', '47']);
    expect(logo.alt).toBe('وب‌یار');
    expect(plateOf(html)).toBeNull();
  });
});

describe('a light logo only', () => {
  it.each(['light', 'dark'] as const)('sits on a paper plate on the band, never straight on it (%s scheme)', async (scheme) => {
    state.custom = upload(false);
    const { html } = await render('international', 'en', scheme);
    const logo = logoOf(html);
    expect(logo.src).toBe(`${CDN}/a1-logo-light-email.png`);
    // The plate is the light card's white in both schemes: the logo was made for a light background.
    expect(plateOf(html)).toBe('#FFFFFF');
    // 300 × 100: about 5,800 px² at its shape.
    expect([logo.width, logo.height]).toEqual(['132', '44']);
    expect(logo.alt).toBe('RESPOK');
    expect(html).not.toContain('/brand/intl/email/');
  });

  it('a PNG whose size the row lacks (an older upload) gives way to the kit, never an image without a size', async () => {
    state.custom = { ...upload(false), logo_png_width: null, logo_png_height: null };
    const { html } = await render('international', 'en');
    const logo = logoOf(html);
    expect(logo.src).toBe('https://app.respok.app/brand/intl/email/respok-logo-dark.png');
    expect([logo.width, logo.height]).toEqual(['159', '37']);
  });
});

describe('a light and a dark logo', () => {
  it.each(['light', 'dark'] as const)('the dark one on the band, in the light one\'s box, with no plate (%s scheme)', async (scheme) => {
    state.custom = upload(true);
    const { html } = await render('international', 'en', scheme);
    const logo = logoOf(html);
    expect(logo.src).toBe(`${CDN}/b2-logo-dark-email.png`);
    expect([logo.width, logo.height]).toEqual(['132', '44']);
    expect(logo.alt).toBe('RESPOK');
    expect(plateOf(html)).toBeNull();
    expect(html).not.toContain('a1-logo-light-email.png');
  });

  it('in a Persian mail of either edition the alt is the name in Persian', async () => {
    state.custom = upload(true);
    const { html } = await render('international', 'fa');
    expect(logoOf(html).alt).toBe('وب‌یار');
  });
});

describe('no logo at all', () => {
  it('with no app address the name stands in, in text, on the band', async () => {
    state.domains = null;
    const { html } = await render('international', 'en');
    expect(html).not.toContain('<img');
    expect(html).toMatch(/font-weight:700;color:#FFFFFF;">RESPOK<\/span>/);
  });
});
