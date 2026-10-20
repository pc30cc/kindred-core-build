/**
 * The panel module is not a page-load file (owner decision 2, contract §2.3):
 * the core asks for it, and for its stylesheet, on the visitor's first
 * intent, opens the panel only once both are in (no unstyled frame), and
 * when either fails puts the visitor's open back and tries again on the next
 * intent. A page whose loader has no hook (an old l.js, the operator
 * preview without the module) keeps a working launcher and throws nothing.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeCallWidgets, flush, mountCallWidget, widgetSource, type Mounted } from './mountCallWidget';

afterEach(() => closeCallWidgets());

const links = (m: Mounted) => m.qa<HTMLLinkElement>('link').map((l) => l.getAttribute('href'));
type Hook = (cb: (ok: boolean) => void) => void;
/** A loader hook that "downloads" the module when the test says so. */
function hook(m: () => Mounted) {
  const calls: Array<(ok: boolean) => void> = [];
  const fn: Hook = vi.fn((cb) => { calls.push(cb); });
  return {
    fn,
    calls,
    deliver(ok = true) {
      if (ok) m().win.eval(widgetSource('presentation-default-panel.js'));
      calls.splice(0).forEach((cb) => cb(ok));
    },
  };
}

describe('the panel module loads on intent', () => {
  it('a page view loads none of it: no module request, no panel stylesheet, no panel content', () => {
    const h = hook(() => m);
    const m = mountCallWidget({ panel: false, loadPanel: h.fn });
    expect(h.fn).not.toHaveBeenCalled();
    expect(links(m)).toEqual(['https://app.example/call-widget/runtime.css?v=abc123', 'https://app.example/call-widget/presentation-default.css?v=abc123']);
    expect(m.q('.ccw-panel .scr')).toBeNull();
    expect((m.win as unknown as { __ccw_panel?: unknown }).__ccw_panel).toBeUndefined();
  });

  it('the first hover asks once, with the stylesheet between runtime.css and the skin', () => {
    const h = hook(() => m);
    const m = mountCallWidget({ panel: false, loadPanel: h.fn });
    const wrap = m.q('.ccw-launcher-wrap')!;
    wrap.dispatchEvent(new m.win.Event('pointerenter'));
    wrap.dispatchEvent(new m.win.Event('focusin'));
    wrap.dispatchEvent(new m.win.Event('pointerdown'));
    expect(h.fn).toHaveBeenCalledTimes(1);
    expect(links(m)).toEqual([
      'https://app.example/call-widget/runtime.css?v=abc123',
      'https://app.example/call-widget/presentation-default-panel.css?v=abc123',
      'https://app.example/call-widget/presentation-default.css?v=abc123',
    ]);
  });

  it('the panel stylesheet by the build\'s hashed name, once by its fixed name when that fails', () => {
    const assetUrl = (p: string) => `https://app.example/call-widget/${p.split('/').pop()!.replace(/\.(css|js)$/, '.0123456789ab.$1')}`;
    const m = mountCallWidget({ mountExtra: { assetUrl } });
    m.q('.ccw-launcher-wrap')!.dispatchEvent(new m.win.Event('pointerenter'));
    const link = m.qa<HTMLLinkElement & { onerror: () => void }>('link')[1];
    expect(link.getAttribute('href')).toBe('https://app.example/call-widget/presentation-default-panel.0123456789ab.css');
    link.onerror();
    expect(link.getAttribute('href')).toBe('https://app.example/call-widget/presentation-default-panel.css?v=abc123');
  });

  it('the bootstrap may name the panel stylesheet; a 6f8af41 bootstrap uses the fixed path', () => {
    const named = mountCallWidget({ bootstrap: { assets: { presentation_panel_style_url: '/call-widget/presentation-other-panel.css' } } });
    named.q('.ccw-launcher-wrap')!.dispatchEvent(new named.win.Event('pointerenter'));
    expect(links(named)[1]).toBe('https://app.example/call-widget/presentation-other-panel.css?v=abc123');
    const old = mountCallWidget({ legacy: true });
    old.q('.ccw-launcher-wrap')!.dispatchEvent(new old.win.Event('pointerenter'));
    expect(links(old)[1]).toBe('https://app.example/call-widget/presentation-default-panel.css?v=abc123');
  });

  it('opens only when both are in: the launcher stays, busy, until then', async () => {
    const h = hook(() => m);
    const m = mountCallWidget({ panel: false, loadPanel: h.fn });
    m.click('.ccw-launcher-btn');
    expect(m.ctrl.open).toBe(true);
    expect(m.root.classList.contains('ccw-is-open')).toBe(false);
    expect(m.q('.ccw-launcher-btn')!.getAttribute('aria-busy')).toBe('true');
    expect(m.q('#ccw-panel')!.hasAttribute('inert')).toBe(true);
    h.deliver();
    // The module is in: its screens are built (tests and the harness read them without CSS)…
    expect(m.screenId()).toBe('home');
    expect(m.root.classList.contains('ccw-is-open')).toBe(false);
    // …and the stylesheet's load opens the panel.
    m.loadLinks();
    await flush();
    expect(m.root.classList.contains('ccw-is-open')).toBe(true);
    expect(m.q('#ccw-panel')!.hasAttribute('inert')).toBe(false);
    expect(m.q('.ccw-launcher-btn')!.hasAttribute('aria-busy')).toBe(false);
    expect(m.q('.ccw-launcher-btn')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('a module that does not come: the open is put back, and the next intent asks again', async () => {
    const h = hook(() => m);
    const m = mountCallWidget({ panel: false, loadPanel: h.fn });
    m.click('.ccw-launcher-btn');
    h.deliver(false);
    await flush();
    expect(m.ctrl.open).toBe(false);
    expect(m.q('.ccw-launcher-btn')!.hasAttribute('aria-busy')).toBe(false);
    m.q('.ccw-launcher-wrap')!.dispatchEvent(new m.win.Event('pointerenter'));
    expect(h.fn).toHaveBeenCalledTimes(2);
    h.deliver();
    m.click('.ccw-launcher-btn');
    m.loadLinks();
    await flush();
    expect(m.root.classList.contains('ccw-is-open')).toBe(true);
  });

  it('a stylesheet that fails twice: the open is put back; the next intent links a new one', async () => {
    const m = mountCallWidget({ mountExtra: { assetUrl: (p: string) => `https://app.example/call-widget/${p.split('/').pop()}?hashed` } });
    m.click('.ccw-launcher-btn');
    const link = m.qa<HTMLLinkElement & { onerror: () => void }>('link')[1];
    link.onerror();
    link.onerror();
    await flush();
    expect(m.ctrl.open).toBe(false);
    expect(link.isConnected).toBe(true);
    m.q('.ccw-launcher-wrap')!.dispatchEvent(new m.win.Event('pointerenter'));
    expect(link.isConnected).toBe(false);
    const again = m.qa<HTMLLinkElement>('link')[1];
    expect(again).not.toBe(link);
    expect(again.getAttribute('href')).toContain('presentation-default-panel.css');
  });

  it('another deploy\'s module (another contract version) is refused, never half-applied', async () => {
    const h = hook(() => m);
    const m = mountCallWidget({ panel: false, loadPanel: h.fn });
    m.click('.ccw-launcher-btn');
    const create = vi.fn(() => ({ render() {} }));
    (m.win as unknown as { __ccw_panel: unknown }).__ccw_panel = { v: 2, create };
    h.calls.splice(0).forEach((cb) => cb(true));
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect((m.win as unknown as { __ccw_panel?: unknown }).__ccw_panel).toBeUndefined();
    expect(m.ctrl.open).toBe(false);
    expect(m.q('.ccw-panel .scr')).toBeNull();
  });

  it('an old loader (no hook) and no module on the page: the launcher keeps working, nothing throws', async () => {
    const errors: unknown[] = [];
    const m = mountCallWidget({ panel: false });
    m.win.addEventListener('error', (e) => errors.push(e));
    expect(() => m.click('.ccw-launcher-btn')).not.toThrow();
    await flush();
    expect(m.ctrl.open).toBe(false);
    expect(m.root.classList.contains('ccw-is-open')).toBe(false);
    expect(m.q('.ccw-launcher-btn')!.hasAttribute('aria-busy')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('a call being restored asks for the panel at mount and opens it without moving focus', async () => {
    const h = hook(() => m);
    const m = mountCallWidget({
      panel: false,
      loadPanel: h.fn,
      bootstrap: { active_call: { call_id: 'c1', state: 'queued', call_type: 'audio', created_at: '2026-10-22T07:30:00Z', queue_position: 2 } },
    });
    expect(h.fn).toHaveBeenCalledTimes(1);
    expect(m.ctrl.open).toBe(true);
    h.deliver();
    m.loadLinks();
    await flush();
    expect(m.root.classList.contains('ccw-is-open')).toBe(true);
    expect(m.screenId()).toBe('queue');
    expect(m.shadow.activeElement).toBeNull();
  });

  it('a call being restored shows no minimised bar before the panel stylesheet (its only styles): the launcher stays, busy', async () => {
    const h = hook(() => m);
    const m = mountCallWidget({
      panel: false,
      loadPanel: h.fn,
      bootstrap: { active_call: { call_id: 'c1', state: 'queued', call_type: 'audio', created_at: '2026-10-22T07:30:00Z', queue_position: 2 } },
    });
    h.deliver();
    await flush();
    expect(m.q('.ccw-launcher-wrap .mc, .ccw-launcher-wrap .mvid')).toBeNull();
    expect(m.q('.ccw-launcher-btn')!.getAttribute('aria-busy')).toBe('true');
    m.loadLinks();
    await flush();
    expect(m.root.classList.contains('ccw-is-open')).toBe(true);
    expect(m.screenId()).toBe('queue');
  });

  it('a closed panel shows the minimised bar only once the panel stylesheet is in', async () => {
    const m = mountCallWidget();
    // Intent: the module is created, its stylesheet still on the way.
    m.q('.ccw-launcher-wrap')!.dispatchEvent(new m.win.Event('pointerenter'));
    m.set({ state: 'queue_waiting', queuePosition: 3, queueStartedAt: 0 });
    expect(m.ctrl.open).toBe(false);
    expect(m.q('.ccw-launcher-wrap .mc')).toBeNull();
    expect(m.q('.ccw-launcher-btn')).not.toBeNull();
    m.loadLinks();
    await flush();
    expect(m.q('.ccw-launcher-wrap .mc')).not.toBeNull();
  });

  it('a visitor\'s open moves focus into the panel; closing returns it to the launcher', async () => {
    const m = mountCallWidget();
    (m.q('.ccw-launcher-btn') as HTMLButtonElement).focus();
    m.open();
    await flush();
    expect(m.shadow.activeElement).toBe(m.q('#ccw-panel'));
    m.click('[data-action="minimize"]');
    expect(m.root.classList.contains('ccw-is-open')).toBe(false);
    expect(m.shadow.activeElement).toBe(m.q('.ccw-launcher-btn'));
    expect(m.q('#ccw-panel')!.hasAttribute('inert')).toBe(true);
  });

  it('Escape collapses the open panel', async () => {
    const m = mountCallWidget();
    m.open();
    await flush();
    m.q('#ccw-panel')!.dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(m.ctrl.open).toBe(false);
  });
});
