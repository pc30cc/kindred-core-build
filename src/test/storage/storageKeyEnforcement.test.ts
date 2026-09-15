/**
 * Service-layer enforcement tests for the workspace-resolved storage
 * operations (uploadFile / downloadFile / downloadFileRange / deleteFile /
 * getFileUrl) in server/services/storage/index.ts.
 *
 * These prove the loophole documented in docs/STORAGE_ARCHITECTURE_AUDIT.md
 * is closed: an internal caller cannot bypass workspace scoping just
 * because it talks to the service directly instead of going through
 * /api/storage/* (which has its own, route-level check). The service layer
 * itself must fail closed.
 *
 * The local filesystem provider is used end-to-end (no network, no real
 * DB) — same technique as recordingRangeDownload.test.ts.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

interface MockQueryBuilder {
  from: (table: string) => MockQueryBuilder;
  select: (...args: unknown[]) => MockQueryBuilder;
  eq: (...args: unknown[]) => MockQueryBuilder;
  order: (...args: unknown[]) => MockQueryBuilder;
  limit: (...args: unknown[]) => MockQueryBuilder;
  not: (...args: unknown[]) => MockQueryBuilder;
  single: () => Promise<{ data: unknown }>;
  maybeSingle: () => Promise<{ data: unknown }>;
  insert: (...args: unknown[]) => Promise<{ data: unknown; error: unknown }>;
}

export const mockInsertCalls: Array<{ table: string; row: unknown }> = [];

// Mutable — read by the mocked `workspaces` table lookup inside
// isWorkspaceDeleting() (server/services/storage/index.ts). null means "no
// workspace row" (every existing test in this file never set it, matching
// the pre-existing default { data: null } behavior below, so this is
// backward compatible).
export const mockWorkspaceStatus = { current: null as string | null };

vi.mock('../../../server/supabase.js', () => {
  // No workspace-level provider_configs override; app_runtime_config
  // resolves to a fully-configured local provider (publicUrl set, so
  // localUpload doesn't fail-loud on the missing-public-url guard) — same
  // shape resolveStorageConfig() expects from a real DB row.
  const makeBuilder = (table: string): MockQueryBuilder => {
    const builder: MockQueryBuilder = {
      from: (t: string) => makeBuilder(t),
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      not: () => builder,
      single: async () => {
        if (table === 'app_runtime_config') {
          return { data: { value: { provider_name: 'local', config: { local_path: '/tmp/storage', public_url: 'http://local.test' } } } };
        }
        return { data: null };
      },
      maybeSingle: async () => {
        // resolveGlobalStorageConfig() (used for user/platform owners, since
        // there's no workspace to derive a provider from) queries via
        // maybeSingle, not single — mirror the same local+publicUrl config.
        if (table === 'app_runtime_config') {
          return { data: { value: { provider_name: 'local', config: { local_path: '/tmp/storage', public_url: 'http://local.test' } } } };
        }
        if (table === 'workspaces') {
          return { data: mockWorkspaceStatus.current ? { status: mockWorkspaceStatus.current } : null };
        }
        return { data: null };
      },
      insert: async (row: unknown) => {
        mockInsertCalls.push({ table, row });
        return { data: null, error: null };
      },
    };
    return builder;
  };
  return { getServiceClient: () => makeBuilder('') };
});

import * as storage from '../../../server/services/storage/index';
import { chatAttachmentKey, userAvatarKey } from '../../../server/services/storage/keys';
import type { ServerConfig } from '../../../server/config';

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const USER_A = '33333333-3333-3333-3333-333333333333';

// resolveStorageConfig's final fallback (no workspace override, no global
// default configured in the mocked DB) is { provider: 'local', localPath:
// '/tmp/storage' } — shared with other suites, so every test below cleans
// up the specific keys it writes rather than wiping the directory.
beforeAll(() => {
  if (!existsSync('/tmp/storage')) mkdirSync('/tmp/storage', { recursive: true });
});

const PNG_BYTES = Buffer.from('fake-png-bytes');

describe('uploadFile — workspace scope enforcement', () => {
  it('rejects a key scoped to a different workspace', async () => {
    const r = await storage.uploadFile({} as unknown as ServerConfig, {
      workspaceId: WS_A,
      fileKey: `workspace/${WS_B}/attachments/chat/x.png`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/scoped to workspace/);
  });

  it('rejects a key under the users/ root', async () => {
    const r = await storage.uploadFile({} as unknown as ServerConfig, {
      workspaceId: WS_A,
      fileKey: `users/${USER_A}/avatar/x.png`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a key under the platform/ root', async () => {
    const r = await storage.uploadFile({} as unknown as ServerConfig, {
      workspaceId: WS_A,
      fileKey: 'platform/call-center/ringback/x.mp3',
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an arbitrary unregistered non-canonical root (the legacy allowlist is narrow, not blanket)', async () => {
    const r = await storage.uploadFile({} as unknown as ServerConfig, {
      workspaceId: WS_A,
      fileKey: `some-made-up-root/${WS_A}/x.png`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a canonical, exactly-scoped key and writes it through the local provider', async () => {
    const key = chatAttachmentKey({ workspaceId: WS_A, fileName: 'photo.png' });
    const r = await storage.uploadFile({} as unknown as ServerConfig, {
      workspaceId: WS_A,
      fileKey: key,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(r.success).toBe(true);
    expect(existsSync(join('/tmp/storage', key))).toBe(true);
    rmSync(join('/tmp/storage', key), { force: true });
  });

  it('automatically permits the small, registered set of pre-canonicalization WORKSPACE legacy shapes (branding/, email-attachments/, LiveKit gs_ rooms) without callers needing an explicit flag', async () => {
    const legacyKeys = [
      `branding/${WS_A}/icon.png`,
      `email-attachments/${WS_A}/2026/01/x.pdf`,
      'gs_11111111_222222222222/12345.mp4',
    ];
    for (const fileKey of legacyKeys) {
      const r = await storage.uploadFile({} as unknown as ServerConfig, {
        workspaceId: WS_A,
        fileKey,
        data: PNG_BYTES,
        contentType: 'image/png',
      });
      expect(r.success, fileKey).toBe(true);
      rmSync(join('/tmp/storage', fileKey), { force: true, recursive: true });
    }
  });

  it('the registered legacy allowlist still enforces basic path safety (no traversal smuggled through a legacy-looking prefix)', async () => {
    const r = await storage.uploadFile({} as unknown as ServerConfig, {
      workspaceId: WS_A,
      fileKey: `avatars/${USER_A}/../../../etc/passwd`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(r.success).toBe(false);
  });

  it('the allowLegacyKey escape hatch permits a one-off unregistered key while still enforcing basic path safety', async () => {
    const allowed = await storage.uploadFile({} as unknown as ServerConfig, {
      workspaceId: WS_A,
      fileKey: 'some-one-off-root/legacy-test.png',
      data: PNG_BYTES,
      contentType: 'image/png',
      allowLegacyKey: true,
    });
    expect(allowed.success).toBe(true);
    rmSync(join('/tmp/storage', 'some-one-off-root/legacy-test.png'), { force: true });

    const stillUnsafe = await storage.uploadFile({} as unknown as ServerConfig, {
      workspaceId: WS_A,
      fileKey: '../../etc/passwd',
      data: PNG_BYTES,
      contentType: 'image/png',
      allowLegacyKey: true,
    });
    expect(stillUnsafe.success).toBe(false);
  });
});

describe('deleteFile — workspace scope enforcement', () => {
  it('rejects deleting a key scoped to a different workspace', async () => {
    const r = await storage.deleteFile({} as unknown as ServerConfig, WS_A, `workspace/${WS_B}/attachments/chat/x.png`);
    expect(r.success).toBe(false);
  });

  it('rejects deleting a users/-rooted key from a workspace-resolved call', async () => {
    const r = await storage.deleteFile({} as unknown as ServerConfig, WS_A, `users/${USER_A}/avatar/x.png`);
    expect(r.success).toBe(false);
  });

  it('rejects deleting a platform/-rooted key from a workspace-resolved call', async () => {
    const r = await storage.deleteFile({} as unknown as ServerConfig, WS_A, 'platform/call-center/ringback/x.mp3');
    expect(r.success).toBe(false);
  });

  it('allows deletion of a correctly-scoped canonical key', async () => {
    const key = chatAttachmentKey({ workspaceId: WS_A, fileName: 'to-delete.png' });
    await storage.uploadFile({} as unknown as ServerConfig, { workspaceId: WS_A, fileKey: key, data: PNG_BYTES, contentType: 'image/png' });
    const r = await storage.deleteFile({} as unknown as ServerConfig, WS_A, key);
    expect(r.success).toBe(true);
    expect(existsSync(join('/tmp/storage', key))).toBe(false);
  });
});

describe('downloadFile / downloadFileRange / getFileUrl — workspace scope enforcement', () => {
  it('downloadFile rejects a cross-workspace key', async () => {
    const r = await storage.downloadFile({} as unknown as ServerConfig, WS_A, `workspace/${WS_B}/attachments/chat/x.png`);
    expect(r.success).toBe(false);
  });

  it('downloadFileRange rejects a cross-workspace key', async () => {
    const r = await storage.downloadFileRange({} as unknown as ServerConfig, WS_A, `workspace/${WS_B}/attachments/chat/x.png`);
    expect(r.success).toBe(false);
  });

  it('downloadFileRange rejects a users/-rooted key', async () => {
    const r = await storage.downloadFileRange({} as unknown as ServerConfig, WS_A, `users/${USER_A}/avatar/x.png`);
    expect(r.success).toBe(false);
  });

  it('getFileUrl returns null for a cross-workspace key instead of resolving it', async () => {
    const url = await storage.getFileUrl({} as unknown as ServerConfig, WS_A, `workspace/${WS_B}/attachments/chat/x.png`);
    expect(url).toBeNull();
  });

  it('getFileUrl returns null for a platform/-rooted key from a workspace-resolved call', async () => {
    const url = await storage.getFileUrl({} as unknown as ServerConfig, WS_A, 'platform/call-center/ringback/x.mp3');
    expect(url).toBeNull();
  });

  it('downloadFile succeeds for a correctly-scoped canonical key', async () => {
    const key = chatAttachmentKey({ workspaceId: WS_A, fileName: 'readable.png' });
    await storage.uploadFile({} as unknown as ServerConfig, { workspaceId: WS_A, fileKey: key, data: PNG_BYTES, contentType: 'image/png' });
    const r = await storage.downloadFile({} as unknown as ServerConfig, WS_A, key);
    expect(r.success).toBe(true);
    expect(r.data?.equals(PNG_BYTES)).toBe(true);
    rmSync(join('/tmp/storage', key), { force: true });
  });
});

describe('uploadForOwner / downloadForOwner / deleteForOwner / getFileUrlForOwner — owner-generic operations', () => {
  it('accepts a canonical users/<userId>/... key for a user owner and round-trips through the local provider', async () => {
    const key = userAvatarKey({ userId: USER_A, ext: 'png' });
    const uploaded = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'user', userId: USER_A },
      fileKey: key,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(uploaded.success).toBe(true);
    expect(existsSync(join('/tmp/storage', key))).toBe(true);

    const downloaded = await storage.downloadForOwner({} as unknown as ServerConfig, { kind: 'user', userId: USER_A }, key);
    expect(downloaded.success).toBe(true);
    expect(downloaded.data?.equals(PNG_BYTES)).toBe(true);

    const url = await storage.getFileUrlForOwner({} as unknown as ServerConfig, { kind: 'user', userId: USER_A }, key);
    expect(url).toBe(`http://local.test/${key}`);

    const deleted = await storage.deleteForOwner({} as unknown as ServerConfig, { kind: 'user', userId: USER_A }, key);
    expect(deleted.success).toBe(true);
    expect(existsSync(join('/tmp/storage', key))).toBe(false);
  });

  it('rejects a user-owned upload scoped to a different user', async () => {
    const r = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'user', userId: USER_A },
      fileKey: `users/${WS_A}/avatar/x.png`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a user-owned call writing into workspace/ or platform/', async () => {
    const a = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'user', userId: USER_A },
      fileKey: `workspace/${WS_A}/attachments/chat/x.png`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(a.success).toBe(false);

    const b = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'user', userId: USER_A },
      fileKey: 'platform/call-center/ringback/x.mp3',
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(b.success).toBe(false);
  });

  it('automatically permits the legacy avatars/<userId>/... shape for a user owner (account avatar migration window)', async () => {
    const legacyKey = `avatars/${USER_A}/old-avatar.png`;
    const r = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'user', userId: USER_A },
      fileKey: legacyKey,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(r.success).toBe(true);
    rmSync(join('/tmp/storage', legacyKey), { force: true });
  });

  it('does NOT permit the legacy avatars/ shape for a workspace or platform owner (the bypass is user-owner-specific)', async () => {
    const a = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'workspace', workspaceId: WS_A },
      fileKey: `avatars/${USER_A}/x.png`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(a.success).toBe(false);

    const b = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'platform' },
      fileKey: `avatars/${USER_A}/x.png`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(b.success).toBe(false);
  });

  it('accepts a canonical platform/... key for a platform owner', async () => {
    const key = 'platform/call-center/ringback/queue-1/tone.mp3';
    const r = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'platform' },
      fileKey: key,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(r.success).toBe(true);
    rmSync(join('/tmp/storage', key), { force: true });
  });

  it('rejects a platform-owned call writing into workspace/ or users/', async () => {
    const a = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'platform' },
      fileKey: `workspace/${WS_A}/attachments/chat/x.png`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(a.success).toBe(false);

    const b = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'platform' },
      fileKey: `users/${USER_A}/avatar/x.png`,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(b.success).toBe(false);
  });

  it('never writes to storage_usage_logs for user/platform-owned uploads (not workspace quota)', async () => {
    mockInsertCalls.length = 0;
    const key = userAvatarKey({ userId: USER_A, ext: 'png' });
    await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'user', userId: USER_A },
      fileKey: key,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(mockInsertCalls.some((c) => c.table === 'storage_usage_logs')).toBe(false);
    rmSync(join('/tmp/storage', key), { force: true });
  });

  it('still writes to storage_usage_logs for workspace-owned uploads (unchanged single-writer quota behavior)', async () => {
    mockInsertCalls.length = 0;
    const key = chatAttachmentKey({ workspaceId: WS_A, fileName: 'quota-check.png' });
    await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'workspace', workspaceId: WS_A },
      fileKey: key,
      data: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(mockInsertCalls.some((c) => c.table === 'storage_usage_logs')).toBe(true);
    rmSync(join('/tmp/storage', key), { force: true });
  });
});

describe('uploadForOwner — workspace deletion write-lock', () => {
  afterEach(() => {
    mockWorkspaceStatus.current = null;
  });

  it('rejects an upload for a workspace whose status is deleting', async () => {
    mockWorkspaceStatus.current = 'deleting';
    const key = chatAttachmentKey({ workspaceId: WS_A, fileName: 'should-not-land.png' });

    const r = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'workspace', workspaceId: WS_A },
      fileKey: key,
      data: PNG_BYTES,
      contentType: 'image/png',
    });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/being deleted/);
    expect(existsSync(join('/tmp/storage', key))).toBe(false);
  });

  it('still allows an upload for an active workspace (no false-positive lock)', async () => {
    mockWorkspaceStatus.current = 'active';
    const key = chatAttachmentKey({ workspaceId: WS_A, fileName: 'active-ws-ok.png' });

    const r = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'workspace', workspaceId: WS_A },
      fileKey: key,
      data: PNG_BYTES,
      contentType: 'image/png',
    });

    expect(r.success).toBe(true);
    rmSync(join('/tmp/storage', key), { force: true });
  });

  it('never applies the write-lock to a user- or platform-owned upload (workspace status is irrelevant to them)', async () => {
    mockWorkspaceStatus.current = 'deleting';
    const key = userAvatarKey({ userId: USER_A, ext: 'png' });

    const r = await storage.uploadForOwner({} as unknown as ServerConfig, {
      owner: { kind: 'user', userId: USER_A },
      fileKey: key,
      data: PNG_BYTES,
      contentType: 'image/png',
    });

    expect(r.success).toBe(true);
    rmSync(join('/tmp/storage', key), { force: true });
  });
});
