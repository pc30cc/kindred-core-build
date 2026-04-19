/**
 * Local artifact store for privacy export ZIPs.
 *
 * Privacy exports are written to a backend-only directory — never to the
 * customer's storage provider. The /api/privacy/exports/:id/download
 * route streams from here, gated by a single-use signed token. Files are
 * automatically deleted on first successful download or on TTL expiry.
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_DIR = process.env.PRIVACY_EXPORT_DIR || '/tmp/privacy-exports';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function artifactPath(jobId: string): string {
  return path.join(BASE_DIR, `${jobId}.zip`);
}

export function writeArtifact(jobId: string, buffer: Buffer): string {
  ensureDir(BASE_DIR);
  const p = artifactPath(jobId);
  fs.writeFileSync(p, buffer, { mode: 0o600 });
  return p;
}

export function readArtifact(jobId: string): Buffer | null {
  try {
    return fs.readFileSync(artifactPath(jobId));
  } catch {
    return null;
  }
}

export function deleteArtifact(jobId: string): void {
  try {
    fs.unlinkSync(artifactPath(jobId));
  } catch {
    // already gone — fine
  }
}

export function artifactExists(jobId: string): boolean {
  try {
    return fs.statSync(artifactPath(jobId)).isFile();
  } catch {
    return false;
  }
}