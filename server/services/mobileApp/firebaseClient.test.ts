import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { firebaseClientFields, firebaseProjectsMatch } from './firebaseClient.js';

/**
 * What Super Admin accepts as the Android app's Firebase client identifiers.
 * A value in the wrong format would start Firebase on every phone and fail
 * there, where nobody can see why — so it is refused at the save.
 */
const schema = z.object(firebaseClientFields);

const APP_ID = '1:123456789012:android:0a1b2c3d4e5f6a7b';
const API_KEY = 'AIzaSyDq3b7mX0v9QeLr4TnKw2HsZc5Uf8Ga1pE';

describe('Android Firebase client identifiers', () => {
  it('takes the four values of a google-services.json', () => {
    const parsed = schema.parse({
      android_firebase_app_id: ` ${APP_ID} `,
      android_firebase_api_key: API_KEY,
      android_firebase_project_id: 'webyar-app',
      android_firebase_sender_id: '123456789012',
    });
    expect(parsed).toEqual({
      android_firebase_app_id: APP_ID,
      android_firebase_api_key: API_KEY,
      android_firebase_project_id: 'webyar-app',
      android_firebase_sender_id: '123456789012',
    });
  });

  it('clears a value saved empty', () => {
    expect(schema.parse({ android_firebase_api_key: '' }).android_firebase_api_key).toBeNull();
  });

  it('refuses a value pasted into the wrong field', () => {
    // An iOS app id, a server key, a project number where the id goes.
    expect(schema.safeParse({ android_firebase_app_id: '1:123456789012:ios:0a1b2c3d4e5f6a7b' }).success).toBe(false);
    expect(schema.safeParse({ android_firebase_api_key: 'AAAA1234:APA91b' }).success).toBe(false);
    expect(schema.safeParse({ android_firebase_project_id: '123456789012' }).success).toBe(false);
    expect(schema.safeParse({ android_firebase_sender_id: 'webyar-app' }).success).toBe(false);
  });

  it('knows an app id and a project number from two different projects', () => {
    expect(firebaseProjectsMatch(APP_ID, '123456789012')).toBe(true);
    expect(firebaseProjectsMatch(APP_ID, '999999999999')).toBe(false);
    // Either one missing is no disagreement.
    expect(firebaseProjectsMatch(APP_ID, null)).toBe(true);
    expect(firebaseProjectsMatch(null, '123456789012')).toBe(true);
  });
});
