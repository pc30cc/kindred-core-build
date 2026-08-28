/**
 * PROVIDER OPERATION EXECUTOR — Channels Worker side.
 *
 * This file is the ONLY place a Telegram socket is opened for lifecycle work.
 * It runs on the unrestricted network; Core (which may be in a restricted
 * network) never calls a provider itself. The worker executes, then reports
 * FACTS to Core, which owns every canonical write.
 *
 * Invariants:
 * - the bot token is decrypted here and never leaves this process: not into a
 *   job payload, not into Core, not into a log line;
 * - ownership is decided by Core (`/connect-preflight`) BEFORE the first
 *   provider mutation, so a losing workspace never touches the bot;
 * - when Core cannot commit a connect, the worker performs the provider-side
 *   rollback (delete the new webhook, restore the previous bot's webhook),
 *   because only the worker has a socket.
 */

import {
  TelegramApiError,
  answerCallbackQuery,
  deleteWebhook,
  downloadFile,
  editMessageText,
  getFile,
  getMe,
  getUserProfilePhotoFileId,
  getWebhookInfo,
  redactToken,
  sendChatAction,
  sendMessage,
  setMyCommands,
  setMyDescription,
  setMyName,
  setMyShortDescription,
  setWebhook,
} from '../../channels/providers/telegram/client.js';

export const TOKEN_KEY = 'telegram_bot_token';
export const TOKEN_PENDING_KEY = 'telegram_bot_token_pending';

export type ProviderOperationRecord = {
  id: string;
  provider: string;
  operation: string;
  workspace_id: string;
  integration_id: string | null;
  installation_id: string | null;
  request: Record<string, any>;
};

export type OperationContext = {
  /** Authenticated JSON POST to Core. Throws on non-2xx. */
  corePost: (path: string, body: unknown) => Promise<any>;
  /** Authenticated GET to Core. Throws on non-2xx. */
  coreGet: (path: string) => Promise<any>;
  /** Streams raw provider bytes to Core over the internal boundary. */
  coreUpload: (path: string, bytes: Uint8Array, contentType: string) => Promise<any>;
  /** Decrypts a credential for an integration. Never leaves the worker. */
  resolveToken: (integrationId: string, secretKey: string) => Promise<string>;
};

export class PermanentOperationError extends Error {
  readonly permanent = true;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PermanentOperationError';
  }
}

function fail(err: unknown): { code: string; message: string } {
  if (err instanceof TelegramApiError) {
    return {
      code: `telegram_${err.httpStatus ?? 'error'}`,
      message: redactToken(err.message).slice(0, 500),
    };
  }
  return {
    code: 'provider_operation_failed',
    message: redactToken(err instanceof Error ? err.message : String(err)).slice(0, 500),
  };
}

/**
 * Runs one operation end to end and reports the outcome to Core.
 *
 * Returns nothing: any error that should cost the job a retry is rethrown, and
 * anything conclusive is already reported to Core.
 */
export async function executeProviderOperation(
  ctx: OperationContext,
  operationId: string,
): Promise<void> {
  const { operation } = (await ctx.coreGet(`/internal/channels/operations/${operationId}`)) as {
    operation: ProviderOperationRecord;
  };
  if (!operation) throw new PermanentOperationError('unknown_operation', 'operation not found');

  switch (operation.operation) {
    case 'connect':
      return runConnect(ctx, operation);
    case 'disconnect':
      return runDisconnect(ctx, operation);
    case 'webhook_repair':
      return runWebhookRepair(ctx, operation);
    case 'diagnostics':
      return runDiagnostics(ctx, operation);
    case 'profile_sync':
      return runProfileSync(ctx, operation);
    case 'media_fetch':
      return runMediaFetch(ctx, operation);
    case 'avatar_fetch':
      return runAvatarFetch(ctx, operation);
    default:
      throw new PermanentOperationError(
        'unsupported_operation',
        `unsupported provider operation: ${operation.operation}`,
      );
  }
}

function requireIntegration(operation: ProviderOperationRecord): string {
  if (!operation.integration_id) {
    throw new PermanentOperationError('no_integration', 'operation has no integration');
  }
  return operation.integration_id;
}

