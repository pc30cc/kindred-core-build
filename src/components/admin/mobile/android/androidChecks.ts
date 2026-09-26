/**
 * The Google Play checks this server can make for itself. Kept out of the
 * tab so the page header can count them too, against the unsaved draft.
 */
import type { MobileAppSettings } from '@/hooks/useMobileApp';

/** Google Play's floor for new apps and updates: Android 16. */
export const PLAY_MIN_TARGET_SDK = 36;

export function androidChecks(settings: MobileAppSettings, pushConfigured: boolean) {
  return [
    { key: 'playListing', ok: Boolean(settings.android_play_store_url), tab: 'identity' },
    { key: 'privacyPolicy', ok: Boolean(settings.privacy_policy_url), tab: 'identity' },
    { key: 'targetSdk', ok: settings.android_target_sdk >= PLAY_MIN_TARGET_SDK, tab: 'release' },
    { key: 'sdkRange', ok: settings.android_min_sdk <= settings.android_target_sdk, tab: 'release' },
    { key: 'push', ok: pushConfigured, tab: null },
  ] as const;
}
