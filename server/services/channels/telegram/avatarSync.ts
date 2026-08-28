/**
 * Best-effort Telegram profile-photo sync for channel contacts.
 *
 * Downloads the sender's current Telegram profile photo through the Bot API
 * and persists it via the SAME storage service every other upload uses, then
 * writes the resulting public URL onto `contacts.avatar_url` so the Inbox,
 * Contacts list and drawer render the real picture.
 *
 * Hard rules (same as mediaIngest.ts):
 * - Nothing derived from the bot token may ever reach a row, a log or a URL.
 * - Never throws: an avatar problem must never affect message processing.
 */

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { readPluginSecret, TELEGRAM_BOT_TOKEN_KEY } from '../../plugins/secrets.js';
import { getIntegrationById } from '../integrations.js';
import { callTelegram, getFile, downloadFile, redactToken } from './client.js';
import { uploadFile, resolveStorageConfig, getFileUrlWithConfig } from '../../storage/index.js';

/** Profile photos are small; anything bigger is not a legitimate avatar. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** Re-check the photo at most once per period — Telegram avatars rarely change. */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type TelegramAvatarSyncInput = {
  workspaceId: string;
  integrationId: string;
  contactId: string;
  telegramUserId: string | null;
};

function shouldSync(contact: any): boolean {
  const syncedAt = contact?.metadata?.avatar_synced_at;
  if (!contact?.avatar_url) return true;
  if (typeof syncedAt !== 'string') return true;
  const ts = Date.parse(syncedAt);
  return !Number.isFinite(ts) || Date.now() - ts > REFRESH_AFTER_MS;
}

export async function syncTelegramContactAvatar(
  config: ServerConfig,
  input: TelegramAvatarSyncInput,
): Promise<void> {
  if (!input.telegramUserId) return;
  const sb = getServiceClient(config);

  try {
    const { data: contact } = await sb
      .from('contacts')
      .select('id, avatar_url, metadata')
      .eq('id', input.contactId)
      .maybeSingle();
    if (!contact || !shouldSync(contact)) return;

    const integration = await getIntegrationById(config, input.integrationId);
    if (!integration) return;
    const botToken = await readPluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_KEY);
    if (!botToken) return;

    const photos = await callTelegram<any>(botToken, 'getUserProfilePhotos', {
      user_id: Number(input.telegramUserId),
      limit: 1,
    });
    const sizes: any[] = Array.isArray(photos?.photos?.[0]) ? photos.photos[0] : [];
    if (!sizes.length) {
      // No photo (or privacy-restricted): record the attempt so we do not
      // hammer the API on every inbound message.
      await sb
        .from('contacts')
        .update({ metadata: { ...(contact.metadata || {}), avatar_synced_at: new Date().toISOString() } })
        .eq('id', input.contactId);
      return;
    }

    // Prefer a mid-size render (~160-320px) — big enough for the UI, small
    // enough to keep the storage footprint negligible.
    const picked =
      sizes.find((s) => (s?.width ?? 0) >= 160 && (s?.width ?? 0) <= 640) ?? sizes[sizes.length - 1];
    if (!picked?.file_id) return;
    if (typeof picked.file_size === 'number' && picked.file_size > MAX_AVATAR_BYTES) return;

    const fileInfo = await getFile(botToken, picked.file_id);
    if (!fileInfo?.file_path) return;
    const bytes = await downloadFile(botToken, fileInfo.file_path, MAX_AVATAR_BYTES);

    const fileKey = `workspace/${input.workspaceId}/avatars/telegram/${input.telegramUserId}-${picked.file_unique_id || 'photo'}.jpg`;
    const uploaded = await uploadFile(config, {
      workspaceId: input.workspaceId,
      fileKey,
      data: Buffer.from(bytes),
      contentType: 'image/jpeg',
    });
    if (!uploaded.success) return;

    const storageConfig = await resolveStorageConfig(config, input.workspaceId);
    const url =
      uploaded.url || (storageConfig ? getFileUrlWithConfig(storageConfig, fileKey) : null);
    if (!url) return;

    await sb
      .from('contacts')
      .update({
        avatar_url: url,
        metadata: {
          ...(contact.metadata || {}),
          avatar_source: 'telegram',
          avatar_synced_at: new Date().toISOString(),
        },
      })
      .eq('id', input.contactId);
  } catch (err) {
    console.warn(
      '[telegram-avatar] sync skipped:',
      redactToken(err instanceof Error ? err.message : String(err)),
    );
  }
}
