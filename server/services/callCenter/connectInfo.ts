/**
 * Build the public, secrets-free `connect` block returned alongside a
 * provider participant token. Visitors and operators receive the same
 * shape so client runtimes can attempt a real provider room join.
 *
 * STRICT:
 *   - Never returns api_key / api_secret / signing secrets.
 *   - Returns `supported: false` (with a reason) when the provider has
 *     no client-facing connection URL — callers must surface a clear
 *     error instead of guessing a URL.
 */
import type { ServerConfig } from '../../config.js';
import type { CallProviderId } from '../calls/controlPlane.js';
import { getLiveKitClientWsUrl } from '../calls/livekitConfig.js';

export interface ClientConnectInfo {
  supported: boolean;
  provider: CallProviderId;
  server_url: string | null;
  room_id: string | null;
  identity: string | null;
  reason?: string;
}

export async function buildClientConnectInfo(
  config: ServerConfig,
  providerId: CallProviderId,
  providerRoomId: string,
  identity: string,
): Promise<ClientConnectInfo> {
  if (providerId === 'livekit') {
    // Use the same source-of-truth the LiveKit provider uses to create rooms,
    // so a workspace configured via livekit_config.rtc_url alone still gets a
    // valid client server_url (instead of a misleading livekit_url_missing).
    const wss = await getLiveKitClientWsUrl(config);
    if (!wss) {
      return {
        supported: false,
        provider: providerId,
        server_url: null,
        room_id: providerRoomId,
        identity,
        reason: 'livekit_url_missing',
      };
    }
    return {
      supported: true,
      provider: providerId,
      server_url: wss,
      room_id: providerRoomId,
      identity,
    };
  }
  // Other providers don't yet have a standalone-call-widget client adapter.
  return {
    supported: false,
    provider: providerId,
    server_url: null,
    room_id: providerRoomId,
    identity,
    reason: 'provider_client_not_supported',
  };
}
