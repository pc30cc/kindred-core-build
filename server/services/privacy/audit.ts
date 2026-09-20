/**
 * Audit-log helper for privacy actions.
 *
 * Writes one row per state transition into public.audit_logs with
 * entity_type='privacy_job'. Best-effort: logging failures must not
 * cause the job to fail.
 */

import type { ServerConfig } from '../../config.js';
import { insertAuditLogRows } from '../auditLog.js';
import { getServiceClient } from '../../supabase.js';

export type PrivacyAuditAction =
  | 'privacy.export.requested'
  | 'privacy.export.completed'
  | 'privacy.export.failed'
  | 'privacy.delete.requested'
  | 'privacy.delete.completed'
  | 'privacy.delete.failed'
  | 'privacy.job.cancelled'
  | 'privacy.export.downloaded'
  | 'privacy.reauth.issued'
  | 'privacy.export.expired_purged'
  | 'privacy.export.expired_purge_failed';

export async function writePrivacyAudit(
  config: ServerConfig,
  args: {
    workspaceId: string | null;
    userId: string;
    action: PrivacyAuditAction;
    jobId: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    // audit_logs.workspace_id is NOT NULL in schema; for cross-workspace
    // user-subject jobs we fall back to a sentinel-friendly approach by
    // skipping the write rather than violating the constraint.
    if (!args.workspaceId) return;
    await insertAuditLogRows(config, sb, {
      workspace_id: args.workspaceId,
      user_id: args.userId,
      entity_type: 'privacy_job',
      entity_id: args.jobId,
      action: args.action,
      new_value: (args.metadata as any) || {},
      ip_address: args.ip || null,
    });
  } catch (err) {
    console.error('[privacy] audit log failed:', err);
  }
}