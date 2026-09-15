/**
 * Storage consistency audit — the read-only diagnostic half of
 * docs/STORAGE_ARCHITECTURE_AUDIT.md's observability requirement (the
 * write half is server/services/storage/legacyMigration/, which fixes
 * what this module only reports).
 *
 * Corrective-pass P1 fix: a workspace's objects can physically live in up
 * to three DIFFERENT storage providers — ordinary attachment storage,
 * LiveKit's own recording_storage account, and privacy export's own
 * policy-resolved account (server/services/storage/workspaceScopes.ts).
 * The previous version of this audit listed ONLY the ordinary attachment
 * provider and compared every DB pointer (including call_recordings and
 * privacy_jobs, which never live there) against that one listing — a
 * valid LiveKit recording or privacy export was therefore always reported
 * as a "dangling pointer" (its key never appears in the wrong provider's
 * listing) and every ordinary object was reported "orphaned" the moment a
 * LiveKit/privacy key was checked against it. This version lists EACH
 * physical scope separately (deduplicating by resolved StorageConfig
 * fingerprint exactly like server/services/workspaceDeletion/worker.ts, so
 * two scopes pointing at the same bucket are only ever listed once) and
 * cross-references each DB pointer source against the SPECIFIC scope it
 * actually lives in.
 *
 * For one workspace, cross-references every object actually present in
 * each scope against every DB row that's supposed to point at one there,
 * and reports:
 *
 *   - orphanedObjects:  exists in storage, no DB row references it
 *                       (a delete that freed the DB row but not the blob,
 *                       or a producer bug that wrote extra objects) — each
 *                       entry carries which scope it was found in.
 *   - danglingPointers: a DB row's storage key does NOT exist in the scope
 *                       it belongs to (the blob was deleted out-of-band,
 *                       or the upload never actually completed despite the
 *                       row existing).
 *   - wrongPrefixRows:  a DB row's storage key doesn't even start with
 *                       workspace/<id>/ — an ownership-scope bug, not
 *                       drift (every producer is supposed to make this
 *                       structurally impossible; finding one here means
 *                       something bypassed the storage service layer).
 *   - legacyShapeCounts: how many rows per category are still on a
 *                       pre-canonicalization key shape (keys.ts's named
 *                       LEGACY_*_PATTERN regexes) — the same predicate
 *                       server/services/storage/legacyMigration/categories.ts
 *                       uses to select migration candidates.
 *   - scopes:           per-scope {configured, objectCount, error?} — lets
 *                       a caller see directly that e.g. livekit_recording
 *                       was listed from its own provider and never folded
 *                       into the attachment scope's accounting.
 *   - unreliableCategories: categories whose scope failed to resolve/list
 *                       this run — their rows are EXCLUDED from
 *                       danglingPointers/orphanedObjects rather than
 *                       misreported, since "we don't know" is not the
 *                       same finding as "this pointer is dangling".
 *
 * workspace_branding.logo_storage_key (184_workspace_branding_storage_key.sql)
 * is the first workspace-branding audit signal this tool has ever had — a
 * legacy row written before that column existed has a NULL
 * logo_storage_key, so its key is instead recovered by parsing logo_url
 * for the same `/branding/<id>/` marker the legacy migration provider
 * uses, purely to count it under legacyShapeCounts (a legacy-shaped URL
 * can never be verified against a storage listing without first knowing
 * its bare key, which is exactly what migrating it produces).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { listWithConfig } from './index.js';
import {
  workspaceScopePrefix,
  workspaceStorageScopes,
  storageConfigFingerprint,
  type WorkspaceStorageScopeName,
} from './workspaceScopes.js';
import {
  LEGACY_EMAIL_ATTACHMENT_PATTERN,
  LEGACY_LIVEKIT_RECORDING_PATTERN,
  LEGACY_PRIVACY_EXPORT_PATTERN,
  LEGACY_BRANDING_PATTERN,
} from './keys.js';

interface PointerSource {
  category: string;
  table: string;
  column: string;
  scope: WorkspaceStorageScopeName;
  legacyPattern?: RegExp;
  /**
   * Only for columns whose legacy rows never got a bare key at all — the
   * key must be recovered by parsing a URL column instead (workspace_branding
   * before 184). When set, a row with an empty `column` falls back to
   * parsing `legacyUrlColumn` for `legacyUrlMarker(workspaceId)` purely to
   * count it in legacyShapeCounts; it can never be verified against a
   * storage listing (no bare key to check), so it's never reported as
   * dangling or wrong-prefix either.
   */
  legacyUrlColumn?: string;
  legacyUrlMarker?: (workspaceId: string) => string;
}

