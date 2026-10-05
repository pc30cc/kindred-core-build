import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectNativeProject, readNativeProjectFacts, readSnapshot } from './project.js';

const ROOT = resolve(__dirname, '..', '..', '..');

/** A minimal ios/Webyar checkout to read facts from. */
function fakeProject(spec: string, opts: { icon?: boolean; manifest?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ios-facts-'));
  const dir = join(root, 'ios/Webyar');
  const icons = join(dir, 'Resources/Assets.xcassets/AppIcon.appiconset');
  mkdirSync(icons, { recursive: true });
  writeFileSync(join(dir, 'project.yml'), spec);
  writeFileSync(
    join(icons, 'Contents.json'),
    JSON.stringify({ images: [{ size: '1024x1024', filename: 'AppIcon-1024.png' }] }),
  );
  if (opts.icon !== false) writeFileSync(join(icons, 'AppIcon-1024.png'), 'png');
  if (opts.manifest !== false) writeFileSync(join(dir, 'Resources/PrivacyInfo.xcprivacy'), '<plist/>');
  return root;
}

const SPEC = `targets:
  Webyar:
    info:
      properties:
        UIBackgroundModes:
          - audio
        NSMicrophoneUsageDescription: Calls.
    entitlements:
      path: Generated/Webyar.entitlements
      properties:
        aps-environment: $(APS_ENVIRONMENT)
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.webyar.ai
`;

describe('native iOS project facts', () => {
  it('ships with the server exactly as the project stands', () => {
    // The API image has no ios/ folder; this file is all it knows. Run
    // `npm run ios:project-facts` after changing the icon, the privacy
    // manifest, the entitlements or the background modes.
    expect(readSnapshot()).toEqual(readNativeProjectFacts(ROOT));
  });

  it('finds what App Review needs in this repository', () => {
    expect(readNativeProjectFacts(ROOT)).toMatchObject({
      available: true,
      appIcon1024: true,
      privacyManifestFile: true,
      pushEntitlement: true,
    });
    expect(readNativeProjectFacts(ROOT).backgroundModes).not.toContain('remote-notification');
  });

  it('reads the checkout when there is one', () => {
    expect(inspectNativeProject().source).toBe('checkout');
  });

  it('reads the entitlement and the background modes from the XcodeGen spec', () => {
    expect(readNativeProjectFacts(fakeProject(SPEC))).toEqual({
      available: true,
      appIcon1024: true,
      privacyManifestFile: true,
      pushEntitlement: true,
      backgroundModes: ['audio'],
    });
    const noPush = SPEC.replace('        aps-environment: $(APS_ENVIRONMENT)\n', '        com.apple.developer.associated-domains: []\n');
    expect(readNativeProjectFacts(fakeProject(noPush)).pushEntitlement).toBe(false);
    const inline = SPEC.replace('UIBackgroundModes:\n          - audio', 'UIBackgroundModes: [audio, remote-notification]');
    expect(readNativeProjectFacts(fakeProject(inline)).backgroundModes).toEqual(['audio', 'remote-notification']);
  });

  it('wants the icon file itself, not only its listing', () => {
    expect(readNativeProjectFacts(fakeProject(SPEC, { icon: false })).appIcon1024).toBe(false);
    expect(readNativeProjectFacts(fakeProject(SPEC, { manifest: false })).privacyManifestFile).toBe(false);
  });

  it('knows nothing without a project', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ios-facts-'));
    expect(readNativeProjectFacts(empty)).toEqual({
      available: false,
      appIcon1024: false,
      privacyManifestFile: false,
      pushEntitlement: false,
      backgroundModes: [],
    });
    expect(readSnapshot(join(empty, 'missing.json'))).toBeNull();
  });
});
