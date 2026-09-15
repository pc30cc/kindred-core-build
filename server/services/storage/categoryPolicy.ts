/**
 * Storage Category Policy — the single registry answering, for every kind
 * of object this platform persists: does it count toward a workspace's
 * storage_gb quota, how long does it live, is it publicly reachable, and
 * who owns it.
 *
 * This is documentation made checkable, not a new enforcement mechanism.
 * `workspace_usage_counters.storage_bytes` keeps exactly one writer — the
 * `trg_storage_usage_logs_apply` trigger on `storage_usage_logs`
 * (docs/STORAGE_COUNTER_ARCHITECTURE.md) — and this registry only decides
 * *whether* a given category's uploader is allowed to write that log row,
 * never how the counter itself is derived.
 *
 * Every category a producer actually writes today is listed as `wired:
 * true`. A `wired: false` category is a real object shape this platform
 * produces whose storage_usage_logs participation has NOT been connected
 * yet — either because the producer still writes through the workspace-
 * generic `uploadFile()`/`uploadForOwner()` gate (which already logs
 * unconditionally for every workspace owner, so it's wired by construction
 * — see the "gate" column) or because it deliberately bypasses that gate
 * (privacy exports, platform ringback audio) and would need explicit work
 * to participate. See docs/STORAGE_ARCHITECTURE_AUDIT.md for the full
 * per-producer inventory this was built from.
 */

export type StorageCategory =
  // Workspace-owned, already routed through uploadFile()/uploadForOwner()
  // — every one of these already writes storage_usage_logs on every
  // successful upload, because that gate logs unconditionally for
  // owner.kind==='workspace'.
  | 'conversation_attachment'
  | 'widget_attachment'
  | 'channel_attachment'
  | 'email_attachment'
  | 'ai_agent_file'
  | 'workspace_branding'
  | 'operator_upload'
  // Workspace-owned, but the producer still ad-hoc string-interpolates its
  // key and calls uploadFile() directly instead of the central key
  // builder (server/services/storage/keys.ts has a builder for it that
  // isn't wired up yet) — tracked in
  // supabase/migrations/20260915091500_call_center_settings_avatar_scope.sql.
  // storage_usage_logs participation is still correct today (uploadFile()
  // logs regardless of key shape); only the KEY SHAPE is non-canonical.
  | 'call_center_avatar'
  // Workspace-owned (for subject_type IN ('contact','visitor')) or
  // user-owned cross-workspace (for subject_type='user') — dual ownership
  // by design, see server/services/privacy/worker.ts's ownerForJob().
  // Bypasses uploadForOwner() entirely (uploadWithConfig with the
  // dedicated privacy provider-policy resolver, per
  // docs/STORAGE_ARCHITECTURE_AUDIT.md's requirement to preserve that
  // resolver) — NOT wired to storage_usage_logs today.
  | 'privacy_export'
  // Workspace-owned, but never routed through this service at all —
  // LiveKit's egress worker writes the object directly to the configured
  // bucket using its own credentials; server/routes/livekitWebhook.ts only
  // records the resulting path in call_recordings after validating it.
  // Metering this would require LiveKit's own byte-count report (egressInfo
  // carries a size), not a storage_usage_logs row — different mechanism,
  // out of scope for this registry.
  | 'call_recording'
  // User-owned, global — deliberately excluded from any workspace's quota.
  | 'account_avatar'
  // Platform-owned — never attributable to a workspace, never counted.
  | 'platform_call_center_ringback'
  | 'platform_asset'
  // Builders exist in keys.ts but no producer writes this shape yet
  // (docs/STORAGE_ARCHITECTURE_AUDIT.md's producer audit). Policy is
  // forward-declared so whoever wires the producer doesn't have to also
  // invent the policy.
  | 'contact_avatar'
  | 'ai_agent_avatar'
  | 'integration_avatar'
  | 'widget_asset';

export type StorageRetentionClass =
  /** No automatic expiry; lives until the owning row/feature deletes it explicitly. */
  | 'indefinite'
  /** Tied to the owning workspace's lifecycle — removed by workspace deletion cleanup, never by a timer. */
  | 'workspace_lifecycle'
  /** Short-lived by design; a background sweep deletes it after a fixed TTL. */
  | 'ttl_short'
  /** Governed by a per-feature retention policy resolver (e.g. call recording retention_policy/legal_hold). */
  | 'policy_driven';

export type StorageVisibility =
  /** Only ever served through a server-authorized, per-request check. */
  | 'private'
  /** Served via a public/CDN URL once uploaded (no per-request authorization). */
  | 'public';

export type StorageOwnerKind = 'workspace' | 'user' | 'platform' | 'workspace_or_user';

export interface StorageCategoryPolicyEntry {
  /**
   * Whether a successful upload in this category should write a
   * `storage_usage_logs` row (and therefore participate in
   * `workspace_usage_counters.storage_bytes`). Structurally this can only
   * ever be true when the object's owner resolves to a workspace — a
   * user- or platform-owned object is never attributed to any workspace's
   * quota, regardless of this flag.
   */
  countsTowardQuota: boolean;
  retention: StorageRetentionClass;
  visibility: StorageVisibility;
  ownerKind: StorageOwnerKind;
  /**
   * True if every current producer of this category already writes
   * `storage_usage_logs` consistently with `countsTowardQuota` (i.e. the
   * policy and the code agree today). False marks a documented gap: either
   * a category that arguably should count but whose producer bypasses the
   * logging gate (privacy_export), or one that legitimately never counts
   * but has no gate to bypass (call_recording, written outside this
   * service entirely).
   */
  wired: boolean;
  notes: string;
}

