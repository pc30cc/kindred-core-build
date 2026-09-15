/**
 * Canonical resolver for the storage account LiveKit call recordings
 * physically live in.
 *
 * LiveKit's egress worker writes a recording directly to LiveKit's own
 * configured S3-compatible bucket
 * (server/services/calls/livekitConfig.ts's recording_storage,
 * server/services/calls/providers/livekitProvider.ts's startRecording()) —
 * a completely separate provider account from the workspace's ordinary
 * attachment storage (server/services/storage/index.ts's
 * resolveStorageConfig(workspaceId)). The canonical object KEY still
 * follows the same workspace/<id>/calls/recordings/<sessionId>/... shape
 * (server/services/storage/keys.ts's callRecordingKey()) — only the
 * physical account differs.
 *
 * Every consumer that reads, ranged-reads, deletes, audits or migrates a
 * call_recordings.storage_path object MUST resolve through this module
 * (via downloadWithConfig/downloadRangeWithConfig/deleteWithConfig/
 * listWithConfig — the explicit-config primitives, never
 * uploadFile/downloadFile/deleteFile/downloadFileRange's ordinary
 * workspace-resolved wrappers) or it will silently talk to the wrong
 * bucket. Known consumers, all fixed to use this resolver:
 *   - server/routes/recordingPlayback.ts (ranged streaming playback)
 *   - server/routes/adminCalls.ts (admin ranged streaming playback)
 *   - server/routes/callCenter.ts (operator zip-archive export, x2)
 *   - server/services/recordings/retentionJanitor.ts (sole deletion path)
 *   - server/services/storage/legacyMigration/categories.ts (migration tool)
 *   - server/services/workspaceDeletion/worker.ts (workspace deletion)
 *   - server/services/storage/consistencyAudit.ts (drift detection)
 */
import type { ServerConfig } from '../../config.js';
import type { StorageConfig } from '../storage/index.js';
import { loadLiveKitConfig, type LiveKitRecordingStorage } from './livekitConfig.js';

export class RecordingStorageNotConfigured extends Error {}

export function mapLiveKitRecordingStorage(rs: LiveKitRecordingStorage): StorageConfig {
  if (!rs.bucket || !rs.access_key || !rs.secret_key) {
    throw new RecordingStorageNotConfigured(
      'LiveKit recording storage (bucket / access_key / secret_key) is not configured.',
    );
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

/** Resolves the current LiveKit recording_storage config as a StorageConfig. Throws RecordingStorageNotConfigured if unset. */
export async function resolveRecordingStorageConfig(config: ServerConfig): Promise<StorageConfig> {
  const lk = await loadLiveKitConfig(config);
  return mapLiveKitRecordingStorage(lk.recording_storage);
}
