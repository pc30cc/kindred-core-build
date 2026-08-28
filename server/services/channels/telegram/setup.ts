/**
 * Telegram connection lifecycle — CORE SIDE ONLY.
 *
 * PROVIDER NETWORK ISOLATION: this module performs NO provider network I/O.
 * It is intentionally free of any `channels/providers/**` import so it can run
 * inside a restricted network (Iran) where `api.telegram.org` is unreachable.
 * Every provider call below is expressed as a durable OPERATION executed by
 * the Channels Worker on the unrestricted network, which reports facts back
 * through `/internal/channels/operation-result`.
 *
 * The connect flow keeps EXACTLY the guarantees it had when Core made the
 * calls itself, only the executor changed:
 *
 *   Core   1. stage the new token in the pending slot (never overwrites live)
 *   Core   2. create a `connect` operation + job
 *   Worker 3. getMe (identity)
 *   Core   4. ownership reservation (DB RPC + unique index) — BEFORE any
 *             provider mutation, via /connect-preflight
 *   Worker 5. setWebhook(secret_token)
 *   Worker 6. getWebhookInfo — the provider CONFIRMS the exact URL
 *   Core   7. atomic promotion (ciphertext copy) + `connected`
 *
 * FAILURE SEMANTICS (unchanged, atomic replace):
 *   - the live credential is never deleted or overwritten before step 7
 *   - the ownership reservation is rolled back to its previous value
 *   - a webhook registered with the NEW token is undone and the OLD bot's
 *     webhook is re-registered — by the WORKER, which owns the socket
 *   - the integration never reports `connected` for a failed attempt
 */

import type { ServerConfig } from '../../../config.js';
import { redactToken } from '../../../../shared/channels/redact.js';
import { deriveChannelWebhookSecret } from '../../../../shared/channels/webhookSecret.js';
import {
  TELEGRAM_BOT_TOKEN_KEY,
  TELEGRAM_BOT_TOKEN_PENDING_KEY,
  TELEGRAM_BOT_TOKEN_PREVIOUS_KEY,
  copyPluginSecret,
  deletePluginSecret,
  hasPluginSecret,
  storePluginSecret,
} from '../../plugins/secrets.js';
import {
  DuplicateProviderAccountError,
  buildWebhookUrl,
  claimProviderAccount,
  getIntegrationById,
  getIntegrationForInstallation,
  markIntegrationError,
  releaseProviderAccount,
  updateIntegration,
  type ChannelIntegration,
} from '../integrations.js';
import {
  completeOperation,
  getOperation,
  requestProviderOperation,
  type ProviderOperation,
} from '../operations.js';

export class TelegramConnectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TelegramConnectError';
  }
}

export type TelegramConnectResult = {
  bot: { id: number; username: string | null; name: string | null };
  webhookUrl: string;
  verifiedAt: string;
  replacedPreviousToken: boolean;
};

/** Everything a failed attempt must restore, captured before staging. */
type ConnectSnapshot = {
  previous_account_id: string | null;
  previous_status: string;
  had_working_integration: boolean;
};

function snapshotOf(operation: ProviderOperation): ConnectSnapshot {
  const snapshot = (operation.request as any)?.snapshot ?? {};
  return {
    previous_account_id: snapshot.previous_account_id ?? null,
    previous_status: snapshot.previous_status ?? 'pending',
    had_working_integration: snapshot.had_working_integration === true,
  };
}

// ── 1. Request: stage the credential and queue the provider work ──────

/**
 * Starts a verified connect / atomic token replacement. Returns immediately
 * with the operation to poll: the provider handshake happens in the Worker.
 */
