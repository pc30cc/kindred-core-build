/**
 * MOBILE APP SETTINGS → XCODE PROJECT ARTEFACTS.
 *
 * Pure, dependency-free translation of the settings row into the four files
 * an iOS build actually reads:
 *
 *   Info.plist          bundle identity, purpose strings, orientations,
 *                       background modes, export-compliance declaration
 *   App.entitlements    push environment, associated domains, app groups,
 *                       keychain sharing, Sign in with Apple
 *   PrivacyInfo.xcprivacy  Apple's required-reason API manifest + the
 *                       collected-data declaration (mandatory since 2024)
 *   ios/generated.xcconfig  bundle id, versions, team, deployment target
 *
 * Both the Super Admin preview (`GET /api/admin/mobile-app/generated-config`)
 * and the build-time writer (`scripts/ios/apply-app-settings.ts`) call these
 * functions, so what an operator sees before syncing is byte-for-byte what
 * gets written.
 */
import type { MobileAppSettings } from './settings.js';

export interface GeneratedConfig {
  infoPlist: Record<string, unknown>;
  entitlements: Record<string, unknown>;
  privacyManifest: Record<string, unknown>;
  xcconfig: Record<string, string>;
  /** The exact commands that turn these values into a build. */
  commands: string[];
}

const ORIENTATION_KEYS: Record<string, string> = {
  portrait: 'UIInterfaceOrientationPortrait',
  'portrait-upside-down': 'UIInterfaceOrientationPortraitUpsideDown',
  'landscape-left': 'UIInterfaceOrientationLandscapeLeft',
  'landscape-right': 'UIInterfaceOrientationLandscapeRight',
};

/** Required-reason API declarations for what this app actually calls. */
const REQUIRED_REASON_APIS = [
  // CA92.1 — UserDefaults read/written only by this app (locale, device id).
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
  // C617.1 — file timestamps for files inside the app container.
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
  // 35F9.1 — free disk space checked before writing a downloaded attachment.
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1'] },
  // 35F9.1 — system boot time used only for in-app timing measurements.
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
];

/**
 * Keys that belong to Xcode and Capacitor rather than to platform settings.
 * They are re-emitted verbatim because the Info.plist is fully generated —
 * an operator never hand-edits it, so nothing can drift out of the UI.
 */
const STATIC_INFO_PLIST_KEYS: Record<string, unknown> = {
  CAPACITOR_DEBUG: '$(CAPACITOR_DEBUG)',
  CFBundleExecutable: '$(EXECUTABLE_NAME)',
  CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
  CFBundleInfoDictionaryVersion: '6.0',
  CFBundleName: '$(PRODUCT_NAME)',
  CFBundlePackageType: 'APPL',
  UILaunchStoryboardName: 'LaunchScreen',
  UIMainStoryboardFile: 'Main',
  UIApplicationSceneManifest: {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        {
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          UISceneStoryboardFile: 'Main',
        },
      ],
    },
  },
};

export function buildInfoPlist(s: MobileAppSettings): Record<string, unknown> {
  const plist: Record<string, unknown> = {
    ...STATIC_INFO_PLIST_KEYS,
    CFBundleDisplayName: s.display_name,
    CFBundleDevelopmentRegion: s.primary_language,
    CFBundleShortVersionString: s.marketing_version,
    CFBundleVersion: String(s.build_number),
    LSRequiresIPhoneOS: true,
    UIRequiresFullScreen: s.requires_full_screen,
    UIViewControllerBasedStatusBarAppearance: true,
    UISupportedInterfaceOrientations: s.orientations
      .map((o) => ORIENTATION_KEYS[o])
      .filter(Boolean),
    // Export compliance is answered here so App Store Connect stops asking on
    // every single upload.
    ITSAppUsesNonExemptEncryption: s.uses_encryption && !s.encryption_exempt,
  };

  if (s.device_family === 'universal') {
    plist['UISupportedInterfaceOrientations~ipad'] = Object.values(ORIENTATION_KEYS);
  }
  if (!s.supports_dark_mode) plist.UIUserInterfaceStyle = 'Light';

  if (s.cap_camera) plist.NSCameraUsageDescription = s.usage_camera;
  if (s.cap_microphone) plist.NSMicrophoneUsageDescription = s.usage_microphone;
  if (s.cap_photo_library) {
    plist.NSPhotoLibraryUsageDescription = s.usage_photo_library;
    if (s.usage_photo_library_add) plist.NSPhotoLibraryAddUsageDescription = s.usage_photo_library_add;
  }
  if (s.cap_location && s.usage_location) {
    plist.NSLocationWhenInUseUsageDescription = s.usage_location;
  }
  if (s.cap_face_id && s.usage_face_id) plist.NSFaceIDUsageDescription = s.usage_face_id;
  if (s.att_enabled && s.usage_tracking) {
    plist.NSUserTrackingUsageDescription = s.usage_tracking;
  }

  const backgroundModes: string[] = [];
  if (s.cap_push_notifications && s.cap_background_remote_notifications) {
    backgroundModes.push('remote-notification');
  }
  if (s.cap_background_fetch) backgroundModes.push('fetch');
  if (backgroundModes.length) plist.UIBackgroundModes = backgroundModes;

  if (s.url_scheme) {
    plist.CFBundleURLTypes = [
      { CFBundleURLName: s.bundle_id, CFBundleURLSchemes: [s.url_scheme] },
    ];
  }

  return plist;
}

