/**
 * Template 1's bottom menu label choice (src/components/app/widget/TemplateOptionsFields.tsx),
 * and the on/off options of issue #340 (Template 2's rating after a chat, the
 * transcript by email) with Template 1's pre-chat form.
 * Only the floating dock (`vb`) draws the label modes; the other bars keep
 * their own labels (presentation-t1.css scopes `.nv-both/.nv-icon/.nv-text`
 * to `.vb`), so with another style the field offers only what changes the
 * widget, says why, and shows a saved dock-only mode as what is drawn.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import { TemplateOptionsFields } from '@/components/app/widget/TemplateOptionsFields';
import type { ChatTemplateOptions } from '../../../shared/chatTemplateCatalog';

afterEach(cleanup);

async function mount(value: ChatTemplateOptions, inherited: ChatTemplateOptions = {}) {
  render(
    <I18nProvider initialLocale="en">
      <TemplateOptionsFields templateId="t1" value={value} inherited={inherited} onChange={() => {}} idPrefix="x" />
    </I18nProvider>,
  );
  await waitFor(() => expect(document.getElementById('x-nav-mode')).not.toBeNull());
  return {
    mode: () => document.getElementById('x-nav-mode')!.textContent,
    hint: () => document.querySelector('[data-nav-mode-hint]'),
  };
}

describe('TemplateOptionsFields: bottom menu labels', () => {
  it('the floating dock offers every label mode', async () => {
    const f = await mount({ navStyle: 'vb', navMode: 'text' });
    expect(f.mode()).toBe('Labels only');
    expect(f.hint()).toBeNull();
  });

  it('another style shows a dock-only mode as its own labels, and says the choices are the dock\'s', async () => {
    const f = await mount({ navMode: 'text' }, { navStyle: 'vc' });
    expect(f.mode()).toBe('As this style draws them');
    expect(f.hint()!.textContent).toBe('The other label choices are for the Floating dock style only.');
  });

  it('"No menu" still applies to every style', async () => {
    expect((await mount({ navStyle: 'va', navMode: 'none' })).mode()).toBe('No menu');
  });
});

describe('TemplateOptionsFields: the after-chat options and the pre-chat form', () => {
  async function render2(templateId: string, value: ChatTemplateOptions, inherited: ChatTemplateOptions = {}, allowReset = false) {
    const changes: ChatTemplateOptions[] = [];
    render(
      <I18nProvider initialLocale="en">
        <TemplateOptionsFields templateId={templateId} value={value} inherited={inherited} allowReset={allowReset} onChange={(v) => changes.push(v)} idPrefix="y" />
      </I18nProvider>,
    );
    await waitFor(() => expect(document.querySelector(`[data-tpl-options="${templateId}"]`)).not.toBeNull());
    return changes;
  }
  const toggle = (key: string) => document.querySelector(`[data-tpl-toggle="${key}"] [role="switch"]`) as HTMLButtonElement | null;

  it('Template 2: the rating and the transcript switches, on unless a level turned them off', async () => {
    const changes = await render2('t2', {}, { csat: false });
    expect(toggle('csat')!.getAttribute('aria-checked')).toBe('false');
    expect(toggle('transcriptEmail')!.getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).toContain('When an operator closes a conversation they answered, the visitor is asked to rate it.');
    expect(document.getElementById('y-prechat-mode')).toBeNull();
    fireEvent.click(toggle('csat')!);
    fireEvent.click(toggle('transcriptEmail')!);
    expect(changes).toEqual([{ csat: true }, { transcriptEmail: false }]);
  });

  it('Template 1: the transcript switch and the pre-chat form, no rating', async () => {
    await render2('t1', {});
    expect(toggle('csat')).toBeNull();
    expect(toggle('transcriptEmail')).not.toBeNull();
    expect(document.getElementById('y-prechat-mode')!.textContent).toBe('Every question on one card');
  });

  it('a value this level sets can be handed back to the level above', async () => {
    const changes = await render2('t2', { csat: false, transcriptEmail: true }, {}, true);
    const reset = document.querySelector('[data-tpl-toggle="csat"] button:not([role="switch"])') as HTMLButtonElement;
    expect(reset.textContent).toBe('Use the default');
    fireEvent.click(reset);
    expect(changes).toEqual([{ transcriptEmail: true }]);
  });

  it('default and intl have no options at all', async () => {
    for (const id of ['default', 'intl']) {
      const { container } = render(
        <I18nProvider initialLocale="en">
          <TemplateOptionsFields templateId={id} value={{}} onChange={() => {}} idPrefix="z" />
        </I18nProvider>,
      );
      expect(container.innerHTML).toBe('');
      cleanup();
    }
  });
});
