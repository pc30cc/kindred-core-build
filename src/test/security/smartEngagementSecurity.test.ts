/**
 * Smart Engagement — server-side security tests.
 * No live DB: supabase clients are fake/stubbed.
 */
import { describe, it, expect } from 'vitest';
import {
  recordSmartEvent,
  loadPublicSmartRules,
} from '../../../server/services/widget/smartEngagement.ts';
import {
  validateSmartRuleForPublish,
  toPublicSmartRule,
} from '../../lib/widget/smartRules';

function fakeSupabase(tables: Record<string, any>) {
  return {
    from(table: string) {
      const impl = tables[table];
      const builder: any = {
        _filters: {} as Record<string, any>,
        select() { return builder; },
        eq(col: string, val: any) { builder._filters[col] = val; return builder; },
        gt() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle: async () => impl.maybeSingle(builder._filters),
        insert: async (row: any) => impl.insert(row),
        then(resolve: any) { return Promise.resolve(impl.select(builder._filters)).then(resolve); },
      };
      return builder;
    },
  };
}

describe('recordSmartEvent cross-workspace safety', () => {
  it('rejects an event whose rule belongs to another workspace', async () => {
    const sb = fakeSupabase({
      widget_smart_rules: {
        maybeSingle: async () => ({ data: { workspace_id: 'ws-OTHER' }, error: null }),
      },
      widget_smart_events: {
        insert: async () => ({ error: null }),
      },
    });
    const result = await recordSmartEvent(sb, {
      workspaceId: 'ws-A',
      ruleId: 'rule-1',
      eventType: 'shown',
      idempotencyKey: 'key-1',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rule_workspace_mismatch');
  });

  it('accepts an event whose rule belongs to the resolved workspace', async () => {
    const sb = fakeSupabase({
      widget_smart_rules: {
        maybeSingle: async () => ({ data: { workspace_id: 'ws-A' }, error: null }),
      },
      widget_smart_events: {
        insert: async () => ({ error: null }),
      },
    });
    const result = await recordSmartEvent(sb, {
      workspaceId: 'ws-A',
      ruleId: 'rule-1',
      eventType: 'shown',
      idempotencyKey: 'key-1',
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateSmartRuleForPublish', () => {
  it('rejects an unsafe javascript: URL, empty content and unknown schema_version', () => {
    const issues = validateSmartRuleForPublish({
      id: '00000000-0000-0000-0000-000000000001',
      workspace_id: '00000000-0000-0000-0000-000000000002',
      name: 'Test rule',
      status: 'active',
      priority: 100,
      schema_version: -1,
      trigger_config: { type: 'page_load' },
      audience_config: { match: 'all', conditions: [] },
      content_config: { default_locale: 'en', locales: {} },
      presentation_config: { mode: 'launcher_nudge', action: 'open_url', url: 'javascript:alert(1)' },
      schedule_config: {},
      frequency_config: { mode: 'once_per_session' },
      behavior_config: {},
    });
    expect(issues.length).toBeGreaterThan(0);
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('schema_version');
    expect(paths.some((p) => p.startsWith('content_config'))).toBe(true);
    expect(paths).toContain('presentation_config.url');
  });
});

describe('loadPublicSmartRules published snapshot separation', () => {
  it('never returns draft config when the published snapshot differs', async () => {
    const row = {
      id: 'rule-1',
      status: 'active',
      priority: 999,
      schema_version: 99,
      published_version: 1,
      // Draft — edited but NOT yet re-published.
      trigger_config: { type: 'time_on_page', seconds: 999 },
      audience_config: { match: 'all', conditions: [] },
      content_config: { default_locale: 'en', locales: { en: { title: 'DRAFT', body: 'draft body', cta_label: '' } } },
      presentation_config: { mode: 'launcher_nudge', action: 'none' },
      schedule_config: {},
      frequency_config: { mode: 'once_per_session' },
      behavior_config: {},
      // Published snapshot — what the visitor must actually see.
      published_priority: 5,
      published_schema_version: 1,
      published_trigger_config: { type: 'page_load' },
      published_audience_config: { match: 'all', conditions: [] },
      published_content_config: { default_locale: 'en', locales: { en: { title: 'LIVE', body: 'live body', cta_label: '' } } },
      published_presentation_config: { mode: 'launcher_nudge', action: 'none' },
      published_schedule_config: {},
      published_frequency_config: { mode: 'once_per_session' },
      published_behavior_config: {},
    };
    const sb = fakeSupabase({
      widget_smart_rules: { select: () => ({ data: [row], error: null }) },
    });
    const result = await loadPublicSmartRules(sb, 'ws-A', true);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].content_config.locales.en.body).toBe('live body');
    expect(result.rules[0].priority).toBe(5);
  });

  it('skips rows with a null published snapshot', async () => {
    const row = {
      id: 'rule-2',
      status: 'active',
      priority: 1,
      schema_version: 1,
      published_version: 1,
      published_trigger_config: null,
      published_content_config: null,
      published_presentation_config: null,
    };
    const sb = fakeSupabase({
      widget_smart_rules: { select: () => ({ data: [row], error: null }) },
    });
    const result = await loadPublicSmartRules(sb, 'ws-A', true);
    expect(result.rules).toHaveLength(0);
  });
});

describe('toPublicSmartRule sanitization', () => {
  it('strips risky URLs and HTML from the public payload', () => {
    const publicRule = toPublicSmartRule({
      id: 'rule-3',
      status: 'active',
      priority: 1,
      schema_version: 1,
      published_version: 1,
      trigger_config: { type: 'page_load' },
      audience_config: { match: 'all', conditions: [] },
      content_config: {
        default_locale: 'en',
        locales: { en: { title: '<script>alert(1)</script>Hi', body: '<img src=x onerror=alert(1)>Body', cta_label: 'Click' } },
      },
      presentation_config: { mode: 'launcher_nudge', action: 'open_url', url: 'javascript:alert(1)' },
      schedule_config: {},
      frequency_config: { mode: 'once_per_session' },
      behavior_config: {},
    });
    expect(publicRule.content_config.locales.en.title).not.toContain('<script>');
    expect(publicRule.content_config.locales.en.body).not.toContain('onerror');
    expect(publicRule.presentation_config.url).toBeNull();
  });
});
