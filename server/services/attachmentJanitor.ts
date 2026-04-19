/**
 * Phase 3 — Orphaned attachment janitor.
 *
 * What counts as orphaned:
 *   • status='uploading' and created_at older than ORPHAN_INIT_TTL_MIN.
 *     The init endpoint reserved a row but the upload POST never happened
 *     (browser closed, network dropped, user cancelled mid-flow).
 *   • status='uploaded' and message_id IS NULL and created_at older than
 *     ORPHAN_UNATTACHED_TTL_MIN. The file landed in storage but was never
 *     attached to a message (operator never sent the draft / removed it
 *     after upload finished).
 *
 * Strategy:
 *   • DB rows are flagged as 'failed' with an explicit error_message so
 *     operators can see them in any debugging surface and so subsequent
 *     uploads will not collide. The actual storage object is left in
 *     place — storage GC is provider-specific and intentionally out of
 *     scope here. This keeps the recovery path explicit: the row is in
 *     a known terminal state, never silently deleted.
 *
 * Run cadence: best-effort, every 15 minutes from the server process.
 * Cheap query, indexed by created_at + status. Never throws.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

const ORPHAN_INIT_TTL_MIN = 60;          // 1 hour: init without upload
const ORPHAN_UNATTACHED_TTL_MIN = 24 * 60; // 24 hours: uploaded but not attached
const RUN_INTERVAL_MS = 15 * 60 * 1000;    // 15 minutes

async function sweep(config: ServerConfig): Promise<void> {
  const sb = getServiceClient(config);
  const initCutoff = new Date(Date.now() - ORPHAN_INIT_TTL_MIN * 60 * 1000).toISOString();
  const unattachedCutoff = new Date(Date.now() - ORPHAN_UNATTACHED_TTL_MIN * 60 * 1000).toISOString();

  // Stale 'uploading' rows
  const { data: stuck, error: e1 } = await sb
    .from('conversation_attachments')
    .update({ status: 'failed', error_message: 'orphan: upload never completed' })
    .eq('status', 'uploading')
    .lt('created_at', initCutoff)
    .select('id');
  if (e1) {
    console.warn('[attachmentJanitor] uploading sweep failed:', e1.message);
  } else if (stuck && stuck.length) {
    console.log(`[attachmentJanitor] flagged ${stuck.length} stuck-uploading rows`);
  }

  // Stale 'uploaded' but unattached rows
  const { data: unbound, error: e2 } = await sb
    .from('conversation_attachments')
    .update({ status: 'failed', error_message: 'orphan: never attached to a message' })
    .eq('status', 'uploaded')
    .is('message_id', null)
    .lt('created_at', unattachedCutoff)
    .select('id');
  if (e2) {
    console.warn('[attachmentJanitor] unattached sweep failed:', e2.message);
  } else if (unbound && unbound.length) {
    console.log(`[attachmentJanitor] flagged ${unbound.length} unattached rows`);
  }
}

export function startAttachmentJanitor(config: ServerConfig): void {
  // Fire once shortly after boot, then on a loose interval.
  setTimeout(() => { void sweep(config); }, 60_000);
  setInterval(() => { void sweep(config); }, RUN_INTERVAL_MS);
}
