import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { closeCallWidgets, mountCallWidget } from './callWidget/mountCallWidget';
import {
  callWidgetFormSchema,
  callWidgetTemplateAssetKeys,
  normalizeCallWidgetFormSchema,
  normalizeCallWidgetOfflineBehavior,
  normalizeCallWidgetTheme,
  resolveCallWidgetTemplateId,
} from '../../server/services/callCenter/presentation';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Call Widget presentation contract', () => {
  it('falls back to the default allowlisted template and assets', () => {
    expect(resolveCallWidgetTemplateId('not-installed')).toBe('default');
    expect(callWidgetTemplateAssetKeys('../unsafe')).toEqual({
      registry: 'presentation-registry.js',
      script: 'presentation-default.js',
      style: 'presentation-default.css',
    });
  });

  it('accepts only safe theme tokens', () => {
    expect(normalizeCallWidgetTheme({ primary: '#AABBCC', density: 'compact' })).toEqual({
      primary: '#aabbcc',
      density: 'compact',
    });
    expect(normalizeCallWidgetTheme({ primary: 'url(javascript:alert(1))' })).toEqual({});
    expect(normalizeCallWidgetTheme({ css: '* { display:none }' })).toEqual({});
  });

  it('validates unique, bounded pre-call fields and select options', () => {
    expect(callWidgetFormSchema.safeParse([
      { id: 'topic', type: 'select', label: 'Topic', required: true, options: [{ value: 'sales', label: 'Sales' }] },
    ]).success).toBe(true);
    expect(callWidgetFormSchema.safeParse([
      { id: 'topic', type: 'text', label: 'One' },
      { id: 'topic', type: 'text', label: 'Two' },
    ]).success).toBe(false);
    expect(normalizeCallWidgetFormSchema([{ id: 'x', type: 'select', label: 'X' }])).toEqual([]);
  });

  it.each([
    ['hide', 'hide'],
    ['show_callback', 'show_callback'],
    ['show_message', 'show_message'],
    ['callback', 'show_callback'],
    ['unknown', 'show_callback'],
  ])('normalizes offline behavior %s', (input, expected) => {
    expect(normalizeCallWidgetOfflineBehavior(input)).toBe(expected);
  });

  it('keeps presentations free from transport, persistence and LiveKit code', () => {
    const files = [
      'public/call-widget/presentation-registry.js',
      'public/call-widget/presentation-default.js',
      'public/call-widget/presentation-default-panel.js',
    ];
    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|Live[Kk]it|sessionStorage|localStorage|indexedDB/);
    }
  });

  it('loads the media SDK only when a call needs it and ignores cancelled calls', () => {
    const loader = read('public/call-widget/l.js');
    const runtime = read('public/call-widget/runtime.js');
    expect(loader).toContain('loadScripts(scriptPaths());');
    expect(loader).not.toMatch(/ensureLiveKitSdk\((?!cb)/);
    expect(loader).toContain('loadLiveKitSdk: ensureLiveKitSdk');
    expect(runtime).toContain('this.loadLiveKitSdk(function (ready)');
    expect(runtime).toContain('(self._mediaLoadGeneration || 0) !== pendingGeneration');
  });

  it('keeps every declared UI state renderable by the default presentation', () => {
    const runtime = read('public/call-widget/runtime.js');
    const stateBlock = runtime.match(/var STATES = \{([\s\S]*?)\n {2}\};/)?.[1] || '';
    const states = [...stateBlock.matchAll(/^\s+[A-Z_]+: '([a-z_]+)'[,]?$/gm)].map((match) => match[1]);
    expect(states).toEqual([
      'loading', 'online_available', 'offline', 'pre_call_form', 'queue_waiting',
      'in_call', 'ended', 'callback_form', 'error',
    ]);
    // Each one, mounted: the root says the state and one screen is drawn for it.
    const m = mountCallWidget({ locale: 'en' });
    m.open();
    const seen: Record<string, string | null> = {};
    for (const state of states) {
      m.set({ state, endedCallId: state === 'ended' ? 'c1' : null });
      expect(m.root.dataset.state).toBe(state);
      expect(m.qa('.scr.on')).toHaveLength(1);
      seen[state] = m.screenId();
    }
    expect(seen).toEqual({
      loading: 'connecting', online_available: 'home', offline: 'offline', pre_call_form: 'precall', queue_waiting: 'queue',
      in_call: 'joining', ended: 'rating', callback_form: 'callback', error: 'error',
    });
    closeCallWidgets();
  });

  it('keeps widget markup and DOM updates out of the transport runtime', () => {
    const runtime = read('public/call-widget/runtime.js');
    expect(runtime).not.toContain('renderLegacy');
    expect(runtime).not.toMatch(/case STATES\./);
    expect(runtime).not.toMatch(/innerHTML|\.querySelector\(|document\.|createElement|appendChild|setAttribute|\.remove\(/);
  });

  it('the panel module defines one global, the contract version the core expects', () => {
    const panel = read('public/call-widget/presentation-default-panel.js');
    expect(panel).toContain('global.__ccw_panel = { v: 1, create: create };');
    expect(read('public/call-widget/presentation-default.js')).toContain('var PANEL_V = 1;');
    expect(panel.match(/\bglobal\.[A-Za-z_$]+\s*=/g)).toEqual(['global.__ccw_panel =']);
  });

  it('ships byte-identical hosted and self-hosted migrations', () => {
    expect(read('supabase/migrations/20260902200000_call_widget_presentation_contract.sql'))
      .toBe(read('database/migrations/101_call_widget_presentation_contract.sql'));
  });
});
