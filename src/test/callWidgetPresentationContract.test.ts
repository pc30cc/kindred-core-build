import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
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
    ];
    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|Live[Kk]it|sessionStorage|localStorage|indexedDB/);
    }
  });

  it('keeps every declared UI state renderable by the default presentation path', () => {
    const runtime = read('public/call-widget/runtime.js');
    const presentation = read('public/call-widget/presentation-default.js');
    const stateBlock = runtime.match(/var STATES = \{([\s\S]*?)\n  \};/)?.[1] || '';
    const states = [...stateBlock.matchAll(/^\s+([A-Z_]+): '[a-z_]+'[,]?$/gm)].map((match) => match[1]);
    expect(states).toEqual([
      'LOADING', 'ONLINE', 'OFFLINE', 'PRE_CALL', 'QUEUE',
      'IN_CALL', 'ENDED', 'CALLBACK', 'ERROR',
    ]);
    for (const state of states) expect(presentation).toContain(`case STATES.${state}`);
  });

  it('keeps widget markup and DOM updates out of the transport runtime', () => {
    const runtime = read('public/call-widget/runtime.js');
    const presentation = read('public/call-widget/presentation-default.js');

    expect(runtime).not.toContain('renderLegacy');
    expect(runtime).not.toMatch(/case STATES\./);
    expect(runtime).not.toMatch(/innerHTML|\.querySelector\(|document\.|createElement|appendChild|setAttribute|\.remove\(/);
    expect(presentation).toContain('function renderWidget()');
    expect(presentation).toContain('function renderState(caps, cfg)');
    expect(presentation).toContain('function renderForm(cfg, forCall)');
  });

  it('ships byte-identical hosted and self-hosted migrations', () => {
    expect(read('supabase/migrations/20260902200000_call_widget_presentation_contract.sql'))
      .toBe(read('database/migrations/098_call_widget_presentation_contract.sql'));
  });
});
