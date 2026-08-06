/**
 * Smart Engagement rule evaluator — SINGLE SOURCE OF TRUTH.
 *
 * This module is intentionally dependency-free and side-effect-free so the
 * exact same code can run in three places:
 *   1. the admin Live Preview (imported as TS),
 *   2. the widget loader on the visitor's site (bundled to
 *      `public/widget/smart-engine.js` by `scripts/build-smart-engine.mjs`),
 *   3. unit tests / server-side validation.
 *
 * Never fork this logic — extend it here and re-run the build script.
 */

export const SMART_ENGINE_SCHEMA_VERSION = 1;

export type SmartRuleStatus = 'draft' | 'active' | 'paused';

export type SmartPresentation =
  | 'launcher_nudge'
  | 'open_widget'
  | 'home_card'
  | 'chat_message'
  | 'announcement';

export type SmartActionType =
  | 'none'
  | 'open_chat'
  | 'open_home'
  | 'open_kb'
  | 'open_article'
  | 'open_url';

export type SmartTriggerType =
  | 'page_load'
  | 'time_on_page'
  | 'scroll_depth'
  | 'inactivity'
  | 'exit_intent';

export type SmartConditionField =
  | 'page_url'
  | 'page_path'
  | 'page_hostname'
  | 'referrer'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'device'
  | 'browser'
  | 'os'
  | 'locale'
  | 'visitor_type'
  | 'session_page_count'
  | 'availability';

export type SmartConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'lt';

export interface SmartAudienceCondition {
  field: SmartConditionField;
  operator: SmartConditionOperator;
  value: string;
}

export interface SmartAudienceGroup {
  match: 'all' | 'any';
  conditions: SmartAudienceCondition[];
  /** One nested level only — deeper nesting is rejected by the schema. */
  groups?: SmartAudienceGroup[];
}

export interface SmartTrigger {
  type: SmartTriggerType;
  /** seconds — time_on_page / inactivity */
  seconds?: number;
  /** 1..100 — scroll_depth */
  percent?: number;
}

export interface SmartLocaleContent {
  title?: string;
  body: string;
  cta_label?: string;
}

export interface SmartContentConfig {
  default_locale: string;
  locales: Record<string, SmartLocaleContent>;
}

export interface SmartPresentationConfig {
  mode: SmartPresentation;
  action: SmartActionType;
  /** knowledge-base article slug for `open_article` */
  article_slug?: string | null;
  /** absolute https/http url for `open_url` */
  url?: string | null;
  open_in_new_tab?: boolean;
  dismissible?: boolean;
}

export interface SmartScheduleConfig {
  start_at?: string | null;
  end_at?: string | null;
  /** 0 = Sunday … 6 = Saturday. Empty array = every day. */
  weekdays?: number[];
  /** "HH:MM" in the workspace timezone */
  time_from?: string | null;
  time_to?: string | null;
  timezone?: string | null;
}

export type SmartFrequencyMode =
  | 'always'
  | 'once_per_session'
  | 'once_per_visitor'
  | 'max_per_day'
  | 'max_per_week'
  | 'cooldown_hours';

export interface SmartFrequencyConfig {
  mode: SmartFrequencyMode;
  count?: number;
  hours?: number;
}

export interface SmartBehaviorConfig {
  stop_after_dismiss?: boolean;
  stop_after_cta?: boolean;
  stop_after_widget_open?: boolean;
  stop_after_conversation?: boolean;
  stop_after_visitor_reply?: boolean;
  /** what to do when the team is offline */
  offline_mode?: 'show' | 'hide';
  /** Never run aggressive triggers on phones. */
  mobile_enabled?: boolean;
}

export interface SmartRule {
  id: string;
  name: string;
  status: SmartRuleStatus;
  priority: number;
  schema_version?: number;
  version?: number;
  trigger_config: SmartTrigger;
  audience_config: SmartAudienceGroup;
  content_config: SmartContentConfig;
  presentation_config: SmartPresentationConfig;
  schedule_config: SmartScheduleConfig;
  frequency_config: SmartFrequencyConfig;
  behavior_config: SmartBehaviorConfig;
}

export interface SmartFrequencyState {
  shownInSession?: number;
  shownTotal?: number;
  shownToday?: number;
  shownThisWeek?: number;
  lastShownAt?: number | null;
  dismissed?: boolean;
  ctaClicked?: boolean;
}

