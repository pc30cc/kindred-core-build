/**
 * Which notification on an Android phone a push replaces.
 *
 * Firebase draws the notification itself while the app is closed, and
 * without a `tag` every message is a new one: a busy conversation piled up a
 * notification per message, the app could not clear them when the
 * conversation was opened (it did not know their tags), and launchers that
 * put a number on the icon (Samsung, Xiaomi…) counted messages, stale ones
 * included. The tag is the key the app itself posts under
 * (`Notifications.keyOf` in the Android app), so there is one per
 * conversation, and opening it clears it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  androidNotificationTag,
  resetFcmCredentialCache,
  sendFcmMessage,
} from '../../../server/services/push/fcm';

describe('androidNotificationTag', () => {
  it('is the conversation for a conversation event', () => {
    expect(androidNotificationTag({ type: 'new_message', conversationId: 'c-1', messageId: 'm-1' })).toBe('c-1');
    expect(androidNotificationTag({ type: 'internal_note', conversationId: 'c-1' })).toBe('c-1');
  });

  it('is the colleague for a team message', () => {
    expect(androidNotificationTag({ type: 'team_message', peerId: 'u-sara', messageId: 'tm-1' })).toBe('team:u-sara');
  });

  it('is the thread for an email and the request for a callback', () => {
    expect(androidNotificationTag({ type: 'email_message', threadId: 't-1' })).toBe('email:t-1');
    expect(androidNotificationTag({ type: 'callback_request', callbackId: 'cb-1' })).toBe('callback:cb-1');
  });

  it('is one fixed tag for a test send, and none when nothing names the thread', () => {
    expect(androidNotificationTag({ type: 'test' })).toBe('push-test');
    expect(androidNotificationTag({ type: 'team_message' })).toBeUndefined();
    expect(androidNotificationTag({ type: 'new_message' })).toBeUndefined();
  });
});

describe('sendFcmMessage', () => {
  const env = { ...process.env };
  let posted: Array<{ url: string; body: unknown }> = [];

  beforeEach(() => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    process.env.FIREBASE_PROJECT_ID = 'webyar-test';
    process.env.FIREBASE_CLIENT_EMAIL = 'push@webyar-test.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = privateKey as unknown as string;
    resetFcmCredentialCache();
    posted = [];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: unknown }) => {
      if (String(url).includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
      }
      posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 200 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...env };
    resetFcmCredentialCache();
  });

  it('tags the notification Firebase draws with the conversation it is about', async () => {
    const outcome = await sendFcmMessage({
      token: 'device-token',
      title: 'Visitor 4ZTK',
      body: 'Hello',
      data: { type: 'new_message', workspaceId: 'w-1', conversationId: 'c-1', messageId: 'm-1' },
      badge: 3,
    });

    expect(outcome.ok).toBe(true);
    const message = (posted.at(-1)?.body as { message: { android: { notification: Record<string, unknown> } } }).message;
    expect(message.android.notification.tag).toBe('c-1');
    expect(message.android.notification.channel_id).toBe('webyar_messages');
  });

  it("tags a colleague's message with the colleague", async () => {
    await sendFcmMessage({
      token: 'device-token',
      title: 'Sara',
      body: 'Hi',
      data: { type: 'team_message', workspaceId: 'w-1', peerId: 'u-sara', messageId: 'tm-1' },
    });
    const message = (posted.at(-1)?.body as { message: { android: { notification: Record<string, unknown> } } }).message;
    expect(message.android.notification.tag).toBe('team:u-sara');
  });
});
