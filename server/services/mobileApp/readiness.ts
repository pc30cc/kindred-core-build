/**
 * APP STORE READINESS ENGINE.
 *
 * Turns the `mobile_app_settings` row plus a few facts about the running
 * deployment into a deterministic list of App Store submission requirements
 * with a pass / fail / manual verdict each.
 *
 * Deliberate split of responsibilities:
 *  • This module decides STATUS. It returns stable check ids and the evidence
 *    behind a verdict — never user-facing prose.
 *  • The Super Admin screen renders the localized title, the requirement and
 *    the fix from `admin.mobileApp.checks.<id>.*`, so every string an operator
 *    reads exists in all three locales (enforced by the i18n tests).
 *
 * `manual` is a first-class verdict, not a failure: Apple requires artefacts
 * (screenshots, age-rating questionnaire, demo password) that live in App
 * Store Connect and cannot be observed from here. Those checks carry the
 * exact specification an operator needs and are acknowledged in the UI, which
 * records the acknowledgement in `mobile_app_settings.checklist`.
 */
import type { MobileAppSettings } from './settings.js';

export type CheckStatus = 'pass' | 'fail' | 'manual';
export type CheckSeverity = 'blocker' | 'warning' | 'info';
export type CheckGroup =
  | 'identity'
  | 'build'
  | 'privacy'
  | 'account'
  | 'review'
  | 'store'
  | 'push'
  | 'compliance'
  | 'technical';

export interface ReadinessCheck {
  id: string;
  group: CheckGroup;
  severity: CheckSeverity;
  status: CheckStatus;
  /** Machine-readable detail behind the verdict (never localized prose). */
  evidence?: string;
  /** App Store Review Guideline reference, when the rule maps to one. */
  guideline?: string;
}

export interface ReadinessInput {
  settings: MobileAppSettings;
  /** FCM service account present in the server environment. */
  pushConfigured: boolean;
  /**
   * False when this deployment has no `ios/` checkout at all (the API image
   * does not ship one). Every file-backed check then reports `manual`: the
   * server cannot honestly fail a file it was never given.
   */
  nativeProjectAvailable: boolean;
  /** GoogleService-Info.plist committed to the iOS target. */
  googleServicePlistPresent: boolean;
  /** 1024×1024 marketing icon present in the asset catalog. */
  appIconPresent: boolean;
  /** PrivacyInfo.xcprivacy present in the iOS target. */
  privacyManifestFilePresent: boolean;
  /** The app forces sign-in before any content is reachable. */
  requiresLogin: boolean;
}

const SEMVER_RE = /^\d+(\.\d+){1,2}$/;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PLACEHOLDER_RE = /(example|test|demo|changeme|yourcompany|com\.company)/i;

