/**
 * Where this build's commerce plugin packages are downloaded from, and the
 * names the install steps quote. Two editions of the same plugins exist
 * (scripts/build/pluginEdition.mjs): the Iran region's, and RESPOK's for the
 * International build. Which one a bundle offers is the build brand's
 * (shared/buildBrand.ts): in the RESPOK build `SHIPS_IRAN_KIT` is the literal
 * `false`, so the Iran edition's names below are removed from its bundle.
 * The Iran build and `both` (dev, tests) keep today's packages.
 */
import { SHIPS_IRAN_KIT } from '../../../shared/buildBrand';

export interface OpenCartPackageInfo {
  opencart: string;
  path: string;
  file: string;
  php: string;
  tested?: string[];
}

export interface CommercePluginDownloads {
  /** WordPress plugin (zip whose single folder is the plugin slug). */
  wooCommerceZip: string;
  /** WHMCS addon (extracted into the WHMCS root). */
  whmcsZip: string;
  /** The folder the WHMCS addon adds, as the install step names it. */
  whmcsAddonDir: string;
  /** OpenCart: the signed release manifest listing the packages. */
  openCartManifest: string;
  /** OpenCart: used when the manifest cannot be read; kept in step with the build script. */
  openCartPackages: OpenCartPackageInfo[];
  /** OpenCart 4.1 takes the extension code from this exact file name. */
  openCartOc4File: string;
}

function downloadsFor(code: string, openCartManifest: string): CommercePluginDownloads {
  return {
    wooCommerceZip: `/downloads/${code}-woocommerce.zip`,
    whmcsZip: `/downloads/${code}-whmcs.zip`,
    whmcsAddonDir: `modules/addons/${code}/`,
    openCartManifest,
    openCartPackages: [
      { opencart: '4.1.x', path: `/downloads/opencart/4.1/${code}.ocmod.zip`, file: `${code}.ocmod.zip`, php: '>=8.1' },
      { opencart: '3.0.5.x', path: `/downloads/opencart/3.0/${code}-oc3.ocmod.zip`, file: `${code}-oc3.ocmod.zip`, php: '>=8.1' },
    ],
    openCartOc4File: `${code}.ocmod.zip`,
  };
}

const RESPOK_DOWNLOADS = downloadsFor('respok', '/downloads/opencart/respok-manifest.json');

/** The commerce plugin downloads this build offers. */
export const COMMERCE_PLUGIN_DOWNLOADS: CommercePluginDownloads = SHIPS_IRAN_KIT
  ? downloadsFor('webyar', '/downloads/opencart/manifest.json')
  : RESPOK_DOWNLOADS;
