/**
 * ASYNC PROVIDER DELIVERY STATUS → canonical message metadata.
 *
 * A NARROW path, deliberately separate from the inbound-message pipeline:
 * a delivery receipt is not a customer turn. It can only ever patch
 * `conversation_messages.metadata` of the OUTBOUND message it names, and it
 * correlates STRICTLY by provider message id (`metadata.channel_message_id`,
 * written by /internal/channels/outbound-result at send time) — never by
 * conversation, contact or "latest message" guessing.
 *
 * Effects it may have:
 *   • move the delivery state up the success ladder (sent → delivered → read);
 *   • mark a terminal async failure, which makes the message stop counting as
 *     a qualified customer-facing answer, so derived Needs Reply comes back.
 * Effects it may NEVER have: opening/resuming a conversation, creating a
 * message, touching operator unread counters, triggering AI routing.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { publishOperatorEvent } from '../realtime/publish.js';
import { updateIntegration } from './integrations.js';
import {
  resolveDeliveryTransition,
  type WhatsAppDeliveryStatus,
} from './whatsapp/deliveryStatus.js';

export type DeliveryStatusOutcome =
  | 'applied'
  | 'terminal_failure'
  | 'ignored_duplicate'
  | 'ignored_out_of_order'
  | 'ignored_already_terminal'
  | 'ignored_not_failable'
  | 'unknown_message';

export async function applyProviderDeliveryStatuses(
  config: ServerConfig,
  input: {
    provider: string;
    workspaceId: string;
    integrationId: string;
    statuses: WhatsAppDeliveryStatus[];
  },
): Promise<DeliveryStatusOutcome[]> {
  const outcomes: DeliveryStatusOutcome[] = [];
  if (!input.statuses.length) return outcomes;

  const sb = getServiceClient(config);
  let sawFailure = false;

  for (const status of input.statuses) {
    try {
      // ── Correlation: provider message id only. ────────────────────────
      const { data: rows, error } = await sb
        .from('conversation_messages')
        .select('id, conversation_id, metadata')
        .filter('metadata->>channel_message_id', 'eq', status.providerMessageId)
        .limit(2);
      if (error) throw new Error(error.message);

      const message = (rows ?? [])[0] as any;
      if (!message) {
        outcomes.push('unknown_message');
        continue;
      }

      // The message must belong to this workspace — a webhook can never be
      // allowed to patch another tenant's data.
      const { data: conversation } = await sb
        .from('conversations')
        .select('id, workspace_id')
        .eq('id', message.conversation_id)
        .maybeSingle();
      if (!conversation || (conversation as any).workspace_id !== input.workspaceId) {
        outcomes.push('unknown_message');
        continue;
      }

      const previousMetadata = ((message.metadata ?? {}) as Record<string, unknown>);
      const transition = resolveDeliveryTransition(
        previousMetadata.channel_delivery as string | undefined,
        status.status,
      );

      if (!transition.apply) {
        outcomes.push(
          transition.reason === 'duplicate'
            ? 'ignored_duplicate'
            : transition.reason === 'out_of_order'
              ? 'ignored_out_of_order'
              : transition.reason === 'already_terminal'
                ? 'ignored_already_terminal'
                : 'ignored_not_failable',
        );
        continue;
      }

      const metadata = { ...previousMetadata };
      metadata.channel_delivery = transition.status;
      metadata.channel_delivery_at = new Date().toISOString();
      metadata.channel_delivery_source = 'provider_status';
      if (status.occurredAt) metadata.channel_delivery_status_at = status.occurredAt;
      if (transition.terminalFailure && status.errorCode) {
        metadata.channel_delivery_error = status.errorCode;
      } else if (!transition.terminalFailure) {
        delete metadata.channel_delivery_error;
      }

      const { error: writeError } = await sb
        .from('conversation_messages')
        .update({ metadata })
        .eq('id', message.id);
      if (writeError) throw new Error(writeError.message);

      if (transition.terminalFailure) {
        sawFailure = true;
        outcomes.push('terminal_failure');
        // Needs Reply is derived on read, so the Inbox only needs to know it
        // must recompute this conversation. Success-ladder moves publish
        // NOTHING: they cannot change Needs Reply and would be realtime noise.
        void publishOperatorEvent(config, {
          kind: 'conversation_updated',
          conversation_id: message.conversation_id,
          workspace_id: input.workspaceId,
          actor_id: null,
          changes: {},
          reason: 'outbound_delivery_failed',
          message_id: message.id,
          updated_at: new Date().toISOString(),
        } as any);
      } else {
        outcomes.push('applied');
      }
    } catch (err) {
      console.error('[channels] delivery status apply failed:', (err as Error).message);
    }
  }

  if (sawFailure) {
    await updateIntegration(config, input.integrationId, {
      last_error_code: 'whatsapp_delivery_failed',
      last_error_at: new Date().toISOString(),
    }).catch(() => undefined);
  }

  return outcomes;
}
