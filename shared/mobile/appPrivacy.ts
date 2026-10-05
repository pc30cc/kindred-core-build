/**
 * App Store Connect's App Privacy categories, as Super Admin's Privacy tab
 * ticks them, and which of them each data type of an iOS privacy manifest
 * (`NSPrivacyCollectedDataType…`, prefix taken off) is declared under.
 *
 * PURE module: read by the server's readiness checks and by the Privacy tab,
 * so both agree on what the app's manifest asks to be declared.
 */

export const APP_PRIVACY_CATEGORIES = [
  'contactInfo', 'identifiers', 'usageData', 'diagnostics', 'userContent', 'location',
] as const;
export type AppPrivacyCategory = (typeof APP_PRIVACY_CATEGORIES)[number];

/** Types outside these six (health, financial, …) have no box to tick here. */
export const APP_PRIVACY_CATEGORY_OF: Record<string, AppPrivacyCategory> = {
  Name: 'contactInfo',
  EmailAddress: 'contactInfo',
  PhoneNumber: 'contactInfo',
  PhysicalAddress: 'contactInfo',
  OtherUserContactInfo: 'contactInfo',
  UserID: 'identifiers',
  DeviceID: 'identifiers',
  ProductInteraction: 'usageData',
  AdvertisingData: 'usageData',
  OtherUsageData: 'usageData',
  CrashData: 'diagnostics',
  PerformanceData: 'diagnostics',
  OtherDiagnosticData: 'diagnostics',
  EmailsOrTextMessages: 'userContent',
  PhotosorVideos: 'userContent',
  AudioData: 'userContent',
  GameplayContent: 'userContent',
  CustomerSupport: 'userContent',
  OtherUserContent: 'userContent',
  PreciseLocation: 'location',
  CoarseLocation: 'location',
};

/** The categories a manifest's data types fall in, in the tab's order. */
export function appPrivacyCategoriesFor(dataTypes: readonly string[]): AppPrivacyCategory[] {
  const found = new Set(dataTypes.map((type) => APP_PRIVACY_CATEGORY_OF[type]).filter(Boolean));
  return APP_PRIVACY_CATEGORIES.filter((category) => found.has(category));
}
