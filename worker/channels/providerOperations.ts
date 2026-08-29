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
  redactToken,
  type BotCredential,
} from '../../channels/providers/telegram/client.js';
import { botApiFor } from './botApi.js';
import { botProvider, renderBotText, type BotProviderDescriptor } from '../../shared/channels/botProviders.js';

/** Legacy Telegram slot names, kept for callers that predate multi-provider. */
export const TOKEN_KEY = 'telegram_bot_token';
export const TOKEN_PENDING_KEY = 'telegram_bot_token_pending';

/**
 * Resolves a credential AND the API root it belongs to.
 *
 * Every provider call in this file goes through here, which is what makes the
 * same executor drive Telegram and Bale without a single `if (provider ===)`
 * in the operation bodies.
 */
async function credential(
  ctx: OperationContext,
  provider: BotProviderDescriptor,
  integrationId: string,
  slot: 'live' | 'pending',
): Promise<BotCredential> {
  const secretKey = slot === 'pending' ? provider.secretKeys.pending : provider.secretKeys.live;
  const token = await ctx.resolveToken(integrationId, secretKey);
  return { token, apiRoot: provider.apiRoot };
}

function descriptorFor(operation: { provider: string }): BotProviderDescriptor {
  try {
    return botProvider(operation.provider);
  } catch {
    throw new PermanentOperationError('unsupported_provider', `unsupported provider: ${operation.provider}`);
  }
}

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
      code: `bot_api_${err.httpStatus ?? 'error'}`,
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
  const provider = descriptorFor(operation);
  const api = botApiFor(provider);
  // The staged credential — the live one is untouched until Core promotes it.
  const token = await credential(ctx, provider, integrationId, 'pending');

  let identity;
  try {
    identity = await api.getMe(token);
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

  // WhatsApp Cloud webhooks live in the Meta app dashboard: there is nothing
  // for the platform to register or verify, so the whole webhook handshake is
  // skipped and the connect succeeds on a validated credential alone.
  const managesWebhook = provider.supportsWebhookRegistration;

  try {
    if (managesWebhook) {
      await api.setWebhook(
        token,
        preflight.webhook_url,
        provider.supportsSecretToken ? preflight.secret_token : null,
        provider.supportsAllowedUpdates ? undefined : null,
      );
    }
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
    const info = managesWebhook ? await api.getWebhookInfo(token) : { url: preflight.webhook_url };
    if (info.url !== preflight.webhook_url) {
      await report(ctx, operation, {
        status: 'failed',
        error_code: 'webhook_url_mismatch',
        error_message: `${provider.label} reports a different webhook URL`,
      });
      await api.deleteWebhook(token).catch(() => {});
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
    await api.deleteWebhook(token).catch(() => {});
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
    await api.deleteWebhook(token).catch(() => {});
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
  const provider = descriptorFor(operation);
  if (!provider.supportsWebhookRegistration) return;
  const api = botApiFor(provider);
  try {
    const liveToken = await credential(ctx, provider, operation.integration_id, 'live');
    await api.setWebhook(
      liveToken,
      preflight.webhook_url,
      provider.supportsSecretToken ? preflight.secret_token : null,
      provider.supportsAllowedUpdates ? undefined : null,
    );
  } catch (err) {
    console.warn('[channels-worker] previous webhook restore failed:', fail(err).message);
  }
}

// ── disconnect / repair / diagnostics ─────────────────────────────────

async function runDisconnect(ctx: OperationContext, operation: ProviderOperationRecord): Promise<void> {
  const integrationId = requireIntegration(operation);
  const provider = descriptorFor(operation);
  const api = botApiFor(provider);
  let removed = false;
  let error: { code: string; message: string } | null = null;
  try {
    const token = await credential(ctx, provider, integrationId, 'live');
    if (provider.supportsWebhookRegistration) await api.deleteWebhook(token);
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
  const provider = descriptorFor(operation);
  const api = botApiFor(provider);
  const token = await credential(ctx, provider, integrationId, 'live');
  if (!provider.supportsWebhookRegistration) {
    // Nothing to repair: the callback URL is owned by the provider dashboard.
    await report(ctx, operation, { status: 'succeeded', result: { repaired: false, managed_externally: true } });
    return;
  }
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
    await api.setWebhook(
      token,
      target,
      provider.supportsSecretToken ? secret : null,
      provider.supportsAllowedUpdates ? undefined : null,
    );
    const info = await api.getWebhookInfo(token);
    if (info.url !== target) throw new Error(`${provider.label} reports a different webhook URL`);
    await report(ctx, operation, { status: 'succeeded', result: { repaired: true, webhook_url: target } });
  } catch (err) {
    const { code, message } = fail(err);
    await report(ctx, operation, { status: 'failed', error_code: code, error_message: message });
  }
}

async function runDiagnostics(ctx: OperationContext, operation: ProviderOperationRecord): Promise<void> {
  const integrationId = requireIntegration(operation);
  const descriptor = descriptorFor(operation);
  const api = botApiFor(descriptor);
  try {
    const token = await credential(ctx, descriptor, integrationId, 'live');
    const info = descriptor.supportsWebhookRegistration
      ? await api.getWebhookInfo(token)
      : { url: '', pending_update_count: 0, last_error_message: undefined, last_error_date: undefined };
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
  const provider = descriptorFor(operation);
  const api = botApiFor(provider);
  const token = await credential(ctx, provider, integrationId, 'live');
  const profile = ((operation.request as any)?.profile ?? {}) as any;
  const applied: string[] = [];
  // Providers without a bot-profile API (Bale) silently skip those fields
  // instead of failing the whole sync — commands still apply.
  const canProfile = provider.supportsBotProfile;

  try {
    if (profile.name && canProfile) {
      await api.setMyName(token, String(profile.name));
      applied.push('name');
    }
    if (profile.short_description && canProfile) {
      await api.setMyShortDescription(token, String(profile.short_description));
      applied.push('short_description');
    }
    if (profile.description && canProfile) {
      await api.setMyDescription(token, String(profile.description));
      applied.push('description');
    }
    if (Array.isArray(profile.commands) && provider.supportsCommands) {
      await api.setMyCommands(token, profile.commands);
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
  const descriptor = descriptorFor(operation);
  const api = botApiFor(descriptor);
  const token = await credential(ctx, descriptor, integrationId, 'live');
  const request = (operation.request ?? {}) as any;
  const maxBytes = Number(request.max_bytes ?? 25 * 1024 * 1024);
  const attachments: any[] = Array.isArray(request.attachments) ? request.attachments : [];
  const outcomes: any[] = [];

  for (const attachment of attachments) {
    const fileId = String(attachment?.file_id ?? '');
    const kind = String(attachment?.kind ?? 'document');
    if (!fileId) continue;
    try {
      const meta = await api.getFile(token, fileId);
      if (meta.file_size && meta.file_size > maxBytes) throw new Error('file_too_large');
      const bytes = await api.downloadFile(token, meta.file_path, maxBytes);

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
  const provider = descriptorFor(operation);
  const api = botApiFor(provider);
  const token = await credential(ctx, provider, integrationId, 'live');
  const request = (operation.request ?? {}) as any;
  const userId = String(request.telegram_user_id ?? request.bot_user_id ?? '');
  const maxBytes = Number(request.max_bytes ?? 2 * 1024 * 1024);

  try {
    const fileId =
      userId && provider.supportsUserProfilePhotos
        ? await api.getUserProfilePhotoFileId(token, userId)
        : null;
    if (!fileId) {
      await report(ctx, operation, { status: 'succeeded', result: { no_photo: true } });
      return;
    }
    const meta = await api.getFile(token, fileId);
    if (meta.file_size && meta.file_size > maxBytes) {
      await report(ctx, operation, { status: 'succeeded', result: { no_photo: true } });
      return;
    }
    const bytes = await api.downloadFile(token, meta.file_path, maxBytes);
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
  providerId = 'telegram',
): Promise<void> {
  const provider = descriptorFor({ provider: providerId });
  const api = botApiFor(provider);
  const token = await credential(ctx, provider, integrationId, 'live');

  for (const action of actions) {
    const kind = String(action?.kind ?? '');
    // Providers that ignore `parse_mode` (Bale) must never receive markup —
    // flatten it here, once, for every outbound screen.
    const rendered = renderBotText(
      provider.id,
      String(action?.text ?? ''),
      (action?.parse_mode as string | undefined) ?? undefined,
    );
    const text = rendered.text;
    const parseMode = rendered.parseMode as 'HTML' | 'MarkdownV2' | undefined;
    try {
      if (kind === 'answer_callback') {
        await api.answerCallbackQuery(token, String(action.callback_query_id), action.text ?? undefined);
      } else if (kind === 'send_message') {
        if (action.typing) await api.sendChatAction(token, action.chat_id, 'typing').catch(() => undefined);
        await api.sendMessage(token, {
          chatId: action.chat_id,
          text,
          parseMode,
          replyMarkup: action.reply_markup ?? undefined,
        });
      } else if (kind === 'edit_message') {
        try {
          if (provider.dialect !== 'telegram-bot') throw new Error('edit_unsupported');
          await api.editMessageText(token, {
            chatId: action.chat_id,
            messageId: Number(action.message_id),
            text,
            parseMode,
            replyMarkup: action.reply_markup ?? undefined,
          });
        } catch (err) {
          // Telegram refuses to edit old/unchanged bubbles; a fresh screen is
          // strictly better than a dead menu.
          if (action.send_on_edit_failure || provider.dialect !== 'telegram-bot') {
            await api.sendMessage(token, {
              chatId: action.chat_id,
              text,
              parseMode,
              replyMarkup: action.reply_markup ?? undefined,
            });
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      // Callback acknowledgements are cosmetic and must not discard a screen
      // queued after them. Message delivery is not cosmetic: propagate its
      // failure so the durable job retries instead of being marked succeeded.
      if (kind === 'answer_callback') {
        console.warn(`[channels-worker] provider action ${kind} failed:`, fail(err).message);
        continue;
      }
      throw err;
    }
  }
}
