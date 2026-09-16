import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Contract guard for the chat auto-scroll mechanism.
 *
 * The behaviour itself is proven in a real browser
 * (e2e/widgetChatScroll.spec.ts) because jsdom has no layout — `scrollHeight`
 * is always 0 and there is no ResizeObserver. These assertions exist so the
 * mechanism cannot be deleted or quietly reverted in a run that never opens
 * a browser.
 */
const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');

describe('the newest message stays pinned however late content settles', () => {
  it('watches the message content box instead of trusting fixed timers', () => {
    expect(runtime).toContain('function observeChatContent(host)');
    expect(runtime).toContain("typeof ResizeObserver !== 'function'");
    // `.messages` is the single wrapper whose height IS the content height.
    expect(runtime).toContain("host.querySelector('.messages')");
  });

  it('only re-pins while the visitor is still following the thread', () => {
    const idx = runtime.indexOf('chatPinObserver = new ResizeObserver');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 260);
    expect(body).toContain('if (!chatStickToBottom || !chatPinHost) return;');
  });

  it('re-observes on every repaint, since the wrapper is a new node each time', () => {
    const idx = runtime.indexOf('function observeChatContent(host)');
    const body = runtime.slice(idx, idx + 900);
    expect(body).toContain('chatPinObserver.disconnect()');
    expect(body).toContain('chatPinObserver.observe(content)');
    // Armed from the same place the list is wired up after a paint.
    expect(runtime).toMatch(/bindChatScrollTracking\(body\);\s*\n\s*observeChatContent\(body\);/);
  });

  it('re-pins when an authenticated image finishes loading', () => {
    // The blob arrives long after the timer cascade and grows the bubble.
    const idx = runtime.indexOf('var clearLoading = function ()');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 420);
    expect(body).toContain('chatScrollToBottom(body)');
  });

  it('re-arms the anchor when the visitor lands on a different thread', () => {
    expect(runtime).toContain('function resetScrollAnchor()');
    expect(runtime).toContain('resetScrollAnchor: resetScrollAnchor');
    // Both context changes: opening an existing thread and starting a new one.
    expect(runtime).toContain('try { chatUI.resetScrollAnchor(); } catch (_) {}');
    const idx = runtime.indexOf("ConvEpoch.bump('start_new_conversation'");
    expect(runtime.slice(idx, idx + 400)).toContain('resetScrollAnchor();');
  });

  it('a forced scroll re-arms following, rather than being a one-off nudge', () => {
    const idx = runtime.indexOf('function chatScrollToBottom(body, force, immediateOnly)');
    const body = runtime.slice(idx, idx + 300);
    expect(body).toContain('if (force) chatStickToBottom = true;');
  });
});
