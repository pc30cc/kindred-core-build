/**
 * Outbound PROVIDER ACTIONS — Core side.
 *
 * Bot UI traffic (menu screens, inline-bubble edits, callback acknowledgements)
 * is provider network I/O, so Core may not perform it. It is enqueued here as
 * a durable `provider_outbound_action` job and executed by the Channels Worker.
 *
 * Payloads are pure presentation data — text and keyboards. No credential and
 * no provider URL ever appears in them; the worker resolves the token itself.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { enqueueChannelJob } from './jobs.js';

export type ProviderAction =
  | {
      kind: 'send_message';
      chatId: string | number;
      text: string;
      parseMode?: 'HTML' | 'MarkdownV2';
      replyMarkup?: Record<string, unknown>;
      /** Show the native "typing…" bubble first. Best effort. */
      typing?: boolean;
    }
  | {
      kind: 'edit_message';
      chatId: string | number;
      messageId: number;
      text: string;
      parseMode?: 'HTML' | 'MarkdownV2';
      replyMarkup?: Record<string, unknown>;
      /** Old bubbles cannot be edited — deliver a fresh message instead. */
      sendOnEditFailure?: boolean;
    }
  | { kind: 'answer_callback'; callbackQueryId: string; text?: string };

/**
 * Queues one or more actions to be executed IN ORDER by the worker.
 * Returns false when the action cannot be queued — callers treat bot UI as
 * best effort and must never fail message processing because of it.
 */
export async function enqueueProviderActions(
  config: ServerConfig,
  input: {
    provider: string;
    workspaceId: string;
    integrationId: string;
    actions: ProviderAction[];
    /** Interactive UI: fail fast rather than replay a stale screen for minutes. */
    maxAttempts?: number;
  },
): Promise<boolean> {
  if (!input.actions.length) return false;
  try {
    await enqueueChannelJob(getServiceClient(config), {
      provider: input.provider,
      jobType: 'provider_outbound_action',
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
      payload: { actions: input.actions.map(serializeAction) },
      maxAttempts: input.maxAttempts ?? 3,
    });
    return true;
  } catch (err) {
    console.warn(
      '[channels] provider action enqueue failed:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function serializeAction(action: ProviderAction): Record<string, unknown> {
  switch (action.kind) {
    case 'send_message':
      return {
        kind: 'send_message',
        chat_id: action.chatId,
        text: action.text,
        parse_mode: action.parseMode ?? null,
        reply_markup: action.replyMarkup ?? null,
        typing: action.typing === true,
      };
    case 'edit_message':
      return {
        kind: 'edit_message',
        chat_id: action.chatId,
        message_id: action.messageId,
        text: action.text,
        parse_mode: action.parseMode ?? null,
        reply_markup: action.replyMarkup ?? null,
        send_on_edit_failure: action.sendOnEditFailure !== false,
      };
    case 'answer_callback':
      return {
        kind: 'answer_callback',
        callback_query_id: action.callbackQueryId,
        text: action.text ?? null,
      };
  }
}
