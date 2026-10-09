/**
 * WebYar's brand kit on the client (shared/webyarBrand.ts): worn only when the
 * platform is known to be the Iranian edition (`region_mode = 'iran'`, from
 * the public config or this browser's cache). Any other region mode, and an
 * edition not known yet, keeps what the app showed before.
 */
import { useKnownEdition } from '@/hooks/useEdition';
import { WEBYAR_BRAND, isUncustomisedColor, isWebyarKitEdition } from '../../shared/webyarBrand';

export { WEBYAR_BRAND, isUncustomisedColor, isWebyarKitEdition };

/** True only in the Iranian edition. */
export function useWebyarKit(): boolean {
  return isWebyarKitEdition(useKnownEdition());
}
