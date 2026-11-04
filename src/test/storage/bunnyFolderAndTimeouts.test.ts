/**
 * Bunny Storage deletes a path ending in `/` recursively, so no folder-like
 * key is ever sent as a delete (admin-3); its delete and listing calls have
 * a ceiling, and an unreadable listing is a failure, never "empty"
 * (admin-9); a storage "Test" only reaches a public https endpoint (sweep).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteWithConfig, listWithConfig, testStorageConnection, type StorageConfig } from '../../../server/services/storage/index';
import { assertOwnerScopedKey, assertSafeStorageKey, isFolderLikeKey, StorageKeyError } from '../../../server/services/storage/keys';

const WS = '11111111-1111-4111-8111-111111111111';
const BUNNY: StorageConfig = { provider: 'bunny_storage', apiKey: 'key', storageZone: 'zone' };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('folder keys (admin-3)', () => {
  it.each(['', 'workspace/x/', 'workspace/x//a.png', '/'])('%j is folder-like', (key) => {
    expect(isFolderLikeKey(key)).toBe(true);
  });

  it('an object key is not', () => {
    expect(isFolderLikeKey(`workspace/${WS}/a.png`)).toBe(false);
  });

  it('owner-scoped object checks refuse the workspace root and folders', () => {
    expect(() => assertOwnerScopedKey({ kind: 'workspace', workspaceId: WS }, `workspace/${WS}/`)).toThrow(StorageKeyError);
    expect(() => assertOwnerScopedKey({ kind: 'workspace', workspaceId: WS }, `workspace/${WS}/kb/`)).toThrow(StorageKeyError);
    expect(() => assertOwnerScopedKey({ kind: 'platform' }, 'platform/')).toThrow(StorageKeyError);
    expect(() => assertOwnerScopedKey({ kind: 'workspace', workspaceId: WS }, `workspace/${WS}/kb/a.pdf`)).not.toThrow();
  });

  it('a listing prefix is still accepted as a prefix', () => {
    expect(() => assertSafeStorageKey(`workspace/${WS}/`)).not.toThrow();
  });

  it.each(['', `workspace/${WS}/`, `workspace/${WS}/kb/`])('Bunny never receives a delete for %j', async (key) => {
    const result = await deleteWithConfig(BUNNY, key);
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a file is deleted', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    expect((await deleteWithConfig(BUNNY, `workspace/${WS}/a.png`)).success).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://storage.bunnycdn.com/zone/workspace/${WS}/a.png`);
  });
});

describe('Bunny delete and list (admin-9)', () => {
  const hangUntilAborted = (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

  it('a hung delete is aborted', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangUntilAborted);
    const pending = deleteWithConfig(BUNNY, `workspace/${WS}/a.png`).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(String(await pending)).toMatch(/timed out/);
  });

  it('a hung listing is a failure', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangUntilAborted);
    const pending = listWithConfig(BUNNY, `workspace/${WS}/`);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await pending).toMatchObject({ success: false });
  });

  it('a 200 that is not a JSON array is a failure, not an empty folder', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>maintenance</html>', { status: 200 }));
    expect(await listWithConfig(BUNNY, `workspace/${WS}/`)).toMatchObject({ success: false });
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    expect(await listWithConfig(BUNNY, `workspace/${WS}/`)).toMatchObject({ success: false });
  });

  it('an empty JSON array is an empty folder', async () => {
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }));
    expect(await listWithConfig(BUNNY, `workspace/${WS}/`)).toMatchObject({ success: true, keys: [] });
  });
});

describe('storage Test targets (sweep)', () => {
  it.each([
    [{ provider: 's3', endpoint: 'http://127.0.0.1:9000', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }],
    [{ provider: 'minio', endpoint: 'https://localhost:8000', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }],
    [{ provider: 's3', endpoint: 'https://169.254.169.254', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }],
    [{ provider: 'bunny_storage', apiKey: 'k', storageZone: 'zone', region: 'evil.example/#' }],
    [{ provider: 'bunny_storage', apiKey: 'k', storageZone: '../other' }],
  ])('refuses %j without a request', async (config) => {
    const result = await testStorageConnection(config as StorageConfig);
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
