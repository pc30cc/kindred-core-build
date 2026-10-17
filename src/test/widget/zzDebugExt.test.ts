/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, flush, resetWindow } from './coreFeaturesHarness';
beforeEach(() => { vi.useRealTimers(); resetWindow(); });
describe('dbg', () => {
  it('home', async () => {
    const h = boot({ renderer: (base) => ({ features: { conversationOperator: true } }), conversations: [{ id: 'c1', outbound: true, operatorName: 'x' }] });
    await flush(20);
    console.log('calls', h.calls.map((c) => c.surface).join(','));
    console.log('scripts', h.scripts.join(','));
    console.log('body', h.body.innerHTML.slice(0, 300));
    expect(1).toBe(1);
  });
});