export async function requestTelegramConnect(
  config: ServerConfig,
  integration: ChannelIntegration,
  botToken: string,
  requestedBy?: string | null,
): Promise<ProviderOperation> {
  if (!config.channelsWebhookSigningKey) {
    throw new TelegramConnectError('not_configured', 'CHANNELS_WEBHOOK_SIGNING_KEY is not configured');
  }
  if (!config.publicChannelsBaseUrl) {
    throw new TelegramConnectError('not_configured', 'PUBLIC_CHANNELS_BASE_URL is not configured');
  }

  const hadToken = await hasPluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_KEY).catch(
    () => false,
  );

  // Stage the credential: write-only slot, the live one is untouched.
  try {
    await storePluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_PENDING_KEY, botToken);
  } catch (err) {
    throw new TelegramConnectError(
      'credential_store_failed',
      redactToken(err instanceof Error ? err.message : String(err)).slice(0, 300),
    );
  }

  try {
    return await requestProviderOperation(config, {
      provider: 'telegram',
      operation: 'connect',
      workspaceId: integration.workspace_id,
      integrationId: integration.id,
      installationId: integration.installation_id,
      requestedBy: requestedBy ?? null,
      // The credential is NOT here — only the state a rollback needs.
      request: {
        snapshot: {
          previous_account_id: integration.external_account_id,
          previous_status: integration.status,
          had_working_integration: hadToken && integration.status === 'connected',
        } satisfies ConnectSnapshot,
      },
      // A connect must not be silently retried against the provider: the
      // operator sees the failure and decides.
      maxAttempts: 1,
    });
  } catch (err) {
    await deletePluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_PENDING_KEY).catch(() => {});
    throw err;
  }
}

// ── 2. Preflight: ownership is decided by the DB, before any mutation ──

export type ConnectPreflight = {
  webhookUrl: string;
  secretToken: string;
  hasPreviousToken: boolean;
};

/**
 * The Worker reports the bot identity it read from the provider; Core decides
 * — against the database — whether this workspace may own that bot, and only
 * then hands back the ingress URL + derived webhook secret.
 *
 * A workspace that lost the race is rejected here, with ZERO provider-side
 * side effects, exactly as before.
 *
 * BOT REPLACEMENT RULE: an integration that is live on Bot A may rotate the
 * token of Bot A freely, but may NOT be silently repointed at Bot B — the
 * old bot would keep a registered webhook and its conversations would be
 * orphaned. Switching bots requires an explicit disconnect first.
 */
export async function connectPreflight(
  config: ServerConfig,
  input: { operationId: string; botId: string },
): Promise<ConnectPreflight> {
  const operation = await getOperation(config, input.operationId);
  if (!operation || operation.operation !== 'connect') {
    throw new TelegramConnectError('unknown_operation', 'connect operation not found');
  }
  const integration = operation.integration_id ? await getIntegrationById(config, operation.integration_id) : null;
  if (!integration) throw new TelegramConnectError('no_integration', 'integration not found');

  const reject = async (code: string, message: string): Promise<never> => {
    // Roll the attempt back here: the Worker has made no provider mutation
    // yet, so nothing outside Core has to be undone.
    await applyConnectFailure(config, operation, { errorCode: code, errorMessage: message }).catch(() => {});
    throw new TelegramConnectError(code, message);
  };

  const snapshot = snapshotOf(operation);
  const liveAccountId = snapshot.previous_account_id ?? integration.external_account_id;
  if (snapshot.had_working_integration && liveAccountId && liveAccountId !== String(input.botId)) {
    await reject(
      'different_bot_requires_disconnect',
      'This integration is connected to a different Telegram bot. Disconnect it before connecting another bot.',
    );
  }

  try {
    await claimProviderAccount(config, integration, String(input.botId));
  } catch (err) {
    if (err instanceof DuplicateProviderAccountError) {
      await reject('duplicate_bot', 'This Telegram bot is already connected to another workspace');
    }
    await reject(
      'account_claim_failed',
      redactToken(err instanceof Error ? err.message : String(err)).slice(0, 300),
    );
  }

  return {
    webhookUrl: buildWebhookUrl(config, 'telegram', integration.public_integration_id),
    secretToken: deriveChannelWebhookSecret(
      config.channelsWebhookSigningKey!,
      'telegram',
      integration.public_integration_id,
    ),
    hasPreviousToken: snapshotOf(operation).had_working_integration,
  };
}

