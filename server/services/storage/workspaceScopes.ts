/**
 * Canonical object-key ownership (`workspace/<id>/...`) does NOT imply a
 * single physical storage provider. At least three workspace-owned
 * categories can each resolve to a DIFFERENT physical account:
 *
 *   - 'attachment'        — the workspace's ordinary attachment storage
 *                            (server/services/storage/index.ts's
 *                            resolveStorageConfigForOwner)
 *   - 'privacy_export'     — the dedicated privacy-export provider policy
 *                            (server/services/privacy/storageResolver.ts's
 *                            resolvePrivacyStoragePolicy)
 *   - 'livekit_recording'  — LiveKit's own recording_storage account
 *                            (server/services/calls/recordingStorageResolver.ts)
 *
 * Any code that needs to enumerate or act on "every physical location
 * that can hold workspace/<id>/..." — workspace deletion, the
 * consistency audit — MUST walk all of these scopes, not just the
 * ordinary attachment one. This module is the single place that lists
 * them, so a fourth scope (if one is ever added) only needs to be added
 * here to be picked up everywhere.
 */
import type { ServerConfig } from '../../config.js';
import { resolveStorageConfigForOwner, type StorageConfig } from './index.js';
import { resolvePrivacyStoragePolicy, PrivacyStorageNotConfigured } from '../privacy/storageResolver.js';
import { resolveRecordingStorageConfig, RecordingStorageNotConfigured } from '../calls/recordingStorageResolver.js';

export type WorkspaceStorageScopeName = 'attachment' | 'privacy_export' | 'livekit_recording';

export type ScopeResolution =
  | { configured: true; config: StorageConfig }
  /** The scope's provider is deliberately unset for this deployment (e.g. LiveKit egress never enabled) — nothing to clean up there, not an error. */
  | { configured: false; reason: string };

export interface WorkspaceStorageScope {
  name: WorkspaceStorageScopeName;
  resolve(): Promise<ScopeResolution>;
}

/** The prefix every scope enumerates under — identical across scopes; only the physical account differs. */
export function workspaceScopePrefix(workspaceId: string): string {
  return `workspace/${workspaceId}/`;
}

export function workspaceStorageScopes(config: ServerConfig, workspaceId: string): WorkspaceStorageScope[] {
  return [
    {
      name: 'attachment',
      async resolve(): Promise<ScopeResolution> {
        const cfg = await resolveStorageConfigForOwner(config, { kind: 'workspace', workspaceId });
        if (!cfg) return { configured: false, reason: 'No storage provider configured' };
        return { configured: true, config: cfg };
      },
    },
    {
      name: 'privacy_export',
      async resolve(): Promise<ScopeResolution> {
        try {
          const policy = await resolvePrivacyStoragePolicy(config, workspaceId);
          return { configured: true, config: policy.config };
        } catch (err) {
          if (err instanceof PrivacyStorageNotConfigured) return { configured: false, reason: err.message };
          throw err;
        }
      },
    },
    {
      name: 'livekit_recording',
      async resolve(): Promise<ScopeResolution> {
        try {
          const cfg = await resolveRecordingStorageConfig(config);
          return { configured: true, config: cfg };
        } catch (err) {
          if (err instanceof RecordingStorageNotConfigured) return { configured: false, reason: err.message };
          throw err;
        }
      },
    },
  ];
}

/**
 * Identity of the physical location a StorageConfig points at — two
 * scopes resolving to configs with the same fingerprint are the SAME
 * physical bucket/container, and must be enumerated/deleted only once
 * (never double-scanned, never double-deleted).
 */
export function storageConfigFingerprint(cfg: StorageConfig): string {
  return JSON.stringify([
    cfg.provider,
    cfg.bucket ?? null,
    cfg.storageZone ?? null,
    cfg.endpoint ?? null,
    cfg.s3Region ?? null,
    cfg.localPath ?? null,
  ]);
}
