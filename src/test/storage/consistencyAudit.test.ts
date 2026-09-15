/**
 * Storage consistency audit — server/services/storage/consistencyAudit.ts.
 *
 * Proves the drift classification (orphaned objects, dangling pointers,
 * wrong-prefix rows, legacy-shape counting) AND — the corrective-pass P1
 * fix this file exists to regression-test — that the audit is
 * provider-aware: a call_recordings row (LiveKit's own recording_storage
 * account) or a privacy_jobs row (its own policy-resolved account) is
 * checked against ITS OWN scope's listing, never against the ordinary
 * attachment scope's listing, so a valid LiveKit/privacy object is never
 * misreported as dangling just because it doesn't appear in a different
 * provider's object list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditWorkspaceStorage } from '../../../server/services/storage/consistencyAudit';

const WS_A = '11111111-1111-1111-1111-111111111111';

const { listWithConfigMock, workspaceStorageScopesMock } = vi.hoisted(() => ({
  listWithConfigMock: vi.fn(),
  workspaceStorageScopesMock: vi.fn(),
}));

vi.mock('../../../server/services/storage/index.js', () => ({ listWithConfig: listWithConfigMock }));

vi.mock('../../../server/services/storage/workspaceScopes.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../server/services/storage/workspaceScopes.js');
  return { ...actual, workspaceStorageScopes: workspaceStorageScopesMock };
});

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function makeBuilder(table: string) {
  const rows = db[table] || (db[table] = []);
  const filters: Array<(r: Row) => boolean> = [];
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filters.push((r: Row) => r[col] === val);
      return builder;
    },
    not: (col: string, _op: string, val: unknown) => {
      filters.push((r: Row) => r[col] !== val);
      return builder;
    },
    then: (resolve: (v: { data: Row[]; error: null }) => void) => {
      resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
    },
  };
  return builder;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: (table: string) => makeBuilder(table) }),
}));

const ATTACHMENT_CFG = { provider: 's3' as const, bucket: 'attachments-bucket', accessKeyId: 'a', secretAccessKey: 'b' };
const LIVEKIT_CFG = { provider: 's3' as const, bucket: 'livekit-bucket', accessKeyId: 'c', secretAccessKey: 'd' };
const PRIVACY_CFG = { provider: 's3' as const, bucket: 'privacy-bucket', accessKeyId: 'e', secretAccessKey: 'f' };

type MockCfg = { bucket?: string };
type MockScope = { name: string; resolve: () => Promise<{ configured: true; config: typeof ATTACHMENT_CFG } | { configured: false; reason: string }> };

function defaultScopes(overrides: Partial<Record<'attachment' | 'privacy_export' | 'livekit_recording', MockScope>> = {}) {
  const base = {
    attachment: { name: 'attachment', resolve: async () => ({ configured: true, config: ATTACHMENT_CFG }) },
    privacy_export: { name: 'privacy_export', resolve: async () => ({ configured: true, config: PRIVACY_CFG }) },
    livekit_recording: { name: 'livekit_recording', resolve: async () => ({ configured: true, config: LIVEKIT_CFG }) },
  };
  return [
    overrides.attachment ?? base.attachment,
    overrides.privacy_export ?? base.privacy_export,
    overrides.livekit_recording ?? base.livekit_recording,
  ];
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  listWithConfigMock.mockReset();
  workspaceStorageScopesMock.mockReset();
  workspaceStorageScopesMock.mockReturnValue(defaultScopes());
  // Every scope resolves by default; tests only stub listWithConfig for the
  // scope(s) they care about — an unstubbed scope returns success:true with
  // no keys (an empty provider), matching a workspace with nothing there yet.
  listWithConfigMock.mockResolvedValue({ success: true, keys: [], nextCursor: null });
});

describe('auditWorkspaceStorage', () => {
  it('reports a clean workspace: every object has a pointer, every pointer has an object', async () => {
    const key = `workspace/${WS_A}/attachments/chat/a.png`;
    listWithConfigMock.mockImplementation(async (cfg: MockCfg) =>
      cfg.bucket === 'attachments-bucket' ? { success: true, keys: [key], nextCursor: null } : { success: true, keys: [], nextCursor: null },
    );
    db.conversation_attachments = [{ id: 'att-1', workspace_id: WS_A, storage_path: key }];

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.storageObjectCount).toBe(1);
    expect(report.dbPointerCount).toBe(1);
    expect(report.orphanedObjects).toEqual([]);
    expect(report.danglingPointers).toEqual([]);
    expect(report.wrongPrefixRows).toEqual([]);
  });

  it('flags an object in the attachment scope with no referencing DB row as orphaned, tagged with its scope', async () => {
    const key = `workspace/${WS_A}/mystery.bin`;
    listWithConfigMock.mockImplementation(async (cfg: MockCfg) =>
      cfg.bucket === 'attachments-bucket' ? { success: true, keys: [key], nextCursor: null } : { success: true, keys: [], nextCursor: null },
    );

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.orphanedObjects).toEqual([{ scope: 'attachment', key }]);
  });

  it('flags a DB pointer whose object does not exist in its scope as dangling', async () => {
    const key = `workspace/${WS_A}/attachments/chat/gone.png`;
    db.conversation_attachments = [{ id: 'att-1', workspace_id: WS_A, storage_path: key }];

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.danglingPointers).toEqual([{ category: 'conversation_attachment', table: 'conversation_attachments', scope: 'attachment', id: 'att-1', key }]);
  });

  it('flags a DB row whose key does not start with the workspace root as wrong-prefix, never double-counted as dangling', async () => {
    const OTHER_WS = '22222222-2222-2222-2222-222222222222';
    db.conversation_attachments = [{ id: 'att-1', workspace_id: WS_A, storage_path: `workspace/${OTHER_WS}/leaked.png` }];

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.wrongPrefixRows).toEqual([{ category: 'conversation_attachment', table: 'conversation_attachments', id: 'att-1', key: `workspace/${OTHER_WS}/leaked.png` }]);
    expect(report.danglingPointers).toEqual([]);
  });

  it('counts legacy-shaped email_attachments rows without flagging them as drift', async () => {
    db.email_attachments = [{ id: 'ea-1', workspace_id: WS_A, storage_key: `email-attachments/${WS_A}/x.pdf` }];

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.legacyShapeCounts.email_attachment).toBe(1);
    expect(report.wrongPrefixRows).toEqual([]);
    expect(report.danglingPointers).toEqual([]);
  });

  describe('multi-provider correctness (the corrective-pass P1 fix)', () => {
    it('checks a call_recordings row against the LiveKit recording scope, never the attachment scope', async () => {
      const recKey = `workspace/${WS_A}/calls/recordings/session-1/rec.mp4`;
      // The attachment scope's listing is EMPTY and unrelated — proves the
      // recording is verified against livekit-bucket, not attachments-bucket.
      listWithConfigMock.mockImplementation(async (cfg: MockCfg) => {
        if (cfg.bucket === 'livekit-bucket') return { success: true, keys: [recKey], nextCursor: null };
        return { success: true, keys: [], nextCursor: null };
      });
      db.call_recordings = [{ id: 'rec-1', workspace_id: WS_A, storage_path: recKey }];

      const report = await auditWorkspaceStorage({} as never, WS_A);

      expect(report.danglingPointers).toEqual([]);
      expect(report.scopes.livekit_recording.objectCount).toBe(1);
      expect(report.scopes.attachment.objectCount).toBe(0);
    });

    it('a LiveKit recording key is never reported orphaned just because it is absent from the attachment scope', async () => {
      const recKey = `workspace/${WS_A}/calls/recordings/session-1/rec.mp4`;
      listWithConfigMock.mockImplementation(async (cfg: MockCfg) => {
        if (cfg.bucket === 'livekit-bucket') return { success: true, keys: [recKey], nextCursor: null };
        return { success: true, keys: [], nextCursor: null };
      });
      db.call_recordings = [{ id: 'rec-1', workspace_id: WS_A, storage_path: recKey }];

      const report = await auditWorkspaceStorage({} as never, WS_A);

      expect(report.orphanedObjects).toEqual([]);
    });

    it('checks a privacy_jobs row against the privacy_export scope, never the attachment or livekit scope', async () => {
      const exportKey = `workspace/${WS_A}/exports/privacy/job-1.zip`;
      listWithConfigMock.mockImplementation(async (cfg: MockCfg) => {
        if (cfg.bucket === 'privacy-bucket') return { success: true, keys: [exportKey], nextCursor: null };
        return { success: true, keys: [], nextCursor: null };
      });
      db.privacy_jobs = [{ id: 'job-1', workspace_id: WS_A, artifact_storage_key: exportKey }];

      const report = await auditWorkspaceStorage({} as never, WS_A);

      expect(report.danglingPointers).toEqual([]);
      expect(report.scopes.privacy_export.objectCount).toBe(1);
    });

    it('a genuinely missing LiveKit recording (deleted out-of-band) is still correctly flagged dangling against its own scope', async () => {
      // livekit scope lists nothing — the row's object really is gone.
      db.call_recordings = [{ id: 'rec-1', workspace_id: WS_A, storage_path: `workspace/${WS_A}/calls/recordings/session-1/gone.mp4` }];

      const report = await auditWorkspaceStorage({} as never, WS_A);

      expect(report.danglingPointers).toEqual([
        { category: 'call_recording', table: 'call_recordings', scope: 'livekit_recording', id: 'rec-1', key: `workspace/${WS_A}/calls/recordings/session-1/gone.mp4` },
      ]);
    });

    it('dedups two scopes that resolve to the same physical StorageConfig — lists once, no double-counted storageObjectCount', async () => {
      // attachment and livekit_recording happen to point at the SAME bucket.
      workspaceStorageScopesMock.mockReturnValue(defaultScopes({
        livekit_recording: { name: 'livekit_recording', resolve: async () => ({ configured: true, config: ATTACHMENT_CFG }) },
      }));
      const key = `workspace/${WS_A}/shared.bin`;
      listWithConfigMock.mockImplementation(async (cfg: MockCfg) =>
        cfg.bucket === 'attachments-bucket' ? { success: true, keys: [key], nextCursor: null } : { success: true, keys: [], nextCursor: null },
      );

      const report = await auditWorkspaceStorage({} as never, WS_A);

      // Only one physical listing call for the shared fingerprint (plus one for privacy_export's distinct bucket).
      const attachmentBucketCalls = listWithConfigMock.mock.calls.filter(([cfg]: [MockCfg]) => cfg.bucket === 'attachments-bucket');
      expect(attachmentBucketCalls.length).toBe(1);
      expect(report.scopes.livekit_recording.dedupOf).toBe('attachment');
      expect(report.storageObjectCount).toBe(1); // not double-counted across the two scope names
    });
  });

  describe('scope reliability', () => {
    it('excludes a category from dangling/orphaned reporting when its scope fails to list, and surfaces it as unreliable', async () => {
      listWithConfigMock.mockImplementation(async (cfg: MockCfg) => {
        if (cfg.bucket === 'livekit-bucket') return { success: false, error: 'provider_unreachable' };
        return { success: true, keys: [], nextCursor: null };
      });
      db.call_recordings = [{ id: 'rec-1', workspace_id: WS_A, storage_path: `workspace/${WS_A}/calls/recordings/session-1/x.mp4` }];

      const report = await auditWorkspaceStorage({} as never, WS_A);

      expect(report.danglingPointers).toEqual([]);
      expect(report.unreliableCategories).toContain('call_recording');
      expect(report.scopes.livekit_recording.listingError).toBe('provider_unreachable');
    });

    it('a scope that is simply not configured marks its categories unreliable rather than reporting every row dangling', async () => {
      workspaceStorageScopesMock.mockReturnValue(defaultScopes({
        privacy_export: { name: 'privacy_export', resolve: async () => ({ configured: false, reason: 'no policy configured' }) },
      }));
      db.privacy_jobs = [{ id: 'job-1', workspace_id: WS_A, artifact_storage_key: `workspace/${WS_A}/exports/privacy/job-1.zip` }];

      const report = await auditWorkspaceStorage({} as never, WS_A);

      expect(report.danglingPointers).toEqual([]);
      expect(report.unreliableCategories).toContain('privacy_export');
      expect(report.scopes.privacy_export.configured).toBe(false);
    });
  });

  describe('workspace branding (184_workspace_branding_storage_key.sql)', () => {
    it('checks a canonical branding row (logo_storage_key set) against the attachment scope', async () => {
      const key = `workspace/${WS_A}/branding/icon.png`;
      listWithConfigMock.mockImplementation(async (cfg: MockCfg) =>
        cfg.bucket === 'attachments-bucket' ? { success: true, keys: [key], nextCursor: null } : { success: true, keys: [], nextCursor: null },
      );
      db.workspace_branding = [{ id: 'wb-1', workspace_id: WS_A, logo_storage_key: key, logo_url: `https://cdn/${key}` }];

      const report = await auditWorkspaceStorage({} as never, WS_A);

      expect(report.danglingPointers).toEqual([]);
      expect(report.orphanedObjects).toEqual([]);
    });

    it('counts a legacy branding row (no logo_storage_key, legacy logo_url shape) under legacyShapeCounts, never as dangling', async () => {
      db.workspace_branding = [{
        id: 'wb-1', workspace_id: WS_A, logo_storage_key: null,
        logo_url: `https://cdn.example.com/branding/${WS_A}/icon-old.png`,
      }];

      const report = await auditWorkspaceStorage({} as never, WS_A);

      expect(report.legacyShapeCounts.workspace_branding).toBe(1);
      expect(report.danglingPointers).toEqual([]);
      expect(report.wrongPrefixRows).toEqual([]);
    });

    it('a branding row with neither logo_storage_key nor a recognizable legacy logo_url is silently skipped (nothing to verify)', async () => {
      db.workspace_branding = [{ id: 'wb-1', workspace_id: WS_A, logo_storage_key: null, logo_url: null }];

      const report = await auditWorkspaceStorage({} as never, WS_A);

      expect(report.legacyShapeCounts.workspace_branding).toBe(0);
      expect(report.danglingPointers).toEqual([]);
    });
  });

  it('paginates through every listing page before diffing', async () => {
    listWithConfigMock.mockImplementation(async (cfg: MockCfg, _prefix: string, cursor?: string) => {
      if (cfg.bucket !== 'attachments-bucket') return { success: true, keys: [], nextCursor: null };
      if (!cursor) return { success: true, keys: [`workspace/${WS_A}/a.png`], nextCursor: 'tok-1' };
      return { success: true, keys: [`workspace/${WS_A}/b.png`], nextCursor: null };
    });

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.storageObjectCount).toBe(2);
    const attachmentCalls = listWithConfigMock.mock.calls.filter(([cfg]: [MockCfg]) => cfg.bucket === 'attachments-bucket');
    expect(attachmentCalls.length).toBe(2);
  });
});
