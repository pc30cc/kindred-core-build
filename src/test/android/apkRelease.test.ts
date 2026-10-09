import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseShippedRelease,
  readShippedAndroidRelease,
  SHIPPED_RELEASE_FILES,
  shippedReleaseFiles,
  withShippedVersion,
} from '../../../server/services/mobileApp/androidRelease';

/**
 * The website's Android download and the file that names its version travel
 * together: Super Admin shows the version from the JSON, so the JSON has to
 * describe the APK next to it — the same bytes, the same size.
 */
const dir = resolve(__dirname, '../../../public/downloads');

describe('the Android download', () => {
  const release = parseShippedRelease(JSON.parse(readFileSync(resolve(dir, 'Webyar-Android.json'), 'utf8')));

  it('names its version in a well-formed sidecar', () => {
    expect(release).not.toBeNull();
  });

  it('is the APK the sidecar describes', () => {
    const apk = resolve(dir, 'Webyar-Android.apk');
    expect(statSync(apk).size).toBe(release!.sizeBytes);
    expect(createHash('sha256').update(readFileSync(apk)).digest('hex')).toBe(release!.sha256);
  });
});

describe('the shipped version', () => {
  it('replaces the typed one, and leaves it alone when nothing is shipped', () => {
    const typed = { android_version_name: '1.0.0', android_version_code: 1, other: true };
    const shipped = parseShippedRelease({ versionName: '1.1', versionCode: 22, sha256: 'a'.repeat(64), sizeBytes: 10 });
    expect(withShippedVersion(typed, shipped)).toEqual({ android_version_name: '1.1', android_version_code: 22, other: true });
    expect(withShippedVersion(typed, null)).toBe(typed);
  });

  it('refuses a sidecar it cannot trust', () => {
    expect(parseShippedRelease({ versionName: '1.1', versionCode: 0, sha256: 'a'.repeat(64), sizeBytes: 10 })).toBeNull();
    expect(parseShippedRelease({ versionName: 'one', versionCode: 2, sha256: 'a'.repeat(64), sizeBytes: 10 })).toBeNull();
    expect(parseShippedRelease({ versionName: '1.1', versionCode: 2, sha256: 'nothex', sizeBytes: 10 })).toBeNull();
    expect(parseShippedRelease(null)).toBeNull();
  });
});

describe('the server finds the sidecar', () => {
  it('beside its own source in the repository', () => {
    expect(SHIPPED_RELEASE_FILES[0]).toBe(resolve(dir, 'Webyar-Android.json'));
    expect(readShippedAndroidRelease()?.versionName).toBe(
      JSON.parse(readFileSync(resolve(dir, 'Webyar-Android.json'), 'utf8')).versionName,
    );
  });

  it('in its Docker image, where the version is read in production', () => {
    const dockerfile = readFileSync(resolve(__dirname, '../../../Dockerfile.server'), 'utf8');
    // Both editions' sidecars; the wildcard always matches WebYar's, so a
    // missing RESPOK-Android.json does not fail the build.
    expect(dockerfile).toContain('COPY public/downloads/*-Android.json ./public/downloads/');
    expect(dockerfile).toContain('test -f /app/public/downloads/Webyar-Android.json');
    expect(dockerfile).not.toContain('test -f /app/public/downloads/RESPOK-Android.json');
  });
});

describe('each edition reads its own sidecar', () => {
  it("Iran (and an unknown edition) reads WebYar's, exactly as before", () => {
    expect(shippedReleaseFiles('iran')).toEqual(SHIPPED_RELEASE_FILES);
    expect(shippedReleaseFiles(null)).toEqual(SHIPPED_RELEASE_FILES);
    expect(readShippedAndroidRelease('iran')).toEqual(readShippedAndroidRelease());
  });

  it("the International edition reads RESPOK's, and has no shipped release while it is missing", () => {
    const files = shippedReleaseFiles('international');
    expect(files[0]).toBe(resolve(dir, 'RESPOK-Android.json'));
    const respok = resolve(dir, 'RESPOK-Android.json');
    const expected = existsSync(respok) ? parseShippedRelease(JSON.parse(readFileSync(respok, 'utf8'))) : null;
    expect(readShippedAndroidRelease('international')).toEqual(expected);
  });
});
