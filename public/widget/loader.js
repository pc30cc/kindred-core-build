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
  if (window.__gs_loaded) {
    // Loader was already injected on this page. Re-queue commands but do not
    // create a second shell or run bootstrap again.
    return;
  }
  window.__gs_loaded = true;

  var LOADER_VERSION = "2026-04-18-shell-v4";
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
    "transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease;",
    "background:var(--gs-primary,#3B82F6);color:#fff;font-family:inherit;}",
    ".launcher:hover{transform:scale(1.08);box-shadow:0 6px 28px -4px rgba(0,0,0,.3);}",
    ".launcher:active{transform:scale(.96);}",
    ".launcher.bottom-right{bottom:24px;right:24px;}",
    ".launcher.bottom-left{bottom:24px;left:24px;}",
    ".launcher svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}",
    ".launcher.open svg.chat-icon{display:none;}.launcher:not(.open) svg.close-icon{display:none;}",
    ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;",
    "background:#EF4444;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;",
    "padding:0 5px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.15);}",
    ".error-toast{position:fixed;bottom:92px;right:24px;max-width:280px;padding:10px 14px;",
    "background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;color:#991B1B;font-size:12px;",
    "box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:2147483647;display:none;}",
    ".error-toast.visible{display:block;}",
    "@media(max-width:480px){.launcher{width:50px;height:50px;}}",
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

  function mountShell() {
    if (shellEl) return; // singleton
    shellEl = document.createElement(ELEMENT_TAG);
    shellEl.setAttribute("data-version", LOADER_VERSION);
    document.body.appendChild(shellEl);
    shadowRoot = shellEl.shadowRoot;

    var style = document.createElement("style");
    style.textContent = SHELL_CSS;
    shadowRoot.appendChild(style);

    var shellDiv = document.createElement("div");
    shellDiv.className = "shell";
    shellDiv.style.setProperty("--gs-primary", "#3B82F6");
    shadowRoot.appendChild(shellDiv);

    launcherEl = document.createElement("button");
    launcherEl.type = "button";
    launcherEl.className = "launcher bottom-right";
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

  function applyConfigToShell(config) {
    if (!shadowRoot) return;
    var shellDiv = shadowRoot.querySelector(".shell");
    if (shellDiv) shellDiv.style.setProperty("--gs-primary", config.primaryColor || "#3B82F6");
    var posClass = config.position === "bottom-left" ? "bottom-left" : "bottom-right";
    if (launcherEl) launcherEl.className = "launcher " + posClass;
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
        sessionToken = data.session_token;
        WORKSPACE_ID = data.workspace_id || WORKSPACE_ID;
        window.__gs._id = WORKSPACE_ID;

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
          scheduleDeferred(function () { startTracking(apiBase, WORKSPACE_ID, sessionToken); });
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
    launcherEl.addEventListener("click", function () {
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
      window.__gs_runtime._instance.close();
      isOpen = false;
      if (launcherEl) launcherEl.classList.remove("open");
    }
  }

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
    var runtimeCss = configData.styleUrl || (assetBase ? assetBase + "/widget/runtime.css" : "");
    var runtimeJs = configData.runtimeUrl || (assetBase ? assetBase + "/widget/runtime.js" : "");
    if (!runtimeJs) {
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
      failed = true;
      runtimeLoading = false;
      warn("Runtime asset failed:", what);
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
    script.onload = function () { jsLoaded = true; done(); };
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
    fetch(apiBase + "/api/widget/track", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Widget-Token": token },
      body: JSON.stringify({
        workspace_id: workspaceId,
        event: "page_view",
        current_page: window.location.pathname,
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
        setInterval(function () {
          fetch(apiBase + "/api/widget/action", {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json", "X-Widget-Token": token },
            body: JSON.stringify({
              workspace_id: workspaceId,
              action: "heartbeat",
              session_id: sessionId,
              current_page: window.location.pathname,
            }),
          }).catch(function () {});
        }, 30000);
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
