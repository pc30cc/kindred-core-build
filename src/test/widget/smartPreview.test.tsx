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
    const doc = srcdoc(scenario('home_card'));
    expect(doc).toContain('"smart":{"enabled":true');
    // Tabs come from the production renderer; the studio strips them.
    expect(doc).toContain("panel.querySelector('.tabs')");
  });

  it('keeps generic navigation in the ordinary preview', () => {
    const { container } = render(
      <WidgetLivePreview settings={{ widget_language: 'en' }} brandName="Acme" view="home" />,
    );
    const doc = container.querySelector('iframe')!.getAttribute('srcdoc') || '';
    expect(doc).toContain('"smart":{"enabled":false');
    expect(doc).toContain('data-tab');
  });

  it('renders the panel through the production presentation renderer', () => {
    const doc = srcdoc(scenario('home_card'));
    expect(doc).toContain('/widget/presentation-registry.js');
    // Template assets are resolved via the registry, never named here.
    expect(doc).toContain('reg.resolve(GS_PREVIEW.templateId)');
    expect(doc).toContain("'/widget/' + desc.script");
    expect(doc).toContain("'/widget/' + desc.style");

    expect(doc).toContain('R.shellHtml(GS_PREVIEW.shellVm)');
    expect(doc).toContain('R.homeHtml(GS_PREVIEW.homeVm)');
    expect(doc).toContain('R.smartSurfaceHtml(surface)');
  });

  it('starts the panel closed and drives it from the phase', () => {
    const doc = srcdoc(scenario('launcher_nudge'));
    expect(doc).toContain('setOpen(!GS_SMART.enabled)');
    expect(doc).toContain('smart-preview:set-phase');
  });

  it('passes every presentation mode to the renderer with its placement', () => {
    expect(srcdoc(scenario('launcher_nudge'))).toContain('"mode":"launcher_nudge"');
    expect(srcdoc(scenario('announcement'))).toContain('"mode":"announcement"');
    expect(srcdoc(scenario('home_card'))).toContain('"mode":"home_card"');
    expect(srcdoc(scenario('chat_message'), 'chat')).toContain('"mode":"chat_message"');
    const doc = srcdoc(scenario('home_card'));
    expect(doc).toContain("'smart-nudge '");
    expect(doc).toContain("ann.className = 'smart-announce'");
    expect(doc).toContain("card.className = 'smart-home-card'");
    expect(doc).toContain("dock.className = 'smart-chat-dock'");
  });

  it('docks the announcement directly under the header, above the body', () => {
    const doc = srcdoc(scenario('announcement'));
    expect(doc).toContain('panel.insertBefore(ann, body)');
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
    // The dock is filled with renderer output only — never a message row.
    expect(doc).toContain('dock.innerHTML = inner');
    expect(doc).not.toContain('smart-chat-dock"><span class="msg-avatar');
  });

  it('marks every smart surface so the phase script can toggle it', () => {
    for (const mode of ['launcher_nudge', 'announcement', 'home_card'] as const) {
      expect(srcdoc(scenario(mode))).toContain("setAttribute('data-smart-surface', '')");
    }
  });

  it('reports dismiss and cta interactions back to the studio', () => {
    const doc = srcdoc(scenario('home_card'));
    expect(doc).toContain('smart-preview:dismiss');
    expect(doc).toContain('smart-preview:cta');
    expect(doc).toContain('smart-preview:widget-opened');
  });
});