async function report(
  ctx: OperationContext,
  operation: ProviderOperationRecord,
  body: Record<string, unknown>,
): Promise<any> {
  return ctx.corePost('/internal/channels/operation-result', {
    operation_id: operation.id,
    ...body,
  });
}

// ── connect ───────────────────────────────────────────────────────────

async function runConnect(ctx: OperationContext, operation: ProviderOperationRecord): Promise<void> {
  const integrationId = requireIntegration(operation);
  // The staged credential — the live one is untouched until Core promotes it.
  const token = await ctx.resolveToken(integrationId, TOKEN_PENDING_KEY);

  let identity;
  try {
    identity = await getMe(token);
  } catch (err) {
    const { code, message } = fail(err);
    await report(ctx, operation, { status: 'failed', error_code: 'invalid_token', error_message: message || code });
    return;
  }

  // Ownership is decided by the DATABASE before ANY provider mutation.
  let preflight: { webhook_url: string; secret_token: string; has_previous_token: boolean };
  try {
    preflight = await ctx.corePost('/internal/channels/connect-preflight', {
      operation_id: operation.id,
      bot_id: identity.id,
    });
  } catch (err) {
    // Core already recorded the rejection (duplicate_bot etc.) — nothing was
    // changed on the provider, so there is nothing to roll back.
    throw err;
  }

  try {
    await setWebhook(token, preflight.webhook_url, preflight.secret_token);
  } catch (err) {
    const { message } = fail(err);
    await report(ctx, operation, {
      status: 'failed',
      error_code: 'set_webhook_failed',
      error_message: message,
    });
    await restorePreviousWebhook(ctx, operation, preflight);
    return;
  }

  // The provider CONFIRMS the exact URL — never trust the write alone.
  try {
    const info = await getWebhookInfo(token);
    if (info.url !== preflight.webhook_url) {
      await report(ctx, operation, {
        status: 'failed',
        error_code: 'webhook_url_mismatch',
        error_message: 'Telegram reports a different webhook URL',
      });
      await deleteWebhook(token).catch(() => {});
      await restorePreviousWebhook(ctx, operation, preflight);
      return;
    }
  } catch (err) {
    const { message } = fail(err);
    await report(ctx, operation, {
      status: 'failed',
      error_code: 'webhook_verify_failed',
      error_message: message,
    });
    await deleteWebhook(token).catch(() => {});
    await restorePreviousWebhook(ctx, operation, preflight);
    return;
  }

  const outcome = await report(ctx, operation, {
    status: 'succeeded',
    result: {
      bot_id: identity.id,
      username: identity.username ?? null,
      first_name: identity.firstName ?? null,
      webhook_url: preflight.webhook_url,
    },
  });

  // Core could not commit: undo the provider-side change we just made.
  if (outcome && outcome.ok === false && outcome.rollback) {
    await deleteWebhook(token).catch(() => {});
    await restorePreviousWebhook(ctx, operation, preflight);
  }
}

/**
 * Re-registers the webhook of the credential that is still live, so a failed
 * replacement leaves the working bot exactly as it was.
 */
async function restorePreviousWebhook(
  ctx: OperationContext,
  operation: ProviderOperationRecord,
  preflight: { webhook_url: string; secret_token: string; has_previous_token: boolean },
): Promise<void> {
  if (!preflight.has_previous_token || !operation.integration_id) return;
  try {
    const liveToken = await ctx.resolveToken(operation.integration_id, TOKEN_KEY);
    await setWebhook(liveToken, preflight.webhook_url, preflight.secret_token);
  } catch (err) {
    console.warn('[channels-worker] previous webhook restore failed:', fail(err).message);
  }
}

// ── disconnect / repair / diagnostics ─────────────────────────────────

async function runDisconnect(ctx: OperationContext, operation: ProviderOperationRecord): Promise<void> {
  const integrationId = requireIntegration(operation);
  let removed = false;
  let error: { code: string; message: string } | null = null;
  try {
    const token = await ctx.resolveToken(integrationId, TOKEN_KEY);
    await deleteWebhook(token);
    removed = true;
  } catch (err) {
    error = fail(err);
  }
  // Always report: Core must destroy the credential either way.
  await report(ctx, operation, {
    status: 'succeeded',
    result: {
      webhook_removed: removed,
      error_code: error?.code ?? null,
      error_message: error?.message ?? null,
    },
  });
}

