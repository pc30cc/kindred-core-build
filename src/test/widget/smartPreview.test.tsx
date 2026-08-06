/**
 * The smart scenario preview must render the *real* widget contract:
 * no generic navigation, phase-driven panel state, announcements docked under
 * the header, and chat automation messages that never borrow an operator
 * identity.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  WidgetLivePreview,
  type SmartPreviewScenario,
  type SmartPreviewPhase,
} from '@/components/app/widget/WidgetLivePreview';
import { createEmptySmartRule } from '@/lib/widget/smartRules';

function scenario(
  mode: 'launcher_nudge' | 'open_widget' | 'home_card' | 'chat_message' | 'announcement',
  phase: SmartPreviewPhase = 'surface_shown',
): SmartPreviewScenario {
  const rule = createEmptySmartRule('en', 'UTC');
  rule.presentation_config = { ...rule.presentation_config, mode } as any;
  return {
    rule,
    content: { title: 'Need help?', body: 'We reply in a minute.', ctaLabel: 'Chat now' },
    verdict: { outcome: 'matched', reasons: [] },
    phase,
    device: 'desktop',
    locale: 'en',
    rtl: false,
    automationLabel: 'Automated message',
  };
}

function srcdoc(s: SmartPreviewScenario, view: 'home' | 'chat' = 'home') {
  const { container } = render(
    <WidgetLivePreview
      settings={{ widget_language: 'en' }}
      brandName="Acme"
      view={view}
      previewMode="smart"
      smartScenario={s}
    />,
  );
  return container.querySelector('iframe')!.getAttribute('srcdoc') || '';
}

describe('smart scenario preview', () => {
  it('hides the generic bottom navigation in smart mode', () => {
    expect(srcdoc(scenario('home_card'))).not.toContain('tabs tabs-bottom');
  });

  it('keeps generic navigation in the ordinary preview', () => {
    const { container } = render(
      <WidgetLivePreview settings={{ widget_language: 'en' }} brandName="Acme" view="home" />,
    );
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('tabs tabs-bottom');
  });

  it('starts the panel closed and drives it from the phase', () => {
    const doc = srcdoc(scenario('launcher_nudge'));
    expect(doc).toContain('setOpen(!GS_SMART.enabled)');
    expect(doc).toContain('smart-preview:set-phase');
  });

  it('renders every presentation mode with its production class', () => {
    expect(srcdoc(scenario('launcher_nudge'))).toContain('class="smart-nudge');
    expect(srcdoc(scenario('announcement'))).toContain('class="smart-announce"');
    expect(srcdoc(scenario('home_card'))).toContain('class="smart-home-card"');
    expect(srcdoc(scenario('chat_message'), 'chat')).toContain('msg-row automation');
  });

  it('docks the announcement directly under the header, above the body', () => {
    const doc = srcdoc(scenario('announcement'));
    const announce = doc.indexOf('class="smart-announce"');
    const body = doc.indexOf('<div class="body">');
    expect(announce).toBeGreaterThan(-1);
    expect(announce).toBeLessThan(body);
  });

  it('never gives a chat automation message an operator identity', () => {
    const s = scenario('chat_message');
    const { container } = render(
      <WidgetLivePreview
        settings={{ widget_language: 'en' }}
        brandName="Acme"
        view="chat"
        operatorAvatar="https://example.com/a.png"
        operatorName="Sara"
        previewMode="smart"
        smartScenario={s}
      />,
    );
    const doc = container.querySelector('iframe')!.getAttribute('srcdoc') || '';
    const start = doc.indexOf('msg-row automation');
    const automation = doc.slice(start, doc.indexOf('msg-row operator', start));
    expect(automation).not.toContain('msg-avatar');
    expect(automation).not.toContain('Sara');
    expect(automation).toContain('Automated message');
  });

  it('marks every smart surface so the phase script can toggle it', () => {
    for (const mode of ['launcher_nudge', 'announcement', 'home_card'] as const) {
      expect(srcdoc(scenario(mode))).toContain('data-smart-surface');
    }
  });

  it('reports dismiss and cta interactions back to the studio', () => {
    const doc = srcdoc(scenario('home_card'));
    expect(doc).toContain('smart-preview:dismiss');
    expect(doc).toContain('smart-preview:cta');
    expect(doc).toContain('smart-preview:widget-opened');
  });
});
