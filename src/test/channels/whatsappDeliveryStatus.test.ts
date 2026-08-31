/**
 * WHATSAPP CLOUD — ASYNC OUTBOUND DELIVERY LIFECYCLE.
 *
 * Traced contract:
 *   • Graph send only ACCEPTS and returns a `wamid`; Core writes
 *     `channel_delivery = 'sent'` from that acceptance.
 *   • The REAL outcome arrives later in webhook `value.statuses[]`:
 *     sent → delivered → read, or a terminal `failed` (which may follow an
 *     accepted send).
 *   • `statuses[]` is not customer content and travels a narrow path that
 *     never enters the inbound pipeline.
 *   • Telegram/Bale/Instagram have no async status callback: a 2xx send IS the
 *     delivery truth and their semantics are untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractWhatsAppDeliveryStatuses,
  resolveDeliveryTransition,
} from '../../../server/services/channels/whatsapp/deliveryStatus';
import { whatsappToBotUpdates } from '../../../server/services/channels/whatsapp/toBotUpdate';
import { computeNeedsReply } from '../../../server/services/needsReply';

const hook = (statuses: any[], messages: any[] = []) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses, messages } }] }],
});
const status = (s: string, id = 'wamid.A', ts = 1700000000, errors?: any[]) => ({
  id,
  status: s,
  timestamp: String(ts),
  recipient_id: '98912',
  ...(errors ? { errors } : {}),
});

describe('statuses[] extraction', () => {
  it('extracts the full success ladder and terminal failure', () => {
    const out = extractWhatsAppDeliveryStatuses(
      hook([status('sent'), status('delivered'), status('read'), status('failed', 'wamid.B', 1700000005, [{ code: 131026, title: 'Undeliverable' }])]),
    );
    expect(out.map((s) => s.status)).toEqual(['sent', 'delivered', 'read', 'failed']);
    expect(out[3].providerMessageId).toBe('wamid.B');
    expect(out[3].errorCode).toBe('131026');
    expect(out[0].occurredAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('ignores unknown status kinds and id-less rows', () => {
    expect(extractWhatsAppDeliveryStatuses(hook([{ status: 'deleted', id: 'wamid.X' }, { status: 'sent' }]))).toEqual([]);
  });

  it('statuses[] never becomes an inbound customer update', () => {
    const payload = hook([status('read'), status('failed')]);
    expect(whatsappToBotUpdates(payload)).toEqual([]);
  });

  it('a webhook carrying BOTH keeps the two paths separate', () => {
    const payload = hook(
      [status('delivered', 'wamid.OUT')],
      [{ from: '98912', id: 'wamid.IN', timestamp: '1700000001', type: 'text', text: { body: 'سلام' } }],
    );
    const updates = whatsappToBotUpdates(payload);
    expect(updates).toHaveLength(1);
    expect(updates[0].message.text).toBe('سلام');
    const statuses = extractWhatsAppDeliveryStatuses(payload);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].providerMessageId).toBe('wamid.OUT');
  });
});

describe('delivery state machine — monotonic success, provider-aware failure', () => {
  it('walks the ladder forward', () => {
    expect(resolveDeliveryTransition(undefined, 'sent')).toMatchObject({ apply: true, status: 'sent' });
    expect(resolveDeliveryTransition('sent', 'delivered')).toMatchObject({ apply: true, status: 'delivered' });
    expect(resolveDeliveryTransition('delivered', 'read')).toMatchObject({ apply: true, status: 'read' });
  });

  it('never downgrades on an out-of-order webhook', () => {
    expect(resolveDeliveryTransition('delivered', 'sent')).toEqual({ apply: false, reason: 'out_of_order' });
    expect(resolveDeliveryTransition('read', 'delivered')).toEqual({ apply: false, reason: 'out_of_order' });
    expect(resolveDeliveryTransition('read', 'sent')).toEqual({ apply: false, reason: 'out_of_order' });
  });

  it('a repeated identical status is a no-op (webhook retries)', () => {
    for (const s of ['sent', 'delivered', 'read', 'failed'] as const) {
      expect(resolveDeliveryTransition(s, s)).toEqual({ apply: false, reason: 'duplicate' });
    }
  });

  it('async failure after an ACCEPTED send is legitimate and terminal', () => {
    expect(resolveDeliveryTransition('sent', 'failed')).toEqual({ apply: true, status: 'failed', terminalFailure: true });
    expect(resolveDeliveryTransition(undefined, 'failed')).toEqual({ apply: true, status: 'failed', terminalFailure: true });
  });

  it('failure is NOT accepted once the handset already has the message', () => {
    expect(resolveDeliveryTransition('delivered', 'failed')).toEqual({ apply: false, reason: 'not_failable' });
    expect(resolveDeliveryTransition('read', 'failed')).toEqual({ apply: false, reason: 'not_failable' });
  });

  it('failed is terminal: nothing resurrects it', () => {
    expect(resolveDeliveryTransition('failed', 'sent')).toEqual({ apply: false, reason: 'already_terminal' });
    expect(resolveDeliveryTransition('failed', 'delivered')).toEqual({ apply: false, reason: 'already_terminal' });
  });
});

describe('Needs Reply recomputation after an async WhatsApp failure', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 10, n)).toISOString();
  const customer = (n: number) => ({ sender_type: 'contact', body: 'سلام', created_at: at(n) });
  const agent = (n: number, metadata: any) => ({ sender_type: 'agent', body: 'پاسخ', created_at: at(n), metadata });

  it("accepted ('sent') answers, then async failure restores the obligation", () => {
    const accepted = [customer(0), agent(5, { channel_delivery: 'sent' })];
    expect(computeNeedsReply({ status: 'open', messages: accepted })).toBe(false);
    const failed = [customer(0), agent(5, { channel_delivery: 'failed', channel_delivery_source: 'provider_status' })];
    expect(computeNeedsReply({ status: 'open', messages: failed })).toBe(true);
  });

  it('delivered and read still count as answers', () => {
    for (const s of ['delivered', 'read']) {
      expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(5, { channel_delivery: s })] })).toBe(false);
    }
  });

  it('A1 async-failed + A2 delivered → answered', () => {
    const msgs = [customer(0), agent(5, { channel_delivery: 'failed' }), agent(9, { channel_delivery: 'delivered' })];
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(false);
  });

  it('A1 delivered + A2 failed → still answered (failure creates no obligation)', () => {
    const msgs = [customer(0), agent(5, { channel_delivery: 'delivered' }), agent(9, { channel_delivery: 'failed' })];
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(false);
  });
});

describe('wiring guarantees (source-level)', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

  it('statuses are handled on their own path, not via process-inbound', () => {
    const route = read('server/routes/internalChannels.ts');
    expect(route).toContain('extractWhatsAppDeliveryStatuses');
    expect(route).toContain('applyProviderDeliveryStatuses');
    // The delivery-status branch must not enqueue an inbound job for statuses.
    expect(route.indexOf('applyProviderDeliveryStatuses')).toBeLessThan(route.indexOf("jobType: botJobType(parsed.data.provider, 'inbound_event')"));
  });

  it('correlation is by provider message id only — no conversation guessing', () => {
    const svc = read('server/services/channels/deliveryStatus.ts');
    expect(svc).toContain("'metadata->>channel_message_id'");
    expect(svc).not.toMatch(/order\('created_at'/);
    // Receipts never touch operator unread state.
    expect(svc).not.toMatch(/unread_count|markRead|clearUnread/);
  });

  it('only a terminal failure emits a realtime invalidation', () => {
    const svc = read('server/services/channels/deliveryStatus.ts');
    expect(svc.lastIndexOf('publishOperatorEvent')).toBeGreaterThan(
      svc.indexOf('if (transition.terminalFailure)'),
    );
    expect(svc).toContain("reason: 'outbound_delivery_failed'");
    expect(svc.match(/publishOperatorEvent/g)?.length).toBe(2); // import + single call
  });

  it('worker retry-exhaustion reporting is preserved', () => {
    const worker = read('worker/channels/index.ts');
    expect(worker).toContain("outbound-result");
    expect(worker).toMatch(/reportOutbound\([^)]*'failed'/s);
  });

  it('Telegram/Bale/Instagram keep synchronous send semantics', () => {
    const api = read('worker/channels/botApi.ts');
    expect(api).toContain('sendMessage: telegram.sendMessage');
    // No status-webhook translation exists for the telegram dialect.
    expect(fs.existsSync(path.join(process.cwd(), 'server/services/channels/telegram/deliveryStatus.ts'))).toBe(false);
  });
});
