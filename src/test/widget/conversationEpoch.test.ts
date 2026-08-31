/**
 * P0-5 — BEHAVIORAL tests for the canonical conversation epoch.
 *
 * These do not grep the source: they execute the shipped
 * `public/widget/runtime.js` in a sandbox and drive the real ConvEpoch
 * object the browser gets (`window.__gs_conv_epoch`), asserting the
 * stale-response rules that the regex tests could only approximate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const source = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');

interface Epoch {
  get(): number;
  valid(captured: number): boolean;
  activeId(): string | null;
  isFresh(): boolean;
  snapshot(): { epoch: number; activeId: string | null; fresh: boolean };
  bump(reason: string, opts?: { conversationId?: string | null; fresh?: boolean }): number;
  adopt(cid: string | null): void;
  ownsFrame(cid: string | null | undefined): boolean;
}

/** Boot the runtime IIFE far enough to publish window.__gs_conv_epoch. */
function loadEpoch(): Epoch {
  const win: any = {};
  win.window = win;
  win.document = { addEventListener() {}, readyState: 'complete' };
  win.navigator = { userAgent: 'node' };
  win.location = { href: 'http://localhost/', origin: 'http://localhost' };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.setInterval = () => 0;
  win.clearInterval = () => {};
  win.fetch = () => Promise.reject(new Error('no network in test'));
  win.console = console;
  const ctx = vm.createContext(win);
  try {
    vm.runInContext(source, ctx);
  } catch {
    // The runtime keeps initializing well past the epoch publication; a
    // later DOM-dependent step throwing is fine for this unit.
  }
  const epoch = ctx.__gs_conv_epoch as Epoch | undefined;
  if (!epoch) throw new Error('runtime did not publish window.__gs_conv_epoch');
  return epoch;
}

describe('ConvEpoch — canonical conversation epoch (P0-1)', () => {
  let epoch: Epoch;
  beforeEach(() => { epoch = loadEpoch(); });

  it('is monotonic: every bump invalidates all previously captured epochs', () => {
    const captured = epoch.get();
    expect(epoch.valid(captured)).toBe(true);
    epoch.bump('start-new', { fresh: true });
    expect(epoch.valid(captured)).toBe(false);
    const second = epoch.get();
    expect(second).toBeGreaterThan(captured);
    epoch.bump('open-other', { conversationId: 'conv-b' });
    expect(epoch.valid(second)).toBe(false);
    expect(epoch.get()).toBeGreaterThan(second);
  });

  it('P0-2/3 — a response captured before "start new" is stale afterwards', () => {
    // Old thread A is active, an async intro/history request starts...
    epoch.bump('open', { conversationId: 'conv-a' });
    const inFlight = epoch.get();
    // ...the visitor hits "Start new conversation" while it is in flight...
    epoch.bump('start-new', { fresh: true });
    // ...and the late response must be refused.
    expect(epoch.valid(inFlight)).toBe(false);
    expect(epoch.activeId()).toBeNull();
    expect(epoch.isFresh()).toBe(true);
  });

  it('P0-3 — selecting B while A history is in flight keeps B active', () => {
    epoch.bump('open-a', { conversationId: 'conv-a' });
    const aRequest = epoch.get();
    epoch.bump('open-b', { conversationId: 'conv-b' });
    expect(epoch.valid(aRequest)).toBe(false); // A's late history is dropped
    expect(epoch.activeId()).toBe('conv-b');   // final active conversation is B
    expect(epoch.snapshot()).toMatchObject({ activeId: 'conv-b', fresh: false });
  });

  it('adopt() attaches a freshly created id and clears the fresh latch', () => {
    epoch.bump('start-new', { fresh: true });
    expect(epoch.isFresh()).toBe(true);
    epoch.adopt('conv-new');
    expect(epoch.isFresh()).toBe(false);
    expect(epoch.activeId()).toBe('conv-new');
  });

  it('P0-4 — ownsFrame rejects realtime frames from other conversations', () => {
    epoch.bump('open-a', { conversationId: 'conv-a' });
    expect(epoch.ownsFrame('conv-a')).toBe(true);
    expect(epoch.ownsFrame('conv-b')).toBe(false);
  });

  it('P0-4 — while a fresh intent is armed no server conversation owns the view', () => {
    epoch.bump('start-new', { fresh: true });
    expect(epoch.ownsFrame('conv-a')).toBe(false);
    expect(epoch.ownsFrame(null)).toBe(false);
  });

  it('untargeted frames are accepted when a conversation is active (unread/call scans)', () => {
    epoch.bump('open-a', { conversationId: 'conv-a' });
    expect(epoch.ownsFrame(null)).toBe(true);
    expect(epoch.ownsFrame(undefined)).toBe(true);
  });
});
