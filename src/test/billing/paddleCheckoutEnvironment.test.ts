/**
 * Paddle.js environment on the payment page (src/lib/paddleCheckout.ts): the
 * sandbox gateway always opens in Paddle's sandbox (its `test_` token is
 * refused by the live environment); live `paddle` in production. A page
 * that opens one and then the other loads Paddle.js again, since it can be
 * initialised (and its environment set) only once per loaded script.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPaddleClientCheckout, openPaddleCheckout, paddleEnvironmentOf } from '@/lib/paddleCheckout';

function fakePaddle() {
  return {
    Environment: { set: vi.fn() },
    Initialize: vi.fn(),
    Update: vi.fn(),
    Checkout: { open: vi.fn(), close: vi.fn() },
  };
}

afterEach(() => {
  delete (window as { Paddle?: unknown }).Paddle;
});

describe('paddleEnvironmentOf', () => {
  it('the sandbox gateway is always the sandbox, even without an environment', () => {
    expect(paddleEnvironmentOf({ provider: 'paddle_sandbox' })).toBe('sandbox');
    expect(paddleEnvironmentOf({ provider: 'paddle_sandbox', environment: 'production' })).toBe('sandbox');
  });

  it('live paddle follows the server', () => {
    expect(paddleEnvironmentOf({ provider: 'paddle', environment: 'production' })).toBe('production');
    expect(paddleEnvironmentOf({ provider: 'paddle' })).toBe('production');
    expect(paddleEnvironmentOf({ provider: 'paddle', environment: 'sandbox' })).toBe('sandbox');
  });

  it('both are opened with Paddle.js on the page; other gateways redirect', () => {
    expect(isPaddleClientCheckout({ provider: 'paddle' })).toBe(true);
    expect(isPaddleClientCheckout({ provider: 'paddle_sandbox' })).toBe(true);
    expect(isPaddleClientCheckout({ provider: 'stripe' })).toBe(false);
    expect(isPaddleClientCheckout(undefined)).toBe(false);
  });
});

describe('openPaddleCheckout', () => {
  it('sets the sandbox environment before Initialize for the sandbox gateway', async () => {
    const paddle = fakePaddle();
    (window as { Paddle?: unknown }).Paddle = paddle;
    await openPaddleCheckout({
      provider: 'paddle_sandbox',
      transactionId: 'txn_sbx',
      clientToken: 'test_token_a',
      successUrl: 'https://app.test/pay?_ptxn=txn_sbx',
    });
    expect(paddle.Environment.set).toHaveBeenCalledWith('sandbox');
    expect(paddle.Environment.set.mock.invocationCallOrder[0]).toBeLessThan(paddle.Initialize.mock.invocationCallOrder[0]);
    expect(paddle.Initialize).toHaveBeenCalledWith(expect.objectContaining({ token: 'test_token_a' }));
    expect(paddle.Checkout.open).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'txn_sbx' }));
  });

  it('leaves the live environment alone for live paddle', async () => {
    const paddle = fakePaddle();
    (window as { Paddle?: unknown }).Paddle = paddle;
    await openPaddleCheckout({
      provider: 'paddle',
      environment: 'production',
      transactionId: 'txn_live',
      clientToken: 'live_token_b',
      successUrl: 'https://app.test/pay?_ptxn=txn_live',
    });
    expect(paddle.Environment.set).not.toHaveBeenCalled();
    expect(paddle.Initialize).toHaveBeenCalledWith(expect.objectContaining({ token: 'live_token_b' }));
  });
});

describe('switching between the sandbox and live in one page', () => {
  it('a live checkout after a sandbox one loads Paddle.js again and initialises it in production', async () => {
    const first = fakePaddle();
    (window as { Paddle?: unknown }).Paddle = first;
    await openPaddleCheckout({ provider: 'paddle_sandbox', transactionId: 'txn_s', clientToken: 'test_switch', successUrl: 'https://app.test/s' });
    expect(first.Environment.set).toHaveBeenCalledWith('sandbox');

    // The fresh script defines a new window.Paddle when it loads.
    const second = fakePaddle();
    const append = vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
      (window as { Paddle?: unknown }).Paddle = second;
      queueMicrotask(() => (node as HTMLScriptElement).onload?.(new Event('load')));
      return node;
    });
    let appended = 0;
    try {
      await openPaddleCheckout({ provider: 'paddle', environment: 'production', transactionId: 'txn_l', clientToken: 'live_switch', successUrl: 'https://app.test/l' });
      appended = append.mock.calls.length;
    } finally {
      append.mockRestore();
    }
    expect(appended).toBe(1);
    expect(first.Initialize).toHaveBeenCalledTimes(1);
    expect(first.Checkout.open).toHaveBeenCalledTimes(1);
    expect(second.Environment.set).not.toHaveBeenCalled();
    expect(second.Initialize).toHaveBeenCalledWith(expect.objectContaining({ token: 'live_switch' }));
    expect(second.Checkout.open).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'txn_l' }));
  });

  it('the same token and environment again reuses the loaded Paddle.js (Update, no reload)', async () => {
    const paddle = fakePaddle();
    (window as { Paddle?: unknown }).Paddle = paddle;
    const append = vi.spyOn(document.head, 'appendChild');
    let appended = -1;
    try {
      await openPaddleCheckout({ provider: 'paddle', environment: 'production', transactionId: 'txn_1', clientToken: 'live_same', successUrl: 'https://app.test/1' });
      await openPaddleCheckout({ provider: 'paddle', environment: 'production', transactionId: 'txn_2', clientToken: 'live_same', successUrl: 'https://app.test/2' });
      appended = append.mock.calls.length;
    } finally {
      append.mockRestore();
    }
    expect(appended).toBe(0);
    expect(paddle.Initialize).toHaveBeenCalledTimes(1);
    expect(paddle.Update).toHaveBeenCalledTimes(1);
    expect(paddle.Checkout.open).toHaveBeenCalledTimes(2);
  });
});

