/** Standalone opt-in browser worker. Never imported by worker/index.ts. */
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { bridgeConfig, bridgePool } from '../../server/services/widgetBridge/config.js';
import { encryptPluginSecret, decryptPluginSecret } from '../../server/lib/pluginCrypto.js';
import { startBridgeEgress } from './egress.js';
import { BridgeStore, type LeasedContact } from './store.js';
import { makeAdapter, type BridgeAdapter } from './adapters.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const SAFE_ERRORS = new Set(['unsupported_widget','widget_not_found','ambiguous_widget','identity_required',
  'composer_unavailable','send_unavailable','connection_stopped','provider_not_allowed','message_too_long']);
const safeError = (err: unknown) => err instanceof Error && SAFE_ERRORS.has(err.message) ? err.message : 'widget_connection_failed';

/** The irreversible step is fenced and marked before touching the widget. */
export async function sendNext(store: BridgeStore, contact: LeasedContact, adapter: BridgeAdapter, persist: () => Promise<void>) {
  const message = await store.next(contact);
  if (!message) return;
  let dispatching = false;
  try {
    await adapter.prepare(contact.identity);
    // Save the visitor identity BEFORE any message can leave the process.
    await persist();
    if (!await store.dispatch(contact, message)) return;
    dispatching = true;
    const posted = await adapter.send(message.body);
    await persist();
    await store.finish(contact, message, posted ? 'sent' : 'uncertain', posted ? null : 'send_not_confirmed');
  } catch (err) {
    await store.finish(contact, message, dispatching ? 'uncertain' : 'failed', safeError(err));
  }
}

/** Bound DB batches without marking unpersisted replies as already received. */
export async function syncReplies(store: BridgeStore, contact: LeasedContact, adapter: BridgeAdapter, received: Map<string, string>) {
  const incoming = await adapter.receive();
  const snapshot = adapter.acknowledge ? incoming.slice(0, 200) : incoming;
  const changed = snapshot.filter(message => received.get(message.key) !== message.body).slice(0, 200);
  await store.receive(contact, changed);
  for (const message of changed) received.set(message.key, message.body);
  adapter.acknowledge?.(snapshot.length);
}

export async function startWidgetBridgeWorker() {
  const config = bridgeConfig();
  const store = new BridgeStore(bridgePool(), config.appId, randomUUID());
  const egress = await startBridgeEgress();
  let browser: Browser | undefined;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const active = new Map<string, Promise<void>>();
  const maxContexts = Math.min(8, Math.max(1, Number(process.env.WIDGET_BRIDGE_MAX_SESSIONS) || 4));
  const sessionMs = Math.min(1800000, Math.max(60000, Number(process.env.WIDGET_BRIDGE_SESSION_MS) || 600000));
  try {
    browser = await chromium.launch({
      headless: true, chromiumSandbox: true,
      proxy: { server: egress.url },
      args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    const run = async (contact: LeasedContact) => {
      let context: BrowserContext | undefined;
      let lastStateHash = '';
      let stopped = false;
      let heartbeatBusy = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let error: string | null = null;
      try {
        await store.recover(contact);
        // A slow navigation must still renew its lease. Failure closes the
        // context, so a partitioned worker cannot keep sending indefinitely.
        heartbeat = setInterval(() => {
          if (heartbeatBusy) return;
          heartbeatBusy = true;
          void store.alive(contact).then(alive => {
            if (!alive) { stopped = true; void context?.close().catch(() => {}); }
          }).catch(() => { stopped = true; void context?.close().catch(() => {}); }).finally(() => { heartbeatBusy = false; });
        }, 5000);
        const storageState = contact.session_envelope
          ? JSON.parse(decryptPluginSecret(contact.session_envelope, config.encryptionKey)) : undefined;
        context = await browser!.newContext({ storageState, serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
        // Do not let popups create unbounded new pages. Network egress is
        // enforced below Chromium, including WebSockets and redirected frames.
        const page = await context.newPage();
        context.on('page', extra => { if (extra !== page) void extra.close(); });
        page.setDefaultTimeout(10000);
        await page.goto(contact.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const adapter = await makeAdapter(page, contact.provider, contact.selectors, contact.allowed_providers);
        await adapter.prepare(contact.identity);
        const persist = async () => {
          if (stopped || stopping) throw new Error('connection_stopped');
          const state = JSON.stringify(await context!.storageState({ indexedDB: true }));
          if (state.length > 1000000) throw new Error('widget_connection_failed');
          const hash = createHash('sha256').update(state).digest('hex');
          if (hash !== lastStateHash) {
            await store.saveSession(contact, encryptPluginSecret(state, config.encryptionKey));
            lastStateHash = hash;
          }
        };
        await persist();
        const started = Date.now();
        let lastPersist = Date.now();
        let lastRotationCheck = started;
        const received = new Map<string, string>();
        while (!stopping && !stopped) {
          if (!await store.alive(contact)) break;
          // Do not create a receive gap every ten minutes for a lone active
          // contact. Rotate only when another site is actually waiting.
          if (Date.now() - started >= sessionMs && Date.now() - lastRotationCheck > 30000) {
            lastRotationCheck = Date.now();
            if (await store.hasWaiting()) break;
          }
          await syncReplies(store, contact, adapter, received);
          await sendNext(store, contact, adapter, persist);
          if (await store.yieldForBatch(contact)) break;
          if (Date.now() - lastPersist > 30000) { await persist(); lastPersist = Date.now(); }
          await pause(1500);
        }
        if (!stopped && !stopping && await store.alive(contact)) await persist();
      } catch (err) { error = safeError(err); }
      finally {
        if (heartbeat) clearInterval(heartbeat);
        await context?.close().catch(() => {});
        await store.release(contact, error).catch(() => {});
      }
    };
    let lastReap = 0;
    let lastHealth = 0;
    while (!stopping) {
      if (!browser.isConnected()) throw new Error('browser_disconnected');
      if (Date.now() - lastReap > 10000) { await store.reap(); lastReap = Date.now(); }
      if (active.size < maxContexts) {
        const contact = await store.claim();
        if (contact) {
          const job = run(contact).finally(() => active.delete(contact.id));
          active.set(contact.id, job);
        }
      }
      if (Date.now() - lastHealth > 10000) {
        writeFileSync('/tmp/widget-bridge-health', String(Date.now())); lastHealth = Date.now();
      }
      await pause(1000);
    }
  } finally {
    stopping = true;
    // Closing pages interrupts any pending navigation/send. No external action
    // is retried after an ambiguous process termination.
    await browser?.close().catch(() => {});
    await Promise.allSettled(active.values());
    await egress.close();
    await bridgePool().end();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startWidgetBridgeWorker().catch(() => {
    console.error('[widget-bridge] worker stopped; check bridge database, encryption and browser sandbox configuration');
    process.exitCode = 1;
  });
}
