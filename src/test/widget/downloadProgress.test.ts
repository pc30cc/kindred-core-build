/**
 * A download's progress (issue #340, g5-2b), with the SHIPPED runtime.js,
 * runtime-ext.js, runtime-late.js and the real t1 / t2 renderers and extras
 * (coreFeaturesHarness.ts):
 *
 *  - Core hands an attachment's response to the template's Core before
 *    reading it (runtime.js hook `media`); with a length (its header, else
 *    the size the message says) the bytes are read as they come and the
 *    attachment's control carries `.dl-on`, `--dl` (0..1) and aria-busy
 *    meanwhile (its voice note: the player), then the blob goes back to
 *    Core's cache as before (the download link works, a second press reads
 *    nothing again);
 *  - without a length or a readable body: Core reads it whole, as before;
 *  - a transfer that fails halfway: nothing marked, the cache entry gone (a
 *    retry asks again);
 *  - `default` reads every response itself (the hook answers nothing).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, click, flush, resetWindow, type ApiAnswer } from './coreFeaturesHarness';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** The files Core saved for the visitor (its hidden anchor's click). */
let saved: Array<{ href: string; download: string }> = [];
beforeEach(() => {
  vi.useRealTimers();
  resetWindow();
  saved = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ href: this.getAttribute('href') || '', download: this.download });
  });
});
afterEach(() => { vi.restoreAllMocks(); });

/** A response whose body the test feeds chunk by chunk. */
function streamed(length: number | null, opts: { type?: string } = {}) {
  const queue: Array<{ resolve: (c: { done: boolean; value?: Uint8Array }) => void; reject: (e: unknown) => void }> = [];
  let reads = 0;
  let blobs = 0;
  const reader = {
    read: () => new Promise<{ done: boolean; value?: Uint8Array }>((res, rej) => { reads++; queue.push({ resolve: res, reject: rej }); }),
  };
  const res = {
    ok: true, status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? (length == null ? null : String(length)) : k.toLowerCase() === 'content-type' ? (opts.type || 'application/pdf') : null) },
    body: { getReader: () => reader },
    blob: () => { blobs++; return Promise.resolve(new Blob(['whole'])); },
    clone() { return res; },
    json: () => Promise.resolve({}),
  };
  return {
    res,
    get reads() { return reads; },
    get blobs() { return blobs; },
    chunk: async (n: number) => { while (!queue.length) await flush(1); queue.shift()!.resolve({ done: false, value: new Uint8Array(n) }); await flush(3); },
    end: async () => { while (!queue.length) await flush(1); queue.shift()!.resolve({ done: true }); await flush(5); },
    fail: async () => { while (!queue.length) await flush(1); queue.shift()!.reject(new Error('reset')); await flush(5); },
  };
}
const FILE = { id: 'att-pdf', kind: 'file', mime_type: 'application/pdf', file_name: 'فاکتور.pdf', size_bytes: 300 };
const VOICE = { id: 'att-voice', kind: 'audio', mime_type: 'audio/webm', file_name: 'voice.webm', size_bytes: 300 };
const row = (attachment: Record<string, unknown>) => ({ id: 'm-' + attachment.id, role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: '', time: new Date().toISOString(), attachment });

