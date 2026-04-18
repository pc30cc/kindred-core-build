/**
 */
(function () {
  "use strict";

  var LOADER_VERSION = "2026-04-18-build-7-prechat-fix";
  var DEBUG = true; // Force debug ON to diagnose pre-chat flow
  var _t0 = Date.now();

  function log(msg, data) {
    if (!DEBUG) return;
    console.info("[Widget]", msg, data !== undefined ? data : "");
  }

  log("Loader version: " + LOADER_VERSION);
  log("Loader start", _t0);

  // ─── Queued commands ───
  var GS = window.__gs || [];
  var queue = [];
  var widget = null;
  var ready = false;

  if (Array.isArray(GS)) {
    for (var i = 0; i < GS.length; i++) queue.push(GS[i]);
  }

  function processQueue() {
    while (queue.length) {
      var cmd = queue.shift();
      if (widget && typeof widget[cmd[0]] === "function") {
        widget[cmd[0]].apply(widget, cmd.slice(1));
      }
    }
  }

  window.__gs = {
    push: function () {
      var args = Array.prototype.slice.call(arguments);
      for (var i = 0; i < args.length; i++) {
        if (ready && widget && typeof widget[args[i][0]] === "function") {
          widget[args[i][0]].apply(widget, args[i].slice(1));
        } else {
          queue.push(args[i]);
        }
      }
    },
    _id: null,
  };

  // ─── Resolve script element ───
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

  function attr(name) {
    return _loaderScript && _loaderScript.getAttribute(name);
  }

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
    if (
      window.__gs_api_base &&
      typeof window.__gs_api_base === "string" &&
      window.__gs_api_base.indexOf("%VITE_") !== 0
    )
      return window.__gs_api_base.replace(/\/$/, "");
    var configured = attr("data-api-base");
    if (configured && configured.indexOf("%VITE_") !== 0) return configured.replace(/\/$/, "");
    return "";
  }

  // ─── Inline launcher CSS (critical path — no external request) ───
  var LAUNCHER_CSS =
    ".__gs-launcher{position:fixed;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
    "width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;" +
    "box-shadow:0 4px 20px -4px rgba(0,0,0,.25),0 0 0 1px rgba(0,0,0,.05);" +
    "transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease;background:var(--gs-primary,#3B82F6);color:#fff}" +
    ".__gs-launcher:hover{transform:scale(1.08);box-shadow:0 6px 28px -4px rgba(0,0,0,.3)}" +
    ".__gs-launcher:active{transform:scale(.96)}" +
    ".__gs-launcher.bottom-right{bottom:24px;right:24px}" +
    ".__gs-launcher.bottom-left{bottom:24px;left:24px}" +
    ".__gs-launcher svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s ease}" +
    ".__gs-launcher.open svg.chat-icon{display:none}.__gs-launcher:not(.open) svg.close-icon{display:none}" +
    ".__gs-badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;" +
    "background:#EF4444;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;" +
    "padding:0 5px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.15)}" +
    "@media(max-width:480px){.__gs-launcher{width:50px;height:50px}}";

  // ─── Inject inline style ───
  var styleEl = document.createElement("style");
  styleEl.textContent = LAUNCHER_CSS;
  document.head.appendChild(styleEl);

  // ─── State ───
  var WORKSPACE_ID = null;
  var sessionToken = null;
  var configData = null;
  var runtimeLoaded = false;
  var runtimeLoading = false;

  // ─── Render launcher immediately ───
  function renderLauncher(color, position) {
    var posClass = position === "bottom-left" ? "bottom-left" : "bottom-right";
    var container = document.createElement("div");
    container.className = "__gs-widget";
    container.style.cssText = "--gs-primary:" + (color || "#3B82F6");
    document.body.appendChild(container);

    var launcher = document.createElement("button");
    launcher.className = "__gs-launcher " + posClass;
    launcher.setAttribute("aria-label", "Open chat");
    launcher.innerHTML =
      '<svg class="chat-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' +
      '<svg class="close-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    container.appendChild(launcher);

    log("Launcher rendered", Date.now() - _t0 + "ms");
    return { container: container, launcher: launcher };
  }

  // ─── Bootstrap ───
  function bootstrap() {
    WORKSPACE_ID = getWorkspaceId();
    var assetBase = getAssetBase();
    var apiBase = getApiBase();

    window.__gs._id = WORKSPACE_ID;

    log("Workspace ID:", WORKSPACE_ID || "(none)");
    log("apiBase:", apiBase || "(empty)");
    log("assetBase:", assetBase || "(empty)");

    // Render launcher immediately with defaults
    var els = renderLauncher("#3B82F6", "bottom-right");

    if (!apiBase) {
      log("No apiBase — launcher only mode");
      return;
    }

    // Bootstrap request — get session token
    var bootstrapUrl = apiBase + "/api/widget/bootstrap";
    var bootstrapBody = JSON.stringify({
      workspace_id: WORKSPACE_ID,
      origin: window.location.origin,
    });

    log("Bootstrap URL:", bootstrapUrl);
    var _tConfig = Date.now();

    fetch(bootstrapUrl, {
      method: "POST",
      credentials: "include", // CRITICAL: lets server set HttpOnly dvsid cookie cross-site
      headers: { "Content-Type": "application/json" },
      body: bootstrapBody,
    })
      .then(function (r) {
        log("Bootstrap status:", r.status, "(" + (Date.now() - _tConfig) + "ms)");
        if (!r.ok) throw new Error("Bootstrap failed: " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.disabled) {
          log("Widget disabled");
          els.container.remove();
          return;
        }

        sessionToken = data.session_token;
        WORKSPACE_ID = data.workspace_id || WORKSPACE_ID;
        window.__gs._id = WORKSPACE_ID;

        log("Session token acquired");

        // Fetch full config (token-secured, also sends cookie)
        return fetch(apiBase + "/api/widget/config?workspace_id=" + encodeURIComponent(WORKSPACE_ID), {
          credentials: "include",
          headers: { "X-Widget-Token": sessionToken },
        });
      })
      .then(function (r) {
        if (!r) return;
        log("Config response:", r.status, "(" + (Date.now() - _tConfig) + "ms)");
        if (!r.ok) throw new Error("Config fetch failed: " + r.status);
        return r.json();
      })
      .then(function (config) {
        if (!config || !config.enabled) return;

        configData = config;
        configData._sessionToken = sessionToken;
        configData._apiBase = apiBase;
        configData._assetBase = assetBase;
        DEBUG = !!config.debugMode;

        // Update launcher appearance from config
        els.container.style.cssText = "--gs-primary:" + (config.primaryColor || "#3B82F6");
        var posClass = config.position === "bottom-left" ? "bottom-left" : "bottom-right";
        els.launcher.className = "__gs-launcher " + posClass;

        log("Config loaded. Features:", config.features);

        // Attach click handler — lazy loads runtime
        els.launcher.addEventListener("click", function () {
          onLauncherClick(els, config, apiBase, assetBase);
        });

        // Deferred: visitor tracking (non-blocking, after idle)
        if (config.features && config.features.visitorTracking) {
          scheduleDeferred(function () {
            startTracking(apiBase, WORKSPACE_ID, sessionToken);
          });
        }

        // Process any queued commands
        widget = {
          open: function () {
            onLauncherClick(els, config, apiBase, assetBase);
          },
          close: function () {
            if (window.__gs_runtime && window.__gs_runtime._instance) window.__gs_runtime._instance.close();
          },
          toggle: function () {
            onLauncherClick(els, config, apiBase, assetBase);
          },
          setUnread: function (count) {
            setUnreadBadge(els.launcher, count);
          },
        };
        ready = true;
        processQueue();
      })
      .catch(function (err) {
        log("Bootstrap error:", err);
      });
  }

  // ─── Launcher click → lazy load runtime ───
  var isOpen = false;
  function onLauncherClick(els, config, apiBase, assetBase) {
    if (runtimeLoaded && window.__gs_runtime && window.__gs_runtime._instance) {
      window.__gs_runtime._instance.toggle();
      isOpen = !isOpen;
      els.launcher.classList.toggle("open", isOpen);
      return;
    }

    if (runtimeLoading) return;
    runtimeLoading = true;

    log("Loading runtime shell...");
    var _tRuntime = Date.now();

    // Load CSS + JS in parallel
    var runtimeCss = config.styleUrl || (assetBase ? assetBase + "/widget/runtime.css" : "");
    var runtimeJs = config.runtimeUrl || (assetBase ? assetBase + "/widget/runtime.js" : "");

    if (!runtimeJs) {
      log("No runtime URL");
      runtimeLoading = false;
      return;
    }

    var cssLoaded = !runtimeCss;
    var jsLoaded = false;

    function onBothLoaded() {
      if (!cssLoaded || !jsLoaded) return;
      log("Runtime loaded", Date.now() - _tRuntime + "ms");
      runtimeLoaded = true;
      runtimeLoading = false;

      if (window.__gs_runtime && window.__gs_runtime.init) {
        widget = window.__gs_runtime.init(config, els);
        window.__gs_runtime._instance = widget;
        ready = true;
        isOpen = true;
        els.launcher.classList.add("open");
        processQueue();
      }
    }

    if (runtimeCss) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = runtimeCss;
      link.onload = function () {
        cssLoaded = true;
        onBothLoaded();
      };
      link.onerror = function () {
        cssLoaded = true;
        onBothLoaded();
      };
      document.head.appendChild(link);
    }

    var script = document.createElement("script");
    script.src = runtimeJs;
    script.async = true;
    script.onload = function () {
      jsLoaded = true;
      onBothLoaded();
    };
    script.onerror = function () {
      log("Runtime script failed to load");
      runtimeLoading = false;
    };
    document.head.appendChild(script);
  }

  // ─── Unread badge ───
  function setUnreadBadge(launcher, count) {
    var existing = launcher.querySelector(".__gs-badge");
    if (existing) existing.remove();
    if (count > 0) {
      var badge = document.createElement("span");
      badge.className = "__gs-badge";
      badge.textContent = count > 9 ? "9+" : String(count);
      launcher.appendChild(badge);
    }
  }

  // ─── Deferred execution (non-blocking) ───
  function scheduleDeferred(fn) {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout: 5000 });
    } else {
      setTimeout(fn, 2000);
    }
  }

  // ─── Visitor tracking (background, non-blocking) ───
  // Identity is owned by the HttpOnly `dvsid` cookie set during /bootstrap.
  // The server resolves visitor_id from that cookie — we never read or store
  // it client-side. All tracking calls send `credentials: 'include'`.
  function startTracking(apiBase, workspaceId, token) {
    if (!apiBase || !workspaceId) return;

    log("Tracking: page view");

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
        // Heartbeat every 30s — non-blocking; cookie identifies visitor
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

  // ─── Utils ───
  function generateId() {
    return "v_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
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
