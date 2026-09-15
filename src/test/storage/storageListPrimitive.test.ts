/**
 * The new list()/listWithConfig()/listForOwner() storage primitives
 * (docs/STORAGE_ARCHITECTURE_AUDIT.md's "Provider Abstraction ...
 * list/batch-delete" requirement, added to support workspace deletion's
 * full storage cleanup walk).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listWithConfig, listForOwner, type StorageConfig } from '../../../server/services/storage/index';

const WS_A = '11111111-1111-1111-1111-111111111111';

describe('listWithConfig — local provider', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-list-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recursively lists every file under a prefix, nested directories included', async () => {
    const cfg: StorageConfig = { provider: 'local', localPath: tmpDir };
    fs.mkdirSync(path.join(tmpDir, `workspace/${WS_A}/attachments/email/2026/09`), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, `workspace/${WS_A}/attachments/email/2026/09/a.pdf`), 'a');
    fs.mkdirSync(path.join(tmpDir, `workspace/${WS_A}/branding`), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, `workspace/${WS_A}/branding/logo.png`), 'b');

    const result = await listWithConfig(cfg, `workspace/${WS_A}`);

    expect(result.success).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(new Set(result.keys)).toEqual(new Set([
      `workspace/${WS_A}/attachments/email/2026/09/a.pdf`,
      `workspace/${WS_A}/branding/logo.png`,
    ]));
  });

  it('returns an empty list (not an error) for a prefix with no objects', async () => {
    const cfg: StorageConfig = { provider: 'local', localPath: tmpDir };

    const result = await listWithConfig(cfg, `workspace/${WS_A}`);

    expect(result.success).toBe(true);
    expect(result.keys).toEqual([]);
  });

  it('never returns a file from a sibling workspace under the same base path', async () => {
    const cfg: StorageConfig = { provider: 'local', localPath: tmpDir };
    const WS_B = '22222222-2222-2222-2222-222222222222';
    fs.mkdirSync(path.join(tmpDir, `workspace/${WS_A}`), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, `workspace/${WS_A}/file.txt`), 'a');
    fs.mkdirSync(path.join(tmpDir, `workspace/${WS_B}`), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, `workspace/${WS_B}/file.txt`), 'b');

    const result = await listWithConfig(cfg, `workspace/${WS_A}`);

    expect(result.keys).toEqual([`workspace/${WS_A}/file.txt`]);
  });
});

describe('listWithConfig — S3-compatible provider', () => {
  const cfg: StorageConfig = {
    provider: 's3', accessKeyId: 'AKIA', secretAccessKey: 'secret', bucket: 'my-bucket', s3Region: 'us-east-1',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses ListObjectsV2 XML into keys and reports no cursor when not truncated', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => `<?xml version="1.0"?>
        <ListBucketResult>
          <IsTruncated>false</IsTruncated>
          <Contents><Key>workspace/${WS_A}/a.pdf</Key></Contents>
          <Contents><Key>workspace/${WS_A}/b.pdf</Key></Contents>
        </ListBucketResult>`,
    });

    const result = await listWithConfig(cfg, `workspace/${WS_A}`);

    expect(result.success).toBe(true);
    expect(result.keys).toEqual([`workspace/${WS_A}/a.pdf`, `workspace/${WS_A}/b.pdf`]);
    expect(result.nextCursor).toBeNull();
  });

  it('returns the continuation token when the listing is truncated', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => `<ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>tok-123</NextContinuationToken>
        <Contents><Key>workspace/${WS_A}/a.pdf</Key></Contents>
      </ListBucketResult>`,
    });

    const result = await listWithConfig(cfg, `workspace/${WS_A}`);

    expect(result.nextCursor).toBe('tok-123');
  });

  it('passes a supplied cursor as the continuation-token query param', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' });

    await listWithConfig(cfg, `workspace/${WS_A}`, 'my-cursor');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('continuation-token=my-cursor');
  });

  it('reports failure on a non-OK response instead of throwing', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' });

    const result = await listWithConfig(cfg, `workspace/${WS_A}`);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/403/);
  });
});

describe('listWithConfig — BunnyCDN provider', () => {
  const cfg: StorageConfig = { provider: 'bunny_storage', apiKey: 'key', storageZone: 'zone' };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recursively walks subdirectories using Bunny\'s per-directory JSON listing', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`workspace/${WS_A}/`)) {
        return {
          ok: true,
          json: async () => [
            { ObjectName: 'branding', IsDirectory: true },
            { ObjectName: 'root.txt', IsDirectory: false },
          ],
        };
      }
      if (url.endsWith(`workspace/${WS_A}/branding/`)) {
        return { ok: true, json: async () => [{ ObjectName: 'logo.png', IsDirectory: false }] };
      }
      return { ok: false, status: 404 };
    });

    const result = await listWithConfig(cfg, `workspace/${WS_A}`);

    expect(result.success).toBe(true);
    expect(new Set(result.keys)).toEqual(new Set([
      `workspace/${WS_A}/root.txt`,
      `workspace/${WS_A}/branding/logo.png`,
    ]));
    expect(result.nextCursor).toBeNull();
  });

  it('treats a 404 directory as empty rather than an error', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await listWithConfig(cfg, `workspace/${WS_A}`);

    expect(result.success).toBe(true);
    expect(result.keys).toEqual([]);
  });
});

describe('listForOwner — owner-scope enforcement', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-list-owner-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a prefixSuffix that attempts to traverse outside the owner root', async () => {
    const result = await listForOwner({} as never, { kind: 'workspace', workspaceId: WS_A }, '../../../etc');

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
