/**
 * Unit tests for the canonical storage ownership model + key builder
 * (server/services/storage/keys.ts). Pure module — no mocking needed.
 */
import { describe, it, expect } from 'vitest';
import {
  StorageKeyError,
  workspaceRoot,
  userRoot,
  platformRoot,
  ownerRoot,
  safeFileName,
  chatAttachmentKey,
  emailAttachmentKey,
  channelAttachmentKey,
  contactAvatarKey,
  aiAgentAvatarKey,
  callCenterAvatarKey,
  integrationAvatarKey,
  widgetAssetKey,
  aiAgentFileKey,
  privacyExportKey,
  callRecordingKey,
  callArchiveKey,
  userAvatarKey,
  platformCallCenterRingbackKey,
  assertSafeStorageKey,
  assertWorkspaceScopedKey,
  assertUserScopedKey,
  assertPlatformScopedKey,
  assertOwnerScopedKey,
  classifyStorageKey,
  isKnownLegacyStorageKey,
} from '../../../server/services/storage/keys';

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const USER_A = '33333333-3333-3333-3333-333333333333';
const SOURCE_ID = '44444444-4444-4444-4444-444444444444';
const CALL_SESSION = '55555555-5555-5555-5555-555555555555';
const JOB_ID = '66666666-6666-6666-6666-666666666666';

describe('owner roots', () => {
  it('workspaceRoot requires a UUID', () => {
    expect(workspaceRoot(WS_A)).toBe(`workspace/${WS_A}`);
    expect(() => workspaceRoot('not-a-uuid')).toThrow(StorageKeyError);
  });

  it('userRoot requires a UUID', () => {
    expect(userRoot(USER_A)).toBe(`users/${USER_A}`);
    expect(() => userRoot('nope')).toThrow(StorageKeyError);
  });

  it('platformRoot is fixed', () => {
    expect(platformRoot()).toBe('platform');
  });

  it('ownerRoot dispatches on owner kind', () => {
    expect(ownerRoot({ kind: 'workspace', workspaceId: WS_A })).toBe(`workspace/${WS_A}`);
    expect(ownerRoot({ kind: 'user', userId: USER_A })).toBe(`users/${USER_A}`);
    expect(ownerRoot({ kind: 'platform' })).toBe('platform');
  });
});