export const STORAGE_CATEGORY_POLICY: Record<StorageCategory, StorageCategoryPolicyEntry> = {
  conversation_attachment: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'private', ownerKind: 'workspace', wired: true,
    notes: 'server/routes/conversationAttachments.ts -> uploadFile(). Gated by requireLimit(storage_gb) per docs/STORAGE_LIMIT_POLICY.md.',
  },
  widget_attachment: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'private', ownerKind: 'workspace', wired: true,
    notes: 'server/routes/widgetAttachments.ts -> uploadFile(). Gated by requireLimit(storage_gb).',
  },
  channel_attachment: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'private', ownerKind: 'workspace', wired: true,
    notes: 'server/services/channels/telegram/mediaIngest.ts (and equivalent channel media ingesters) -> uploadFile(). Not requireLimit-gated (inbound provider webhooks can\'t be blocked the way an operator upload can), but counted.',
  },
  email_attachment: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'private', ownerKind: 'workspace', wired: true,
    notes: 'server/services/email/inbox.ts + server/routes/internalChannels.ts (gmail/yahoo ingest) -> uploadFile(). DB-scoped by email_attachments_path_scope_check.',
  },
  ai_agent_file: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'private', ownerKind: 'workspace', wired: true,
    notes: 'server/services/ai-agent/files/fileIngestion.ts -> uploadFile().',
  },
  workspace_branding: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'public', ownerKind: 'workspace', wired: true,
    notes: 'server/routes/admin.ts workspace icon -> uploadFile(). Legacy branding/<id>/... shape still allowed (isKnownLegacyStorageKey).',
  },
  operator_upload: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'private', ownerKind: 'workspace', wired: true,
    notes: 'server/routes/storage.ts generic POST /api/storage/upload -> uploadFile(). Gated by requireLimit(storage_gb).',
  },
  call_center_avatar: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'public', ownerKind: 'workspace', wired: true,
    notes: 'server/routes/callCenter.ts avatar upload -> uploadFile(), so logging is correct today even though the key shape is ad-hoc (workspace/<id>/call-center/avatar/... instead of callCenterAvatarKey()\'s workspace/<id>/avatars/call-center/...). See call_center_settings_avatar_path_scope_check.',
  },
  privacy_export: {
    countsTowardQuota: true, retention: 'ttl_short', visibility: 'private', ownerKind: 'workspace_or_user', wired: true,
    notes: 'server/services/privacy/worker.ts -> uploadWithConfig() directly (preserves the dedicated privacy provider-policy resolver), then explicitly calls logWorkspaceStorageUsage() for workspace-owned jobs (workspace_id set) only — user-subject jobs never touch any workspace quota. Symmetric delete-side logging on both purge paths (server/services/privacy/expirySweep.ts\'s TTL sweep and server/routes/privacy.ts\'s auto-purge-on-download) uses privacy_jobs.artifact_size_bytes as the freed-bytes figure, so the counter cannot leak upward.',
  },
  call_recording: {
    countsTowardQuota: false, retention: 'policy_driven', visibility: 'private', ownerKind: 'workspace', wired: false,
    notes: 'Written directly by LiveKit\'s egress worker, never through this service — there is no uploadFile()/uploadForOwner() call to gate. Metering would need egressInfo\'s own size report, a different mechanism entirely. Matches docs/STORAGE_LIMIT_POLICY.md\'s existing "provider-managed system buckets... until/unless we explicitly opt them in" exclusion.',
  },
  account_avatar: {
    countsTowardQuota: false, retention: 'indefinite', visibility: 'public', ownerKind: 'user', wired: true,
    notes: 'server/routes/account.ts -> uploadForOwner() with owner.kind=\'user\'. uploadForOwner only logs for owner.kind===\'workspace\', so this correctly never touches any workspace\'s quota.',
  },
  platform_call_center_ringback: {
    countsTowardQuota: false, retention: 'indefinite', visibility: 'private', ownerKind: 'platform', wired: true,
    notes: 'server/routes/callCenter.ts ringback-audio upload -> uploadWithConfig() with a placeholder all-zero workspaceId (predates the StorageOwner model; the key itself is correctly platform/call-center/ringback/... via platformCallCenterRingbackKey()). Never logs regardless — uploadWithConfig has no logging path at all — so quota exclusion is correct by omission, not by owner.kind gating. The zero-UUID sentinel is a tracked anti-pattern (server/services/storage/keys.ts already has the owner-generic builder) but inert for quota purposes.',
  },
  platform_asset: {
    countsTowardQuota: false, retention: 'indefinite', visibility: 'private', ownerKind: 'platform', wired: true,
    notes: 'Any platform/... object. Never attributable to a workspace by definition.',
  },
  contact_avatar: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'public', ownerKind: 'workspace', wired: false,
    notes: 'server/services/storage/keys.ts has contactAvatarKey() but no producer writes this shape yet (forward-declared).',
  },
  ai_agent_avatar: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'public', ownerKind: 'workspace', wired: false,
    notes: 'aiAgentAvatarKey() exists, unwired.',
  },
  integration_avatar: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'public', ownerKind: 'workspace', wired: false,
    notes: 'integrationAvatarKey() exists, unwired.',
  },
  widget_asset: {
    countsTowardQuota: true, retention: 'workspace_lifecycle', visibility: 'public', ownerKind: 'workspace', wired: false,
    notes: 'widgetAssetKey() exists, unwired.',
  },
};

export function storageCategoryPolicy(category: StorageCategory): StorageCategoryPolicyEntry {
  return STORAGE_CATEGORY_POLICY[category];
}
