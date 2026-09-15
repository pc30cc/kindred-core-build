/**
 * Storage consistency audit — server/services/storage/consistencyAudit.ts.
 *
 * Proves the drift classification: orphaned objects (in storage, no DB
 * row), dangling pointers (DB row, no object), wrong-prefix rows (DB row's
 * key doesn't even start with the workspace's own root — an ownership-scope
 * bug), and legacy-shape counting (mirrors what
 * server/services/storage/legacyMigration/categories.ts would migrate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditWorkspaceStorage, UNAUDITABLE_CATEGORIES } from '../../../server/services/storage/consistencyAudit';

const WS_A = '11111111-1111-1111-1111-111111111111';

const { listForOwnerMock } = vi.hoisted(() => ({ listForOwnerMock: vi.fn() }));
vi.mock('../../../server/services/storage/index.js', () => ({ listForOwner: listForOwnerMock }));

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

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  listForOwnerMock.mockReset();
});

describe('auditWorkspaceStorage', () => {
  it('reports a clean workspace: every object has a pointer, every pointer has an object', async () => {
    const key = `workspace/${WS_A}/attachments/chat/a.png`;
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [key], nextCursor: null });
    db.conversation_attachments = [{ id: 'att-1', workspace_id: WS_A, storage_path: key }];

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.storageObjectCount).toBe(1);
    expect(report.dbPointerCount).toBe(1);
    expect(report.orphanedObjects).toEqual([]);
    expect(report.danglingPointers).toEqual([]);
    expect(report.wrongPrefixRows).toEqual([]);
  });

  it('flags an object in storage with no referencing DB row as orphaned', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/mystery.bin`], nextCursor: null });

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.orphanedObjects).toEqual([`workspace/${WS_A}/mystery.bin`]);
  });

  it('flags a DB pointer whose object does not exist in storage as dangling', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [], nextCursor: null });
    const key = `workspace/${WS_A}/attachments/chat/gone.png`;
    db.conversation_attachments = [{ id: 'att-1', workspace_id: WS_A, storage_path: key }];

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.danglingPointers).toEqual([{ category: 'conversation_attachment', table: 'conversation_attachments', id: 'att-1', key }]);
  });

  it('flags a DB row whose key does not start with the workspace root as wrong-prefix, never double-counted as dangling', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [], nextCursor: null });
    const OTHER_WS = '22222222-2222-2222-2222-222222222222';
    db.conversation_attachments = [{ id: 'att-1', workspace_id: WS_A, storage_path: `workspace/${OTHER_WS}/leaked.png` }];

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.wrongPrefixRows).toEqual([{ category: 'conversation_attachment', table: 'conversation_attachments', id: 'att-1', key: `workspace/${OTHER_WS}/leaked.png` }]);
    expect(report.danglingPointers).toEqual([]);
  });

  it('counts legacy-shaped email_attachments rows without flagging them as drift', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [`email-attachments/${WS_A}/x.pdf`], nextCursor: null });
    db.email_attachments = [{ id: 'ea-1', workspace_id: WS_A, storage_key: `email-attachments/${WS_A}/x.pdf` }];

    const report = await auditWorkspaceStorage({} as never, WS_A);

    // email-attachments/<id>/... doesn't start with workspace/<id>/, so a
    // legacy-shaped row is reported via legacyShapeCounts, not as a
    // wrong-prefix bug (it's a known, tracked migration-window shape) or a
    // dangling pointer (the object genuinely exists, just under the old key).
    expect(report.legacyShapeCounts.email_attachment).toBe(1);
    expect(report.wrongPrefixRows).toEqual([]);
  });

  it('only counts a workspace-owned privacy_jobs row (workspace_id filter applied at the query)', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [], nextCursor: null });
    const key = `workspace/${WS_A}/exports/privacy/job-1.zip`;
    db.privacy_jobs = [{ id: 'job-1', workspace_id: WS_A, artifact_storage_key: key }];

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.danglingPointers.some((d) => d.table === 'privacy_jobs')).toBe(true);
  });

  it('surfaces a listing failure explicitly rather than reporting misleading zero-drift', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: false, error: 'provider_unreachable' });

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.listingError).toBe('provider_unreachable');
    expect(report.orphanedObjects).toEqual([]);
  });

  it('paginates through every listing page before diffing', async () => {
    listForOwnerMock
      .mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/a.png`], nextCursor: 'tok-1' })
      .mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/b.png`], nextCursor: null });

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.storageObjectCount).toBe(2);
    expect(listForOwnerMock).toHaveBeenCalledTimes(2);
    expect(listForOwnerMock).toHaveBeenNthCalledWith(2, {}, { kind: 'workspace', workspaceId: WS_A }, undefined, 'tok-1');
  });

  it('reports workspace_branding as an unauditable category (no DB pointer column exists for it)', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [], nextCursor: null });

    const report = await auditWorkspaceStorage({} as never, WS_A);

    expect(report.unauditableCategories).toEqual(UNAUDITABLE_CATEGORIES);
    expect(report.unauditableCategories).toContain('workspace_branding');
  });
});
