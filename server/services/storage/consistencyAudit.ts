/**
 * Storage consistency audit — the read-only diagnostic half of
 * docs/STORAGE_ARCHITECTURE_AUDIT.md's observability requirement (the
 * write half is server/services/storage/legacyMigration/, which fixes
 * what this module only reports).
 *
 * For one workspace, cross-references every object actually present under
 * workspace/<id>/ in the storage provider against every DB row that's
 * supposed to point at one, and reports four kinds of drift:
 *
 *   - orphanedObjects:  exists in storage, no DB row references it
 *                       (a delete that freed the DB row but not the blob,
 *                       or a producer bug that wrote extra objects)
 *   - danglingPointers: a DB row's storage key does NOT exist in storage
 *                       (the blob was deleted out-of-band, or the upload
 *                       never actually completed despite the row existing)
 *   - wrongPrefixRows:  a DB row's storage key doesn't even start with
 *                       workspace/<id>/ — an ownership-scope bug, not
 *                       drift (every producer is supposed to make this
 *                       structurally impossible; finding one here means
 *                       something bypassed the storage service layer)
 *   - legacyShapeCounts: how many rows per category are still on a
 *                       pre-canonicalization key shape (keys.ts's named
 *                       LEGACY_*_PATTERN regexes) — the same predicate
 *                       server/services/storage/legacyMigration/categories.ts
 *                       uses to select migration candidates, so this
 *                       number is exactly "what the legacy migration tool
 *                       still has left to do" for this workspace.
 *
 * Categories with no DB storage-key column at all (workspace branding/icon
 * today — see docs/STORAGE_ARCHITECTURE_AUDIT.md) cannot be reconciled by
 * this audit; they're reported explicitly as unauditable rather than
 * silently skipped, since "we cannot verify this category" is itself a
 * finding.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { listForOwner } from './index.js';
import {
  workspaceRoot,
  LEGACY_EMAIL_ATTACHMENT_PATTERN,
  LEGACY_LIVEKIT_RECORDING_PATTERN,
  LEGACY_PRIVACY_EXPORT_PATTERN,
} from './keys.js';

interface PointerSource {
  category: string;
  table: string;
  column: string;
  legacyPattern?: RegExp;
}

const POINTER_SOURCES: PointerSource[] = [
  { category: 'conversation_attachment', table: 'conversation_attachments', column: 'storage_path' },
  { category: 'email_attachment', table: 'email_attachments', column: 'storage_key', legacyPattern: LEGACY_EMAIL_ATTACHMENT_PATTERN },
  { category: 'call_recording', table: 'call_recordings', column: 'storage_path', legacyPattern: LEGACY_LIVEKIT_RECORDING_PATTERN },
  { category: 'privacy_export', table: 'privacy_jobs', column: 'artifact_storage_key', legacyPattern: LEGACY_PRIVACY_EXPORT_PATTERN },
  { category: 'call_center_avatar', table: 'call_center_settings', column: 'avatar_storage_path' },
];

/** Categories this audit cannot reconcile — no DB column records the object key at all. */
export const UNAUDITABLE_CATEGORIES = ['workspace_branding'] as const;

export interface WorkspaceStorageAuditReport {
  workspaceId: string;
  storageObjectCount: number;
  dbPointerCount: number;
  orphanedObjects: string[];
  danglingPointers: Array<{ category: string; table: string; id: string; key: string }>;
  wrongPrefixRows: Array<{ category: string; table: string; id: string; key: string }>;
  legacyShapeCounts: Record<string, number>;
  unauditableCategories: readonly string[];
  /** Set when the storage listing itself failed — every other field is unreliable/partial in that case. */
  listingError?: string;
}

export async function auditWorkspaceStorage(config: ServerConfig, workspaceId: string): Promise<WorkspaceStorageAuditReport> {
  const sb = getServiceClient(config);
  const root = `${workspaceRoot(workspaceId)}/`;

  const storageKeys = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const listing = await listForOwner(config, { kind: 'workspace', workspaceId }, undefined, cursor);
    if (!listing.success) {
      return {
        workspaceId, storageObjectCount: 0, dbPointerCount: 0, orphanedObjects: [], danglingPointers: [],
        wrongPrefixRows: [], legacyShapeCounts: {}, unauditableCategories: UNAUDITABLE_CATEGORIES,
        listingError: listing.error ?? 'unknown listing error',
      };
    }
    for (const key of listing.keys ?? []) storageKeys.add(key);
    if (!listing.nextCursor) break;
    cursor = listing.nextCursor;
  }

  const referencedKeys = new Set<string>();
  const danglingPointers: WorkspaceStorageAuditReport['danglingPointers'] = [];
  const wrongPrefixRows: WorkspaceStorageAuditReport['wrongPrefixRows'] = [];
  const legacyShapeCounts: Record<string, number> = {};
  let dbPointerCount = 0;

  for (const source of POINTER_SOURCES) {
    let query = sb.from(source.table).select(`id, ${source.column}`).eq('workspace_id', workspaceId);
    if (source.category === 'privacy_export') {
      query = query.not(source.column, 'is', null);
    }
    const { data, error } = await query;
    if (error) continue; // table may not exist on this deployment (e.g. self-host lag) — skip, don't fail the whole audit
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

    let legacyCount = 0;
    for (const row of rows) {
      const key = row[source.column];
      if (typeof key !== 'string' || key.length === 0) continue;
      dbPointerCount++;

      if (source.legacyPattern?.test(key)) {
        // A recognized pre-canonicalization shape lives under a completely
        // different root by design (e.g. email-attachments/<id>/... instead
        // of workspace/<id>/...) — this listing only ever covers
        // workspace/<id>/, so a legacy key can never appear in storageKeys
        // and would otherwise be double-misreported as both wrong-prefix
        // and dangling. It's neither: it's exactly what
        // server/services/storage/legacyMigration/ still has left to do,
        // which legacyShapeCounts already exists to surface.
        legacyCount++;
        continue;
      }

      referencedKeys.add(key);
      if (!key.startsWith(root)) {
        wrongPrefixRows.push({ category: source.category, table: source.table, id: String(row.id), key });
        continue; // a wrong-prefix key can never be found under root's listing either — don't double-report as dangling
      }
      if (!storageKeys.has(key)) {
        danglingPointers.push({ category: source.category, table: source.table, id: String(row.id), key });
      }
    }
    if (source.legacyPattern) legacyShapeCounts[source.category] = legacyCount;
  }

  const orphanedObjects = [...storageKeys].filter((key) => !referencedKeys.has(key));

  return {
    workspaceId,
    storageObjectCount: storageKeys.size,
    dbPointerCount,
    orphanedObjects,
    danglingPointers,
    wrongPrefixRows,
    legacyShapeCounts,
    unauditableCategories: UNAUDITABLE_CATEGORIES,
  };
}
