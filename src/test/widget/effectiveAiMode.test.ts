/**
 * Effective AI Mode — precedence unit tests.
 *
 * A workspace `enabled` toggle plus a `mode` value is not sufficient to
 * decide whether AI is actually visitor-facing (spec §3): the platform
 * kill switch outranks workspace settings, and 'off'/'suggest_only' must
 * never be treated as visitor-facing even when enabled=true. This tests
 * the pure classification step (server/services/ai-agent/effectiveMode.ts)
 * with no Supabase/provider I/O involved.
 */
import { describe, it, expect } from 'vitest';
import { classifyEffectiveAiMode } from '../../../server/services/ai-agent/effectiveMode';

describe('classifyEffectiveAiMode', () => {
  it('platform_disabled wins even when workspace settings would otherwise allow AI', () => {
    const result = classifyEffectiveAiMode(false, { enabled: true, mode: 'auto_reply_always' });
    expect(result).toEqual({ visitorFacing: false, reason: 'platform_disabled' });
  });

  it('workspace_disabled when the workspace toggle is off, even if mode is auto', () => {
    const result = classifyEffectiveAiMode(true, { enabled: false, mode: 'auto_reply_always' });
    expect(result).toEqual({ visitorFacing: false, reason: 'workspace_disabled' });
  });

  it('mode_off is never visitor-facing even when enabled=true', () => {
    const result = classifyEffectiveAiMode(true, { enabled: true, mode: 'off' });
    expect(result).toEqual({ visitorFacing: false, reason: 'mode_off' });
  });

  it('mode_suggest_only is never visitor-facing (operator-only suggestions)', () => {
    const result = classifyEffectiveAiMode(true, { enabled: true, mode: 'suggest_only' });
    expect(result).toEqual({ visitorFacing: false, reason: 'mode_suggest_only' });
  });

  it.each([
    'auto_reply_when_offline',
    'auto_reply_until_human_joins',
    'auto_reply_always',
  ] as const)('mode=%s with platform+workspace allowed defers to provider check (provider_pending)', (mode) => {
    const result = classifyEffectiveAiMode(true, { enabled: true, mode });
    expect(result).toEqual({ visitorFacing: false, reason: 'provider_pending' });
  });

  it('treats an unrecognized mode value as mode_off (fail closed, never visitor-facing by default)', () => {
    const result = classifyEffectiveAiMode(true, { enabled: true, mode: 'some_future_mode' as any });
    expect(result).toEqual({ visitorFacing: false, reason: 'mode_off' });
  });

  it('never returns visitorFacing: true — that can only happen after the provider check', () => {
    const allTrueInputs = [
      [false, { enabled: true, mode: 'auto_reply_always' as const }],
      [true, { enabled: true, mode: 'auto_reply_always' as const }],
    ] as const;
    for (const [platformAllowed, settings] of allTrueInputs) {
      expect(classifyEffectiveAiMode(platformAllowed, settings).visitorFacing).toBe(false);
    }
  });
});
