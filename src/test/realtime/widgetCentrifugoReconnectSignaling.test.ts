/**
 * Widget-side sibling of centrifugoReconnectSignaling.test.ts. Loads the
 * REAL public/widget/runtime-rt-centrifugo.js source (not a reimplementation)
 * into an isolated vm context and drives it through a mocked WebSocket +
 * fetch to prove the same reconnect-signaling contract holds for the
 * plain-JS widget runtime:
 *
 *   - initial connect                                → 0 reconnect signals
 *   - genuine first reconnect, token still valid      → 1 lightweight signal,
 *                                                        no token re-mint
 *   - reconnect with an expired/near-expiry token     → 1 full re-negotiation
 *                                                        tagged intent:'reconnect'
 *
 * Reconnect-classification fix — retries before the FIRST successful
 * Centrifugo CONNECT ack (firstConnectDone) must never be classified as a
 * reconnect, regardless of WebSocket onopen, token presence, or attempt
 * count:
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const WIDGET_SRC = readFileSync(
  path.join(process.cwd(), 'public/widget/runtime-rt-centrifugo.js'),
  'utf8',
);

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
  sent: any[] = [];
  /** When true, the next 'connect' frame gets an error reply instead of a success ack. */
  rejectConnect = false;
  constructor(public url: string) {
    MockSocket.instances.push(this);
  }
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
    }
  }
  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  triggerUnexpectedClose(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'abnormal' });
  }
  /** The widget's connect-rejection handler calls ws.close() itself. */
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'connect_rejected' });
  }
}

interface Call {
  url: string;
  body: any;
}

const TOKEN_TTL_MS = 30 * 60_000;

function buildSandbox(fetchCalls: Call[]) {
  const fetchImpl = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    fetchCalls.push({ url: u, body });
    if (u.includes('/api/realtime/connect')) {
      return {
        ok: true,
        json: async () => ({
          vendor: 'centrifugo',
          ws_url: 'wss://test.invalid/connection/websocket',
          token: `fresh-token-${fetchCalls.length}`,
          expires_at: Date.now() + TOKEN_TTL_MS,
        }),
      } as any;
    }
    if (u.includes('/api/realtime/reconnect-signal')) {
      return { ok: true, json: async () => ({ ok: true }) } as any;
    }
    throw new Error(`unmocked fetch: ${u}`);
  });

  const sandbox: any = {
    window: { __gs_policy: null },
    WebSocket: MockSocket,
    fetch: fetchImpl,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    JSON,
    Object,
    Array,
    Math,
    Date,
    String,
    Number,
    Boolean,
  };
  vm.createContext(sandbox);
  vm.runInContext(WIDGET_SRC, sandbox);
  return { sandbox, fetchImpl };
}

function reconnectSignalCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.includes('/reconnect-signal'));
}
function fullReconnectNegotiations(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.includes('/api/realtime/connect') && c.body.intent === 'reconnect');
}
function initialNegotiations(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.includes('/api/realtime/connect') && c.body.intent === 'initial');
}

