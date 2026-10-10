/**
 * Test (sandbox) payment gateways: gateways that never move real money.
 *
 * Shared by the server (finance report, gateway listing, checkout) and the
 * client (payment page, finance report). Pure: no I/O.
 *
 * A payment made through one of these is recognised by its `provider_name`
 * (billing_payments / billing_payment_intents carry no separate test column);
 * Finance → Gateways' `is_test` marker is the operational flag the customer
 * sees ("Test gateway").
 */

/** Paddle Billing's sandbox (sandbox-api.paddle.com), its own gateway next to live `paddle`. */
export const PADDLE_SANDBOX_PROVIDER = 'paddle_sandbox';

/** Every gateway that only ever talks to a sandbox or simulator. */
export const TEST_PAYMENT_PROVIDERS = [
  'internal_test',
  'zarinpal_test',
  'idpay_test',
  'iranpardakht_sandbox',
  PADDLE_SANDBOX_PROVIDER,
] as const;

const TEST_SET = new Set<string>(TEST_PAYMENT_PROVIDERS);

function key(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

export function isTestPaymentProvider(name: unknown): boolean {
  return TEST_SET.has(key(name));
}

/**
 * Gateways that are a test gateway whatever Finance → Gateways says: their
 * `is_test` marker is always on, so the customer always sees that the
 * payment is a test. (The older Iranian test gateways keep the marker their
 * row was seeded with.)
 */
export function isAlwaysTestGateway(name: unknown): boolean {
  return key(name) === PADDLE_SANDBOX_PROVIDER;
}

/** Paddle Billing, live or sandbox: opened in the browser by Paddle.js. */
export function isPaddleProvider(name: unknown): boolean {
  const k = key(name);
  return k === 'paddle' || k === PADDLE_SANDBOX_PROVIDER;
}

/** Paddle's sandbox test cards (https://developer.paddle.com/concepts/payment-methods/credit-debit-card). */
export const PADDLE_SANDBOX_TEST_CARD = '4242 4242 4242 4242';
