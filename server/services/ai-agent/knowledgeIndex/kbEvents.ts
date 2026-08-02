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

async function markProcessed(
  config: ServerConfig,
  ids: string[],
  lastError: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  await getServiceClient(config)
    .from('knowledge_base_change_events')
    .update({
      processed_at: new Date().toISOString(),
      last_error: lastError,
      updated_at: new Date().toISOString(),
    })
    .in('id', ids);
}

/** Drains one batch of pending KB change events. Never throws. */
export async function drainKnowledgeBaseChangeEvents(
  config: ServerConfig,
  opts: { batchSize?: number } = {},
): Promise<KbEventDrainSummary> {
  const summary: KbEventDrainSummary = {
    claimed: 0, reindexedWorkspaces: 0, skippedNoPlan: 0, failed: 0,
  };
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('knowledge_base_change_events')
    .select('id, workspace_id, event_type, attempts')
    .is('processed_at', null)
    .order('created_at', { ascending: true })
    .limit(Math.min(Math.max(opts.batchSize ?? 100, 1), 500));
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
      summary.skippedNoPlan += ids.length;
      await markProcessed(config, ids, null);
      continue;
    }

    try {
      await rebuildWorkspaceIndex(config, workspaceId);
      summary.reindexedWorkspaces += 1;
      await markProcessed(config, ids, null);
    } catch (e) {
      summary.failed += ids.length;
      const message = e instanceof Error ? e.message : String(e);
      await sb
        .from('knowledge_base_change_events')
        .update({
          attempts: (rows.find((r) => ids.includes(r.id))?.attempts ?? 0) + 1,
          last_error: message.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .in('id', ids);
    }
  }

  return summary;
}