async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('widget runtime-rt-centrifugo.js — reconnect signaling contract', () => {
  let fetchCalls: Call[];

  beforeEach(() => {
    vi.useFakeTimers();
    fetchCalls = [];
    MockSocket.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createDriver(sandbox: any, expiresInMs: number) {
    const ctx = { apiBase: '', workspaceId: 'ws-1', sessionToken: 'widget-token-1' };
    const resolved = {
      token: 'initial-token',
      expires_at: Date.now() + expiresInMs,
      ws_url: 'wss://test.invalid/connection/websocket',
      capabilities: {},
      public_config: {},
    };
    const hooks = { onConnectionState: vi.fn(), onReconnect: vi.fn(), fallbackToPolling: vi.fn() };
    const driver = sandbox.window.__gs_mod_rt_centrifugo.create(ctx, resolved, hooks);
    return { driver, hooks };
  }

  it('initial connect reports zero reconnect signals and zero reconnect negotiations', async () => {
    const { sandbox } = buildSandbox(fetchCalls);
    const { driver } = createDriver(sandbox, TOKEN_TTL_MS);
    driver.connect();
    await flushMicrotasks(2);
    const socket = MockSocket.instances[0];
    socket.triggerOpen();
    await flushMicrotasks(6);

    expect(reconnectSignalCalls(fetchCalls)).toHaveLength(0);
    expect(fullReconnectNegotiations(fetchCalls)).toHaveLength(0);
    // The initial connect() used the token already provided by the
    // resolver (resolved.token) — it never re-fetches /connect at all.
    expect(initialNegotiations(fetchCalls)).toHaveLength(0);
  });

  it('a genuine first reconnect with a still-valid token sends the lightweight signal and reuses the token', async () => {
    const { sandbox } = buildSandbox(fetchCalls);
    const { driver } = createDriver(sandbox, TOKEN_TTL_MS);
    driver.connect();
    await flushMicrotasks(2);
    const firstSocket = MockSocket.instances[0];
    firstSocket.triggerOpen();
    await flushMicrotasks(6);

    firstSocket.triggerUnexpectedClose();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks(6);

    expect(reconnectSignalCalls(fetchCalls)).toHaveLength(1);
    expect(fullReconnectNegotiations(fetchCalls)).toHaveLength(0);
    expect(MockSocket.instances.length).toBe(2);
  });

  it('a reconnect with an expired/near-expiry token performs a full re-negotiation tagged intent:reconnect, never the lightweight signal', async () => {
    const { sandbox } = buildSandbox(fetchCalls);
    // 30s out — inside the widget's 60s local-expiry lead.
    const { driver } = createDriver(sandbox, 30_000);
    driver.connect();
    await flushMicrotasks(2);
    const socket = MockSocket.instances[0];
    socket.triggerOpen();
    await flushMicrotasks(6);

    socket.triggerUnexpectedClose();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks(6);

    expect(fullReconnectNegotiations(fetchCalls)).toHaveLength(1);
    expect(reconnectSignalCalls(fetchCalls)).toHaveLength(0);
  });

  it('1: the first socket closes before it ever successfully opens/connects → zero reconnect signals, zero intent:reconnect', async () => {
    const { sandbox } = buildSandbox(fetchCalls);
    const { driver } = createDriver(sandbox, TOKEN_TTL_MS);
    driver.connect();
    await flushMicrotasks(2);
    const socket = MockSocket.instances[0];
    // Never call triggerOpen() — the socket dies before onopen ever fires,
    // so firstConnectDone is still false. Not proof of a prior connection.
    socket.triggerUnexpectedClose();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks(6);

    expect(reconnectSignalCalls(fetchCalls)).toHaveLength(0);
    expect(fullReconnectNegotiations(fetchCalls)).toHaveLength(0);
    // A second socket was opened for the retry, but that retry is initial
    // recovery, not a reconnect.
    expect(MockSocket.instances.length).toBe(2);
  });

  it('2: the socket opens but the first Centrifugo CONNECT handshake is rejected → retry is still initial recovery, zero reconnect metrics', async () => {
    const { sandbox } = buildSandbox(fetchCalls);
    const { driver } = createDriver(sandbox, TOKEN_TTL_MS);
    driver.connect();
    await flushMicrotasks(2);
    const socket = MockSocket.instances[0];
    socket.rejectConnect = true;
    socket.triggerOpen();
    await flushMicrotasks(6);
    // The widget's connect-rejection handler calls ws.close() itself,
    // which fires onclose → scheduleReconnect. firstConnectDone was never
    // set (the CONNECT reply was an error, not a success).
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks(6);

    expect(reconnectSignalCalls(fetchCalls)).toHaveLength(0);
    expect(fullReconnectNegotiations(fetchCalls)).toHaveLength(0);
  });

  it('3: initial connection recovery that needs a fresh/expired token negotiates with intent:initial, never intent:reconnect', async () => {
    const { sandbox } = buildSandbox(fetchCalls);
    // Already past its expiry — forces scheduleReconnect's token-refresh branch.
    const { driver } = createDriver(sandbox, -1_000);
    driver.connect();
    await flushMicrotasks(2);
    const socket = MockSocket.instances[0];
    // Socket dies before ever completing a CONNECT handshake.
    socket.triggerUnexpectedClose();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks(6);

    expect(fullReconnectNegotiations(fetchCalls)).toHaveLength(0);
    expect(reconnectSignalCalls(fetchCalls)).toHaveLength(0);
    // The recovery negotiation must be tagged intent:'initial'.
    expect(initialNegotiations(fetchCalls).length).toBeGreaterThanOrEqual(1);
  });

  it('4: initial failures then a real success then an unexpected close → reconnect accounting begins only after that success', async () => {
    const { sandbox } = buildSandbox(fetchCalls);
    const { driver } = createDriver(sandbox, TOKEN_TTL_MS);
    driver.connect();
    await flushMicrotasks(2);

    // First attempt: dies before ever opening — initial-recovery territory.
    const firstSocket = MockSocket.instances[0];
    firstSocket.triggerUnexpectedClose();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks(6);

    expect(reconnectSignalCalls(fetchCalls)).toHaveLength(0);
    expect(fullReconnectNegotiations(fetchCalls)).toHaveLength(0);

    // Second attempt: succeeds — the first real CONNECT ack for this
    // client instance. firstConnectDone flips true here.
    const secondSocket = MockSocket.instances[MockSocket.instances.length - 1];
    secondSocket.triggerOpen();
    await flushMicrotasks(6);

    // Still zero reconnect telemetry — a successful connect is not itself a reconnect.
    expect(reconnectSignalCalls(fetchCalls)).toHaveLength(0);
    expect(fullReconnectNegotiations(fetchCalls)).toHaveLength(0);

    // NOW an unexpected loss of the established connection is a real reconnect.
    secondSocket.triggerUnexpectedClose();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks(6);

    expect(reconnectSignalCalls(fetchCalls)).toHaveLength(1);
    expect(fullReconnectNegotiations(fetchCalls)).toHaveLength(0);
  });
});
