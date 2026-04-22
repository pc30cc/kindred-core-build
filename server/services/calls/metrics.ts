/**
 * Phase 8B - Thin wrapper over emitMetric() for the call layer.
 *
 * Keeps call-specific tag conventions in one place so panels/dashboards
 * can rely on a stable shape:
 *   metric: 'call.create.success' | 'call.create.failure' |
 *           'call.token.success'  | 'call.token.failure'  |
 *           'call.join.success'   | 'call.join.failure'   |
 *           'call.setup.latency'  | 'call.recording.start.success' |
 *           'call.recording.start.failure' | 'call.recording.stop.success' |
 *           'call.recording.stop.failure'  | 'call.active.count'   |
 *           'call.webhook.received' | 'call.webhook.dedup'
 *
 * tags always include: provider, call_type (when known), reason (failures).
 */
import type { ServerConfig } from '../../config.js';
import { emitMetric } from '../observability/metrics.js';

export type CallMetricName =
  | 'call.create.success'
  | 'call.create.failure'
  | 'call.token.success'
  | 'call.token.failure'
  | 'call.join.success'
  | 'call.join.failure'
  | 'call.setup.latency'
  | 'call.recording.start.success'
  | 'call.recording.start.failure'
  | 'call.recording.stop.success'
  | 'call.recording.stop.failure'
  | 'call.active.count'
  | 'call.webhook.received'
  | 'call.webhook.dedup'
  | 'call.provider.not_ready'
  | 'call.turn.missing';

export interface CallMetricInput {
  metric: CallMetricName;
  workspaceId?: string | null;
  provider?: string | null;
  callId?: string | null;
  callType?: string | null;
  reason?: string | null;
  /** Numeric measurement (e.g. setup latency ms). */
  value?: number;
  extra?: Record<string, string | number | boolean | null>;
}

export function emitCallMetric(config: ServerConfig, input: CallMetricInput): void {
  const tags: Record<string, string | number | boolean | null> = {
    ...(input.extra || {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.callType ? { call_type: input.callType } : {}),
    ...(input.callId ? { call_id: input.callId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(typeof input.value === 'number' ? { value: input.value } : {}),
  };
  emitMetric(config, {
    metric: input.metric,
    workspaceId: input.workspaceId ?? null,
    driver: input.provider ?? null,
    source: 'server',
    tags,
  });
}