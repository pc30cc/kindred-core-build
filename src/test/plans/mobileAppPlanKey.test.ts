// @vitest-environment node
/**
 * The mobile app is a plan feature (docs/operations/MOBILE_APP_PLAN.md,
 * "Plan"): the registry key `mobile_app` exactly as the doc defines it, and
 * on by default, so a plan that never mentions it (every plan at the
 * rollout) and a workspace without a plan keep their apps. Only a plan that
 * says false turns them off, and the snapshot both apps read
 * (GET /api/plans/workspace/:id/effective) shows exactly that.
 */
import { describe, it, expect } from 'vitest';
import { getCapability, validatePlanPayload } from '../../../server/services/billing/capabilityRegistry';
import {
  resolveEffectiveEntitlements,
  unlimitedEntitlements,
} from '../../../server/services/billing/effectiveEntitlements';

const plan = (entitlements: Record<string, unknown>) => ({ entitlements, planLimits: {}, limitOverrides: {} }) as never;

describe('mobile_app', () => {
  it('is a plan-only mobile feature, on unless a plan turns it off', () => {
    const cap = getCapability('mobile_app');
    expect(cap).toMatchObject({
      key: 'mobile_app',
      type: 'feature',
      group: 'mobile',
      label: 'Mobile App',
      defaultValue: true,
      planConfigurable: true,
      workspaceOverridable: false,
      userVisible: true,
    });
    expect(cap!.internalOnly).toBeFalsy();
    expect(cap!.deprecated).toBeFalsy();
  });

  it('a plan that never mentions it keeps the apps: the registry default', () => {
    expect(resolveEffectiveEntitlements(plan({}), [], []).features.mobile_app).toEqual({ value: true, source: 'default' });
    expect(resolveEffectiveEntitlements(plan({ team_calls: true, mobile_promo_banner: true }), [], []).features.mobile_app)
      .toEqual({ value: true, source: 'default' });
  });

  it('only the plan saying false turns them off, read the way Postgres reads it', () => {
    expect(resolveEffectiveEntitlements(plan({ mobile_app: false }), [], []).features.mobile_app).toEqual({ value: false, source: 'plan' });
    expect(resolveEffectiveEntitlements(plan({ mobile_app: 'false' }), [], []).features.mobile_app.value).toBe(false);
    expect(resolveEffectiveEntitlements(plan({ mobile_app: true }), [], []).features.mobile_app).toEqual({ value: true, source: 'plan' });
  });

  it('takes no per-workspace override: an override row of the same name changes nothing', () => {
    const snapshot = resolveEffectiveEntitlements(
      plan({ mobile_app: false }),
      [{ module_key: 'mobile_app', enabled: true }],
      [{ channel_key: 'mobile_app', enabled: true }],
    );
    expect(snapshot.features.mobile_app).toEqual({ value: false, source: 'plan' });
  });

  it('a self-host install without billing is shown it on, like everything', () => {
    expect(unlimitedEntitlements().features.mobile_app.value).toBe(true);
  });

  it('is a plan toggle the plan editor may save: a boolean in entitlements', () => {
    expect(validatePlanPayload({ entitlements: { mobile_app: false } })).toEqual({ valid: true, issues: [] });
    const wrong = validatePlanPayload({ entitlements: { mobile_app: 'off' } });
    expect(wrong.valid).toBe(false);
    expect(wrong.issues.map((i) => i.code)).toEqual(['entitlement_not_boolean']);
    expect(validatePlanPayload({ limits: { mobile_app: 0 } }).issues.map((i) => i.code)).toEqual(['not_a_limit']);
  });
});
