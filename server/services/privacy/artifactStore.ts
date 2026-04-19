/**
 * Legacy local-disk artifact store — backward compatibility only.
 *
 * BEFORE the storage-provider refactor, privacy export ZIPs were written
 * directly to PRIVACY_EXPORT_DIR on the local filesystem. Existing rows in
 * privacy_jobs with NULL artifact_storage_provider still point here.
 *
 * NEW jobs MUST go through resolvePrivacyStoragePolicy() and the storage
 * provider abstraction (uploadWithConfig / downloadWithConfig / deleteWithConfig).
 * This module now serves only legacy reads/deletes so old artifacts remain
 * downloadable until their TTL expires.
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_DIR = process.env.PRIVACY_EXPORT_DIR || '/tmp/privacy-exports';

function legacyPath(jobId: string): string {
  return path.join(BASE_DIR, `${jobId}.zip`);
}

/** Read a legacy on-disk artifact. Returns null if not present. */
export function readLegacyArtifact(jobId: string): Buffer | null {
  try {
    return fs.readFileSync(legacyPath(jobId));
  } catch {
    return null;
  }
}

/** Delete a legacy on-disk artifact. Idempotent. */
export function deleteLegacyArtifact(jobId: string): void {
  try {
    fs.unlinkSync(legacyPath(jobId));
  } catch {
    // already gone — fine
  }
}

/** Whether a legacy artifact exists on disk for a given job. */
export function legacyArtifactExists(jobId: string): boolean {
  try {
    return fs.statSync(legacyPath(jobId)).isFile();
  } catch {
    return false;
  }
}