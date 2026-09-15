/**
 * Concrete LegacyMigrationProviders — one per known pre-canonicalization
 * key shape (docs/STORAGE_ARCHITECTURE_AUDIT.md). Each resolves the exact
 * same StorageConfig its category's write path already uses, so the
 * migrated bytes land in the account the canonical reader will actually
 * look in.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import {
  resolveStorageConfigForOwner,
  type StorageConfig,
} from '../index.js';
import {
  emailAttachmentKey,
  userAvatarKey,
  callRecordingKey,
  privacyExportKey,
  LEGACY_EMAIL_ATTACHMENT_PATTERN,
  LEGACY_USER_AVATAR_PATTERN,
  LEGACY_LIVEKIT_RECORDING_PATTERN,
  LEGACY_PRIVACY_EXPORT_PATTERN,
} from '../keys.js';
import { resolvePrivacyStoragePolicy } from '../../privacy/storageResolver.js';
import { ownerForJob } from '../../privacy/worker.js';
import { loadLiveKitConfig } from '../../calls/livekitConfig.js';
import type { LegacyMigrationCandidate, LegacyMigrationProvider } from './engine.js';

function extFromFileName(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  return m ? m[1] : 'bin';
}

/** email_attachments.storage_key: email-attachments/<workspaceId>/... -> workspace/<id>/attachments/email/... */
export function emailAttachmentsMigrationProvider(config: ServerConfig): LegacyMigrationProvider {
  const sb = getServiceClient(config);
  return {
    category: 'email_attachments',
    async fetchBatch(limit) {
      // workspace_id was denormalized onto this table in
      // database/migrations/178_email_attachments_workspace_scope.sql —
      // every row has it, so no join is needed to resolve the owner.
      const { data, error } = await sb
        .from('email_attachments')
        .select('id, workspace_id, filename, storage_key')
        .like('storage_key', 'email-attachments/%')
        .order('id', { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ id: string; workspace_id: string; filename: string; storage_key: string }>;
      const candidates: LegacyMigrationCandidate[] = [];
      for (const row of rows) {
        if (!LEGACY_EMAIL_ATTACHMENT_PATTERN.test(row.storage_key)) continue;
        candidates.push({
          id: row.id,
          oldKey: row.storage_key,
          newKey: emailAttachmentKey({ workspaceId: row.workspace_id, fileName: row.filename }),
        });
      }
      return candidates;
    },
    async resolveStorageConfig(candidateId) {
      const { data, error } = await sb.from('email_attachments').select('workspace_id').eq('id', candidateId).maybeSingle();
      if (error || !data) throw new Error(error?.message || 'email_attachments row not found');
      const cfg: StorageConfig | null = await resolveStorageConfigForOwner(config, { kind: 'workspace', workspaceId: data.workspace_id });
      if (!cfg) throw new Error(`No storage provider configured for workspace ${data.workspace_id}`);
      return cfg;
    },
    async commitNewKey(candidateId, newKey) {
      const { error } = await sb.from('email_attachments').update({ storage_key: newKey }).eq('id', candidateId);
      if (error) throw new Error(error.message);
    },
    async readBackKey(candidateId) {
      const { data } = await sb.from('email_attachments').select('storage_key').eq('id', candidateId).maybeSingle();
      return (data as { storage_key?: string } | null)?.storage_key ?? null;
    },
  };
}

/** profiles.avatar_storage_key: avatars/<userId>/... -> users/<id>/avatar/... */
export function accountAvatarsMigrationProvider(config: ServerConfig): LegacyMigrationProvider {
  const sb = getServiceClient(config);
  return {
    category: 'account_avatars',
    async fetchBatch(limit) {
      const { data, error } = await sb
        .from('profiles')
        .select('id, avatar_storage_key')
        .like('avatar_storage_key', 'avatars/%')
        .order('id', { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ id: string; avatar_storage_key: string | null }>;
      const candidates: LegacyMigrationCandidate[] = [];
      for (const row of rows) {
        if (!row.avatar_storage_key || !LEGACY_USER_AVATAR_PATTERN.test(row.avatar_storage_key)) continue;
        const ext = extFromFileName(row.avatar_storage_key);
        candidates.push({
          id: row.id,
          oldKey: row.avatar_storage_key,
          newKey: userAvatarKey({ userId: row.id, ext }),
        });
      }
      return candidates;
    },
    // User-owned assets resolve the platform-wide default provider, not a
    // per-workspace one (server/services/storage/index.ts's
    // resolveStorageConfigForOwner) — same resolver account.ts's upload
    // route already uses for new avatars.
    async resolveStorageConfig(candidateId) {
      const cfg: StorageConfig | null = await resolveStorageConfigForOwner(config, { kind: 'user', userId: candidateId });
      if (!cfg) throw new Error('No global storage provider configured');
      return cfg;
    },
    async commitNewKey(candidateId, newKey) {
      const { error } = await sb.from('profiles').update({ avatar_storage_key: newKey }).eq('id', candidateId);
      if (error) throw new Error(error.message);
    },
    async readBackKey(candidateId) {
      const { data } = await sb.from('profiles').select('avatar_storage_key').eq('id', candidateId).maybeSingle();
      return (data as { avatar_storage_key?: string } | null)?.avatar_storage_key ?? null;
    },
  };
}

/**
 * privacy_jobs.artifact_storage_key: the old privacy-exports/<workspaceId>/...
 * shape (workspace-scoped jobs) and privacy-exports/_self/... shape
 * (pre-Phase-2 user-subject jobs, routed through a fake sentinel
 * workspaceId) -> workspace/<id>/exports/privacy/... or
 * users/<subjectId>/exports/privacy/....
 */
export function privacyExportsMigrationProvider(config: ServerConfig): LegacyMigrationProvider {
  const sb = getServiceClient(config);
  return {
    category: 'privacy_exports',
    async fetchBatch(limit) {
      const { data, error } = await sb
        .from('privacy_jobs')
        .select('id, workspace_id, subject_id, artifact_storage_key')
        .like('artifact_storage_key', 'privacy-exports/%')
        .order('id', { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ id: string; workspace_id: string | null; subject_id: string; artifact_storage_key: string | null }>;
      const candidates: LegacyMigrationCandidate[] = [];
      for (const row of rows) {
        if (!row.artifact_storage_key || !LEGACY_PRIVACY_EXPORT_PATTERN.test(row.artifact_storage_key)) continue;
        candidates.push({
          id: row.id,
          oldKey: row.artifact_storage_key,
          newKey: privacyExportKey(ownerForJob(row), row.id),
        });
      }
      return candidates;
    },
    // Privacy exports use their own dedicated provider-policy resolver
    // (workspace override -> platform default -> optional attachment
    // fallback), never the generic per-owner one — same resolver worker.ts
    // uses at write time. This is the requirement this project was
    // explicitly told to preserve.
    async resolveStorageConfig(candidateId) {
      const { data, error } = await sb.from('privacy_jobs').select('workspace_id').eq('id', candidateId).maybeSingle();
      if (error || !data) throw new Error(error?.message || 'privacy_jobs row not found');
      const policy = await resolvePrivacyStoragePolicy(config, data.workspace_id);
      return policy.config;
    },
    async commitNewKey(candidateId, newKey) {
      const { error } = await sb
        .from('privacy_jobs')
        .update({ artifact_storage_key: newKey, artifact_path: newKey })
        .eq('id', candidateId);
      if (error) throw new Error(error.message);
    },
    async readBackKey(candidateId) {
      const { data } = await sb.from('privacy_jobs').select('artifact_storage_key').eq('id', candidateId).maybeSingle();
      return (data as { artifact_storage_key?: string } | null)?.artifact_storage_key ?? null;
    },
  };
}

function livekitRecordingStorageConfig(rs: {
  bucket: string | null; region: string | null; endpoint: string | null; access_key: string | null; secret_key: string | null;
}): StorageConfig {
  if (!rs.bucket || !rs.access_key || !rs.secret_key) {
    throw new Error('LiveKit recording storage (bucket / access_key / secret_key) is not configured.');
  }
  return {
    provider: 's3',
    accessKeyId: rs.access_key,
    secretAccessKey: rs.secret_key,
    bucket: rs.bucket,
    s3Region: rs.region ?? undefined,
    endpoint: rs.endpoint ?? undefined,
  };
}

/**
 * call_recordings.storage_path: the old <providerRoomId>/<ts>.mp4 shape
 * (LiveKit's own room-naming convention, no workspace prefix at all) ->
 * workspace/<id>/calls/recordings/<callSessionId>/....
 *
 * LiveKit's egress worker writes recordings directly to LiveKit's own
 * configured S3-compatible bucket (server/services/calls/livekitConfig.ts's
 * recording_storage), a completely separate account from the workspace's
 * attachment storage provider — resolveStorageConfigForOwner() would read
 * the wrong bucket entirely. This provider resolves the same
 * recording_storage config server/services/calls/providers/livekitProvider.ts
 * uses to start a recording.
 */
export function callRecordingsMigrationProvider(config: ServerConfig): LegacyMigrationProvider {
  const sb = getServiceClient(config);
  return {
    category: 'call_recordings',
    async fetchBatch(limit) {
      const { data, error } = await sb
        .from('call_recordings')
        .select('id, workspace_id, call_session_id, storage_path')
        .neq('storage_path', '')
        .order('id', { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ id: string; workspace_id: string; call_session_id: string; storage_path: string }>;
      const candidates: LegacyMigrationCandidate[] = [];
      for (const row of rows) {
        if (!LEGACY_LIVEKIT_RECORDING_PATTERN.test(row.storage_path)) continue;
        const fileName = row.storage_path.split('/').pop() || `${Date.now()}.mp4`;
        candidates.push({
          id: row.id,
          oldKey: row.storage_path,
          newKey: callRecordingKey({ workspaceId: row.workspace_id, callSessionId: row.call_session_id, fileName }),
        });
      }
      return candidates;
    },
    async resolveStorageConfig() {
      const lk = await loadLiveKitConfig(config);
      return livekitRecordingStorageConfig(lk.recording_storage);
    },
    async commitNewKey(candidateId, newKey) {
      const { error } = await sb.from('call_recordings').update({ storage_path: newKey }).eq('id', candidateId);
      if (error) throw new Error(error.message);
    },
    async readBackKey(candidateId) {
      const { data } = await sb.from('call_recordings').select('storage_path').eq('id', candidateId).maybeSingle();
      return (data as { storage_path?: string } | null)?.storage_path ?? null;
    },
  };
}

export function allLegacyMigrationProviders(config: ServerConfig): LegacyMigrationProvider[] {
  return [
    emailAttachmentsMigrationProvider(config),
    accountAvatarsMigrationProvider(config),
    privacyExportsMigrationProvider(config),
    callRecordingsMigrationProvider(config),
  ];
}
