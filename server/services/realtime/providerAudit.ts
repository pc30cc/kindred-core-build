/**
 * REALTIME — the single choke point for `realtime_provider_audit` writes.
 *
 * Six producers: the four admin realtime routes (configure, preflight
 * failure, connectivity test, node-registry changes), the realtime control
 * plane PUT, and the failover engine's own transition record. Together they
 * are the audit of who changed realtime transport configuration and of every
 * automatic failover that has occurred, so they belong to
 * COMPLIANCE_AUDIT_LOGGING rather than to either ticker flag.
 *
 * NOTE the failover engine's transition row is reached by TWO switches: this
 * one, and REALTIME_FAILOVER_TICKER (with the ticker stopped there are no
 * transitions left to audit). See server/config.ts.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type RealtimeProviderAuditRow = Record<string, unknown>;

/**
 * Callers keep their own try/catch: this deliberately does NOT swallow
 * errors, because several sites already decide for themselves whether an
 * audit failure is worth logging. No-op when COMPLIANCE_AUDIT_LOGGING=off.
 */
export async function recordRealtimeProviderAudit(
  config: ServerConfig,
  row: RealtimeProviderAuditRow,
): Promise<void> {
  if (config.complianceAuditLoggingEnabled === false) return;
  await getServiceClient(config).from('realtime_provider_audit').insert(row as any);
}
