/* GENERATED FILE - do not edit. Sources: src/lib/widget/smartEngine.ts (the engine),
   src/lib/widget/smartClient.js (the visitor side, appended as it is).
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
    AI_JOURNEY_MAX_PAGES: () => AI_JOURNEY_MAX_PAGES,
    AI_MODE_DEFAULTS: () => AI_MODE_DEFAULTS,
    SMART_ENGINE_SCHEMA_VERSION: () => SMART_ENGINE_SCHEMA_VERSION,
    SmartEngine: () => SmartEngine,
    compareCondition: () => compareCondition,
    computeAiProactiveFingerprint: () => computeAiProactiveFingerprint,
    computeAiProactiveScore: () => computeAiProactiveScore,
    default: () => smartEngine_default,
    evaluateAiProactiveEligibility: () => evaluateAiProactiveEligibility,
    evaluateAudienceGroup: () => evaluateAudienceGroup,
    evaluateFrequency: () => evaluateFrequency,
    evaluateSchedule: () => evaluateSchedule,
    evaluateSmartRule: () => evaluateSmartRule,
    isSafeSmartUrl: () => isSafeSmartUrl,
    matchesPathPattern: () => matchesPathPattern,
    normalizeTopicFromPath: () => normalizeTopicFromPath,
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
      // The length check first: a value one character shorter than the
      // suffix, and without it, has lastIndexOf -1 === length - expected.length.
      case "ends_with":
        return expected !== "" && actual.length >= expected.length && actual.lastIndexOf(expected) === actual.length - expected.length;
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
  var AI_JOURNEY_MAX_PAGES = 12;
  var AI_MODE_THRESHOLDS = {
    off: Infinity,
    conservative: 70,
    balanced: 45,
    active: 25
  };
  var AI_MODE_DEFAULTS = {
    conservative: { maxPerSession: 1, cooldownSeconds: 180 },
    balanced: { maxPerSession: 2, cooldownSeconds: 120 },
    active: { maxPerSession: 3, cooldownSeconds: 90 }
  };
  function normalizePath(path) {
    const p = String(path || "/").split("?")[0].split("#")[0];
    return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p || "/";
  }
  function normalizeTopicFromPath(path) {
    const p = normalizePath(path);
    const seg = p.split("/").filter(Boolean)[0] || "home";
    return seg.toLowerCase().slice(0, 40);
  }
  function matchesPathPattern(path, pattern) {
    const p = normalizePath(path);
    const raw = String(pattern || "").trim();
    if (!raw) return false;
    if (raw.endsWith("*")) {
      const prefix = normalizePath(raw.slice(0, -1) || "/");
      return p === prefix || p.startsWith(prefix === "/" ? "/" : prefix + "/") || p.startsWith(prefix);
    }
    return p === normalizePath(raw);
  }
  function isPathTargeted(path, config) {
    const excludes = config.excludePaths || [];
    for (let i = 0; i < excludes.length; i++) {
      if (matchesPathPattern(path, excludes[i])) return false;
    }
    const includes = config.includePaths || [];
    if (!includes.length) return true;
    for (let i = 0; i < includes.length; i++) {
      if (matchesPathPattern(path, includes[i])) return true;
    }
    return false;
  }
  function computeAiProactiveScore(ctx, journey) {
    let score = 0;
    if (ctx.visitor.isReturning) score += 15;
    if (ctx.signals.elapsedMs >= 45e3) score += 15;
    if (ctx.signals.scrollPercent >= 70) score += 10;
    if ((ctx.visitor.sessionPageCount || 0) >= 3) score += 10;
    const recent = journey.recentPages || [];
    const currentNorm = normalizePath(journey.current.path);
    const revisitedCurrent = recent.some((p) => normalizePath(p.path) === currentNorm && p.ts < journey.current.ts);
    if (revisitedCurrent) score += 20;
    const distinctPaths = new Set(recent.map((p) => normalizePath(p.path)));
    distinctPaths.add(currentNorm);
    if (distinctPaths.size >= 3) score += 20;
    const topic = normalizeTopicFromPath(journey.current.path);
    const prev = journey.previousNudge;
    if (prev && prev.topic === topic && prev.dismissed) score -= 50;
    return score;
  }
  function computeAiProactiveFingerprint(journey) {
    const topic = normalizeTopicFromPath(journey.current.path);
    const pageCount = journey.sessionPageCount || 0;
    const distinct = Array.from(new Set((journey.recentPages || []).map((p) => normalizePath(p.path)))).sort().join(",");
    return `${topic}|${pageCount}|${distinct}`;
  }
  function evaluateAiProactiveEligibility(config, ctx, journey, freqState, now = /* @__PURE__ */ new Date()) {
    const fingerprint = computeAiProactiveFingerprint(journey);
    const topicBucket = normalizeTopicFromPath(journey.current.path);
    const fail = (reason, score2 = 0) => {
      var _a;
      return {
        eligible: false,
        score: score2,
        threshold: (_a = AI_MODE_THRESHOLDS[config.mode]) != null ? _a : Infinity,
        fingerprint,
        topicBucket,
        reasons: [reason]
      };
    };
    if (!ctx.masterEnabled) return fail("MASTER_DISABLED");
    if (config.mode === "off") return fail("AI_MODE_OFF");
    const it = ctx.interaction || {};
    if (it.widgetError) return fail("OTHER_RULE_SHOWING");
    if (it.callActive) return fail("CALL_ACTIVE");
    if (it.prechatOpen) return fail("PRECHAT_OPEN");
    if (it.visitorTyping) return fail("VISITOR_TYPING");
    if (it.anotherRuleShowing) return fail("OTHER_RULE_SHOWING");
    if (it.conversationActive && config.stopAfterConversation !== false) return fail("CONVERSATION_ACTIVE");
    if (it.visitorReplied) return fail("CONVERSATION_ACTIVE");
    if (it.widgetOpen && config.stopAfterWidgetOpen !== false) return fail("WIDGET_OPEN");
    if (ctx.signals.pageHidden) return fail("PAGE_HIDDEN");
    if (ctx.device === "mobile" && config.mobileEnabled === false) return fail("MOBILE_BLOCKED");
    if (!isPathTargeted(journey.current.path, config)) {
      const excludes = config.excludePaths || [];
      const isExcluded = excludes.some((p) => matchesPathPattern(journey.current.path, p));
      return fail(isExcluded ? "AI_PATH_EXCLUDED" : "AI_PATH_NOT_INCLUDED");
    }
    const fs = freqState || {};
    const dismissedTopics = fs.dismissedTopics || [];
    if (config.stopAfterDismiss !== false && dismissedTopics.indexOf(topicBucket) !== -1) {
      return fail("AI_TOPIC_DISMISSED");
    }
    if ((fs.shownInSession || 0) >= Math.max(0, config.maxPerSession)) return fail("AI_MAX_PER_SESSION");
    if (fs.lastShownAt) {
      const elapsedS = (now.getTime() - fs.lastShownAt) / 1e3;
      if (elapsedS < Math.max(0, config.cooldownSeconds)) return fail("AI_COOLDOWN");
    }
    if (fs.lastEvalFingerprint === fingerprint && fs.lastEvalAt && now.getTime() - fs.lastEvalAt < 5 * 6e4) {
      return fail("AI_DUPLICATE_CONTEXT");
    }
    const score = computeAiProactiveScore(ctx, journey);
    const threshold = config.minScoreOverride != null ? config.minScoreOverride : AI_MODE_THRESHOLDS[config.mode];
    if (score < threshold) return { eligible: false, score, threshold, fingerprint, topicBucket, reasons: ["AI_LOW_INTENT"] };
    return { eligible: true, score, threshold, fingerprint, topicBucket, reasons: ["AI_ELIGIBLE"] };
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
    zonedParts,
    AI_JOURNEY_MAX_PAGES,
    AI_MODE_DEFAULTS,
    normalizeTopicFromPath,
    matchesPathPattern,
    computeAiProactiveScore,
    computeAiProactiveFingerprint,
    evaluateAiProactiveEligibility
  };
  var smartEngine_default = SmartEngine;
  return __toCommonJS(smartEngine_exports);
})();
window.__gs_smart_engine = __gs_smart_engine_module.SmartEngine || __gs_smart_engine_module.default;
/**
 * Smart Engagement's visitor side: the rules' loop, the bubble beside the
 * launcher, the surfaces it hands the panel, the AI proactive nudge.
 *
 * ES5 with no build step of its own: scripts/build-smart-engine.mjs appends
 * it to public/widget/smart-engine.js, after the engine, so it arrives with
 * the engine in the same request, and only on a site whose workspace has
 * active rules (public/widget/loader.js, startSmart). It used to live in the
 * loader, which every page view of every site downloads.
 *
 * It reads the loader's state through `host` (loader.js startSmart): plain
 * values that are fixed once the bootstrap is done, getters for the ones
 * that change, and the loader's own functions.
 */