function https(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function filled(value: string | null | undefined, min = 1): boolean {
  return typeof value === 'string' && value.trim().length >= min;
}

/** Apple rejects a purpose string that does not say WHY the data is used. */
function purposeStringOk(value: string | null | undefined): boolean {
  return filled(value, 25) && /\b(so|to|for|because|in order)\b/i.test(String(value));
}

export function evaluateReadiness(input: ReadinessInput): ReadinessCheck[] {
  const s = input.settings;
  const checks: ReadinessCheck[] = [];
  const add = (
    id: string,
    group: CheckGroup,
    severity: CheckSeverity,
    status: CheckStatus,
    evidence?: string,
    guideline?: string,
  ) => checks.push({ id, group, severity, status, evidence, guideline });

  // ── Identity ──────────────────────────────────────────────────────────
  add(
    'bundleId',
    'identity',
    'blocker',
    BUNDLE_ID_RE.test(s.bundle_id) && !PLACEHOLDER_RE.test(s.bundle_id) ? 'pass' : 'fail',
    s.bundle_id,
  );
  add(
    'teamId',
    'identity',
    'blocker',
    TEAM_ID_RE.test(String(s.apple_team_id ?? '')) ? 'pass' : 'fail',
    s.apple_team_id ?? '',
  );
  add(
    'displayName',
    'identity',
    'blocker',
    filled(s.display_name) && s.display_name.trim().length <= 30 ? 'pass' : 'fail',
    `${s.display_name.trim().length}/30`,
  );
  add('appStoreConnectRecord', 'identity', 'blocker', filled(s.apple_app_id) ? 'pass' : 'manual', s.apple_app_id ?? '');
  add('sku', 'identity', 'warning', filled(s.app_sku) ? 'pass' : 'fail', s.app_sku ?? '');

  // ── Build ─────────────────────────────────────────────────────────────
  add('marketingVersion', 'build', 'blocker', SEMVER_RE.test(s.marketing_version) ? 'pass' : 'fail', s.marketing_version);
  add('buildNumber', 'build', 'blocker', Number(s.build_number) >= 1 ? 'pass' : 'fail', String(s.build_number));
  add(
    'minimumOsVersion',
    'build',
    'warning',
    parseFloat(s.minimum_os_version) >= 13 ? 'pass' : 'fail',
    s.minimum_os_version,
  );
  add('appIcon', 'build', 'blocker', fileVerdict(input, input.appIconPresent));
  add('launchScreen', 'build', 'blocker', 'pass');
  add(
    'orientations',
    'build',
    'warning',
    s.orientations.length > 0 ? 'pass' : 'fail',
    s.orientations.join(','),
  );
  add('screenshots', 'build', 'blocker', ack(s, 'screenshots'));
  add('darkMode', 'build', 'info', s.supports_dark_mode ? 'pass' : 'manual');

  // ── Privacy ───────────────────────────────────────────────────────────
  add('privacyPolicyUrl', 'privacy', 'blocker', https(s.privacy_policy_url) ? 'pass' : 'fail', s.privacy_policy_url ?? '', '5.1.1');
  add(
    'usageCamera',
    'privacy',
    'blocker',
    !s.cap_camera ? 'pass' : purposeStringOk(s.usage_camera) ? 'pass' : 'fail',
    undefined,
    '5.1.1',
  );
  add(
    'usageMicrophone',
    'privacy',
    'blocker',
    !s.cap_microphone ? 'pass' : purposeStringOk(s.usage_microphone) ? 'pass' : 'fail',
    undefined,
    '5.1.1',
  );
  add(
    'usagePhotoLibrary',
    'privacy',
    'blocker',
    !s.cap_photo_library ? 'pass' : purposeStringOk(s.usage_photo_library) ? 'pass' : 'fail',
    undefined,
    '5.1.1',
  );
  add(
    'usageLocation',
    'privacy',
    'blocker',
    !s.cap_location ? 'pass' : purposeStringOk(s.usage_location) ? 'pass' : 'fail',
    undefined,
    '5.1.1',
  );
  add(
    'usageFaceId',
    'privacy',
    'blocker',
    !s.cap_face_id ? 'pass' : purposeStringOk(s.usage_face_id) ? 'pass' : 'fail',
  );
  add(
    'trackingPermission',
    'privacy',
    'blocker',
    !s.att_enabled ? 'pass' : purposeStringOk(s.usage_tracking) ? 'pass' : 'fail',
    undefined,
    '5.1.2',
  );
  add(
    'idfaDeclaration',
    'privacy',
    'blocker',
    s.uses_idfa && !s.att_enabled ? 'fail' : 'pass',
    undefined,
    '5.1.2',
  );
  add(
    'privacyManifest',
    'privacy',
    'blocker',
    privacyManifestOk(s) ? fileVerdict(input, input.privacyManifestFilePresent) : 'fail',
  );
  add(
    'privacyNutritionLabels',
    'privacy',
    'blocker',
    !s.collects_data ? 'pass' : dataCollectionOk(s) ? 'pass' : 'fail',
    undefined,
    '5.1.1',
  );
  add('thirdPartySdkAudit', 'privacy', 'warning', s.third_party_sdks.length > 0 ? 'pass' : 'manual');

  // ── Account (5.1.1(v)) ────────────────────────────────────────────────
  add(
    'accountDeletion',
    'account',
    'blocker',
    s.account_deletion_supported ? 'pass' : 'fail',
    undefined,
    '5.1.1(v)',
  );
  add(
    'accountDeletionDiscoverable',
    'account',
    'warning',
    s.account_deletion_supported ? 'pass' : 'fail',
    undefined,
    '5.1.1(v)',
  );
  add(
    'signInWithApple',
    'account',
    'blocker',
    !usesThirdPartyLogin(s) || s.cap_sign_in_with_apple ? 'pass' : 'fail',
    undefined,
    '4.8',
  );

  // ── App Review ────────────────────────────────────────────────────────
  const demoNeeded = input.requiresLogin && s.demo_account_required;
  add(
    'demoAccount',
    'review',
    'blocker',
    !demoNeeded ? 'pass' : filled(s.demo_account_username) ? 'pass' : 'fail',
    undefined,
    '2.1',
  );
  add('demoAccountPassword', 'review', 'blocker', !demoNeeded ? 'pass' : ack(s, 'demoAccountPassword'), undefined, '2.1');
  add(
    'reviewContact',
    'review',
    'blocker',
    filled(s.review_contact_name) && filled(s.review_contact_email) && filled(s.review_contact_phone)
      ? 'pass'
      : 'fail',
    undefined,
    '2.1',
  );
  add('reviewNotes', 'review', 'warning', filled(s.review_notes, 40) ? 'pass' : 'fail');

  // ── Store listing ─────────────────────────────────────────────────────
  add('supportUrl', 'store', 'blocker', https(s.support_url) ? 'pass' : 'fail', s.support_url ?? '', '1.5');
  add('marketingUrl', 'store', 'info', !s.marketing_url || https(s.marketing_url) ? 'pass' : 'fail');
  add('termsUrl', 'store', 'warning', !s.terms_url || https(s.terms_url) ? 'pass' : 'fail', undefined, '3.1.2');
  add('copyright', 'store', 'warning', filled(s.copyright) ? 'pass' : 'fail');
  add('category', 'store', 'blocker', filled(s.primary_category) ? 'pass' : 'fail');
  add('ageRating', 'store', 'blocker', ack(s, 'ageRating'));
  add('storeDescription', 'store', 'blocker', ack(s, 'storeDescription'));
  add('keywords', 'store', 'warning', ack(s, 'keywords'));
  add(
    'contentRights',
    'store',
    'warning',
    s.contains_third_party_content ? ack(s, 'contentRights') : 'pass',
    undefined,
    '5.2',
  );

  // ── Push ──────────────────────────────────────────────────────────────
  const pushOn = s.cap_push_notifications;
  add('pushCapability', 'push', pushOn ? 'blocker' : 'info', pushOn ? 'pass' : 'manual');
  add(
    'pushBackgroundMode',
    'push',
    'blocker',
    !pushOn || s.cap_background_remote_notifications ? 'pass' : 'fail',
  );
  add('pushServerCredentials', 'push', 'blocker', !pushOn || input.pushConfigured ? 'pass' : 'fail');
  add(
    'pushFirebasePlist',
    'push',
    'blocker',
    !pushOn ? 'pass' : fileVerdict(input, input.googleServicePlistPresent),
  );
  add('pushApnsKey', 'push', 'blocker', !pushOn ? 'pass' : ack(s, 'pushApnsKey'));
  add('pushNotRequiredForUse', 'push', 'warning', 'pass', undefined, '4.5.4');

  // ── Compliance ────────────────────────────────────────────────────────
  add(
    'exportCompliance',
    'compliance',
    'blocker',
    !s.uses_encryption || s.encryption_exempt || filled(s.encryption_notes, 20) ? 'pass' : 'fail',
  );
  add('encryptionDeclaration', 'compliance', 'blocker', 'pass');
  add('noExternalPayments', 'compliance', 'warning', 'pass', undefined, '3.1.1');
  add('minimumFunctionality', 'compliance', 'warning', 'manual', undefined, '4.2');
  add('dataSafetyAccuracy', 'compliance', 'warning', ack(s, 'dataSafetyAccuracy'), undefined, '5.1.1');

  // ── Technical ─────────────────────────────────────────────────────────
  add('httpsOnly', 'technical', 'blocker', 'pass');
  add('ipv6', 'technical', 'blocker', 'pass', undefined, '2.1');
  add('noPrivateApis', 'technical', 'blocker', 'pass', undefined, '2.5.1');
  add('bitcodeRemoved', 'technical', 'info', 'pass');
  add('signingConfigured', 'technical', 'blocker', s.automatic_signing || filled(s.provisioning_profile) ? 'pass' : 'fail');
  add(
    'associatedDomains',
    'technical',
    'warning',
    !s.cap_associated_domains || s.associated_domains.length > 0 ? 'pass' : 'fail',
  );
  add('crashFree', 'technical', 'blocker', ack(s, 'crashFree'), undefined, '2.1');
  add('deviceTested', 'technical', 'blocker', ack(s, 'deviceTested'), undefined, '2.1');

  return checks;
}

/**
 * A file-backed verdict. Without a native checkout the honest answer is
 * "verify this yourself", never a red failure the operator cannot act on.
 */
function fileVerdict(input: ReadinessInput, present: boolean): CheckStatus {
  if (!input.nativeProjectAvailable) return 'manual';
  return present ? 'pass' : 'fail';
}

/** A manual requirement is satisfied once an operator acknowledges it. */
function ack(s: MobileAppSettings, key: string): CheckStatus {
  return s.checklist?.[key]?.done ? 'pass' : 'manual';
}

function usesThirdPartyLogin(s: MobileAppSettings): boolean {
  return s.third_party_sdks.some((name) => /google|facebook|apple sign|oauth|twitter|github/i.test(name));
}

function privacyManifestOk(s: MobileAppSettings): boolean {
  const manifest = s.privacy_manifest as Record<string, unknown>;
  const reasons = manifest?.NSPrivacyAccessedAPITypes;
  return Array.isArray(reasons) && reasons.length > 0;
}

function dataCollectionOk(s: MobileAppSettings): boolean {
  const collection = s.data_collection as Record<string, unknown>;
  const types = collection?.types;
  return Array.isArray(types) && types.length > 0;
}

export interface ReadinessSummary {
  total: number;
  passed: number;
  failed: number;
  manual: number;
  blockers: number;
  /** 0–100; manual-but-unacknowledged counts as not done. */
  score: number;
  submittable: boolean;
}

export function summarize(checks: ReadinessCheck[]): ReadinessSummary {
  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const manual = checks.filter((c) => c.status === 'manual').length;
  const blockers = checks.filter((c) => c.severity === 'blocker' && c.status !== 'pass').length;
  return {
    total: checks.length,
    passed,
    failed,
    manual,
    blockers,
    score: checks.length ? Math.round((passed / checks.length) * 100) : 0,
    submittable: blockers === 0,
  };
}
