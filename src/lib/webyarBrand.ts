/**
 * WebYar's brand kit on the client (shared/webyarBrand.ts): worn only when the
 * platform is known to be the Iranian edition (`region_mode = 'iran'`, from
 * the public config or this browser's cache). Any other region mode, and an
 * edition not known yet, keeps what the app showed before.
 *
 * A build without the Iranian kit (shared/buildBrand.ts SHIPS_IRAN_KIT: the
 * RESPOK build) never wears it: useWebyarKit() is false there and
 * WEBYAR_BRAND holds no path or name (empty strings), so the kit's files and
 * words leave that bundle even where a caller reads them outside a
 * SHIPS_IRAN_KIT branch.
 */
import { useKnownEdition } from '@/hooks/useEdition';
import { WEBYAR_BRAND as IRAN_KIT, isUncustomisedColor, isWebyarKitEdition } from '../../shared/webyarBrand';
import { SHIPS_IRAN_KIT } from '../../shared/buildBrand';

/** The kit's values as the app reads them (every one a path, a name or a colour). */
export interface IranBrandKit {
  readonly name: string;
  readonly logo: { readonly light: string; readonly dark: string };
  readonly symbol: string;
  readonly favicon: string;
  readonly appleTouchIcon: string;
  readonly maskIcon: string;
  readonly ogImage: string;
  readonly pwa192: string;
  readonly pwa512: string;
  readonly pwaMaskable: string;
  readonly themeColor: string;
}

const NO_KIT: IranBrandKit = {
  name: '',
  logo: { light: '', dark: '' },
  symbol: '',
  favicon: '',
  appleTouchIcon: '',
  maskIcon: '',
  ogImage: '',
  pwa192: '',
  pwa512: '',
  pwaMaskable: '',
  themeColor: '',
};

export const WEBYAR_BRAND: IranBrandKit = SHIPS_IRAN_KIT ? IRAN_KIT : NO_KIT;

export { isUncustomisedColor, isWebyarKitEdition };

/** True only in the Iranian edition (and never in a build without its kit). */
export function useWebyarKit(): boolean {
  const edition = useKnownEdition();
  return SHIPS_IRAN_KIT && isWebyarKitEdition(edition);
}