describe('safeFileName', () => {
  it('strips path separators a client might smuggle in', () => {
    expect(safeFileName('../../etc/passwd')).not.toContain('/');
    expect(safeFileName('..\\..\\windows\\system32')).not.toContain('\\');
  });

  it('replaces unsafe characters and keeps a sane extension', () => {
    expect(safeFileName('my report (final)!!.pdf')).toBe('my_report_final_.pdf');
  });

  it('collapses unicode into a safe ascii-ish fragment without throwing', () => {
    const result = safeFileName('résumé—final 📎.docx');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toMatch(/[\\/]/);
  });

  it('truncates very long filenames', () => {
    const long = 'a'.repeat(500) + '.txt';
    const result = safeFileName(long);
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it('falls back when the cleaned name is genuinely empty', () => {
    expect(safeFileName('', 'file')).toBe('file');
    expect(safeFileName('///', 'file')).toBe('file');
  });

  it('collapses an all-dot name into a safe non-empty fragment instead of a hidden/traversal-like name', () => {
    expect(safeFileName('...')).toBe('_');
    expect(safeFileName('..')).not.toBe('..');
  });
});

describe('key builders produce canonical, owner-scoped keys', () => {
  it('chatAttachmentKey', () => {
    const key = chatAttachmentKey({ workspaceId: WS_A, fileName: 'photo.png', date: new Date('2026-03-05') });
    expect(key).toMatch(new RegExp(`^workspace/${WS_A}/attachments/chat/2026/03/[0-9a-f-]{36}-photo\\.png$`));
  });

  it('emailAttachmentKey', () => {
    const key = emailAttachmentKey({ workspaceId: WS_A, fileName: 'invoice.pdf', date: new Date('2026-01-09') });
    expect(key).toMatch(new RegExp(`^workspace/${WS_A}/attachments/email/2026/01/[0-9a-f-]{36}-invoice\\.pdf$`));
  });

  it('channelAttachmentKey namespaces by provider', () => {
    const key = channelAttachmentKey({ workspaceId: WS_A, provider: 'telegram', fileName: 'v.mp4', date: new Date('2026-06-01') });
    expect(key.startsWith(`workspace/${WS_A}/attachments/channels/telegram/2026/06/`)).toBe(true);
  });

  it('contactAvatarKey', () => {
    const key = contactAvatarKey({ workspaceId: WS_A, provider: 'telegram', contactId: 'contact-1', ext: 'JPG' });
    expect(key).toBe(`workspace/${WS_A}/avatars/contacts/telegram/contact-1.jpg`);
  });

  it('aiAgentAvatarKey / callCenterAvatarKey / integrationAvatarKey', () => {
    expect(aiAgentAvatarKey({ workspaceId: WS_A, fileName: 'logo.png' }).startsWith(`workspace/${WS_A}/avatars/ai-agent/`)).toBe(true);
    expect(callCenterAvatarKey({ workspaceId: WS_A, fileName: 'logo.png' }).startsWith(`workspace/${WS_A}/avatars/call-center/`)).toBe(true);
    expect(
      integrationAvatarKey({ workspaceId: WS_A, provider: 'woocommerce', fileName: 'logo.png' }).startsWith(
        `workspace/${WS_A}/avatars/integrations/woocommerce/`,
      ),
    ).toBe(true);
  });

  it('widgetAssetKey', () => {
    expect(widgetAssetKey({ workspaceId: WS_A, category: 'launcher', fileName: 'icon.svg' }).startsWith(`workspace/${WS_A}/widget/launcher/`)).toBe(true);
    expect(widgetAssetKey({ workspaceId: WS_A, category: 'assets', fileName: 'bg.png' }).startsWith(`workspace/${WS_A}/widget/assets/`)).toBe(true);
  });

  it('aiAgentFileKey requires a UUID sourceId', () => {
    const key = aiAgentFileKey({ workspaceId: WS_A, sourceId: SOURCE_ID, fileName: 'kb.md' });
    expect(key.startsWith(`workspace/${WS_A}/ai-agent/files/${SOURCE_ID}/`)).toBe(true);
    expect(() => aiAgentFileKey({ workspaceId: WS_A, sourceId: 'nope', fileName: 'kb.md' })).toThrow(StorageKeyError);
  });

  it('privacyExportKey supports workspace, user and platform owners', () => {
    expect(privacyExportKey({ kind: 'workspace', workspaceId: WS_A }, JOB_ID)).toBe(
      `workspace/${WS_A}/exports/privacy/${JOB_ID}.zip`,
    );
    expect(privacyExportKey({ kind: 'user', userId: USER_A }, JOB_ID)).toBe(`users/${USER_A}/exports/privacy/${JOB_ID}.zip`);
    expect(privacyExportKey({ kind: 'platform' }, JOB_ID)).toBe(`platform/exports/privacy/${JOB_ID}.zip`);
    expect(() => privacyExportKey({ kind: 'workspace', workspaceId: WS_A }, 'not-a-uuid')).toThrow(StorageKeyError);
  });

  it('callRecordingKey requires a UUID callSessionId', () => {
    const key = callRecordingKey({ workspaceId: WS_A, callSessionId: CALL_SESSION, fileName: 'rec.mp4' });
    expect(key).toBe(`workspace/${WS_A}/calls/recordings/${CALL_SESSION}/rec.mp4`);
    expect(() => callRecordingKey({ workspaceId: WS_A, callSessionId: 'nope', fileName: 'rec.mp4' })).toThrow(StorageKeyError);
  });

  it('callArchiveKey', () => {
    const key = callArchiveKey({ workspaceId: WS_A, archiveName: 'archive.zip', date: new Date('2026-02-01') });
    expect(key).toBe(`workspace/${WS_A}/calls/archives/2026/02/archive.zip`);
  });

  it('userAvatarKey is rooted under users/, not workspace/', () => {
    const key = userAvatarKey({ userId: USER_A, ext: 'png' });
    expect(key.startsWith(`users/${USER_A}/avatar/`)).toBe(true);
    expect(key).not.toContain('workspace/');
  });

  it('platformCallCenterRingbackKey is rooted under platform/', () => {
    const key = platformCallCenterRingbackKey({ slot: 'queue-1', fileName: 'ring.mp3' });
    expect(key.startsWith('platform/call-center/ringback/queue-1/')).toBe(true);
  });
});

describe('assertSafeStorageKey — structural traversal/injection defense', () => {
  const unsafe = [
    '../../etc/passwd',
    `workspace/${WS_A}/../${WS_B}/file.png`,
    `workspace/${WS_A}/%2e%2e/x.png`,
    '/absolute/path.png',
    'https://evil.example/x.png',
    `workspace\\${WS_A}\\x.png`,
    'a/b\0c',
    'workspace/%2e%2e%2f/x',
    'a'.repeat(2000),
    '',
  ];

  it.each(unsafe)('rejects %s', (key) => {
    expect(() => assertSafeStorageKey(key)).toThrow(StorageKeyError);
  });

  it('accepts a well-formed canonical key', () => {
    expect(() => assertSafeStorageKey(`workspace/${WS_A}/attachments/chat/2026/01/x-name.png`)).not.toThrow();
  });
});

describe('assertWorkspaceScopedKey / assertUserScopedKey / assertPlatformScopedKey', () => {
  it('accepts a key scoped to the exact workspace', () => {
    expect(() => assertWorkspaceScopedKey(WS_A, `workspace/${WS_A}/attachments/chat/x.png`)).not.toThrow();
  });

  it('rejects a key scoped to a different workspace', () => {
    expect(() => assertWorkspaceScopedKey(WS_A, `workspace/${WS_B}/attachments/chat/x.png`)).toThrow(StorageKeyError);
  });

  it('rejects legacy/non-canonical roots even when they look workspace-ish', () => {
    expect(() => assertWorkspaceScopedKey(WS_A, `avatars/${WS_A}/x.png`)).toThrow(StorageKeyError);
    expect(() => assertWorkspaceScopedKey(WS_A, `email-attachments/${WS_A}/x.png`)).toThrow(StorageKeyError);
    expect(() => assertWorkspaceScopedKey(WS_A, `users/${WS_A}/x.png`)).toThrow(StorageKeyError);
    expect(() => assertWorkspaceScopedKey(WS_A, `platform/x.png`)).toThrow(StorageKeyError);
  });

  it('assertUserScopedKey accepts only the exact user root', () => {
    expect(() => assertUserScopedKey(USER_A, `users/${USER_A}/avatar/x.png`)).not.toThrow();
    expect(() => assertUserScopedKey(USER_A, `users/${WS_B}/avatar/x.png`)).toThrow(StorageKeyError);
    expect(() => assertUserScopedKey(USER_A, `workspace/${WS_A}/avatar/x.png`)).toThrow(StorageKeyError);
  });

  it('assertPlatformScopedKey accepts only platform/', () => {
    expect(() => assertPlatformScopedKey('platform/call-center/ringback/x.mp3')).not.toThrow();
    expect(() => assertPlatformScopedKey(`workspace/${WS_A}/x.png`)).toThrow(StorageKeyError);
  });

  it('assertOwnerScopedKey dispatches by owner kind', () => {
    expect(() => assertOwnerScopedKey({ kind: 'workspace', workspaceId: WS_A }, `workspace/${WS_A}/x`)).not.toThrow();
    expect(() => assertOwnerScopedKey({ kind: 'user', userId: USER_A }, `users/${USER_A}/x`)).not.toThrow();
    expect(() => assertOwnerScopedKey({ kind: 'platform' }, `platform/x`)).not.toThrow();
    expect(() => assertOwnerScopedKey({ kind: 'workspace', workspaceId: WS_A }, `workspace/${WS_B}/x`)).toThrow(StorageKeyError);
  });
});

describe('isKnownLegacyStorageKey', () => {
  it('recognizes the small, registered set of pre-canonicalization shapes', () => {
    expect(isKnownLegacyStorageKey(`avatars/${USER_A}/x.png`)).toBe(true);
    expect(isKnownLegacyStorageKey(`branding/${WS_A}/icon.png`)).toBe(true);
    expect(isKnownLegacyStorageKey(`email-attachments/${WS_A}/2026/01/x.pdf`)).toBe(true);
    expect(isKnownLegacyStorageKey('gs_11111111_222222222222/12345.mp4')).toBe(true);
  });

  it('does not recognize canonical keys or arbitrary non-canonical roots', () => {
    expect(isKnownLegacyStorageKey(`workspace/${WS_A}/attachments/chat/x.png`)).toBe(false);
    expect(isKnownLegacyStorageKey(`users/${USER_A}/avatar/x.png`)).toBe(false);
    expect(isKnownLegacyStorageKey('platform/call-center/ringback/x.mp3')).toBe(false);
    expect(isKnownLegacyStorageKey('some-made-up-root/x.png')).toBe(false);
    expect(isKnownLegacyStorageKey('avatars/not-a-uuid/x.png')).toBe(false);
  });
});

describe('classifyStorageKey', () => {
  it('classifies each canonical root', () => {
    expect(classifyStorageKey(`workspace/${WS_A}/attachments/chat/x.png`)).toEqual({
      owner: { kind: 'workspace', workspaceId: WS_A },
      rest: 'attachments/chat/x.png',
    });
    expect(classifyStorageKey(`users/${USER_A}/avatar/x.png`)).toEqual({
      owner: { kind: 'user', userId: USER_A },
      rest: 'avatar/x.png',
    });
    expect(classifyStorageKey('platform/call-center/ringback/x.mp3')).toEqual({
      owner: { kind: 'platform' },
      rest: 'call-center/ringback/x.mp3',
    });
  });

  it('returns null for legacy / unrecognized roots', () => {
    expect(classifyStorageKey(`avatars/${USER_A}/x.png`)).toBeNull();
    expect(classifyStorageKey(`email-attachments/${WS_A}/x.png`)).toBeNull();
    expect(classifyStorageKey('gs_abcd1234_efgh5678ijkl/12345.mp4')).toBeNull();
  });
});