export function buildEntitlements(s: MobileAppSettings): Record<string, unknown> {
  const entitlements: Record<string, unknown> = {};
  if (s.cap_push_notifications) {
    // Resolved by the build configuration, not hardcoded: a Debug build signed
    // with a development profile MUST say `development` here or codesign
    // refuses the mismatch. ios/debug.xcconfig sets it to `development`;
    // ios/generated.xcconfig sets `production` for Release and TestFlight.
    entitlements['aps-environment'] = '$(APS_ENVIRONMENT)';
  }
  if (s.cap_associated_domains && s.associated_domains.length) {
    entitlements['com.apple.developer.associated-domains'] = s.associated_domains.map((d) =>
      d.includes(':') ? d : `applinks:${d}`,
    );
  }
  if (s.cap_app_groups && s.app_group_id) {
    entitlements['com.apple.security.application-groups'] = [s.app_group_id];
  }
  if (s.cap_keychain_sharing) {
    entitlements['keychain-access-groups'] = [`$(AppIdentifierPrefix)${s.bundle_id}`];
  }
  if (s.cap_sign_in_with_apple) {
    entitlements['com.apple.developer.applesignin'] = ['Default'];
  }
  return entitlements;
}

export function buildPrivacyManifest(s: MobileAppSettings): Record<string, unknown> {
  const declared = s.privacy_manifest as Record<string, unknown>;
  const accessed = Array.isArray(declared?.NSPrivacyAccessedAPITypes)
    ? (declared.NSPrivacyAccessedAPITypes as unknown[])
    : REQUIRED_REASON_APIS;
  const collected = Array.isArray((s.data_collection as Record<string, unknown>)?.types)
    ? ((s.data_collection as Record<string, unknown>).types as unknown[])
    : [];
  return {
    NSPrivacyTracking: s.att_enabled,
    NSPrivacyTrackingDomains: Array.isArray(declared?.NSPrivacyTrackingDomains)
      ? declared.NSPrivacyTrackingDomains
      : [],
    NSPrivacyCollectedDataTypes: collected,
    NSPrivacyAccessedAPITypes: accessed,
  };
}

export function buildXcconfig(s: MobileAppSettings): Record<string, string> {
  const config: Record<string, string> = {
    PRODUCT_BUNDLE_IDENTIFIER: s.bundle_id,
    // PRODUCT_NAME deliberately stays the target name: renaming the built
    // product renames the executable and the archive path for no gain — the
    // name a user sees is CFBundleDisplayName, which Info.plist carries.
    MARKETING_VERSION: s.marketing_version,
    CURRENT_PROJECT_VERSION: String(s.build_number),
    IPHONEOS_DEPLOYMENT_TARGET: s.minimum_os_version,
    TARGETED_DEVICE_FAMILY: s.device_family === 'universal' ? '1,2' : '1',
    CODE_SIGN_STYLE: s.automatic_signing ? 'Automatic' : 'Manual',
    CODE_SIGN_ENTITLEMENTS: 'App/App.entitlements',
    ENABLE_BITCODE: 'NO',
    SWIFT_VERSION: '5.0',
    // Expanded inside App.entitlements; overridden to `development` by
    // ios/debug.xcconfig so a debug run signs against a development profile.
    APS_ENVIRONMENT: 'production',
  };
  if (s.apple_team_id) config.DEVELOPMENT_TEAM = s.apple_team_id;
  if (!s.automatic_signing && s.provisioning_profile) {
    config.PROVISIONING_PROFILE_SPECIFIER = s.provisioning_profile;
  }
  return config;
}

export function buildCommands(s: MobileAppSettings): string[] {
  const scheme = 'App';
  return [
    'npm install',
    'npm run ios:prepare',
    `xcodebuild -workspace ios/App/App.xcworkspace -scheme ${scheme} -configuration ${s.build_configuration} -destination "generic/platform=iOS" -archivePath build/App.xcarchive archive`,
    'xcodebuild -exportArchive -archivePath build/App.xcarchive -exportOptionsPlist ios/ExportOptions.plist -exportPath build/ipa',
    'xcrun altool --upload-app -f build/ipa/App.ipa -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"',
  ];
}

export function buildGeneratedConfig(s: MobileAppSettings): GeneratedConfig {
  return {
    infoPlist: buildInfoPlist(s),
    entitlements: buildEntitlements(s),
    privacyManifest: buildPrivacyManifest(s),
    xcconfig: buildXcconfig(s),
    commands: buildCommands(s),
  };
}

/** Minimal, deterministic Apple property-list serializer (XML plist v1.0). */
export function toPlistXml(value: Record<string, unknown>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${node(value, 0)}
</plist>
`;
}

function node(value: unknown, depth: number): string {
  const pad = '\t'.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}<array/>`;
    return `${pad}<array>\n${value.map((v) => node(v, depth + 1)).join('\n')}\n${pad}</array>`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return `${pad}<dict/>`;
    const body = entries
      .map(([key, child]) => `${pad}\t<key>${escapeXml(key)}</key>\n${node(child, depth + 1)}`)
      .join('\n');
    return `${pad}<dict>\n${body}\n${pad}</dict>`;
  }
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `${pad}<integer>${value}</integer>`
      : `${pad}<real>${value}</real>`;
  }
  return `${pad}<string>${escapeXml(String(value))}</string>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
