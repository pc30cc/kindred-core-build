/**
 * Call Center realtime publish — uses the existing publisher abstraction
 * to fan out queue/call events on dedicated channels.
 */
import type { ServerConfig } from '../../config.js';
import { resolvePublisher } from '../realtime/resolvePublisher.js';

export type CallCenterEventType =
  | 'call_requested'
  | 'call_queued'
  | 'call_ringing'
  | 'call_accepted'
  | 'call_rejected'
  | 'call_cancelled'
  | 'call_started'
  | 'call_ended'
  | 'callback_requested'
  | 'agent_status_changed';

function queueChannel(workspaceId: string) {
  return `ws:${workspaceId}:call-center:queue`;
}
function callChannel(workspaceId: string, callId: string) {
  return `ws:${workspaceId}:call:${callId}`;
}

export async function publishQueueEvent(
  config: ServerConfig,
  workspaceId: string,
  type: CallCenterEventType,
  payload: Record<string, unknown>,
) {
  try {
    const pub = await resolvePublisher(config, workspaceId);
    await pub.publish(queueChannel(workspaceId), {
      type: 'message',
      payload: { kind: 'call_center', event: type, ...payload },
    } as any);
  } catch {/* polling fallback */}
}

export async function publishCallEvent(
  config: ServerConfig,
  workspaceId: string,
  callId: string,
  type: CallCenterEventType,
  payload: Record<string, unknown>,
) {
  try {
    const pub = await resolvePublisher(config, workspaceId);
    await pub.publish(callChannel(workspaceId, callId), {
      type: 'message',
      payload: { kind: 'call_center', event: type, ...payload },
    } as any);
  } catch {/* polling fallback */}
}