const POINTER_SOURCES: PointerSource[] = [
  { category: 'conversation_attachment', table: 'conversation_attachments', column: 'storage_path', scope: 'attachment' },
  { category: 'email_attachment', table: 'email_attachments', column: 'storage_key', scope: 'attachment', legacyPattern: LEGACY_EMAIL_ATTACHMENT_PATTERN },
  { category: 'call_recording', table: 'call_recordings', column: 'storage_path', scope: 'livekit_recording', legacyPattern: LEGACY_LIVEKIT_RECORDING_PATTERN },
  { category: 'privacy_export', table: 'privacy_jobs', column: 'artifact_storage_key', scope: 'privacy_export', legacyPattern: LEGACY_PRIVACY_EXPORT_PATTERN },
  { category: 'call_center_avatar', table: 'call_center_settings', column: 'avatar_storage_path', scope: 'attachment' },
  {
    category: 'workspace_branding', table: 'workspace_branding', column: 'logo_storage_key', scope: 'attachment',
    legacyPattern: LEGACY_BRANDING_PATTERN, legacyUrlColumn: 'logo_url',
    legacyUrlMarker: (workspaceId) => `/branding/${workspaceId}/`,
  },
  // Contact avatars ingested from a channel. The key column arrived with
  // migration 190; before it, the row held only an absolute URL, so a
  // pre-migration row that the conservative backfill could not prove
  // simply has no key and is invisible here — correctly, since there is
  // nothing to verify a listing against.
  { category: 'contact_avatar', table: 'contacts', column: 'avatar_storage_key', scope: 'attachment' },
];

export interface WorkspaceScopeAuditInfo {
  configured: boolean;
  objectCount: number;
  reason?: string;
  listingError?: string;
  /** Another scope name this one shares a physical StorageConfig with (dedup) — its objectCount/keys are the same underlying listing, not double-counted in the workspace total. */
  dedupOf?: WorkspaceStorageScopeName;
}

export interface WorkspaceStorageAuditReport {
  workspaceId: string;
  storageObjectCount: number;
  dbPointerCount: number;
  orphanedObjects: Array<{ scope: WorkspaceStorageScopeName; key: string }>;
  danglingPointers: Array<{ category: string; table: string; scope: WorkspaceStorageScopeName; id: string; key: string }>;
  wrongPrefixRows: Array<{ category: string; table: string; id: string; key: string }>;
  legacyShapeCounts: Record<string, number>;
  scopes: Record<WorkspaceStorageScopeName, WorkspaceScopeAuditInfo>;
  /** Categories whose scope failed to resolve or list this run — excluded from dangling/orphaned reporting rather than misreported as drift. */
  unreliableCategories: string[];
}

async function listScopeFully(
  config: ServerConfig,
  workspaceId: string,
  scopeConfig: Awaited<ReturnType<Awaited<ReturnType<typeof workspaceStorageScopes>>[number]['resolve']>>,
): Promise<{ keys: Set<string> } | { error: string }> {
  if (!scopeConfig.configured) return { keys: new Set() };
  const keys = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const listing = await listWithConfig(scopeConfig.config, workspaceScopePrefix(workspaceId), cursor);
    if (!listing.success) return { error: listing.error ?? 'unknown listing error' };
    for (const key of listing.keys ?? []) keys.add(key);
    if (!listing.nextCursor) break;
    cursor = listing.nextCursor;
  }
  return { keys };
}

