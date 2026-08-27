/**
 * Channel integration records — the join between a workspace plugin
 * installation and a concrete provider account (e.g. one Telegram bot).
 *
 * CANONICAL LIFECYCLE (must match the DB CHECK constraint in
 * 048_plugin_platform_and_channels.sql exactly):
 *
 *     pending → connected → disconnected
 *        └──────→ error ──────┘
 *
 * `public_integration_id` is a random, non-guessable id that appears in the
 * webhook URL path. It is the ONLY identifier the provider ever sees, and it
 * is what the Gateway uses to derive the expected webhook secret without a
 * database lookup.
 */

import { randomBytes } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

/** The only integration statuses the database will accept. */
export const CHANNEL_INTEGRATION_STATUSES = ['pending', 'connected', 'disconnected', 'error'] as const;
export type ChannelIntegrationStatus = (typeof CHANNEL_INTEGRATION_STATUSES)[number];

/** Every column of public.channel_integrations, and nothing else. */
export const CHANNEL_INTEGRATION_COLUMNS = [
  'id',
  'workspace_id',
  'installation_id',
  'provider',
  'public_integration_id',
  'external_account_id',
  'display_name',
  'username',
  'status',
  'webhook_registered_at',
  'webhook_verified_at',
  'last_inbound_at',
  'last_outbound_at',
  'last_error_code',
  'last_error_at',
  'metadata',
  'created_at',
  'updated_at',
] as const;

export type ChannelIntegration = {
  id: string;
  public_integration_id: string;
  workspace_id: string;
  installation_id: string;
  provider: string;
  status: ChannelIntegrationStatus;
  external_account_id: string | null;
  display_name: string | null;
  username: string | null;
  webhook_registered_at: string | null;
  webhook_verified_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

/** Columns a service is allowed to patch. Anything else is a contract bug. */
export const CHANNEL_INTEGRATION_MUTABLE_COLUMNS = [
  'status',
  'external_account_id',
  'display_name',
  'username',
  'webhook_registered_at',
  'webhook_verified_at',
  'last_inbound_at',
  'last_outbound_at',
  'last_error_code',
  'last_error_at',
  'metadata',
] as const;

export type ChannelIntegrationPatch = Partial<
  Pick<ChannelIntegration, (typeof CHANNEL_INTEGRATION_MUTABLE_COLUMNS)[number]>
>;

export function newPublicIntegrationId(): string {
  return randomBytes(24).toString('base64url');
}

export class DuplicateProviderAccountError extends Error {
  constructor(readonly provider: string) {
    super(`${provider} account is already connected to another workspace`);
    this.name = 'DuplicateProviderAccountError';
  }
}

export async function createIntegration(
  config: ServerConfig,
  input: { workspaceId: string; installationId: string; provider: string },
): Promise<ChannelIntegration> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('channel_integrations')
    .insert({
      public_integration_id: newPublicIntegrationId(),
      workspace_id: input.workspaceId,
      installation_id: input.installationId,
      provider: input.provider,
      status: 'pending' satisfies ChannelIntegrationStatus,
    })
    .select('*')
    .single();
  if (error) throw new Error(`integration create failed: ${error.message}`);
  return data as ChannelIntegration;
}

export async function getIntegrationByPublicId(
  config: ServerConfig,
  publicIntegrationId: string,
): Promise<ChannelIntegration | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('channel_integrations')
    .select('*')
    .eq('public_integration_id', publicIntegrationId)
    .maybeSingle();
  if (error) throw new Error(`integration read failed: ${error.message}`);
  return (data as ChannelIntegration | null) ?? null;
}

export async function getIntegrationById(
  config: ServerConfig,
  integrationId: string,
): Promise<ChannelIntegration | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('channel_integrations')
    .select('*')
    .eq('id', integrationId)
    .maybeSingle();
  if (error) throw new Error(`integration read failed: ${error.message}`);
  return (data as ChannelIntegration | null) ?? null;
}

export async function getIntegrationForInstallation(
  config: ServerConfig,
  installationId: string,
): Promise<ChannelIntegration | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('channel_integrations')
    .select('*')
    .eq('installation_id', installationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`integration read failed: ${error.message}`);
  return (data as ChannelIntegration | null) ?? null;
}

export async function updateIntegration(
  config: ServerConfig,
  integrationId: string,
  patch: ChannelIntegrationPatch,
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of CHANNEL_INTEGRATION_MUTABLE_COLUMNS) {
    if (patch[key] !== undefined) row[key] = patch[key];
  }
  const sb = getServiceClient(config);
  const { error } = await sb.from('channel_integrations').update(row).eq('id', integrationId);
  if (error) throw new Error(`integration update failed: ${error.message}`);
}

/**
 * Binds a provider account id to this integration. The partial unique index
 * `channel_integrations_account_unique` makes the "one bot ↔ one workspace"
 * rule a DATABASE invariant, so two concurrent connects cannot both win.
 */
export async function claimProviderAccount(
  config: ServerConfig,
  integration: ChannelIntegration,
  externalAccountId: string,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('channel_integrations')
    .update({ external_account_id: externalAccountId, updated_at: new Date().toISOString() })
    .eq('id', integration.id);
  if (error) {
    if ((error as any).code === '23505') throw new DuplicateProviderAccountError(integration.provider);
    throw new Error(`provider account claim failed: ${error.message}`);
  }
}

/** Marks an integration as failed without ever storing provider credentials. */
export async function markIntegrationError(
  config: ServerConfig,
  integrationId: string,
  errorCode: string,
): Promise<void> {
  await updateIntegration(config, integrationId, {
    status: 'error',
    last_error_code: errorCode.slice(0, 120),
    last_error_at: new Date().toISOString(),
  });
}

/**
 * Canonical webhook URL. Built ONLY from PUBLIC_CHANNELS_BASE_URL — never
 * from a request Host/Origin/X-Forwarded-Host header.
 */
export function buildWebhookUrl(
  config: ServerConfig,
  provider: string,
  publicIntegrationId: string,
): string {
  if (!config.publicChannelsBaseUrl) {
    throw new Error('PUBLIC_CHANNELS_BASE_URL is not configured');
  }
  return `${config.publicChannelsBaseUrl}/hooks/${provider}/${publicIntegrationId}`;
}
