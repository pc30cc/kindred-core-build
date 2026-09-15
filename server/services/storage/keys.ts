/**
 * Canonical storage ownership model + key builder.
 *
 * Every Blob/File the platform persists is addressed through this module —
 * no route or service should build a storage key with ad-hoc string
 * interpolation. Three namespaces exist, and every object belongs to
 * exactly one of them:
 *
 *   workspace/<workspaceId>/...   objects owned by a workspace
 *   users/<userId>/...            global, workspace-independent user objects
 *   platform/...                  platform-owned/managed objects
 *
 * See docs/STORAGE_ARCHITECTURE_AUDIT.md for the current-state audit that
 * motivated this module, and docs/STORAGE_ARCHITECTURE_AUDIT.md's "legacy
 * exception" notes in server/services/storage/index.ts for the migration
 * window during which some existing producers still write outside these
 * shapes.
 */

import * as crypto from 'crypto';

// ─── Ownership model ───────────────────────────────────────────────

export type StorageOwner =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'platform' };

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new StorageKeyError(`Invalid ${label}: expected a UUID`);
  }
  return value;
}

// ─── Filename / segment sanitization ────────────────────────────────
//
// Defense in depth only — the full constructed key must still pass
// assertSafeStorageKey()/assertOwnerScopedKey() before being handed to a
// storage provider. Never trust a sanitized filename alone.

const MAX_SAFE_NAME_LENGTH = 150;

/** Strips a display filename down to a safe object-key fragment. */
export function safeFileName(name: string, fallback = 'file'): string {
  const base = String(name || '').normalize('NFKC');
  const lastSegment = base.split(/[\\/]/).pop() || '';
  const cleaned = lastSegment.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_');
  const trimmed = cleaned.slice(0, MAX_SAFE_NAME_LENGTH);
  return trimmed || fallback;
}

function safePathSegment(value: string, fallback = 'unknown'): string {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
  return cleaned || fallback;
}

function safeExt(ext: string, fallback = 'bin'): string {
  const cleaned = String(ext || '').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 10).toLowerCase();
  return cleaned || fallback;
}

function datePathParts(date: Date = new Date()): { yyyy: string; mm: string } {
  return {
    yyyy: String(date.getUTCFullYear()),
    mm: String(date.getUTCMonth() + 1).padStart(2, '0'),
  };
}

function newUuid(): string {
  return crypto.randomUUID();
}

// ─── Owner roots ───────────────────────────────────────────────────

export function workspaceRoot(workspaceId: string): string {
  return `workspace/${requireUuid(workspaceId, 'workspaceId')}`;
}

export function userRoot(userId: string): string {
  return `users/${requireUuid(userId, 'userId')}`;
}

export function platformRoot(): string {
  return 'platform';
}

