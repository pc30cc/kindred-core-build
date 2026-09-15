/**
 * Telegram profile-photo sync — CORE SIDE (decision only, NO network).
 *
 * Core decides WHETHER a contact's avatar should be refreshed and queues an
 * `avatar_fetch` provider operation. The Channels Worker downloads the photo
 * on the unrestricted network and streams the bytes back to
 * `POST /internal/channels/media-ingest?kind=avatar`, where Core persists it
 * through the same storage service every other upload uses.
 *
 * Hard rules (unchanged):
 * - Nothing derived from the bot token may ever reach a row, a log or a URL.
 * - Never throws: an avatar problem must never affect message processing.
 */

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { redactToken } from '../../../../shared/channels/redact.js';
import { requestProviderOperation } from '../operations.js';
import { MAX_AVATAR_BYTES } from './mediaIngest.js';

/** Re-check the photo at most once per period — Telegram avatars rarely change. */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type TelegramAvatarSyncInput = {
  /** Bot provider that owns the account (telegram | bale). */
  provider?: string;
  workspaceId: string;
  integrationId: string;
  contactId: string;
  telegramUserId: string | null;
};

function shouldSync(contact): boolean {
  const syncedAt = contact?.metadata?.avatar_synced_at;
  // "Has an avatar" means either one of ours (a storage key — the only thing
  // persisted for an object we own) or an externally supplied URL from a CRM
  // import. Checking only the URL column would re-fetch from the provider on
  // every message for every contact whose avatar we already store.
  if (!contact?.avatar_storage_key && !contact?.avatar_url) return true;
  if (typeof syncedAt !== 'string') return true;
  const ts = Date.parse(syncedAt);
  return !Number.isFinite(ts) || Date.now() - ts > REFRESH_AFTER_MS;
}

export async function syncTelegramContactAvatar(
  config: ServerConfig,
  input: TelegramAvatarSyncInput,
): Promise<void> {
  if (!input.telegramUserId) return;

  try {
    const sb = getServiceClient(config);
    const { data: contact } = await sb
      .from('contacts')
      .select('id, avatar_url, avatar_storage_key, metadata')
      .eq('id', input.contactId)
      // Same ownership scoping as the write side (mediaIngest.persistContactAvatar):
      // the decision to queue a fetch for this contact is made only for the
      // workspace that owns it.
      .eq('workspace_id', input.workspaceId)
      .maybeSingle();
    if (!contact || !shouldSync(contact)) return;

    await requestProviderOperation(config, {
      provider: input.provider || 'telegram',
      operation: 'avatar_fetch',
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
      installationId: null,
      request: {
        contact_id: input.contactId,
        telegram_user_id: input.telegramUserId,
        max_bytes: MAX_AVATAR_BYTES,
      },
      maxAttempts: 2,
    });
  } catch (err) {
    // An in-flight avatar op for this integration (unique index) or a queue
    // problem must never disturb message processing.
    console.warn(
      '[telegram-avatar] sync skipped:',
      redactToken(err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Records that the provider reported no usable photo, so we do not hammer the
 * API on every inbound message.
 */
export async function markAvatarChecked(config: ServerConfig, contactId: string): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data: contact } = await sb.from('contacts').select('metadata').eq('id', contactId).maybeSingle();
    await sb
      .from('contacts')
      .update({
        metadata: { ...((contact?.metadata) || {}), avatar_synced_at: new Date().toISOString() },
      })
      .eq('id', contactId);
  } catch {
    /* best effort */
  }
}
