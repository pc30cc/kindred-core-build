/**
 * Inbound call orchestration (ARI events → Core → LiveKit SIP).
 *
 * Deterministic and idempotent:
 *   INVITE → Asterisk endpoint (tenant resolved from the realtime row, NEVER
 *   from a SIP header) → Core `/calls/incoming` → Core returns the unique room
 *   name → operator claims in the Call Center → Core calls back with `answer`
 *   → this service answers the PSTN leg, dials `PJSIP/<room>@livekit_sip` and
 *   bridges both legs → either side hanging up converges on one `ended`.
 *
 * Duplicate ARI/provider events for the same SIP dialog resolve to the same
 * call record; Core is idempotent on (installation, provider, sip_call_id) too.
 */

import type { AsteriskControl } from './asteriskAri.js';
import type { RealtimeStore } from './database.js';
import type { CoreClient } from './coreClient.js';

export interface ActiveCall {
  sipCallId: string;
  installationId: string;
  workspaceId: string;
  provider: string;
  channelId: string;
  callerNumber: string | null;
  calledNumber: string | null;
  roomName: string | null;
  callSessionId: string | null;
  bridgeId: string | null;
  mediaChannelId: string | null;
  state: 'ringing' | 'connected' | 'ended';
}

export interface CallRegistry {
  byChannel: Map<string, ActiveCall>;
  bySipCallId: Map<string, ActiveCall>;
}

export function createCallRegistry(): CallRegistry {
  return { byChannel: new Map(), bySipCallId: new Map() };
}

