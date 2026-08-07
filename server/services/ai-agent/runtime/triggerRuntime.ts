/**
 * AI Agent — C2B Message Trigger runtime evaluator (safe).
 *
 * Pure evaluator. Returns RuntimeActions; the caller (engine / actionExecutor)
 * is responsible for executing safe actions and persisting metadata.
 *
 * Supported events:
 *   after_prechat | visitor_first_message | ai_no_answer | human_requested
 *   topic_detected | business_hours_closed | no_operator_online
 *
 * Supported actions executed in C2B:
 *   - send_message  (static template, optional continue_ai)
 *   - handoff       (delegated to engine; flagged via .executed)
 *
 * All other actions are planned-only (workflow_planned, tag_planned, ...).
 */
import type { MessageTrigger } from '../runtimeConfig.js';
import type { RuntimeEvaluationContext, RuntimeAction } from './types.js';
import { readRuntimeFlags } from './conversationState.js';
import { textMatchesLocale } from '../../platformRegion.js';

export type TriggerEventType =
  | 'after_prechat'
  | 'visitor_first_message'
  | 'ai_no_answer'
  | 'human_requested'
  | 'topic_detected'
  | 'business_hours_closed'
  | 'no_operator_online';

export interface TriggerEvaluationResult {
  actions: RuntimeAction[];
  matchedTriggerIds: string[];
  matchedTriggerNames: string[];
  executed: RuntimeAction[];
  planned: RuntimeAction[];
  skipped: RuntimeAction[];
}

const SUPPORTED_CONDITION_KEYS = new Set([
  'topic_slug', 'topic', 'language', 'input_language', 'response_language',
  'page_url_contains', 'confidence_below',
  'business_hours_open', 'has_email', 'visitor_email_exists',
]);

function emailFromCtx(ctx: RuntimeEvaluationContext): string | null {
  const p = (ctx.prechat || {}) as any;
  const cs = ctx.conversationState as any;
  const fromMeta = cs?._metadata?.contact_email || cs?._metadata?.visitor_email;
  return p?.email || fromMeta || null;
}

function conditionsMatch(trigger: MessageTrigger, ctx: RuntimeEvaluationContext): {
  matched: boolean;
  unsupported: string[];
} {
  const cond = (trigger.conditions_json as any) || {};
  const keys = Object.keys(cond);
  const unsupported: string[] = [];
  if (keys.length === 0) return { matched: true, unsupported };

  for (const k of keys) {
    const v = cond[k];
    if (!SUPPORTED_CONDITION_KEYS.has(k)) {
      unsupported.push(k);
      continue;
    }
    switch (k) {
      case 'topic_slug':
      case 'topic': {
        const want = String(v || '').toLowerCase();
        if (!want) break;
        const top = ctx.topTopic?.slug?.toLowerCase();
        const any = (ctx.detectedTopics || []).some(
          (t) => t.slug?.toLowerCase() === want || (t as any).name?.toLowerCase?.() === want,
        );
        if (top !== want && !any) return { matched: false, unsupported };
        break;
      }
      case 'language':
      case 'input_language': {
        const want = String(v || '').toLowerCase();
        if (!want) break;
        if (ctx.inputLanguage?.toLowerCase() !== want && k === 'input_language') return { matched: false, unsupported };
        if (k === 'language' && ctx.inputLanguage?.toLowerCase() !== want && ctx.responseLanguage?.toLowerCase() !== want) {
          return { matched: false, unsupported };
        }
        break;
      }
      case 'response_language': {
        const want = String(v || '').toLowerCase();
        if (want && ctx.responseLanguage?.toLowerCase() !== want) return { matched: false, unsupported };
        break;
      }
      case 'page_url_contains': {
        const want = String(v || '');
        if (!want) break;
        const url = ctx.currentPageUrl || '';
        if (!url.toLowerCase().includes(want.toLowerCase())) return { matched: false, unsupported };
        break;
      }
      case 'confidence_below': {
        const threshold = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(threshold)) break;
        const c = ctx.answerStrategy?.confidence;
        if (typeof c !== 'number' || !(c < threshold)) return { matched: false, unsupported };
        break;
      }
      case 'has_email':
      case 'visitor_email_exists': {
        const want = v === undefined ? true : !!v;
        const has = !!emailFromCtx(ctx);
        if (has !== want) return { matched: false, unsupported };
        break;
      }
      case 'business_hours_open':
        // Not wired in C2B — treat as soft skip (do not block match if absent).
        break;
    }
  }
  return { matched: true, unsupported };
}

