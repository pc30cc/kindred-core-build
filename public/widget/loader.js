/**
 * Widget Loader v4 — Shadow DOM shell + hardened bootstrap.
 *
 * Responsibilities (and ONLY these):
 *  1. Define the <gs-widget> custom element (Shadow DOM root).
 *  2. Render the launcher FAB inside the shadow root immediately.
 *  3. Bootstrap (POST /widget/bootstrap) with retries + error states.
 *  4. Fetch /widget/config, then on first launcher click lazy-load
 *     runtime.css + runtime.js INTO the shadow root.
 *  5. Hand over to runtime.init(config, shellApi).
 *
 * Strict rules:
 *  - No business logic (chat, identity, KB) lives here.
 *  - DEBUG is OFF unless explicitly enabled by config.debugMode or
 *    window.__gs_debug === true.
 *  - Multiple injections must NOT create duplicate shells.
 *  - Identity/security model is untouched: cookies + X-Widget-Token only.
 */
(function () {
  "use strict";

  // ─── Singleton guard ───
  // Multi-layer protection against double inject:
  //   1. window.__gs_loaded — set by THIS execution; second copy of the
  //      loader script will see it and return immediately.
  //   2. existing <gs-widget> element in the DOM — protects against a
  //      previous execution that was unloaded by an SPA but the shell node
  //      survived (shouldn't happen, but defense in depth).
  if (window.__gs_loaded) return;
  if (typeof document !== "undefined" && document.querySelector("gs-widget")) {
    // A shell already exists from a prior execution — adopt the singleton
    // flag and exit. The pre-existing instance owns the widget.
    window.__gs_loaded = true;
    return;
  }
  window.__gs_loaded = true;

  var LOADER_VERSION = "2026-08-06-smart-engagement-v1";
  var ELEMENT_TAG = "gs-widget";

  // DEBUG defaults to OFF in production. Opt in via:
  //   window.__gs_debug = true   (developer console)
  //   data-debug="true" attribute on the loader script
  //   config.debugMode === true  (server-driven)
  var DEBUG = window.__gs_debug === true;

  function log() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[Widget]");
    try { console.info.apply(console, args); } catch (_) {}
  }
  function warn() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[Widget]");
    try { console.warn.apply(console, args); } catch (_) {}
  }

  log("Loader version:", LOADER_VERSION);

  // ─── Pending command queue (window.__gs.push(['open']) etc.) ───
  var GS = window.__gs || [];
  var queue = [];
  var widgetApi = null;
  var ready = false;

  if (Array.isArray(GS)) {
    for (var i = 0; i < GS.length; i++) queue.push(GS[i]);
  }

  // ─── Shared token bus ──────────────────────────────────────────────
  // Single authoritative source for the widget session token across:
  //   - loader heartbeat / track / session-refresh
  //   - runtime tokenManager (proactive + reactive refresh)
  //   - runtime-rt-centrifugo /api/realtime/connect & /subscribe
  //
  // Without this each layer kept its own snapshot. After wake the runtime
  // could refresh the token while the loader's heartbeat was still using
  // the old one — producing the 403 loop on /api/widget/action and
  // /api/widget/session/refresh and dragging the realtime layer back into
  // reconnecting because /api/realtime/connect was hit with a stale token.
  if (!window.__gs_token) {
    var __tokenListeners = [];
    window.__gs_token = {
      _value: '',
      get: function () { return this._value; },
      set: function (t) {
        if (!t || t === this._value) return;
        this._value = t;
        for (var i = 0; i < __tokenListeners.length; i++) {
          try { __tokenListeners[i](t); } catch (_) {}
        }
      },
      onChange: function (fn) {
        __tokenListeners.push(fn);
        return function () {
          var i = __tokenListeners.indexOf(fn);
          if (i !== -1) __tokenListeners.splice(i, 1);
        };
      },
    };
  }

  function processQueue() {
    while (queue.length) {
      var cmd = queue.shift();
      if (widgetApi && typeof widgetApi[cmd[0]] === "function") {
        try { widgetApi[cmd[0]].apply(widgetApi, cmd.slice(1)); } catch (e) { warn("cmd err", e); }
      }
    }
  }
  window.__gs = {
    push: function () {
      var args = Array.prototype.slice.call(arguments);
      for (var i = 0; i < args.length; i++) {
        if (ready && widgetApi && typeof widgetApi[args[i][0]] === "function") {
          try { widgetApi[args[i][0]].apply(widgetApi, args[i].slice(1)); } catch (e) { warn("cmd err", e); }
        } else {
          queue.push(args[i]);
        }
      }
    },
    _id: null,
    _version: LOADER_VERSION,
  };

  // ─── Resolve loader script + config attributes ───
  function getLoaderScript() {
    if (document.currentScript && (document.currentScript.src || "").indexOf("/widget/loader.js") !== -1) {
      return document.currentScript;
    }
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      if ((scripts[i].src || "").indexOf("/widget/loader.js") !== -1) return scripts[i];
    }
    return null;
  }
  var _loaderScript = getLoaderScript();
  function attr(name) { return _loaderScript && _loaderScript.getAttribute(name); }

  if (attr("data-debug") === "true") DEBUG = true;

  function getWorkspaceId() {
    return window.__gs_id || attr("data-workspace-id") || null;
  }
  function getAssetBase() {
    var explicit = attr("data-asset-base");
    if (explicit && explicit.indexOf("%VITE_") !== 0) return explicit.replace(/\/$/, "");
    var src = _loaderScript && _loaderScript.src ? _loaderScript.src : "";
    return src ? src.replace(/\/widget\/loader\.js.*$/, "") : "";
  }
  function getApiBase() {
    if (window.__gs_api_base && typeof window.__gs_api_base === "string" && window.__gs_api_base.indexOf("%VITE_") !== 0) {
      return window.__gs_api_base.replace(/\/$/, "");
    }
    var configured = attr("data-api-base");
    if (configured && configured.indexOf("%VITE_") !== 0) return configured.replace(/\/$/, "");
    return "";
  }

  // ─── Embed-safe inline launcher CSS (Shadow DOM scoped) ───
  // This is the ONLY style emitted before runtime.css loads. It lives inside
  // the Shadow DOM so host-page CSS cannot leak in.
  var SHELL_CSS = [
    ":host{all:initial;contain:layout style;}",
    "*,*::before,*::after{box-sizing:border-box;}",
    ".shell{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1F2937;}",
    ".launcher{position:fixed;z-index:2147483646;display:flex;align-items:center;justify-content:center;",
    "width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;",
    "box-shadow:0 4px 20px -4px rgba(0,0,0,.25),0 0 0 1px rgba(0,0,0,.05);",
    "transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease,opacity .2s ease;",
    "background:var(--gs-primary,transparent);color:#fff;font-family:inherit;",
    "opacity:1;}",
    /* Hidden state — keeps the launcher invisible and non-interactive until
       /config resolves and we know the brand color. Eliminates blue flash. */
    ".launcher.pending{opacity:0;pointer-events:none;visibility:hidden;}",
    /* Reveal animation once config arrives. */
    ".launcher.revealed{opacity:1;pointer-events:auto;visibility:visible;}",
    ".launcher:hover{transform:scale(1.08);box-shadow:0 6px 28px -4px rgba(0,0,0,.3);}",
    ".launcher:active{transform:scale(.96);}",
    ".launcher.bottom-right{bottom:24px;right:24px;}",
    ".launcher.bottom-left{bottom:24px;left:24px;}",
    ".launcher.square{border-radius:16px;}",
    ".launcher.pulse{animation:gs-fab-pulse 2s ease-in-out infinite;}",
    "@keyframes gs-fab-pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.07);}}",
    ".gs-fab-label{position:fixed;z-index:2147483645;display:inline-flex;align-items:center;",
    "padding:7px 12px;border-radius:999px;font-size:12px;font-weight:600;font-family:inherit;",
    "box-shadow:0 4px 14px -4px rgba(0,0,0,.25);white-space:nowrap;background:var(--gs-primary,#3B82F6);color:#fff;}",
    ".launcher svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}",
    ".launcher.open svg.chat-icon{display:none;}.launcher:not(.open) svg.close-icon{display:none;}",
    /* When the panel is open the launcher steps aside — the panel now owns
       its own close control in the header (top-left). */
    ".launcher.open{opacity:0;visibility:hidden;pointer-events:none;transform:scale(.85);animation:none;}",
    ".launcher.open ~ .gs-fab-label{opacity:0;visibility:hidden;pointer-events:none;}",
    ".gs-fab-label{transition:opacity .2s ease;}",
    ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;",
    "background:#EF4444;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;",
    "padding:0 5px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.15);}",
    ".error-toast{position:fixed;bottom:92px;right:24px;max-width:280px;padding:10px 14px;",
    "background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;color:#991B1B;font-size:12px;",
    "box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:2147483647;display:none;}",
    ".error-toast.visible{display:block;}",
    "@media(max-width:480px){.launcher{width:50px;height:50px;}}",
    /* ── Smart Engagement: launcher nudge only (loader-owned surface). ── */
    /* Values mirror .smart-nudge / .smart-title / .smart-body / .smart-cta / */
    /* .smart-dismiss in runtime.css exactly — same look, no runtime.css load. */
    ".smart-nudge{position:fixed;z-index:6;max-width:280px;display:flex;flex-direction:column;gap:8px;",
    "padding:12px 14px;border-radius:16px;background:#fff;color:#1f2937;",
    "border:1px solid rgba(15,23,42,.08);",
    "box-shadow:0 18px 40px -18px rgba(2,6,23,.45),0 2px 6px -2px rgba(2,6,23,.12);",
    "font-size:13px;line-height:1.6;bottom:96px;}",
    ".smart-nudge[hidden]{display:none !important;}",
    ".smart-nudge .smart-title{font-weight:700;font-size:13px;}",
    ".smart-nudge .smart-body{color:#475569;white-space:pre-wrap;word-break:break-word;}",
    ".smart-nudge .smart-cta{align-self:flex-start;border:none;cursor:pointer;padding:7px 14px;",
    "border-radius:999px;font:inherit;font-weight:700;font-size:12px;color:#fff;",
    "background:var(--gs-primary,#3b82f6);}",
    ".smart-nudge .smart-dismiss{position:absolute;top:-8px;width:22px;height:22px;border-radius:50%;",
    "border:1px solid rgba(15,23,42,.1);background:#fff;color:#64748b;cursor:pointer;display:flex;",
    "align-items:center;justify-content:center;font-size:13px;line-height:1;padding:0;}",
    ".smart-nudge.bottom-right{right:24px;}",
    ".smart-nudge.bottom-left{left:24px;}",
    ".smart-nudge.bottom-right .smart-dismiss{left:-8px;}",
    ".smart-nudge.bottom-left .smart-dismiss{right:-8px;}",
    "@keyframes gs-smart-in{from{opacity:0;transform:translateY(10px) scale(.96);}to{opacity:1;transform:translateY(0) scale(1);}}",
    ".anim-on .smart-nudge{animation:gs-smart-in .34s cubic-bezier(.22,1,.36,1) both;}",
    "@media(max-width:480px){.smart-nudge{bottom:84px;max-width:calc(100vw - 40px);}}",
  ].join("");

  // ─── <gs-widget> custom element ───
  // Defining it once is safe; if some host page already registered it, we no-op.
  if (!customElements.get(ELEMENT_TAG)) {
    try {
      customElements.define(ELEMENT_TAG, class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: "open" });
        }
      });
    } catch (e) {
      warn("custom element define failed", e);
    }
  }

  // ─── Shell bootstrap ───
  var WORKSPACE_ID = null;
  var sessionToken = null;
  var configData = null;
  var runtimeLoaded = false;
  var runtimeLoading = false;
  // Set once a runtime asset load has failed. Guards the SILENT preload
  // path only (preloadRuntimeForSmart) so a visitor whose network/ad-blocker
  // blocks runtime.js/css doesn't get re-fetched every tick() (1s) forever.
  // An explicit launcher click bypasses this and retries anyway, since
  // that's a user gesture and self-limited.
  var runtimeLoadFailed = false;
  // True once something wants the panel visibly open when the runtime
  // finishes loading — a real launcher click, or a click that raced in
  // while a Smart Engagement silent preload (see preloadRuntimeForSmart)
  // was already in flight. A silent preload alone never sets this.
  var wantRuntimeOpen = false;
  var shellEl = null;
  var shadowRoot = null;
  var shellContentEl = null;
  var launcherEl = null;
  var errorToastEl = null;
  var isOpen = false;
  // Singletons for background loops the loader owns. Guard against double
  // start in case bootstrap() is somehow re-entered (defense in depth — the
  // singleton flag at the top of the IIFE already prevents this in practice).
  var trackingStarted = false;
  // Smart Engagement — bootstrap-derived facts the evaluator needs.
  var visitorIsNew = null;
  var availabilityOnline = true;
  var smartStarted = false;

  function mountShell() {
    if (shellEl) return; // singleton
    // Defense in depth: if a previous loader run left a shell node in the
    // DOM (e.g. inside an SPA route that didn't fully unmount us), adopt
    // it instead of creating a duplicate.
    var existing = document.querySelector(ELEMENT_TAG);
    if (existing && existing.shadowRoot) {
      shellEl = existing;
      shadowRoot = existing.shadowRoot;
      shellContentEl = shadowRoot.querySelector(".shell");
      var existingLauncher = shadowRoot.querySelector(".launcher");
      if (existingLauncher) launcherEl = existingLauncher;
      var existingToast = shadowRoot.querySelector(".error-toast");
      if (existingToast) errorToastEl = existingToast;
      log("Adopted existing shell from prior load");
      return;
    }
    shellEl = document.createElement(ELEMENT_TAG);
    shellEl.setAttribute("data-version", LOADER_VERSION);
    document.body.appendChild(shellEl);
    shadowRoot = shellEl.shadowRoot;

    var style = document.createElement("style");
    style.textContent = SHELL_CSS;
    shadowRoot.appendChild(style);

    var shellDiv = document.createElement("div");
    shellDiv.className = "shell";
    shellContentEl = shellDiv;
    // Do NOT set a brand color here — that would cause a blue-flash before
    // the workspace's real color arrives via /config. The launcher itself
    // stays hidden until applyConfigToShell() runs (or, in launcher-only
    // failure mode, attachLauncherClick reveals a neutral launcher).
    shadowRoot.appendChild(shellDiv);

    launcherEl = document.createElement("button");
    launcherEl.type = "button";
    // `pending` keeps the launcher invisible (opacity:0, no pointer events)
    // until config arrives. This eliminates the visible blue→brand flash.
    launcherEl.className = "launcher bottom-right pending";
    launcherEl.setAttribute("aria-label", "Open chat");
    launcherEl.innerHTML =
      '<svg class="chat-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' +
      '<svg class="close-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    shellDiv.appendChild(launcherEl);

    errorToastEl = document.createElement("div");
    errorToastEl.className = "error-toast";
    shellDiv.appendChild(errorToastEl);

    log("Shell mounted (Shadow DOM)");
  }

  // Loader-level error strings — a tiny, standalone dict (not the full
  // runtime.js I18n table, which isn't loaded yet when these can fire).
  var LOADER_STRINGS = {
    en: {
      notConfigured: "Chat is not configured.",
      resourcesUnavailable: "Chat resources unavailable.",
      couldNotStart: "Chat could not start.",
      resourcesFailed: "Chat resources failed to load.",
      chatUnavailable: "Chat unavailable.",
      notAuthorized: "Chat not authorized for this site.",
      bootstrapFailed: "Could not start chat.",
      configFailed: "Could not load chat settings.",
    },
    fa: {
      notConfigured: "چت پیکربندی نشده است.",
      resourcesUnavailable: "منابع چت در دسترس نیست.",
      couldNotStart: "چت راه‌اندازی نشد.",
      resourcesFailed: "بارگذاری منابع چت ناموفق بود.",
      chatUnavailable: "چت در دسترس نیست.",
      notAuthorized: "این سایت مجاز به استفاده از چت نیست.",
      bootstrapFailed: "راه‌اندازی چت ممکن نشد.",
      configFailed: "بارگذاری تنظیمات چت ناموفق بود.",
    },
    tr: {
      notConfigured: "Sohbet yapılandırılmamış.",
      resourcesUnavailable: "Sohbet kaynakları kullanılamıyor.",
      couldNotStart: "Sohbet başlatılamadı.",
      resourcesFailed: "Sohbet kaynakları yüklenemedi.",
      chatUnavailable: "Sohbet kullanılamıyor.",
      notAuthorized: "Bu site için sohbete izin verilmiyor.",
      bootstrapFailed: "Sohbet başlatılamadı.",
      configFailed: "Sohbet ayarları yüklenemedi.",
    },
  };
  function lt(key) {
    var raw = (configData && configData.locale) || document.documentElement.lang || navigator.language || "en";
    var locale = String(raw).toLowerCase().split("-")[0];
    var dict = LOADER_STRINGS[locale] || LOADER_STRINGS.en;
    return dict[key] || LOADER_STRINGS.en[key] || key;
  }

  function showShellError(message) {
    if (!errorToastEl) return;
    errorToastEl.textContent = message;
    errorToastEl.classList.add("visible");
    setTimeout(function () { errorToastEl.classList.remove("visible"); }, 6000);
  }

  // ─── Launcher (FAB) icon set — kept byte-identical with the operator
  // preview (src/components/app/widget/WidgetLivePreview.tsx) so what the
  // operator configures is exactly what the visitor sees.
  var FAB_ICONS = {
    chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    headset: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  };

  // Scale is stored either as a percentage (80–140) or a multiplier (0.8–1.4).
  // Normalize both to a multiplier, clamped to the supported range.
  function normalizeFabScale(raw) {
    var n = Number(raw);
    if (!isFinite(n) || n <= 0) return 1;
    if (n > 3) n = n / 100;
    return Math.min(1.4, Math.max(0.8, n));
  }

  var fabLabelEl = null;
  function applyFabConfig(config, posClass) {
    var fab = (config && config.fab) || {};
    var scale = normalizeFabScale(fab.scale);
    var size = Math.round(56 * scale);
    launcherEl.style.width = size + "px";
    launcherEl.style.height = size + "px";
    if (String(fab.shape || "circle") === "square") launcherEl.classList.add("square");
    if (fab.animation === true) launcherEl.classList.add("pulse");
    launcherEl.style.color = fab.iconColor || "#ffffff";
    var icon = FAB_ICONS[fab.icon] || FAB_ICONS.chat;
    launcherEl.innerHTML =
      '<svg class="chat-icon" viewBox="0 0 24 24">' + icon + '</svg>' +
      '<svg class="close-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';

    // Optional text chip beside the launcher.
    var shellDiv2 = shadowRoot.querySelector(".shell");
    if (fabLabelEl && fabLabelEl.parentNode) fabLabelEl.parentNode.removeChild(fabLabelEl);
    fabLabelEl = null;
    var label = fab.label ? String(fab.label).trim() : "";
    if (label && shellDiv2) {
      fabLabelEl = document.createElement("div");
      fabLabelEl.className = "gs-fab-label";
      fabLabelEl.textContent = label;
      fabLabelEl.style.bottom = Math.round(24 + size / 2 - 15) + "px";
      if (posClass === "bottom-left") fabLabelEl.style.left = (size + 36) + "px";
      else fabLabelEl.style.right = (size + 36) + "px";
      if (fab.textColor) fabLabelEl.style.color = fab.textColor;
      shellDiv2.appendChild(fabLabelEl);
    }
  }

  function applyConfigToShell(config) {
    if (!shadowRoot) return;
    var shellDiv = shadowRoot.querySelector(".shell");
    if (shellDiv) {
      shellDiv.style.setProperty("--gs-primary", config.primaryColor || "#3B82F6");
      // Second gradient stop for the full-panel gradient canvas.
      shellDiv.style.setProperty(
        "--gs-secondary",
        config.secondaryColor || config.primaryColor || "#6366F1"
      );
    }
    var posClass = config.position === "bottom-left" ? "bottom-left" : "bottom-right";
    if (launcherEl) {
      // Set position + reveal in one paint so the user never sees a wrong
      // color first. The CSS transitions opacity so it fades in cleanly.
      launcherEl.className = "launcher " + posClass + " revealed";
      // ─── Workspace launcher (FAB) customization ───
      // The operator configures these under Widget → Appearance. The live
      // preview renders the exact same rules, so site == preview.
      applyFabConfig(config, posClass);
    }
  }

  // ─── HTTP helper with capped retries & jitter ───
  function fetchWithRetry(url, opts, attempts) {
    attempts = attempts || 3;
    var attempt = 0;
    return new Promise(function (resolve, reject) {
      function go() {
        attempt++;
        fetch(url, opts).then(function (r) {
          if (r.status >= 500 && attempt < attempts) return delay();
          resolve(r);
        }).catch(function (err) {
          if (attempt < attempts) return delay(err);
          reject(err);
        });
      }
      function delay(err) {
        var ms = Math.min(2000, 200 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 150);
        log("retry in", ms, "ms (attempt " + attempt + ")");
        setTimeout(go, ms);
      }
      go();
    });
  }

  // ─── Bootstrap flow ───
  function bootstrap() {
    mountShell();
    WORKSPACE_ID = getWorkspaceId();
    var assetBase = getAssetBase();
    var apiBase = getApiBase();
    window.__gs._id = WORKSPACE_ID;
    // Phase 8B — expose API base to sidecar modules (e.g. runtime-call.js)
    // so they can talk to the widget API without re-resolving env. Single
    // additive global; no FSM/transport touch.
    window.__gs._api = apiBase || '';

    log("workspace:", WORKSPACE_ID || "(none)", "api:", apiBase || "(empty)", "asset:", assetBase || "(empty)");

    if (!apiBase) {
      log("No apiBase — launcher-only mode");
      attachLauncherClick({ launcherOnly: true });
      return;
    }
    if (!WORKSPACE_ID) {
      warn("No workspace id");
      attachLauncherClick({ launcherOnly: true });
      return;
    }

    var bootstrapUrl = apiBase + "/api/widget/bootstrap";
    var bootstrapBody = JSON.stringify({
      workspace_id: WORKSPACE_ID,
      origin: window.location.origin,
    });

    fetchWithRetry(bootstrapUrl, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: bootstrapBody,
    }, 3)
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          throw new Error("unauthorized");
        }
        if (!r.ok) throw new Error("bootstrap_failed_" + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.disabled) {
          log("Widget disabled by server");
          if (shellEl) shellEl.remove();
          return null;
        }
        // Phase 8 — hide_widget on NEW loads only. We treat any widget
        // load that has no prior conversation cookie as a "new load".
        // Existing active sessions remain visible because the runtime
        // is what reads the cookie via /identity/history; here we only
        // suppress the shell when bootstrap explicitly tells us to and
        // there is no in-flight conversation context yet.
        try {
          var av = data && data.availability;
          if (av && av.state === 'offline' && av.offline_mode === 'hide_widget') {
            // We can't read HttpOnly dvsid, so use a non-identity hint
            // cookie set by the runtime when a conversation is active.
            var hasActive = (document.cookie || '').indexOf('gs_active=') !== -1;
            if (!hasActive) {
              log("hide_widget — new load, removing shell");
              if (shellEl) shellEl.remove();
              return null;
            }
            log("hide_widget — active session detected, keeping shell");
          }
        } catch (_) {}
        sessionToken = data.session_token;
        WORKSPACE_ID = data.workspace_id || WORKSPACE_ID;
        window.__gs._id = WORKSPACE_ID;
        // Smart Engagement facts that only bootstrap knows.
        if (typeof data.is_new_visitor === 'boolean') visitorIsNew = data.is_new_visitor;
        try {
          if (data && data.availability && data.availability.state) {
            availabilityOnline = data.availability.state === 'online';
          }
        } catch (_) {}
        // Publish to shared bus so runtime + realtime driver use the same token.
        try { window.__gs_token.set(sessionToken); } catch (_) {}
        // Phase 6C — stash the effective realtime policy snapshot from
        // bootstrap so the runtime can honor degraded/force_polling/typing
        // suppression / reconnect backoff multiplier without a separate
        // round-trip. Forward-compatible: older runtimes ignore unknown
        // window keys.
        try {
          if (data && data.effective_policy) {
            window.__gs_policy = data.effective_policy;
          }
        } catch (_) {}

        return fetchWithRetry(
          apiBase + "/api/widget/config?workspace_id=" + encodeURIComponent(WORKSPACE_ID),
          {
            credentials: "include",
            headers: { "X-Widget-Token": sessionToken },
          },
          3
        );
      })
      .then(function (r) {
        if (!r) return null;
        if (!r.ok) throw new Error("config_failed_" + r.status);
        return r.json();
      })
      .then(function (config) {
        if (!config || !config.enabled) return;
        configData = config;
        configData._sessionToken = sessionToken;
        configData._apiBase = apiBase;
        configData._assetBase = assetBase;
        configData._loaderVersion = LOADER_VERSION;
        if (config.debugMode) DEBUG = true;

        applyConfigToShell(config);
        attachLauncherClick({ launcherOnly: false });

        if (config.features && config.features.visitorTracking) {
          scheduleDeferred(function () {
            if (trackingStarted) return;
            trackingStarted = true;
            startTracking(apiBase, WORKSPACE_ID, sessionToken);
          });
        }

        // Smart Engagement — proactive rules. Runs entirely in the loader so
        // a nudge can appear before the heavy runtime bundle is fetched.
        try {
          if (config.smart && config.smart.enabled &&
              config.smart.rules && config.smart.rules.length) {
            startSmart(config);
          }
        } catch (e) { warn("smart init failed", e); }

        // Public API placeholder until runtime mounts
        widgetApi = {
          open: function () { triggerOpen(); },
          close: function () { triggerClose(); },
          toggle: function () { triggerOpen(); },
          setUnread: function (count) { setUnreadBadge(count); },
        };
        ready = true;
        processQueue();
      })
      .catch(function (err) {
        var msg = (err && err.message) || "unknown";
        warn("Bootstrap error:", msg);
        var human = lt("chatUnavailable");
        if (msg === "unauthorized") human = lt("notAuthorized");
        else if (msg.indexOf("bootstrap_failed") === 0) human = lt("bootstrapFailed");
        else if (msg.indexOf("config_failed") === 0) human = lt("configFailed");
        attachLauncherClick({ launcherOnly: true, errorMessage: human });
      });
  }

  function attachLauncherClick(opts) {
    if (!launcherEl) return;
    // Idempotent — never bind the click handler more than once even if
    // bootstrap() is somehow re-entered.
    if (launcherEl.__gsClickBound) return;
    launcherEl.__gsClickBound = true;
    // Reveal even in launcher-only / error mode so the user sees SOMETHING
    // instead of a permanently hidden widget. Use a neutral gray so we
    // don't flash a wrong brand color.
    if (launcherEl.classList.contains("pending")) {
      var shellDiv = shadowRoot && shadowRoot.querySelector(".shell");
      if (shellDiv && !shellDiv.style.getPropertyValue("--gs-primary")) {
        shellDiv.style.setProperty("--gs-primary", "#6B7280"); // neutral
      }
      launcherEl.classList.remove("pending");
      launcherEl.classList.add("revealed");
    }
    launcherEl.addEventListener("click", function () {
      if (opts.errorMessage) { showShellError(opts.errorMessage); return; }
      if (opts.launcherOnly) { showShellError(lt("notConfigured")); return; }
      onLauncherClick();
    });
  }

  function triggerOpen() {
    if (!launcherEl) return;
    if (runtimeLoaded && window.__gs_runtime && window.__gs_runtime._instance) {
      window.__gs_runtime._instance.open();
      isOpen = true;
      launcherEl.classList.add("open");
      return;
    }
    onLauncherClick();
  }
  function triggerClose() {
    if (runtimeLoaded && window.__gs_runtime && window.__gs_runtime._instance) {
      try { window.__gs_runtime._instance.close(); } catch (_) {}
    }
    isOpen = false;
    if (launcherEl) launcherEl.classList.remove("open");
  }
  // Exposed so the panel's own collapse chevron can close deterministically
  // instead of round-tripping through a hidden launcher click (which could
  // desync `isOpen` and leave the launcher stuck in the "open" state).
  try { window.__gs_panel_close = triggerClose; } catch (_) {}

  function onLauncherClick() {
    if (!configData) return;
    if (runtimeLoaded && window.__gs_runtime && window.__gs_runtime._instance) {
      window.__gs_runtime._instance.toggle();
      isOpen = !isOpen;
      launcherEl.classList.toggle("open", isOpen);
      return;
    }
    // A Smart Engagement silent preload (see preloadRuntimeForSmart) may
    // already have a load in flight. Upgrade it to "open when ready"
    // instead of starting a second, redundant load.
    wantRuntimeOpen = true;
    if (runtimeLoading) return;
    loadRuntimeAssets();
  }

  // Loads runtime.css + runtime.js (+ the call-module sidecar) and calls
  // window.__gs_runtime.init(). Shared by onLauncherClick (visitor clicked
  // the launcher) and preloadRuntimeForSmart (Smart Engagement background
  // preload — see there). `wantRuntimeOpen` decides whether the panel
  // actually opens once ready and whether a load failure surfaces a visible
  // error — a silent preload must never pop an error at a visitor who
  // hasn't asked for anything yet.
  function loadRuntimeAssets() {
    if (runtimeLoaded || runtimeLoading) return;
    runtimeLoading = true;

    var assetBase = configData._assetBase;
    // ─────────────────────────────────────────────────────────────
    // Asset URL resolution — STRICT.
    // We deliberately do NOT fall back to unhashed `/widget/runtime.css`
    // / `/widget/runtime.js` if the backend config didn't provide
    // hashed URLs. The unhashed files exist on the CDN (copied from
    // `public/widget/`) and a year-long cache on them would pin an
    // OLD widget version for the visitor — that was the "old style
    // sometimes appears" bug. Better to fail loudly so a refresh
    // recovers than to silently serve stale assets for a year.
    // ─────────────────────────────────────────────────────────────
    var runtimeCss = configData.styleUrl || "";
    var runtimeJs = configData.runtimeUrl || "";
    var callRuntimeJs = configData.callRuntimeUrl || "";
    // Pass 2 — vendor LiveKit SDK URL (hashed, self-hosted). Set BEFORE
    // any runtime-call.js script runs so its strict loadSdk() never has
    // to fall back to anything. When this is missing the call surface
    // surfaces a `sdk_url_missing` error at Join time — never silently.
    var livekitSdkUrl = configData.livekitSdkUrl || "";
    if (livekitSdkUrl) {
      try { window.__gs_call_sdk_url = livekitSdkUrl; } catch (_) { /* noop */ }
    }
    if (!runtimeJs || !runtimeCss) {
      warn("No runtime URL");
      runtimeLoading = false;
      if (wantRuntimeOpen) showShellError(lt("resourcesUnavailable"));
      return;
    }

    var cssLoaded = !runtimeCss;
    var jsLoaded = false;
    var failed = false;

    function done() {
      if (failed || !cssLoaded || !jsLoaded) return;
      runtimeLoaded = true;
      runtimeLoading = false;
      if (window.__gs_runtime && window.__gs_runtime.init) {
        try {
          var instance = window.__gs_runtime.init(configData, {
            shadowRoot: shadowRoot,
            shellEl: shellEl,
            launcher: launcherEl,
            setUnread: setUnreadBadge,
          });
          window.__gs_runtime._instance = instance;
          widgetApi = {
            open: function () { instance.open(); isOpen = true; launcherEl.classList.add("open"); },
            close: function () { instance.close(); isOpen = false; launcherEl.classList.remove("open"); },
            toggle: function () { instance.toggle(); isOpen = !isOpen; launcherEl.classList.toggle("open", isOpen); },
            setUnread: setUnreadBadge,
          };
          ready = true;
          if (wantRuntimeOpen) {
            isOpen = true;
            launcherEl.classList.add("open");
          }
          processQueue();
        } catch (e) {
          warn("Runtime init failed", e);
          if (wantRuntimeOpen) showShellError(lt("couldNotStart"));
        }
      } else {
        warn("Runtime did not register __gs_runtime");
        if (wantRuntimeOpen) showShellError(lt("couldNotStart"));
      }
    }

    function fail(what) {
      // Prevent re-entry: if we already failed, don't toast/log twice.
      if (failed) return;
      failed = true;
      runtimeLoading = false;
      runtimeLoadFailed = true;
      warn("Runtime asset failed:", what);
      // Clean up any half-loaded sibling so a successful CSS load does
      // not later flip `cssLoaded=true` and re-enter `done()` with a
      // mismatched runtime. Hard-removes the offending <script>/<link>
      // from the shadow root and head.
      try {
        var staleScript = document.head.querySelector('script[data-gs-runtime]');
        if (staleScript) staleScript.remove();
        var staleCallScript = document.head.querySelector('script[data-gs-runtime-call]');
        if (staleCallScript) staleCallScript.remove();
        if (shadowRoot) {
          var staleLink = shadowRoot.querySelector('link[data-gs-runtime]');
          if (staleLink) staleLink.remove();
        }
      } catch (_) { /* noop */ }
      if (wantRuntimeOpen) showShellError(lt("resourcesFailed"));
    }

    if (runtimeCss) {
      // Inject as <link> directly into the SHADOW ROOT — Shadow DOM supports
      // external stylesheets natively and they are NOT subject to CORS
      // (stylesheets load with no-cors semantics, just like in a normal page).
      // This avoids needing CORS headers on the static asset host.
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = runtimeCss;
      link.setAttribute("data-gs-runtime", "true");
      link.onload = function () { cssLoaded = true; done(); };
      link.onerror = function () { fail("css"); };
      shadowRoot.appendChild(link);
    }

    var script = document.createElement("script");
    script.src = runtimeJs;
    script.async = true;
    // Tag so runtime.js's lazy-inject fallback can locate this script
    // regardless of whether the filename is hashed.
    script.setAttribute("data-gs-runtime", "true");
    // Phase 9C — expose the call-module URL BEFORE runtime.js executes.
    // Two reasons this must happen here, not inside script.onload:
    //   1. runtime.js may render an invitation card and the visitor may
    //      click Join before the chat runtime's onload completes the
    //      sidecar injection (we'd then race `__gs_call_url`).
    //   2. The fallback in runtime.js that derives the URL from the
    //      runtime <script> tag uses a literal `/widget/runtime.js`
    //      match — when the asset is hashed (runtime-abc123.js, served
    //      from a CDN base) that fallback returns null and the visitor
    //      sees `call_runtime_url_unknown`. Setting the global here is
    //      the single source of truth.
    try {
      var preCallJs = callRuntimeJs || runtimeJs.replace(/runtime(?:[.-][A-Za-z0-9]+)?\.js(?:\?[^#]*)?(?:#.*)?$/, "runtime-call.js");
      if (preCallJs && preCallJs !== runtimeJs) {
        window.__gs_call_url = preCallJs;
      }
    } catch (_) { /* noop */ }
    script.onload = function () {
      jsLoaded = true;
      // Phase 8B - lazy-load the incoming call module alongside the runtime.
      // Self-contained (own shadow root, own SDK loader). Failure is
      // non-fatal: chat keeps working even if call module can't load.
      try {
        var callJs = configData.callRuntimeUrl || window.__gs_call_url || runtimeJs.replace(/runtime(?:[.-][A-Za-z0-9]+)?\.js(?:\?[^#]*)?(?:#.*)?$/, "runtime-call.js");
        if (callJs && callJs !== runtimeJs && !document.querySelector('script[data-gs-runtime-call]')) {
          // Phase 9 fix — expose readiness so the chat join handler can
          // await the call module BEFORE invoking window.__gs_call.incoming.
          // Without this the visitor could click "Join" before this script
          // executed and would hit `call_runtime_unavailable`.
          window.__gs_call_url = callJs;
          window.__gs_call_ready = window.__gs_call_ready || new Promise(function (resolve, reject) {
            window.__gs_call_resolveReady = resolve;
            window.__gs_call_rejectReady = reject;
          });
          var cs = document.createElement("script");
          cs.src = callJs;
          cs.async = true;
          cs.setAttribute("data-gs-runtime-call", "true");
          cs.onload = function () {
            // The script defines window.__gs_call synchronously inside its
            // IIFE — by the time onload fires the global is present.
            if (window.__gs_call && typeof window.__gs_call.incoming === 'function') {
              try { window.__gs_call_resolveReady && window.__gs_call_resolveReady(window.__gs_call); } catch (_) {}
            } else {
              try { window.__gs_call_rejectReady && window.__gs_call_rejectReady(new Error('call_module_loaded_but_api_missing')); } catch (_) {}
            }
          };
          cs.onerror = function () {
            warn("call module failed to load");
            try { window.__gs_call_rejectReady && window.__gs_call_rejectReady(new Error('call_module_load_failed')); } catch (_) {}
          };
          document.head.appendChild(cs);
        }
      } catch (_) { /* never block chat boot on the call module */ }
      done();
    };
    script.onerror = function () { fail("js"); };
    document.head.appendChild(script);
  }

  // Smart Engagement — silent background preload.
  //
  // A panel-bound presentation (anything but launcher_nudge) only fires
  // once the visitor's real interaction state is known (see
  // isUnknownInteraction / fire() below), and that state is only ever
  // reported by the full runtime — which otherwise loads exclusively on a
  // launcher click. A visitor who never clicked anything would leave that
  // state permanently unknown, so a rule targeting exactly that audience
  // (the point of a proactive nudge) could never fire. This loads the same
  // runtime assets in the background, WITHOUT opening the panel
  // (wantRuntimeOpen stays false), so the next tick() sees a real snapshot.
  // If the rule still matches, fire() re-enters and shows it through the
  // normal triggerOpen() -> instance.open() path.
  function preloadRuntimeForSmart() {
    if (!configData || runtimeLoadFailed) return;
    loadRuntimeAssets();
  }

  // ─── Unread badge (in shadow root) ───
  function setUnreadBadge(count) {
    if (!launcherEl) return;
    var existing = launcherEl.querySelector(".badge");
    if (existing) existing.remove();
    if (count > 0) {
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = count > 9 ? "9+" : String(count);
      launcherEl.appendChild(badge);
    }
  }

  // ─── Deferred work ───
  function scheduleDeferred(fn) {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout: 5000 });
    } else {
      setTimeout(fn, 2000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Smart Engagement — production rule evaluation.
  //
  // The loader owns this because a proactive nudge must be able to appear
  // before the (much larger) chat runtime is downloaded. Evaluation uses the
  // EXACT same bundle the operator preview uses (`smart-engine.js`, built
  // from src/lib/widget/smartEngine.ts), so what is authored is what fires.
  // ═══════════════════════════════════════════════════════════════════
  function ensureRuntimeCss(cb) {
    try {
      var href = (configData && configData.styleUrl) || "";
      if (!href || !shadowRoot) { if (cb) cb(); return; }
      if (shadowRoot.querySelector('link[data-gs-runtime]')) { if (cb) cb(); return; }
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.setAttribute("data-gs-runtime", "true");
      l.onload = function () { if (cb) cb(); };
      l.onerror = function () { if (cb) cb(); };
      shadowRoot.appendChild(l);
    } catch (_) { if (cb) cb(); }
  }

  // ─── Shared history-patch bus (SPA route-change notifications) ───
  // Both visitor tracking and Smart Engagement need to know when a
  // pushState/replaceState-driven route change happens. Patching
  // history.pushState/replaceState more than once is wasteful and, if any
  // consumer forgets `.apply`, actively breaks the chain — so there is
  // exactly one patch, shared via window, with a listener list.
  function onHistoryChange(cb) {
    if (!window.__gs_history_listeners) window.__gs_history_listeners = [];
    window.__gs_history_listeners.push(cb);
    if (window.__gs_history_patched) return;
    window.__gs_history_patched = true;
    try {
      ["pushState", "replaceState"].forEach(function (fn) {
        var original = history[fn];
        if (typeof original !== "function") return;
        history[fn] = function () {
          var out = original.apply(this, arguments);
          var listeners = window.__gs_history_listeners || [];
          for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](); } catch (_) {}
          }
          return out;
        };
      });
    } catch (_) {}
  }

  function startSmart(config) {
    if (smartStarted) return;
    smartStarted = true;

    var apiBase = configData._apiBase;
    var rules = config.smart.rules || [];
    var engineUrl = config.smart.engineUrl;
    if (!engineUrl) { warn("smart: no engine url"); return; }

    var isPreview = configData.mode === "preview" || window.__gs_preview === true;

    // ═══ smartFrequency:isoWeekKey ═══
    // ES5 mirror of src/lib/widget/smartFrequency.ts#isoWeekKey — kept in
    // lockstep by src/test/widget/smartLoader.test.ts.
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
      try { store.setItem(key, JSON.stringify(value)); } catch (_) {}
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
    var pageStart = Date.now();
    var lastActivity = Date.now();
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
      writeJson(window.sessionStorage, sessionKey, session);
    }

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
      if (!runtimeLoaded && !runtimeInstance() && !isOpen) {
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
        widgetOpen: !!isOpen,
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
          isReturning: visitorIsNew === null ? false : !visitorIsNew,
          sessionPageCount: Number(session.pages) || 1,
        },
        availability: { online: !!availabilityOnline },
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
        var token = (window.__gs_token && window.__gs_token.get()) || sessionToken;
        fetch(apiBase + "/api/widget/smart/event", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-Widget-Token": token },
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
      if (activeSurface && activeSurface.el && activeSurface.el.parentNode) {
        activeSurface.el.parentNode.removeChild(activeSurface.el);
      }
      activeSurface = null;
    }

    function surfaceHtml(content, dismissible) {
      return (dismissible === false
        ? ""
        : '<button type="button" class="smart-dismiss" data-smart-dismiss aria-label="close">\u00d7</button>') +
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

    function showNudge(rule, content) {
      if (!shellContentEl) return false;
      var posClass = configData.position === "bottom-left" ? "bottom-left" : "bottom-right";
      var el = document.createElement("div");
      el.className = "smart-nudge " + posClass;
      el.innerHTML = surfaceHtml(content, (rule.presentation_config || {}).dismissible);
      shellContentEl.appendChild(el);
      activeSurface = { ruleId: rule.id, el: el };

      var dismissBtn = el.querySelector("[data-smart-dismiss]");
      if (dismissBtn) {
        dismissBtn.addEventListener("click", function () {
          markRule(rule, "dismissed");
          report(rule, "dismissed");
          clearSurface();
        });
      }
      var ctaBtn = el.querySelector("[data-smart-cta]");
      if (ctaBtn) {
        ctaBtn.addEventListener("click", function () {
          markRule(rule, "cta");
          report(rule, "cta_clicked");
          clearSurface();
          runAction(rule);
        });
      }
      // Auto-release: a launcher nudge that the visitor never touches must
      // not block every other rule forever. After its display window we
      // remove it WITHOUT marking it dismissed, so the evaluation loop is
      // free to surface the next matching rule (still behind the global
      // cooldown). Only the visual surface is released — frequency state
      // already counted this impression.
      var behavior = rule.behavior_config || {};
      var autoSec = Number(behavior.auto_hide_seconds);
      if (!isFinite(autoSec) || autoSec <= 0) autoSec = 25;
      setTimeout(function () {
        if (activeSurface && activeSurface.el === el) clearSurface();
      }, autoSec * 1000);
      return true;
    }

    // Delivery is async (inst.showSmart may not exist yet, and may itself
    // refuse to render — e.g. a call/prechat is active). `onResult(delivered)`
    // fires once the real outcome is known, so the caller can gate
    // recordShown/"shown" telemetry on an actual render instead of assuming
    // success — see fire().
    function showPanelSurface(rule, content, onResult) {
      var pres = rule.presentation_config || {};
      var wasOpen = !!isOpen;
      triggerOpen();
      if (!wasOpen) {
        // widget_opened is only ever reported once the panel actually opens.
        var tries0 = 0;
        (function waitOpen() {
          if (isOpen) { report(rule, "widget_opened"); return; }
          if (tries0++ > 40) return;
          setTimeout(waitOpen, 100);
        })();
      }
      if (pres.mode === "open_widget") { onResult(true); return; }
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
    var SmartEngineRef = null;
    var ticking = null;

    function tick() {
      if (!SmartEngineRef || activeSurface) return;
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
      if (best) fire(best);
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

    // Engine bundle injected at most once — guards a second loader
    // execution (e.g. a stray duplicate <script> tag on the host page)
    // from downloading/registering it twice.
    if (document.querySelector('script[data-gs-smart]')) {
      SmartEngineRef = window.__gs_smart_engine || null;
      if (SmartEngineRef && SmartEngineRef.evaluateSmartRule) { attachSignals(); tick(); }
      return;
    }
    var engineScript = document.createElement("script");
    engineScript.src = engineUrl;
    engineScript.async = true;
    engineScript.setAttribute("data-gs-smart", "true");
    engineScript.onload = function () {
      SmartEngineRef = window.__gs_smart_engine;
      if (!SmartEngineRef || !SmartEngineRef.evaluateSmartRule) {
        warn("smart: engine bundle did not register");
        return;
      }
      log("smart: engine ready with", rules.length, "rule(s)");
      attachSignals();
      tick();
    };
    // Engine load failure is non-blocking — chat itself must keep working.
    engineScript.onerror = function () { warn("smart: engine failed to load"); };
    document.head.appendChild(engineScript);
  }



  // ─── Visitor tracking (background, identity owned by HttpOnly cookie) ───
  function startTracking(apiBase, workspaceId, token) {
    if (!apiBase || !workspaceId) return;
    // Use path + search so query-string-driven views (e.g. ?article=42) get
    // their own row. Hash is excluded — most apps treat it as in-page state.
    function currentPage() {
      try { return window.location.pathname + (window.location.search || ''); }
      catch (_) { return window.location.pathname; }
    }
    // Capture the document title for richer page-history entries. Falls back
    // to null so the server can decide whether to store it.
    function currentTitle() {
      try {
        var t = (document.title || '').trim();
        return t ? t.slice(0, 300) : null;
      } catch (_) { return null; }
    }
    // ─── Token state (mutable: refreshed when server returns 401/403) ───
    // The widget session token has a short TTL (15 min). Without periodic
    // refresh the heartbeat loop would emit 403/TOKEN_EXPIRED forever, which
    // upstream proxies (nginx/Coolify) eventually return as 504 *without*
    // CORS headers — surfacing as a confusing CORS error in the browser.
    // Read from the shared bus on every send so a refresh by the runtime
    // tokenManager (or vice-versa) is picked up immediately. Falls back
    // to the bootstrap token if the bus is somehow not yet initialized.
    function tokenNow() {
      try {
        var t = window.__gs_token && window.__gs_token.get();
        return t || token;
      } catch (_) { return token; }
    }
    var heartbeatTimer = null;
    var refreshing = null; // Promise<string|null> while a refresh is in flight
    var consecutiveFailures = 0;
    var STOPPED = false;

    function bootstrapSession() {
      return fetch(apiBase + "/api/widget/bootstrap", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, origin: window.location.origin }),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.session_token) {
            try { window.__gs_token.set(data.session_token); } catch (_) {}
            try {
              if (data.effective_policy) window.__gs_policy = data.effective_policy;
            } catch (_) {}
            return data.session_token;
          }
          return null;
        })
        .catch(function () { return null; });
    }

    function refreshToken() {
      if (refreshing) return refreshing;
      var t = tokenNow();
      refreshing = fetch(apiBase + "/api/widget/session/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Widget-Token": t },
      })
        .then(function (r) {
          if (!r.ok) return null;
          return r.json();
        })
        .then(function (data) {
          if (data && data.session_token) {
            try { window.__gs_token.set(data.session_token); } catch (_) {}
            try {
              if (data.effective_policy) window.__gs_policy = data.effective_policy;
            } catch (_) {}
            return data.session_token;
          }
          return null;
        })
        .catch(function () { return null; })
        .then(function (tok) { refreshing = null; return tok; });
      return refreshing;
    }

    function recoverToken() {
      return refreshToken().then(function (tok) {
        return tok || bootstrapSession();
      });
    }

    fetch(apiBase + "/api/widget/track", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Widget-Token": tokenNow() },
      body: JSON.stringify({
        workspace_id: workspaceId,
        event: "page_view",
        current_page: currentPage(),
        page_title: currentTitle(),
        referrer: document.referrer || null,
        browser: detectBrowser(),
        device: /Mobi|Android/i.test(navigator.userAgent) ? "Mobile" : "Desktop",
        os: detectOS(),
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var sessionId = data && data.session_id ? data.session_id : null;
        if (!sessionId) return;
        try { window.__gs_session_id = sessionId; } catch (_) {}
        var lastPage = currentPage();
        function doPing(tokenToUse, isRetry) {
          if (STOPPED) return;
          // Skip when the page is hidden — saves battery and avoids
          // burning rate-limit budget on backgrounded tabs.
          if (typeof document !== 'undefined' && document.hidden) return;
          fetch(apiBase + "/api/widget/action", {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json", "X-Widget-Token": tokenToUse },
            body: JSON.stringify({
              workspace_id: workspaceId,
              action: "heartbeat",
              session_id: sessionId,
              current_page: currentPage(),
              page_title: currentTitle(),
            }),
          })
            .then(function (r) {
              if (r.ok) { consecutiveFailures = 0; return; }
              // Token expired/invalid → refresh once and retry.
              if ((r.status === 401 || r.status === 403) && !isRetry) {
                return recoverToken().then(function (newTok) {
                  if (newTok) return doPing(newTok, true);
                  // Refresh failed — count as a hard failure.
                  consecutiveFailures++;
                });
              }
              consecutiveFailures++;
            })
            .catch(function () { consecutiveFailures++; })
            .then(function () {
              // Stop the loop after 5 consecutive failures so we don't
              // hammer a degraded backend (and don't trigger upstream 504s).
              if (consecutiveFailures >= 5 && heartbeatTimer) {
                STOPPED = true;
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
                warn('heartbeat stopped after repeated failures');
              }
            });
        }
        function ping() { doPing(tokenNow(), false); }
        function resumeHeartbeat(reason) {
          return recoverToken().then(function (newTok) {
            if (!newTok) return;
            STOPPED = false;
            consecutiveFailures = 0;
            if (!heartbeatTimer) heartbeatTimer = setInterval(ping, 30000);
            log('heartbeat resumed', reason);
            return doPing(newTok, false);
          });
        }
        // Background heartbeat — keeps presence "online" and refreshes
        // last_seen_at so the operator UI stays accurate.
        heartbeatTimer = setInterval(ping, 30000);
        // Resume immediately when the tab becomes visible again.
        try {
          document.addEventListener('visibilitychange', function () {
            if (document.hidden) return;
            if (STOPPED) return void resumeHeartbeat('visibilitychange');
            ping();
          });
          window.addEventListener('online', function () {
            if (STOPPED) return void resumeHeartbeat('online');
            ping();
          });
        } catch (_) {}

        // SPA navigation: many host sites (React/Vue/Next) don't reload the
        // page when the URL changes. Without this, page_history would only
        // ever record the very first URL. We listen for the three signals
        // that cover ~all client-side routers:
        //   - popstate           → back/forward buttons
        //   - pushState/replace  → router.push / router.replace
        //   - hashchange         → legacy hash routing (#/foo)
        function onUrlChange() {
          var now = currentPage();
          if (now === lastPage) return;
          lastPage = now;
          // Fire an immediate ping so the new URL is logged without waiting
          // up to 30 seconds for the next heartbeat tick.
          ping();
        }
        onHistoryChange(onUrlChange);
        window.addEventListener("popstate", onUrlChange);
        window.addEventListener("hashchange", onUrlChange);
      })
      .catch(function () {});
  }

  function detectBrowser() {
    var ua = navigator.userAgent;
    if (ua.indexOf("Chrome") > -1 && ua.indexOf("Edg") === -1) return "Chrome";
    if (ua.indexOf("Firefox") > -1) return "Firefox";
    if (ua.indexOf("Safari") > -1 && ua.indexOf("Chrome") === -1) return "Safari";
    if (ua.indexOf("Edg") > -1) return "Edge";
    return "Other";
  }
  function detectOS() {
    var ua = navigator.userAgent;
    if (ua.indexOf("Win") > -1) return "Windows";
    if (ua.indexOf("Mac") > -1) return "macOS";
    if (ua.indexOf("Linux") > -1) return "Linux";
    if (/Android/i.test(ua)) return "Android";
    if (/iPhone|iPad/i.test(ua)) return "iOS";
    return "Other";
  }

  // ─── Boot ───
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