export interface CallOrchestratorDeps {
  asterisk: AsteriskControl;
  store: RealtimeStore;
  core: CoreClient;
  livekitSipEndpoint: string;
  registry?: CallRegistry;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Endpoint name out of an ARI channel name: `PJSIP/wby<id>-00000001`. */
export function endpointFromChannelName(name: string): string | null {
  const m = /^PJSIP\/([^-]+)-/.exec(name);
  return m ? m[1] : null;
}

/** Caller identity is redacted in logs per the repo's privacy conventions. */
export function maskNumber(value: string | null): string {
  if (!value) return 'anonymous';
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `${value.slice(0, 3)}***${digits.slice(-2)}`;
}

export interface StasisStartEvent {
  channel: {
    id: string;
    name: string;
    caller?: { number?: string | null };
    dialplan?: { exten?: string | null };
  };
  args?: string[];
}

export function createCallOrchestrator(deps: CallOrchestratorDeps) {
  const registry = deps.registry ?? createCallRegistry();
  const log = deps.log ?? (() => undefined);

  async function handleStasisStart(event: StasisStartEvent): Promise<ActiveCall | null> {
    const channelId = event.channel.id;
    // The media leg we originate re-enters Stasis with our marker arg — it is
    // not a new inbound call.
    if ((event.args ?? []).includes('media')) return null;
    if (registry.byChannel.has(channelId)) return registry.byChannel.get(channelId)!;

    const endpointId = endpointFromChannelName(event.channel.name);
    if (!endpointId) {
      await deps.asterisk.hangup(channelId, 'congestion').catch(() => undefined);
      return null;
    }

    const owner = await deps.store.findEndpointOwner(endpointId);
    if (!owner) {
      // Unknown/unprovisioned endpoint: reject, never guess a tenant.
      log('telephony.gateway.error', { errorCode: 'unknown_endpoint', endpointId });
      await deps.asterisk.hangup(channelId, 'congestion').catch(() => undefined);
      return null;
    }

    const sipCallId =
      (await deps.asterisk.getChannelVar(channelId, 'CHANNEL(pjsip,call-id)')) ?? `chan-${channelId}`;

    const existing = registry.bySipCallId.get(sipCallId);
    if (existing) {
      registry.byChannel.set(channelId, existing);
      return existing;
    }

    const callerNumber = event.channel.caller?.number ?? null;
    const calledNumber = event.channel.dialplan?.exten ?? null;

    const call: ActiveCall = {
      sipCallId,
      installationId: owner.installationId,
      workspaceId: owner.workspaceId,
      provider: owner.provider,
      channelId,
      callerNumber,
      calledNumber,
      roomName: null,
      callSessionId: null,
      bridgeId: null,
      mediaChannelId: null,
      state: 'ringing',
    };
    registry.byChannel.set(channelId, call);
    registry.bySipCallId.set(sipCallId, call);

    log('telephony.call.incoming', {
      installationId: owner.installationId,
      provider: owner.provider,
      caller: maskNumber(callerNumber),
    });

    const result = await deps.core.incomingCall({
      installation_id: owner.installationId,
      provider: owner.provider,
      sip_call_id: sipCallId,
      external_call_id: sipCallId,
      caller_number: callerNumber,
      called_number: calledNumber,
      channel_id: channelId,
    });

    if (!result.ok || !result.room_name) {
      log('telephony.gateway.error', { errorCode: 'core_rejected_call', detail: result.error ?? null });
      await deps.asterisk.hangup(channelId, 'congestion').catch(() => undefined);
      registry.byChannel.delete(channelId);
      registry.bySipCallId.delete(sipCallId);
      return null;
    }

    call.roomName = result.room_name;
    call.callSessionId = result.call_session_id ?? null;
    await deps.asterisk.ring(channelId).catch(() => undefined);
    log('telephony.call.ringing', { installationId: owner.installationId, room: result.room_name });
    return call;
  }

  /** Operator won the atomic claim in Core: bridge PSTN ↔ LiveKit SIP. */
  async function answer(sipCallId: string, roomName?: string | null): Promise<void> {
    const call = registry.bySipCallId.get(sipCallId);
    if (!call) throw new Error('unknown_call');
    if (call.state === 'connected') return; // idempotent
    const room = roomName || call.roomName;
    if (!room) throw new Error('missing_room');

    await deps.asterisk.answer(call.channelId);
    const bridgeId = `webyar-${call.sipCallId.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`;
    await deps.asterisk.createBridge(bridgeId);
    const mediaChannelId = await deps.asterisk.originateToLiveKit({
      endpoint: deps.livekitSipEndpoint,
      room,
      callerId: call.callerNumber ?? 'anonymous',
      appArgs: 'media',
    });
    await deps.asterisk.addToBridge(bridgeId, [call.channelId, mediaChannelId]);

    call.bridgeId = bridgeId;
    call.mediaChannelId = mediaChannelId;
    call.roomName = room;
    call.state = 'connected';
    registry.byChannel.set(mediaChannelId, call);
    log('telephony.call.answered', { installationId: call.installationId, room });
  }

  async function reject(sipCallId: string): Promise<void> {
    const call = registry.bySipCallId.get(sipCallId);
    if (!call) throw new Error('unknown_call');
    await deps.asterisk.hangup(call.channelId, 'busy').catch(() => undefined);
    log('telephony.call.rejected', { installationId: call.installationId });
    await teardown(call, 'rejected');
  }

  async function hangup(sipCallId: string): Promise<void> {
    const call = registry.bySipCallId.get(sipCallId);
    if (!call) throw new Error('unknown_call');
    await deps.asterisk.hangup(call.channelId, 'normal').catch(() => undefined);
    await teardown(call, 'operator_hangup');
  }

  /** A channel disappeared (remote hangup, SIP failure, LiveKit teardown). */
  async function handleChannelDestroyed(channelId: string, reason = 'remote_hangup'): Promise<void> {
    const call = registry.byChannel.get(channelId);
    if (!call) return;
    await teardown(call, reason);
  }

  /** One convergent, idempotent end for every termination path. */
  async function teardown(call: ActiveCall, reason: string): Promise<void> {
    if (call.state === 'ended') return;
    call.state = 'ended';
    if (call.mediaChannelId) {
      await deps.asterisk.hangup(call.mediaChannelId, 'normal').catch(() => undefined);
    }
    if (call.bridgeId) await deps.asterisk.destroyBridge(call.bridgeId).catch(() => undefined);
    await deps.asterisk.hangup(call.channelId, 'normal').catch(() => undefined);
    registry.byChannel.delete(call.channelId);
    if (call.mediaChannelId) registry.byChannel.delete(call.mediaChannelId);
    registry.bySipCallId.delete(call.sipCallId);
    await deps.core.callEnded(call.installationId, call.sipCallId, reason);
    log('telephony.call.ended', { installationId: call.installationId, reason });
  }

  return { registry, handleStasisStart, handleChannelDestroyed, answer, reject, hangup };
}

export type CallOrchestrator = ReturnType<typeof createCallOrchestrator>;

/** Subscribes to the ARI event stream and drives the orchestrator. */
export function connectAriEvents(input: {
  ariUrl: string;
  user: string;
  password: string;
  appName: string;
  orchestrator: CallOrchestrator;
  log?: (event: string, fields: Record<string, unknown>) => void;
  WebSocketImpl?: typeof WebSocket;
}): { close: () => void } {
  const log = input.log ?? (() => undefined);
  const WS = input.WebSocketImpl ?? WebSocket;
  let socket: WebSocket | null = null;
  let closed = false;
  let retry = 1000;

  const wsUrl = `${input.ariUrl.replace(/^http/, 'ws')}/events?app=${encodeURIComponent(input.appName)}` +
    `&subscribeAll=true&api_key=${encodeURIComponent(`${input.user}:${input.password}`)}`;

  function open(): void {
    if (closed) return;
    socket = new WS(wsUrl);
    socket.onopen = () => { retry = 1000; log('telephony.gateway.ari_connected', {}); };
    socket.onclose = () => {
      if (closed) return;
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 30_000);
    };
    socket.onerror = () => { /* onclose handles the retry */ };
    socket.onmessage = (raw: MessageEvent) => {
      let event: any;
      try { event = JSON.parse(String(raw.data)); } catch { return; }
      void dispatch(event);
    };
  }

  async function dispatch(event: any): Promise<void> {
    try {
      switch (event?.type) {
        case 'StasisStart':
          await input.orchestrator.handleStasisStart(event);
          break;
        case 'ChannelDestroyed':
        case 'StasisEnd':
          await input.orchestrator.handleChannelDestroyed(
            String(event?.channel?.id ?? ''),
            event?.cause_txt ? String(event.cause_txt).slice(0, 60) : 'remote_hangup',
          );
          break;
        default:
          break;
      }
    } catch (err) {
      log('telephony.gateway.error', { errorCode: 'ari_event_failed', detail: (err as Error).message });
    }
  }

  open();
  return { close: () => { closed = true; socket?.close(); } };
}
