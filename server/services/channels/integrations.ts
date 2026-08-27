/**
 * Channel integration records — the join between a workspace plugin
 * installation and a concrete provider account (e.g. one Telegram bot).
 *
 * `public_integration_id` is a random, non-guessable id that appears in the
 * webhook URL path. It is the ONLY identifier the provider ever sees, and it
 * is what the Gateway uses to derive the expected webhook secret without a
 * database lookup.
 */

import { randomBytes } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type ChannelIntegration = {
  id: string;
  public_integration_id: string;
  workspace_id: string;
  installation_id: string;
  provider: string;
  status: 'pending' | 'active' | 'paused' | 'error' | 'revoked';
  external_account_id: string | null;
  external_account_name: string | null;
  webhook_registered_at: string | null;
  last_inbound_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
};

export function newPublicIntegrationId(): string {
  return randomBytes(24).toString('base64url');
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
      status: 'pending',
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

export async function getIntegrationForInstallation(
  config: ServerConfig,
  installationId: string,
): Promise<ChannelIntegration | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('channel_integrations')
    .select('*')
    .eq('installation_id', installationId)
    .neq('status', 'revoked')
    .maybeSingle();
  if (error) throw new Error(`integration read failed: ${error.message}`);
  return (data as ChannelIntegration | null) ?? null;
}

export async function updateIntegration(
  config: ServerConfig,
  integrationId: string,
  patch: Partial<
    Pick<
      ChannelIntegration,
      'status' | 'external_account_id' | 'external_account_name' | 'webhook_registered_at' | 'last_error' | 'metadata'
    >
  >,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('channel_integrations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', integrationId);
  if (error) throw new Error(`integration update failed: ${error.message}`);
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