export interface SmartEvalContext {
  masterEnabled: boolean;
  mode: 'production' | 'preview';
  page: {
    url: string;
    path: string;
    hostname: string;
    title?: string;
    query?: Record<string, string>;
  };
  referrer?: string;
  utm?: { source?: string; medium?: string; campaign?: string };
  device: 'desktop' | 'mobile' | 'tablet';
  browser?: string;
  os?: string;
  locale: string;
  visitor: {
    isReturning: boolean;
    visitCount?: number;
    sessionPageCount?: number;
  };
  availability: { online: boolean };
  interaction: {
    widgetOpen?: boolean;
    conversationActive?: boolean;
    visitorTyping?: boolean;
    callActive?: boolean;
    prechatOpen?: boolean;
    anotherRuleShowing?: boolean;
    visitorReplied?: boolean;
    widgetError?: boolean;
  };
  signals: {
    elapsedMs: number;
    scrollPercent: number;
    inactiveMs: number;
    exitIntent: boolean;
    pageHidden?: boolean;
  };
  frequency?: SmartFrequencyState;
  /** Global cooldown between two proactive surfaces (ms since last one). */
  msSinceLastSurface?: number | null;
  globalCooldownMs?: number;
}

export type SmartOutcome =
  | 'matched'
  | 'waiting'
  | 'not_matched'
  | 'suppressed'
  | 'expired'
  | 'frequency_capped'
  | 'invalid';

export type SmartReasonCode =
  | 'MASTER_DISABLED'
  | 'RULE_NOT_ACTIVE'
  | 'INVALID_RULE'
  | 'OUTSIDE_SCHEDULE'
  | 'SCHEDULE_NOT_STARTED'
  | 'SCHEDULE_EXPIRED'
  | 'AUDIENCE_MATCHED'
  | 'AUDIENCE_NOT_MATCHED'
  | 'PAGE_NOT_MATCHED'
  | 'WAITING_FOR_DELAY'
  | 'SCROLL_NOT_REACHED'
  | 'WAITING_FOR_INACTIVITY'
  | 'WAITING_FOR_EXIT_INTENT'
  | 'TRIGGER_MATCHED'
  | 'FREQUENCY_LIMITED'
  | 'ALREADY_DISMISSED'
  | 'CTA_ALREADY_CLICKED'
  | 'CONVERSATION_ACTIVE'
  | 'WIDGET_OPEN'
  | 'CALL_ACTIVE'
  | 'VISITOR_TYPING'
  | 'PRECHAT_OPEN'
  | 'OTHER_RULE_SHOWING'
  | 'PAGE_HIDDEN'
  | 'MOBILE_BLOCKED'
  | 'OFFLINE_HIDDEN'
  | 'GLOBAL_COOLDOWN'
  | 'EMPTY_CONTENT'
  | 'MATCHED';

export interface SmartReason {
  code: SmartReasonCode;
  state: 'pass' | 'pending' | 'fail';
  detail?: Record<string, string | number>;
}

export interface SmartEvalResult {
  outcome: SmartOutcome;
  reasons: SmartReason[];
}

/* ────────────────────────────── helpers ────────────────────────────── */

function lower(v: unknown): string {
  return String(v == null ? '' : v).toLowerCase();
}

function numeric(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : NaN;
}

export function compareCondition(
  actualRaw: string | number | boolean | undefined,
  operator: SmartConditionOperator,
  expectedRaw: string,
): boolean {
  if (operator === 'gt' || operator === 'lt') {
    const a = numeric(actualRaw);
    const b = numeric(expectedRaw);
    if (isNaN(a) || isNaN(b)) return false;
    return operator === 'gt' ? a > b : a < b;
  }
  const actual = lower(actualRaw);
  const expected = lower(expectedRaw).trim();
  switch (operator) {
    case 'equals': return actual === expected;
    case 'not_equals': return actual !== expected;
    case 'contains': return expected !== '' && actual.indexOf(expected) !== -1;
    case 'not_contains': return expected === '' || actual.indexOf(expected) === -1;
    case 'starts_with': return actual.indexOf(expected) === 0;
    case 'ends_with': return expected !== '' && actual.lastIndexOf(expected) === actual.length - expected.length;
    default: return false;
  }
}