window.__gs_smart_start = function (host, config) {
  "use strict";

  var configData = host.configData;
  var WORKSPACE_ID = host.workspaceId;
  var warn = host.warn, log = host.log, tracks = host.tracks, vh = host.vh, recoverPost = host.recoverPost;
  var lt = host.lt, widgetLang = host.widgetLang, detectBrowser = host.detectBrowser, detectOS = host.detectOS;
  var injectPresentationFonts = host.injectPresentationFonts, onOpenIntent = host.onOpenIntent;
  var isPhoneViewport = host.isPhoneViewport, preloadRuntimeForSmart = host.preloadRuntimeForSmart;
  var triggerOpen = host.triggerOpen, onHistoryChange = host.onHistoryChange;
  function returningVisitor() { var isNew = host.visitorIsNew(); return isNew === null ? false : !isNew; }

  var apiBase = configData._apiBase;
  var rules = config.smart.rules || [];

  var isPreview = configData.mode === "preview" || window.__gs_preview === true;

  // ═══ smartFrequency:isoWeekKey ═══
  // The ISO 8601 week ("2026-W47"), for a rule's weekly cap.
  function isoWeekKey(date) {
    var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    var dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    var weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return d.getUTCFullYear() + "-W" + (weekNo < 10 ? "0" + weekNo : String(weekNo));
  }
  // ═══ /smartFrequency:isoWeekKey ═══

  // ═══ smartFrequency:buildFrequencyKey ═══
  function buildFrequencyKey(workspaceId, ruleId, ruleVersion) {
    return "gs:smart:v1:" + workspaceId + ":" + ruleId + ":" + (ruleVersion || 1);
  }
  // ═══ /smartFrequency:buildFrequencyKey ═══

  // ═══ smartFrequency:buildSessionKey ═══
  function buildSessionKey(workspaceId) {
    return "gs:smart:v1:" + workspaceId + ":session";
  }
  // ═══ /smartFrequency:buildSessionKey ═══

  // ═══ smartFrequency:buildIdempotencyKey ═══
  function buildIdempotencyKey(sessionId, ruleId, ruleVersion, eventType, occurrence) {
    return (sessionId + ":" + ruleId + ":" + (ruleVersion || 1) + ":" + eventType + ":" + occurrence).slice(0, 160);
  }
  // ═══ /smartFrequency:buildIdempotencyKey ═══

  // ═══ smartFrequency:suppressionDedupeKey ═══
  function suppressionDedupeKey(ruleId, reason) {
    return ruleId + "::" + reason;
  }
  // ═══ /smartFrequency:suppressionDedupeKey ═══

  function readJson(store, key) {
    try {
      var raw = store.getItem(key);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (_) { return {}; } // corrupt JSON resets silently
  }
  function writeJson(store, key, value) {
    if (tracks()) try { store.setItem(key, JSON.stringify(value)); } catch (_) {}
  }
  function dayKey() { return new Date().toISOString().slice(0, 10); }
  function weekKey() { return isoWeekKey(new Date()); }
  function ruleVersion(rule) { return rule.version || 1; }

  var sessionKey = buildSessionKey(WORKSPACE_ID);
  var session = readJson(window.sessionStorage, sessionKey);
  if (!session.rules) session.rules = {};
  session.pages = (Number(session.pages) || 0) + 1;
  if (!session.seed) session.seed = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
  writeJson(window.sessionStorage, sessionKey, session);

  // No identity data is ever stored here — only counters/flags keyed by
  // workspace + rule + rule VERSION, so publishing a new version starts
  // with a clean slate (never inherits the old version's state).
  function readRuleRecord(rule) {
    return readJson(window.localStorage, buildFrequencyKey(WORKSPACE_ID, rule.id, ruleVersion(rule)));
  }
  function writeRuleRecord(rule, rec) {
    writeJson(window.localStorage, buildFrequencyKey(WORKSPACE_ID, rule.id, ruleVersion(rule)), rec);
  }

  function frequencyState(rule) {
    var rec = readRuleRecord(rule);
    return {
      shownInSession: Number(session.rules[rule.id] || 0),
      shownTotal: Number(rec.total || 0),
      shownToday: rec.dayKey === dayKey() ? Number(rec.today || 0) : 0,
      shownThisWeek: rec.weekKey === weekKey() ? Number(rec.week || 0) : 0,
      lastShownAt: rec.last || null,
      dismissed: !!rec.dismissed,
      ctaClicked: !!rec.cta,
    };
  }
  function recordShown(rule) {
    var rec = readRuleRecord(rule);
    rec.total = (Number(rec.total) || 0) + 1;
    rec.today = (rec.dayKey === dayKey() ? Number(rec.today) || 0 : 0) + 1;
    rec.dayKey = dayKey();
    rec.week = (rec.weekKey === weekKey() ? Number(rec.week) || 0 : 0) + 1;
    rec.weekKey = weekKey();
    rec.last = Date.now();
    writeRuleRecord(rule, rec);
    session.rules[rule.id] = (Number(session.rules[rule.id]) || 0) + 1;
    writeJson(window.sessionStorage, sessionKey, session);
  }
  function markRule(rule, field) {
    var rec = readRuleRecord(rule);
    rec[field] = true;
    writeRuleRecord(rule, rec);
  }
  // Deterministic per-rule/version/event occurrence counter, persisted so
  // a page-reload-before-ack retry of the same logical event reuses the
  // same idempotency key instead of minting a new one.
  function nextOccurrence(rule, eventType) {
    var rec = readRuleRecord(rule);
    rec.events = rec.events || {};
    rec.events[eventType] = (Number(rec.events[eventType]) || 0) + 1;
    writeRuleRecord(rule, rec);
    return rec.events[eventType];
  }

  // ─── Per-page signals ───
  // From when the loader started Smart Engagement, as before this file
  // moved out of it: a rule's time on the page counts from there.
  var pageStart = host.startedAt;
  var lastActivity = host.startedAt;
  var scrollPercent = 0;
  var exitIntent = false;
  var lastSurfaceAt = null;
  var activeSurface = null;   // { ruleId, el }
  var suppressedThisPage = {}; // dedupe: "ruleId::reason" -> true

  function resetPageSignals() {
    pageStart = Date.now();
    lastActivity = Date.now();
    scrollPercent = 0;
    exitIntent = false;
    suppressedThisPage = {};
    session.pages = (Number(session.pages) || 0) + 1;
    navGeneration++;
    recordJourneyPage();
    writeJson(window.sessionStorage, sessionKey, session);
  }

  // ─── AI Proactive Nudge — bounded visitor journey (additive) ──────────
  // AI_JOURNEY_MAX_PAGES mirrors src/lib/widget/smartEngine.ts's exported
  // constant of the same name (src/test/widget/smartClientBundle.test.ts
  // keeps them equal).
  var AI_JOURNEY_MAX_PAGES = 12;
  if (!session.journey) session.journey = [];
  if (!session.aiFreq) {
    session.aiFreq = { shownInSession: 0, lastShownAt: null, dismissedTopics: [], lastTopic: null, lastEngaged: false, lastFingerprint: null, lastEvalAt: null };
  }
  var navGeneration = 0;
  var aiNudgeInFlight = false;
  var aiCfg = (config.smart && config.smart.aiProactive) || { enabled: false, mode: "off" };

  function recordJourneyPage() {
    var path = (window.location.pathname || "/").slice(0, 500);
    var title = (document.title || "").slice(0, 300);
    var last = session.journey.length ? session.journey[session.journey.length - 1] : null;
    if (last && last.path === path) return;
    session.journey.push({ path: path, title: title, ts: Date.now() });
    if (session.journey.length > AI_JOURNEY_MAX_PAGES) {
      session.journey.splice(0, session.journey.length - AI_JOURNEY_MAX_PAGES);
    }
  }
  // Record the initial page load (subsequent navigations go through resetPageSignals above).
  recordJourneyPage();
  writeJson(window.sessionStorage, sessionKey, session);

  function aiJourneyContext() {
    var current = session.journey.length ? session.journey[session.journey.length - 1] : { path: window.location.pathname || "/", title: document.title || "", ts: Date.now() };
    var lastTopic = session.aiFreq.lastTopic;
    return {
      current: current,
      recentPages: session.journey.slice(0, -1),
      sessionPageCount: Number(session.pages) || 1,
      returning: returningVisitor(),
      previousNudge: lastTopic
        ? { topic: lastTopic, dismissed: session.aiFreq.dismissedTopics.indexOf(lastTopic) !== -1, engaged: !!session.aiFreq.lastEngaged }
        : null,
    };
  }

  // Client-side eligibility is a CHEAP pre-filter only — it exists purely
  // so a visitor navigating many pages does not trigger a network call on
  // every single one. It intentionally does NOT know the workspace's real
  // frequency ceilings (those stay server-side, see policy.ts) — it uses
  // conservative local placeholders. The server independently re-runs the
  // SAME evaluateAiProactiveEligibility function with the real, clamped
  // policy before ever spending an AI call; this local check can only
  // ever be MORE permissive than the server, never less safe.
  function aiEligibilityCheck(ctx) {
    if (!SmartEngineRef || !SmartEngineRef.evaluateAiProactiveEligibility) return null;
    if (!aiCfg.enabled || aiCfg.mode === "off") return null;
    var journey = aiJourneyContext();
    var freqState = {
      shownInSession: session.aiFreq.shownInSession,
      lastShownAt: session.aiFreq.lastShownAt,
      dismissedTopics: session.aiFreq.dismissedTopics,
      lastEvalFingerprint: session.aiFreq.lastFingerprint,
      lastEvalAt: session.aiFreq.lastEvalAt,
    };
    var localCfg = {
      mode: aiCfg.mode,
      maxPerSession: 5,
      cooldownSeconds: 30,
      stopAfterDismiss: true,
      stopAfterWidgetOpen: true,
      stopAfterConversation: true,
      mobileEnabled: true,
    };
    try {
      return SmartEngineRef.evaluateAiProactiveEligibility(localCfg, ctx, journey, freqState, new Date());
    } catch (_) { return null; }
  }

  // Session-recovery aware lifecycle reporter. A bubble can render while
  // its 'shown' ack fails during widget token rotation/expiry — without
  // recovery, backend status stays stuck at 'generated' forever even
  // though the visitor genuinely saw it. This uses the SAME canonical
  // widget session manager every other layer uses (window.__gs_token.
  // recover — installed once by installSessionManager near the top of
  // this file), never an independent auth/session implementation, and
  // retries the SAME event exactly once — safe because the server
  // derives its own idempotency key for 'ai_proactive' events
  // server-side, so a retry can never double-record. Non-auth failures
  // stay best-effort and never throw, so a reporting failure can never
  // break the visitor widget.
  function reportAiEvent(nudgeId, type) {
    try {
      recoverPost(apiBase + "/api/widget/smart/event", {
        workspace_id: WORKSPACE_ID,
        source: "ai_proactive",
        ai_nudge_id: nudgeId,
        event_type: type,
        page_path: (window.location.pathname || "/").slice(0, 500),
        idempotency_key: (currentSessionId() + ":" + nudgeId + ":" + type).slice(0, 160),
      }, host.sessionToken()).catch(function () {});
    } catch (_) {}
  }

  function runAiNudgeAction(data) {
    var cta = data.cta || {};
    if (cta.action === "open_url" && SmartEngineRef && SmartEngineRef.isSafeSmartUrl(cta.url)) {
      try { window.open(cta.url, "_blank", "noopener,noreferrer"); } catch (_) {}
      return;
    }
    // Continuity into chat — read by the runtime's send path so the AI
    // Agent continues this exact topic instead of a generic greeting.
    try { window.__gs_pending_nudge_context = { source: "ai_proactive_nudge", nudge_id: data.nudgeId }; } catch (_) {}
    // Continuity UI on open — a separate, purely-cosmetic echo of the
    // exact message the visitor already saw in the bubble (never trusted
    // for grounding/billing, only for suppressing a jarring generic
    // greeting and showing a quiet "continuing from" cue). Consumed
    // exactly once by runtime.js's chat-open render path.
    try { window.__gs_pending_nudge_intro = { message: data.message || "", topic: data.topic || "" }; } catch (_) {}
    openRuntime("chat");
  }

  function showAiNudge(data) {
    if (!host.shellContentEl() || activeSurface) return false;
    bubble("ai:" + data.nudgeId, { title: "", body: data.message, cta_label: data.cta && data.cta.label }, true, 25,
      function () {
        if (data.topic && session.aiFreq.dismissedTopics.indexOf(data.topic) === -1) {
          session.aiFreq.dismissedTopics.push(data.topic);
          writeJson(window.sessionStorage, sessionKey, session);
        }
        reportAiEvent(data.nudgeId, "dismissed");
      },
      function () {
        session.aiFreq.lastEngaged = true;
        writeJson(window.sessionStorage, sessionKey, session);
        reportAiEvent(data.nudgeId, "cta_clicked");
        runAiNudgeAction(data);
      });

    session.aiFreq.shownInSession = (Number(session.aiFreq.shownInSession) || 0) + 1;
    session.aiFreq.lastShownAt = Date.now();
    session.aiFreq.lastTopic = data.topic || null;
    session.aiFreq.lastEngaged = false;
    writeJson(window.sessionStorage, sessionKey, session);
    lastSurfaceAt = Date.now();
    reportAiEvent(data.nudgeId, "shown");
    return true;
  }

  function requestAiNudge(eligibility) {
    if (aiNudgeInFlight || isPreview) return;
    aiNudgeInFlight = true;
    var journey = aiJourneyContext();
    var ctx = buildContext();
    var capturedGen = navGeneration;
    var token = (window.__gs_token && window.__gs_token.get()) || host.sessionToken();
    fetch(apiBase + "/api/widget/nudge/evaluate", {
      method: "POST",
      credentials: "include",
      headers: vh({ "Content-Type": "application/json", "X-Widget-Token": token }),
      body: JSON.stringify({
        workspace_id: WORKSPACE_ID,
        // Visitor identity is resolved server-side from the signed
        // HttpOnly cookie — nothing sent from here is trusted for that.
        session_id: currentSessionId(),
        locale: ctx.locale,
        device: ctx.device,
        current: { path: journey.current.path, title: journey.current.title },
        recent_pages: journey.recentPages.map(function (p) { return { path: p.path, title: p.title, ts: p.ts }; }),
        session_page_count: journey.sessionPageCount,
        returning: journey.returning,
        previous_nudge: journey.previousNudge,
        // Without its query string, as every tracked address (P-01).
        referrer: (document.referrer || "").split(/[?#]/)[0],
        utm: ctx.utm,
        signals: ctx.signals,
        interaction: ctx.interaction,
        online: ctx.availability.online,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        aiNudgeInFlight = false;
        session.aiFreq.lastFingerprint = eligibility.fingerprint;
        session.aiFreq.lastEvalAt = Date.now();
        writeJson(window.sessionStorage, sessionKey, session);
        // Discard a stale response if the visitor already moved to
        // another page, opened the widget, or another surface appeared
        // while this request was in flight.
        if (capturedGen !== navGeneration) return;
        if (activeSurface) return;
        if (interactionSnapshot().widgetOpen) return;
        if (!data || data.decision !== "show" || !data.nudgeId || !data.message) return;
        showAiNudge(data);
      })
      .catch(function () { aiNudgeInFlight = false; });
  }

  function maybeTryAiNudge(ctx) {
    if (activeSurface || aiNudgeInFlight) return;
    var eligibility = aiEligibilityCheck(ctx);
    if (eligibility && eligibility.eligible) requestAiNudge(eligibility);
  }
  // ─── /AI Proactive Nudge ───────────────────────────────────────────────

  function measureScroll() {
    try {
      var doc = document.documentElement;
      var max = (doc.scrollHeight || 0) - (window.innerHeight || 0);
      if (max <= 0) { scrollPercent = 100; return; }
      scrollPercent = Math.max(scrollPercent, Math.min(100, ((window.pageYOffset || doc.scrollTop || 0) / max) * 100));
    } catch (_) {}
  }

  function currentQuery() {
    var out = {};
    try {
      var sp = new URLSearchParams(window.location.search || "");
      sp.forEach(function (v, k) { out[k.toLowerCase()] = v; });
    } catch (_) {}
    return out;
  }

  // ─── Runtime interaction bridge ─────────────────────────────────────
  // The identity cookie is HttpOnly (unreadable from JS) so, before the
  // runtime is loaded, only loader-trustworthy state is known: whether
  // WE opened the panel. Everything else the runtime tracks (an active
  // conversation, a live call, an open pre-chat form) is UNKNOWN until
  // the runtime hands us a real snapshot — we never guess "false".
  var runtimeInteraction = null; // real snapshot once the runtime subscribes
  function runtimeInstance() {
    try { return window.__gs_runtime && window.__gs_runtime._instance; } catch (_) { return null; }
  }
  function subscribeRuntimeInteractionOnce() {
    if (runtimeInteraction) return;
    var inst = runtimeInstance();
    if (!inst || typeof inst.getSmartInteractionState !== "function") return;
    try {
      runtimeInteraction = inst.getSmartInteractionState();
      if (typeof inst.onSmartInteractionChange === "function") {
        inst.onSmartInteractionChange(function (next) { runtimeInteraction = next; });
      }
    } catch (_) {}
  }
  // "unknown" while the runtime hasn't reported yet — never coerced to false.
  function interactionSnapshot() {
    subscribeRuntimeInteractionOnce();
    if (runtimeInteraction) return runtimeInteraction;
    // The runtime bundle is lazy — it only loads once the panel is opened.
    // If it has never been loaded AND we never opened the panel, there is
    // provably no conversation, call or pre-chat form in this page: the
    // code that could create one does not exist yet. Reporting "unknown"
    // here would deadlock every panel-bound surface forever, because the
    // runtime that would resolve the unknown is only loaded by opening the
    // widget. Anything else stays "unknown" until the runtime reports.
    if (!host.runtimeLoaded() && !runtimeInstance() && !host.isOpen()) {
      return {
        widgetOpen: false,
        conversationActive: false,
        visitorTyping: false,
        callActive: false,
        prechatOpen: false,
        visitorReplied: false,
        widgetError: false,
        currentView: null,
      };
    }
    return {
      widgetOpen: !!host.isOpen(),
      conversationActive: "unknown",
      visitorTyping: "unknown",
      callActive: "unknown",
      prechatOpen: "unknown",
      visitorReplied: "unknown",
      widgetError: false,
      currentView: null,
    };
  }
  function isUnknownInteraction(snap) {
    return snap.conversationActive === "unknown" ||
      snap.callActive === "unknown" ||
      snap.prechatOpen === "unknown";
  }
  function isPanelBoundMode(mode) { return mode !== "launcher_nudge"; }

  function buildContext() {
    var q = currentQuery();
    var ua = navigator.userAgent || "";
    var device = /iPad|Tablet/i.test(ua) ? "tablet" : (/Mobi|Android/i.test(ua) ? "mobile" : "desktop");
    var snap = interactionSnapshot();
    return {
      masterEnabled: true,
      mode: isPreview ? "preview" : "production",
      page: {
        url: window.location.href,
        path: window.location.pathname,
        hostname: window.location.hostname,
        title: document.title || "",
        query: q,
      },
      referrer: document.referrer || "",
      utm: { source: q.utm_source, medium: q.utm_medium, campaign: q.utm_campaign },
      device: device,
      browser: detectBrowser(),
      os: detectOS(),
      locale: (configData.locale || document.documentElement.lang || navigator.language || "en"),
      visitor: {
        isReturning: returningVisitor(),
        sessionPageCount: Number(session.pages) || 1,
      },
      availability: { online: !!host.online() },
      interaction: {
        widgetOpen: !!snap.widgetOpen,
        // Fail-safe: unknown is treated as "not active" for the ENGINE
        // pass (so nudges can still fire); the extra unknown-gate below
        // separately blocks panel-bound surfaces until we know for sure.
        conversationActive: snap.conversationActive === true,
        visitorTyping: snap.visitorTyping === true,
        callActive: snap.callActive === true,
        prechatOpen: snap.prechatOpen === true,
        visitorReplied: snap.visitorReplied === true,
        widgetError: !!snap.widgetError,
        anotherRuleShowing: !!activeSurface,
      },
      signals: {
        elapsedMs: Date.now() - pageStart,
        scrollPercent: scrollPercent,
        inactiveMs: Date.now() - lastActivity,
        exitIntent: exitIntent,
        pageHidden: typeof document !== "undefined" ? !!document.hidden : false,
      },
      msSinceLastSurface: lastSurfaceAt == null ? null : Date.now() - lastSurfaceAt,
    };
  }

  // ─── Telemetry (best-effort, never blocks the UI) ───
  function currentSessionId() {
    try { if (window.__gs_session_id) return String(window.__gs_session_id); } catch (_) {}
    return session.seed;
  }
  function report(rule, type) {
    if (isPreview) return; // never send telemetry from preview contexts
    try {
      var occurrence = nextOccurrence(rule, type);
      var token = (window.__gs_token && window.__gs_token.get()) || host.sessionToken();
      fetch(apiBase + "/api/widget/smart/event", {
        method: "POST",
        credentials: "include",
        headers: vh({ "Content-Type": "application/json", "X-Widget-Token": token }),
        body: JSON.stringify({
          workspace_id: WORKSPACE_ID,
          rule_id: rule.id,
          rule_version: ruleVersion(rule),
          event_type: type,
          page_path: (window.location.pathname || "/").slice(0, 500),
          idempotency_key: buildIdempotencyKey(currentSessionId(), rule.id, ruleVersion(rule), type, occurrence),
        }),
      }).catch(function () {});
    } catch (_) {}
  }
  function reportSuppressed(rule, reasonCode) {
    var key = suppressionDedupeKey(rule.id, reasonCode);
    if (suppressedThisPage[key]) return;
    suppressedThisPage[key] = true;
    report(rule, "suppressed");
  }

  // ─── Actions ───
  function openRuntime(tab, slug) {
    triggerOpen();
    var tries = 0;
    (function waitReady() {
      var inst = runtimeInstance();
      if (inst && inst.setTab) { try { inst.setTab(tab, slug); } catch (_) {} return; }
      if (tries++ > 60) return;
      setTimeout(waitReady, 150);
    })();
  }
  function runAction(rule) {
    var p = rule.presentation_config || {};
    switch (p.action) {
      case "open_chat": openRuntime("chat"); break;
      case "open_home": openRuntime("home"); break;
      case "open_kb": openRuntime("help"); break;
      case "open_article": openRuntime("help", p.article_slug || null); break;
      case "open_url":
        if (SmartEngineRef && SmartEngineRef.isSafeSmartUrl(p.url)) {
          try {
            if (p.open_in_new_tab === false) window.location.href = p.url;
            else window.open(p.url, "_blank", "noopener,noreferrer");
          } catch (_) {}
        }
        break;
      default: break;
    }
  }

  // ─── Surface rendering ──────────────────────────────────────────────
  // Loader-owned surface: `launcher_nudge` ONLY. `announcement`,
  // `home_card`, `chat_message` and `open_widget` are ALWAYS handed to
  // the runtime (inst.showSmart) so they render inside the real widget
  // chrome — the loader never paints a floating announcement itself.
  function clearSurface() {
    var surface = activeSurface;
    activeSurface = null;
    if (!surface || !surface.el || !surface.el.parentNode) return;
    // Sink the bubble back into the launcher instead of yanking it out of
    // the DOM. The removal is guarded by a timeout so a disabled/absent
    // animation can never leave the surface stuck on screen.
    var el = surface.el;
    var removed = false;
    var drop = function () {
      if (removed) return;
      removed = true;
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    try {
      el.classList.add("leaving");
      el.addEventListener("animationend", drop);
      setTimeout(drop, 320);
    } catch (_) { drop(); }
  }

  function surfaceHtml(content, dismissible) {
    return (dismissible === false
      ? ""
      : '<button type="button" class="smart-dismiss" data-smart-dismiss aria-label="' +
          String(lt("dismiss")).replace(/"/g, "&quot;") + '">\u00d7</button>') +
      (content.title ? '<div class="smart-title">' + escapeText(content.title) + "</div>" : "") +
      '<div class="smart-body">' + escapeText(content.body || "") + "</div>" +
      (content.cta_label
        ? '<button type="button" class="smart-cta" data-smart-cta>' + escapeText(content.cta_label) + "</button>"
        : "");
  }

  function escapeText(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // One bubble beside the launcher: a rule's nudge, an AI nudge, the
  // preview of a rule meant for the panel. A live region (role=status: a
  // screen reader hears it once it is filled), in the widget's language
  // and direction. It goes after `sec` seconds, never while the pointer or
  // the focus is on it (WCAG 2.2.1). `onDismiss` / `onCta` run before it goes.
  function bubble(id, content, dismissible, sec, onDismiss, onCta) {
    var lang = widgetLang();
    var el = document.createElement("div");
    el.className = "smart-nudge entering " + (configData.position === "bottom-left" ? "bottom-left" : "bottom-right");
    el.setAttribute("role", "status");
    el.lang = lang;
    el.dir = ["fa", "ar", "he", "ur"].indexOf(lang) >= 0 ? "rtl" : "ltr";
    host.shellContentEl().appendChild(el);
    el.innerHTML = surfaceHtml(content, dismissible);
    // Drop the intro class once it has played so a late-arriving template
    // stylesheet cannot restart the entry animation mid-life.
    var settle = function () { try { el.classList.remove("entering"); } catch (_) {} };
    try { el.addEventListener("animationend", settle, { once: true }); } catch (_) {}
    setTimeout(settle, 480);
    activeSurface = { ruleId: id, el: el };
    [["[data-smart-dismiss]", onDismiss], ["[data-smart-cta]", onCta]].forEach(function (b) {
      var btn = el.querySelector(b[0]);
      if (btn) btn.addEventListener("click", function (e) { e.stopPropagation(); b[1](); clearSurface(); });
    });
    // Auto-release: a bubble the visitor never touches must not block
    // every other rule forever. It goes WITHOUT being marked dismissed, so
    // the evaluation loop is free to surface the next matching rule (still
    // behind the global cooldown); frequency state already counted it.
    var timer = null;
    var arm = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { if (activeSurface && activeSurface.el === el) clearSurface(); }, (sec > 0 ? sec : 25) * 1000);
    };
    var hold = function () { clearTimeout(timer); };
    el.addEventListener("mouseenter", hold);
    el.addEventListener("focusin", hold);
    el.addEventListener("mouseleave", arm);
    el.addEventListener("focusout", arm);
    arm();
    return el;
  }

  // A rule's bubble. With `open`, it is the preview of a surface meant for
  // the panel (showPanelSurface): a tap on it opens the panel there.
  function showNudge(rule, content, open) {
    if (!host.shellContentEl()) return false;
    injectPresentationFonts(configData.presentationFontsUrl || "");
    // A template newer than the edition's first one dresses the bubble in
    // its own stylesheet: load the template now, as an open intent does
    // (nothing runs until an open).
    if (configData.templateId && !/^(default|intl)$/.test(configData.templateId)) onOpenIntent();
    var el = bubble(rule.id, content, (rule.presentation_config || {}).dismissible,
      Number((rule.behavior_config || {}).auto_hide_seconds),
      function () {
        markRule(rule, "dismissed");
        report(rule, "dismissed");
        // The surface waiting in the panel goes with its preview.
        var inst = open && runtimeInstance();
        if (inst && inst.hideSmart) inst.hideSmart();
      },
      open || function () {
        markRule(rule, "cta");
        report(rule, "cta_clicked");
        runAction(rule);
      });
    if (open) el.addEventListener("click", function () { clearSurface(); open(); });
    return true;
  }

  // Delivery is async (inst.showSmart may not exist yet, and may itself
  // refuse to render — e.g. a call/prechat is active). `onResult(delivered)`
  // fires once the real outcome is known, so the caller can gate
  // recordShown/"shown" telemetry on an actual render instead of assuming
  // success — see fire().
  function showPanelSurface(rule, content, onResult) {
    var pres = rule.presentation_config || {};
    var wasOpen = !!host.isOpen();
    // Proactive (the panel is closed): the screen and the focus stay the
    // visitor's (WCAG 3.2). The surface waits in the panel, previewed by
    // the launcher, until the visitor opens it, from the preview or the
    // launcher. Only `open_widget` opens by itself, on a computer, with
    // the focus left where it is: a phone's open panel is the whole screen.
    var preview = !wasOpen && (pres.mode !== "open_widget" || isPhoneViewport());
    var tap = function () { triggerOpen(); report(rule, "widget_opened"); };
    if (!preview) {
      triggerOpen(true);
      if (!wasOpen) {
        // widget_opened is only ever reported once the panel actually opens.
        var tries0 = 0;
        (function waitOpen() {
          if (host.isOpen()) { report(rule, "widget_opened"); return; }
          if (tries0++ > 40) return;
          setTimeout(waitOpen, 100);
        })();
      }
    }
    if (pres.mode === "open_widget") { onResult(preview ? showNudge(rule, content, tap) : true); return; }
    // The surface waits in the runtime, booted silently for a preview.
    preloadRuntimeForSmart();
    var tries = 0;
    (function waitReady() {
      var inst = runtimeInstance();
      if (inst && inst.showSmart) {
        var delivered = inst.showSmart({
          id: rule.id,
          mode: pres.mode,
          title: content.title || "",
          body: content.body || "",
          ctaLabel: content.cta_label || "",
          dismissible: pres.dismissible !== false,
          onDismiss: function () {
            markRule(rule, "dismissed");
            report(rule, "dismissed");
            activeSurface = null;
          },
          onCta: function () {
            markRule(rule, "cta");
            report(rule, "cta_clicked");
            activeSurface = null;
            runAction(rule);
          },
        });
        if (delivered) activeSurface = { ruleId: rule.id, el: null };
        if (delivered && preview) showNudge(rule, content, tap);
        onResult(delivered);
        return;
      }
      if (tries++ > 60) { onResult(false); return; }
      setTimeout(waitReady, 150);
    })();
  }

  function fire(rule) {
    var mode = (rule.presentation_config || {}).mode;
    var snap = interactionSnapshot();
    // Fail-safe: while the runtime hasn't confirmed real interaction
    // state yet, panel-bound surfaces never fire — only the nudge may.
    if (isPanelBoundMode(mode) && isUnknownInteraction(snap)) {
      reportSuppressed(rule, "INTERACTION_UNKNOWN");
      // Kick off a silent background load so interaction state becomes
      // known on a later tick() instead of staying unknown forever — see
      // preloadRuntimeForSmart(). No-ops once a load is already underway.
      preloadRuntimeForSmart();
      return;
    }
    var content = SmartEngineRef.resolveSmartContent(rule, buildContext().locale);
    if (!content || !content.body) return;
    var vars = {
      "workspace.name": configData.brandName || "",
      "page.title": document.title || "",
      "page.path": window.location.pathname || "",
    };
    var rendered = {
      title: SmartEngineRef.renderSmartTemplate(content.title || "", vars),
      body: SmartEngineRef.renderSmartTemplate(content.body || "", vars),
      cta_label: SmartEngineRef.renderSmartTemplate(content.cta_label || "", vars),
    };
    function onShown() {
      recordShown(rule);
      lastSurfaceAt = Date.now();
      report(rule, "shown");
    }
    if (mode === "launcher_nudge") {
      if (showNudge(rule, rendered)) onShown();
      return;
    }
    showPanelSurface(rule, rendered, function (delivered) {
      if (delivered) onShown();
    });
  }

  // ─── Evaluation loop ───
  var SmartEngineRef = window.__gs_smart_engine || null;
  var ticking = null;

  function tick() {
    if (!SmartEngineRef || activeSurface || !tracks()) return;
    measureScroll();
    var ctx = buildContext();
    var now = new Date();
    var best = null;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      ctx.frequency = frequencyState(rule);
      var result = SmartEngineRef.evaluateSmartRule(rule, ctx, now);
      if (result.outcome === "suppressed" && result.reasons && result.reasons.length) {
        reportSuppressed(rule, result.reasons[result.reasons.length - 1].code);
      }
      if (result.outcome !== "matched") continue;
      if (!best) { best = rule; continue; }
      var dp = (Number(rule.priority) || 0) - (Number(best.priority) || 0);
      if (dp > 0 || (dp === 0 && String(rule.id) < String(best.id))) best = rule;
    }
    // Deterministic precedence: a matched static Smart Engagement rule
    // ALWAYS outranks an AI proactive candidate — AI is only ever
    // consulted when nothing else already earned this tick's surface.
    if (best) { fire(best); return; }
    maybeTryAiNudge(ctx);
  }

  function attachSignals() {
    var mark = function () { lastActivity = Date.now(); };
    window.addEventListener("scroll", function () { measureScroll(); mark(); }, { passive: true });
    window.addEventListener("mousemove", mark, { passive: true });
    window.addEventListener("keydown", mark, { passive: true });
    window.addEventListener("touchstart", mark, { passive: true });
    document.addEventListener("mouseleave", function (ev) {
      if (!ev || ev.clientY == null || ev.clientY <= 0) { exitIntent = true; tick(); }
    });
    document.addEventListener("visibilitychange", function () { mark(); });

    // SPA navigation — treat every route change as a fresh page. Uses the
    // shared history bus so pushState/replaceState are patched only once
    // process-wide (shared with startTracking's page-view pings).
    var onNav = function () {
      clearSurface();
      resetPageSignals();
      setTimeout(tick, 60);
    };
    onHistoryChange(onNav);
    window.addEventListener("popstate", onNav);

    ticking = setInterval(tick, 1000);
  }

  if (!SmartEngineRef || !SmartEngineRef.evaluateSmartRule) {
    warn("smart: engine bundle did not register");
    return;
  }
  log("smart: engine ready with", rules.length, "rule(s)");
  attachSignals();
  tick();
};
