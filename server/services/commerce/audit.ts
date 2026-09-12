/**
 * Commerce audit logging — mirrors server/services/privacy/audit.ts exactly:
 * best-effort, workspace-scoped, never throws. No credentials, no PII.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

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
    await sb.from('audit_logs').insert({
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

export async function recordCommerceToolAudit(
  config: ServerConfig,
  input: {
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
  },
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb.from('commerce_tool_audit').insert({
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
    });
  } catch (err) {
    console.warn('[commerce.audit] tool audit write failed:', err instanceof Error ? err.message : err);
  }
}
