/**
 * Centrifugo publisher.
 *
 * Wraps the existing `CentrifugoDriver.publish()` HTTP API call. The
 * envelope is sent as-is so the widget runtime
 * (public/widget/runtime-rt-centrifugo.js) and the inbox client adapter
 * (src/realtime/providers/centrifugo.ts) receive the same shape they
 * already parse today.
 */

import type { CentrifugoDriver } from '../centrifugo.js';
import type {
  ConversationEventEnvelope,
  PublishResult,
  ServerRealtimePublisher,
} from './types.js';

export class CentrifugoPublisher implements ServerRealtimePublisher {
  readonly vendor = 'centrifugo' as const;

  constructor(private readonly driver: CentrifugoDriver) {}

  async publish(channel: string, envelope: ConversationEventEnvelope): Promise<PublishResult> {
    try {
      const result = await this.driver.publish(
        channel,
        envelope as unknown as Record<string, unknown>,
      );
      if (!result.ok) {
        return { ok: false, reason: result.error || 'centrifugo_publish_failed' };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'centrifugo_publish_error' };
    }
  }
}
