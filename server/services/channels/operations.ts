/**
 * PROVIDER OPERATIONS — Core side.
 *
 * Core never talks to a channel provider. When a provider-side action is
 * needed (connect a bot, remove a webhook, push branding, read diagnostics,
 * download media), Core writes an OPERATION row plus one `channel_jobs` entry
 * and returns. The Channels Worker — the only process on the unrestricted
 * network — executes it and reports the result back through
 * `/internal/channels/operation-result`, which Core applies to canonical data.
 *
 * INVARIANTS
 *  - `request` NEVER contains a credential. The worker resolves credentials
 *    itself, server-side, by integration id.
 *  - Core applies every canonical write; the worker only reports facts.
 *  - Operations are durable and idempotent: a crashed worker re-claims the
 *    job, and a duplicate completion is ignored (status is only advanced
 *    from pending/running).
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { enqueueChannelJob } from './jobs.js';
import { redactToken } from '../../../shared/channels/redact.js';

export const PROVIDER_OPERATIONS = [
  'connect',
  'disconnect',
  'webhook_repair',
  'diagnostics',
  'profile_sync',
  'media_fetch',
  'avatar_fetch',
  'outbound_action',
] as const;

export type ProviderOperationKind = (typeof PROVIDER_OPERATIONS)[number];

export type ProviderOperationStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type ProviderOperation = {
  id: string;
  provider: string;
  operation: ProviderOperationKind;
  workspace_id: string;
  integration_id: string | null;
  installation_id: string | null;
  status: ProviderOperationStatus;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export class InFlightOperationError extends Error {
  constructor(readonly operation: ProviderOperationKind) {
    super(`a ${operation} operation is already in flight for this integration`);
    this.name = 'InFlightOperationError';
  }
}

/**
 * Records intent and queues execution. Returns the operation id the caller
 * can poll (or await via `awaitOperation`).
 */
export async function requestProviderOperation(
  config: ServerConfig,
  input: {
    provider: string;
    operation: ProviderOperationKind;
    workspaceId: string;
    integrationId: string | null;
    installationId: string | null;
    request?: Record<string, unknown>;
    requestedBy?: string | null;
    maxAttempts?: number;
  },
): Promise<ProviderOperation> {
  const sb = getServiceClient(config);

  const { data, error } = await sb
    .from('channel_provider_operations')
    .insert({
      provider: input.provider,
      operation: input.operation,
      workspace_id: input.workspaceId,
      integration_id: input.integrationId,
      installation_id: input.installationId,
      request: assertCredentialFree(input.request ?? {}),
      requested_by: input.requestedBy ?? null,
    })
    .select('*')
    .single();

  if (error) {
    // The partial unique index guarantees a single in-flight operation of a
    // kind per integration — a double click is a no-op, never a double
    // provider mutation.
    if ((error as any).code === '23505') throw new InFlightOperationError(input.operation);
    throw new Error(`provider operation create failed: ${error.message}`);
  }

  const operation = data as ProviderOperation;

  await enqueueChannelJob(sb, {
    provider: input.provider,
    jobType: 'provider_operation',
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    payload: { operation_id: operation.id, operation: input.operation },
    maxAttempts: input.maxAttempts ?? 5,
  });

  return operation;
}

/**
 * Defence in depth: a credential must never reach the operations table, not
 * even by accident from a future call site.
 */
function assertCredentialFree(request: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(request);
  if (serialized !== redactToken(serialized)) {
    throw new Error('provider operation request must never contain a credential');
  }
  return request;
}

export async function getOperation(
  config: ServerConfig,
  operationId: string,
): Promise<ProviderOperation | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('channel_provider_operations')
    .select('*')
    .eq('id', operationId)
    .maybeSingle();
  if (error) throw new Error(`provider operation read failed: ${error.message}`);
  return (data as ProviderOperation | null) ?? null;
}

/** Marks the operation as picked up by a worker. Idempotent. */
export async function markOperationRunning(config: ServerConfig, operationId: string): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('channel_provider_operations')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', operationId)
    .in('status', ['pending', 'running']);
}

/**
 * Terminal transition. Only advances an operation that is still open, so a
 * duplicate worker report (lease expiry + re-claim) cannot rewrite history.
 */
export async function completeOperation(
  config: ServerConfig,
  operationId: string,
  outcome:
    | { status: 'succeeded'; result?: Record<string, unknown> }
    | { status: 'failed'; errorCode: string; errorMessage?: string },
): Promise<void> {
  const sb = getServiceClient(config);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> =
    outcome.status === 'succeeded'
      ? { status: 'succeeded', result: outcome.result ?? {}, error_code: null, error_message: null }
      : {
          status: 'failed',
          error_code: outcome.errorCode.slice(0, 120),
          error_message: outcome.errorMessage ? redactToken(outcome.errorMessage).slice(0, 500) : null,
        };

  const { error } = await sb
    .from('channel_provider_operations')
    .update({ ...patch, updated_at: now, completed_at: now })
    .eq('id', operationId)
    .in('status', ['pending', 'running']);
  if (error) throw new Error(`provider operation completion failed: ${error.message}`);
}

/**
 * Convenience for interactive HTTP routes: wait a bounded time for the worker
 * to finish, so the operator UI can stay synchronous when the worker is
 * healthy, and degrade to "in progress" when it is not.
 *
 * NOTE: this is a DB poll. It performs no provider network I/O.
 */
export async function awaitOperation(
  config: ServerConfig,
  operationId: string,
  timeoutMs = 20_000,
  intervalMs = 400,
): Promise<ProviderOperation | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const operation = await getOperation(config, operationId);
    if (!operation) return null;
    if (operation.status === 'succeeded' || operation.status === 'failed') return operation;
    if (Date.now() >= deadline) return operation;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Most recent operation of a kind — used by status/diagnostics surfaces. */
export async function latestOperation(
  config: ServerConfig,
  integrationId: string,
  operation: ProviderOperationKind,
): Promise<ProviderOperation | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('channel_provider_operations')
    .select('*')
    .eq('integration_id', integrationId)
    .eq('operation', operation)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`provider operation read failed: ${error.message}`);
  return (data as ProviderOperation | null) ?? null;
}
