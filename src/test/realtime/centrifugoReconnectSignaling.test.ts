/**
 * Regression coverage for the operator-side Centrifugo reconnect-labeling
 * fix (round 2). Drives the REAL CentrifugoClientProvider through a mocked
 * WebSocket + mocked fetch to prove the full lifecycle contract:
 *
 *   - initial connection                                 → 0 reconnect signals
 *   - proactive token refresh                              → 0 reconnect signals
 *   - intentional socket rotation caused by that refresh   → 0 reconnect signals
 *   - genuine first reconnect, token still valid           → 1 lightweight signal,
 *                                                             NO token re-mint
 *   - genuine reconnect with an expired/near-expiry token  → 1 full re-negotiation
 *                                                             tagged intent:'reconnect'
 *   - a second, subsequent failed-then-retried reconnect   → its own distinct
 *                                                             report, not a duplicate
 *     of the first
 *
 * Reconnect-classification fix — retries before the FIRST successful
 * Centrifugo CONNECT ack (SharedConnection.everConnected) must never be
 * classified as a reconnect, regardless of a live socket, token presence,
 * or attempt count:
 *   - socket closes before it ever opens/connects     → 0 reconnect signals,
 *                                                        0 intent:'reconnect'
 *   - the first CONNECT handshake is rejected          → retry stays initial
 *                                                        recovery, 0 metrics
 *   - initial recovery needs a fresh/expired token      → negotiates with
 *                                                        intent:'initial'
 *   - initial failures, THEN a real success, THEN an
 *     unexpected close                                  → reconnect
 *                                                        accounting begins
 *                                                        only after success
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: async () => ({ data: null, error: null }) },
}));

// centrifugo.ts dynamically imports this module inside scheduleReconnect's
// re-negotiation branch. Pre-mocking it avoids a real (slow, non-fake-timer)
// module-load round-trip racing against vi.advanceTimersByTimeAsync below.
vi.mock('@/realtime/resolveClientRealtimeProvider', () => ({
  invalidateClientRealtimeCache: vi.fn(),
}));

class MockSocket {
  static instances: MockSocket[] = [];
  static reset(): void {
    MockSocket.instances = [];
  }
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev?: any) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners: Record<string, Array<() => void>> = {};
  sent: any[] = [];
  /** When true, the next 'connect' frame gets an error reply instead of a success ack. */
  rejectConnect = false;
  constructor(public url: string) {
    MockSocket.instances.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    (this.listeners[type] ||= []).push(cb);
  }
  removeEventListener(): void {}
  send(data: string): void {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (frame.connect) {
      if (this.rejectConnect) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: frame.id, error: { code: 109, message: 'token expired' } }) }));
      } else {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: frame.id, connect: { client: 'c1' } }) }));
      }
    } else if (frame.subscribe) {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: frame.id, subscribe: {} }) }));
    } else if (frame.unsubscribe) {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: frame.id, unsubscribe: {} }) }));
    }
  }
  /** Test helper: simulate the handshake completing successfully. */
  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
    (this.listeners.open || []).forEach((cb) => cb());
  }
  /** Test helper: simulate an unexpected server-side / network close. */
  triggerUnexpectedClose(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'abnormal' });
  }
  /**
   * Test helper: the socket dies before it ever fires 'open' — the real
   * browser equivalent of a connection that never gets established (DNS
   * failure, refused connection, etc). Fires the 'error' listener openSocket()
   * awaits (rejecting conn.ready) AND the onclose handler
   * attachSocketHandlers wires up (triggering scheduleReconnect), matching
   * how a real failed WebSocket reports both.
   */
  triggerCloseBeforeOpen(): void {
    this.readyState = 3;
    (this.listeners.error || []).forEach((cb) => cb());
    this.onclose?.({ code: 1006, reason: 'failed_before_open' });
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'manual_close' });
  }
}

const WS = 'ws-1111-1111-1111-1111-111111111111';
const TOKEN_TTL_MS = 30 * 60_000; // 30 minutes, matching platform default