function fieldValue(field: SmartConditionField, ctx: SmartEvalContext): string | number {
  switch (field) {
    case 'page_url': return ctx.page.url || '';
    case 'page_path': return ctx.page.path || '';
    case 'page_hostname': return ctx.page.hostname || '';
    case 'referrer': return ctx.referrer || '';
    case 'utm_source': return (ctx.utm && ctx.utm.source) || '';
    case 'utm_medium': return (ctx.utm && ctx.utm.medium) || '';
    case 'utm_campaign': return (ctx.utm && ctx.utm.campaign) || '';
    case 'device': return ctx.device || '';
    case 'browser': return ctx.browser || '';
    case 'os': return ctx.os || '';
    case 'locale': return ctx.locale || '';
    case 'visitor_type': return ctx.visitor.isReturning ? 'returning' : 'new';
    case 'session_page_count': return ctx.visitor.sessionPageCount || 0;
    case 'availability': return ctx.availability.online ? 'online' : 'offline';
    default: return '';
  }
}

export function evaluateAudienceGroup(group: SmartAudienceGroup | undefined, ctx: SmartEvalContext): boolean {
  if (!group) return true;
  const conditions = group.conditions || [];
  const groups = group.groups || [];
  const results: boolean[] = [];
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    results.push(compareCondition(fieldValue(c.field, ctx), c.operator, c.value));
  }
  for (let i = 0; i < groups.length; i++) {
    results.push(evaluateAudienceGroup({ match: groups[i].match, conditions: groups[i].conditions }, ctx));
  }
  if (!results.length) return true;
  return group.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

