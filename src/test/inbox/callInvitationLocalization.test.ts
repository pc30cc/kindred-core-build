import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

/**
 * The operator inbox showed "You have been invited to an audio call."
 *
 * That string is written by the server
 * (`server/services/calls/invitations.ts`) and frozen into the message row
 * at insert time, so it can never follow the reader's language. The visitor
 * widget already ignores it and draws the card from `metadata`, which is why
 * the visitor saw Persian while the operator saw English for the same
 * message. The inbox now does the same.
 */
const INBOX = readFileSync('src/pages/app/InboxPage.tsx', 'utf8');
const SERVER = readFileSync('server/services/calls/invitations.ts', 'utf8');

/** Comments explain the bug by quoting it; only real code should be searched. */
const INBOX_CODE = INBOX
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

const LOCALES: Record<string, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
  fa: fa as unknown as Record<string, string>,
  tr: tr as unknown as Record<string, string>,
};

const KEYS = [
  'system.callInviteAudio',
  'system.callInviteVideo',
  'system.callInviteAudioFrom',
  'system.callInviteVideoFrom',
];

/** Locale files nest the inbox strings under an `inbox` object. */
function inboxStrings(bundle: Record<string, unknown>): Record<string, string> {
  return (bundle.inbox ?? bundle) as Record<string, string>;
}

describe('the invitation notice is localized for the operator', () => {
  it('renders from metadata rather than from the frozen English body', () => {
    expect(INBOX).toContain("meta.kind === 'call_invitation'");
    expect(INBOX).toContain("meta.channel === 'video'");
    // The persisted body must never be what the operator reads.
    expect(INBOX_CODE).not.toContain('You have been invited to');
  });

  it('picks the key by channel, and names the operator when known', () => {
    // The key selection now lives in the one shared localizer, so the same
    // sentence is produced for the thread, the list preview and the contact
    // page (see systemMessageText.test.ts for the behaviour itself).
    const LOCALIZER = readFileSync('src/lib/systemMessageText.ts', 'utf8');
    expect(LOCALIZER).toContain('inbox.system.callInviteVideoFrom');
    expect(LOCALIZER).toContain('inbox.system.callInviteAudioFrom');
    expect(LOCALIZER).toContain('inbox.system.callInviteVideo');
    expect(LOCALIZER).toContain('inbox.system.callInviteAudio');
    expect(INBOX).toContain('systemMessageText(meta as SystemMessageMeta, t)');
  });

  it('shows the live invitation status, not only that one was sent', () => {
    // The card mutates in place as the visitor acts on it.
    const LOCALIZER = readFileSync('src/lib/systemMessageText.ts', 'utf8');
    for (const status of ['Joined', 'Expired', 'Cancelled', 'Declined', 'Pending']) {
      expect(LOCALIZER, status).toContain(`inbox.callInvite.status${status}`);
    }
    expect(INBOX).toContain('invitationStatusText(t, status)');
  });

  it('carries every key in every locale', () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
      const strings = inboxStrings(bundle);
      for (const key of KEYS) {
        const value = strings[key];
        expect(value, `${name} is missing ${key}`).toBeTruthy();
        expect(value.trim(), `${name}.${key} is blank`).not.toBe('');
      }
    }
  });

  it('keeps the {op} placeholder in the operator-named variants only', () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
      const strings = inboxStrings(bundle);
      expect(strings['system.callInviteAudioFrom'], name).toContain('{op}');
      expect(strings['system.callInviteVideoFrom'], name).toContain('{op}');
      expect(strings['system.callInviteAudio'], name).not.toContain('{op}');
      expect(strings['system.callInviteVideo'], name).not.toContain('{op}');
    }
  });

  it('actually translates — no locale just echoes the English', () => {
    const strings = (l: string) => inboxStrings(LOCALES[l]);
    for (const key of KEYS) {
      expect(strings('fa')[key], `fa.${key}`).not.toBe(strings('en')[key]);
      expect(strings('tr')[key], `tr.${key}`).not.toBe(strings('en')[key]);
      // Persian is the product's first language; a Latin-only string there
      // means the key was copied rather than translated.
      expect(strings('fa')[key], `fa.${key} is not Persian`).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('the server still writes a body, and that is fine', () => {
  it('keeps the metadata that every client renders from', () => {
    // The frozen body stays as a last-resort fallback for surfaces that do
    // not know the kind; the metadata is the part clients must rely on.
    expect(SERVER).toContain("kind: 'call_invitation'");
    expect(SERVER).toContain('channel: InvitationChannel');
  });
});