/**
 * Ingress contract for operations on an ALREADY-OWNED bot (webhook repair,
 * reconnect). It must never run the connect preflight: ownership is already
 * decided, there is no staged credential, and claiming the account again
 * would corrupt a healthy integration's reservation.
 */
export async function providerWebhookContract(
  config: ServerConfig,
  input: { operationId: string },
): Promise<{ webhookUrl: string; secretToken: string; integrationId: string }> {
  if (!config.channelsWebhookSigningKey) {
    throw new TelegramConnectError('not_configured', 'CHANNELS_WEBHOOK_SIGNING_KEY is not configured');
  }
  if (!config.publicChannelsBaseUrl) {
    throw new TelegramConnectError('not_configured', 'PUBLIC_CHANNELS_BASE_URL is not configured');
  }

  const operation = await getOperation(config, input.operationId);
  if (!operation) throw new TelegramConnectError('unknown_operation', 'operation not found');
  if (operation.operation === 'connect') {
    // Connect must go through the ownership preflight, never this shortcut.
    throw new TelegramConnectError('invalid_operation', 'connect requires the ownership preflight');
  }
  const integration = operation.integration_id ? await getIntegrationById(config, operation.integration_id) : null;
  if (!integration) throw new TelegramConnectError('no_integration', 'integration not found');

  const hasToken = await hasPluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_KEY).catch(
    () => false,
  );
  if (!hasToken) throw new TelegramConnectError('no_token', 'integration has no live credential');

  return {
    integrationId: integration.id,
    webhookUrl: buildWebhookUrl(config, operation.provider, integration.public_integration_id),
    secretToken: deriveChannelWebhookSecret(
      config.channelsWebhookSigningKey,
      operation.provider,
      integration.public_integration_id,
    ),
  };
}


// ── 3. Result: Core owns every canonical write ────────────────────────

export type ConnectSuccessReport = {
  botId: number;
  username: string | null;
  firstName: string | null;
  webhookUrl: string;
};

/**
 * Promotion. The staged ciphertext is copied into the live slot WITHOUT ever
 * being decrypted, after the live one is backed up, so a failing state
 * transition restores the exact previous credential.
 *
 * Returns a rollback instruction when the transition failed: the Worker owns
 * the socket, so it — not Core — undoes the provider-side webhook.
 */
export async function applyConnectSuccess(
  config: ServerConfig,
  operation: ProviderOperation,
  report: ConnectSuccessReport,
): Promise<{ ok: true; verifiedAt: string } | { ok: false; rollback: true; errorCode: string }> {
  const integration = operation.integration_id ? await getIntegrationById(config, operation.integration_id) : null;
  if (!integration) {
    await completeOperation(config, operation.id, { status: 'failed', errorCode: 'no_integration' });
    return { ok: false, rollback: true, errorCode: 'no_integration' };
  }
  const installationId = integration.installation_id;
  const verifiedAt = new Date().toISOString();

  const hadLiveToken = await hasPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY).catch(() => false);

  try {
    if (hadLiveToken) {
      await copyPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY, TELEGRAM_BOT_TOKEN_PREVIOUS_KEY);
    }
    const promoted = await copyPluginSecret(
      config,
      installationId,
      TELEGRAM_BOT_TOKEN_PENDING_KEY,
      TELEGRAM_BOT_TOKEN_KEY,
    );
    if (!promoted) throw new Error('staged credential is missing');

    await updateIntegration(config, integration.id, {
      status: 'connected',
      external_account_id: String(report.botId),
      display_name: report.firstName,
      username: report.username,
      webhook_registered_at: verifiedAt,
      webhook_verified_at: verifiedAt,
      last_error_code: null,
      last_error_at: null,
    });
  } catch (err) {
    // Restore the exact previous credential, then let the Worker undo the
    // provider-side webhook.
    if (hadLiveToken) {
      await copyPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_PREVIOUS_KEY, TELEGRAM_BOT_TOKEN_KEY).catch(
        () => {},
      );
    } else {
      await deletePluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY).catch(() => {});
    }
    await applyConnectFailure(config, operation, {
      errorCode: 'state_transition_failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, rollback: true, errorCode: 'state_transition_failed' };
  }

  await deletePluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_PENDING_KEY).catch(() => {});
  await deletePluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_PREVIOUS_KEY).catch(() => {});

  await completeOperation(config, operation.id, {
    status: 'succeeded',
    result: {
      bot: { id: report.botId, username: report.username, name: report.firstName },
      webhook_url: report.webhookUrl,
      verified_at: verifiedAt,
      replaced_previous_token: hadLiveToken,
    },
  });

  return { ok: true, verifiedAt };
}