async function runWebhookRepair(ctx: OperationContext, operation: ProviderOperationRecord): Promise<void> {
  const integrationId = requireIntegration(operation);
  const token = await ctx.resolveToken(integrationId, TOKEN_KEY);
  // Core owns the ingress contract. Repair/reconnect targets an ALREADY-OWNED
  // bot, so it must use the ownership-free contract endpoint — running the
  // connect preflight here would re-claim the account of a healthy
  // integration and reject on the bot-replacement rule.
  const contract = await ctx
    .corePost('/internal/channels/webhook-contract', { operation_id: operation.id })
    .catch(() => null);

  const target = contract?.webhook_url ?? String((operation.request as any)?.webhook_url ?? '');
  const secret = contract?.secret_token ?? String((operation.request as any)?.secret_token ?? '');
  if (!target || !secret) {
    await report(ctx, operation, {
      status: 'failed',
      error_code: 'ingress_unavailable',
      error_message: 'Core did not provide the webhook contract',
    });
    return;
  }


  try {
    await setWebhook(token, target, secret);
    const info = await getWebhookInfo(token);
    if (info.url !== target) throw new Error('Telegram reports a different webhook URL');
    await report(ctx, operation, { status: 'succeeded', result: { repaired: true, webhook_url: target } });
  } catch (err) {
    const { code, message } = fail(err);
    await report(ctx, operation, { status: 'failed', error_code: code, error_message: message });
  }
}

async function runDiagnostics(ctx: OperationContext, operation: ProviderOperationRecord): Promise<void> {
  const integrationId = requireIntegration(operation);
  try {
    const token = await ctx.resolveToken(integrationId, TOKEN_KEY);
    const info = await getWebhookInfo(token);
    await report(ctx, operation, {
      status: 'succeeded',
      result: {
        webhook_url: info.url || null,
        pending_update_count: info.pending_update_count ?? 0,
        last_error_message: info.last_error_message ? redactToken(info.last_error_message) : null,
        last_error_at: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
      },
    });
  } catch (err) {
    const { code, message } = fail(err);
    await report(ctx, operation, { status: 'failed', error_code: code, error_message: message });
  }
}

async function runProfileSync(ctx: OperationContext, operation: ProviderOperationRecord): Promise<void> {
  const integrationId = requireIntegration(operation);
  const token = await ctx.resolveToken(integrationId, TOKEN_KEY);
  const profile = ((operation.request as any)?.profile ?? {}) as any;
  const applied: string[] = [];

  try {
    if (profile.name) {
      await setMyName(token, String(profile.name));
      applied.push('name');
    }
    if (profile.short_description) {
      await setMyShortDescription(token, String(profile.short_description));
      applied.push('short_description');
    }
    if (profile.description) {
      await setMyDescription(token, String(profile.description));
      applied.push('description');
    }
    if (Array.isArray(profile.commands)) {
      await setMyCommands(token, profile.commands);
      applied.push('commands');
    }
  } catch (err) {
    const { code, message } = fail(err);
    await report(ctx, operation, { status: 'failed', error_code: code, error_message: message });
    return;
  }

  await report(ctx, operation, {
    status: 'succeeded',
    result: { applied, name: profile.name ?? null },
  });
}

// ── media ─────────────────────────────────────────────────────────────