export function ownerRoot(owner: StorageOwner): string {
  switch (owner.kind) {
    case 'workspace':
      return workspaceRoot(owner.workspaceId);
    case 'user':
      return userRoot(owner.userId);
    case 'platform':
      return platformRoot();
    default: {
      const _exhaustive: never = owner;
      throw new StorageKeyError(`Unknown storage owner kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ─── Key builders ────────────────────────────────────────────────────
//
// One function per storage-producing feature. Every builder returns a key
// rooted under the correct owner namespace; callers never interpolate path
// segments themselves.

export function chatAttachmentKey(opts: { workspaceId: string; fileName: string; date?: Date }): string {
  const { yyyy, mm } = datePathParts(opts.date);
  return `${workspaceRoot(opts.workspaceId)}/attachments/chat/${yyyy}/${mm}/${newUuid()}-${safeFileName(opts.fileName)}`;
}

export function emailAttachmentKey(opts: { workspaceId: string; fileName: string; date?: Date }): string {
  const { yyyy, mm } = datePathParts(opts.date);
  return `${workspaceRoot(opts.workspaceId)}/attachments/email/${yyyy}/${mm}/${newUuid()}-${safeFileName(opts.fileName)}`;
}

export function channelAttachmentKey(opts: {
  workspaceId: string;
  provider: string;
  fileName: string;
  date?: Date;
}): string {
  const { yyyy, mm } = datePathParts(opts.date);
  const provider = safePathSegment(opts.provider);
  return `${workspaceRoot(opts.workspaceId)}/attachments/channels/${provider}/${yyyy}/${mm}/${newUuid()}-${safeFileName(opts.fileName)}`;
}

export function contactAvatarKey(opts: {
  workspaceId: string;
  provider: string;
  contactId: string;
  ext: string;
}): string {
  const provider = safePathSegment(opts.provider);
  const id = safePathSegment(opts.contactId);
  return `${workspaceRoot(opts.workspaceId)}/avatars/contacts/${provider}/${id}.${safeExt(opts.ext)}`;
}

export function aiAgentAvatarKey(opts: { workspaceId: string; fileName: string }): string {
  return `${workspaceRoot(opts.workspaceId)}/avatars/ai-agent/${newUuid()}-${safeFileName(opts.fileName)}`;
}

export function callCenterAvatarKey(opts: { workspaceId: string; fileName: string }): string {
  return `${workspaceRoot(opts.workspaceId)}/avatars/call-center/${newUuid()}-${safeFileName(opts.fileName)}`;
}

export function integrationAvatarKey(opts: {
  workspaceId: string;
  provider: string;
  fileName: string;
}): string {
  const provider = safePathSegment(opts.provider);
  return `${workspaceRoot(opts.workspaceId)}/avatars/integrations/${provider}/${newUuid()}-${safeFileName(opts.fileName)}`;
}

export function widgetAssetKey(opts: {
  workspaceId: string;
  category: 'launcher' | 'assets';
  fileName: string;
}): string {
  return `${workspaceRoot(opts.workspaceId)}/widget/${opts.category}/${newUuid()}-${safeFileName(opts.fileName)}`;
}

export function aiAgentFileKey(opts: { workspaceId: string; sourceId: string; fileName: string }): string {
  const sourceId = requireUuid(opts.sourceId, 'sourceId');
  return `${workspaceRoot(opts.workspaceId)}/ai-agent/files/${sourceId}/${newUuid()}-${safeFileName(opts.fileName)}`;
}

/** Privacy export artifact. `owner` is usually a workspace; platform/self-actor exports use the 'platform' owner. */
export function privacyExportKey(owner: StorageOwner, jobId: string): string {
  const id = requireUuid(jobId, 'jobId');
  return `${ownerRoot(owner)}/exports/privacy/${id}.zip`;
}

export function callRecordingKey(opts: { workspaceId: string; callSessionId: string; fileName: string }): string {
  const sessionId = requireUuid(opts.callSessionId, 'callSessionId');
  return `${workspaceRoot(opts.workspaceId)}/calls/recordings/${sessionId}/${safeFileName(opts.fileName)}`;
}

export function callArchiveKey(opts: { workspaceId: string; archiveName: string; date?: Date }): string {
  const { yyyy, mm } = datePathParts(opts.date);
  return `${workspaceRoot(opts.workspaceId)}/calls/archives/${yyyy}/${mm}/${safeFileName(opts.archiveName)}`;
}

/** Global account avatar — user-owned, independent of workspace membership. */
export function userAvatarKey(opts: { userId: string; ext: string }): string {
  return `${userRoot(opts.userId)}/avatar/${newUuid()}.${safeExt(opts.ext)}`;
}

export function platformCallCenterRingbackKey(opts: { slot: string; fileName: string }): string {
  return `platform/call-center/ringback/${safePathSegment(opts.slot)}/${newUuid()}-${safeFileName(opts.fileName)}`;
}

// ─── Validators ──────────────────────────────────────────────────────

const MAX_KEY_LENGTH = 1024;

/**
 * Structural safety only: no traversal, no absolute paths, no URL scheme,
 * no percent-encoded traversal, no backslash, no null byte. Does NOT check
 * ownership scoping — pair with assertWorkspaceScopedKey / assertUserScopedKey
 * / assertPlatformScopedKey / assertOwnerScopedKey for that.
 */
export function assertSafeStorageKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StorageKeyError('Storage key must be a non-empty string');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new StorageKeyError('Storage key too long');
  }
  const lowered = key.toLowerCase();
  if (
    key.includes('..') ||
    lowered.includes('%2e%2e') ||
    lowered.includes('%2f') ||
    lowered.includes('%5c') ||
    lowered.includes('%00') ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.startsWith('/') ||
    lowered.includes('://')
  ) {
    throw new StorageKeyError('Storage key contains unsafe path segments');
  }
}

export function assertWorkspaceScopedKey(workspaceId: string, key: unknown): asserts key is string {
  assertSafeStorageKey(key);
  const prefix = `${workspaceRoot(workspaceId)}/`;
  if (!(key as string).startsWith(prefix)) {
    throw new StorageKeyError(`Storage key must be scoped to workspace/${workspaceId}/`);
  }
}

export function assertUserScopedKey(userId: string, key: unknown): asserts key is string {
  assertSafeStorageKey(key);
  const prefix = `${userRoot(userId)}/`;
  if (!(key as string).startsWith(prefix)) {
    throw new StorageKeyError(`Storage key must be scoped to users/${userId}/`);
  }
}

export function assertPlatformScopedKey(key: unknown): asserts key is string {
  assertSafeStorageKey(key);
  if (!(key as string).startsWith('platform/')) {
    throw new StorageKeyError('Storage key must be scoped to platform/');
  }
}

export function assertOwnerScopedKey(owner: StorageOwner, key: unknown): asserts key is string {
  switch (owner.kind) {
    case 'workspace':
      assertWorkspaceScopedKey(owner.workspaceId, key);
      return;
    case 'user':
      assertUserScopedKey(owner.userId, key);
      return;
    case 'platform':
      assertPlatformScopedKey(key);
      return;
    default: {
      const _exhaustive: never = owner;
      throw new StorageKeyError(`Unknown storage owner kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ─── Legacy shape allowlist (migration window only) ─────────────────
//
// Known pre-canonicalization WORKSPACE key shapes that predate the
// workspace/users/platform namespace convention. Each pattern here maps to
// a specific, still-open migration tracked in
// docs/STORAGE_ARCHITECTURE_AUDIT.md, so the small number of legacy
// producers (workspace branding, LiveKit egress recordings, and reads of
// email attachments written before the email-attachments/ -> canonical
// migration) keep working under strict service-layer enforcement without
// their call sites needing their own escape hatch. New code must NEVER
// produce a key matching one of these — always build keys with one of the
// functions above. Remove an entry only once its producer has fully
// migrated; never add a new entry to route around enforcement — that
// defeats the point.
//
// Note: `avatars/<userId>/...` (the account avatar legacy shape) is
// intentionally NOT here — it was never workspace-owned. Its
// migration-window bypass is scoped to user owners only, in
// server/services/storage/index.ts's enforceOwnerScope, so a
// workspace-resolved or platform-resolved call can never smuggle a key
// through this shape.
const LEGACY_KEY_PATTERNS: RegExp[] = [
  /^branding\/[0-9a-f-]{36}\//i, // account.ts workspace icon (target: workspace/<id>/branding/...)
  /^email-attachments\/[0-9a-f-]{36}\//i, // pre-migration email_attachments.storage_key rows (writers already migrated)
  /^gs_[0-9a-f]{8}_[0-9a-f-]{1,24}\//i, // LiveKit egress recordings (target: workspace/<id>/calls/recordings/<sessionId>/...)
];

export function isKnownLegacyStorageKey(key: unknown): boolean {
  return typeof key === 'string' && LEGACY_KEY_PATTERNS.some((re) => re.test(key));
}

export interface ClassifiedStorageKey {
  owner: StorageOwner;
  rest: string;
}

/**
 * Best-effort classification of an existing key by its root segment.
 * Returns null for keys that don't match any of the three canonical roots
 * (e.g. a legacy pre-migration key) — callers must handle that explicitly
 * rather than assuming every stored key is canonical yet.
 */
export function classifyStorageKey(key: string): ClassifiedStorageKey | null {
  if (typeof key !== 'string') return null;
  const wsMatch = /^workspace\/([0-9a-f-]{36})\/(.*)$/i.exec(key);
  if (wsMatch && UUID_RE.test(wsMatch[1])) {
    return { owner: { kind: 'workspace', workspaceId: wsMatch[1] }, rest: wsMatch[2] };
  }
  const userMatch = /^users\/([0-9a-f-]{36})\/(.*)$/i.exec(key);
  if (userMatch && UUID_RE.test(userMatch[1])) {
    return { owner: { kind: 'user', userId: userMatch[1] }, rest: userMatch[2] };
  }
  if (key.startsWith('platform/')) {
    return { owner: { kind: 'platform' }, rest: key.slice('platform/'.length) };
  }
  return null;
}