/**
 * Local rollback for a failed connect. The staged credential never survives,
 * a previously working integration is never degraded, and ownership is
 * released so a retry (or another workspace) can claim the bot.
 */
export async function applyConnectFailure(
  config: ServerConfig,
  operation: ProviderOperation,
  failure: { errorCode: string; errorMessage?: string },
): Promise<void> {
  const snapshot = snapshotOf(operation);
  const integration = operation.integration_id ? await getIntegrationById(config, operation.integration_id) : null;

  if (integration) {
    await deletePluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_PENDING_KEY).catch(() => {});
    await deletePluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_PREVIOUS_KEY).catch(() => {});

    // Ownership restore: back to the previous account, or released entirely.
    try {
      if (snapshot.previous_account_id) {
        await updateIntegration(config, integration.id, {
          external_account_id: snapshot.previous_account_id,
        });
      } else if (integration.external_account_id) {
        await releaseProviderAccount(config, integration.id);
      }
    } catch {
      /* best effort — the next connect re-derives ownership from the DB */
    }

    if (snapshot.had_working_integration) {
      // A failed replacement must not degrade a working integration.
      await updateIntegration(config, integration.id, {
        status: 'connected',
        last_error_code: failure.errorCode.slice(0, 120),
        last_error_at: new Date().toISOString(),
      }).catch(() => {});
    } else {
      await markIntegrationError(config, integration.id, failure.errorCode).catch(() => {});
    }
  }

  await completeOperation(config, operation.id, {
    status: 'failed',
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
  });
}

/** Shapes a finished connect operation for the HTTP layer. */
export function connectResultOf(operation: ProviderOperation): TelegramConnectResult | null {
  const result = operation.result as any;
  if (operation.status !== 'succeeded' || !result?.bot) return null;
  return {
    bot: { id: result.bot.id, username: result.bot.username ?? null, name: result.bot.name ?? null },
    webhookUrl: String(result.webhook_url ?? ''),
    verifiedAt: String(result.verified_at ?? ''),
    replacedPreviousToken: result.replaced_previous_token === true,
  };
}

// ── Disconnect ────────────────────────────────────────────────────────

/**
 * Canonical disconnect.
 *
 * Local acceptance is invalidated IMMEDIATELY and synchronously — the
 * integration flips to `disconnected` and ownership is released, so ingest is
 * refused and another workspace may claim the bot even if the provider is
 * unreachable from here. Removing the provider webhook needs the credential,
 * so the credential is destroyed only once the Worker reports back (or the
 * operation fails permanently).
 *
 * Conversations and messages are historical data and are PRESERVED.
 */
export async function requestTelegramDisconnect(
  config: ServerConfig,
  installationId: string,
  requestedBy?: string | null,
): Promise<{ integration: boolean; operation: ProviderOperation | null }> {
  const integration = await getIntegrationForInstallation(config, installationId);

  if (!integration) {
    await deletePluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY).catch(() => {});
    await deletePluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_PENDING_KEY).catch(() => {});
    return { integration: false, operation: null };
  }

  await deletePluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_PENDING_KEY).catch(() => {});
  await releaseProviderAccount(config, integration.id).catch(() => {});
  await updateIntegration(config, integration.id, {
    status: 'disconnected',
    webhook_registered_at: null,
    webhook_verified_at: null,
    last_error_code: null,
    last_error_at: null,
  });

  const hasToken = await hasPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY).catch(() => false);
  if (!hasToken) return { integration: true, operation: null };

  const operation = await requestProviderOperation(config, {
    provider: 'telegram',
    operation: 'disconnect',
    workspaceId: integration.workspace_id,
    integrationId: integration.id,
    installationId,
    requestedBy: requestedBy ?? null,
    maxAttempts: 3,
  }).catch(() => null);

  if (!operation) {
    // Could not even queue the cleanup: destroy the credential now rather
    // than leaving a usable one behind.
    await deletePluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY).catch(() => {});
  }
  return { integration: true, operation };
}

