import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

/**
 * Puts a workspace's latest terminally-failed deletion job back in the queue
 * via retry_workspace_deletion_job, the same RPC POST .../workspaces/:id/
 * deletion-retry uses; the job resumes from its saved storage_scopes
 * progress. Account deletion needs this: a workspace left 'deleting' with no
 * active job is refused by enqueue_workspace_deletion, so without reviving
 * it the owner can never be deleted.
 */
export async function reviveFailedWorkspaceDeletion(
  config: ServerConfig,
  workspaceId: string,
  actorUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = getServiceClient(config);
  const { data: failed, error } = await sb
    .from('workspace_deletion_jobs')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'failed')
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!failed) return { ok: false, error: 'no failed deletion job found' };
  const { data, error: retryError } = await sb.rpc('retry_workspace_deletion_job', {
    _job_id: failed.id,
    _actor_user_id: actorUserId,
  });
  if (retryError) return { ok: false, error: retryError.message };
  if (!data?.ok) return { ok: false, error: data?.error ?? 'retry_failed' };
  return { ok: true };
}
