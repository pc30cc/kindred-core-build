import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getInstallation } from '../../plugins/state.js';
import { TELEGRAM_BOT_TOKEN_KEY, hasPluginSecret } from '../../plugins/secrets.js';
import { resolveAvailability } from '../../widget/availability.js';
import { anyOperatorOnline } from '../../widget/operatorPresence.js';
import { enqueueProviderActions } from '../providerActions.js';
import { getIntegrationForInstallation } from '../integrations.js';
import { buildOfflineScreen } from './menu.js';
import { parseTelegramSettings } from './settings.js';

const OFFLINE_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const OFFLINE_LOCK_COOLDOWN_MS = 45 * 1000;

export async function isWorkspaceUnreachable(
  config: ServerConfig,
  workspaceId: string,
  locale: string,
): Promise<boolean> {
  const [availability, presence] = await Promise.all([
    resolveAvailability(config, { workspaceId, locale }).catch(() => null),
    anyOperatorOnline(config, workspaceId).catch(() => null),
  ]);
  if (availability?.state === 'offline') return true;
  if (presence && presence.memberCount > 0 && !presence.anyOnline) return true;
  return false;
}

/**
 * Atomically claims and queues the one authoritative Telegram offline screen.
 * Claim-before-enqueue prevents concurrent inbound/routing/AI paths from each
 * sending a copy. The same first message carries the reduced keyboard and the
 * input placeholder, so Telegram applies the strongest lock its API supports.
 */
export async function maybeQueueTelegramOfflineScreen(
  config: ServerConfig,
  args: {
    workspaceId: string;
    conversationId: string;
    locale: string;
    fallbackLocale?: string | null;
    requireUnreachable?: boolean;
  },
): Promise<boolean> {
  if (args.requireUnreachable !== false
      && !(await isWorkspaceUnreachable(config, args.workspaceId, args.locale))) return false;

  const installation = await getInstallation(config, args.workspaceId, 'telegram');
  if (!installation) return false;
  const settings = parseTelegramSettings(installation.settings);
  const locked = settings.menu.lockWhenOffline === true;
  if (settings.menu.offlineNoticeEnabled === false && !locked) return false;
  if (!(await hasPluginSecret(config, installation.id, TELEGRAM_BOT_TOKEN_KEY))) return false;
  const integration = await getIntegrationForInstallation(config, installation.id);
  if (!integration) return false;

  const sb = getServiceClient(config);
  const cooldown = locked ? OFFLINE_LOCK_COOLDOWN_MS : OFFLINE_NOTICE_COOLDOWN_MS;
  const claimId = crypto.randomUUID();
  let claimed = false;

  // Optimistic compare-and-swap: only one concurrent request can replace the
  // exact metadata snapshot it read. Retry when an unrelated metadata writer
  // wins; stop when another offline sender has already claimed the window.
  for (let attempt = 0; attempt < 3 && !claimed; attempt += 1) {
    const { data } = await sb
      .from('conversations')
      .select('metadata')
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    if (!data) return false;
    const metadata = (((data as any).metadata as Record<string, unknown>) || {});
    const lastAt = Date.parse(String(metadata.telegram_offline_notice_at || '')) || 0;
    if (Date.now() - lastAt < cooldown) return false;

    const now = new Date().toISOString();
    const nextMetadata = {
      ...metadata,
      telegram_offline_notice_at: now,
      telegram_offline_notice_claim: claimId,
    };
    const { data: updated } = await sb
      .from('conversations')
      .update({ metadata: nextMetadata })
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .eq('metadata', metadata)
      .select('id')
      .maybeSingle();
    claimed = Boolean(updated);
  }
  if (!claimed) return false;

  const metadataResult = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', args.conversationId)
    .maybeSingle();
  const conversationMetadata = (((metadataResult.data as any)?.metadata as Record<string, unknown>) || {});
  const chatId = String(conversationMetadata.channel_chat_id ?? '');
  if (!chatId) return false;

  const screen = buildOfflineScreen(settings, args.locale, args.fallbackLocale, { locked });
  const queued = await enqueueProviderActions(config, {
    provider: 'telegram',
    workspaceId: args.workspaceId,
    integrationId: integration.id,
    actions: [{
      kind: 'send_message',
      chatId,
      text: screen.text,
      parseMode: 'HTML',
      replyMarkup: screen.replyMarkup,
      // No typing animation: the lock and placeholder must appear immediately.
      typing: false,
    }],
  });

  if (!queued) {
    await sb
      .from('conversations')
      .update({
        metadata: {
          ...conversationMetadata,
          telegram_offline_notice_at: null,
          telegram_offline_notice_claim: null,
        },
      })
      .eq('id', args.conversationId)
      .contains('metadata', { telegram_offline_notice_claim: claimId });
  }
  return queued;
}