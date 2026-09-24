/**
 * Commerce audit logging — mirrors server/services/privacy/audit.ts exactly:
 * best-effort, workspace-scoped, never throws. No credentials, no PII.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { insertAuditLogRows } from '../auditLog.js';

export async function writeCommerceAudit(
  config: ServerConfig,
  input: {
    workspaceId: string;
    userId?: string | null;
    action: string;
    entityType: 'commerce_connection' | 'commerce_pairing' | 'commerce_tool';
    entityId: string;
    newValue?: Record<string, unknown>;
    ipAddress?: string | null;
  },
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await insertAuditLogRows(config, sb, {
      workspace_id: input.workspaceId,
      user_id: input.userId ?? null,
      entity_type: input.entityType,
      entity_id: input.entityId,
      action: input.action,
      new_value: input.newValue ?? {},
      ip_address: input.ipAddress ?? null,
    });
  } catch (err) {
    console.warn('[commerce.audit] write failed:', err instanceof Error ? err.message : err);
  }
}

export interface CommerceToolAuditRow {
  workspaceId: string;
  connectionId: string | null;
  conversationId?: string | null;
  correlationId?: string | null;
  toolName: string;
  durationMs: number;
  success: boolean;
  safeErrorCode?: string | null;
  cacheHit?: boolean;
  liveRevalidated?: boolean;
  resultCount?: number | null;
}

function toDbRow(input: CommerceToolAuditRow) {
  return {
    workspace_id: input.workspaceId,
    connection_id: input.connectionId,
    conversation_id: input.conversationId ?? null,
    correlation_id: input.correlationId ?? null,
    tool_name: input.toolName,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    success: input.success,
    safe_error_code: input.safeErrorCode ?? null,
    cache_hit: input.cacheHit ?? false,
    live_revalidated: input.liveRevalidated ?? false,
    result_count: input.resultCount ?? null,
  };
}

export async function recordCommerceToolAudit(config: ServerConfig, input: CommerceToolAuditRow): Promise<void> {
  // COMPLIANCE_AUDIT_LOGGING — the single writer of commerce_tool_audit,
  // the record of what an AI agent did against a merchant's store.
  if (config.complianceAuditLoggingEnabled === false) return;
  try {
    const sb = getServiceClient(config);
    await sb.from('commerce_tool_audit').insert(toDbRow(input));
  } catch (err) {
    console.warn('[commerce.audit] tool audit write failed:', err instanceof Error ? err.message : err);
  }
}

/** Upper bound of rows one turn can produce (3 store calls + cached reads + refusals). */
export const MAX_AUDIT_ROWS_PER_TURN = 8;

/**
 * Writes one turn's tool audit rows as ONE multi-row INSERT.
 *
 * Batching is per turn and in memory only: no queue outlives the request, so
 * there is nothing to lose on a crash beyond the turn being processed, and
 * nothing to grow. Every call of the turn is still its own row (the audit is
 * not sampled). Bounded at MAX_AUDIT_ROWS_PER_TURN; best effort and never
 * throws, exactly like the single-row writer. See docs/commerce/OPENCART.md
 * §Audit.
 */
export async function flushCommerceToolAudit(config: ServerConfig, rows: CommerceToolAuditRow[]): Promise<void> {
  if (config.complianceAuditLoggingEnabled === false || !rows.length) return;
  try {
    const sb = getServiceClient(config);
    await sb.from('commerce_tool_audit').insert(rows.slice(0, MAX_AUDIT_ROWS_PER_TURN).map(toDbRow));
  } catch (err) {
    console.warn('[commerce.audit] tool audit batch write failed:', err instanceof Error ? err.message : err);
  }
}