/** Minutes offset of a timezone at a given instant, DST-aware. */
function tzOffsetMinutes(timeZone: string, date: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts: Record<string, string> = {};
    dtf.formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour === '24' ? '0' : parts.hour), Number(parts.minute), Number(parts.second),
    );
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** Local wall-clock parts of `now` in the rule timezone. */
export function zonedParts(now: Date, timeZone?: string | null): { weekday: number; minutes: number } {
  const offset = timeZone ? tzOffsetMinutes(timeZone, now) : -now.getTimezoneOffset();
  const shifted = new Date(now.getTime() + offset * 60000);
  return {
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function parseHHMM(value?: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function evaluateSchedule(
  schedule: SmartScheduleConfig | undefined,
  now: Date,
): { state: 'active' | 'not_started' | 'expired' | 'outside_window' } {
  const s = schedule || {};
  const ts = now.getTime();
  if (s.start_at) {
    const start = Date.parse(s.start_at);
    if (isFinite(start) && ts < start) return { state: 'not_started' };
  }
  if (s.end_at) {
    const end = Date.parse(s.end_at);
    if (isFinite(end) && ts > end) return { state: 'expired' };
  }
  const weekdays = s.weekdays || [];
  const from = parseHHMM(s.time_from);
  const to = parseHHMM(s.time_to);
  if (weekdays.length || from !== null || to !== null) {
    const parts = zonedParts(now, s.timezone);
    if (weekdays.length && weekdays.indexOf(parts.weekday) === -1) return { state: 'outside_window' };
    if (from !== null && to !== null) {
      const inWindow = from <= to
        ? parts.minutes >= from && parts.minutes <= to
        : parts.minutes >= from || parts.minutes <= to; // overnight window
      if (!inWindow) return { state: 'outside_window' };
    }
  }
  return { state: 'active' };
}

export function evaluateFrequency(
  freq: SmartFrequencyConfig | undefined,
  state: SmartFrequencyState | undefined,
  now: Date,
): { allowed: boolean; detail?: Record<string, string | number> } {
  const f = freq || { mode: 'once_per_session' as SmartFrequencyMode };
  const st = state || {};
  switch (f.mode) {
    case 'always':
      return { allowed: true };
    case 'once_per_session':
      return { allowed: (st.shownInSession || 0) < 1, detail: { shown: st.shownInSession || 0, cap: 1 } };
    case 'once_per_visitor':
      return { allowed: (st.shownTotal || 0) < 1, detail: { shown: st.shownTotal || 0, cap: 1 } };
    case 'max_per_day': {
      const cap = Math.max(1, Number(f.count) || 1);
      return { allowed: (st.shownToday || 0) < cap, detail: { shown: st.shownToday || 0, cap } };
    }
    case 'max_per_week': {
      const cap = Math.max(1, Number(f.count) || 1);
      return { allowed: (st.shownThisWeek || 0) < cap, detail: { shown: st.shownThisWeek || 0, cap } };
    }
    case 'cooldown_hours': {
      const hours = Math.max(1, Number(f.hours) || 24);
      if (!st.lastShownAt) return { allowed: true };
      const elapsedH = (now.getTime() - st.lastShownAt) / 3600000;
      return { allowed: elapsedH >= hours, detail: { elapsed: Math.floor(elapsedH), cap: hours } };
    }
    default:
      return { allowed: true };
  }
}

function contentForLocale(rule: SmartRule, locale: string): SmartLocaleContent | null {
  const content = rule.content_config;
  if (!content || !content.locales) return null;
  const lang = String(locale || '').toLowerCase().split('-')[0];
  return content.locales[lang]
    || content.locales[content.default_locale]
    || content.locales[Object.keys(content.locales)[0]]
    || null;
}

export function resolveSmartContent(rule: SmartRule, locale: string): SmartLocaleContent | null {
  return contentForLocale(rule, locale);
}

/** Replace `{{var}}` / `{{var | default:"x"}}` with real, escaped values. */
export function renderSmartTemplate(
  input: string,
  vars: Record<string, string | undefined | null>,
): string {
  return String(input || '').replace(
    /\{\{\s*([a-z0-9_.]+)\s*(?:\|\s*default\s*:\s*"([^"]*)"\s*)?\}\}/gi,
    (_all, key: string, fallback?: string) => {
      const value = vars[key.toLowerCase()];
      const resolved = value == null || String(value).trim() === '' ? (fallback || '') : String(value);
      return resolved;
    },
  );
}

/* ───────────────────────────── evaluator ───────────────────────────── */

export function evaluateSmartRule(
  rule: SmartRule,
  ctx: SmartEvalContext,
  now: Date = new Date(),
): SmartEvalResult {
  const reasons: SmartReason[] = [];
  const fail = (code: SmartReasonCode, outcome: SmartOutcome, detail?: Record<string, string | number>): SmartEvalResult => {
    reasons.push({ code, state: 'fail', detail });
    return { outcome, reasons };
  };

  if (!rule || !rule.id || !rule.presentation_config || !rule.trigger_config) {
    return fail('INVALID_RULE', 'invalid');
  }
  if (!ctx.masterEnabled) return fail('MASTER_DISABLED', 'suppressed');
  if (rule.status !== 'active' && ctx.mode !== 'preview') {
    return fail('RULE_NOT_ACTIVE', 'suppressed', { status: rule.status });
  }

  const content = contentForLocale(rule, ctx.locale);
  if (!content || !String(content.body || '').trim()) {
    return fail('EMPTY_CONTENT', 'invalid');
  }

  // ── Schedule ──
  const sched = evaluateSchedule(rule.schedule_config, now);
  if (sched.state === 'not_started') return fail('SCHEDULE_NOT_STARTED', 'waiting');
  if (sched.state === 'expired') return fail('SCHEDULE_EXPIRED', 'expired');
  if (sched.state === 'outside_window') return fail('OUTSIDE_SCHEDULE', 'waiting');

  const behavior = rule.behavior_config || {};

  // ── Hard suppression states ──
  if (ctx.device === 'mobile' && behavior.mobile_enabled === false) {
    return fail('MOBILE_BLOCKED', 'suppressed');
  }
  if (!ctx.availability.online && behavior.offline_mode === 'hide') {
    return fail('OFFLINE_HIDDEN', 'suppressed');
  }
  const it = ctx.interaction || {};
  if (it.widgetError) return fail('OTHER_RULE_SHOWING', 'suppressed');
  if (it.callActive) return fail('CALL_ACTIVE', 'suppressed');
  if (it.prechatOpen) return fail('PRECHAT_OPEN', 'suppressed');
  if (it.visitorTyping) return fail('VISITOR_TYPING', 'suppressed');
  if (it.anotherRuleShowing) return fail('OTHER_RULE_SHOWING', 'suppressed');
  if (it.conversationActive && behavior.stop_after_conversation !== false) {
    return fail('CONVERSATION_ACTIVE', 'suppressed');
  }
  if (it.visitorReplied && behavior.stop_after_visitor_reply !== false) {
    return fail('CONVERSATION_ACTIVE', 'suppressed');
  }
  if (it.widgetOpen && behavior.stop_after_widget_open !== false && rule.presentation_config.mode !== 'home_card') {
    return fail('WIDGET_OPEN', 'suppressed');
  }
  if (ctx.signals.pageHidden) return fail('PAGE_HIDDEN', 'waiting');

  // ── Frequency + stop conditions ──
  const freqState = ctx.frequency || {};
  if (freqState.dismissed && behavior.stop_after_dismiss !== false) {
    return fail('ALREADY_DISMISSED', 'frequency_capped');
  }
  if (freqState.ctaClicked && behavior.stop_after_cta !== false) {
    return fail('CTA_ALREADY_CLICKED', 'frequency_capped');
  }
  const freq = evaluateFrequency(rule.frequency_config, freqState, now);
  if (!freq.allowed) return fail('FREQUENCY_LIMITED', 'frequency_capped', freq.detail);

  if (
    typeof ctx.msSinceLastSurface === 'number' &&
    ctx.msSinceLastSurface >= 0 &&
    ctx.msSinceLastSurface < (ctx.globalCooldownMs == null ? 20000 : ctx.globalCooldownMs)
  ) {
    return fail('GLOBAL_COOLDOWN', 'waiting');
  }

  // ── Audience ──
  if (!evaluateAudienceGroup(rule.audience_config, ctx)) {
    return fail('AUDIENCE_NOT_MATCHED', 'not_matched');
  }
  reasons.push({ code: 'AUDIENCE_MATCHED', state: 'pass' });

  // ── Trigger ──
  const trigger = rule.trigger_config;
  if (trigger.type === 'time_on_page') {
    const need = Math.max(0, Number(trigger.seconds) || 0) * 1000;
    if (ctx.signals.elapsedMs < need) {
      reasons.push({
        code: 'WAITING_FOR_DELAY',
        state: 'pending',
        detail: { elapsed: Math.floor(ctx.signals.elapsedMs / 1000), required: Math.floor(need / 1000) },
      });
      return { outcome: 'waiting', reasons };
    }
  } else if (trigger.type === 'scroll_depth') {
    const need = Math.min(100, Math.max(1, Number(trigger.percent) || 50));
    if (ctx.signals.scrollPercent < need) {
      reasons.push({
        code: 'SCROLL_NOT_REACHED',
        state: 'pending',
        detail: { current: Math.floor(ctx.signals.scrollPercent), required: need },
      });
      return { outcome: 'waiting', reasons };
    }
  } else if (trigger.type === 'inactivity') {
    const need = Math.max(1, Number(trigger.seconds) || 30) * 1000;
    if (ctx.signals.inactiveMs < need) {
      reasons.push({
        code: 'WAITING_FOR_INACTIVITY',
        state: 'pending',
        detail: { elapsed: Math.floor(ctx.signals.inactiveMs / 1000), required: Math.floor(need / 1000) },
      });
      return { outcome: 'waiting', reasons };
    }
  } else if (trigger.type === 'exit_intent') {
    if (ctx.device !== 'desktop') return fail('MOBILE_BLOCKED', 'suppressed');
    if (!ctx.signals.exitIntent) {
      reasons.push({ code: 'WAITING_FOR_EXIT_INTENT', state: 'pending' });
      return { outcome: 'waiting', reasons };
    }
  }

  reasons.push({ code: 'TRIGGER_MATCHED', state: 'pass' });
  reasons.push({ code: 'MATCHED', state: 'pass' });
  return { outcome: 'matched', reasons };
}

/**
 * Deterministic conflict resolution: highest priority wins, ties break on
 * rule id so two visitors on the same page always see the same rule.
 */
export function pickSmartRule(
  rules: SmartRule[],
  ctx: SmartEvalContext,
  now: Date = new Date(),
): { rule: SmartRule; result: SmartEvalResult } | null {
  const matched: { rule: SmartRule; result: SmartEvalResult }[] = [];
  for (let i = 0; i < (rules || []).length; i++) {
    const result = evaluateSmartRule(rules[i], ctx, now);
    if (result.outcome === 'matched') matched.push({ rule: rules[i], result });
  }
  if (!matched.length) return null;
  matched.sort((a, b) => {
    const p = (Number(b.rule.priority) || 0) - (Number(a.rule.priority) || 0);
    if (p !== 0) return p;
    return String(a.rule.id) < String(b.rule.id) ? -1 : 1;
  });
  return matched[0];
}

/** Only these protocols may ever be opened by a smart rule action. */
export function isSafeSmartUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const raw = String(url).trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  if (/^\s*javascript:/i.test(raw) || /^\s*data:/i.test(raw) || /^\s*vbscript:/i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const SmartEngine = {
  SMART_ENGINE_SCHEMA_VERSION,
  evaluateSmartRule,
  pickSmartRule,
  evaluateAudienceGroup,
  evaluateSchedule,
  evaluateFrequency,
  compareCondition,
  resolveSmartContent,
  renderSmartTemplate,
  isSafeSmartUrl,
  zonedParts,
};

export default SmartEngine;