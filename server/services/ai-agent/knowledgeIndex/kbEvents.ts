/**
 * Phase 6-S5-R1 — asynchronous Knowledge Base → AI index bridge.
 *
 * The KB write path emits neutral rows into public.knowledge_base_change_events
 * via a database trigger. This consumer lives entirely on the AI side: it
 * drains those events and re-indexes affected workspaces ONLY when the
 * workspace plan includes the `ai_assistant` module.
 *
 * Direction is strictly one-way (KB → AI). A failure here can never surface
 * in, block, or roll back Knowledge Base CRUD.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { checkModuleAccess } from '../../../middleware/featureGating.js';
import { rebuildWorkspaceIndex } from './sync.js';

interface KbChangeEventRow {
  id: string;
  workspace_id: string;
  event_type: string;
  attempts: number;
}

export interface KbEventDrainSummary {
  claimed: number;
  reindexedWorkspaces: number;
  skippedNoPlan: number;
  failed: number;
}

async function markProcessed(config: ServerConfig, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getServiceClient(config).rpc('complete_kb_change_events', { _ids: ids });
}

async function markFailed(config: ServerConfig, ids: string[], error: string): Promise<void> {
  if (ids.length === 0) return;
  await getServiceClient(config).rpc('fail_kb_change_events', {
    _ids: ids,
    _error: error.slice(0, 500),
  });
}

/**
 * Drains one batch of pending KB change events. Never throws.
 *
 * Events are claimed through an atomic `FOR UPDATE SKIP LOCKED` lease so that
 * multiple worker replicas never process the same event twice. Failures are
 * released back to the queue with a backoff instead of being silently dropped.
 */
export async function drainKnowledgeBaseChangeEvents(
  config: ServerConfig,
  opts: { batchSize?: number; workerId?: string; leaseSeconds?: number } = {},
): Promise<KbEventDrainSummary> {
  const summary: KbEventDrainSummary = {
    claimed: 0, reindexedWorkspaces: 0, skippedNoPlan: 0, failed: 0,
  };
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('claim_kb_change_events', {
    _worker_id: opts.workerId ?? process.env.WORKER_ID ?? 'kb-drain',
    _limit: Math.min(Math.max(opts.batchSize ?? 100, 1), 500),
    _lease_seconds: Math.max(opts.leaseSeconds ?? 300, 30),
  });
  if (error || !data || data.length === 0) return summary;

  const rows = data as unknown as KbChangeEventRow[];
  summary.claimed = rows.length;

  // Collapse to one re-index per workspace per batch.
  const byWorkspace = new Map<string, string[]>();
  for (const row of rows) {
    const list = byWorkspace.get(row.workspace_id) ?? [];
    list.push(row.id);
    byWorkspace.set(row.workspace_id, list);
  }

  for (const [workspaceId, ids] of byWorkspace) {
    let planAllowed = false;
    try {
      const r = await checkModuleAccess(
        config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'ai_assistant',
      );
      planAllowed = r.allowed === true;
    } catch {
      planAllowed = false;
    }

    if (!planAllowed) {
      // Not an error: the workspace simply has no AI assistant in its plan.
      // The event is completed — a later plan upgrade enqueues a `catchup`
      // event (public.enqueue_kb_catchup) so nothing is permanently lost.
      summary.skippedNoPlan += ids.length;
      await markProcessed(config, ids);
      continue;
    }

    try {
      await rebuildWorkspaceIndex(config, workspaceId);
      summary.reindexedWorkspaces += 1;
      await markProcessed(config, ids);
    } catch (e) {
      summary.failed += ids.length;
      const message = e instanceof Error ? e.message : String(e);
      await markFailed(config, ids, message);
    }
  }

  return summary;
}

/**
 * Deterministic catch-up after a plan upgrade: enqueues a single neutral
 * `catchup` outbox event for the workspace. Never throws — indexing must never
 * be able to fail a billing/plan operation.
 */
export async function enqueueKnowledgeBaseCatchup(
  config: ServerConfig,
  workspaceId: string,
): Promise<void> {
  try {
    await getServiceClient(config).rpc('enqueue_kb_catchup', { _workspace_id: workspaceId });
  } catch {
    /* best effort */
  }
}
