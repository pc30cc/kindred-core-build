/**
 * P0-AI — the authoritative visitor AI snapshot.
 *
 * The bug being locked down: `/widget/config` treated `provider_pending`
 * (no resolvable AI provider) as visitor-facing, so it suppressed the
 * greeting and promised a conversation the AI could never hold. The
 * snapshot must separate "may send the static intro" (introCapable) from
 * "will actually converse" (visitorFacing, provider required), and must
 * never leak provider details.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const platformGate = vi.fn();
const resolveAIConfig = vi.fn();

vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({
  isAutoAnswerAllowedForWorkspace: (...a: any[]) => platformGate(...a),
}));
vi.mock('../../../server/services/ai/index.js', () => ({
  resolveAIConfig: (...a: any[]) => resolveAIConfig(...a),
}));

const { resolveVisitorAiSnapshot } = await import('../../../server/services/ai-agent/visitorAiSnapshot');

const config: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };

describe('resolveVisitorAiSnapshot', () => {
  beforeEach(() => {
    platformGate.mockReset();
    resolveAIConfig.mockReset();
  });

  it('provider missing → introCapable true, visitorFacing FALSE (no greeting suppression)', async () => {
    platformGate.mockResolvedValue({ allowed: true });
    resolveAIConfig.mockRejectedValue(new Error('no provider'));
    const snap = await resolveVisitorAiSnapshot(config, 'ws', { enabled: true, mode: 'auto_reply_always' } as any);
    expect(snap).toMatchObject({
      platformAllowed: true,
      workspaceEnabled: true,
      autoReplyMode: true,
      providerReady: false,
      introCapable: true,
      visitorFacing: false,
      reason: 'no_provider',
    });
  });

  it('provider resolvable → visitorFacing true', async () => {
    platformGate.mockResolvedValue({ allowed: true });
    resolveAIConfig.mockResolvedValue({ provider: 'redacted' });
    const snap = await resolveVisitorAiSnapshot(config, 'ws', { enabled: true, mode: 'auto_reply_always' } as any);
    expect(snap).toMatchObject({ providerReady: true, visitorFacing: true, introCapable: true, reason: 'ok' });
  });

  it('platform gate closed beats an enabled workspace', async () => {
    platformGate.mockResolvedValue({ allowed: false, reason: 'auto_answer_disabled_by_platform' });
    const snap = await resolveVisitorAiSnapshot(config, 'ws', { enabled: true, mode: 'auto_reply_always' } as any);
    expect(snap).toMatchObject({ platformAllowed: false, introCapable: false, visitorFacing: false, reason: 'platform_disabled' });
    expect(resolveAIConfig).not.toHaveBeenCalled();
  });

  it('suggest_only is never visitor-facing and never intro-capable', async () => {
    platformGate.mockResolvedValue({ allowed: true });
    const snap = await resolveVisitorAiSnapshot(config, 'ws', { enabled: true, mode: 'suggest_only' } as any);
    expect(snap).toMatchObject({ introCapable: false, visitorFacing: false, reason: 'mode_suggest_only' });
  });

  it('fails closed when the platform gate throws', async () => {
    platformGate.mockRejectedValue(new Error('db down'));
    const snap = await resolveVisitorAiSnapshot(config, 'ws', { enabled: true, mode: 'auto_reply_always' } as any);
    expect(snap.visitorFacing).toBe(false);
    expect(snap.introCapable).toBe(false);
  });

  it('carries no provider/credential-bearing fields', async () => {
    platformGate.mockResolvedValue({ allowed: true });
    resolveAIConfig.mockResolvedValue({ provider: 'openai', apiKey: 'sk-secret', model: 'gpt-x' });
    const snap = await resolveVisitorAiSnapshot(config, 'ws', { enabled: true, mode: 'auto_reply_always' } as any);
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toMatch(/sk-secret|openai|gpt-x|apiKey/);
    expect(Object.keys(snap).sort()).toEqual([
      'autoReplyMode', 'introCapable', 'mode', 'platformAllowed',
      'providerReady', 'reason', 'visitorFacing', 'workspaceEnabled',
    ]);
  });
});
