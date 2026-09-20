/**
 * Guards the call_widget → Call Center surface generalization.
 *
 * Group A (operator queue, routing, lifecycle, call lists) must include BOTH
 * widget and telephony calls. Group B (widget concurrency/entitlement counters
 * and widget-specific routes) must stay widget-only so existing billing and
 * widget semantics never change silently.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CALL_CENTER_ENTRY_SOURCES,
  ENTRY_SOURCE_CALL_WIDGET,
  ENTRY_SOURCE_TELEPHONY,
  WIDGET_ONLY_ENTRY_SOURCE,
  isCallCenterEntrySource,
  isTelephonyEntrySource,
} from '../../../shared/callCenter/entrySources.js';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('call center entry sources', () => {
  it('exposes both widget and telephony as Call Center surfaces', () => {
    expect(CALL_CENTER_ENTRY_SOURCES).toContain(ENTRY_SOURCE_CALL_WIDGET);
    expect(CALL_CENTER_ENTRY_SOURCES).toContain(ENTRY_SOURCE_TELEPHONY);
    expect(isCallCenterEntrySource('telephony')).toBe(true);
    expect(isCallCenterEntrySource('chat')).toBe(false);
    expect(isTelephonyEntrySource('telephony')).toBe(true);
    expect(isTelephonyEntrySource('call_widget')).toBe(false);
  });

  it('keeps widget-only semantics on a distinct constant', () => {
    expect(WIDGET_ONLY_ENTRY_SOURCE).toBe('call_widget');
  });

  it('keeps widget concurrency/entitlement counters widget-only', () => {
    // These are Group B surfaces: they bound the *widget* product limit, so a
    // telephony call must never be counted against them.
    const usage = read('server/services/billing/usageResolvers.ts');
    expect(usage).toContain("'call_widget'");
    expect(usage).not.toContain('CALL_CENTER_ENTRY_SOURCES');

    const widget = read('server/routes/callWidget.ts');
    expect(widget).not.toContain('CALL_CENTER_ENTRY_SOURCES');
  });

  it('routes telephony calls through the shared Call Center routing surface', () => {
    const routing = read('server/services/callCenter/routing.ts');
    expect(routing).toContain('CALL_CENTER_ENTRY_SOURCES');
  });
});
