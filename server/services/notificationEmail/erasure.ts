/**
 * A privacy erasure's part in the notification emails.
 *
 * A queued or finished job can hold what a visitor wrote (a transcript, a
 * conversation's subject, their name) until the dispatcher empties it, and
 * its row lives on for KEEP_FINISHED_MS after that. The anonymizer
 * (services/privacy/anonymizer.ts) calls these: an erased contact's
 * conversations take every job about them (found by
 * notification_email_jobs.conversation_ids, migration 289c), sent or not; an
 * erased account takes every job addressed to it. A digest that also listed
 * other conversations goes too, and the next sweep writes a new one.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

type DbError = { code?: string; message?: string } | null;

/** The jobs of `workspaceId` about any of `conversationIds`, deleted. */
export async function deleteNotificationJobsAboutConversations(
  config: ServerConfig,
  workspaceId: string,
  conversationIds: string[],
): Promise<{ count: number; error: DbError }> {
  let count = 0;
  for (let i = 0; i < conversationIds.length; i += 100) {
    const { data, error } = await getServiceClient(config)
      .from('notification_email_jobs')
      .delete()
      .eq('workspace_id', workspaceId)
      .overlaps('conversation_ids', conversationIds.slice(i, i + 100))
      .select('id');
    if (error) return { count, error };
    count += (data ?? []).length;
  }
  return { count, error: null };
}

/** Every job addressed to `userId`, deleted. */
export async function deleteNotificationJobsOfUser(
  config: ServerConfig,
  userId: string,
): Promise<{ count: number; error: DbError }> {
  const { data, error } = await getServiceClient(config)
    .from('notification_email_jobs')
    .delete()
    .eq('user_id', userId)
    .select('id');
  return { count: (data ?? []).length, error };
}