function start(renderer: 't1' | 't2' | 'default', attachment: Record<string, unknown>, answer: () => ApiAnswer) {
  if (renderer !== 'default') {
    new Function(read(`public/widget/presentation-${renderer}-x.js`)).call(window);
    new Function(read('public/widget/runtime-late.js')).call(window);
  }
  const url = URL as unknown as Record<string, unknown>;
  url.createObjectURL = () => 'blob:att';
  url.revokeObjectURL = () => {};
  return boot({
    renderer,
    hint: { tab: 'chat', conversationId: 'c1' },
    conversations: [{ id: 'c1' }],
    history: { c1: [row(attachment)] },
    api: (u) => (u.includes('/api/widget/attachments/' + attachment.id) ? answer() : undefined),
  });
}
const host = (h: ReturnType<typeof boot>, sel: string) => h.q<HTMLElement>('[data-chat-messages] ' + sel)!;
const attFetches = (h: ReturnType<typeof boot>, id: string) => h.fetches.filter((u) => u.includes('/api/widget/attachments/' + id));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe.each(['t1', 't2'] as const)('%s: a file', (tpl) => {
  it('marks its download control while the bytes come, then hands Core the blob it caches', async () => {
    const s = streamed(300);
    const h = start(tpl, FILE, () => ({ raw: s.res }));
    await flush(40);
    const link = () => host(h, '[data-att-download="att-pdf"]');
    click(link());
    await flush(5);
    expect(attFetches(h, 'att-pdf')).toHaveLength(1);
    await s.chunk(100);
    await frame();
    expect(link().classList.contains('dl-on')).toBe(true);
    expect(link().style.getPropertyValue('--dl')).toBe('0.333');
    expect(link().getAttribute('aria-busy')).toBe('true');
    await s.chunk(100);
    await frame();
    expect(link().style.getPropertyValue('--dl')).toBe('0.667');
    await s.chunk(100);
    await frame();
    expect(link().style.getPropertyValue('--dl')).toBe('1.000');
    await s.end();
    expect(link().classList.contains('dl-on')).toBe(false);
    expect(link().hasAttribute('aria-busy')).toBe(false);
    expect(link().style.getPropertyValue('--dl')).toBe('');
    expect(link().classList.contains('downloading')).toBe(false);
    expect(s.blobs).toBe(0);
    // The file is saved as before.
    expect(saved).toEqual([{ href: 'blob:att', download: 'فاکتور.pdf' }]);
    // Cached: a second press reads nothing again.
    click(link());
    await flush(5);
    expect(attFetches(h, 'att-pdf')).toHaveLength(1);
  });
});

describe('a voice note', () => {
  it('marks its player (the play button\'s arc) while it loads', async () => {
    const s = streamed(null, { type: 'audio/webm' });
    const h = start('t2', VOICE, () => ({ raw: s.res }));
    await flush(40);
    expect(attFetches(h, 'att-voice')).toHaveLength(1);
    await s.chunk(150);
    await frame();
    // No header: the size the message says.
    const player = host(h, '[data-audio-player]');
    expect(player.classList.contains('dl-on')).toBe(true);
    expect(player.style.getPropertyValue('--dl')).toBe('0.500');
    await s.chunk(150);
    await s.end();
    expect(player.classList.contains('dl-on')).toBe(false);
    expect(host(h, '[data-att-media-src="att-voice"]').getAttribute('src')).toBe('blob:att');
  });
});

describe('Core reads it whole, as before', () => {
  it('without a length (no header, no size) or without a readable body', async () => {
    const s = streamed(null);
    const h = start('t2', { ...FILE, size_bytes: 0 }, () => ({ raw: s.res }));
    await flush(40);
    click(host(h, '[data-att-download="att-pdf"]'));
    await flush(10);
    expect(s.reads).toBe(0);
    expect(s.blobs).toBe(1);
    expect(host(h, '[data-att-download="att-pdf"]').classList.contains('dl-on')).toBe(false);
  });

  it('for default, whose hook answers nothing', async () => {
    const s = streamed(300);
    const h = start('default', VOICE, () => ({ raw: s.res }));
    await flush(40);
    expect(attFetches(h, 'att-voice')).toHaveLength(1);
    expect(s.reads).toBe(0);
    expect(s.blobs).toBe(1);
  });
});

describe('a transfer that fails halfway', () => {
  it('unmarks the control and forgets it: a retry asks again', async () => {
    let s = streamed(300);
    const h = start('t2', FILE, () => ({ raw: s.res }));
    await flush(40);
    const link = () => host(h, '[data-att-download="att-pdf"]');
    click(link());
    await s.chunk(100);
    await frame();
    expect(link().classList.contains('dl-on')).toBe(true);
    await s.fail();
    expect(link().classList.contains('dl-on')).toBe(false);
    expect(link().classList.contains('downloading')).toBe(false);
    s = streamed(300);
    click(link());
    await flush(5);
    expect(attFetches(h, 'att-pdf')).toHaveLength(2);
  });
});
