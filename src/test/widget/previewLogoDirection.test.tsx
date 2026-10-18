/**
 * The dashboard's live preview of the International edition's skins over
 * Templates 1 and 2 (t1-intl, t2-intl) and their logo direction
 * (`logoDirection`, a template option), drawn as the loader and the server
 * draw it on a site: `lg-thread` / `lg-open` on the shell (the skin's art
 * follows it), that direction's chat button glyph and its footer lockup.
 * `intl` reads no option, so it stays Thread.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { WidgetLivePreview } from '@/components/app/widget/WidgetLivePreview';

vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'international', isInternational: true, ready: true }),
  useKnownEdition: () => 'international',
}));

afterEach(cleanup);

const POWERED = { text: 'Powered by', brand: 'Respok', url: 'https://respok.app' };

function frame(templateId: string, templateOptions: Record<string, unknown>) {
  const { container } = render(
    <WidgetLivePreview settings={{ widget_language: 'en' }} brandName="Acme" view="home" poweredBy={POWERED}
      templateId={templateId} templateOptions={templateOptions} />,
  );
  const doc = container.querySelector('iframe')!.getAttribute('srcdoc') || '';
  const m = /var GS_PREVIEW = (\{.*\});\n/.exec(doc);
  if (!m) throw new Error('no payload');
  const shell = /<div class="(shell [^"]*)">/.exec(doc)![1].split(' ');
  return { doc, shell, payload: JSON.parse(m[1]) as { templateId: string; config: { poweredBy: { logo: string }; templateOptions: Record<string, unknown> } } };
}

describe('WidgetLivePreview — the International logo direction', () => {
  it.each(['t1-intl', 't2-intl'])('%s, Open: lg-open, the bubble-and-dot button, the Open lockup', (id) => {
    const { doc, shell, payload } = frame(id, { logoDirection: 'open' });
    expect(payload.templateId).toBe(id);
    expect(shell).toContain('lg-open');
    expect(shell).not.toContain('lg-thread');
    expect(doc).toContain('rpk-kit-glyph rpk-kit-o"');
    expect(payload.config.poweredBy.logo).toMatch(/\/brand\/intl\/respok-open-horizontal-color\.svg$/);
    expect(payload.config.templateOptions).toEqual({ logoDirection: 'open' });
  });

  it.each(['t1-intl', 't2-intl'])('%s, Thread (the default): lg-thread, the two pills, the Thread lockup', (id) => {
    const { doc, shell, payload } = frame(id, { logoDirection: 'thread' });
    expect(shell).toContain('lg-thread');
    expect(shell).not.toContain('lg-open');
    expect(doc).not.toContain('rpk-kit-glyph rpk-kit-o"');
    expect(doc).toContain('class="chat-icon rpk-kit-glyph"');
    expect(payload.config.poweredBy.logo).toMatch(/\/brand\/intl\/respok-thread-horizontal-color\.svg$/);
  });

  it('intl reads no option: Thread', () => {
    const { shell, payload } = frame('intl', {});
    expect(shell).toContain('lg-thread');
    expect(payload.config.poweredBy.logo).toMatch(/respok-thread-horizontal-color\.svg$/);
  });
});
