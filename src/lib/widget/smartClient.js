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
