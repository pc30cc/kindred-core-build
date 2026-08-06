/* GENERATED FILE - do not edit. Source: src/lib/widget/smartEngine.ts
   Regenerate with: node scripts/build-smart-engine.mjs */
var __gs_smart_engine_module = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/lib/widget/smartEngine.ts
  var smartEngine_exports = {};
  __export(smartEngine_exports, {
    SMART_ENGINE_SCHEMA_VERSION: () => SMART_ENGINE_SCHEMA_VERSION,
    SmartEngine: () => SmartEngine,
    compareCondition: () => compareCondition,
    default: () => smartEngine_default,
    evaluateAudienceGroup: () => evaluateAudienceGroup,
    evaluateFrequency: () => evaluateFrequency,
    evaluateSchedule: () => evaluateSchedule,
    evaluateSmartRule: () => evaluateSmartRule,
    isSafeSmartUrl: () => isSafeSmartUrl,
    pickSmartRule: () => pickSmartRule,
    renderSmartTemplate: () => renderSmartTemplate,
    resolveSmartContent: () => resolveSmartContent,
    zonedParts: () => zonedParts
  });
  var SMART_ENGINE_SCHEMA_VERSION = 1;
  function lower(v) {
    return String(v == null ? "" : v).toLowerCase();
  }
  function numeric(v) {
    const n = Number(v);
    return isFinite(n) ? n : NaN;
  }
  function compareCondition(actualRaw, operator, expectedRaw) {
    if (operator === "gt" || operator === "lt") {
      const a = numeric(actualRaw);
      const b = numeric(expectedRaw);
      if (isNaN(a) || isNaN(b)) return false;
      return operator === "gt" ? a > b : a < b;
    }
    const actual = lower(actualRaw);
    const expected = lower(expectedRaw).trim();
    switch (operator) {
      case "equals":
        return actual === expected;
      case "not_equals":
        return actual !== expected;
      case "contains":
        return expected !== "" && actual.indexOf(expected) !== -1;
      case "not_contains":
        return expected === "" || actual.indexOf(expected) === -1;
      case "starts_with":
        return actual.indexOf(expected) === 0;
      case "ends_with":
        return expected !== "" && actual.lastIndexOf(expected) === actual.length - expected.length;
      default:
        return false;
    }
  }
  function fieldValue(field, ctx) {
    switch (field) {
      case "page_url":
        return ctx.page.url || "";
      case "page_path":
        return ctx.page.path || "";
      case "page_hostname":
        return ctx.page.hostname || "";
      case "referrer":
        return ctx.referrer || "";
      case "utm_source":
        return ctx.utm && ctx.utm.source || "";
      case "utm_medium":
        return ctx.utm && ctx.utm.medium || "";
      case "utm_campaign":
        return ctx.utm && ctx.utm.campaign || "";
      case "device":
        return ctx.device || "";
      case "browser":
        return ctx.browser || "";
      case "os":
        return ctx.os || "";
      case "locale":
        return ctx.locale || "";
      case "visitor_type":
        return ctx.visitor.isReturning ? "returning" : "new";
      case "session_page_count":
        return ctx.visitor.sessionPageCount || 0;
      case "availability":
        return ctx.availability.online ? "online" : "offline";
      default:
        return "";
    }
  }
  function evaluateAudienceGroup(group, ctx) {
    if (!group) return true;
    const conditions = group.conditions || [];
    const groups = group.groups || [];
    const results = [];
    for (let i = 0; i < conditions.length; i++) {
      const c = conditions[i];
      results.push(compareCondition(fieldValue(c.field, ctx), c.operator, c.value));
    }
    for (let i = 0; i < groups.length; i++) {
      results.push(evaluateAudienceGroup({ match: groups[i].match, conditions: groups[i].conditions }, ctx));
    }
    if (!results.length) return true;
    return group.match === "any" ? results.some(Boolean) : results.every(Boolean);
  }
  function tzOffsetMinutes(timeZone, date) {
    try {
      const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
      const parts = {};
      dtf.formatToParts(date).forEach((p) => {
        parts[p.type] = p.value;
      });
      const asUTC = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour === "24" ? "0" : parts.hour),
        Number(parts.minute),
        Number(parts.second)
      );
      return Math.round((asUTC - date.getTime()) / 6e4);
    } catch (e) {
      return 0;
    }
  }
  function zonedParts(now, timeZone) {
    const offset = timeZone ? tzOffsetMinutes(timeZone, now) : -now.getTimezoneOffset();
    const shifted = new Date(now.getTime() + offset * 6e4);
    return {
      weekday: shifted.getUTCDay(),
      minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
    };
  }
  function parseHHMM(value) {
    if (!value) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  function evaluateSchedule(schedule, now) {
    const s = schedule || {};
    const ts = now.getTime();
    if (s.start_at) {
      const start = Date.parse(s.start_at);
      if (isFinite(start) && ts < start) return { state: "not_started" };
    }
    if (s.end_at) {
      const end = Date.parse(s.end_at);
      if (isFinite(end) && ts > end) return { state: "expired" };
    }
    const weekdays = s.weekdays || [];
    const from = parseHHMM(s.time_from);
    const to = parseHHMM(s.time_to);
    if (weekdays.length || from !== null || to !== null) {
      const parts = zonedParts(now, s.timezone);
      if (weekdays.length && weekdays.indexOf(parts.weekday) === -1) return { state: "outside_window" };
      if (from !== null && to !== null) {
        const inWindow = from <= to ? parts.minutes >= from && parts.minutes <= to : parts.minutes >= from || parts.minutes <= to;
        if (!inWindow) return { state: "outside_window" };
      }
    }
    return { state: "active" };
  }
  function evaluateFrequency(freq, state, now) {
    const f = freq || { mode: "once_per_session" };
    const st = state || {};
    switch (f.mode) {
      case "always":
        return { allowed: true };
      case "once_per_session":
        return { allowed: (st.shownInSession || 0) < 1, detail: { shown: st.shownInSession || 0, cap: 1 } };
      case "once_per_visitor":
        return { allowed: (st.shownTotal || 0) < 1, detail: { shown: st.shownTotal || 0, cap: 1 } };
      case "max_per_day": {
        const cap = Math.max(1, Number(f.count) || 1);
        return { allowed: (st.shownToday || 0) < cap, detail: { shown: st.shownToday || 0, cap } };
      }
      case "max_per_week": {
        const cap = Math.max(1, Number(f.count) || 1);
        return { allowed: (st.shownThisWeek || 0) < cap, detail: { shown: st.shownThisWeek || 0, cap } };
      }
      case "cooldown_hours": {
        const hours = Math.max(1, Number(f.hours) || 24);
        if (!st.lastShownAt) return { allowed: true };
        const elapsedH = (now.getTime() - st.lastShownAt) / 36e5;
        return { allowed: elapsedH >= hours, detail: { elapsed: Math.floor(elapsedH), cap: hours } };
      }
      default:
        return { allowed: true };
    }
  }
  function contentForLocale(rule, locale) {
    const content = rule.content_config;
    if (!content || !content.locales) return null;
    const lang = String(locale || "").toLowerCase().split("-")[0];
    return content.locales[lang] || content.locales[content.default_locale] || content.locales[Object.keys(content.locales)[0]] || null;
  }
  function resolveSmartContent(rule, locale) {
    return contentForLocale(rule, locale);
  }
  function renderSmartTemplate(input, vars) {
    return String(input || "").replace(
      /\{\{\s*([a-z0-9_.]+)\s*(?:\|\s*default\s*:\s*"([^"]*)"\s*)?\}\}/gi,
      (_all, key, fallback) => {
        const value = vars[key.toLowerCase()];
        const resolved = value == null || String(value).trim() === "" ? fallback || "" : String(value);
        return resolved;
      }
    );
  }
  function evaluateSmartRule(rule, ctx, now = /* @__PURE__ */ new Date()) {
    const reasons = [];
    const fail = (code, outcome, detail) => {
      reasons.push({ code, state: "fail", detail });
      return { outcome, reasons };
    };
    if (!rule || !rule.id || !rule.presentation_config || !rule.trigger_config) {
      return fail("INVALID_RULE", "invalid");
    }
    if (!ctx.masterEnabled) return fail("MASTER_DISABLED", "suppressed");
    if (rule.status !== "active" && ctx.mode !== "preview") {
      return fail("RULE_NOT_ACTIVE", "suppressed", { status: rule.status });
    }
    const content = contentForLocale(rule, ctx.locale);
    if (!content || !String(content.body || "").trim()) {
      return fail("EMPTY_CONTENT", "invalid");
    }
    const sched = evaluateSchedule(rule.schedule_config, now);
    if (sched.state === "not_started") return fail("SCHEDULE_NOT_STARTED", "waiting");
    if (sched.state === "expired") return fail("SCHEDULE_EXPIRED", "expired");
    if (sched.state === "outside_window") return fail("OUTSIDE_SCHEDULE", "waiting");
    const behavior = rule.behavior_config || {};
    if (ctx.device === "mobile" && behavior.mobile_enabled === false) {
      return fail("MOBILE_BLOCKED", "suppressed");
    }
    if (!ctx.availability.online && behavior.offline_mode === "hide") {
      return fail("OFFLINE_HIDDEN", "suppressed");
    }
    const it = ctx.interaction || {};
    if (it.widgetError) return fail("OTHER_RULE_SHOWING", "suppressed");
    if (it.callActive) return fail("CALL_ACTIVE", "suppressed");
    if (it.prechatOpen) return fail("PRECHAT_OPEN", "suppressed");
    if (it.visitorTyping) return fail("VISITOR_TYPING", "suppressed");
    if (it.anotherRuleShowing) return fail("OTHER_RULE_SHOWING", "suppressed");
    if (it.conversationActive && behavior.stop_after_conversation !== false) {
      return fail("CONVERSATION_ACTIVE", "suppressed");
    }
    if (it.visitorReplied && behavior.stop_after_visitor_reply !== false) {
      return fail("CONVERSATION_ACTIVE", "suppressed");
    }
    if (it.widgetOpen && behavior.stop_after_widget_open !== false && rule.presentation_config.mode !== "home_card") {
      return fail("WIDGET_OPEN", "suppressed");
    }
    if (ctx.signals.pageHidden) return fail("PAGE_HIDDEN", "waiting");
    const freqState = ctx.frequency || {};
    if (freqState.dismissed && behavior.stop_after_dismiss !== false) {
      return fail("ALREADY_DISMISSED", "frequency_capped");
    }
    if (freqState.ctaClicked && behavior.stop_after_cta !== false) {
      return fail("CTA_ALREADY_CLICKED", "frequency_capped");
    }
    const freq = evaluateFrequency(rule.frequency_config, freqState, now);
    if (!freq.allowed) return fail("FREQUENCY_LIMITED", "frequency_capped", freq.detail);
    if (typeof ctx.msSinceLastSurface === "number" && ctx.msSinceLastSurface >= 0 && ctx.msSinceLastSurface < (ctx.globalCooldownMs == null ? 2e4 : ctx.globalCooldownMs)) {
      return fail("GLOBAL_COOLDOWN", "waiting");
    }
    if (!evaluateAudienceGroup(rule.audience_config, ctx)) {
      return fail("AUDIENCE_NOT_MATCHED", "not_matched");
    }
    reasons.push({ code: "AUDIENCE_MATCHED", state: "pass" });
    const trigger = rule.trigger_config;
    if (trigger.type === "time_on_page") {
      const need = Math.max(0, Number(trigger.seconds) || 0) * 1e3;
      if (ctx.signals.elapsedMs < need) {
        reasons.push({
          code: "WAITING_FOR_DELAY",
          state: "pending",
          detail: { elapsed: Math.floor(ctx.signals.elapsedMs / 1e3), required: Math.floor(need / 1e3) }
        });
        return { outcome: "waiting", reasons };
      }
    } else if (trigger.type === "scroll_depth") {
      const need = Math.min(100, Math.max(1, Number(trigger.percent) || 50));
      if (ctx.signals.scrollPercent < need) {
        reasons.push({
          code: "SCROLL_NOT_REACHED",
          state: "pending",
          detail: { current: Math.floor(ctx.signals.scrollPercent), required: need }
        });
        return { outcome: "waiting", reasons };
      }
    } else if (trigger.type === "inactivity") {
      const need = Math.max(1, Number(trigger.seconds) || 30) * 1e3;
      if (ctx.signals.inactiveMs < need) {
        reasons.push({
          code: "WAITING_FOR_INACTIVITY",
          state: "pending",
          detail: { elapsed: Math.floor(ctx.signals.inactiveMs / 1e3), required: Math.floor(need / 1e3) }
        });
        return { outcome: "waiting", reasons };
      }
    } else if (trigger.type === "exit_intent") {
      if (ctx.device !== "desktop") return fail("MOBILE_BLOCKED", "suppressed");
      if (!ctx.signals.exitIntent) {
        reasons.push({ code: "WAITING_FOR_EXIT_INTENT", state: "pending" });
        return { outcome: "waiting", reasons };
      }
    }
    reasons.push({ code: "TRIGGER_MATCHED", state: "pass" });
    reasons.push({ code: "MATCHED", state: "pass" });
    return { outcome: "matched", reasons };
  }
  function pickSmartRule(rules, ctx, now = /* @__PURE__ */ new Date()) {
    const matched = [];
    for (let i = 0; i < (rules || []).length; i++) {
      const result = evaluateSmartRule(rules[i], ctx, now);
      if (result.outcome === "matched") matched.push({ rule: rules[i], result });
    }
    if (!matched.length) return null;
    matched.sort((a, b) => {
      const p = (Number(b.rule.priority) || 0) - (Number(a.rule.priority) || 0);
      if (p !== 0) return p;
      return String(a.rule.id) < String(b.rule.id) ? -1 : 1;
    });
    return matched[0];
  }
  function isSafeSmartUrl(url) {
    if (!url) return false;
    const raw = String(url).trim();
    if (!/^https?:\/\//i.test(raw)) return false;
    if (/^\s*javascript:/i.test(raw) || /^\s*data:/i.test(raw) || /^\s*vbscript:/i.test(raw)) return false;
    try {
      const parsed = new URL(raw);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (e) {
      return false;
    }
  }
  var SmartEngine = {
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
    zonedParts
  };
  var smartEngine_default = SmartEngine;
  return __toCommonJS(smartEngine_exports);
})();
window.__gs_smart_engine = __gs_smart_engine_module.SmartEngine || __gs_smart_engine_module.default;
