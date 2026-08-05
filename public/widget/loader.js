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

  var LOADER_VERSION = "2026-04-22-token-bus-v1";
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
    /* Welcome toast (shown by template2 — distinct from runtime.css .gs-toast).
       Lives in the loader so it can render BEFORE runtime.js is fetched. */
    ".gs-welcome-toast{position:fixed;z-index:2147483645;bottom:96px;right:24px;",
    "max-width:300px;background:#fff;color:#1F2937;padding:12px 14px 12px 16px;",
    "border-radius:14px;box-shadow:0 14px 40px -10px rgba(0,51,153,.28),0 0 0 1px rgba(15,23,42,.05);",
    "cursor:pointer;font-family:'Vazirmatn',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
    "opacity:0;transform:translateY(10px) scale(.96);pointer-events:none;",
    "transition:opacity .25s ease,transform .3s cubic-bezier(.34,1.56,.64,1);}",
    ".gs-welcome-toast.bottom-left{left:24px;right:auto;}",
    ".gs-welcome-toast.visible{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}",
    ".gs-welcome-toast .gs-wt-row{display:flex;gap:10px;align-items:flex-start;}",
    ".gs-welcome-toast .gs-wt-avatar{width:34px;height:34px;border-radius:50%;flex-shrink:0;",
    "background:linear-gradient(160deg,#0052ff,#2b86ff);display:flex;align-items:center;justify-content:center;color:#fff;}",
    ".gs-welcome-toast .gs-wt-avatar svg{width:18px;height:18px;}",
    ".gs-welcome-toast .gs-wt-title{font-size:13px;font-weight:700;color:#0052ff;margin-bottom:2px;}",
    ".gs-welcome-toast .gs-wt-body{font-size:13px;line-height:1.45;color:#374151;}",
    ".gs-welcome-toast .gs-wt-close{position:absolute;top:6px;left:8px;width:20px;height:20px;",
    "border:none;background:transparent;color:#9CA3AF;cursor:pointer;border-radius:50%;",
    "display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;}",
    ".gs-welcome-toast .gs-wt-close:hover{background:#F3F4F6;color:#374151;}",
    ".gs-welcome-toast[dir=rtl] .gs-wt-close{left:auto;right:8px;}",
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
  var shellEl = null;
  var shadowRoot = null;
  var launcherEl = null;
  var errorToastEl = null;
  var isOpen = false;
  // Singletons for background loops the loader owns. Guard against double
  // start in case bootstrap() is somehow re-entered (defense in depth — the
  // singleton flag at the top of the IIFE already prevents this in practice).
  var trackingStarted = false;

  function mountShell() {
    if (shellEl) return; // singleton
    // Defense in depth: if a previous loader run left a shell node in the
    // DOM (e.g. inside an SPA route that didn't fully unmount us), adopt
    // it instead of creating a duplicate.
    var existing = document.querySelector(ELEMENT_TAG);
    if (existing && existing.shadowRoot) {
      shellEl = existing;
      shadowRoot = existing.shadowRoot;
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

  function showShellError(message) {
    if (!errorToastEl) return;
    errorToastEl.textContent = message;
    errorToastEl.classList.add("visible");
    setTimeout(function () { errorToastEl.classList.remove("visible"); }, 6000);
  }

  // Welcome toast — used by template2 to surface a friendly nudge a few
  // seconds after the page loads, similar to popular SaaS chat widgets.
  // Lives in the loader so it appears BEFORE runtime.js is fetched.
  var welcomeToastEl = null;
  var welcomeToastShown = false;
  function scheduleWelcomeToast(config, posClass) {
    if (welcomeToastShown) return;
    if (!shadowRoot) return;
    // Respect dismissal across page navigations (per-tab).
    try {
      if (sessionStorage.getItem("__gs_wt_dismissed") === "1") return;
    } catch (_) {}
    var delayMs = 3500;
    setTimeout(function () { showWelcomeToast(config, posClass); }, delayMs);
  }
  function showWelcomeToast(config, posClass) {
    if (welcomeToastShown) return;
    if (!shadowRoot) return;
    var shellDiv = shadowRoot.querySelector(".shell");
    if (!shellDiv) return;
    welcomeToastShown = true;
    welcomeToastEl = document.createElement("div");
    welcomeToastEl.className = "gs-welcome-toast " + (posClass || "bottom-right");
    var brandName = (config && config.brandName) ? String(config.brandName) : "Support";
    var welcomeMsg = (config && config.welcomeMessage)
      ? String(config.welcomeMessage)
      : "سلام! چطور می‌توانم کمکتان کنم؟";
    var safeName = brandName.replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
    var safeMsg = welcomeMsg.replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
    welcomeToastEl.innerHTML =
      '<button type="button" class="gs-wt-close" aria-label="Close">×</button>' +
      '<div class="gs-wt-row">' +
        '<div class="gs-wt-avatar">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
        '</div>' +
        '<div class="gs-wt-text">' +
          '<div class="gs-wt-title">' + safeName + '</div>' +
          '<div class="gs-wt-body">' + safeMsg + '</div>' +
        '</div>' +
      '</div>';
    shellDiv.appendChild(welcomeToastEl);
    // Animate in next frame.
    requestAnimationFrame(function () {
      if (welcomeToastEl) welcomeToastEl.classList.add("visible");
    });
    // Click body → open widget; click × → dismiss only.
    welcomeToastEl.addEventListener("click", function (e) {
      var target = e.target;
      if (target && target.classList && target.classList.contains("gs-wt-close")) {
        dismissWelcomeToast(true);
        return;
      }
      dismissWelcomeToast(false);
      if (launcherEl) launcherEl.click();
    });
    // Auto-hide after 12s if untouched.
    setTimeout(function () { dismissWelcomeToast(false); }, 12000);
  }
  function dismissWelcomeToast(persist) {
    if (!welcomeToastEl) return;
    welcomeToastEl.classList.remove("visible");
    if (persist) {
      try { sessionStorage.setItem("__gs_wt_dismissed", "1"); } catch (_) {}
    }
    var el = welcomeToastEl;
    welcomeToastEl = null;
    setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 300);
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
      // Expose template slug for CSS scoping (Task 4).
      if (config.templateSlug) {
        launcherEl.setAttribute("data-template", config.templateSlug);
        if (shellEl) shellEl.setAttribute("data-template", config.templateSlug);
        if (shellDiv) shellDiv.setAttribute("data-template", config.templateSlug);
        // Template-specific launcher icon. Each template gets a visually
        // distinct icon shape so visitors immediately perceive the skin
        // difference (request: launcher icon must NOT match the default).
        if (config.templateSlug === "template2") {
          launcherEl.innerHTML =
            // Rounded squircle bubble with three dots (template2 style)
            '<svg class="chat-icon" viewBox="0 0 32 32" fill="none" stroke="none">' +
              '<path fill="currentColor" d="M16 4C9.373 4 4 8.925 4 15c0 3.43 1.74 6.49 4.46 8.5-.18 1.36-.74 2.96-1.84 4.36-.3.38.02.94.5.86 2.7-.46 4.96-1.6 6.46-2.74 .78.16 1.6.24 2.42.24 6.627 0 12-4.925 12-11S22.627 4 16 4z"/>' +
              '<circle cx="11" cy="15" r="1.5" fill="#fff"/>' +
              '<circle cx="16" cy="15" r="1.5" fill="#fff"/>' +
              '<circle cx="21" cy="15" r="1.5" fill="#fff"/>' +
            '</svg>' +
            '<svg class="close-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
          // Inline launcher styling so the distinct skin appears immediately
          // (before runtime.css lazy-loads on first click).
          launcherEl.style.background = "linear-gradient(160deg,#0052ff 0%,#0066ff 50%,#2b86ff 100%)";
          launcherEl.style.width = "60px";
          launcherEl.style.height = "60px";
          launcherEl.style.boxShadow = "0 14px 32px -6px rgba(0,82,255,.55),0 6px 14px -2px rgba(0,0,0,.16),inset 0 1px 0 rgba(255,255,255,.18)";
          scheduleWelcomeToast(config, posClass);
        }
      }
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
        var human = "Chat unavailable.";
        if (msg === "unauthorized") human = "Chat not authorized for this site.";
        else if (msg.indexOf("bootstrap_failed") === 0) human = "Could not start chat.";
        else if (msg.indexOf("config_failed") === 0) human = "Could not load chat settings.";
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
      dismissWelcomeToast(true);
      if (opts.errorMessage) { showShellError(opts.errorMessage); return; }
      if (opts.launcherOnly) { showShellError("Chat is not configured."); return; }
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
    if (runtimeLoading) return;
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
      showShellError("Chat resources unavailable.");
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
          isOpen = true;
          launcherEl.classList.add("open");
          processQueue();
        } catch (e) {
          warn("Runtime init failed", e);
          showShellError("Chat could not start.");
        }
      } else {
        warn("Runtime did not register __gs_runtime");
        showShellError("Chat could not start.");
      }
    }

    function fail(what) {
      // Prevent re-entry: if we already failed, don't toast/log twice.
      if (failed) return;
      failed = true;
      runtimeLoading = false;
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
      showShellError("Chat resources failed to load.");
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
        try {
          var origPush = history.pushState;
          var origReplace = history.replaceState;
          history.pushState = function () {
            var r = origPush.apply(this, arguments);
            try { onUrlChange(); } catch (_) {}
            return r;
          };
          history.replaceState = function () {
            var r = origReplace.apply(this, arguments);
            try { onUrlChange(); } catch (_) {}
            return r;
          };
          window.addEventListener("popstate", onUrlChange);
          window.addEventListener("hashchange", onUrlChange);
        } catch (_) {/* read-only history in some sandboxes */}
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
