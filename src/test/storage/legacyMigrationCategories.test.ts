/**
 * Concrete legacy migration category providers —
 * server/services/storage/legacyMigration/categories.ts.
 *
 * Focused on the part most likely to be wrong: each category's fetchBatch()
 * builds the correct canonical newKey from a legacy row, and
 * resolveStorageConfig() resolves through the SAME path its category's
 * write path actually uses — most importantly call_recordings, which must
 * NOT go through the generic workspace-attachment resolver (LiveKit writes
 * to its own separate S3-compatible bucket, not the workspace's configured
 * attachment storage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  emailAttachmentsMigrationProvider,
  accountAvatarsMigrationProvider,
  privacyExportsMigrationProvider,
  callRecordingsMigrationProvider,
  workspaceBrandingMigrationProvider,
} from '../../../server/services/storage/legacyMigration/categories';

const WS_A = '11111111-1111-1111-1111-111111111111';
const USER_A = '33333333-3333-3333-3333-333333333333';
const SESSION_A = '55555555-5555-5555-5555-555555555555';
const JOB_1 = '77777777-7777-7777-7777-777777777771';
const JOB_2 = '77777777-7777-7777-7777-777777777772';

const { resolveStorageConfigForOwnerMock, resolvePrivacyStoragePolicyMock, loadLiveKitConfigMock } = vi.hoisted(() => ({
  resolveStorageConfigForOwnerMock: vi.fn(async () => ({ provider: 'local', localPath: '/tmp/storage' })),
  resolvePrivacyStoragePolicyMock: vi.fn(async () => ({
    provider: 'local',
    config: { provider: 'local', localPath: '/tmp/privacy' },
    source: 'platform_default' as const,
    allowAttachmentFallback: false,
  })),
  loadLiveKitConfigMock: vi.fn(async () => ({
    recording_storage: { bucket: 'recordings', region: 'us-east-1', endpoint: null, access_key: 'AKIA', secret_key: 'secret' },
  })),
}));

vi.mock('../../../server/services/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../server/services/storage/index')>('../../../server/services/storage/index');
  return { ...actual, resolveStorageConfigForOwner: resolveStorageConfigForOwnerMock };
});
vi.mock('../../../server/services/privacy/storageResolver.js', () => ({
  resolvePrivacyStoragePolicy: resolvePrivacyStoragePolicyMock,
}));
vi.mock('../../../server/services/calls/livekitConfig.js', () => ({
  loadLiveKitConfig: loadLiveKitConfigMock,
}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function makeBuilder(table: string) {
  const rows = db[table] || (db[table] = []);
  const filters: Array<(r: Row) => boolean> = [];
  let limitN = Infinity;
  const builder = {
    select: () => builder,
    like: (col: string, pattern: string) => {
      const prefix = pattern.replace(/%$/, '');
      filters.push((r) => typeof r[col] === 'string' && (r[col] as string).startsWith(prefix));
      return builder;
    },
    neq: (col: string, val: unknown) => {
      filters.push((r) => r[col] !== val);
      return builder;
    },
    is: (col: string, val: null) => {
      filters.push((r) => (r[col] ?? null) === val);
      return builder;
    },
    not: (col: string, _op: string, val: unknown) => {
      filters.push((r) => (r[col] ?? null) !== val);
      return builder;
    },
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    },
    order: () => builder,
    limit: (n: number) => {
      limitN = n;
      return builder;
    },
    maybeSingle: async () => {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: matched[0] ?? null, error: null };
    },
    update: (patch: Row) => {
      const scoped: Array<(r: Row) => boolean> = [...filters];
      return {
        eq: async (col: string, val: unknown) => {
          scoped.push((r) => r[col] === val);
          for (const r of rows.filter((r2) => scoped.every((f) => f(r2)))) Object.assign(r, patch);
          return { error: null };
        },
      };
    },
    // Makes `await sb.from(x).select(...).like(...).order(...).limit(...)`
    // work directly — the chain methods above all return this same object,
    // so whichever one is awaited last resolves via this thenable.
    then(resolve: (v: { data: Row[]; error: null }) => void) {
      resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, limitN), error: null });
    },
  };
  return builder;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => makeBuilder(table),
  }),
}));

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  resolveStorageConfigForOwnerMock.mockClear();
  resolvePrivacyStoragePolicyMock.mockClear();
  loadLiveKitConfigMock.mockClear();
});

describe('emailAttachmentsMigrationProvider', () => {
  it('builds the canonical key from workspace_id + filename and detects legacy rows', async () => {
    db.email_attachments = [
      { id: 'ea-1', workspace_id: WS_A, filename: 'invoice.pdf', storage_key: `email-attachments/${WS_A}/invoice.pdf` },
      { id: 'ea-2', workspace_id: WS_A, filename: 'ok.pdf', storage_key: `workspace/${WS_A}/attachments/email/2026/09/ok.pdf` },
    ];
    const provider = emailAttachmentsMigrationProvider({} as never);

    const batch = await provider.fetchBatch(10);

    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe('ea-1');
    expect(batch[0].newKey).toMatch(new RegExp(`^workspace/${WS_A}/attachments/email/\\d{4}/\\d{2}/[0-9a-f-]{36}-invoice\\.pdf$`));

    const cfg = await provider.resolveStorageConfig('ea-1');
    expect(cfg.provider).toBe('local');
    expect(resolveStorageConfigForOwnerMock).toHaveBeenCalledWith({}, { kind: 'workspace', workspaceId: WS_A });

    await provider.commitNewKey('ea-1', 'workspace/x/attachments/email/2026/09/new.pdf');
    expect(await provider.readBackKey('ea-1')).toBe('workspace/x/attachments/email/2026/09/new.pdf');
  });
});

describe('accountAvatarsMigrationProvider', () => {
  it('builds users/<id>/avatar/<uuid>.<ext> and resolves the user-owner storage config', async () => {
    db.profiles = [{ id: USER_A, avatar_storage_key: `avatars/${USER_A}/old.png` }];
    const provider = accountAvatarsMigrationProvider({} as never);

    const batch = await provider.fetchBatch(10);

    expect(batch).toHaveLength(1);
    expect(batch[0].newKey).toMatch(new RegExp(`^users/${USER_A}/avatar/[0-9a-f-]{36}\\.png$`));

    await provider.resolveStorageConfig(USER_A);
    expect(resolveStorageConfigForOwnerMock).toHaveBeenCalledWith({}, { kind: 'user', userId: USER_A });
  });

  it('skips rows whose avatar_storage_key is already canonical', async () => {
    db.profiles = [{ id: USER_A, avatar_storage_key: `users/${USER_A}/avatar/abc.png` }];
    const provider = accountAvatarsMigrationProvider({} as never);

    expect(await provider.fetchBatch(10)).toHaveLength(0);
  });
});

describe('privacyExportsMigrationProvider', () => {
  it('routes a workspace-scoped job to the workspace export key and the dedicated privacy resolver', async () => {
    db.privacy_jobs = [{ id: JOB_1, workspace_id: WS_A, subject_id: 'contact-1', artifact_storage_key: `privacy-exports/${WS_A}/${JOB_1}.zip` }];
    const provider = privacyExportsMigrationProvider({} as never);

    const batch = await provider.fetchBatch(10);

    expect(batch[0].newKey).toBe(`workspace/${WS_A}/exports/privacy/${JOB_1}.zip`);
    await provider.resolveStorageConfig(JOB_1);
    expect(resolvePrivacyStoragePolicyMock).toHaveBeenCalledWith({}, WS_A);
  });

  it('routes a user-subject job (old _self sentinel shape) to the user export key', async () => {
    db.privacy_jobs = [{ id: JOB_2, workspace_id: null, subject_id: USER_A, artifact_storage_key: `privacy-exports/_self/${JOB_2}.zip` }];
    const provider = privacyExportsMigrationProvider({} as never);

    const batch = await provider.fetchBatch(10);

    expect(batch[0].newKey).toBe(`users/${USER_A}/exports/privacy/${JOB_2}.zip`);
  });
});

describe('callRecordingsMigrationProvider', () => {
  it('builds the canonical recording key and resolves LiveKit\'s dedicated recording_storage, not the workspace attachment resolver', async () => {
    db.call_recordings = [
      { id: 'rec-1', workspace_id: WS_A, call_session_id: SESSION_A, storage_path: `gs_11111111_555555555555/171234.mp4` },
    ];
    const provider = callRecordingsMigrationProvider({} as never);

    const batch = await provider.fetchBatch(10);

    expect(batch).toHaveLength(1);
    expect(batch[0].newKey).toBe(`workspace/${WS_A}/calls/recordings/${SESSION_A}/171234.mp4`);

    const cfg = await provider.resolveStorageConfig('rec-1');
    expect(loadLiveKitConfigMock).toHaveBeenCalled();
    expect(resolveStorageConfigForOwnerMock).not.toHaveBeenCalled();
    expect(cfg).toMatchObject({ provider: 's3', bucket: 'recordings', accessKeyId: 'AKIA', secretAccessKey: 'secret' });
  });

  it('throws a clear error when LiveKit recording storage is not configured', async () => {
    loadLiveKitConfigMock.mockResolvedValueOnce({ recording_storage: { bucket: null, region: null, endpoint: null, access_key: null, secret_key: null } });
    const provider = callRecordingsMigrationProvider({} as never);

    await expect(provider.resolveStorageConfig('rec-1')).rejects.toThrow(/not configured/);
  });

  it('never treats the empty pending-recording placeholder or an already-canonical path as legacy', async () => {
    db.call_recordings = [
      { id: 'rec-pending', workspace_id: WS_A, call_session_id: SESSION_A, storage_path: '' },
      { id: 'rec-done', workspace_id: WS_A, call_session_id: SESSION_A, storage_path: `workspace/${WS_A}/calls/recordings/${SESSION_A}/out.mp4` },
    ];
    const provider = callRecordingsMigrationProvider({} as never);

    expect(await provider.fetchBatch(10)).toHaveLength(0);
  });
});

describe('workspaceBrandingMigrationProvider', () => {
  it('parses the legacy branding/<workspaceId>/... marker out of logo_url and builds the canonical key', async () => {
    db.workspace_branding = [{
      id: 'wb-1', workspace_id: WS_A, logo_storage_key: null,
      logo_url: `https://cdn.example.com/branding/${WS_A}/icon-1700000000-ab12.png`,
    }];
    const provider = workspaceBrandingMigrationProvider({} as never);

    const batch = await provider.fetchBatch(10);

    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe(WS_A);
    expect(batch[0].oldKey).toBe(`branding/${WS_A}/icon-1700000000-ab12.png`);
    expect(batch[0].newKey).toMatch(new RegExp(`^workspace/${WS_A}/branding/[0-9a-f-]{36}-icon-1700000000-ab12\\.png$`));

    await provider.resolveStorageConfig(WS_A);
    expect(resolveStorageConfigForOwnerMock).toHaveBeenCalledWith({}, { kind: 'workspace', workspaceId: WS_A });
  });

  it('skips a row that already has logo_storage_key set (already migrated)', async () => {
    const key = `workspace/${WS_A}/branding/existing.png`;
    db.workspace_branding = [{ id: 'wb-1', workspace_id: WS_A, logo_storage_key: key, logo_url: `https://cdn/${key}` }];
    const provider = workspaceBrandingMigrationProvider({} as never);

    expect(await provider.fetchBatch(10)).toHaveLength(0);
  });

  it('skips a row with no logo_url at all (nothing to migrate)', async () => {
    db.workspace_branding = [{ id: 'wb-1', workspace_id: WS_A, logo_storage_key: null, logo_url: null }];
    const provider = workspaceBrandingMigrationProvider({} as never);

    expect(await provider.fetchBatch(10)).toHaveLength(0);
  });

  it('commitNewKey writes logo_storage_key and readBackKey reads it back (bare-key column, not the URL column)', async () => {
    db.workspace_branding = [{ id: 'wb-1', workspace_id: WS_A, logo_storage_key: null, logo_url: `https://cdn.example.com/branding/${WS_A}/old.png` }];
    const provider = workspaceBrandingMigrationProvider({} as never);

    await provider.commitNewKey(WS_A, `workspace/${WS_A}/branding/new.png`);

    expect(await provider.readBackKey(WS_A)).toBe(`workspace/${WS_A}/branding/new.png`);
  });
});
