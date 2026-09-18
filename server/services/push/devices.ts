/**
 * PUSH DEVICE REGISTRY.
 *
 * Identity always comes from the authenticated first-party session (cookie or
 * mobile Bearer) — a client-supplied user_id is never trusted, and is not even
 * accepted by the route.
 *
 * Lifecycle rules that matter in production:
 *  • Token rotation UPSERTS on (user_id, device_id) — the stable install
 *    identity — so a rotating FCM token never creates endless rows.
 *  • A token that reappears under a DIFFERENT user (shared phone, logout →
 *    login) is re-owned: any other row holding that exact token is deleted
 *    first, so a customer's operator can never receive another operator's
 *    notifications.
 *  • Logout disables ONLY the calling device. Push device lifecycle is
 *    intentionally NOT the auth session lifecycle.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type PushPlatform = 'ios' | 'android';

export interface RegisterDeviceInput {
  userId: string;
  workspaceId?: string | null;
  platform: PushPlatform;
  /** The FCM token. Null on an install that only registered for calls. */
  pushToken: string | null;
  deviceId: string;
  deviceName?: string | null;
  appVersion?: string | null;
  permissionStatus?: string | null;
  /** PushKit's own token, iOS only. Null clears it. */
  voipToken?: string | null;
}

export interface PushDeviceRow {
  id: string;
  user_id: string;
  platform: PushPlatform;
  push_token: string;
  device_id: string;
  enabled: boolean;
}

export async function registerDevice(
  config: ServerConfig,
  input: RegisterDeviceInput,
): Promise<{ id: string } | null> {
  const sb = getServiceClient(config);
  const now = new Date().toISOString();

  // Re-own the token: it can only ever address ONE user.
  if (input.pushToken) {
    await sb
      .from('mobile_push_devices')
      .delete()
      .eq('push_token', input.pushToken)
      .neq('user_id', input.userId);
  }

  // Same rule for the VoIP address, for a sharper reason: a stale row holding
  // it would make one operator's phone ring for another operator's calls.
  if (input.voipToken) {
    await sb
      .from('mobile_push_devices')
      .update({ voip_token: null, voip_token_updated_at: now })
      .eq('voip_token', input.voipToken)
      .neq('user_id', input.userId);
  }

  const { data, error } = await sb
    .from('mobile_push_devices')
    .upsert(
      {
        user_id: input.userId,
        workspace_id: input.workspaceId ?? null,
        platform: input.platform,
        push_token: input.pushToken ?? null,
        device_id: input.deviceId,
        device_name: input.deviceName ?? null,
        app_version: input.appVersion ?? null,
        permission_status: input.permissionStatus ?? null,
        voip_token: input.voipToken ?? null,
        voip_token_updated_at: input.voipToken ? now : null,
        enabled: true,
        disabled_reason: null,
        last_seen_at: now,
        updated_at: now,
      },
      { onConflict: 'user_id,device_id' },
    )
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[push] device registration failed', { code: error.code, message: error.message });
    return null;
  }
  return data ? { id: (data as { id: string }).id } : null;
}

/** Logout / "turn off notifications on this phone" — this device only. */
export async function disableDevice(
  config: ServerConfig,
  userId: string,
  deviceId: string,
  reason = 'user_logout',
): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('mobile_push_devices')
    .update({ enabled: false, disabled_reason: reason, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('device_id', deviceId);
}

/** FCM told us the address is dead. Never retried, never deleted blindly. */
export async function disableToken(
  config: ServerConfig,
  pushToken: string,
  reason = 'fcm_unregistered',
): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('mobile_push_devices')
    .update({ enabled: false, disabled_reason: reason, updated_at: new Date().toISOString() })
    .eq('push_token', pushToken);
}

export async function listActiveDevices(
  config: ServerConfig,
  userIds: string[],
): Promise<PushDeviceRow[]> {
  if (!userIds.length) return [];
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('mobile_push_devices')
    .select('id, user_id, platform, push_token, device_id, enabled')
    .in('user_id', userIds)
    .eq('enabled', true)
    // A call-only device has no notification address, and handing a null to
    // FCM would fail every send for every other device in the same batch.
    .not('push_token', 'is', null);
  if (error) {
    console.error('[push] device lookup failed', { code: error.code, message: error.message });
    return [];
  }
  return (data ?? []) as PushDeviceRow[];
}

export async function touchDevice(
  config: ServerConfig,
  userId: string,
  deviceId: string,
): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('mobile_push_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('device_id', deviceId);
}