export async function auditWorkspaceStorage(config: ServerConfig, workspaceId: string): Promise<WorkspaceStorageAuditReport> {
  const sb = getServiceClient(config);
  const root = workspaceScopePrefix(workspaceId);

  const scopes = await workspaceStorageScopes(config, workspaceId);
  const scopeKeys = new Map<WorkspaceStorageScopeName, Set<string>>();
  const scopeInfo = {} as Record<WorkspaceStorageScopeName, WorkspaceScopeAuditInfo>;
  const fingerprintOwner = new Map<string, WorkspaceStorageScopeName>();

  for (const scope of scopes) {
    let resolution;
    try {
      resolution = await scope.resolve();
    } catch (err) {
      scopeInfo[scope.name] = { configured: false, objectCount: 0, listingError: err instanceof Error ? err.message : String(err) };
      continue;
    }
    if (!resolution.configured) {
      scopeInfo[scope.name] = { configured: false, objectCount: 0, reason: resolution.reason };
      continue;
    }

    const fingerprint = storageConfigFingerprint(resolution.config);
    const dedupTarget = fingerprintOwner.get(fingerprint);
    if (dedupTarget) {
      const keys = scopeKeys.get(dedupTarget)!;
      scopeKeys.set(scope.name, keys);
      scopeInfo[scope.name] = { configured: true, objectCount: keys.size, dedupOf: dedupTarget };
      continue;
    }

    const listed = await listScopeFully(config, workspaceId, resolution);
    if ('error' in listed) {
      scopeInfo[scope.name] = { configured: true, objectCount: 0, listingError: listed.error };
      continue;
    }
    fingerprintOwner.set(fingerprint, scope.name);
    scopeKeys.set(scope.name, listed.keys);
    scopeInfo[scope.name] = { configured: true, objectCount: listed.keys.size };
  }

  const referencedKeys = new Map<WorkspaceStorageScopeName, Set<string>>();
  const danglingPointers: WorkspaceStorageAuditReport['danglingPointers'] = [];
  const wrongPrefixRows: WorkspaceStorageAuditReport['wrongPrefixRows'] = [];
  const legacyShapeCounts: Record<string, number> = {};
  const unreliableCategories: string[] = [];
  let dbPointerCount = 0;

  for (const source of POINTER_SOURCES) {
    const info = scopeInfo[source.scope];
    const scopeReliable = !!info && info.configured && !info.listingError;
    if (!scopeReliable) unreliableCategories.push(source.category);

    const selectCols = ['id', source.column, ...(source.legacyUrlColumn ? [source.legacyUrlColumn] : [])].join(', ');
    let query = sb.from(source.table).select(selectCols).eq('workspace_id', workspaceId);
    if (source.category === 'privacy_export') query = query.not(source.column, 'is', null);
    const { data, error } = await query;
    if (error) continue; // table may not exist on this deployment (e.g. self-host lag) — skip, don't fail the whole audit
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

    let legacyCount = 0;
    for (const row of rows) {
      const key = row[source.column];

      if ((typeof key !== 'string' || key.length === 0) && source.legacyUrlColumn && source.legacyUrlMarker) {
        const url = row[source.legacyUrlColumn];
        if (typeof url === 'string') {
          const marker = source.legacyUrlMarker(workspaceId);
          const idx = url.indexOf(marker);
          if (idx >= 0) {
            const extracted = url.slice(idx + 1);
            if (extracted && source.legacyPattern?.test(extracted)) legacyCount++;
          }
        }
        continue;
      }

      if (typeof key !== 'string' || key.length === 0) continue;
      dbPointerCount++;

      if (source.legacyPattern?.test(key)) {
        // A recognized pre-canonicalization shape lives under a completely
        // different root by design — this scope's listing only ever covers
        // workspace/<id>/, so a legacy key can never appear there and would
        // otherwise be double-misreported as both wrong-prefix and dangling.
        legacyCount++;
        continue;
      }

      if (!scopeReliable) continue; // can't verify against a scope we failed to list — not a finding, just unknown

      if (!referencedKeys.has(source.scope)) referencedKeys.set(source.scope, new Set());
      referencedKeys.get(source.scope)!.add(key);

      if (!key.startsWith(root)) {
        wrongPrefixRows.push({ category: source.category, table: source.table, id: String(row.id), key });
        continue; // a wrong-prefix key can never be found under root's listing either — don't double-report as dangling
      }
      const keys = scopeKeys.get(source.scope);
      if (!keys || !keys.has(key)) {
        danglingPointers.push({ category: source.category, table: source.table, scope: source.scope, id: String(row.id), key });
      }
    }
    if (source.legacyPattern) legacyShapeCounts[source.category] = (legacyShapeCounts[source.category] ?? 0) + legacyCount;
  }

  const orphanedObjects: WorkspaceStorageAuditReport['orphanedObjects'] = [];
  const reportedFingerprints = new Set<WorkspaceStorageScopeName>();
  for (const [scopeName, keys] of scopeKeys.entries()) {
    const info = scopeInfo[scopeName];
    if (info?.dedupOf) continue; // this scope's keys are the same Set object as its dedup target — reported once, under the target
    if (reportedFingerprints.has(scopeName)) continue;
    reportedFingerprints.add(scopeName);
    const referenced = referencedKeys.get(scopeName) ?? new Set<string>();
    for (const key of keys) {
      if (!referenced.has(key)) orphanedObjects.push({ scope: scopeName, key });
    }
  }

  const storageObjectCount = [...reportedFingerprints].reduce((sum, name) => sum + (scopeKeys.get(name)?.size ?? 0), 0);

  return {
    workspaceId,
    storageObjectCount,
    dbPointerCount,
    orphanedObjects,
    danglingPointers,
    wrongPrefixRows,
    legacyShapeCounts,
    scopes: scopeInfo,
    unreliableCategories: [...new Set(unreliableCategories)],
  };
}
