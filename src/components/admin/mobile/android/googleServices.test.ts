import { describe, expect, it } from 'vitest';
import { firebaseClientComplete, firebaseProjectsMatch, readGoogleServices } from './googleServices';

/**
 * Super Admin fills the Android app's Firebase fields from the
 * google-services.json Firebase gives for a project. A project lists every
 * Android app registered in it, so the one for this package is picked out.
 */
const file = (packages: string[]) =>
  JSON.stringify({
    project_info: { project_number: '123456789012', project_id: 'webyar-app', storage_bucket: 'webyar-app.appspot.com' },
    client: packages.map((pkg, i) => ({
      client_info: {
        mobilesdk_app_id: `1:123456789012:android:0a1b2c3d4e5f6a7${i}`,
        android_client_info: { package_name: pkg },
      },
      oauth_client: [],
      api_key: [{ current_key: `AIzaSyDq3b7mX0v9QeLr4TnKw2HsZc5Uf8Ga1p${i}` }],
      services: { appinvite_service: { other_platform_oauth_client: [] } },
    })),
    configuration_version: '1',
  });

describe('reading google-services.json', () => {
  it('takes the four values for this package, not another app of the project', () => {
    const result = readGoogleServices(file(['com.webyar.operator', 'com.webyar.ai']), 'com.webyar.ai');
    expect(result).toEqual({
      ok: true,
      patch: {
        android_firebase_app_id: '1:123456789012:android:0a1b2c3d4e5f6a71',
        android_firebase_api_key: 'AIzaSyDq3b7mX0v9QeLr4TnKw2HsZc5Uf8Ga1p1',
        android_firebase_project_id: 'webyar-app',
        android_firebase_sender_id: '123456789012',
      },
    });
  });

  it('says which packages a file has when this one is not among them', () => {
    expect(readGoogleServices(file(['com.webyar.operator']), 'com.webyar.ai')).toEqual({
      ok: false,
      reason: 'noPackage',
      found: ['com.webyar.operator'],
    });
  });

  it('refuses what is not a google-services.json', () => {
    expect(readGoogleServices('not json', 'com.webyar.ai')).toEqual({ ok: false, reason: 'invalid' });
    expect(readGoogleServices('{"type":"service_account"}', 'com.webyar.ai')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('counts the set complete only with all four, from one project', () => {
    const patch = {
      android_firebase_app_id: '1:123456789012:android:0a1b2c3d4e5f6a70',
      android_firebase_api_key: 'AIzaSyDq3b7mX0v9QeLr4TnKw2HsZc5Uf8Ga1p0',
      android_firebase_project_id: 'webyar-app',
      android_firebase_sender_id: '123456789012',
    };
    expect(firebaseClientComplete(patch)).toBe(true);
    expect(firebaseClientComplete({ ...patch, android_firebase_api_key: null })).toBe(false);
    expect(firebaseProjectsMatch(patch)).toBe(true);
    expect(firebaseProjectsMatch({ ...patch, android_firebase_sender_id: '999999999999' })).toBe(false);
  });
});
