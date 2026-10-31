/**
 * useEdition() — the platform's edition (shared/edition.ts) and what follows
 * from it, for any screen that shows money, gateways or providers.
 *
 *   iran          → Toman (stored IRR), Iranian gateways, Jalali, the wallet
 *                   and AI-credit top-ups: exactly as before.
 *   international → USD, international gateways only, Gregorian; no wallet or
 *                   Rial AI-credit top-up; Persian is only Persian text.
 *
 * Fed by the public config (region.region_mode); before it arrives, by the
 * edition this browser last saw (src/lib/edition.ts). While neither is known
 * the screens behave as they always did (`edition` reads `iran`, `ready` is
 * false).
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { usePlatformPublicConfig } from '@/lib/platformPublicConfig';
import {
  cachedEdition,
  knownRegionModeOrNull,
  rememberEdition,
  rememberPlatformDefaultLocale,
  rememberRegionMode,
} from '@/lib/edition';
import { formatAmountForEdition } from '@/lib/money';
import {
  EDITION_PROFILE,
  currencyForEditionRegion,
  isChannelAllowedInEdition,
  isCurrencyAllowedInEdition,
  isProviderAllowedInEdition,
  resolveEdition,
  parseRegionMode,
  smsVerificationAvailable,
  type Edition,
  type EditionProfile,
  type RegionCurrency,
  type RegionMode,
} from '../../shared/edition';
import { SHIPS_IRAN_KIT } from '../../shared/buildBrand';
import { panelLanguagesFor } from '../../shared/panelLanguages';

export interface EditionInfo {
  edition: Edition;
  isIran: boolean;
  isInternational: boolean;
  /** True once the edition is known (from the config or this browser's cache). */
  ready: boolean;
  /** The raw region mode (multi / iran / turkey / global); `multi` while unknown. */
  regionMode: RegionMode;
  /**
   * The currency this region shows and charges (shared/edition.ts
   * editionCurrencyFor): IRR (displayed as Toman) in Iran, TRY on a
   * Turkish-only site, USD in Multi Region and Global — for every language.
   */
  currency: RegionCurrency;
  calendar: EditionProfile['calendar'];
  phoneCountry: EditionProfile['phoneCountry'];
  features: {
    wallet: boolean;
    aiCreditTopup: boolean;
    iranianProviders: boolean;
    /**
     * SMS one-time codes (phone verification and its gates): always in Iran
     * (Kavenegar, SMS.ir); in International only while the server reports
     * Telnyx configured and enabled (public config `sms_verification`).
     */
    smsVerification: boolean;
    /** The Bale messenger channel. */
    bale: boolean;
  };
  /** A stored amount as people read it (Toman for IRR in Iran; minor units elsewhere). */
  formatAmount: (amount: number | string | null | undefined, currency?: string | null) => string;
  /** May this gateway / vendor be listed in this edition? */
  allowsProvider: (name: string | null | undefined) => boolean;
  /** May money in this currency be shown or offered in this edition? */
  allowsCurrency: (code: string | null | undefined) => boolean;
}

/** The edition the public config says, else the cached one, else null. */
export function useKnownEdition(): Edition | null {
  const { data } = usePlatformPublicConfig();
  const fromConfig = data ? resolveEdition(data.region?.region_mode) : null;
  const regionMode = data ? parseRegionMode(data.region?.region_mode) : null;
  // The panel's default language (shared/panelLanguages.ts), in either
  // edition: what the next first paint opens in (src/i18n getSiteDefaultLocale).
  const defaultLocale = data ? panelLanguagesFor(data.region).defaultLocale : null;
  useEffect(() => {
    if (fromConfig) rememberEdition(fromConfig);
    if (regionMode) rememberRegionMode(regionMode);
    if (defaultLocale) rememberPlatformDefaultLocale(defaultLocale);
  }, [fromConfig, regionMode, defaultLocale]);
  // A build without the Iranian kit (RESPOK's) is only ever International.
  if (!SHIPS_IRAN_KIT) return 'international';
  return fromConfig ?? cachedEdition();
}

/** The region mode the public config says, else the cached one, else `multi`. */
function useKnownRegionMode(): RegionMode {
  const { data } = usePlatformPublicConfig();
  return data ? parseRegionMode(data.region?.region_mode) : knownRegionModeOrNull() ?? 'multi';
}

export function useEdition(): EditionInfo {
  const known = useKnownEdition();
  const { data: publicConfig } = usePlatformPublicConfig();
  const internationalSms = publicConfig?.sms_verification === true;
  const { locale } = useTranslation();
  const edition: Edition = known ?? 'iran';
  const profile = EDITION_PROFILE[edition];
  const regionMode = useKnownRegionMode();
  const currency = currencyForEditionRegion(edition, regionMode);

  const formatAmount = useCallback(
    (amount: number | string | null | undefined, currency?: string | null) =>
      formatAmountForEdition(amount, currency, locale, edition),
    [locale, edition],
  );
  const allowsProvider = useCallback(
    (name: string | null | undefined) => !name || isProviderAllowedInEdition(name, edition),
    [edition],
  );
  const allowsCurrency = useCallback(
    (code: string | null | undefined) => !code || isCurrencyAllowedInEdition(code, edition),
    [edition],
  );

  return useMemo(
    () => ({
      edition,
      isIran: edition === 'iran',
      isInternational: edition === 'international',
      ready: known !== null,
      regionMode,
      currency,
      calendar: profile.calendar,
      phoneCountry: profile.phoneCountry,
      features: {
        wallet: profile.wallet,
        aiCreditTopup: profile.aiCreditTopup,
        iranianProviders: profile.allowsIranianProviders,
        smsVerification: smsVerificationAvailable(edition) || (edition === 'international' && internationalSms),
        bale: isChannelAllowedInEdition('bale', edition),
      },
      formatAmount,
      allowsProvider,
      allowsCurrency,
    }),
    [edition, known, profile, regionMode, currency, formatAmount, allowsProvider, allowsCurrency, internationalSms],
  );
}
