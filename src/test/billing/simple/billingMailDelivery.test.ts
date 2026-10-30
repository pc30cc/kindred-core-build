/**
 * How a billing mail is delivered (services/billing/account/notify.ts) and
 * who receives it:
 *
 *   - a mail about something that already happened is queued for the email
 *     outbox (sent within moments, retried on a provider's hiccup), and sent
 *     at once only when the queue cannot take it (before migration 289b);
 *   - its dedupe key names the event, or there is none: a key built from
 *     blanks would make two different events one mail;
 *   - the invoice email must be one plain address: saved as such
 *     (INVALID_INVOICE_EMAIL otherwise), and an older value that is not one
 *     (a comma list, a name with an "@") is passed over for the owner rather
 *     than failing every billing mail of the workspace.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  invoiceEmail: '' as unknown,
  enqueue: vi.fn(),
  send: vi.fn(),
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        limit: () => builder,
        update: (values: Record<string, unknown>) => {
          h.updates.push(values);
          return builder;
        },
        single: async () => ({ data: { workspace_id: WS, currency: 'USD', balance_minor: 0, billing_profile: h.updates.at(-1)?.billing_profile ?? {} }, error: null }),
        maybeSingle: async () => {
          if (table === 'workspaces') return { data: { name: 'Acme', owner_id: 'owner-1' }, error: null };
          if (table === 'profiles') return { data: { email: 'owner@example.org', preferred_locale: 'en' }, error: null };
          if (table === 'billing_accounts') {
            return { data: { workspace_id: WS, currency: 'USD', balance_minor: 0, billing_profile: { invoice_email: h.invoiceEmail } }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  }),
}));
vi.mock('../../../../server/services/email/outbox.js', () => ({ enqueueEmail: h.enqueue }));
vi.mock('../../../../server/services/email/index.js', () => ({
  sendEmail: h.send,
  resolveEmailScope: async () => ({ edition: 'international', locales: ['en'] }),
}));
vi.mock('../../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/platformRegion.js')>()),
  getPlatformEditionOrNull: async () => 'international',
}));
vi.mock('../../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async (_c: unknown, _ws: string, path: string) => `https://app.example.com/acme${path}`,
}));

const notify = await import('../../../../server/services/billing/account/notify.js');
const account = await import('../../../../server/services/billing/account/index.js');
const CONFIG = {} as never;

beforeEach(() => {
  h.invoiceEmail = '';
  h.enqueue.mockReset();
  h.send.mockReset();
  h.updates.length = 0;
});

describe('the dedupe key of a queued billing mail', () => {
  it('names the event, or is none when a part is missing', () => {
    expect(notify.billingMailKey('billing_payment_receipt', WS, 'ledger-1')).toBe(`billing_payment_receipt:${WS}:ledger-1`);
    expect(notify.billingMailKey('billing_renewed', WS, 'plan', undefined, '2026-11-01')).toBeUndefined();
    expect(notify.billingMailKey('billing_expired', WS, 'plan', ' ')).toBeUndefined();
    expect(notify.billingMailKey('billing_expired', '', 'plan')).toBeUndefined();
  });
});

describe('queued delivery', () => {
  it('a queued mail is in the outbox and is not sent here', async () => {
    h.enqueue.mockResolvedValue({ queued: true, id: 'row-1' });
    const result = await notify.sendBillingEmail(CONFIG, WS, 'billing_payment_receipt', () => ({ receipt_number: 'R-1' }), {
      receiptLedgerId: 'ledger-1', queue: true, dedupeKey: 'k-1',
    });
    expect(result).toEqual({ sent: false, queued: true });
    expect(h.send).not.toHaveBeenCalled();
    const [request, opts] = h.enqueue.mock.calls[0].slice(1);
    expect(request).toMatchObject({
      workspaceId: WS,
      to: 'owner@example.org',
      templateSlug: 'billing_payment_receipt',
      templateData: {
        workspace: 'Acme',
        receipt_number: 'R-1',
        billing_url: 'https://app.example.com/acme/billing',
        receipt_url: 'https://app.example.com/acme/billing/receipts/ledger-1',
      },
    });
    expect(opts).toEqual({ dedupeKey: 'k-1' });
  });

  it('when the queue cannot take it, the mail is sent here as before', async () => {
    h.enqueue.mockResolvedValue({ queued: false, error: 'outbox_unavailable' });
    h.send.mockResolvedValue({ success: true, provider: 'smtp' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await notify.sendBillingEmail(CONFIG, WS, 'billing_trial_ended', () => ({}), { queue: true })).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a notice that retries on its own is still one attempt here, never queued', async () => {
    h.send.mockResolvedValue({ success: false, provider: 'smtp', errorCode: 'timeout', permanent: false, error: 'timeout: x' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await notify.sendBillingEmail(CONFIG, WS, 'billing_renewal_reminder', () => ({}))).toEqual({ sent: false, error: 'timeout: x' });
    expect(h.enqueue).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the invoice email', () => {
  it('a plain address on the profile receives the billing mail', async () => {
    h.invoiceEmail = ' billing@acme.example ';
    expect((await notify.billingRecipient(CONFIG, WS))?.email).toBe('billing@acme.example');
  });

  it('an older value that is not one plain address is passed over for the owner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const value of ['a@acme.example, b@other.example', 'Billing <billing@acme.example>', 'not-an-address@']) {
      h.invoiceEmail = value;
      expect((await notify.billingRecipient(CONFIG, WS))?.email, value).toBe('owner@example.org');
    }
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('acme.example');
    warn.mockRestore();
  });

  it('is saved only as one plain address', async () => {
    await expect(account.updateBillingProfile(CONFIG, WS, { company: 'Acme', invoice_email: 'a@acme.example; b@other.example' }))
      .rejects.toMatchObject({ code: 'INVALID_INVOICE_EMAIL', status: 400 });
    expect(h.updates).toEqual([]);

    await account.updateBillingProfile(CONFIG, WS, { company: 'Acme', invoice_email: '  billing@acme.example ' });
    expect(h.updates.at(-1)?.billing_profile).toEqual({ company: 'Acme', invoice_email: 'billing@acme.example' });

    // Cleared is fine: the owner receives the mail.
    await account.updateBillingProfile(CONFIG, WS, { company: 'Acme', invoice_email: '' });
    expect(h.updates.at(-1)?.billing_profile).toEqual({ company: 'Acme' });
  });
});
