/**
 * Paddle Billing checkout in the browser.
 *
 * Paddle Billing has no redirect checkout page of its own: a transaction the
 * server created (priced from the invoice) is opened by Paddle.js as an
 * overlay on this page. Paddle.js must come from Paddle's CDN (it cannot be
 * self-hosted) and runs only on domains approved in the Paddle dashboard.
 * Only public values reach this module: the client-side token and the
 * transaction id.
 *
 * When the payment completes the page goes to the server-provided return URL
 * (`…&_ptxn=<transaction id>`), whose verification asks Paddle about the
 * transaction server-to-server — nothing here decides that money arrived.
 */
import type { ClientCheckout } from '@/lib/billingApi';
import { PADDLE_SANDBOX_PROVIDER, isPaddleProvider } from '../../shared/testGateways';

declare global {
  interface Window {
    Paddle?: PaddleJs;
  }
}

interface PaddleEvent {
  name?: string;
}

interface PaddleJs {
  Environment: { set(env: string): void };
  Initialize(options: { token: string; eventCallback?: (event: PaddleEvent) => void }): void;
  Update(options: { eventCallback?: (event: PaddleEvent) => void }): void;
  Checkout: {
    open(options: Record<string, unknown>): void;
    close(): void;
  };
}

const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';

let inflight: Promise<PaddleJs> | null = null;
let initializedToken: string | null = null;

/** A checkout the payment page opens with Paddle.js: live `paddle` or `paddle_sandbox`. */
export function isPaddleClientCheckout(checkout: ClientCheckout | null | undefined): checkout is ClientCheckout {
  return Boolean(checkout && isPaddleProvider(checkout.provider));
}

/**
 * The Paddle.js environment for a checkout: the sandbox gateway always opens
 * in the sandbox (its token is a `test_` token, which the live environment
 * refuses), live `paddle` only when the server says its Sandbox Mode is on.
 */
export function paddleEnvironmentOf(checkout: Pick<ClientCheckout, 'provider' | 'environment'>): 'sandbox' | 'production' {
  return checkout.provider === PADDLE_SANDBOX_PROVIDER || checkout.environment === 'sandbox' ? 'sandbox' : 'production';
}

export function loadPaddle(): Promise<PaddleJs> {
  if (typeof window !== 'undefined' && window.Paddle) return Promise.resolve(window.Paddle);
  if (inflight) return inflight;
  inflight = new Promise<PaddleJs>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('paddle_js_load_failed'));
      return;
    }
    const script = document.createElement('script');
    script.src = PADDLE_JS_URL;
    script.async = true;
    script.dataset.paddleLoader = '1';
    script.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error('paddle_js_load_failed')));
    script.onerror = () => reject(new Error('paddle_js_load_failed'));
    document.head.appendChild(script);
  });
  inflight.catch(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Opens the overlay for a server-created transaction. Resolves once it is
 * open; `onClosed` fires when the customer closes it without paying. On
 * completion the browser is sent to `successUrl`.
 */
export async function openPaddleCheckout(
  checkout: ClientCheckout,
  opts: { locale?: string; onClosed?: () => void } = {},
): Promise<void> {
  if (!checkout.transactionId || !checkout.clientToken || !checkout.successUrl) {
    throw new Error('paddle_checkout_incomplete');
  }
  const Paddle = await loadPaddle();
  let completed = false;
  const eventCallback = (event: PaddleEvent) => {
    if (event?.name === 'checkout.completed') {
      completed = true;
      try {
        Paddle.Checkout.close();
      } catch {
        /* the overlay may already be gone */
      }
      window.location.assign(checkout.successUrl as string);
    } else if (event?.name === 'checkout.closed' && !completed) {
      opts.onClosed?.();
    }
  };

  if (initializedToken !== checkout.clientToken) {
    // Initialize may run once per page; the environment must be set before it.
    if (paddleEnvironmentOf(checkout) === 'sandbox') Paddle.Environment.set('sandbox');
    Paddle.Initialize({ token: checkout.clientToken, eventCallback });
    initializedToken = checkout.clientToken;
  } else {
    Paddle.Update({ eventCallback });
  }

  Paddle.Checkout.open({
    transactionId: checkout.transactionId,
    settings: { displayMode: 'overlay', ...(opts.locale ? { locale: opts.locale } : {}) },
    ...(checkout.customerEmail ? { customer: { email: checkout.customerEmail } } : {}),
  });
}
