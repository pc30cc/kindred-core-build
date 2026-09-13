/**
 * Archive abstraction for the retention engine.
 *
 * The retention engine NEVER talks to a storage backend directly — it asks
 * this registry for an adapter and degrades safely when none is configured.
 * The intended production implementation is Parquet + ZSTD written to
 * S3-compatible object storage; deliberately NOT implemented here, because a
 * hand-rolled Parquet writer would be worse than no archive at all. Until an
 * adapter is registered, `archive_then_delete` policies REFUSE to delete
 * (the run finishes `partial` with `archive_adapter_unavailable`).
 *
 * HTML/CSV are user-facing exports, not an analytical archive format, and are
 * intentionally not an option here.
 */
import type { RetentionPolicy } from './types.js';

export interface ArchiveBatchRequest {
  policy: RetentionPolicy;
  /** Inclusive upper bound — rows strictly older than this are in scope. */
  cutoff: string;
  batchSize: number;
}

export interface ArchiveBatchResult {
  rowsArchived: number;
  bytesArchived: number | null;
  /** Adapter-specific locator (object key, path, …) recorded in run metadata. */
  locator?: string;
  /** false → the engine must not delete anything for this policy. */
  supported: boolean;
  reason?: string;
}

export interface ArchiveAdapter {
  readonly name: string;
  /** Reports whether this adapter can currently accept writes. */
  isAvailable(): Promise<boolean>;
  archiveBatch(req: ArchiveBatchRequest): Promise<ArchiveBatchResult>;
}

/** Default adapter: explicitly unavailable, never silently drops data. */
export const unavailableArchiveAdapter: ArchiveAdapter = {
  name: 'unavailable',
  async isAvailable() { return false; },
  async archiveBatch() {
    return { rowsArchived: 0, bytesArchived: null, supported: false, reason: 'archive_adapter_unavailable' };
  },
};

let registered: ArchiveAdapter = unavailableArchiveAdapter;

export function registerArchiveAdapter(adapter: ArchiveAdapter): void {
  registered = adapter;
}

export function getArchiveAdapter(): ArchiveAdapter {
  return registered;
}

/** Test/reset hook. */
export function resetArchiveAdapter(): void {
  registered = unavailableArchiveAdapter;
}
