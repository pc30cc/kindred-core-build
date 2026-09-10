/**
 * Connection lifecycle: disconnect, revoke, rotate. See
 * docs/commerce/SECURITY.md and spec §54 (disconnect semantics) — revoking
 * an installation immediately loses Commerce Gateway access; historical
 * conversations/audit data are never deleted.
 */
import { randomBytes } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { setInstallationStatus } from '../plugins/state.js';
import { revokeInstallationSecrets, rotateInstallationSecret } from './credentials.js';
import { writeCommerceAudit } from './audit.js';
import { getConnectionForWorkspace } from './gateway.js';

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function disconnectConnection(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  userId: string,
): Promise<void> {
  const connection = await getConnectionForWorkspace(config, workspaceId, connectionId);
  if (!connection) return; // idempotent — nothing to disconnect

  const sb = getServiceClient(config);
  await sb
    .from('commerce_connections')
    .update({ revoked_at: new Date().toISOString(), health: 'disconnected', catalog_ready: false })
    .eq('id', connectionId)
    .eq('workspace_id', workspaceId);

  await revokeInstallationSecrets(config, connection.installation_id);
  await setInstallationStatus(config, connection.installation_id, 'uninstalled');

  // Cancel any in-flight sync work for this connection so a disconnected
  // store cannot keep writing to the catalog index.
  await sb.from('commerce_sync_jobs').delete().eq('connection_id', connectionId).in('status', ['queued', 'running']);

  await writeCommerceAudit(config, {
    workspaceId,
    userId,
    action: 'commerce.connection.disconnected',
    entityType: 'commerce_connection',
    entityId: connectionId,
  });
}

export async function rotateConnectionCredential(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  userId: string,
): Promise<{ installationSecret: string }> {
  const connection = await getConnectionForWorkspace(config, workspaceId, connectionId);
  if (!connection) throw new Error('connection not found');

  const newSecret = base64url(randomBytes(32));
  await rotateInstallationSecret(config, connection.installation_id, newSecret);

  const sb = getServiceClient(config);
  await sb.from('commerce_connections').update({ rotated_at: new Date().toISOString() }).eq('id', connectionId);

  await writeCommerceAudit(config, {
    workspaceId,
    userId,
    action: 'commerce.connection.credential_rotated',
    entityType: 'commerce_connection',
    entityId: connectionId,
  });

  return { installationSecret: newSecret };
}

export async function updateConnectionPermissions(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  userId: string,
  permissions: Record<string, boolean>,
): Promise<void> {
  const connection = await getConnectionForWorkspace(config, workspaceId, connectionId);
  if (!connection) throw new Error('connection not found');

  const sb = getServiceClient(config);
  const { error } = await sb
    .from('commerce_connections')
    .update({ permissions, updated_at: new Date().toISOString() })
    .eq('id', connectionId)
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(`permission update failed: ${error.message}`);

  await writeCommerceAudit(config, {
    workspaceId,
    userId,
    action: 'commerce.connection.permissions_updated',
    entityType: 'commerce_connection',
    entityId: connectionId,
    newValue: { permissions },
  });
}
