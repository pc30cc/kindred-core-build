/**
 * A store still running the previous (Iran-named) build of a commerce plugin:
 * the connections API marks it (`plugin_edition: 'previous'`) and, in the
 * International edition, shows its protocol without the dialect's name; the
 * RESPOK build's panel asks the owner to install this platform's plugin. The
 * Iran edition's response and build stay as they were.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { presentConnection, INTERNATIONAL_PROTOCOL_LABEL } from '../../../server/routes/commerce/connections';
import { LEGACY_DIALECT, NEUTRAL_DIALECT } from '../../../server/services/commerce/pluginDialect';
import { IRAN_BRAND_PATTERNS } from '../../../scripts/build/brandAudit.mjs';

const row = (protocol: string | null) => ({ id: 'c1', provider_type: 'woocommerce', protocol_version: protocol, health: 'connected' });

describe('connections API: the plugin edition a store runs', () => {
  it('Iran: unchanged protocol, plus which build the store runs', () => {
    expect(presentConnection(row(LEGACY_DIALECT.protocol), 'iran')).toMatchObject({ protocol_version: LEGACY_DIALECT.protocol, plugin_edition: 'previous' });
    expect(presentConnection(row(NEUTRAL_DIALECT.protocol), 'iran')).toMatchObject({ protocol_version: NEUTRAL_DIALECT.protocol, plugin_edition: 'current' });
  });

  it('International: the previous build is marked, and no response names the Iran brand', () => {
    for (const protocol of [LEGACY_DIALECT.protocol, null, NEUTRAL_DIALECT.protocol]) {
      const out = presentConnection(row(protocol), 'international');
      expect(out.protocol_version).toBe(INTERNATIONAL_PROTOCOL_LABEL);
      expect(out.plugin_edition).toBe(protocol === NEUTRAL_DIALECT.protocol ? 'current' : 'previous');
      const json = JSON.stringify(out);
      expect(IRAN_BRAND_PATTERNS.some((re: RegExp) => re.test(json))).toBe(false);
    }
  });
});

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (k: string, v?: Record<string, string>) => (v ? `${k} ${JSON.stringify(v)}` : k), locale: 'en' }),
}));
vi.mock('@/lib/brand', () => ({ useBrandTokens: () => ({ brand: 'RESPOK' }) }));
const kit = { ships: false };
vi.mock('../../../shared/buildBrand', () => ({
  get SHIPS_IRAN_KIT() { return kit.ships; },
}));

describe('PreviousPluginNotice', () => {
  afterEach(cleanup);

  it('the RESPOK build asks a store on the previous build to install this platform’s plugin', async () => {
    kit.ships = false;
    const { PreviousPluginNotice } = await import('@/components/plugins/PreviousPluginNotice');
    const { container } = render(<PreviousPluginNotice pluginEdition="previous" downloadPath="/downloads/respok-woocommerce.zip" />);
    expect(container.querySelector('[data-previous-plugin-notice]')).not.toBeNull();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/downloads/respok-woocommerce.zip');
  });

  it('says nothing for a store on the current build, or in the Iran build', async () => {
    const { PreviousPluginNotice } = await import('@/components/plugins/PreviousPluginNotice');
    kit.ships = false;
    expect(render(<PreviousPluginNotice pluginEdition="current" downloadPath="/x.zip" />).container.innerHTML).toBe('');
    cleanup();
    kit.ships = true;
    expect(render(<PreviousPluginNotice pluginEdition="previous" downloadPath="/x.zip" />).container.innerHTML).toBe('');
  });
});
