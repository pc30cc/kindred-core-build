/**
 * Paddle.js environment on the payment page (src/lib/paddleCheckout.ts): the
 * sandbox gateway always opens in Paddle's sandbox (its `test_` token is
 * refused by the live environment); live `paddle` only when the server says
 * its Sandbox Mode is on.
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
