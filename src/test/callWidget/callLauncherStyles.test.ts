/**
 * shared/callLauncherStyles.ts: the call widget's nine launcher styles and
 * five placements (migration 277), one rule for the server, the dashboard and
 * the widget's engine.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CALL_LAUNCHER_STYLES,
  CALL_WIDGET_POSITIONS,
  CALL_WIDGET_POSITION_ALIASES,
  callEdgeTabSide,
  callLauncherNeedsPresence,
  isCallLauncherStyle,
  normalizeCallLauncherStyle,
  normalizeCallWidgetPosition,
  resolveCallLauncher,
} from '../../../shared/callLauncherStyles';

describe('call launcher styles', () => {
  it('names the nine styles of the design, each a shape the 277 column accepts', () => {
    expect([...CALL_LAUNCHER_STYLES]).toEqual([
      'round', 'round_label', 'pill', 'card', 'split', 'edge_tab', 'dark_square', 'operator_face', 'mobile_bar',
    ]);
    for (const style of CALL_LAUNCHER_STYLES) expect(style).toMatch(/^[a-z][a-z_]{0,31}$/);
  });

  it('reads an unknown or missing style as round_label', () => {
    expect(normalizeCallLauncherStyle('card')).toBe('card');
    for (const raw of [undefined, null, '', 'ROUND', 'bubble', 42, {}]) {
      expect(normalizeCallLauncherStyle(raw)).toBe('round_label');
    }
    expect(isCallLauncherStyle('mobile_bar')).toBe(true);
    expect(isCallLauncherStyle('mobile-bar')).toBe(false);
  });

  it('publishes operators only for the styles that draw them', () => {
    expect(CALL_LAUNCHER_STYLES.filter(callLauncherNeedsPresence)).toEqual(['card', 'operator_face']);
    expect(callLauncherNeedsPresence(undefined)).toBe(false);
  });
});

describe('call widget placements', () => {
  it('has the five placements', () => {
    expect([...CALL_WIDGET_POSITIONS]).toEqual(['right', 'left', 'top_right', 'top_left', 'bottom_center']);
  });

  it('maps every stored spelling to its placement (a stored bottom-left is left)', () => {
    expect(normalizeCallWidgetPosition('bottom-right')).toBe('right');
    expect(normalizeCallWidgetPosition('bottom_right')).toBe('right');
    expect(normalizeCallWidgetPosition('bottom-left')).toBe('left');
    expect(normalizeCallWidgetPosition('bottom_left')).toBe('left');
    expect(normalizeCallWidgetPosition('top-right')).toBe('top_right');
    expect(normalizeCallWidgetPosition('top-left')).toBe('top_left');
    expect(normalizeCallWidgetPosition('bottom-center')).toBe('bottom_center');
    expect(normalizeCallWidgetPosition('center')).toBe('bottom_center');
    for (const p of CALL_WIDGET_POSITIONS) expect(normalizeCallWidgetPosition(p)).toBe(p);
  });

  it('reads anything else as right, where it always rendered', () => {
    for (const raw of [undefined, null, '', 'Left', ' left', 'middle', 'constructor', '__proto__', 7]) {
      expect(normalizeCallWidgetPosition(raw)).toBe('right');
    }
  });

  it('is the same table as the engine\'s position() (runtime.js POSITION_ALIASES)', () => {
    const src = readFileSync(resolve(process.cwd(), 'public/call-widget/runtime.js'), 'utf8');
    const block = /var POSITION_ALIASES = \{([\s\S]*?)\};/.exec(src);
    expect(block, 'POSITION_ALIASES in runtime.js').not.toBeNull();
    const engine: Record<string, string> = {};
    for (const m of block![1].matchAll(/'?([a-z_-]+)'?\s*:\s*'([a-z_]+)'/g)) engine[m[1]] = m[2];
    expect(engine).toEqual({ ...CALL_WIDGET_POSITION_ALIASES });
  });

  it('resolves a row to the style and placement the bootstrap sends', () => {
    expect(resolveCallLauncher({ launcher_style: 'pill', widget_position: 'bottom-left' })).toEqual({ style: 'pill', position: 'left' });
    // A row from before 277: no style column.
    expect(resolveCallLauncher({ widget_position: 'bottom-right' })).toEqual({ style: 'round_label', position: 'right' });
    expect(resolveCallLauncher(null)).toEqual({ style: 'round_label', position: 'right' });
  });

  it('puts the edge tab on the right edge unless the placement is on the left', () => {
    expect(callEdgeTabSide('top_right')).toBe('right');
    expect(callEdgeTabSide('right')).toBe('right');
    expect(callEdgeTabSide('bottom_center')).toBe('right');
    expect(callEdgeTabSide('left')).toBe('left');
    expect(callEdgeTabSide('top-left')).toBe('left');
  });
});