async function runMediaFetch(ctx: OperationContext, operation: ProviderOperationRecord): Promise<void> {
  const integrationId = requireIntegration(operation);
  const token = await ctx.resolveToken(integrationId, TOKEN_KEY);
  const request = (operation.request ?? {}) as any;
  const maxBytes = Number(request.max_bytes ?? 25 * 1024 * 1024);
  const attachments: any[] = Array.isArray(request.attachments) ? request.attachments : [];
  const outcomes: any[] = [];

  for (const attachment of attachments) {
    const fileId = String(attachment?.file_id ?? '');
    const kind = String(attachment?.kind ?? 'document');
    if (!fileId) continue;
    try {
      const meta = await getFile(token, fileId);
      if (meta.file_size && meta.file_size > maxBytes) throw new Error('file_too_large');
      const bytes = await downloadFile(token, meta.file_path, maxBytes);

      // Core validates and persists; only bot-agnostic metadata crosses.
      const query = new URLSearchParams({
        operation_id: operation.id,
        file_id: fileId,
        kind,
        file_path: meta.file_path,
      });
      if (attachment?.file_name) query.set('file_name', String(attachment.file_name));
      if (attachment?.mime_type) query.set('mime_type', String(attachment.mime_type));

      const response = await ctx.coreUpload(
        `/internal/channels/media-ingest?${query.toString()}`,
        bytes,
        'application/octet-stream',
      );
      outcomes.push(response?.outcome ?? { fileId, kind, status: 'stored' });
    } catch (err) {
      outcomes.push({ fileId, kind, status: 'failed', error: fail(err).message.slice(0, 200) });
    }
  }

  await report(ctx, operation, { status: 'succeeded', result: { outcomes } });
}

async function runAvatarFetch(ctx: OperationContext, operation: ProviderOperationRecord): Promise<void> {
  const integrationId = requireIntegration(operation);
  const token = await ctx.resolveToken(integrationId, TOKEN_KEY);
  const request = (operation.request ?? {}) as any;
  const userId = String(request.telegram_user_id ?? '');
  const maxBytes = Number(request.max_bytes ?? 2 * 1024 * 1024);

  try {
    const fileId = userId ? await getUserProfilePhotoFileId(token, userId) : null;
    if (!fileId) {
      await report(ctx, operation, { status: 'succeeded', result: { no_photo: true } });
      return;
    }
    const meta = await getFile(token, fileId);
    if (meta.file_size && meta.file_size > maxBytes) {
      await report(ctx, operation, { status: 'succeeded', result: { no_photo: true } });
      return;
    }
    const bytes = await downloadFile(token, meta.file_path, maxBytes);
    const query = new URLSearchParams({
      operation_id: operation.id,
      kind: 'avatar',
      file_key_hint: `${userId}-${fileId.slice(-12)}`,
    });
    await ctx.coreUpload(`/internal/channels/media-ingest?${query.toString()}`, bytes, 'image/jpeg');
    await report(ctx, operation, { status: 'succeeded', result: { stored: true } });
  } catch (err) {
    const { code, message } = fail(err);
    await report(ctx, operation, { status: 'failed', error_code: code, error_message: message });
  }
}

// ── bot UI actions (menus, edits, callback acks) ──────────────────────

export async function executeOutboundActions(
  ctx: OperationContext,
  integrationId: string,
  actions: any[],
): Promise<void> {
  const token = await ctx.resolveToken(integrationId, TOKEN_KEY);

  for (const action of actions) {
    const kind = String(action?.kind ?? '');
    try {
      if (kind === 'answer_callback') {
        await answerCallbackQuery(token, String(action.callback_query_id), action.text ?? undefined);
      } else if (kind === 'send_message') {
        if (action.typing) await sendChatAction(token, action.chat_id, 'typing').catch(() => undefined);
        await sendMessage(token, {
          chatId: action.chat_id,
          text: String(action.text ?? ''),
          parseMode: action.parse_mode ?? undefined,
          replyMarkup: action.reply_markup ?? undefined,
        });
      } else if (kind === 'edit_message') {
        try {
          await editMessageText(token, {
            chatId: action.chat_id,
            messageId: Number(action.message_id),
            text: String(action.text ?? ''),
            parseMode: action.parse_mode ?? undefined,
            replyMarkup: action.reply_markup ?? undefined,
          });
        } catch (err) {
          // Telegram refuses to edit old/unchanged bubbles; a fresh screen is
          // strictly better than a dead menu.
          if (action.send_on_edit_failure) {
            await sendMessage(token, {
              chatId: action.chat_id,
              text: String(action.text ?? ''),
              parseMode: action.parse_mode ?? undefined,
              replyMarkup: action.reply_markup ?? undefined,
            });
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      // Bot UI is best-effort per action: a failed acknowledgement must not
      // discard the menu screen that follows it.
      console.warn(`[channels-worker] provider action ${kind} failed:`, fail(err).message);
    }
  }
}