export function pickTranslated(
  source: { message?: string; template?: string; translations?: Record<string, string> } | null | undefined,
  locale: string | undefined,
): string | null {
  if (!source) return null;
  const t = source.translations || {};
  const l = (locale || 'en').toLowerCase();
  for (const c of [l, l.split('-')[0], 'en']) {
    if (t[c]) return t[c];
  }
  if (typeof source.message === 'string' && source.message.trim()) return source.message;
  if (typeof source.template === 'string' && source.template.trim()) return source.template;
  const first = Object.values(t).find((x) => typeof x === 'string' && x.trim());
  return first || null;
}

export function evaluateMessageTriggers(
  ctx: RuntimeEvaluationContext,
  eventType: TriggerEventType,
): TriggerEvaluationResult {
  const out: TriggerEvaluationResult = {
    actions: [], matchedTriggerIds: [], matchedTriggerNames: [],
    executed: [], planned: [], skipped: [],
  };
  const triggers = ctx.runtimeConfig?.messageTriggers || [];
  if (!triggers.length) return out;

  const flags = readRuntimeFlags((ctx.conversationState as any)?._metadata);

  for (const trig of triggers) {
    if (!trig.enabled) continue;
    if (trig.event_type !== eventType) continue;

    const { matched, unsupported } = (() => {
      try { return conditionsMatch(trig, ctx); }
      catch { return { matched: false, unsupported: [] as string[] }; }
    })();
    if (!matched) continue;

    out.matchedTriggerIds.push(trig.id);
    out.matchedTriggerNames.push(trig.name);
    console.log('[ai-agent.runtime.trigger] matched', { id: trig.id, name: trig.name, event: eventType });

    const payload = (trig.action_json as any) || {};
    const runOncePerConversation = payload.run_once_per_conversation !== false;
    const dedupePlanned = payload.dedupe_planned === true;

    if (runOncePerConversation && flags.triggerExecutedIds.includes(trig.id)) {
      const sk: RuntimeAction = {
        type: 'skip', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
        reason: trig.action_type, executed: false, skippedReason: 'duplicate_trigger',
      };
      out.actions.push(sk); out.skipped.push(sk);
      console.log('[ai-agent.runtime.trigger] skipped', { id: trig.id, reason: 'duplicate_trigger' });
      continue;
    }

    if (unsupported.length) {
      console.log('[ai-agent.runtime.trigger] skipped_unsupported_conditions', { id: trig.id, unsupported });
    }

    switch (trig.action_type) {
      case 'send_message': {
        const body = pickTranslated(payload, ctx.responseLanguage);
        if (!body) {
          const sk: RuntimeAction = {
            type: 'skip', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
            reason: 'send_message', executed: false, skippedReason: 'empty_message',
          };
          out.actions.push(sk); out.skipped.push(sk);
          break;
        }
        // Content authored in one language only (no per-locale translations
        // set up) must never leak verbatim to a visitor expecting a
        // different language — e.g. a trigger typed only in Turkish firing
        // as-is on a Persian response. Same script-based heuristic already
        // used to keep the AI intro from leaking the wrong language.
        if (!textMatchesLocale(body, ctx.responseLanguage)) {
          const sk: RuntimeAction = {
            type: 'skip', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
            reason: 'send_message', executed: false, skippedReason: 'language_mismatch',
          };
          out.actions.push(sk); out.skipped.push(sk);
          console.log('[ai-agent.runtime.trigger] skipped_language_mismatch', { id: trig.id, responseLanguage: ctx.responseLanguage });
          break;
        }
        const continueAi = payload.continue_ai === true;
        const a: RuntimeAction = {
          type: 'reply_template', source: 'message_trigger',
          sourceId: trig.id, sourceName: trig.name,
          reason: eventType,
          payload: { body, continue_ai: continueAi, event_type: eventType, action_type: 'send_message' },
          executed: true, // engine will perform insertion
        };
        out.actions.push(a); out.executed.push(a);
        console.log('[ai-agent.runtime.trigger] planned-execute send_message', { id: trig.id, continueAi });
        break;
      }
      case 'handoff': {
        if (flags.handoffSent) {
          const sk: RuntimeAction = {
            type: 'skip', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
            reason: 'handoff', executed: false, skippedReason: 'handoff_already_sent',
          };
          out.actions.push(sk); out.skipped.push(sk);
          break;
        }
        const a: RuntimeAction = {
          type: 'handoff', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
          reason: eventType, payload: { event_type: eventType, action_type: 'handoff', ...payload },
          executed: true,
        };
        out.actions.push(a); out.executed.push(a);
        break;
      }
      case 'start_workflow': {
        const a: RuntimeAction = {
          type: 'workflow_planned', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
          reason: eventType, payload: { workflow_id: payload.workflow_id || null, event_type: eventType },
          executed: false, skippedReason: 'workflow_runtime_disabled',
        };
        out.actions.push(a); out.planned.push(a);
        break;
      }
      case 'assign': {
        const a: RuntimeAction = {
          type: 'assign_team_planned', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
          reason: eventType, payload, executed: false, skippedReason: 'assignment_runtime_disabled',
        };
        out.actions.push(a); out.planned.push(a);
        break;
      }
      case 'tag': {
        const a: RuntimeAction = {
          type: 'tag_planned', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
          reason: eventType, payload, executed: false, skippedReason: 'tag_runtime_disabled',
        };
        out.actions.push(a); out.planned.push(a);
        break;
      }
      case 'internal_note': {
        const a: RuntimeAction = {
          type: 'internal_note_planned', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
          reason: eventType, payload, executed: false, skippedReason: 'internal_note_runtime_disabled',
        };
        out.actions.push(a); out.planned.push(a);
        break;
      }
      default: {
        const sk: RuntimeAction = {
          type: 'skip', source: 'message_trigger', sourceId: trig.id, sourceName: trig.name,
          reason: trig.action_type, executed: false,
          skippedReason: `unsupported_action:${trig.action_type}`,
        };
        out.actions.push(sk); out.skipped.push(sk);
      }
    }

    // Note: executed dedupe append is performed by engine after side-effects;
    // planned dedupe (if requested) handled by workflow runtime / engine.
    if (dedupePlanned) {
      // Marker only — engine will persist planned ids when relevant.
    }
  }

  return out;
}

export function buildTriggerMetadata(result: TriggerEvaluationResult) {
  return {
    matched: result.matchedTriggerIds.map((id, i) => ({
      id, name: result.matchedTriggerNames[i] || id,
    })),
    executed: result.executed.map((a) => ({
      id: a.sourceId, name: a.sourceName, action_type: actionTypeOf(a),
      messageId: (a.payload as any)?.messageId || null,
    })),
    planned: result.planned.map((a) => ({
      id: a.sourceId, name: a.sourceName, action_type: actionTypeOf(a),
      reason: a.skippedReason || a.reason || null,
    })),
    skipped: result.skipped.map((a) => ({
      id: a.sourceId, name: a.sourceName, reason: a.skippedReason || a.reason || null,
    })),
  };
}

function actionTypeOf(a: RuntimeAction): string {
  if (a.type === 'reply_template') return 'send_message';
  if (a.type === 'handoff') return 'handoff';
  if (a.type === 'workflow_planned') return 'start_workflow';
  if (a.type === 'assign_team_planned') return 'assign';
  if (a.type === 'tag_planned') return 'tag';
  if (a.type === 'internal_note_planned') return 'internal_note';
  return a.type;
}