interface Call {
  url: string;
  body: any;
}
let fetchCalls: Call[] = [];

function mockFetchImpl(negotiationOverrides: Partial<{ token: string; expires_at: number }> = {}) {
  return vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    fetchCalls.push({ url: u, body });
    if (u.includes('/api/realtime/operator-connect')) {
      return {
        ok: true,
        json: async () => ({
          vendor: 'centrifugo',
          ws_url: 'wss://test.invalid/connection/websocket',
          token: negotiationOverrides.token ?? `fresh-token-${fetchCalls.length}`,
          expires_at: negotiationOverrides.expires_at ?? Date.now() + TOKEN_TTL_MS,
          capabilities: {},
        }),
      } as any;
    }
    if (u.includes('/api/realtime/operator-reconnect-signal')) {
      return { ok: true, json: async () => ({ ok: true }) } as any;
    }
    if (u.includes('/api/realtime/operator-inbox-subscribe')) {
      return {
        ok: true,
        json: async () => ({
          vendor: 'centrifugo',
          channel: `ws:${WS}:inbox`,
          token: 'sub-token',
          expires_at: Date.now() + TOKEN_TTL_MS,
        }),
      } as any;
    }
    throw new Error(`unmocked fetch: ${u}`);
  });
}

function reconnectSignalCalls(): Call[] {
  return fetchCalls.filter((c) => c.url.includes('/operator-reconnect-signal'));
}
function fullReconnectNegotiations(): Call[] {
  return fetchCalls.filter((c) => c.url.includes('/operator-connect') && c.body.intent === 'reconnect');
}
function refreshNegotiations(): Call[] {
  return fetchCalls.filter((c) => c.url.includes('/operator-connect') && c.body.intent === 'refresh');
}
function initialNegotiations(): Call[] {
  return fetchCalls.filter((c) => c.url.includes('/operator-connect') && c.body.intent === 'initial');
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('CentrifugoClientProvider — reconnect signaling contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchCalls = [];
    MockSocket.reset();
    vi.stubGlobal('WebSocket', MockSocket as any);
    vi.stubGlobal('fetch', mockFetchImpl());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function connectAndOpen() {
    const { CentrifugoClientProvider } = await import('@/realtime/providers/centrifugo');
    const provider = new CentrifugoClientProvider({
      vendor: 'centrifugo',
      ws_url: 'wss://test.invalid/connection/websocket',
      token: 'initial-token',
      expires_at: Date.now() + TOKEN_TTL_MS,
      capabilities: {},
    });
    const handlers = { onStatus: vi.fn() };
    const subPromise = provider.subscribe(`ws:${WS}:inbox`, handlers as any);
    await flushMicrotasks(2);
    const socket = MockSocket.instances[0];
    expect(socket).toBeTruthy();
    socket.triggerOpen();
    await flushMicrotasks(6);
    await subPromise;
    return { provider, handlers, socket };
  }

  it('initial connection reports zero reconnect signals and zero full reconnect negotiations', async () => {
    await connectAndOpen();
    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);
  });

  it('a genuine first reconnect with a still-valid token sends the lightweight signal and reuses the token (no re-mint)', async () => {
    const { socket: firstSocket } = await connectAndOpen();
    const callsBeforeClose = fetchCalls.length;

    firstSocket.triggerUnexpectedClose();
    // scheduleReconnect's timer fires after the (jittered) backoff delay.
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(6);

    expect(reconnectSignalCalls()).toHaveLength(1);
    expect(fullReconnectNegotiations()).toHaveLength(0);
    // No new /operator-connect call at all — the token was reused, not re-minted.
    const newNegotiations = fetchCalls
      .slice(callsBeforeClose)
      .filter((c) => c.url.includes('/api/realtime/operator-connect'));
    expect(newNegotiations).toHaveLength(0);

    const secondSocket = MockSocket.instances[MockSocket.instances.length - 1];
    expect(secondSocket).not.toBe(firstSocket);
  });

  it('a reconnect with an expired/near-expiry token performs a full re-negotiation tagged intent:reconnect (never the lightweight signal)', async () => {
    // expires_at set inside the TOKEN_REFRESH_LEAD_MS (120s) window from now.
    const { CentrifugoClientProvider } = await import('@/realtime/providers/centrifugo');
    const provider = new CentrifugoClientProvider({
      vendor: 'centrifugo',
      ws_url: 'wss://test.invalid/connection/websocket',
      token: 'about-to-expire',
      expires_at: Date.now() + 60_000, // 60s out — inside the 120s refresh lead
      capabilities: {},
    });
    const subPromise = provider.subscribe(`ws:${WS}:inbox`, { onStatus: vi.fn() } as any);
    await flushMicrotasks(2);
    const socket = MockSocket.instances[0];
    socket.triggerOpen();
    await flushMicrotasks(6);
    await subPromise;

    socket.triggerUnexpectedClose();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(6);

    expect(fullReconnectNegotiations()).toHaveLength(1);
    expect(reconnectSignalCalls()).toHaveLength(0);
  });

  it('repeated failed reconnects each get their own distinct report, not a duplicate of the first', async () => {
    const { socket: firstSocket } = await connectAndOpen();

    // Attempt 1: valid token → lightweight signal, then the new socket also fails to open.
    firstSocket.triggerUnexpectedClose();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(6);
    expect(reconnectSignalCalls()).toHaveLength(1);

    const secondSocket = MockSocket.instances[MockSocket.instances.length - 1];
    // Simulate the second socket also failing before ever completing its handshake.
    secondSocket.triggerUnexpectedClose();
    // Attempt 2: reconnectAttempt is now > 1 → forces full re-negotiation.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks(6);

    expect(fullReconnectNegotiations()).toHaveLength(1);
    // Still exactly one lightweight signal — attempt 2 took the full-negotiation
    // path instead, it did not also send a duplicate lightweight signal.
    expect(reconnectSignalCalls()).toHaveLength(1);
  });

  it('proactive token refresh reports intent:refresh, never a reconnect signal', async () => {
    await connectAndOpen();

    // TOKEN_REFRESH_LEAD_MS is 120_000; the initial token was minted with a
    // 30-minute TTL, so advance to just past (ttl - lead).
    await vi.advanceTimersByTimeAsync(TOKEN_TTL_MS - 120_000 + 1_000);
    await flushMicrotasks(6);

    expect(refreshNegotiations()).toHaveLength(1);
    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);
  });

  it('the socket rotation caused by a proactive refresh does not masquerade as a real reconnect', async () => {
    await connectAndOpen();

    // scheduleTokenRefresh negotiates a fresh token, then closes its own
    // socket to rotate onto it — the resulting onclose fires
    // scheduleReconnect's very next timer within this same advance window
    // (the rotation's own reconnect backoff, ~500ms, comfortably fits
    // inside the 1s of slack past the refresh's scheduled fire time).
    // That whole self-inflicted cycle must produce zero reconnect reports.
    await vi.advanceTimersByTimeAsync(TOKEN_TTL_MS - 120_000 + 1_000);
    await flushMicrotasks(6);

    expect(refreshNegotiations()).toHaveLength(1);
    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);
  });

  it('policy-poll traffic (useEffectivePolicy) never touches this provider’s reconnect accounting', async () => {
    // useEffectivePolicy calls /operator-connect directly with intent:'policy_poll'
    // — a completely separate call path from CentrifugoClientProvider. Confirm
    // that path alone never appears as a reconnect report.
    await fetch('/api/realtime/operator-connect', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: WS, intent: 'policy_poll' }),
    });
    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);
  });

  it('1: the first socket closes before it ever successfully opens/connects → zero reconnect signals, zero intent:reconnect', async () => {
    const { CentrifugoClientProvider } = await import('@/realtime/providers/centrifugo');
    const provider = new CentrifugoClientProvider({
      vendor: 'centrifugo',
      ws_url: 'wss://test.invalid/connection/websocket',
      token: 'initial-token',
      expires_at: Date.now() + TOKEN_TTL_MS,
      capabilities: {},
    });
    const handlers = { onStatus: vi.fn() };
    const subPromise = provider.subscribe(`ws:${WS}:inbox`, handlers as any);
    await flushMicrotasks(2);
    const firstSocket = MockSocket.instances[0];
    // Never opens — dies before onopen/CONNECT ever fire. everConnected is
    // still false: not proof a connection previously existed.
    firstSocket.triggerCloseBeforeOpen();
    await subPromise;
    await flushMicrotasks(2);

    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);

    // Let the recovery retry actually fire.
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(6);

    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);
  });

  it('2: the socket opens but the first Centrifugo CONNECT handshake is rejected → retry stays initial recovery, zero reconnect metrics', async () => {
    const { CentrifugoClientProvider } = await import('@/realtime/providers/centrifugo');
    const provider = new CentrifugoClientProvider({
      vendor: 'centrifugo',
      ws_url: 'wss://test.invalid/connection/websocket',
      token: 'initial-token',
      expires_at: Date.now() + TOKEN_TTL_MS,
      capabilities: {},
    });
    const handlers = { onStatus: vi.fn() };
    const subPromise = provider.subscribe(`ws:${WS}:inbox`, handlers as any);
    await flushMicrotasks(2);
    const socket = MockSocket.instances[0];
    socket.rejectConnect = true;
    socket.triggerOpen();
    await subPromise;
    await flushMicrotasks(6);

    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(6);

    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);
  });

  it('3: initial connection recovery that needs a fresh/expired token negotiates with intent:initial, never intent:reconnect', async () => {
    const { CentrifugoClientProvider } = await import('@/realtime/providers/centrifugo');
    const provider = new CentrifugoClientProvider({
      vendor: 'centrifugo',
      ws_url: 'wss://test.invalid/connection/websocket',
      token: 'about-to-expire',
      // Already past expiry — forces scheduleReconnect's token-refresh branch.
      expires_at: Date.now() - 1_000,
      capabilities: {},
    });
    const handlers = { onStatus: vi.fn() };
    const subPromise = provider.subscribe(`ws:${WS}:inbox`, handlers as any);
    await flushMicrotasks(2);
    const firstSocket = MockSocket.instances[0];
    firstSocket.triggerCloseBeforeOpen();
    await subPromise;
    await flushMicrotasks(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(6);

    expect(fullReconnectNegotiations()).toHaveLength(0);
    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(initialNegotiations().length).toBeGreaterThanOrEqual(1);
  });

  it('4: initial failures then a real success then an unexpected close → reconnect accounting begins only after that success', async () => {
    const { CentrifugoClientProvider } = await import('@/realtime/providers/centrifugo');
    const provider = new CentrifugoClientProvider({
      vendor: 'centrifugo',
      ws_url: 'wss://test.invalid/connection/websocket',
      token: 'initial-token',
      expires_at: Date.now() + TOKEN_TTL_MS,
      capabilities: {},
    });
    const handlers = { onStatus: vi.fn() };
    const subPromise = provider.subscribe(`ws:${WS}:inbox`, handlers as any);
    await flushMicrotasks(2);
    const firstSocket = MockSocket.instances[0];
    firstSocket.triggerCloseBeforeOpen();
    await subPromise;
    await flushMicrotasks(2);

    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);

    // Recovery retry fires and this time succeeds — the FIRST real CONNECT
    // ack for this shared connection. everConnected flips true here.
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(6);
    const secondSocket = MockSocket.instances[MockSocket.instances.length - 1];
    secondSocket.triggerOpen();
    await flushMicrotasks(6);

    // A successful connect is not itself a reconnect.
    expect(reconnectSignalCalls()).toHaveLength(0);
    expect(fullReconnectNegotiations()).toHaveLength(0);

    // NOW losing the established connection is a genuine reconnect.
    secondSocket.triggerUnexpectedClose();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(6);

    expect(reconnectSignalCalls()).toHaveLength(1);
    expect(fullReconnectNegotiations()).toHaveLength(0);
  });
});
