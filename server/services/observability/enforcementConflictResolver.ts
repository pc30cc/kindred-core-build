/**
 * Phase 7.6 — Enforcement conflict resolver.
 *
 * Pure function that takes the raw set of (rule, action_type) pairs the
 * engine wants to apply and returns a normalized, deduplicated, conflict-
 * resolved set, plus a list of human-readable reasons describing every
 * change.
 *
 * Determinism rules:
 *   • Input is sorted by `rule_priority DESC, rule_slug ASC` before
 *     resolution so the output is stable across runs.
 *   • Higher-priority rules win when two rules want to apply different
 *     actions that are redundant w.r.t. each other.
 *   • The resolver is pure — same input always yields same output.
 *
 * Conflict rules implemented:
 *   1. force_polling_mode SUPERSEDES increase_reconnect_backoff
 *      (no point tuning reconnect when WS is disabled).
 *   2. force_polling_mode SUPERSEDES disable_typing_temporarily
 *      (typing is already inert in polling-only mode; keeping the
 *      action would just create extra audit noise).
 *   3. Same action_type from two rules collapses into one — the
 *      higher-priority rule "owns" the activation. The other rule
 *      is recorded as "merged_into".
 *   4. priority_only_mode + throttle_new_conversations: keep BOTH but
 *      annotate that throttling is bypassed for high-priority traffic
 *      (clients honor this via effective_policy.priority_only_mode).
 *
 * Notes:
 *   • The resolver does NOT mutate inputs.
 *   • Harmless overlaps are kept (e.g. mark_system_degraded +
 *     disable_typing_temporarily — they target different surfaces).
 */

import type { EnforcementActionType } from './enforcementEngine.js';

export interface RawEnforcementCandidate {
  rule_id: string;
  rule_slug: string;
  rule_priority: number;
  action_type: EnforcementActionType;
  scope_type: string;
  scope_key: string;
  trigger_payload: Record<string, unknown>;
}

export interface NormalizedEnforcementCandidate extends RawEnforcementCandidate {
  /** Other rule slugs that wanted the same action_type and were merged. */
  merged_with: string[];
  /** Other action_types this candidate suppressed (with reason). */
  suppressed: { action_type: EnforcementActionType; reason: string }[];
  /** Optional annotations applied to the candidate (UI hints). */
  annotations: string[];
}

export interface ResolutionReason {
  kind: 'merged' | 'suppressed' | 'annotated';
  action_type: EnforcementActionType;
  rule_slug: string;
  detail: string;
}

export interface ResolutionResult {
  raw: RawEnforcementCandidate[];
  normalized: NormalizedEnforcementCandidate[];
  reasons: ResolutionReason[];
  changed: boolean;
}

function compareCandidates(
  a: RawEnforcementCandidate,
  b: RawEnforcementCandidate,
): number {
  if (b.rule_priority !== a.rule_priority) return b.rule_priority - a.rule_priority;
  if (a.rule_slug !== b.rule_slug) return a.rule_slug < b.rule_slug ? -1 : 1;
  return a.action_type < b.action_type ? -1 : a.action_type > b.action_type ? 1 : 0;
}

/**
 * Pure conflict resolver. Never throws.
 */
export function resolveEnforcementConflicts(
  raw: RawEnforcementCandidate[],
): ResolutionResult {
  const sorted = [...raw].sort(compareCandidates);
  const reasons: ResolutionReason[] = [];

  // Stage 1 — collapse duplicates by action_type. Highest-priority wins.
  const byAction = new Map<EnforcementActionType, NormalizedEnforcementCandidate>();
  for (const c of sorted) {
    const existing = byAction.get(c.action_type);
    if (!existing) {
      byAction.set(c.action_type, {
        ...c,
        merged_with: [],
        suppressed: [],
        annotations: [],
      });
      continue;
    }
    if (existing.rule_slug === c.rule_slug) continue; // safety: same rule twice
    existing.merged_with.push(c.rule_slug);
    reasons.push({
      kind: 'merged',
      action_type: c.action_type,
      rule_slug: c.rule_slug,
      detail: `merged into rule "${existing.rule_slug}" (higher priority ${existing.rule_priority})`,
    });
  }

  // Stage 2 — supersession rules.
  const fp = byAction.get('force_polling_mode');
  if (fp) {
    const supersededByForcePolling: EnforcementActionType[] = [
      'increase_reconnect_backoff',
      'disable_typing_temporarily',
    ];
    for (const at of supersededByForcePolling) {
      const victim = byAction.get(at);
      if (!victim) continue;
      fp.suppressed.push({
        action_type: at,
        reason: `superseded by force_polling_mode (rule "${fp.rule_slug}")`,
      });
      reasons.push({
        kind: 'suppressed',
        action_type: at,
        rule_slug: victim.rule_slug,
        detail: `force_polling_mode supersedes ${at}`,
      });
      byAction.delete(at);
    }
  }

  // Stage 3 — annotations (kept, not removed).
  const pri = byAction.get('priority_only_mode');
  const throttle = byAction.get('throttle_new_conversations');
  if (pri && throttle) {
    const note = 'priority_only_mode active — throttling is bypassed for high-priority conversations';
    throttle.annotations.push(note);
    reasons.push({
      kind: 'annotated',
      action_type: 'throttle_new_conversations',
      rule_slug: throttle.rule_slug,
      detail: note,
    });
  }

  // Stable order in the output (priority desc, then slug, then action).
  const normalized = Array.from(byAction.values()).sort(compareCandidates);

  // We say `changed` when normalization removed/merged anything OR added
  // any annotation. Order-only differences are NOT considered changes.
  const rawActionTypes = new Set(raw.map((r) => `${r.action_type}|${r.rule_slug}`));
  const normalizedActionTypes = new Set(
    normalized.map((n) => `${n.action_type}|${n.rule_slug}`),
  );
  const sameMembership =
    rawActionTypes.size === normalizedActionTypes.size &&
    [...rawActionTypes].every((k) => normalizedActionTypes.has(k));
  const annotated = normalized.some((n) => n.annotations.length > 0);
  const changed = !sameMembership || annotated;

  return { raw, normalized, reasons, changed };
}