/**
 * AI Proactive Nudge — security and tenant-isolation unit tests.
 *
 * Covers three trust boundaries the feature spec calls out explicitly:
 *  1. The AI decision contract fails closed on any malformed/out-of-range
 *     model output (server/services/widget/aiNudge/contract.ts).
 *  2. Platform ceilings always dominate a workspace's own settings and the
 *     resolver never throws (server/services/widget/aiNudge/policy.ts).
 *  3. A cross-workspace ai_nudge_id can never attribute an event to another
 *     tenant (server/services/widget/smartEngagement.ts recordSmartEvent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import { parseAiNudgeDecision, AI_NUDGE_MESSAGE_HARD_MAX } from '../../../server/services/widget/aiNudge/contract.js';

describe('AI Proactive Nudge — decision contract fails closed', () => {
  it('rejects non-JSON output', () => {
    expect(parseAiNudgeDecision('sure, here is a friendly nudge message!')).toBeNull();
  });

  it('rejects JSON missing required fields', () => {
    expect(parseAiNudgeDecision(JSON.stringify({ decision: 'show' }))).toBeNull();
  });

  it('rejects an unknown decision value', () => {
    expect(parseAiNudgeDecision(JSON.stringify({ decision: 'auto_open_chat', message: 'hi', intent: 'x', confidence: 0.9, topic: 'pricing' }))).toBeNull();
  });

  it('rejects confidence outside 0..1', () => {
    const raw = JSON.stringify({ decision: 'show', intent: 'pricing', confidence: 1.5, message: 'Need help choosing a plan?', topic: 'pricing' });
    expect(parseAiNudgeDecision(raw)).toBeNull();
  });

  it('rejects a message longer than the hard cap', () => {
    const raw = JSON.stringify({
      decision: 'show', intent: 'pricing', confidence: 0.8,
      message: 'x'.repeat(AI_NUDGE_MESSAGE_HARD_MAX + 1), topic: 'pricing',
    });
    expect(parseAiNudgeDecision(raw)).toBeNull();
  });

  it('rejects an unsupported cta action (prevents an arbitrary open_url-like escape hatch)', () => {
    const raw = JSON.stringify({
      decision: 'show', intent: 'pricing', confidence: 0.8, message: 'Need help?', topic: 'pricing',
      cta: { label: 'Chat now', action: 'redirect_external' },
    });
    expect(parseAiNudgeDecision(raw)).toBeNull();
  });

  it('rejects oversized raw payloads outright (defense against a huge/garbage completion)', () => {
    expect(parseAiNudgeDecision('{"decision":"show",' + 'x'.repeat(9000))).toBeNull();
  });

  it('accepts a well-formed show decision, tolerating a fenced code block wrapper', () => {
    const payload = { decision: 'show', intent: 'pricing', confidence: 0.82, message: 'Need help choosing a plan?', topic: 'pricing', cta: { label: 'Chat now', action: 'open_chat' } };
    const raw = '```json\n' + JSON.stringify(payload) + '\n```';
    const parsed = parseAiNudgeDecision(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.decision).toBe('show');
  });

  it('accepts a minimal suppress decision', () => {
    const parsed = parseAiNudgeDecision(JSON.stringify({ decision: 'suppress' }));
    expect(parsed?.decision).toBe('suppress');
  });
});

vi.mock('../../../server/services/ai-agent/platformSettings.js', () => ({
  getPlatformAiAgentSettings: vi.fn(),
}));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({
  isAutoAnswerAllowedForWorkspace: vi.fn(),
}));
vi.mock('../../../server/services/widget/entitlements.js', () => ({
  resolveWidgetEntitlements: vi.fn(),
}));
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: vi.fn(() => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  })),
}));

const PLATFORM_ENABLED_BASE = {
  ai_proactive_nudge_enabled: true,
  ai_proactive_default_mode: 'balanced' as const,
  ai_proactive_max_per_session_ceiling: 3,
  ai_proactive_min_cooldown_seconds_ceiling: 60,
  ai_proactive_max_evaluations_per_session_ceiling: 20,
  ai_proactive_max_message_length: 220,
  ai_proactive_min_confidence_floor: 0.55,
};

describe('AI Proactive Nudge — platform ceilings always dominate workspace config', () => {
  beforeEach(() => vi.clearAllMocks());

  async function resolve(workspaceRow: Record<string, unknown>, platformOverrides: Record<string, unknown> = {}) {
    const { getPlatformAiAgentSettings } = await import('../../../server/services/ai-agent/platformSettings.js');
    const { isAutoAnswerAllowedForWorkspace } = await import('../../../server/services/ai-agent/platformGuards.js');
    const { resolveWidgetEntitlements } = await import('../../../server/services/widget/entitlements.js');
    (getPlatformAiAgentSettings as any).mockResolvedValue({ ...PLATFORM_ENABLED_BASE, ...platformOverrides });
    (isAutoAnswerAllowedForWorkspace as any).mockResolvedValue({ allowed: true });
    (resolveWidgetEntitlements as any).mockResolvedValue({ features: { widget_smart_engagement: true, ai_proactive_nudge: true } });

    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true, mode: 'balanced', ...workspaceRow }, error: null }) }) }) }),
    });

    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    return resolveEffectiveAiNudgePolicy({} as any, 'ws-1');
  }

  it('clamps a workspace max_per_session down to the platform ceiling, never up', async () => {
    const policy = await resolve({ max_per_session: 999 }, { ai_proactive_max_per_session_ceiling: 3 });
    expect(policy.maxPerSession).toBe(3);
  });

  it('clamps a workspace cooldown up to the platform minimum, never down', async () => {
    const policy = await resolve({ cooldown_seconds: 5 }, { ai_proactive_min_cooldown_seconds_ceiling: 90 });
    expect(policy.cooldownSeconds).toBeGreaterThanOrEqual(90);
  });

  it('is unavailable when the platform kill switch is off, regardless of workspace settings', async () => {
    const policy = await resolve({ enabled: true, max_per_session: 5 }, { ai_proactive_nudge_enabled: false });
    expect(policy.available).toBe(false);
    expect(policy.unavailableReason).toBe('platform_disabled');
  });

  it('is unavailable when not entitled even if the workspace row says enabled', async () => {
    const { resolveWidgetEntitlements } = await import('../../../server/services/widget/entitlements.js');
    const { getPlatformAiAgentSettings } = await import('../../../server/services/ai-agent/platformSettings.js');
    const { isAutoAnswerAllowedForWorkspace } = await import('../../../server/services/ai-agent/platformGuards.js');
    (getPlatformAiAgentSettings as any).mockResolvedValue(PLATFORM_ENABLED_BASE);
    (isAutoAnswerAllowedForWorkspace as any).mockResolvedValue({ allowed: true });
    (resolveWidgetEntitlements as any).mockResolvedValue({ features: { widget_smart_engagement: true, ai_proactive_nudge: false } });
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true, mode: 'balanced' }, error: null }) }) }) }),
    });
    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    const policy = await resolveEffectiveAiNudgePolicy({} as any, 'ws-1');
    expect(policy.available).toBe(false);
    expect(policy.unavailableReason).toBe('not_entitled');
  });

  it('fails safe-disabled (never throws) when a dependency lookup rejects', async () => {
    const { getPlatformAiAgentSettings } = await import('../../../server/services/ai-agent/platformSettings.js');
    (getPlatformAiAgentSettings as any).mockRejectedValue(new Error('db down'));
    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    const policy = await resolveEffectiveAiNudgePolicy({} as any, 'ws-1');
    expect(policy.available).toBe(false);
    expect(policy.maxPerSession).toBe(0);
  });
});

describe('AI Proactive Nudge — cross-workspace nudge_id isolation', () => {
  it('rejects an ai_nudge_id that belongs to a different workspace', async () => {
    const { recordSmartEvent } = await import('../../../server/services/widget/smartEngagement.js');
    const fakeSupabase = {
      from: (table: string) => {
        if (table === 'widget_ai_nudges') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { workspace_id: 'other-workspace' }, error: null }) }) }) };
        }
        return { insert: async () => ({ error: null }) };
      },
    };
    const result = await recordSmartEvent(fakeSupabase, {
      workspaceId: 'victim-workspace',
      source: 'ai_proactive',
      aiNudgeId: 'nudge-from-another-tenant',
      eventType: 'shown',
      idempotencyKey: 'k1',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('nudge_workspace_mismatch');
  });

  it('rejects a nudge_id that does not exist at all', async () => {
    const { recordSmartEvent } = await import('../../../server/services/widget/smartEngagement.js');
    const fakeSupabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    };
    const result = await recordSmartEvent(fakeSupabase, {
      workspaceId: 'ws-1',
      source: 'ai_proactive',
      aiNudgeId: 'does-not-exist',
      eventType: 'shown',
      idempotencyKey: 'k2',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('nudge_workspace_mismatch');
  });

  it('accepts a nudge_id that genuinely belongs to the resolved workspace', async () => {
    const { recordSmartEvent } = await import('../../../server/services/widget/smartEngagement.js');
    const fakeSupabase = {
      from: (table: string) => {
        if (table === 'widget_ai_nudges') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { workspace_id: 'ws-1' }, error: null }) }) }), update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) };
        }
        return { insert: async () => ({ error: null }) };
      },
    };
    const result = await recordSmartEvent(fakeSupabase, {
      workspaceId: 'ws-1',
      source: 'ai_proactive',
      aiNudgeId: 'genuine-nudge',
      eventType: 'shown',
      idempotencyKey: 'k3',
    });
    expect(result.ok).toBe(true);
  });
});
