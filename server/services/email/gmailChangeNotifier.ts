/**
 * GMAIL CHANGE NOTIFIER — turns Pub/Sub pushes into content-free signals.
 *
 * A push only says "mailbox X changed". Nothing is imported: this coalesces
 * bursts per mailbox, reads the ids of newly added INBOX messages from
 * `history.list` (ids only, no message fetch), advances the stored cursor,
 * publishes one realtime `email_mailbox_changed` event (apps with the inbox
 * open re-read just the changed threads via `/changes`), and sends a mobile
 * push with no subject, sender or snippet when there is new mail.
 *
 * Coalescing is per API instance. Pub/Sub delivers each push to one instance,
 * so a burst split across instances costs at most one extra event per
 * instance — not worth shared coordination (Redis) today.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { updateIntegration, type ChannelIntegration } from '../channels/integrations.js';
import { getGmailAccessToken } from '../channels/gmail/oauth.js';
import { getGmailOAuthConfig } from '../channels/gmail/oauthConfig.js';
import { createGmailAdapter } from '../../../channels/mail/gmail/client.js';
import { publishOperatorEvent } from '../realtime/publish.js';
import { notifyEmailMessage } from '../push/index.js';

const COALESCE_MS = 2_000;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleGmailChange(config: ServerConfig, integrationId: string): void {
  if (pending.has(integrationId)) return;
  const timer = setTimeout(() => {
    pending.delete(integrationId);
    void processGmailChange(config, integrationId);
  }, COALESCE_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
  pending.set(integrationId, timer);
}

async function processGmailChange(config: ServerConfig, integrationId: string): Promise<void> {
  try {
    const cfg = getGmailOAuthConfig();
    if (!cfg) return;
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('channel_integrations')
      .select('*')
      .eq('id', integrationId)
      .eq('status', 'connected')
      .maybeSingle();
    const integration = data as ChannelIntegration | null;
    if (!integration) return;

    const ga = createGmailAdapter(cfg);
    const accessToken = await getGmailAccessToken(config, integration.installation_id);
    const cursor = typeof integration.metadata?.gmail_history_id === 'string' ? integration.metadata.gmail_history_id : null;

    let newMessages = 0;
    let historyId: string | null = null;
    if (cursor) {
      const delta = await ga.listHistorySince(accessToken, cursor);
      newMessages = delta.messageIds.length;
      historyId = delta.expired ? await ga.getProfileHistoryId(accessToken) : delta.historyId;
    } else {
      historyId = await ga.getProfileHistoryId(accessToken);
    }

    if (historyId && historyId !== cursor) {
      await updateIntegration(config, integration.id, {
        metadata: { ...integration.metadata, gmail_history_id: historyId },
      });
    }

    await publishOperatorEvent(config, {
      kind: 'email_mailbox_changed',
      workspace_id: integration.workspace_id,
      conversation_id: '',
      provider: 'gmail',
      history_id: historyId,
    }, { skipConversationChannel: true });

    if (newMessages > 0 && historyId) {
      // No from/subject/snippet: the notification names no email content.
      await notifyEmailMessage(config, {
        workspaceId: integration.workspace_id,
        threadId: '',
        messageId: `gmail-${integration.id}-${historyId}`,
      });
    }
  } catch (err) {
    console.error(`[gmail-change] integration ${integrationId}: ${(err as Error)?.message || 'failed'}`);
  }
}
