/**
 * Template 1's bottom menu label choice (src/components/app/widget/TemplateOptionsFields.tsx).
 * Only the floating dock (`vb`) draws the label modes; the other bars keep
 * their own labels (presentation-t1.css scopes `.nv-both/.nv-icon/.nv-text`
 * to `.vb`), so with another style the field offers only what changes the
 * widget, says why, and shows a saved dock-only mode as what is drawn.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
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
