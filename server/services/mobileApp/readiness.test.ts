import { describe, expect, it } from 'vitest';
import { evaluateReadiness, summarize, type ReadinessInput } from './readiness.js';
import { MOBILE_APP_DEFAULTS, type MobileAppSettings } from './settings.js';
import { buildEntitlements, buildInfoPlist, buildXcconfig, toPlistXml } from './generatedConfig.js';

function input(overrides: Partial<MobileAppSettings> = {}, rest: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    settings: { ...MOBILE_APP_DEFAULTS, ...overrides },
    pushConfigured: true,
    nativeProjectAvailable: true,
    googleServicePlistPresent: true,
    appIconPresent: true,
    privacyManifestFilePresent: true,
    requiresLogin: true,
    ...rest,
  };
}

function verdict(checks: ReturnType<typeof evaluateReadiness>, id: string) {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`no such check: ${id}`);
  return check.status;
}

describe('App Store readiness', () => {
  it('fails the placeholder bundle identifier the template ships with', () => {
    expect(verdict(evaluateReadiness(input({ bundle_id: 'com.example.app' })), 'bundleId')).toBe('fail');
    expect(verdict(evaluateReadiness(input({ bundle_id: 'com.acme.support' })), 'bundleId')).toBe('pass');
  });

  it('requires a ten-character team id', () => {
    expect(verdict(evaluateReadiness(input({ apple_team_id: null })), 'teamId')).toBe('fail');
    expect(verdict(evaluateReadiness(input({ apple_team_id: 'SHORT' })), 'teamId')).toBe('fail');
    expect(verdict(evaluateReadiness(input({ apple_team_id: 'KB548B4TUJ' })), 'teamId')).toBe('pass');
  });

  it('rejects a purpose string that does not explain why the data is used', () => {
    const vague = evaluateReadiness(input({ usage_camera: 'Camera access' }));
    expect(verdict(vague, 'usageCamera')).toBe('fail');
    // The shipped default already reads as a full sentence.
    expect(verdict(evaluateReadiness(input()), 'usageCamera')).toBe('pass');
  });

  it('does not ask for a purpose string for a capability that is off', () => {
    const checks = evaluateReadiness(input({ cap_location: false, usage_location: null }));
    expect(verdict(checks, 'usageLocation')).toBe('pass');
  });

  it('demands the tracking string only when the app asks for tracking', () => {
    expect(verdict(evaluateReadiness(input()), 'trackingPermission')).toBe('pass');
    expect(verdict(evaluateReadiness(input({ att_enabled: true })), 'trackingPermission')).toBe('fail');
  });

  it('treats IDFA without the tracking prompt as a failure', () => {
    expect(verdict(evaluateReadiness(input({ uses_idfa: true })), 'idfaDeclaration')).toBe('fail');
  });

  it('reports a file it cannot see as manual rather than failed', () => {
    const checks = evaluateReadiness(input({}, { nativeProjectAvailable: false, appIconPresent: false }));
    expect(verdict(checks, 'appIcon')).toBe('manual');
  });

  it('fails a missing icon when the project IS checked out', () => {
    expect(verdict(evaluateReadiness(input({}, { appIconPresent: false })), 'appIcon')).toBe('fail');
  });

  it('requires a demo account while the app is behind a login', () => {
    expect(verdict(evaluateReadiness(input()), 'demoAccount')).toBe('fail');
    expect(
      verdict(evaluateReadiness(input({ demo_account_username: 'review@acme.test' })), 'demoAccount'),
    ).toBe('pass');
  });

  it('accepts an acknowledgement only for a manual requirement', () => {
    const acknowledged = evaluateReadiness(
      input({ checklist: { screenshots: { done: true } } }),
    );
    expect(verdict(acknowledged, 'screenshots')).toBe('pass');
  });

  it('blocks submission while any blocker is open and clears once none are', () => {
    const blocked = summarize(evaluateReadiness(input()));
    expect(blocked.submittable).toBe(false);
    expect(blocked.blockers).toBeGreaterThan(0);

    const clean = summarize(
      evaluateReadiness(
        input({
          bundle_id: 'com.acme.support',
          apple_team_id: 'KB548B4TUJ',
          apple_app_id: '1234567890',
          app_sku: 'acme-support',
          privacy_policy_url: 'https://acme.test/privacy',
          support_url: 'https://acme.test/support',
          copyright: '2026 Acme Ltd',
          review_contact_name: 'Sara',
          review_contact_email: 'sara@acme.test',
          review_contact_phone: '+905551112233',
          review_notes: 'Sign in with the demo account; the inbox loads on launch.',
          demo_account_username: 'review@acme.test',
          privacy_manifest: { NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'x' }] },
          data_collection: { types: ['contactInfo'] },
          checklist: Object.fromEntries(
            [
              'screenshots', 'ageRating', 'storeDescription', 'keywords', 'demoAccountPassword',
              'pushApnsKey', 'dataSafetyAccuracy', 'crashFree', 'deviceTested',
            ].map((key) => [key, { done: true }]),
          ),
        }),
      ),
    );
    expect(clean.blockers).toBe(0);
    expect(clean.submittable).toBe(true);
  });
});

describe('generated Xcode configuration', () => {
  it('declares the background mode push actually needs', () => {
    const plist = buildInfoPlist({ ...MOBILE_APP_DEFAULTS });
    expect(plist.UIBackgroundModes).toEqual(['remote-notification']);
  });

  it('omits a purpose string for a capability that is off', () => {
    const plist = buildInfoPlist({ ...MOBILE_APP_DEFAULTS, cap_camera: false });
    expect(plist.NSCameraUsageDescription).toBeUndefined();
    expect(plist.NSMicrophoneUsageDescription).toBeDefined();
  });

  it('answers export compliance so App Store Connect stops asking', () => {
    const exempt = buildInfoPlist({ ...MOBILE_APP_DEFAULTS });
    expect(exempt.ITSAppUsesNonExemptEncryption).toBe(false);
    const nonExempt = buildInfoPlist({ ...MOBILE_APP_DEFAULTS, encryption_exempt: false });
    expect(nonExempt.ITSAppUsesNonExemptEncryption).toBe(true);
  });

  it('leaves the APNs environment to the build configuration', () => {
    // Hardcoding `production` breaks a debug run: codesign rejects an
    // entitlement that disagrees with the development profile.
    expect(buildEntitlements({ ...MOBILE_APP_DEFAULTS })['aps-environment']).toBe('$(APS_ENVIRONMENT)');
  });

  it('drops the associated-domains entitlement when no domain is listed', () => {
    const none = buildEntitlements({ ...MOBILE_APP_DEFAULTS, cap_associated_domains: true });
    expect(none['com.apple.developer.associated-domains']).toBeUndefined();
    const some = buildEntitlements({
      ...MOBILE_APP_DEFAULTS,
      cap_associated_domains: true,
      associated_domains: ['acme.test'],
    });
    expect(some['com.apple.developer.associated-domains']).toEqual(['applinks:acme.test']);
  });

  it('never overrides PRODUCT_NAME, which would rename the built executable', () => {
    expect(buildXcconfig({ ...MOBILE_APP_DEFAULTS }).PRODUCT_NAME).toBeUndefined();
  });

  it('serializes a plist Xcode can read', () => {
    const xml = toPlistXml({ a: true, b: 2, c: ['x'], d: { e: 'f & g' } });
    expect(xml).toContain('<plist version="1.0">');
    expect(xml).toContain('<true/>');
    expect(xml).toContain('<integer>2</integer>');
    expect(xml).toContain('f &amp; g');
  });
});
