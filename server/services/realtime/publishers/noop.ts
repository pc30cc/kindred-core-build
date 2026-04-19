/**
 * No-op publisher.
 *
 * Used when realtime is disabled, mis-configured, or the active vendor
 * has no server-side publish support. The DB write is already the source
 * of truth and React Query polling drives the inbox UI, so returning
 * `{ ok: false, reason: 'noop' }` is the desired behavior — the inbox
 * shows "saved (polling)" instead of "sent live".
 */

import type {
  ConversationEventEnvelope,
  PublishResult,
  ServerRealtimePublisher,
} from './types.js';

export class NoopPublisher implements ServerRealtimePublisher {
  readonly vendor = 'noop' as const;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async publish(_channel: string, _envelope: ConversationEventEnvelope): Promise<PublishResult> {
    return { ok: false, reason: 'realtime_disabled_or_unsupported' };
  }
}
