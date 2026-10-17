// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isContentHashedAssetName, widgetAssetUrl } from './manifest.js';

describe('widgetAssetUrl — a content-hashed name is its own version', () => {
  it('gives hashed names no query', () => {
    for (const name of [
      'runtime.3051edd1.js',
      'runtime.4f424b04.css',
      'vendor/livekit-client.umd.min.23449062.js',
      'presentation-default-fonts.57bc0d3a.css',
      'smart-engine.fcdcf880.js',
      'runtime-rt-centrifugo.0a1b2c3d.js',
      'fonts/inter-500-latin.9f8e7d6c.woff2',
      'RUNTIME.ABCDEF12.JS',
    ]) {
      expect(widgetAssetUrl('https://app.example', name, 'lv1')).toBe(`https://app.example/widget/${name}`);
    }
  });

  it('keeps ?v=<loaderVersion> on unhashed fallback names, URL-encoded', () => {
    expect(widgetAssetUrl('https://app.example', 'runtime-rt-resolver.js', 'unresolved'))
      .toBe('https://app.example/widget/runtime-rt-resolver.js?v=unresolved');
    expect(widgetAssetUrl('https://app.example', 'runtime.js', 'a b&c'))
      .toBe('https://app.example/widget/runtime.js?v=a%20b%26c');
    // Seven or nine hex digits are not a build hash.
    expect(widgetAssetUrl('https://app.example', 'runtime.3051edd.js', 'v')).toContain('?v=v');
    expect(widgetAssetUrl('https://app.example', 'runtime.3051edd11.js', 'v')).toContain('?v=v');
  });

  it('is null without a base or a name, as the old inline ternaries were', () => {
    expect(widgetAssetUrl(null, 'runtime.3051edd1.js', 'v')).toBeNull();
    expect(widgetAssetUrl('https://app.example', null, 'v')).toBeNull();
    expect(widgetAssetUrl('', 'runtime.js', 'v')).toBeNull();
  });

  it('isContentHashedAssetName', () => {
    expect(isContentHashedAssetName('loader.js')).toBe(false);
    expect(isContentHashedAssetName('runtime-chat.js')).toBe(false);
    expect(isContentHashedAssetName('runtime-chat.deadbeef.js')).toBe(true);
    expect(isContentHashedAssetName('fonts/iransans-400.0123abcd.woff2')).toBe(true);
    expect(isContentHashedAssetName('fonts/iransans-400.woff2')).toBe(false);
    expect(isContentHashedAssetName('x.deadbeef.json')).toBe(false);
  });

  it('matches exactly what nginx serves immutable (the hashed /widget/ location)', () => {
    const nginx = readFileSync('nginx.conf.template', 'utf8');
    const m = nginx.match(/location ~\* "\^\/widget\/\.\*(\\\.\[a-f0-9\]\{8\}\\\.\(\?:[a-z0-9|]+\))\$"/);
    expect(m, 'hashed /widget/ location not found').not.toBeNull();
    const helperSrc = readFileSync('server/services/widget/manifest.ts', 'utf8');
    // Same suffix test, same extensions, case-insensitive on both sides.
    expect(helperSrc).toContain(`const CONTENT_HASHED_RE = /${m![1]}$/i;`);
  });
});
