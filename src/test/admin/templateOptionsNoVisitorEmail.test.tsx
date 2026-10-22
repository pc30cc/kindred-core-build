/**
 * With visitor email switched off (shared/visitorEmail.ts, the shipped value;
 * owner 2026-10-21), neither the Super Admin's catalog nor a workspace's
 * template options offer the transcript by email: the switch is not drawn.
 * Switched on, it is (templateOptionsFields.test.tsx).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import { TemplateOptionsFields } from '@/components/app/widget/TemplateOptionsFields';
import { VISITOR_EMAIL_FEATURES_ENABLED } from '../../../shared/visitorEmail';

afterEach(cleanup);

describe('TemplateOptionsFields while visitor email is switched off', () => {
  it('draws no transcript switch for Template 1 or 2; the rest of their options stay', async () => {
    expect(VISITOR_EMAIL_FEATURES_ENABLED).toBe(false);
    for (const id of ['t1', 't2']) {
      render(
        <I18nProvider initialLocale="en">
          <TemplateOptionsFields templateId={id} value={{ transcriptEmail: true }} onChange={() => {}} idPrefix="n" />
        </I18nProvider>,
      );
      await waitFor(() => expect(document.querySelector(`[data-tpl-options="${id}"]`)).not.toBeNull());
      expect(document.querySelector('[data-tpl-toggle="transcriptEmail"]')).toBeNull();
      expect(document.body.textContent).not.toMatch(/transcript/i);
      if (id === 't2') expect(document.querySelector('[data-tpl-toggle="csat"]')).not.toBeNull();
      cleanup();
    }
  });
});
