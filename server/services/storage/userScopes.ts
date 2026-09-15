/**
 * Analogous to server/services/storage/workspaceScopes.ts, but for a
 * USER's global `users/<userId>/...` objects. Second corrective pass, P0
 * finding: user deletion assumed every `users/<userId>/...` object lives
 * in the global/default user storage provider, but a user-subject privacy
 * export (`users/<userId>/exports/privacy/<jobId>.zip` —
 * server/services/storage/keys.ts's privacyExportKey with a `user` owner)
 * physically lives in the DEDICATED privacy storage provider
 * (resolvePrivacyStoragePolicy), which can be a completely different
 * physical account. User deletion must clean both, not just the default
 * one — see server/services/userDeletion/worker.ts.
 */
import type { ServerConfig } from '../../config.js';
import { resolveStorageConfigForOwner, type StorageConfig } from './index.js';
import { resolvePrivacyStoragePolicy, PrivacyStorageNotConfigured } from '../privacy/storageResolver.js';

export type UserStorageScopeName = 'default' | 'privacy_export';

export type UserScopeResolution =
  | { configured: true; config: StorageConfig }
  | { configured: false; reason: string };

export interface UserStorageScope {
  name: UserStorageScopeName;
  resolve(): Promise<UserScopeResolution>;
}

/** The prefix every user scope enumerates under — identical across scopes; only the physical account differs. */
export function userScopePrefix(userId: string): string {
  return `users/${userId}/`;
}

export function userStorageScopes(config: ServerConfig, userId: string): UserStorageScope[] {
  return [
    {
      name: 'default',
      async resolve(): Promise<UserScopeResolution> {
        const cfg = await resolveStorageConfigForOwner(config, { kind: 'user', userId });
        if (!cfg) return { configured: false, reason: 'No global storage provider configured' };
        return { configured: true, config: cfg };
      },
    },
    {
      name: 'privacy_export',
      async resolve(): Promise<UserScopeResolution> {
        try {
          // User-subject privacy jobs carry workspace_id = null — the same
          // resolver privacy/worker.ts uses for those jobs
          // (resolvePrivacyStoragePolicy(config, null)), so this resolves
          // through the exact policy path that actually wrote the object.
          const policy = await resolvePrivacyStoragePolicy(config, null);
          return { configured: true, config: policy.config };
        } catch (err) {
          if (err instanceof PrivacyStorageNotConfigured) return { configured: false, reason: err.message };
          throw err;
        }
      },
    },
  ];
}