/** Credential destruction happens once the provider webhook is gone (or provably un-removable). */
export async function applyDisconnectResult(
  config: ServerConfig,
  operation: ProviderOperation,
  report: { webhookRemoved: boolean; errorCode?: string | null; errorMessage?: string | null },
): Promise<void> {
  if (operation.installation_id) {
    await deletePluginSecret(config, operation.installation_id, TELEGRAM_BOT_TOKEN_KEY).catch(() => {});
    await deletePluginSecret(config, operation.installation_id, TELEGRAM_BOT_TOKEN_PENDING_KEY).catch(() => {});
  }
  if (operation.integration_id && report.errorCode) {
    await updateIntegration(config, operation.integration_id, {
      last_error_code: 'webhook_delete_failed',
      last_error_at: new Date().toISOString(),
    }).catch(() => {});
  }
  await completeOperation(config, operation.id, {
    status: 'succeeded',
    result: {
      webhook_removed: report.webhookRemoved,
      webhook_error: report.errorMessage ? redactToken(report.errorMessage).slice(0, 300) : null,
    },
  });
}

// ── Webhook repair / diagnostics / profile ────────────────────────────

export async function requestTelegramWebhookRepair(
  config: ServerConfig,
  installationId: string,
  requestedBy?: string | null,
): Promise<ProviderOperation> {
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) throw new TelegramConnectError('no_integration', 'Telegram is not connected');
  if (!config.channelsWebhookSigningKey || !config.publicChannelsBaseUrl) {
    throw new TelegramConnectError('not_configured', 'Channels ingress is not configured');
  }
  return requestProviderOperation(config, {
    provider: 'telegram',
    operation: 'webhook_repair',
    workspaceId: integration.workspace_id,
    integrationId: integration.id,
    installationId,
    requestedBy: requestedBy ?? null,
    maxAttempts: 3,
  });
}

export async function applyWebhookRepairResult(
  config: ServerConfig,
  operation: ProviderOperation,
  report: { repaired: boolean; webhookUrl?: string | null; errorCode?: string | null; errorMessage?: string | null },
): Promise<void> {
  if (!operation.integration_id) return;

  if (report.repaired) {
    const now = new Date().toISOString();
    await updateIntegration(config, operation.integration_id, {
      status: 'connected',
      webhook_registered_at: now,
      webhook_verified_at: now,
      last_error_code: null,
      last_error_at: null,
    });
    await completeOperation(config, operation.id, {
      status: 'succeeded',
      result: { repaired: true, webhook_url: report.webhookUrl ?? null },
    });
    return;
  }

  await markIntegrationError(config, operation.integration_id, report.errorCode || 'webhook_repair_failed').catch(
    () => {},
  );
  await completeOperation(config, operation.id, {
    status: 'failed',
    errorCode: report.errorCode || 'webhook_repair_failed',
    errorMessage: report.errorMessage ?? undefined,
  });
}

/**
 * Diagnostics compare what the provider believes with what Core expects. The
 * provider half is read by the Worker; the expectation half is computed here.
 */
export async function requestTelegramDiagnostics(
  config: ServerConfig,
  installationId: string,
): Promise<ProviderOperation> {
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) throw new TelegramConnectError('no_integration', 'Telegram is not connected');
  return requestProviderOperation(config, {
    provider: 'telegram',
    operation: 'diagnostics',
    workspaceId: integration.workspace_id,
    integrationId: integration.id,
    installationId,
    maxAttempts: 2,
  });
}

