import { afterEach, describe, expect, it } from 'vitest';
import { closeCallWidgets, mountCallWidget } from './callWidget/mountCallWidget';

afterEach(() => closeCallWidgets());

function mount(config: Record<string, unknown>, online = true) {
  return mountCallWidget({
    locale: 'en',
    bootstrap: {
      config: { pre_call_form_enabled: true, ...config },
      capabilities: { voice: online, video: false, callback: true },
    },
  });
}

describe('Call Widget runtime/presentation integration', () => {
  it('mounts the default presentation and applies allowlisted theme tokens', () => {
    const { root } = mount({ widget_theme: { primary: '#ff0000', radius: 'lg', density: 'compact' } });
    expect(root.classList.contains('ccw-presentation-default')).toBe(true);
    expect(root.style.getPropertyValue('--ccw-primary')).toBe('0 100% 50%');
    expect(root.style.getPropertyValue('--a')).toBe('#ff0000');
    expect(root.dataset.radius).toBe('lg');
    expect(root.dataset.density).toBe('compact');
  });

  /**
   * The widget mounts collapsed: a launcher, and a panel whose screens are
   * drawn only once the visitor shows intent (the panel module is lazy).
   * `hide` leaves the wrap in the DOM and hides it, so presence alone is not
   * the question — visibility is.
   */
  it.each([
    ['hide', false, false],
    ['show_message', true, false],
    ['show_callback', true, true],
  ])('enforces offline behavior %s', (behavior, launcher, callback) => {
    const m = mount({ offline_behavior: behavior }, false);
    const wrap = m.q('.ccw-launcher-wrap') as HTMLElement;
    expect(!wrap.hidden).toBe(launcher);
    if (launcher) m.open();
    else m.ctrl.toggleOpen();
    expect(!!m.q('[data-screen="offline"] [data-action="callback"]')).toBe(callback);
  });

  it('the launcher is what reveals the panel — a fresh mount draws no screen', () => {
    const m = mount({});
    expect(m.q('[data-action="voice"]')).toBeNull();
    expect(m.q('#ccw-panel')!.hasAttribute('inert')).toBe(true);
    m.open();
    expect(m.q('[data-action="voice"]')).not.toBeNull();
  });

  it('uses the authoritative pre-call schema', () => {
    const m = mount({
      pre_call_form_schema: [{ id: 'account_id', type: 'text', label: 'Account ID', required: true }],
    });
    m.open();
    m.click('[data-action="voice"]');
    expect(m.screenId()).toBe('precall');
    expect(m.screen()!.textContent).toContain('Account ID');
    expect(m.screen()!.textContent).not.toContain('Full name');
  });
});