export async function applyDiagnosticsResult(
  config: ServerConfig,
  operation: ProviderOperation,
  report: {
    webhookUrl?: string | null;
    pendingUpdateCount?: number | null;
    lastErrorMessage?: string | null;
    lastErrorAt?: string | null;
  },
): Promise<void> {
  await completeOperation(config, operation.id, {
    status: 'succeeded',
    result: {
      webhook_url: report.webhookUrl ?? null,
      pending_update_count: report.pendingUpdateCount ?? 0,
      last_error_message: report.lastErrorMessage ? redactToken(report.lastErrorMessage).slice(0, 300) : null,
      last_error_at: report.lastErrorAt ?? null,
    },
  });
}

/** Core-side half of a diagnostics answer: never needs the provider. */
export async function telegramDiagnosticsView(
  config: ServerConfig,
  installationId: string,
  operation: ProviderOperation | null,
) {
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) return { connected: false as const, reason: 'no_integration' };

  const hasToken = await hasPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY).catch(() => false);
  if (!hasToken) return { connected: false as const, reason: 'no_token' };

  const expectedUrl = config.publicChannelsBaseUrl
    ? buildWebhookUrl(config, 'telegram', integration.public_integration_id)
    : null;
  const probe = (operation?.status === 'succeeded' ? (operation.result as any) : null) ?? null;

  return {
    connected: integration.status === 'connected',
    /** null while the Worker has not answered yet — never a guess. */
    probeStatus: operation?.status ?? 'unavailable',
    probeError: operation?.status === 'failed' ? operation.error_code : null,
    webhookUrl: probe?.webhook_url ?? null,
    expectedWebhookUrl: expectedUrl,
    webhookMatches: !!expectedUrl && !!probe && probe.webhook_url === expectedUrl,
    pendingUpdateCount: probe?.pending_update_count ?? 0,
    lastErrorMessage: probe?.last_error_message ?? null,
    lastErrorAt: probe?.last_error_at ?? null,
    lastInboundAt: integration.last_inbound_at,
    lastOutboundAt: integration.last_outbound_at,
    integrationStatus: integration.status,
  };
}

export type TelegramCommandPatch = { command: string; description: string };

export type TelegramProfilePatch = {
  name?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  commands?: TelegramCommandPatch[] | null;
};

/** APPLY-ON-DEMAND bot branding. Never runs implicitly. */
export async function requestTelegramProfileSync(
  config: ServerConfig,
  installationId: string,
  patch: TelegramProfilePatch,
  requestedBy?: string | null,
): Promise<ProviderOperation> {
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) throw new TelegramConnectError('no_integration', 'Telegram is not connected');
  const hasToken = await hasPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY).catch(() => false);
  if (!hasToken) throw new TelegramConnectError('no_token', 'Telegram is not connected');

  return requestProviderOperation(config, {
    provider: 'telegram',
    operation: 'profile_sync',
    workspaceId: integration.workspace_id,
    integrationId: integration.id,
    installationId,
    requestedBy: requestedBy ?? null,
    request: {
      profile: {
        name: patch.name ?? null,
        short_description: patch.shortDescription ?? null,
        description: patch.description ?? null,
        commands: patch.commands ?? null,
      },
    },
    maxAttempts: 3,
  });
}

export async function applyProfileSyncResult(
  config: ServerConfig,
  operation: ProviderOperation,
  report: { applied: string[]; name?: string | null },
): Promise<void> {
  if (operation.integration_id) {
    const integration = await getIntegrationById(config, operation.integration_id);
    if (integration) {
      await updateIntegration(config, integration.id, {
        display_name: report.name ?? integration.display_name,
        metadata: {
          ...(integration.metadata ?? {}),
          profile_synced_at: new Date().toISOString(),
          profile_synced_fields: report.applied,
        },
      });
    }
  }
  await completeOperation(config, operation.id, {
    status: 'succeeded',
    result: { applied: report.applied },
  });
}
