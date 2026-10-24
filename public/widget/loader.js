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
 *  - Identity/security model is untouched: cookies + the widget session
 *    token (X-Widget-Token; on a backend that says protocol >= 3, the same
 *    token in the body of /track and /visitor-presence — see tokenPost).
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

  // The Iran region's local kit (its floating button) is shipped only where
  // that region is served. The RESPOK build (scripts/build/widgetBrand.mjs)
  // deletes every block between the `@iran-kit` markers and sets this to
  // false, so the minifier drops each `if (LOCAL_KIT ...)` branch too: every
  // use of what those blocks define must sit inside such a branch.
  var LOCAL_KIT = true;
  // The mirror for the International edition's kit (RESPOK's floating
  // button): the Iran build deletes every `@intl-kit` block and sets this to
  // false, so every `if (INTL_KIT ...)` branch goes too and an Iran-brand
  // deployment switched to the International edition shows the plain
  // launcher (docs/operations/WIDGET_TEMPLATE_RULES.md §5).
  var INTL_KIT = true;

  // DEBUG defaults to OFF in production. Opt in via:
  //   window.__gs_debug = true          (developer console)
  //   localStorage.setItem('gs:debug','1')  (same key runtime.js/
  //                                          runtime-chat.js already honor —
  //                                          kept consistent here too)
  //   data-debug="true" attribute on the loader script
  //   config.debugMode === true         (server-driven)
  function readLsDebug() {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem('gs:debug') === '1'; }
    catch (_) { return false; }
  }
  var DEBUG = window.__gs_debug === true || readLsDebug();

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

  // ─── Public event bus ────────────────────────────────────────────────
  // onReady/onOpen/onClose/onMessage/onUnreadChange are registered through
  // the SAME __gs.push(['onOpen', fn]) command mechanism as every other
  // public command — a listener registration is just a command whose
  // effect is "remember this callback" instead of "do a thing once". No
  // second dispatch mechanism, no new top-level method on window.__gs.
  var readyFired = false;
  var eventListeners = { ready: [], open: [], close: [], message: [], unreadchange: [] };
  function emitPublicEvent(name, payload) {
    var arr = eventListeners[name];
    if (!arr) return;
    // Snapshot before iterating — a listener registering/unregistering
    // another listener mid-emit must never skip or double-fire siblings.
    var snap = arr.slice();
    for (var i = 0; i < snap.length; i++) {
      try { snap[i](payload); } catch (e) { warn("public event listener error (" + name + ")", e); }
    }
  }
  function onPublicEvent(name) {
    return function (cb) {
      if (typeof cb !== "function") return;
      eventListeners[name].push(cb);
      // A listener registered AFTER the widget already became ready must
      // still get its one 'ready' call — otherwise `push(['onReady', fn])`
      // called late (e.g. after a slow host-page script) would silently
      // never fire.
      if (name === "ready" && readyFired) { try { cb(); } catch (e) { warn("onReady listener error", e); } }
    };
  }
  // Bridge so runtime.js (loaded lazily, a separate script) can emit
  // 'message' events without reaching into loader-internal state — the
  // ONLY cross-file public-event hook. Never exposes tokens/ids/internal
  // objects; runtime.js is responsible for handing this a minimal payload.
  window.__gs_public_events = { emit: emitPublicEvent };
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

  // ─── Canonical widget session manager ──────────────────────────────
  // The bus above is only a value holder. THIS is the single owner of
  // session recovery for one page/widget instance:
  //
  //   bus.refresh()  — single-flight POST /api/widget/session/refresh
  //   bus.recover()  — single-flight: refresh once, and if that cannot
  //                    succeed, re-bootstrap (bounded by a cooldown) so a
  //                    token expired beyond the server's grace window is
  //                    replaced without a page reload. The HttpOnly `dvsid`
  //                    visitor cookie is sent (credentials: 'include'), so
  //                    re-bootstrap keeps the SAME visitor identity.
  //
  // Both the loader heartbeat and the runtime TokenManager delegate here,
  // so two layers can never run two competing refresh engines: concurrent
  // callers await the exact same promise and every consumer converges on
  // the same token through the bus.
  (function installSessionManager(bus) {
    if (!bus || bus.__canonicalSession) return;
    bus.__canonicalSession = true;

    var cfg = { apiBase: '', workspaceId: '' };
    var refreshing = null;
    var recovering = null;
    var lastBootstrapAt = 0;
    var BOOTSTRAP_COOLDOWN_MS = 15000;
    // Absolute ceiling, independent of the cooldown, so even forced
    // origin-recovery bootstraps cannot storm the backend.
    var BOOTSTRAP_WINDOW_MS = 60000;
    var MAX_BOOTSTRAPS_PER_WINDOW = 4;
    var windowStartedAt = 0;
    var bootstrapsInWindow = 0;


    // What the backend said it speaks (the bootstrap's `protocol`). >= 3:
    // /track and /visitor-presence take the token in a CORS-simple body (see
    // tokenPost). Taken from EVERY bootstrap answer, so a backend rolled back
    // mid-page is followed; 0 (unknown) keeps the header form.
    bus.serverProtocol = 0;
    function noteProtocol(data) {
      if (data && data.session_token) bus.serverProtocol = Number(data.protocol) || 0;
      adoptVisitor(data, cfg.workspaceId);
      return data;
    }

    bus.configure = function (next) {
      if (!next) return;
      if (next.apiBase) cfg.apiBase = next.apiBase;
      if (next.workspaceId) cfg.workspaceId = next.workspaceId;
      if (next.protocol !== undefined) bus.serverProtocol = Number(next.protocol) || 0;
      if (next.token) bus.set(next.token);
    };
    bus.config = function () { return { apiBase: cfg.apiBase, workspaceId: cfg.workspaceId }; };

    function adopt(data) {
      if (!data || !data.session_token) return null;
      try { bus.set(data.session_token); } catch (_) {}
      try { if (data.effective_policy) window.__gs_policy = data.effective_policy; } catch (_) {}
      return data.session_token;
    }

    function clearRefresh(v) { refreshing = null; return v; }

    bus.refresh = function () {
      if (refreshing) return refreshing;
      var token = bus.get();
      if (!cfg.apiBase || !token) return Promise.resolve(null);
      refreshing = fetch(cfg.apiBase + '/api/widget/session/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Widget-Token': token },
        body: JSON.stringify({ workspace_id: cfg.workspaceId || undefined }),
      })
        .then(function (r) {
          // A rejected refresh means the token is past any grace window:
          // throw it away so nothing keeps replaying a dead credential.
          if (!r.ok) {
            if (r.status === 401 || r.status === 403) { try { bus.discard(); } catch (_) {} }
            return null;
          }
          return r.json();
        })

        .then(adopt)
        .catch(function () { return null; })
        .then(clearRefresh, function () { return clearRefresh(null); });
      return refreshing;
    };

    bus.bootstrap = function (opts) {
      if (!cfg.apiBase || !cfg.workspaceId) return Promise.resolve(null);
      var now = Date.now();
      var force = !!(opts && opts.force);
      // Storm guard: a hard ceiling of bootstraps per rolling window applies
      // even to "forced" (origin-recovery) calls, so a server that keeps
      // rejecting the fresh token can never turn into a bootstrap loop.
      if (now - windowStartedAt > BOOTSTRAP_WINDOW_MS) {
        windowStartedAt = now;
        bootstrapsInWindow = 0;
      }
      if (bootstrapsInWindow >= MAX_BOOTSTRAPS_PER_WINDOW) return Promise.resolve(null);
      if (!force && now - lastBootstrapAt < BOOTSTRAP_COOLDOWN_MS) return Promise.resolve(null);
      lastBootstrapAt = now;
      bootstrapsInWindow += 1;
      // Always the CURRENT browser origin: a token is never migrated from
      // one origin to another, a brand-new origin-bound one is minted.
      var body = JSON.stringify({ workspace_id: cfg.workspaceId, origin: window.location.origin, visitor_credential: vcNow() || undefined });
      // First CORS-simple (text/plain, no preflight) to /boot; a backend
      // older than this loader has no such route and answers before any
      // bootstrap work, so anything but a current answer is dropped and the
      // same body goes once more as application/json to /bootstrap (see
      // requestBootstrap below). One fetch site for both shapes.
      function post(json) {
        var init = { method: 'POST', credentials: 'include', body: body };
        if (json) init.headers = { 'Content-Type': 'application/json' };
        return fetch(cfg.apiBase + bootstrapPath(json), init);
      }
      function okJson(r) { return r && r.ok ? r.json() : null; }
      function asJson() { return post(true).then(okJson); }
      return post(false)
        .then(function (r) {
          if (r.status === 429) return null;
          if (!r.ok) {
            return r.json().then(function (j) { return isFinalBootstrapError(j) ? null : asJson(); }, asJson);
          }
          return r.json().then(function (data) {
            return isCurrentBootstrap(data, cfg.workspaceId) ? data : asJson();
          }, asJson);
        }, asJson)
        .then(noteProtocol)
        .then(adopt)
        .catch(function () { return null; });
    };

    /** Drop an unusable credential so it can never be replayed or refreshed. */
    bus.discard = function () {
      try { bus.set(''); } catch (_) {}
    };

    /**
     * opts.discardToken — the current token is structurally unusable for this
     * origin (ORIGIN_MISMATCH) or beyond any refresh window: skip refresh
     * entirely, throw the token away and bootstrap a fresh origin-bound one.
     */
    bus.recover = function (opts) {
      if (recovering) return recovering;
      var hard = !!(opts && opts.discardToken);
      var start;
      if (hard) {
        bus.discard();
        start = bus.bootstrap({ force: true });
      } else {
        start = bus.refresh().then(function (t) { return t || bus.bootstrap(); });
      }
      recovering = start
        .catch(function () { return null; })
        .then(function (t) { recovering = null; return t; }, function () { recovering = null; return null; });
      return recovering;
    };
  })(window.__gs_token);



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
  // ─── Commerce customer identity bridge ───
  // A store plugin (e.g. WooCommerce) puts a SIGNED, short-lived assertion on
  // this script tag when the page is being viewed by a signed-in customer.
  // It is never a raw customer id, and the server re-verifies it against the
  // store's installation secret before binding anything.
  //
  // Both ends of this bridge shipped a long time ago and the middle was
  // missing: POST /api/widget/commerce/identity existed and its own comment
  // said "called by the widget runtime after it reads the plugin-injected
  // assertion", but nothing in loader.js or runtime.js had ever referenced
  // it. The visible symptom was that a signed-in shopper was an anonymous
  // visitor to the widget, so every order question could only answer
  // `identity_required`.
  var _commerceBound = false;
  // A billing plugin (WHMCS) also names the grant behind the assertion with an
  // opaque fingerprint (`data-commerce-binding`). The same grant on the next
  // page of the same tab was bound a moment ago, and re-posting it only makes
  // the server re-verify something it already holds — so it is skipped for a
  // while. The server stays authoritative either way: every private read is
  // re-authorized by the billing system itself.
  var BINDING_REUSE_MS = 10 * 60 * 1000;
  function bindingKey(workspaceId) { return "gs:cbind:" + workspaceId; }
  function alreadyBound(workspaceId, binding) {
    if (!binding) return false;
    try {
      var raw = window.sessionStorage.getItem(bindingKey(workspaceId));
      if (!raw) return false;
      var rec = JSON.parse(raw);
      return rec && rec.b === binding && (Date.now() - rec.t) < BINDING_REUSE_MS;
    } catch (_) { return false; }
  }
  function rememberBinding(workspaceId, binding) {
    if (!binding) return;
    try { window.sessionStorage.setItem(bindingKey(workspaceId), JSON.stringify({ b: binding, t: Date.now() })); } catch (_) {}
  }
  // Credentials of the bootstrap, kept for the LAZY store identity below.
  var _commerceSession = null;
  function bindCommerceIdentity(apiBase, workspaceId, token, lazyAssertion) {
    if (!lazyAssertion) _commerceSession = { apiBase: apiBase, workspaceId: workspaceId, token: token };
    if (_commerceBound) return;   // defence in depth; bootstrap() is not re-entered today
    var assertion = lazyAssertion || attr("data-commerce-assertion");
    if (!assertion || !apiBase || !workspaceId || !token) return;
    // WHMCS profile data can change without a new grant. Reconcile each page;
    // the server writes only when data actually changed.
    var binding = assertion.indexOf("whmcs1.") === 0 ? null : attr("data-commerce-binding");
    if (alreadyBound(workspaceId, binding)) { _commerceBound = true; log("commerce identity: already linked"); return; }
    _commerceBound = true;
    // The connection id is an optional cross-check, not a requirement: a store
    // paired before the plugin began storing its own connection id cannot send
    // one, and the server resolves the workspace's connection itself when it
    // is absent. Requiring it here would have left the bridge inert on exactly
    // the stores that have been connected the longest.
    var connectionId = attr("data-commerce-connection");
    var body = { workspaceId: workspaceId, assertion: assertion };
    if (connectionId) body.connectionId = connectionId;
    // Await the bounded first attempt before rendering. Transient failures
    // retry in the background and refresh the profile when binding succeeds.
    // Same credentials as every other widget call: the `dvsid` cookie carries
    // the visitor this link is written against, and the session token is what
    // gets the request past `enforceWidgetToken`. The token is NOT optional —
    // /api/widget/* enters widgetRouter first, which 401s a header-less
    // request before Express ever reaches this endpoint's own mount. A
    // cookie-only call was answered with {"code":"MISSING_TOKEN"} against the
    // live API, which is how this was found.
    var attempts = 0;
    function sendIdentity() {
      attempts += 1;
      var abort = typeof AbortController !== "undefined" ? new AbortController() : null;
      var deadline = setTimeout(function () { if (abort) abort.abort(); }, 4000);
      function retry() {
        clearTimeout(deadline);
        if (attempts < 3) window.setTimeout(sendIdentity, attempts * 1000);
        else _commerceBound = false;
      }
      try {
        return fetch(apiBase + "/api/widget/commerce/identity", {
          method: "POST",
          signal: abort ? abort.signal : undefined,
          credentials: "include",
          headers: vh({ "Content-Type": "application/json", "X-Widget-Token": token }),
          body: JSON.stringify(body),
        }).then(function (r) {
          clearTimeout(deadline);
          if (r.ok) {
            rememberBinding(workspaceId, binding);
            var instance = runtimeInstanceRef();
            if (instance && instance.refreshIdentity) instance.refreshIdentity();
          } else if (r.status >= 500 || r.status === 429) retry();
          else _commerceBound = false;
          log("commerce identity:", r.ok ? "linked" : "not linked (" + r.status + ")");
        }).catch(retry);
      } catch (_) { retry(); }
    }
    return sendIdentity();
  }

  // ─── Lazy store identity (OpenCart and any store that opts in) ───
  // Instead of a signed assertion in the page — which a full-page cache could
  // hand to the next visitor — the store gives the loader the address of a
  // same-origin, never-cached endpoint (`data-commerce-context-url`). It is
  // called ONCE per page, and only when the visitor actually opens the chat:
  // an idle page makes no identity call at all. A browser that was linked
  // and now reports nobody signed in (logout) has its link ended, so the
  // previous customer's orders are not answered in this chat.
  var _commerceContextChecked = false;
  var COMMERCE_LINKED_KEY = "gs:commerce-linked:";
  function commerceContextOnOpen() {
    if (_commerceContextChecked || !_commerceSession) return;
    var raw = attr("data-commerce-context-url");
    if (!raw) return;
    _commerceContextChecked = true;
    var url;
    try {
      url = new URL(raw, window.location.href);
      if (url.origin !== window.location.origin) return; // same-origin only, by construction
    } catch (_) { return; }
    var ws = _commerceSession.workspaceId;
    var storageKey = COMMERCE_LINKED_KEY + ws;
    try {
      fetch(url.href, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (ctx) {
          if (!ctx) return;
          if (ctx.assertion) {
            bindCommerceIdentity(_commerceSession.apiBase, ws, _commerceSession.token, String(ctx.assertion));
            try { window.sessionStorage.setItem(storageKey, "1"); } catch (_) {}
            return;
          }
          var wasLinked = false;
          try { wasLinked = window.sessionStorage.getItem(storageKey) === "1"; } catch (_) {}
          if (ctx.signed_in === false && wasLinked) {
            try { window.sessionStorage.removeItem(storageKey); } catch (_) {}
            fetch(_commerceSession.apiBase + "/api/widget/commerce/identity/unlink", {
              method: "POST",
              credentials: "include",
              headers: vh({ "Content-Type": "application/json", "X-Widget-Token": _commerceSession.token }),
              body: JSON.stringify({ workspaceId: ws }),
            }).catch(function () {});
          }
        })
        .catch(function () { /* offline or blocked — stay anonymous */ });
    } catch (_) { /* no fetch — stay anonymous */ }
  }

  // WHMCS retains the conversation at logout; eager store contexts rotate
  // on logout. Both commit the subject only after a successful bootstrap.
  function commerceSubjectChanged(workspaceId) {
    var subject = attr("data-commerce-subject");
    var eager = attr("data-commerce-context-eager") === "true";
    if (!subject || !workspaceId || (!eager && subject.charAt(0) !== "u")) return false;
    var previous = null;
    try { previous = window.localStorage.getItem("gs:csub:" + workspaceId); } catch (_) { return eager; }
    return (!previous && eager)
      || (!!previous && previous.charAt(0) === "u" && previous !== subject);
  }

  function rememberCommerceSubject(workspaceId) {
    var subject = attr("data-commerce-subject");
    if (!subject || !workspaceId) return;
    if (subject.charAt(0) !== "u" && attr("data-commerce-context-eager") !== "true") return;
    try { window.localStorage.setItem("gs:csub:" + workspaceId, subject); } catch (_) {}
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
    /* ── Shared corner anchor ──
       The shell is a ZERO-SIZE fixed box pinned to the configured corner.
       BOTH the launcher and the panel are absolutely positioned children of
       it, anchored to the SAME corner (bottom + right, or bottom + left), so
       the panel grows out of exactly where the FAB sits instead of jumping. */
    ".shell{font-family:var(--gs-presentation-font,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif);color:#1F2937;",
    "position:fixed;z-index:2147483646;width:0;height:0;}",
    ".shell.pos-bottom-right{bottom:24px;right:24px;left:auto;top:auto;}",
    ".shell.pos-bottom-left{bottom:24px;left:24px;right:auto;top:auto;}",
    "@media(max-width:640px){.shell.pos-bottom-right{bottom:12px;right:12px;}",
    ".shell.pos-bottom-left{bottom:12px;left:12px;}}",
    /* ── Mobile full-screen shell ──
       While the panel is open on a phone the shell stops being a zero-size
       corner anchor and becomes the whole (visual) viewport, so the panel is
       pinned to the screen and the keyboard cannot push it around. The height
       comes from visualViewport (--gs-vvh) with a 100dvh fallback. Not
       behind a width query: the class itself is the phone test (PHONE_MQ),
       which a phone turned to landscape (844px wide) still passes. */
    ".shell.gs-mobile-open{top:0;left:0;right:0;bottom:auto;",
    "width:100vw;height:var(--gs-vvh,100dvh);}",
    ".shell.gs-mobile-open .launcher,.shell.gs-mobile-open .fab-label,",
    ".shell.gs-mobile-open .smart-nudge{display:none!important;}",
    /* A bubble gives way to the open panel (it holds what the bubble previews). */
    ".launcher.open~.smart-nudge{display:none!important;}",
    ".launcher{position:absolute;bottom:0;z-index:2;display:flex;align-items:center;justify-content:center;",
    "--gs-fab-exit:calc(var(--gs-fab-size,56px) + 56px);",
    "width:var(--gs-fab-size,56px);height:var(--gs-fab-size,56px);border-radius:50%;border:none;cursor:pointer;",
    "box-shadow:0 3px 12px -4px var(--gs-shadow,rgba(0,0,0,.16)),0 0 0 1px rgba(0,0,0,.03);",
    "transition:transform .28s cubic-bezier(.22,1,.36,1),box-shadow .18s ease;",
    "background:var(--gs-primary,transparent);color:#fff;font-family:inherit;",
    "opacity:1;}",
    /* First paint: the FAB starts fully outside the browser edge and slides
       up into the corner with the shared open/close timing. */
    ".launcher.enter,.launcher.enter:hover{transform:translateY(var(--gs-fab-exit,112px));animation:none!important;}",
    /* Hidden state — keeps the launcher invisible and non-interactive until
       /config resolves and we know the brand color. Eliminates blue flash. */
    ".launcher.pending{opacity:0;pointer-events:none;visibility:hidden;}",
    /* Reveal animation once config arrives. */
    ".launcher.revealed{opacity:1;pointer-events:auto;visibility:visible;}",
    ".launcher:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 5px 16px -4px var(--gs-shadow,rgba(0,0,0,.22));transition:transform .18s ease-out,box-shadow .18s ease;}",
    ".launcher:active{transform:translateY(0) scale(.92);}",
    ".launcher.bottom-right{right:0;left:auto;}",
    ".launcher.bottom-left{left:0;right:auto;}",
    ".launcher.square{border-radius:16px;}",
    ".launcher.pulse:not(.open):not(.enter){animation:gs-fab-pulse 2.4s ease-in-out 2;}",
    "@keyframes gs-fab-pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.07);}}",
    /* ── Custom launcher image with a circle-reveal hover ──
       The uploaded image covers the button and, on hover, its clip-path
       circle collapses to the centre revealing the configured icon that
       sits underneath. No crossfade — a real reveal. */
    ".launcher .fab-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;",
    "border-radius:inherit;pointer-events:none;opacity:1;transform:scale(1);",
    "transition:opacity .2s ease,transform .2s ease;}",
    ".launcher.has-image:hover .fab-img{opacity:0;transform:scale(.88);}",
    /* ── FAB ⇄ panel shared origin ──
       Opening the panel drops the FAB out of view (down + shrink) and
       closing brings it back, so the panel visually grows out of the very
       corner the button occupied. */
    ".launcher.open,.launcher.open:hover{transform:translateY(var(--gs-fab-exit,112px));",
    "pointer-events:none;animation:none;}",

    /* ── Text card beside the FAB ──
       Anchored to the SAME corner as the launcher and moving with it, so it
       slides down + fades out together when the panel opens. */
    ".gs-fab-label{position:absolute;bottom:0;z-index:2;display:flex;flex-direction:column;justify-content:center;",
    "--gs-fab-exit:calc(var(--gs-fab-size,56px) + 56px);",
    "height:calc(var(--gs-fab-size,56px) - 4px);padding:0 16px;border-radius:.9rem;background:#fff;",
    "box-shadow:0 8px 20px rgba(0,0,0,.12);white-space:nowrap;font-family:inherit;pointer-events:none;",
    "transition:transform .62s cubic-bezier(.33,1,.68,1);transform:translateY(0);}",
    ".gs-fab-label .label-title{font-size:13px;font-weight:600;color:#1c2024;line-height:1.3;}",
    ".gs-fab-label .label-sub{font-size:11px;color:#60646c;line-height:1.3;}",
    ".gs-fab-label.enter{transform:translateY(var(--gs-fab-exit,112px));}",
    ".gs-fab-label.open{transform:translateY(var(--gs-fab-exit,112px));pointer-events:none;}",
    /* Icon box is derived from the launcher size so chat ⇄ close never differ. */
    ".launcher svg{width:calc(var(--gs-fab-size,56px) * .46);height:calc(var(--gs-fab-size,56px) * .46);fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}",
    /* The launcher is the ONLY open/close control: it stays in place while the
       panel is open and simply swaps the chat icon for a close (X) icon. */
    ".launcher.open svg.chat-icon{display:none;}.launcher:not(.open) svg.close-icon{display:none;}",

    ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;",
    "background:#EF4444;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;",
    "padding:0 5px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.15);}",
    ".error-toast{position:fixed;bottom:92px;right:24px;left:auto;max-width:280px;padding:10px 14px;",
    "background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;color:#991B1B;font-size:12px;",
    "box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:2147483647;display:none;}",
    /* A bottom-left widget used to throw its error toast at the opposite
       corner of the screen, far from the launcher it belongs to. */
    ".error-toast.toast-left{left:24px;right:auto;}",
    ".error-toast.visible{display:block;}",
    /* Mobile keeps the configured size — parity between closed and open. */
    /* ── Smart Engagement: launcher nudge only (loader-owned surface). ── */
    /* Values mirror the .smart-nudge block in the active template stylesheet so
       bubble looks identical before/after the template stylesheet lands. */
    ".smart-nudge{position:absolute;z-index:6;bottom:calc(var(--gs-fab-size,56px) + 12px);",
    "width:max-content;max-width:288px;display:flex;flex-direction:column;gap:5px;",
    "padding:13px 15px 14px;border-radius:16px;color:#1c2024;",
    "background:linear-gradient(158deg,#ffffff 0%,#ffffff 55%,#f4f7fc 100%);",
    "border:1px solid rgba(15,23,42,.06);",
    "box-shadow:0 18px 38px -20px rgba(2,6,23,.42),0 2px 6px -3px rgba(2,6,23,.12),",
    "inset 0 1px 0 rgba(255,255,255,.9);",
    "font-size:13px;line-height:1.75;}",
    /* Accent hairline welded to the top edge — ties the bubble to the FAB. */
    ".smart-nudge::before{content:\'\';position:absolute;top:0;inset-inline:14px;height:2px;",
    "border-radius:2px;opacity:.85;",
    "background:linear-gradient(90deg,transparent,var(--gs-primary,#3b82f6),transparent);}",
    ".smart-nudge[hidden]{display:none !important;}",
    /* Tail: a rotated square welded to the bubble edge closest to the FAB. */
    ".smart-nudge::after{content:\'\';position:absolute;bottom:-6px;width:12px;height:12px;",
    "background:#f6f9fd;border-right:1px solid rgba(15,23,42,.06);",
    "border-bottom:1px solid rgba(15,23,42,.06);border-bottom-right-radius:3px;",
    "transform:rotate(45deg);}",
    ".smart-nudge{font-family:inherit;}",
    ".smart-nudge .smart-title{font-weight:700;font-size:13.5px;line-height:1.6;}",
    ".smart-nudge .smart-body{color:#475569;font-weight:700;white-space:pre-wrap;word-break:break-word;}",
    ".smart-nudge .smart-cta{align-self:flex-start;border:none;cursor:pointer;padding:8px 16px;",
    "border-radius:999px;font:inherit;font-weight:700;font-size:12.5px;color:#fff;margin-top:4px;",
    "background:var(--gs-primary,#3b82f6);box-shadow:0 6px 16px -8px var(--gs-primary,#3b82f6);",
    "transition:filter .15s ease,transform .15s ease;}",
    ".smart-nudge .smart-cta:hover{filter:brightness(1.06);transform:translateY(-1px);}",
    /* Close control always sits OUTSIDE the bubble, top-right, in every dir. */
    ".smart-nudge .smart-dismiss{position:absolute;top:-9px;inset-inline:auto;right:-9px;left:auto;",
    "width:22px;height:22px;border-radius:50%;border:1px solid rgba(15,23,42,.08);background:#fff;",
    "color:#60646c;cursor:pointer;display:flex;align-items:center;justify-content:center;",
    "font-size:13px;line-height:1;padding:0;box-shadow:0 4px 12px -5px rgba(2,6,23,.4);",
    "transition:background-color .15s ease,color .15s ease;}",
    ".smart-nudge .smart-dismiss:hover{background:#f0f0f3;color:#1c2024;}",
    ".smart-nudge.bottom-right{right:0;left:auto;}",
    ".smart-nudge.bottom-left{left:0;right:auto;}",
    ".smart-nudge.bottom-right::after{right:18px;}",
    ".smart-nudge.bottom-left::after{left:18px;}",
    /* Shared origin with the FAB: the bubble rises out from under the button,
       fading in, and sinks back into it on close. */
    "@keyframes gs-smart-in{from{opacity:0;transform:translateY(16px) scale(.82);}",
    "60%{opacity:1;}to{opacity:1;transform:translateY(0) scale(1);}}",
    "@keyframes gs-smart-out{from{opacity:1;transform:translateY(0) scale(1);}",
    "to{opacity:0;transform:translateY(14px) scale(.84);}}",
    /* Entry animation is gated on `.entering`, which JS strips once the
       bubble has landed. A stylesheet that arrives LATER (the template
       sheet) therefore cannot re-trigger the intro and make the bubble
       jump down and rise again. */
    ".anim-on .smart-nudge.entering{animation:gs-smart-in .38s cubic-bezier(.22,1,.36,1) both;}",
    ".anim-on .smart-nudge.leaving{animation:gs-smart-out .24s cubic-bezier(.4,0,1,1) both;}",
    ".smart-nudge.leaving{pointer-events:none;}",
    ".smart-nudge.bottom-right{transform-origin:100% 100%;}",
    ".smart-nudge.bottom-left{transform-origin:0 100%;}",
    "@media(max-width:480px){.smart-nudge{max-width:calc(100vw - 48px);}}",

    /* ── Reduced motion ──
       The template stylesheet already honours this for the panel's own
       surfaces, but everything the LOADER owns — the FAB's slide/scale, its
       optional pulse, the label card and the nudge's intro — kept moving for
       visitors who asked the OS for less motion. State changes still apply;
       only the movement is removed. */
    "@media(prefers-reduced-motion:reduce){",
    ".launcher,.gs-fab-label,.launcher .fab-img{transition:none!important;animation:none!important;}",
    ".launcher.pulse{animation:none!important;}",
    ".launcher:hover{transform:none;}",
    ".anim-on .smart-nudge.entering,.anim-on .smart-nudge.leaving{animation:none!important;}",
    ".smart-nudge .smart-cta{transition:none!important;}",
    ".smart-nudge .smart-cta:hover{transform:none;}}",

  ].join("");

  // The platform colour every deployment was seeded with: never a choice, so
  // a kit's own ground is shown in its place (both regions' buttons).
  var KIT_UNCUSTOMISED_COLOR = "#3b82f6";
  function kitBrandColor(config) {
    var c = String((config && config.primaryColor) || "").trim().toLowerCase();
    return !c || c === KIT_UNCUSTOMISED_COLOR;
  }

  /* @iran-kit:begin */
  // ─── The Iran region's floating button (its local brand kit) ───
  // Worn by every template when the bootstrap says the platform is the Iran
  // region's edition (config.edition === "iran" exactly; an older backend or
  // an unknown edition keeps the launcher above, as does every other region
  // mode). Byte-identical with shared/localKitLauncher.ts (the
  // operator preview's copy; src/test/widget/localKitLauncher.test.ts).
  // Injected as its own <style> only when worn, so other editions' shadow DOM
  // is unchanged.
  var LOCAL_KIT_CSS = ".launcher.lk-kit.lk-kit-brand{background:linear-gradient(140deg,#22D3B4,#0B7D6C);box-shadow:0 12px 28px rgba(11,125,108,.36),0 3px 8px rgba(18,20,31,.16);--lk-kit-dot:#18AD94;--lk-kit-ring:#16C7A8;}.launcher.lk-kit:not(.open):not(.enter):hover{transform:translateY(-3px) scale(1.06);transition:transform .22s cubic-bezier(.2,.8,.2,1),box-shadow .22s ease;}.launcher.lk-kit.lk-kit-brand:not(.open):not(.enter):hover{box-shadow:0 18px 36px rgba(11,125,108,.42),0 4px 10px rgba(18,20,31,.16);}.launcher.lk-kit svg.lk-kit-glyph{position:absolute;inset:0;width:100%;height:100%;fill:none;stroke:none;overflow:visible;transform-origin:50% 50%;transition:transform .2s cubic-bezier(.4,0,1,1),opacity .16s ease;}.launcher.lk-kit .lk-kit-body{fill:currentColor;transition:fill .25s ease;}.launcher.lk-kit .lk-kit-dot{fill:var(--lk-kit-dot,var(--gs-primary,#0B7D6C));transform-box:fill-box;transform-origin:50% 50%;transition:fill .25s ease;}.launcher.lk-kit .lk-kit-chev{fill:none;stroke:currentColor;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round;}.launcher.lk-kit svg.close-icon.lk-kit-glyph{display:block;opacity:0;transform:rotate(45deg) scale(.6);transition:transform .2s ease,opacity .14s ease;}.launcher.lk-kit.open svg.chat-icon.lk-kit-glyph{display:block;opacity:0;transform:rotate(-35deg) scale(.3);}.launcher.lk-kit.open svg.close-icon.lk-kit-glyph{opacity:1;transform:none;transition:transform .26s cubic-bezier(.2,.9,.3,1.2) .06s,opacity .2s ease .06s;}.launcher.lk-kit.lk-kit-enter{animation:lk-kit-fab-in .62s cubic-bezier(.2,1.25,.4,1) backwards;}.launcher.lk-kit.lk-kit-enter .lk-kit-body{transform-box:fill-box;transform-origin:50% 50%;animation:lk-kit-body-in .5s cubic-bezier(.2,1.2,.4,1) .12s backwards;}.launcher.lk-kit.lk-kit-enter .lk-kit-dot{animation:lk-kit-dot-in .32s cubic-bezier(.3,1.45,.5,1) backwards;}.launcher.lk-kit.lk-kit-enter .lk-kit-d1{animation-delay:.45s;}.launcher.lk-kit.lk-kit-enter .lk-kit-d2{animation-delay:.65s;}.launcher.lk-kit.lk-kit-enter .lk-kit-d3{animation-delay:.85s;}.launcher.lk-kit:not(.open):hover .lk-kit-dot{animation:lk-kit-wave .62s ease-in-out;}.launcher.lk-kit:not(.open):hover .lk-kit-d2{animation-delay:.08s;}.launcher.lk-kit:not(.open):hover .lk-kit-d3{animation-delay:.16s;}.launcher.lk-kit.lk-kit-closing:not(.open) .lk-kit-dot{animation:lk-kit-dot-in .26s cubic-bezier(.3,1.45,.5,1) backwards;}.launcher.lk-kit.lk-kit-closing:not(.open) .lk-kit-d1{animation-delay:.12s;}.launcher.lk-kit.lk-kit-closing:not(.open) .lk-kit-d2{animation-delay:.2s;}.launcher.lk-kit.lk-kit-closing:not(.open) .lk-kit-d3{animation-delay:.28s;}.launcher.lk-kit.lk-kit-typing:not(.open) .lk-kit-dot,.launcher.lk-kit.lk-kit-typing:not(.open):hover .lk-kit-dot{animation:lk-kit-type 1.3s ease-in-out infinite;}.launcher.lk-kit.lk-kit-typing:not(.open) .lk-kit-d2,.launcher.lk-kit.lk-kit-typing:not(.open):hover .lk-kit-d2{animation-delay:.16s;}.launcher.lk-kit.lk-kit-typing:not(.open) .lk-kit-d3,.launcher.lk-kit.lk-kit-typing:not(.open):hover .lk-kit-d3{animation-delay:.32s;}.launcher.lk-kit .lk-kit-ping{position:absolute;inset:0;border-radius:inherit;border:2px solid var(--lk-kit-ring,var(--gs-primary,#16C7A8));opacity:0;pointer-events:none;}.launcher.lk-kit.lk-kit-pinging:not(.open) .lk-kit-ping{animation:lk-kit-ping 1.8s cubic-bezier(.2,.6,.3,1) 2;}.launcher.lk-kit .badge{top:-6px;right:-6px;min-width:24px;height:24px;padding:0 6px;border-radius:12px;border:0;background:#FFB423;color:#12141F;font:800 13px/24px IRANSans,Tahoma,'Segoe UI',sans-serif;box-shadow:0 0 0 3px #fff;animation:lk-kit-badge-in .45s cubic-bezier(.3,1.6,.5,1);}.launcher.lk-kit.open .badge{display:none;}.launcher.lk-kit.lk-kit-nudge:not(.open){animation:lk-kit-nudge .6s ease-in-out;}.launcher.lk-kit.lk-kit-brand.lk-kit-offline{background:#12141F;--lk-kit-dot:#12141F;}.launcher.lk-kit.lk-kit-brand.lk-kit-offline .lk-kit-body{fill:#16C7A8;}@keyframes lk-kit-fab-in{0%{opacity:0;transform:translateY(18px) scale(.6);}100%{opacity:1;transform:none;}}@keyframes lk-kit-body-in{0%{opacity:0;transform:scale(.7);}100%{opacity:1;transform:none;}}@keyframes lk-kit-type{0%,60%,100%{transform:none;opacity:.55;}25%{transform:translateY(-2.5px);opacity:1;}}@keyframes lk-kit-ping{0%{opacity:.6;transform:scale(1);}100%{opacity:0;transform:scale(1.75);}}@keyframes lk-kit-dot-in{0%{opacity:0;transform:scale(.4);}100%{opacity:1;transform:none;}}@keyframes lk-kit-wave{0%,100%{transform:none;}35%{transform:translateY(-2.5px);}}@keyframes lk-kit-badge-in{0%{transform:scale(0);}60%{transform:scale(1.18);}100%{transform:scale(1);}}@keyframes lk-kit-nudge{0%,100%{transform:none;}20%{transform:rotate(-10deg);}45%{transform:rotate(8deg);}70%{transform:rotate(-4deg);}}@media(prefers-reduced-motion:reduce){.launcher.lk-kit,.launcher.lk-kit *{animation:none!important;}.launcher.lk-kit:not(.open):not(.enter):hover{transform:none;}.launcher.lk-kit svg.lk-kit-glyph,.launcher.lk-kit svg.close-icon.lk-kit-glyph,.launcher.lk-kit.open svg.close-icon.lk-kit-glyph{transition:opacity .15s ease;}.launcher.lk-kit.open svg.chat-icon.lk-kit-glyph,.launcher.lk-kit svg.close-icon.lk-kit-glyph{transform:none;}}.launcher.lk-kit.square{border-radius:18px;}";
  var LOCAL_KIT_CHAT_GLYPH = "<svg class=\"chat-icon lk-kit-glyph\" viewBox=\"0 0 60 60\" aria-hidden=\"true\" focusable=\"false\"><path class=\"lk-kit-body\" d=\"M42.28 27.95A12.4 12.4 0 0 0 21.7 17.01A12.4 12.4 0 0 0 30.43 38.62A7.75 7.75 0 0 0 22.95 46.14A0.43 0.43 0 0 1 22.56 46.56A21.7 21.7 0 0 0 42.28 27.95Z\"/><path class=\"lk-kit-dot lk-kit-d1\" d=\"M35.21 24.12L37.32 26.23L35.21 28.34L33.1 26.23Z\"/><path class=\"lk-kit-dot lk-kit-d2\" d=\"M30 24.12L32.11 26.23L30 28.34L27.89 26.23Z\"/><path class=\"lk-kit-dot lk-kit-d3\" d=\"M24.79 24.12L26.9 26.23L24.79 28.34L22.69 26.23Z\"/></svg>";
  var LOCAL_KIT_CLOSE_GLYPH = "<svg class=\"close-icon lk-kit-glyph\" viewBox=\"0 0 60 60\" aria-hidden=\"true\" focusable=\"false\"><path class=\"lk-kit-chev\" d=\"M22 27l8 8 8-8\"/></svg>";
  var LOCAL_KIT_PING = "<span class=\"lk-kit-ping\" aria-hidden=\"true\"></span>";
  function localKitOn(config) {
    return !!config && config.edition === "iran";
  }
  var PERSIAN_DIGITS = "\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9";
  function persianDigits(text) {
    return String(text).replace(/[0-9]/g, function (d) { return PERSIAN_DIGITS.charAt(+d); });
  }
  // The local kit's button: the attention ring spreads twice (3.6s), once,
  // 6s after the entrance, only while the chat is closed (the kit's ping()).
  var LOCAL_KIT_PING_AFTER = 6000;
  function localKitPing() {
    if (!launcherEl || isOpen || !launcherEl.classList.contains("lk-kit")) return;
    var pinged = launcherEl;
    pinged.classList.add("lk-kit-pinging");
    setTimeout(function () { pinged.classList.remove("lk-kit-pinging"); }, 3800);
  }
  function ensureLocalKitStyle() {
    if (!shadowRoot || shadowRoot.querySelector("style[data-lk-kit]")) return;
    var kitStyle = document.createElement("style");
    kitStyle.setAttribute("data-lk-kit", "");
    kitStyle.textContent = LOCAL_KIT_CSS;
    shadowRoot.appendChild(kitStyle);
  }
  /* @iran-kit:end */
  // The local kit's button: the three dots bob while the operator is typing
  // (the runtime's "Support is typing…" signal, shell.setOperatorTyping).
  function setOperatorTyping(on) {
    if (!launcherEl) return;
    if (LOCAL_KIT && launcherEl.classList.contains("lk-kit")) launcherEl.classList.toggle("lk-kit-typing", !!on);
  }

  /* @intl-kit:begin */
  // ─── RESPOK's floating button (the brand kit's Thread chat button,
  // International edition only) ───
  // Worn by every template when the bootstrap says the platform is the
  // International edition (config.edition === "international" exactly; an
  // unknown edition, an older backend and the Iranian edition never wear
  // it). Byte-identical with
  // shared/respokLauncher.ts (the operator preview's copy;
  // src/test/widget/respokLauncher.test.ts). Injected as its own <style> only
  // when worn, so the other edition's shadow DOM is unchanged.
  var RESPOK_KIT_CSS = ".launcher.rpk-kit.rpk-kit-brand{background:#16142B;box-shadow:0 10px 28px rgba(22,20,43,.28);--rpk-kit-accent:#FF5A3C;--rpk-kit-away:#A9A7BC;}.launcher.rpk-kit:not(.open):not(.enter):hover{transform:scale(1.06);transition:transform .16s ease,box-shadow .16s ease;}.launcher.rpk-kit.rpk-kit-brand:not(.open):not(.enter):hover{box-shadow:0 16px 36px rgba(22,20,43,.36);}.launcher.rpk-kit:not(.open):not(.enter):active{transform:scale(.94);transition-duration:.09s;}.launcher.rpk-kit.rpk-kit-brand:not(.open):not(.enter):active{box-shadow:0 5px 14px rgba(22,20,43,.24);}.launcher.rpk-kit:focus-visible{outline:none;box-shadow:0 0 0 3px #fff,0 0 0 6px #FF5A3C,0 10px 28px rgba(22,20,43,.28);}.launcher.rpk-kit svg.rpk-kit-glyph{position:absolute;inset:0;margin:auto;width:50%;height:44.23%;fill:none;stroke:none;overflow:visible;transition:transform .2s ease,opacity .2s ease;}.launcher.rpk-kit .rpk-kit-q{fill:currentColor;}.launcher.rpk-kit .rpk-kit-a{fill:var(--rpk-kit-accent,currentColor);}.launcher.rpk-kit.rpk-kit-away .rpk-kit-a{fill:none;stroke:var(--rpk-kit-away,currentColor);stroke-width:7;}.launcher.rpk-kit svg.close-icon.rpk-kit-glyph{display:block;width:43%;height:43%;opacity:0;transform:rotate(-90deg);}.launcher.rpk-kit .rpk-kit-chev{fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;}.launcher.rpk-kit.open svg.chat-icon.rpk-kit-glyph{display:block;opacity:0;transform:rotate(90deg) scale(.6);}.launcher.rpk-kit.open svg.close-icon.rpk-kit-glyph{opacity:1;transform:none;}.launcher.rpk-kit.rpk-kit-arrive .rpk-kit-a{animation:rpk-kit-answer .36s cubic-bezier(.3,1.4,.5,1);}.launcher.rpk-kit .badge{top:-3px;right:-3px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;border:2px solid #fff;background:#D3361A;color:#fff;font-size:12px;font-weight:700;line-height:18px;box-shadow:none;animation:rpk-kit-badge-in .34s cubic-bezier(.3,1.5,.5,1);}.launcher.rpk-kit .badge.rpk-kit-bump{animation:rpk-kit-bump .32s ease;}.launcher.rpk-kit .badge.rpk-kit-still{animation:none;}.launcher.rpk-kit.open .badge{display:none;}.launcher.rpk-kit svg.rpk-kit-o{width:47%;height:47%;}.launcher.rpk-kit.rpk-kit-arrive .rpk-kit-o .rpk-kit-a{animation-name:rpk-kit-dot;animation-timing-function:cubic-bezier(.3,1.5,.5,1);transform-origin:96px 96px;}@keyframes rpk-kit-dot{0%{transform:scale(.2);}60%{transform:scale(1.35);}}@keyframes rpk-kit-answer{0%{transform:translateX(34px);opacity:0;}70%{transform:translateX(-6px);opacity:1;}100%{transform:none;}}@keyframes rpk-kit-badge-in{0%{transform:scale(0);}100%{transform:scale(1);}}@keyframes rpk-kit-bump{0%,100%{transform:scale(1);}50%{transform:scale(1.15);}}@media(prefers-reduced-motion:reduce){.launcher.rpk-kit,.launcher.rpk-kit *{animation:none!important;}.launcher.rpk-kit:not(.open):not(.enter):hover,.launcher.rpk-kit:not(.open):not(.enter):active{transform:none;}.launcher.rpk-kit svg.rpk-kit-glyph,.launcher.rpk-kit svg.close-icon.rpk-kit-glyph,.launcher.rpk-kit.open svg.close-icon.rpk-kit-glyph{transition:opacity .12s ease;}.launcher.rpk-kit.open svg.chat-icon.rpk-kit-glyph,.launcher.rpk-kit svg.close-icon.rpk-kit-glyph{transform:none;}}";
  var RESPOK_KIT_CHAT_GLYPH = "<svg class=\"chat-icon rpk-kit-glyph\" viewBox=\"0 0 104 92\" aria-hidden=\"true\" focusable=\"false\"><path class=\"rpk-kit-q\" d=\"M21 0H41A21 21 0 0 1 62 21V21A21 21 0 0 1 41 42H4A4 4 0 0 1 0 38V21A21 21 0 0 1 21 0Z\"/><path class=\"rpk-kit-a\" d=\"M43 50H83A21 21 0 0 1 104 71V88A4 4 0 0 1 100 92H43A21 21 0 0 1 22 71V71A21 21 0 0 1 43 50Z\"/></svg>";
  // The Open logo (template option logoDirection: "open", t1-intl / t2-intl
  // only): the bubble, and the Signal dot that springs in with a message.
  var RESPOK_KIT_OPEN_GLYPH = "<svg class=\"chat-icon rpk-kit-glyph rpk-kit-o\" viewBox=\"0 0 108 108\" aria-hidden=\"true\" focusable=\"false\"><path class=\"rpk-kit-q\" d=\"M41 0A41 41 0 0 1 82 41L82 78Q82 82 78 82L41 82A41 41 0 0 1 0 41A41 41 0 0 1 41 0Z\"/><circle class=\"rpk-kit-a\" cx=\"96\" cy=\"96\" r=\"12\"/></svg>";
  var RESPOK_KIT_CLOSE_GLYPH = "<svg class=\"close-icon rpk-kit-glyph\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path class=\"rpk-kit-chev\" d=\"M6 9l6 6 6-6\"/></svg>";
  function respokKitOn(config) {
    return !!config && config.edition === "international";
  }
  function rpkOpen(config) {
    return (config.templateOptions || {}).logoDirection === "open";
  }
  function ensureRespokKitStyle() {
    if (!shadowRoot || shadowRoot.querySelector("style[data-rpk-kit]")) return;
    var kitStyle = document.createElement("style");
    kitStyle.setAttribute("data-rpk-kit", "");
    kitStyle.textContent = RESPOK_KIT_CSS;
    shadowRoot.appendChild(kitStyle);
  }
  /* @intl-kit:end */

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
  // That open is nobody's request (a Smart Engagement rule): no focus move.
  var quietOpen = false;
  var shellEl = null;
  var shadowRoot = null;
  var shellContentEl = null;
  var launcherEl = null;
  var errorToastEl = null;
  var isOpen = false;
  // Last unread count reported to setUnreadBadge — the only source for the
  // public getState()/onUnreadChange `unread` field, since the badge DOM
  // itself is write-only (rendered then discarded, never read back).
  var lastUnreadCount = 0;
  // Singletons for background loops the loader owns. Guard against double
  // start in case bootstrap() is somehow re-entered (defense in depth — the
  // singleton flag at the top of the IIFE already prevents this in practice).
  var trackingStarted = false;
  // Consent (P-01): tracking (page views, presence, Smart Engagement and its
  // storage, the AI's page journey) waits for `__gs.push(['consent', true])`
  // while the workspace asks for it (config.privacy.consent) or the browser
  // sends Global Privacy Control; `consent` false holds or stops it. Never
  // stored: the page says it on each load (docs/WIDGET_PUBLIC_API.md).
  var consent = null;
  function tracks() {
    return consent != null ? consent : !(navigator.globalPrivacyControl || (configData.privacy || {}).consent);
  }
  function setConsent(v) {
    consent = v === true || v === "granted";
    // Taken back: the visitor leaves the live visitors list too.
    if (!consent) try { window.__gs_visitor_presence.stop(); } catch (_) {}
    if (configData) beginTracking();
  }
  function beginTracking() {
    var config = configData;
    if (!tracks()) return;
    if (config.features && config.features.visitorTracking) {
      scheduleDeferred(function () {
        if (trackingStarted || !tracks()) return;
        trackingStarted = true;
        startTracking(config._apiBase, WORKSPACE_ID, config._sessionToken);
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
  }
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
    shellDiv.className = "shell pos-bottom-right";
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
    // The launcher is a disclosure control for the chat panel. Its name is
    // recomputed (localized, open/closed, unread count) by syncLauncherLabel;
    // this is only the pre-config default.
    launcherEl.setAttribute("aria-haspopup", "dialog");
    launcherEl.setAttribute("aria-expanded", "false");
    syncLauncherLabel();
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
      openChat: "Open chat",
      closeChat: "Close chat",
      unreadOne: "1 unread message",
      unreadMany: "{n} unread messages",
      dismiss: "Dismiss",
      configFailed: "Could not load chat settings.",
    },
    fa: {
      notConfigured: "گفتگو پیکربندی نشده است.",
      resourcesUnavailable: "منابع گفتگو در دسترس نیست.",
      couldNotStart: "گفتگو راه‌اندازی نشد.",
      resourcesFailed: "بارگذاری منابع گفتگو ناموفق بود.",
      chatUnavailable: "گفتگو در دسترس نیست.",
      notAuthorized: "این سایت مجاز به استفاده از گفتگو نیست.",
      bootstrapFailed: "راه‌اندازی گفتگو ممکن نشد.",
      openChat: "باز کردن گفتگو",
      closeChat: "بستن گفتگو",
      unreadOne: "۱ پیام خوانده‌نشده",
      unreadMany: "{n} پیام خوانده‌نشده",
      dismiss: "بستن",
      configFailed: "بارگذاری تنظیمات گفتگو ناموفق بود.",
    },
    tr: {
      notConfigured: "Sohbet yapılandırılmamış.",
      resourcesUnavailable: "Sohbet kaynakları kullanılamıyor.",
      couldNotStart: "Sohbet başlatılamadı.",
      resourcesFailed: "Sohbet kaynakları yüklenemedi.",
      chatUnavailable: "Sohbet kullanılamıyor.",
      notAuthorized: "Bu site için sohbete izin verilmiyor.",
      bootstrapFailed: "Sohbet başlatılamadı.",
      openChat: "Sohbeti aç",
      closeChat: "Sohbeti kapat",
      unreadOne: "1 okunmamış mesaj",
      unreadMany: "{n} okunmamış mesaj",
      dismiss: "Kapat",
      configFailed: "Sohbet ayarları yüklenemedi.",
    },
  };
  /** The widget's language ('fa', 'en', 'tr'), whatever the host page's is. */
  function widgetLang() {
    return String((configData && configData.locale) || document.documentElement.lang || navigator.language || "en").toLowerCase().split("-")[0];
  }
  function lt(key) {
    var dict = LOADER_STRINGS[widgetLang()] || LOADER_STRINGS.en;
    return dict[key] || LOADER_STRINGS.en[key] || key;
  }

  // Accessible name for the launcher: "<Open|Close> chat" plus the unread
  // count when there is one, in the visitor's locale. Previously a
  // hardcoded English "Open chat" that never changed state and left the
  // unread badge to be read as a bare number with no context.
  function syncLauncherLabel() {
    if (!launcherEl) return;
    // A pill is named by the text it shows (the name contains the label).
    var label = isOpen ? lt("closeChat") : launcherEl.classList.contains("fx-pill") && launcherEl.getAttribute("data-fx") || lt("openChat");
    var n = lastUnreadCount | 0;
    if (!isOpen && n > 0) {
      var tpl = n === 1 ? lt("unreadOne") : lt("unreadMany");
      label += " — " + String(tpl).replace("{n}", String(n));
    }
    launcherEl.setAttribute("aria-label", label);
    launcherEl.setAttribute("aria-expanded", isOpen ? "true" : "false");
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
  function prefersReducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (_) { return false; }
  }
  function playFabEntry(element) {
    if (!element) return;
    // A Web Animations call bypasses the CSS media query entirely, so the
    // reduced-motion opt-out has to be honoured here too. The element still
    // ends up in its resting position — it just gets there instantly.
    if (prefersReducedMotion()) {
      if (element.__gsFabEntryAnimation) {
        try { element.__gsFabEntryAnimation.cancel(); } catch (_) {}
        element.__gsFabEntryAnimation = null;
      }
      element.classList.remove("enter");
      return;
    }
    var distance = "var(--gs-fab-exit,112px)";
    // Use a real keyframe animation rather than relying only on a class
    // transition. The launcher is hidden while config loads, so some browsers
    // otherwise coalesce the hidden and revealed paints and skip the movement.
    if (element.__gsFabEntryAnimation) {
      try { element.__gsFabEntryAnimation.cancel(); } catch (_) {}
      element.__gsFabEntryAnimation = null;
    }
    if (typeof element.animate === "function") {
      element.classList.remove("enter");
      var animation = element.animate(
        [
          { transform: "translateY(" + distance + ")" },
          { transform: "translateY(0)" },
        ],
        { duration: 280, easing: "cubic-bezier(.22,1,.36,1)", fill: "none" }
      );
      if (animation) {
        element.__gsFabEntryAnimation = animation;
        animation.onfinish = function () { if (element.__gsFabEntryAnimation === animation) element.__gsFabEntryAnimation = null; };
      }
      return;
    }
    element.classList.add("enter");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { element.classList.remove("enter"); });
    });
  }

  function applyFabConfig(config, posClass) {
    var fab = (config && config.fab) || {};
    var scale = normalizeFabScale(fab.scale);
    var kit = LOCAL_KIT && localKitOn(config);
    var rpkKit = INTL_KIT && !kit && respokKitOn(config);
    // The kits' buttons are 60px at 100% (the scale still applies).
    var size = Math.round((kit || rpkKit ? 60 : 56) * scale);
    // ONE source of truth for the launcher box: the CSS variable. The button,
    // its icons (chat AND close) and the panel anchor all derive from it, so
    // the closed and open states can never drift apart in size.
    var shellForVar = shadowRoot && shadowRoot.querySelector(".shell");
    if (shellForVar) shellForVar.style.setProperty("--gs-fab-size", size + "px");
    launcherEl.style.width = "";
    launcherEl.style.height = "";


    if (String(fab.shape || "circle") === "square") launcherEl.classList.add("square");
    if (fab.animation === true) launcherEl.classList.add("pulse");
    launcherEl.style.color = fab.iconColor || "#ffffff";
    // Its own keys only: an icon named "constructor" drew prototype text.
    var custom = FAB_ICONS.hasOwnProperty(fab.icon) && fab.icon !== "chat";
    var icon = custom ? FAB_ICONS[fab.icon] : FAB_ICONS.chat;
    var away = !!(config.availability && config.availability.state === "offline");
    var imageUrl = typeof fab.imageUrl === "string" ? fab.imageUrl.trim() : "";
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) imageUrl = "";
    launcherEl.classList.toggle("has-image", !!imageUrl);
    var imgHtml = imageUrl
      ? '<img class="fab-img" alt="" aria-hidden="true" decoding="async" fetchpriority="low" src="' + imageUrl.replace(/"/g, "&quot;") + '">'
      : '';
    if (LOCAL_KIT && kit) {
      // The local kit's button: its bubble (or the workspace's own icon when
      // it picked one other than `chat`) and its chevron for "open".
      ensureLocalKitStyle();
      launcherEl.classList.add("lk-kit");
      var kitBrand = kitBrandColor(config);
      launcherEl.classList.toggle("lk-kit-brand", kitBrand);
      launcherEl.classList.toggle("lk-kit-offline", kitBrand && away);
      launcherEl.innerHTML =
        (custom
          ? '<svg class="chat-icon" viewBox="0 0 24 24">' + icon + '</svg>'
          : LOCAL_KIT_CHAT_GLYPH) +
        LOCAL_KIT_CLOSE_GLYPH + LOCAL_KIT_PING + imgHtml;
    } else if (INTL_KIT && rpkKit) {
      // RESPOK's button: the kit's Thread pills (or the workspace's own icon
      // when it picked one other than `chat`) and the kit's chevron for
      // "open". The seeded colour wears Ink + Signal; any other colour keeps
      // its own ground and draws the pills in its icon colour.
      ensureRespokKitStyle();
      launcherEl.classList.add("rpk-kit");
      launcherEl.classList.toggle("rpk-kit-brand", kitBrandColor(config));
      launcherEl.classList.toggle("rpk-kit-away", away);
      launcherEl.innerHTML =
        (custom
          ? '<svg class="chat-icon" viewBox="0 0 24 24">' + icon + '</svg>'
          : rpkOpen(config) ? RESPOK_KIT_OPEN_GLYPH : RESPOK_KIT_CHAT_GLYPH) +
        RESPOK_KIT_CLOSE_GLYPH + imgHtml;
    } else {
      launcherEl.innerHTML =
        '<svg class="chat-icon" viewBox="0 0 24 24">' + icon + '</svg>' +
        '<svg class="close-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
        imgHtml;
    }
    // A launcher style (shared/launcherStyles.ts: the pill, the bubble, two
    // bubbles, the agent's face) is runtime-fab.css's, which /config names
    // only for a workspace wearing one: classes and texts for it on today's
    // markup, the launcher unseen until it is in (3 s at most). Without it
    // today's launcher shows.
    var fxUrl = config.fabStyleUrl;
    if (fxUrl) {
      launcherEl.className += " fx fx-" + fab.icon + " fx-" + fab.shape + (away ? " fx-off" : "");
      launcherEl.setAttribute("data-fx", fab.label || "");
      launcherEl.dir = /^fa/.test(config.locale) ? "rtl" : "ltr";
      if (!shadowRoot.querySelector("link[data-gs-fab]")) {
        var fxLink = document.createElement("link");
        var fxEl = launcherEl;
        // The card beside it waits with it (it is drawn below).
        var fxShow = function () { fxEl.style.visibility = ""; if (fabLabelEl) fabLabelEl.style.visibility = ""; };
        fxEl.style.visibility = "hidden";
        fxLink.rel = "stylesheet";
        fxLink.href = fxUrl;
        fxLink.setAttribute("data-gs-fab", "");
        fxLink.onload = fxShow;
        withHashFallback(fxLink, fxUrl, "href", shadowRoot, fxShow);
        setTimeout(fxShow, 3000);
        shadowRoot.appendChild(fxLink);
      }
    }


    // Optional text card beside the launcher (title + optional sub-line).
    var shellDiv2 = shadowRoot.querySelector(".shell");
    if (fabLabelEl && fabLabelEl.parentNode) fabLabelEl.parentNode.removeChild(fabLabelEl);
    fabLabelEl = null;
    // A pill (worn: its stylesheet named) carries its text inside: no card beside it.
    var label = fab.label && !(fxUrl && fab.shape === "pill") ? String(fab.label).trim() : "";
    var subLabel = fab.subLabel ? String(fab.subLabel).trim() : "";
    if (label && shellDiv2) {
      fabLabelEl = document.createElement("div");
      fabLabelEl.className = "gs-fab-label" + (isOpen ? " open" : "");
      // Unseen while its launcher waits for runtime-fab.css (above).
      if (launcherEl.style.visibility) fabLabelEl.style.visibility = "hidden";
      var titleEl = document.createElement("span");
      titleEl.className = "label-title";
      titleEl.textContent = label;
      // The card is always white: a light colour (the default is the
      // launcher's white icon colour) would leave an empty white box, so
      // only a colour that reads on white is applied.
      if (fab.textColor && readsOnWhite(fab.textColor)) titleEl.style.color = fab.textColor;
      fabLabelEl.appendChild(titleEl);
      if (subLabel) {
        var subEl = document.createElement("span");
        subEl.className = "label-sub";
        subEl.textContent = subLabel;
        fabLabelEl.appendChild(subEl);
      }
      // Same corner anchor as the launcher, offset by the FAB box + 10px gap.
      if (posClass === "bottom-left") fabLabelEl.style.left = (size + 10) + "px";
      else fabLabelEl.style.right = (size + 10) + "px";
      shellDiv2.appendChild(fabLabelEl);
    }

  }

  /** True when a #rgb / #rrggbb colour is dark enough to read on white (WCAG contrast >= 3). */
  function readsOnWhite(hex) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return false;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    function lin(c) { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    var l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return 1.05 / (l + 0.05) >= 3;
  }

  /** Launcher shadow is DERIVED from the brand colour — never configured. */
  function shadowFromPrimary(hex) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return "rgba(0,0,0,.22)";
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + ",.34)";
  }

  function applyConfigToShell(config) {
    if (!shadowRoot) return;
    var shellDiv = shadowRoot.querySelector(".shell");
    if (shellDiv) {
      // The panel's accent: the workspace's colour; without one, the colour
      // of the kit's button (the Iran kit's deep turquoise, RESPOK's Ink), so
      // the panel and the button agree (shared/widgetColor.ts).
      var accent = config.primaryColor || "#3B82F6";
      if (kitBrandColor(config)) {
        if (LOCAL_KIT && localKitOn(config)) accent = "#0B7D6C";
        else if (INTL_KIT && respokKitOn(config)) accent = "#16142B";
      }
      shellDiv.style.setProperty("--gs-primary", accent);
      // Second gradient stop for the full-panel gradient canvas.
      shellDiv.style.setProperty(
        "--gs-secondary",
        config.secondaryColor || config.primaryColor || "#6366F1"
      );
      shellDiv.style.setProperty("--gs-shadow", shadowFromPrimary(accent));
      // The launcher, its bubbles and the panel speak the widget's language
      // to a screen reader, not the host page's (WCAG 3.1.2).
      shellDiv.lang = widgetLang();
    }

    var posClass = config.position === "bottom-left" ? "bottom-left" : "bottom-right";
    // Keep the shared anchor on the SAME corner as the launcher/panel pair.
    if (shellDiv) {
      shellDiv.classList.toggle("pos-bottom-left", posClass === "bottom-left");
      shellDiv.classList.toggle("pos-bottom-right", posClass !== "bottom-left");
      // RESPOK's logo direction, one class for the launcher and the panel.
      if (INTL_KIT && respokKitOn(config)) {
        shellDiv.classList.toggle("lg-open", rpkOpen(config));
        shellDiv.classList.toggle("lg-thread", !rpkOpen(config));
      }
    }
    if (launcherEl) {
      // Set position + reveal in one paint so the user never sees a wrong
      // color first. The CSS transitions opacity so it fades in cleanly.
      var firstReveal = launcherEl.classList.contains("pending");
      launcherEl.className = "launcher " + posClass + " revealed" + (firstReveal ? " enter" : "");
      // ─── Workspace launcher (FAB) customization ───
      // The operator configures these under Widget → Appearance. The live
      // preview renders the exact same rules, so site == preview.
      applyFabConfig(config, posClass);
      if (firstReveal) {
        // Entry: force a genuine below-viewport → resting-position movement.
        // No opacity animation is involved.
        var labelEl = shellDiv && shellDiv.querySelector(".gs-fab-label");
        if (LOCAL_KIT && launcherEl.classList.contains("lk-kit")) {
          // The local kit's button arrives its own way instead (CSS: it springs in,
          // the bubble grows, then the three dots appear one by one; nothing
          // moves with reduced motion), and pings once 6s later if the chat
          // has not been opened.
          var kitLauncher = launcherEl;
          kitLauncher.classList.remove("enter");
          kitLauncher.classList.add("lk-kit-enter");
          setTimeout(function () { kitLauncher.classList.remove("lk-kit-enter"); }, 1400);
          setTimeout(function () { localKitPing(); }, LOCAL_KIT_PING_AFTER);
        } else {
          playFabEntry(launcherEl);
        }
        playFabEntry(labelEl);
      }
      // The real locale is only known now that /config has resolved — the
      // label built at mount time used the page's `lang` as a guess.
      syncLauncherLabel();
    }
    // Error toasts are anchored to the SAME corner as the launcher.
    if (errorToastEl) {
      errorToastEl.classList.toggle("toast-left", posClass === "bottom-left");
    }
  }

  // ─── Hashed-asset self-healing ───────────────────────────────────────
  // /config hands us content-hashed asset names (runtime.<hash>.js). If the
  // static host has not been redeployed in lockstep with the API, those
  // exact names 404 and the whole chat UI silently dies (or, worse, loads
  // partially: shell from cache, message renderer missing → thread opens
  // empty). Retry ONCE with the unhashed canonical filename before giving
  // up. Same origin, same path, no new endpoint — just a resilience net.
  function unhashedAssetUrl(url) {
    if (!url) return null;
    var alt = String(url).replace(/\.[0-9a-f]{6,16}\.(js|css)(\?|#|$)/, ".$1$2");
    if (alt === String(url)) return null;
    // A hashed URL carries no query (its name is its version); the
    // canonical name keeps a cache-buster, as it always had.
    return alt.indexOf("?") === -1
      ? alt + "?v=" + encodeURIComponent(configData.loaderVersion || LOADER_VERSION)
      : alt;
  }
  /**
   * Wires `el.onerror` so a hashed 404 is retried once with the unhashed
   * name (a fresh node, because re-setting src/href on a failed element is
   * not reliably re-fetched), then calls onFail() if that also fails.
   * Fresh means createElement, never cloneNode(): a cloned <script> keeps
   * its "already started" flag (HTML spec), so it is never fetched and
   * fires neither load nor error, and the panel would wait forever.
   */
  function withHashFallback(el, url, urlProp, parent, onFail) {
    el.onerror = function () {
      var alt = unhashedAssetUrl(url);
      if (!alt) { onFail(); return; }
      warn("asset failed, retrying unhashed:", alt);
      var retry = document.createElement(el.tagName.toLowerCase());
      for (var ai = 0; ai < el.attributes.length; ai++) {
        var attr = el.attributes[ai];
        if (attr.name !== urlProp) retry.setAttribute(attr.name, attr.value);
      }
      if (urlProp === "src") retry.async = el.async;
      retry[urlProp] = alt;
      retry.onload = el.onload;
      retry.onerror = function () { onFail(); };
      try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
      parent.appendChild(retry);
    };
  }

  // ─── HTTP helper with capped retries & jitter ───
  // `failFastOnError`: a thrown fetch (network / CORS failure) is not
  // retried here — the caller has its own fallback for it. 5xx still are.
  // A 429 (rate limited) is asked again ONCE, after the wait it names
  // (see retryDelay429); a second 429 is the answer.
  function fetchWithRetry(url, opts, attempts, failFastOnError) {
    attempts = attempts || 3;
    var attempt = 0;
    var retried429 = false;
    return new Promise(function (resolve, reject) {
      function go() {
        attempt++;
        fetch(url, opts).then(function (r) {
          if (r.status === 429 && !retried429) {
            retried429 = true;
            return retryDelay429(r).then(function (ms) {
              log("rate limited — retry in", ms, "ms");
              setTimeout(go, ms);
            });
          }
          if (r.status >= 500 && attempt < attempts) return delay();
          resolve(r);
        }).catch(function (err) {
          if (attempt < attempts && !failFastOnError) return delay(err);
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

  // How long to wait before asking a 429 again: the `retry_after` seconds of
  // its JSON body, else its Retry-After header (the server exposes it to
  // this origin), at most 10 s — 2 s when it names neither — plus up to half
  // a second at random, so visitors refused together do not return together.
  function retryDelay429(r) {
    var header = null;
    try { header = r.headers && r.headers.get ? r.headers.get("Retry-After") : null; } catch (_) {}
    var body;
    try { body = r.json(); } catch (_) { body = null; }
    return Promise.resolve(body).then(null, function () { return null; }).then(function (j) {
      var s = Number(j && j.retry_after);
      if (!(s > 0)) s = Number(header);
      return Math.min(s > 0 ? s * 1000 : 2000, 10000) + Math.floor(Math.random() * 500);
    });
  }

  // ─── Token-bearing POSTs that can go CORS-simple ───
  // POST /api/widget/track and /api/realtime/visitor-presence carry the
  // widget session token. A backend whose bootstrap said `protocol` >= 3
  // reads it from the JSON body (`widget_token`), so they are sent with no
  // request header at all: the browser labels the body text/plain and sends
  // no OPTIONS preflight (one round trip less on every page view whose
  // preflight is not cached). Any other backend — older, or not known yet —
  // gets exactly the request it always got: JSON with X-Widget-Token.
  // Never in the URL.
  function serverReadsBodyToken() {
    try { return Number(window.__gs_token && window.__gs_token.serverProtocol) >= 3; } catch (_) { return false; }
  }
  // A body-token request that fails (no CORS headers: a network error), is
  // refused as unauthenticated (401), or is refused as malformed (400: an
  // older process cannot read a text/plain body, and on a same-origin page
  // that answer is readable) may have reached a backend process older than
  // the one that answered the bootstrap (a rolling deploy, a rollback): it is
  // sent once more in the header form, and when that goes through, this page
  // keeps the header form from then on.
  // ─── The visitor credential (server/services/widget/visitorIdentity.ts) ───
  // For browsers that drop the HttpOnly dvsid cookie (Safari, Brave): the
  // bootstrap's signed visitor credential, on the token bus (`vc`, which
  // runtime.js sends too) and, only while the server says the cookie did not
  // arrive, in this page's own localStorage, so the next page view is still
  // the same visitor. Sent as X-Widget-Visitor (vh), or as
  // `visitor_credential` in the CORS-simple bodies (no preflight).
  function vcKey(ws) { return "gs:vc:" + ws; }
  function vcNow() { try { return window.__gs_token.vc || ""; } catch (_) { return ""; } }
  function vh(h) { var v = vcNow(); if (v) h["X-Widget-Visitor"] = v; return h; }
  function adoptVisitor(data, ws) {
    if (!data || typeof data.visitor_credential !== "string" || !ws) return;
    var keep = data.visitor_cookie === true ? "" : data.visitor_credential;
    try { window.__gs_token.vc = keep; } catch (_) {}
    try {
      if (keep) window.localStorage.setItem(vcKey(ws), keep);
      else window.localStorage.removeItem(vcKey(ws));
    } catch (_) {}
  }

  function tokenPost(url, payload, token) {
    function headerForm() {
      return fetch(url, {
        method: "POST",
        credentials: "include",
        headers: vh({ "Content-Type": "application/json", "X-Widget-Token": token }),
        body: JSON.stringify(payload),
      });
    }
    function useHeaderForm() {
      try { if (window.__gs_token) window.__gs_token.serverProtocol = 0; } catch (_) {}
    }
    if (!serverReadsBodyToken()) return headerForm();
    var body = {};
    for (var k in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
    }
    body.widget_token = token;
    if (vcNow()) body.visitor_credential = vcNow();
    return fetch(url, { method: "POST", credentials: "include", body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status !== 401 && r.status !== 400) return r;
        return headerForm().then(function (again) {
          if (again.ok) useHeaderForm();
          return again;
        });
      }, function () {
        useHeaderForm();
        return headerForm();
      });
  }

  // ─── POST /api/widget/boot, then /api/widget/bootstrap ───
  // The CORS-simple first try goes to /boot, a route only a backend that
  // reads its text/plain body has. An older backend answers it before any
  // bootstrap work (no route: 401/404, or no CORS headers at all), so it never
  // mints a token or sets a visitor cookie for whatever workspace the page
  // origin maps to; the JSON retry goes to /bootstrap, which every backend has.
  function bootstrapPath(json) { return json ? '/api/widget/bootstrap' : '/api/widget/boot'; }

  // A bootstrap answer from a backend that read our text/plain body: it says
  // `protocol` >= 2 and names the workspace we asked for (a disabled answer
  // names none). Anything else came from an older backend, which ignored
  // that body and can only have answered for the page origin's mapping.
  function isCurrentBootstrap(data, workspaceId) {
    return !!data && typeof data === "object" && Number(data.protocol) >= 2 &&
      (!data.workspace_id || sameWorkspaceId(data.workspace_id, workspaceId));
  }
  // The server answers with the id in its canonical spelling (lower case,
  // hyphenated); the page may have embedded another one of the same uuid.
  function sameWorkspaceId(a, b) {
    function c(v) { return String(v || "").replace(/[{}\-\s]/g, "").toLowerCase(); }
    return c(a) === c(b);
  }
  // An error the current bootstrap handler wrote (it carries `protocol`):
  // final, as a bootstrap error always was. Without it, the error came from a
  // backend that has no /boot route, and the JSON request to /bootstrap is
  // the real answer.
  function isFinalBootstrapError(body) {
    return !!body && typeof body === "object" && Number(body.protocol) >= 2;
  }

  // Sent first as a CORS-simple request to /boot: no Content-Type header, so
  // the browser labels the JSON text/plain and sends no OPTIONS preflight
  // (one round trip less on a first visit; `include_config` saves another).
  // Frontend and backend deploy independently, so the backend may be older
  // than this loader: it then has no /boot (an error, or no CORS headers at
  // all — a network error), or answers without `protocol`. Such an answer is
  // DROPPED and the same body is sent once more as application/json to
  // /bootstrap; that answer is used, and 401/403/404 and a disabled widget
  // are final there, as they always were. An error from the current handler
  // (it carries `protocol`) is final at once, and so is a 429 on /boot (both
  // paths share the bootstrap budget; fetchWithRetry already waited once).
  // 5xx are retried by fetchWithRetry as before.
  function requestBootstrap(apiBase, payload) {
    var body = JSON.stringify(payload);
    function parse(r) {
      if (r.status === 401 || r.status === 403) {
        throw new Error("unauthorized");
      }
      if (!r.ok) throw new Error("bootstrap_failed_" + r.status);
      return r.json();
    }
    function asJson() {
      return fetchWithRetry(apiBase + bootstrapPath(true), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: body,
      }, 3).then(parse);
    }
    return fetchWithRetry(apiBase + bootstrapPath(false), { method: "POST", credentials: "include", body: body }, 3, true)
      .then(function (r) {
        if (r.status === 429) return parse(r);
        if (!r.ok) {
          return r.json().then(function (j) {
            return isFinalBootstrapError(j) ? parse(r) : asJson();
          }, asJson);
        }
        return r.json().then(function (data) {
          return isCurrentBootstrap(data, payload.workspace_id) ? data : asJson();
        }, asJson);
      }, asJson);
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

    var bootstrapPayload = {
      workspace_id: WORKSPACE_ID,
      origin: window.location.origin,
      // The GET /config body comes back inline (an older backend ignores this).
      include_config: true,
    };
    if (commerceSubjectChanged(WORKSPACE_ID)) {
      bootstrapPayload.fresh_visitor = true;
      try {
        window.sessionStorage.removeItem("gs:view:" + WORKSPACE_ID);
        window.sessionStorage.removeItem(bindingKey(WORKSPACE_ID));
        document.cookie = "gs_active=; path=/; max-age=0; SameSite=Lax";
        window.localStorage.removeItem(vcKey(WORKSPACE_ID));
      } catch (_) {}
    } else {
      try { window.__gs_token.vc = window.localStorage.getItem(vcKey(WORKSPACE_ID)) || ""; } catch (_) {}
      if (vcNow()) bootstrapPayload.visitor_credential = vcNow();
    }
    requestBootstrap(apiBase, bootstrapPayload)
      .then(function (data) {
        if (data.disabled) {
          log("Widget disabled by server");
          if (shellEl) shellEl.remove();
          return null;
        }
        adoptVisitor(data, data.workspace_id || WORKSPACE_ID);
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
        // Commit the subject only after bootstrap has reset both identity
        // cookies. A failed reset must be attempted again on the next page.
        rememberCommerceSubject(WORKSPACE_ID);
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
        // Publish to shared bus so runtime + realtime driver use the same token,
        // and give the canonical session manager everything it needs to run
        // refresh / bounded re-bootstrap on behalf of every layer.
        try {
          if (window.__gs_token.configure) {
            window.__gs_token.configure({ apiBase: apiBase, workspaceId: WORKSPACE_ID, token: sessionToken, protocol: Number(data.protocol) || 0 });
          } else {
            window.__gs_token.set(sessionToken);
          }
        } catch (_) {}

        // Bind the store customer now: bootstrap has just established both
        // credentials this endpoint needs — the visitor cookie it reads the
        // identity from and the session token it is gated on — so this is the
        // earliest point the link can be made.
        var identityReady = bindCommerceIdentity(apiBase, WORKSPACE_ID, sessionToken);

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

        // The current backend sends the GET /config body inline; an older
        // one (or a widget that is not configured) does not, and then it is
        // asked for exactly as before.
        var inlineConfig = data.config && typeof data.config === "object" ? data.config : null;
        var configRequest = inlineConfig ? Promise.resolve(null) : fetchWithRetry(
          apiBase + "/api/widget/config?workspace_id=" + encodeURIComponent(WORKSPACE_ID),
          {
            credentials: "include",
            headers: { "X-Widget-Token": sessionToken },
          },
          3
        );
        return Promise.all([configRequest, identityReady]).then(function (ready) {
          if (inlineConfig) return inlineConfig;
          var r = ready[0];
          if (!r.ok) throw new Error("config_failed_" + r.status);
          return r.json();
        });
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
        // A conversation is going on in this browser (the runtime's
        // `gs_active` hint): the runtime boots silently once the page is
        // idle, so a reply reaches this page too (badge, preview, title).
        if (/(^|;\s*)gs_active=1/.test(document.cookie)) scheduleDeferred(preloadRuntimeForSmart);

        // Public API placeholder until runtime mounts
        widgetApi = {
          open: function () { triggerOpen(); },
          close: function () { triggerClose(); },
          toggle: function () { triggerOpen(); },
          setUnread: function (count) { setUnreadBadge(count); },
          show: function () { setLauncherHidden(false); },
          hide: function () { triggerClose(); setLauncherHidden(true); },
          // Callback-shaped — see callWithPublicState() above for why a
          // bare return value here is unusable by a host page.
          isOpen: function (cb) { callWithPublicState(cb); },
          getState: function (cb) { callWithPublicState(cb); },
          identify: function (data) { setIdentifyData(data); },
          consent: setConsent,
          onReady: onPublicEvent("ready"),
          onOpen: onPublicEvent("open"),
          onClose: onPublicEvent("close"),
          onMessage: onPublicEvent("message"),
          onUnreadChange: onPublicEvent("unreadchange"),
        };
        ready = true;
        readyFired = true;
        emitPublicEvent("ready");
        // A `consent` the page queued is applied before anything is tracked.
        processQueue();
        beginTracking();
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
    if (!opts.errorMessage && !opts.launcherOnly) {
      // A press or keyboard focus is an intent at once.
      var intentEvents = ["pointerdown", "touchstart", "focus"];
      for (var ie = 0; ie < intentEvents.length; ie++) {
        launcherEl.addEventListener(intentEvents[ie], onOpenIntent, { passive: true });
      }
      // A mouse only by MOVING over the launcher: one that appears under a
      // resting cursor gets a pointerenter (and maybe a synthetic move at the
      // same spot) though nobody moved. Movement opens the connections; the
      // files load once the pointer stays 100 ms, so a pointer that only
      // passes over the corner costs no download.
      launcherEl.addEventListener("pointerenter", onPointerEnter, { passive: true });
      launcherEl.addEventListener("pointermove", onPointerMove, { passive: true });
      launcherEl.addEventListener("pointerleave", onPointerLeave, { passive: true });
    }
  }

  // ─── Open intent: warm what a first open waits on ────────────────────
  // A first open needs two connections the page view no longer opens:
  // Chrome's uncredentialed one to the API (the open's preflights; the page
  // view sends none now) and to the fonts' host (the template's CORS font
  // files). Each costs a TCP + TLS setup at tap time. A pointer moving over
  // the launcher, a touch on it or keyboard focus says an open is likely:
  // both are opened then (rel=preconnect crossorigin, never on a page view
  // nobody opens, so no handshake is spent on those), and the panel's files
  // load and run (for a mouse once it stays 100 ms), with the template's
  // prepare() warming its faces. Only
  // their definitions run: runtime.init() (the realtime connection, every
  // API read) waits for a real open, or for a Smart Engagement preload.
  var openIntentSeen = false;
  var connectionsWarmed = false;
  var pointerAnchor = null;
  var dwellTimer = null;
  var holdRuntimeInit = false;
  var heldRuntimeInit = null;
  var preconnected = {};
  function preconnectAnonymous(base) {
    try {
      if (!base) return;
      var o = new URL(base, window.location.href).origin;
      if (!o || o === "null" || o === window.location.origin || preconnected[o]) return;
      preconnected[o] = true;
      var link = document.createElement("link");
      link.rel = "preconnect";
      link.href = o;
      link.crossOrigin = "anonymous";
      (document.head || document.documentElement).appendChild(link);
    } catch (_) { /* noop */ }
  }
  function warmConnections() {
    if (connectionsWarmed || !configData) return;
    connectionsWarmed = true;
    preconnectAnonymous(configData._apiBase);
    // The faces come from the fonts stylesheet's host (the template's other
    // files load no-cors, over the credentialed connection the page view
    // already opened).
    preconnectAnonymous(configData.presentationFontsUrl);
  }
  function onOpenIntent() {
    if (openIntentSeen || !configData) return;
    openIntentSeen = true;
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
    warmConnections();
    if (runtimeLoaded || runtimeLoading || runtimeLoadFailed) return;
    holdRuntimeInit = true;
    loadRuntimeAssets();
  }
  function isMousePointer(ev) {
    return !ev || !ev.pointerType || ev.pointerType === "mouse" || ev.pointerType === "pen";
  }
  function onPointerEnter(ev) {
    if (!isMousePointer(ev)) return;
    pointerAnchor = { x: ev.clientX, y: ev.clientY };
  }
  function onPointerMove(ev) {
    if (openIntentSeen || !isMousePointer(ev)) return;
    if (!pointerAnchor) { pointerAnchor = { x: ev.clientX, y: ev.clientY }; return; }
    if (Math.abs(ev.clientX - pointerAnchor.x) + Math.abs(ev.clientY - pointerAnchor.y) < 3) return;
    warmConnections();
    if (!dwellTimer) dwellTimer = setTimeout(function () { dwellTimer = null; onOpenIntent(); }, 100);
  }
  function onPointerLeave() {
    pointerAnchor = null;
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
  }
  // Something wants the runtime itself now (an open, a Smart Engagement
  // preload): run the init a warm-up held back, or let the load go on to it.
  function releaseRuntimeInit() {
    holdRuntimeInit = false;
    var run = heldRuntimeInit;
    heldRuntimeInit = null;
    if (run) run();
  }

  // ─── Single source of truth for open state ───────────────────────────
  // The Runtime owns `isOpen`. The loader NEVER flips its own copy blindly;
  // after every action it re-reads the runtime and mirrors the launcher.
  function runtimeInstanceRef() {
    return (window.__gs_runtime && window.__gs_runtime._instance) || null;
  }
  function syncOpenStateFromRuntime() {
    var was = isOpen;
    var inst = runtimeInstanceRef();
    if (inst && typeof inst.isOpen === "function") {
      try { isOpen = !!inst.isOpen(); } catch (_) { /* keep last known */ }
    } else {
      isOpen = false;
    }
    if (launcherEl && isOpen && launcherEl.__gsFabEntryAnimation) {
      try { launcherEl.__gsFabEntryAnimation.cancel(); } catch (_) {}
      launcherEl.__gsFabEntryAnimation = null;
    }
    if (launcherEl) launcherEl.classList.toggle("open", !!isOpen);
    if (fabLabelEl) fabLabelEl.classList.toggle("open", !!isOpen);
    // The local kit's button: opening ends its entrance and ping; closing
    // brings its three dots back one by one (the kit's is-closing).
    if (LOCAL_KIT && launcherEl && launcherEl.classList.contains("lk-kit")) {
      if (isOpen) launcherEl.classList.remove("lk-kit-enter", "lk-kit-pinging", "lk-kit-closing");
      else if (was) {
        var closing = launcherEl;
        closing.classList.add("lk-kit-closing");
        setTimeout(function () { closing.classList.remove("lk-kit-closing"); }, 700);
      }
    }
    syncLauncherLabel();
    applyMobileFullScreen(!!isOpen);
    if (isOpen !== was) emitPublicEvent(isOpen ? "open" : "close");
    return isOpen;
  }

  // ─── Mobile: panel is pinned to the visitor's screen ─────────────────
  // On phones an open panel must behave like a native sheet: it covers the
  // visual viewport, follows the on-screen keyboard (visualViewport) and the
  // host page behind it must not scroll. Desktop is untouched.
  // A phone in either orientation: narrow, or short with a touch screen (a
  // phone turned to landscape is 844x390; a tablet is never that short).
  // Re-evaluated whenever the viewport changes while the panel is open: the
  // owner's iPhone, turned to landscape, kept the desktop box (cut off), and
  // turned back it stayed a floating card once a sync had dropped the class.
  var PHONE_MQ = "(max-width:640px),(max-height:500px) and (pointer:coarse)";
  var mobileLockState = null;
  function isPhoneViewport() {
    try { return window.matchMedia(PHONE_MQ).matches; } catch (_) { return false; }
  }
  function onViewportTurn() { if (isOpen) applyMobileFullScreen(true); }
  window.addEventListener("resize", onViewportTurn);
  window.addEventListener("orientationchange", onViewportTurn);
  function syncVisualViewport() {
    if (!shellContentEl) return;
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight;
    shellContentEl.style.setProperty("--gs-vvh", Math.round(h) + "px");
    // Keep the shell glued to the top of the *visual* viewport while the
    // keyboard or the mobile URL bar shifts it.
    shellContentEl.style.setProperty("--gs-vvo", Math.round((vv && vv.offsetTop) || 0) + "px");
    if (mobileLockState) shellContentEl.style.transform = "translateY(" + Math.round((vv && vv.offsetTop) || 0) + "px)";
  }
  function watchPage() {
    var mo = window.MutationObserver && new MutationObserver(function () { applyMobileFullScreen(isOpen); });
    if (mo) mo.observe(document.body, { attributes: true, attributeFilter: ["style"] });
    return mo || 1;
  }
  function unwatchPage(st) { if (st && st.held && st.held.disconnect) st.held.disconnect(); }
  function applyMobileFullScreen(open) {
    if (!shellContentEl) return;
    var want = open && isPhoneViewport();
    if (want === !!mobileLockState) {
      // The other widget let the page go while this panel stays: hold it now.
      if (want && mobileLockState.held && document.body.style.position !== "fixed") { unwatchPage(mobileLockState); mobileLockState = null; applyMobileFullScreen(true); return; }
      if (want) syncVisualViewport();
      return;
    }
    if (want) {
      var body = document.body;
      var docEl = document.documentElement;
      // A page another widget already holds (the call widget's phone
      // panel) stays its holder's: each widget restores only what it
      // changed, else whichever closed last would freeze the page again;
      // it is watched, so that this panel holds it the moment it is let go.
      mobileLockState = body.style.position === "fixed" ? { held: watchPage() } : {
        scrollY: window.scrollY || window.pageYOffset || 0,
        bodyOverflow: body.style.overflow,
        bodyPosition: body.style.position,
        bodyTop: body.style.top,
        bodyWidth: body.style.width,
        docOverscroll: docEl.style.overscrollBehavior,
      };
      shellContentEl.classList.add("gs-mobile-open");
      if (!mobileLockState.held) {
        body.style.position = "fixed";
        body.style.top = "-" + mobileLockState.scrollY + "px";
        body.style.width = "100%";
        body.style.overflow = "hidden";
        docEl.style.overscrollBehavior = "none";
      }
      syncVisualViewport();
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", syncVisualViewport);
        window.visualViewport.addEventListener("scroll", syncVisualViewport);
      }
    } else {
      var st = mobileLockState;
      mobileLockState = null;
      shellContentEl.classList.remove("gs-mobile-open");
      shellContentEl.style.transform = "";
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", syncVisualViewport);
        window.visualViewport.removeEventListener("scroll", syncVisualViewport);
      }
      unwatchPage(st);
      if (st && !st.held) {
        document.body.style.position = st.bodyPosition;
        document.body.style.top = st.bodyTop;
        document.body.style.width = st.bodyWidth;
        document.body.style.overflow = st.bodyOverflow;
        document.documentElement.style.overscrollBehavior = st.docOverscroll;
        window.scrollTo(0, st.scrollY);
      }
    }
  }

  // `quiet`: nobody asked (a Smart Engagement rule): the focus stays put.
  function triggerOpen(quiet) {
    if (!launcherEl) return;
    commerceContextOnOpen();
    var inst = runtimeInstanceRef();
    if (runtimeLoaded && inst) {
      try { inst.open(quiet); } catch (_) {}
      syncOpenStateFromRuntime();
      return;
    }
    onLauncherClick(quiet);
  }
  function triggerClose() {
    var inst = runtimeInstanceRef();
    var wasOpen = isOpen || !!(launcherEl && launcherEl.classList.contains("open"));
    if (runtimeLoaded && inst) {
      try { inst.close(); } catch (_) {}
      syncOpenStateFromRuntime();
      // Closing removes both visibility classes in one browser task. Run an
      // explicit below-edge → resting-position animation so the browser cannot
      // coalesce those style changes: the FAB rises while the panel descends.
      if (wasOpen) {
        playFabEntry(launcherEl);
        playFabEntry(fabLabelEl);
      }
      return;
    }
    isOpen = false;
    if (launcherEl) launcherEl.classList.remove("open");
    if (fabLabelEl) fabLabelEl.classList.remove("open");
    syncLauncherLabel();
    if (wasOpen) {
      playFabEntry(launcherEl);
      playFabEntry(fabLabelEl);
    }
  }
  // Exposed so the panel's own collapse chevron can close deterministically
  // instead of round-tripping through a hidden launcher click (which could
  // desync `isOpen` and leave the launcher stuck in the "open" state).
  try { window.__gs_panel_close = triggerClose; } catch (_) {}

  function onLauncherClick(quiet) {
    if (!configData) return;
    commerceContextOnOpen();
    var inst = runtimeInstanceRef();
    if (runtimeLoaded && inst) {
      try { inst.toggle(); } catch (_) {}
      syncOpenStateFromRuntime();
      return;
    }
    // A Smart Engagement silent preload (see preloadRuntimeForSmart) or an
    // open-intent warm-up (onOpenIntent) may already have a load in flight.
    // Upgrade it to "open when ready" instead of starting a second,
    // redundant load.
    wantRuntimeOpen = true;
    quietOpen = quiet === true;
    if (runtimeLoading) { releaseRuntimeInit(); return; }
    holdRuntimeInit = false;
    loadRuntimeAssets();
  }


  // Loads runtime.css + runtime.js (+ the call-module sidecar) and calls
  // window.__gs_runtime.init(). Shared by onLauncherClick (visitor clicked
  // the launcher) and preloadRuntimeForSmart (Smart Engagement background
  // preload — see there). `wantRuntimeOpen` decides whether the panel
  // actually opens once ready and whether a load failure surfaces a visible
  // error — a silent preload must never pop an error at a visitor who
  // hasn't asked for anything yet.
  // Presentation-owned font asset (opaque to the loader: no family, no
  // template id). Injected at DOCUMENT level so `document.fonts` sees the
  // faces, and injected EARLY — pre-runtime surfaces (the launcher nudge)
  // must already paint in the template's own typeface. The stylesheet is
  // also expected to publish a generic `--gs-presentation-font` custom
  // property, which the shell consumes through a var() fallback.
  // Settles once the template's font stylesheet has loaded or failed (null
  // while none was injected): the template's prepare() asks the browser for
  // faces, and a face the stylesheet has not declared yet is found missing at
  // once, so the panel would open in the fallback font and swap. The loader
  // still knows nothing of what the stylesheet holds.
  var presentationFontsReady = null;
  function stylesheetSettled(link) {
    return new Promise(function (resolve) {
      try { if (link.sheet) { resolve(); return; } } catch (_) { /* noop */ }
      link.addEventListener("load", function () { resolve(); });
      link.addEventListener("error", function () { resolve(); });
    });
  }

  function injectPresentationFonts(url) {
    if (!url) return;
    try {
      var existing = document.getElementById("gs-presentation-fonts");
      if (existing) {
        if (!presentationFontsReady) presentationFontsReady = stylesheetSettled(existing);
        return;
      }
      var fontsLink = document.createElement("link");
      fontsLink.id = "gs-presentation-fonts";
      fontsLink.rel = "stylesheet";
      fontsLink.href = url;
      presentationFontsReady = stylesheetSettled(fontsLink);
      (document.head || document.documentElement).appendChild(fontsLink);
      // Mirror the presentation font custom property onto the shadow host.
      // Custom properties normally inherit into the shadow tree, but the
      // shell's `all:initial` reset makes that fragile across engines — so
      // the value is copied explicitly (still opaque: the loader never
      // learns the family name).
      var syncFontVar = function () {
        try {
          var v = getComputedStyle(document.documentElement)
            .getPropertyValue("--gs-presentation-font");
          if (!v || !v.trim()) return false;
          var shell = shadowRoot && shadowRoot.querySelector(".shell");
          if (!shell) return false;
          shell.style.setProperty("--gs-presentation-font", v.trim());
          return true;
        } catch (_) { return false; }
      };
      fontsLink.addEventListener("load", syncFontVar);
      var syncTries = 0;
      (function pollFontVar() {
        if (syncFontVar()) return;
        if (syncTries++ > 40) return;
        setTimeout(pollFontVar, 100);
      })();
    } catch (_) { /* noop */ }
  }

  function loadRuntimeAssets() {
    if (runtimeLoaded || runtimeLoading) return;
    runtimeLoading = true;
    injectPresentationFonts(configData.presentationFontsUrl || "");

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
    // ─── Presentation (template) assets ───────────────────────────
    // The registry + active template renderer + template stylesheet.
    // Widget Core carries no markup, so these are REQUIRED — same
    // strict, hash-only policy as the runtime assets above.
    var presentationRegistryJs = configData.presentationRegistryUrl || "";
    var presentationJs = configData.presentationUrl || "";
    var presentationCss = configData.presentationStyleUrl || "";
    // OPTIONAL generic descriptor asset (currently the template's font
    // stylesheet). Absent → nothing extra is loaded; never required.
    var presentationFontsCss = configData.presentationFontsUrl || "";
    // OPTIONAL skin stylesheet — a template that restyles another template's
    // renderer (the International edition's `intl`). Absent → nothing extra.
    var presentationSkinCss = configData.presentationSkinUrl || "";

    var callRuntimeJs = configData.callRuntimeUrl || "";
    // Pass 2 — vendor LiveKit SDK URL (hashed, self-hosted). Set BEFORE
    // any runtime-call.js script runs so its strict loadSdk() never has
    // to fall back to anything. When this is missing the call surface
    // surfaces a `sdk_url_missing` error at Join time — never silently.
    var livekitSdkUrl = configData.livekitSdkUrl || "";
    if (livekitSdkUrl) {
      try { window.__gs_call_sdk_url = livekitSdkUrl; } catch (_) { /* noop */ }
    }
    if (!presentationRegistryJs || !presentationJs || !presentationCss) {
      warn("No presentation template URLs");
      runtimeLoading = false;
      if (wantRuntimeOpen) showShellError(lt("resourcesUnavailable"));
      return;
    }
    if (!runtimeJs || !runtimeCss) {
      warn("No runtime URL");
      runtimeLoading = false;
      if (wantRuntimeOpen) showShellError(lt("resourcesUnavailable"));
      return;
    }

    var cssLoaded = !runtimeCss;
    var jsLoaded = false;
    var templateCssLoaded = false;
    var templateSkinLoaded = !presentationSkinCss;
    var registryLoaded = false;
    var templateJsLoaded = false;
    var presentationPreparing = false;
    var preparation = null;
    var failed = false;

    // The template's own readiness (its typeface), started as soon as the
    // registry and the renderer are in, while runtime.js is still on its way,
    // so whatever it fetches loads alongside; done() awaits the same promise.
    // The context is opaque here: the template decides what its first paint
    // needs from the locale (the loader knows no font, family or file).
    function startPreparation() {
      if (preparation || !registryLoaded || !templateJsLoaded) return preparation;
      var registry = window.__gs_presentation_registry;
      var descriptor = registry && typeof registry.resolve === "function"
        ? registry.resolve(configData.templateId)
        : null;
      var presentationModule = descriptor ? window[descriptor.globalKey] : null;
      // prepare() runs once the font stylesheet is in (at most 800 ms later:
      // a slow or failed stylesheet only costs the typeface, never the panel).
      var fontsGate = presentationFontsReady
        ? Promise.race([presentationFontsReady, new Promise(function (resolve) { setTimeout(resolve, 800); })])
        : Promise.resolve();
      preparation = fontsGate.then(function () {
        var ready = null;
        try {
          ready = presentationModule && typeof presentationModule.prepare === "function"
            ? presentationModule.prepare({ locale: configData.locale, templateId: configData.templateId })
            : null;
        } catch (_) { ready = null; }
        return ready;
      }).catch(function () {
        // Readiness is best-effort. A template must never make the widget
        // permanently unavailable because a font or other visual asset failed.
      });
      return preparation;
    }

    function done() {
      if (failed || !cssLoaded || !jsLoaded || !templateCssLoaded || !templateSkinLoaded || !registryLoaded || !templateJsLoaded) return;
      if (presentationPreparing) return;
      presentationPreparing = true;
      startPreparation().then(function () {
        // An open-intent warm-up stops here until something wants the runtime.
        if (holdRuntimeInit) { heldRuntimeInit = initRuntime; return; }
        initRuntime();
      });
    }

    function initRuntime() {
      runtimeLoaded = true;
      runtimeLoading = false;
      if (window.__gs_runtime && window.__gs_runtime.init) {
        try {
          var instance = window.__gs_runtime.init(configData, {
            shadowRoot: shadowRoot,
            shellEl: shellEl,
            launcher: launcherEl,
            setUnread: setUnreadBadge,
            setOperatorTyping: setOperatorTyping,
          });
          window.__gs_runtime._instance = instance;
          widgetApi = {
            open: function () { try { instance.open(); } catch (_) {} syncOpenStateFromRuntime(); },
            close: function () { try { instance.close(); } catch (_) {} syncOpenStateFromRuntime(); },
            toggle: function () { try { instance.toggle(); } catch (_) {} syncOpenStateFromRuntime(); },
            setUnread: setUnreadBadge,
            show: function () { setLauncherHidden(false); },
            hide: function () {
              try { instance.close(); } catch (_) {}
              syncOpenStateFromRuntime();
              setLauncherHidden(true);
            },
            // Callback-shaped — see callWithPublicState() above for why a
            // bare return value here is unusable by a host page.
            isOpen: function (cb) { callWithPublicState(cb); },
            getState: function (cb) { callWithPublicState(cb); },
            identify: function (data) { setIdentifyData(data); },
            consent: setConsent,
            onReady: onPublicEvent("ready"),
            onOpen: onPublicEvent("open"),
            onClose: onPublicEvent("close"),
            onMessage: onPublicEvent("message"),
            onUnreadChange: onPublicEvent("unreadchange"),
          };
          ready = true;
          // init() only MOUNTS. The panel opens here — and ONLY here — when
          // something actually asked for it (a real launcher click). A silent
          // Smart Engagement preload leaves the widget mounted but closed.
          if (wantRuntimeOpen) {
            try { instance.open(quietOpen); } catch (_) {}
          }
          syncOpenStateFromRuntime();
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
      holdRuntimeInit = false;
      heldRuntimeInit = null;
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
      withHashFallback(link, runtimeCss, "href", shadowRoot, function () { fail("css"); });
      shadowRoot.appendChild(link);
    }


    // Optional presentation-owned font asset — a hashed, immutable stylesheet
    // named by the active template's registry descriptor. The loader is
    // deliberately generic: it knows no font family, no template id and no
    // fixed path — only that the bootstrap may hand it one extra stylesheet.
    //
    // It is injected at DOCUMENT level (not the shadow root) because
    // `document.fonts.load()` — used by the template's own prepare() gate —
    // only sees document-level faces.
    injectPresentationFonts(presentationFontsCss);


    // Template stylesheet — injected AFTER runtime.css so template rules
    // keep their original cascade position. Core CSS stays template-agnostic.

    var tplLink = document.createElement("link");
    tplLink.rel = "stylesheet";
    tplLink.href = presentationCss;
    tplLink.setAttribute("data-gs-runtime", "true");
    tplLink.setAttribute("data-gs-template", "true");
    tplLink.onload = function () { templateCssLoaded = true; done(); };
    withHashFallback(tplLink, presentationCss, "href", shadowRoot, function () { fail("template-css"); });
    shadowRoot.appendChild(tplLink);

    // Skin stylesheet — after the template stylesheet, so its tokens win.
    // Never fatal: if it cannot load, the widget still works in the base look.
    if (presentationSkinCss) {
      var skinLink = document.createElement("link");
      skinLink.rel = "stylesheet";
      skinLink.href = presentationSkinCss;
      skinLink.setAttribute("data-gs-runtime", "true");
      skinLink.setAttribute("data-gs-template-skin", "true");
      skinLink.onload = function () { templateSkinLoaded = true; done(); };
      withHashFallback(skinLink, presentationSkinCss, "href", shadowRoot, function () {
        warn("Template skin failed to load; continuing without it");
        templateSkinLoaded = true;
        done();
      });
      shadowRoot.appendChild(skinLink);
    }

    // The registry and the active template's renderer, in parallel: the
    // renderer only registers itself on window, and both must be in before
    // runtime.init() runs (done()). Loading them one after the other cost a
    // round trip on every first open.
    var regScript = document.createElement("script");
    regScript.src = presentationRegistryJs;
    regScript.charset = "utf-8";
    regScript.async = true;
    regScript.setAttribute("data-gs-template", "registry");
    regScript.onload = function () { registryLoaded = true; startPreparation(); done(); };
    withHashFallback(regScript, presentationRegistryJs, "src", document.head, function () { fail("template-registry"); });
    document.head.appendChild(regScript);

    var tplScript = document.createElement("script");
    tplScript.src = presentationJs;
    tplScript.charset = "utf-8";
    tplScript.async = true;
    tplScript.setAttribute("data-gs-template", "renderer");
    tplScript.onload = function () { templateJsLoaded = true; startPreparation(); done(); };
    withHashFallback(tplScript, presentationJs, "src", document.head, function () { fail("template-js"); });
    document.head.appendChild(tplScript);

    var script = document.createElement("script");
    script.src = runtimeJs;
    script.charset = "utf-8";
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
          // Whoever awaits it (a Join) handles a failure; with nobody waiting,
          // a failed load must not surface on the customer's page as an
          // unhandled rejection.
          window.__gs_call_ready.then(null, function () {});
          var cs = document.createElement("script");
          cs.src = callJs;
          cs.charset = "utf-8";
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
          // Its own one-time canonical-name retry, like every hashed file.
          withHashFallback(cs, callJs, "src", document.head, function () {
            warn("call module failed to load");
            try { window.__gs_call_rejectReady && window.__gs_call_rejectReady(new Error('call_module_load_failed')); } catch (_) {}
          });
          document.head.appendChild(cs);
        }
      } catch (_) { /* never block chat boot on the call module */ }
      done();
    };
    withHashFallback(script, runtimeJs, "src", document.head, function () { fail("js"); });
    document.head.appendChild(script);

    // Core's optional module for a renderer that builds on it: /config names
    // it (`modules.ext`) for such a template only. Fetched with the
    // template's files (after runtime.js, which init() needs first), so
    // runtime.js finds it in the cache; nothing here waits for it, and
    // runtime.js requests it itself (canonical-name retry, short wait).
    var extJs = configData.modules && configData.modules.ext;
    if (extJs) {
      var extScript = document.createElement("script");
      extScript.src = extJs;
      extScript.charset = "utf-8";
      extScript.async = true;
      document.head.appendChild(extScript);
    }
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
    if (runtimeLoading) { releaseRuntimeInit(); return; }
    holdRuntimeInit = false;
    loadRuntimeAssets();
  }

  // ─── Unread badge (in shadow root) ───
  function setUnreadBadge(count) {
    if (!launcherEl) return;
    var existing = launcherEl.querySelector(".badge");
    if (existing) existing.remove();
    var kitBadge = LOCAL_KIT && launcherEl.classList.contains("lk-kit");
    if (count > 0) {
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = count > 9 ? "9+" : String(count);
      // The local kit's button: Persian digits in a Persian widget, and one
      // nudge when the first unread message arrives.
      if (LOCAL_KIT && kitBadge && widgetLang() === "fa") {
        badge.textContent = persianDigits(badge.textContent);
      }
      if (LOCAL_KIT && kitBadge && !(lastUnreadCount > 0)) {
        var nudged = launcherEl;
        nudged.classList.remove("lk-kit-nudge");
        void nudged.offsetWidth;
        nudged.classList.add("lk-kit-nudge");
        setTimeout(function () { nudged.classList.remove("lk-kit-nudge"); }, 700);
      }
      // RESPOK's button: the badge springs in the first time, bumps when it
      // was already showing and a message arrived, and keeps still when the
      // count only went down; a new message slides the answer pill in.
      if (INTL_KIT && launcherEl.classList.contains("rpk-kit")) {
        if (lastUnreadCount > 0) badge.classList.add(count > lastUnreadCount ? "rpk-kit-bump" : "rpk-kit-still");
        if (count > lastUnreadCount && !isOpen) {
          var arriving = launcherEl;
          arriving.classList.remove("rpk-kit-arrive");
          void arriving.offsetWidth;
          arriving.classList.add("rpk-kit-arrive");
          setTimeout(function () { arriving.classList.remove("rpk-kit-arrive"); }, 420);
        }
      }
      // The count is carried by the launcher's own accessible name instead.
      badge.setAttribute("aria-hidden", "true");
      launcherEl.appendChild(badge);
    }
    lastUnreadCount = Math.max(0, count | 0);
    syncLauncherLabel();
    emitPublicEvent("unreadchange", lastUnreadCount);
  }

  // ─── Public API: show()/hide() — launcher-level visibility ───────────
  // Distinct from open()/close() (the CHAT PANEL): this controls whether
  // the launcher bubble is on the page at all. hide() also closes the
  // panel first (a widget with no launcher but an open panel would be
  // unreachable/unclosable by the visitor).
  var launcherHidden = false;
  function setLauncherHidden(hidden) {
    launcherHidden = !!hidden;
    if (launcherEl) launcherEl.style.display = launcherHidden ? "none" : "";
  }

  // ─── Public API: getState()/isOpen() — queue-compatible state query ──
  // window.__gs.push([...]) is fire-and-forget: processQueue()/push() call
  // widgetApi[cmd[0]].apply(...) and DISCARD whatever it returns, so a
  // command that `return`s a value (the original isOpen() design) is
  // unusable from a host page — there is nowhere for that return value to
  // go. Every state query is therefore callback-shaped instead, exactly
  // like onReady/onOpen/etc.: `push(['getState', function (state) {...}])`.
  function getPublicState() {
    return { ready: !!ready, open: !!isOpen, visible: !launcherHidden, unread: lastUnreadCount };
  }
  function callWithPublicState(cb) {
    if (typeof cb !== "function") return;
    try { cb(getPublicState()); } catch (e) { warn("getState/isOpen callback error", e); }
  }

  // ─── Public API: identify() — visitor metadata via the EXISTING,
  // already-server-accepted visitor_name/visitor_email/visitor_phone
  // fields on POST /api/widget/message (the same fields the pre-chat form
  // already sends). No new identity mechanism, no new endpoint — this
  // only remembers the values so the next message send includes them.
  function setIdentifyData(data) {
    if (!data || typeof data !== "object") return;
    var next = {};
    if (typeof data.name === "string" && data.name.trim()) next.name = data.name.trim().slice(0, 200);
    if (typeof data.email === "string" && data.email.trim()) next.email = data.email.trim().slice(0, 255);
    if (typeof data.phone === "string" && data.phone.trim()) next.phone = data.phone.trim().slice(0, 30);
    try { window.__gs_identify_data = Object.assign({}, window.__gs_identify_data || {}, next); } catch (_) {
      window.__gs_identify_data = next;
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
      navGeneration++;
      recordJourneyPage();
      writeJson(window.sessionStorage, sessionKey, session);
    }

    // ─── AI Proactive Nudge — bounded visitor journey (additive) ──────────
    // AI_JOURNEY_MAX_PAGES mirrors src/lib/widget/smartEngine.ts's exported
    // constant of the same name — kept in lockstep the same way
    // buildFrequencyKey/isoWeekKey above are (see smartLoader.test.ts).
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
        returning: visitorIsNew === null ? false : !visitorIsNew,
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
      function send(tok, isRetry) {
        return fetch(apiBase + "/api/widget/smart/event", {
          method: "POST",
          credentials: "include",
          headers: vh({ "Content-Type": "application/json", "X-Widget-Token": tok }),
          body: JSON.stringify({
            workspace_id: WORKSPACE_ID,
            source: "ai_proactive",
            ai_nudge_id: nudgeId,
            event_type: type,
            page_path: (window.location.pathname || "/").slice(0, 500),
            idempotency_key: (currentSessionId() + ":" + nudgeId + ":" + type).slice(0, 160),
          }),
        })
          .then(function (r) {
            if (r.ok || isRetry) return;
            if (r.status !== 401 && r.status !== 403) return;
            if (!window.__gs_token || typeof window.__gs_token.recover !== "function") return;
            return window.__gs_token.recover().then(function (freshTok) {
              if (freshTok) return send(freshTok, true);
            });
          })
          .catch(function () {});
      }
      try {
        var token = (window.__gs_token && window.__gs_token.get()) || sessionToken;
        send(token, false);
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
      if (!shellContentEl || activeSurface) return false;
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
      var token = (window.__gs_token && window.__gs_token.get()) || sessionToken;
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
      shellContentEl.appendChild(el);
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
      if (!shellContentEl) return false;
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
      var wasOpen = !!isOpen;
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
            if (isOpen) { report(rule, "widget_opened"); return; }
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
    var SmartEngineRef = null;
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
    engineScript.charset = "utf-8";
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




  /**
   * Decode the exp claim from an HMAC widget session token (same format
   * read by runtime.js's TokenManager). Used so presence's own refresh
   * schedule can be bounded by this token's TTL too — it is issued
   * independently of, and is typically shorter-lived than, the realtime
   * connection/subscription tokens, so scheduling refresh purely off the
   * realtime TTL leaves a window where every refresh attempt starts with
   * an already-expired session token.
   */
  function readSessionTokenExpiry(t) {
    try {
      if (!t || typeof t !== 'string' || t.indexOf('wss_') !== 0) return 0;
      var raw = t.slice(4);
      var dot = raw.lastIndexOf('.');
      if (dot < 1) return 0;
      var b64 = raw.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var json = JSON.parse(atob(b64));
      return (json && typeof json.exp === 'number') ? json.exp * 1000 : 0;
    } catch (_) { return 0; }
  }

  // ─── Visitor live presence (realtime-first) ──────────────────────────
  //
  // While Centrifugo presence is authoritative, "this visitor is here right
  // now" is proven by an open SUBSCRIPTION to a sharded presence channel —
  // not by a database heartbeat. The backend derives the channel and both
  // tokens from the verified session id (`/api/realtime/visitor-presence`);
  // this side only holds the socket open.
  //
  // While the subscription is live, the liveness heartbeat is suppressed and
  // only real navigation still calls the API. If the socket cannot be
  // established (or drops for good), presence hands liveness back to the
  // heartbeat, so a visitor is never shown as offline just because realtime
  // failed.
  function startVisitorPresence(apiBase, workspaceId, sessionId, tokenNow, onOwnershipChange) {
    var ws = null;
    var closed = false;
    var owns = false;
    var attempt = 0;
    var retryTimer = null;
    var refreshTimer = null;
    var cmdId = 1;
    var negotiating = false;
    var refreshing = false;
    var currentWsUrl = null;
    /** Command id → reply handler (refresh / sub_refresh). */
    var pending = {};

    // Per-session lease presented on every heartbeat. While it is valid AND
    // the subscription is open, the server performs no liveness write. It is
    // dropped the moment ownership is lost, so a dead socket immediately hands
    // liveness back to the database path.
    var lease = null;
    var leaseExpiresAt = 0;

    function setOwns(v) {
      if (!v) { lease = null; leaseExpiresAt = 0; }
      if (owns === v) return;
      owns = v;
      try { onOwnershipChange(v); } catch (_) {}
    }

    function clearRefresh() {
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    }

    // Tokens and the lease are short-lived. Renew ~60s before the earliest
    // expiry so a backgrounded tab (whose timers are throttled to ~1Hz) still
    // renews in time instead of silently dropping out of presence.
    //
    // The renewal happens IN PLACE, over the live socket (Centrifugo
    // `refresh` + `sub_refresh`). A healthy visitor therefore never drops its
    // connection: closing the socket every TTL would produce a cluster-wide
    // reconnect wave and a presence gap for every visitor on the page.
    function scheduleRefresh(cfg) {
      clearRefresh();
      // Bound by the session token's own expiry too (not just the realtime
      // conn/lease TTLs): that token is minted independently, is often
      // shorter-lived, and nothing else touches the network to keep it warm
      // while presence owns liveness (the heartbeat is suppressed in that
      // state — see doPing below). Without this bound, refresh was scheduled
      // purely off the realtime TTL and every refresh attempt predictably
      // opened with an already-expired session token.
      var soonest = Math.min(
        cfg.expires_at || Infinity,
        cfg.lease_expires_at || Infinity,
        readSessionTokenExpiry(tokenNow()) || Infinity
      );
      if (!isFinite(soonest)) return;
      var delay = Math.max(15000, soonest - Date.now() - 60000);
      refreshTimer = setTimeout(function () {
        refreshTimer = null;
        refreshNow();
      }, delay);
    }

    function scheduleRetry(reason) {
      if (closed) return;
      if (retryTimer) return;
      // Bounded, jittered backoff — a broken realtime deployment must not turn
      // into a reconnect storm across every embedded page.
      attempt = Math.min(attempt + 1, 6);
      var base = Math.min(30000, 1000 * Math.pow(2, attempt));
      var delay = base / 2 + Math.random() * (base / 2);
      log('presence retry in', Math.round(delay), reason || '');
      retryTimer = setTimeout(function () {
        retryTimer = null;
        negotiate();
      }, delay);
    }

    function send(obj) {
      try { ws.send(JSON.stringify(obj)); } catch (_) {}
    }

    /** Send a command and route its reply to `cb(frame)`. */
    function call(payload, cb) {
      var id = cmdId++;
      pending[id] = cb;
      payload.id = id;
      send(payload);
    }

    function dropSocket() {
      if (ws) { try { ws.close(); } catch (_) {} }
    }

    function open(cfg) {
      try {
        ws = new WebSocket(cfg.ws_url);
      } catch (_) {
        return scheduleRetry('ws_ctor_failed');
      }
      currentWsUrl = cfg.ws_url;
      ws.onopen = function () {
        send({ id: cmdId++, connect: { token: cfg.token, name: 'widget-presence' } });
        send({ id: cmdId++, subscribe: { channel: cfg.channel, token: cfg.sub_token } });
      };
      ws.onmessage = function (ev) {
        var lines = String(ev.data || '').split('\n');
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i]) continue;
          var frame = null;
          try { frame = JSON.parse(lines[i]); } catch (_) { continue; }
          // Server ping — an empty object. The reply keeps the connection
          // (and therefore the presence entry) alive.
          if (frame && Object.keys(frame).length === 0) { send({}); continue; }
          if (frame && typeof frame.id === 'number' && pending[frame.id]) {
            var cb = pending[frame.id];
            delete pending[frame.id];
            try { cb(frame); } catch (_) {}
            continue;
          }
          if (frame && frame.subscribe) {
            attempt = 0;
            // The lease only becomes usable once the subscription is actually
            // open: it certifies "this session is connected", not "this
            // session asked to connect".
            lease = cfg.presence_lease || null;
            leaseExpiresAt = cfg.lease_expires_at || 0;
            setOwns(true);
            // Never log cfg.channel — its format (vp:v2:{workspace_id}:
            // {session_id}) embeds the visitor's session id.
            log('presence subscribed');
          }

          if (frame && frame.error) {
            setOwns(false);
          }
          // A publication on this visitor's channel: an operator wrote to
          // them (services/widget/visitorWake.ts). It carries nothing; the
          // runtime, booted silently, reads the reply and shows it.
          if (frame && frame.push && frame.push.pub) preloadRuntimeForSmart();
        }
      };
      ws.onclose = function (ev) {
        ws = null;
        pending = {};
        clearRefresh();
        setOwns(false);
        // Re-negotiate rather than reusing the old tokens: they may have
        // expired, and in app-routed mode another node may now be the right
        // endpoint. The close code is logged because a repeating presence
        // retry is almost always a server-side rejection (bad token: 3500,
        // unknown channel / namespace misconfiguration: 3501+), and without
        // it the log says only "closed".
        scheduleRetry(
          'closed code=' + (ev && ev.code) + (ev && ev.reason ? ' ' + ev.reason : ''),
        );
      };
      ws.onerror = function () { setOwns(false); };
    }

    /** Fetch a fresh presence config (tokens + lease). Resolves null on failure. */
    function fetchConfig(isRetry) {
      // CORS-simple when the backend takes the token in the body (tokenPost).
      return tokenPost(apiBase + '/api/realtime/visitor-presence', {
        workspace_id: workspaceId,
        session_id: sessionId,
      }, tokenNow())
        .then(function (r) {
          if (r.ok) return r.json();
          // The widget session died while the page sat open (tab left open
          // overnight). Rebuild the session ONCE instead of hammering the
          // endpoint with a credential the server will never accept again.
          if ((r.status === 401 || r.status === 403) && !isRetry) {
            var mgr = window.__gs_token;
            if (mgr && typeof mgr.recover === 'function') {
              return mgr.recover({ discardToken: r.status === 403 })
                .then(function (t) { return t ? fetchConfig(true) : null; });
            }
          }
          return null;
        })
        .catch(function () { return null; });
    }


    function usable(cfg) {
      return !!(cfg && cfg.vendor === 'centrifugo' && cfg.presence && cfg.ws_url && cfg.token);
    }

    /**
     * In-place renewal over the live socket. Only falls back to a reconnect
     * when the cluster hands us a different node, or when Centrifugo rejects
     * the renewal.
     */
    function refreshNow() {
      if (closed || refreshing) return;
      if (!ws || ws.readyState !== 1) return;
      refreshing = true;
      fetchConfig().then(function (cfg) {
        refreshing = false;
        if (closed || !ws || ws.readyState !== 1) return;
        if (!usable(cfg)) {
          // Realtime is no longer authoritative for this workspace: hand
          // liveness back to the database heartbeat.
          setOwns(false);
          dropSocket();
          return;
        }
        if (cfg.ws_url !== currentWsUrl) {
          // Assignment moved us to another node — a reconnect is the point.
          dropSocket();
          return;
        }
        var connOk = false;
        var subOk = false;
        var settled = false;
        function done() {
          if (settled) return;
          if (!connOk || !subOk) return;
          settled = true;
          lease = cfg.presence_lease || null;
          leaseExpiresAt = cfg.lease_expires_at || 0;
          setOwns(true);
          scheduleRefresh(cfg);
          log('presence refreshed in place');
        }
        function fail() {
          if (settled) return;
          settled = true;
          dropSocket();
        }
        call({ refresh: { token: cfg.token } }, function (frame) {
          if (frame && frame.error) return fail();
          connOk = true;
          done();
        });
        call({ sub_refresh: { channel: cfg.channel, token: cfg.sub_token } }, function (frame) {
          if (frame && frame.error) return fail();
          subOk = true;
          done();
        });
      });
    }

    function negotiate() {
      if (closed || negotiating || ws) return;
      negotiating = true;
      fetchConfig()
        .then(function (cfg) {
          negotiating = false;
          if (closed) return;
          if (!usable(cfg)) {
            // Database mode (or realtime unavailable): the heartbeat stays in
            // charge and we do NOT keep probing.
            setOwns(false);
            return;
          }
          scheduleRefresh(cfg);
          open(cfg);
        })
        .catch(function () {
          negotiating = false;
          scheduleRetry('negotiate_failed');
        });
    }

    // A throttled background tab can miss its refresh window entirely. On
    // becoming visible again, renew in place when the socket is still alive
    // and only reconnect when there is nothing left to renew.
    function onVisible() {
      if (closed || document.visibilityState !== 'visible') return;
      var leaseStale = !lease || leaseExpiresAt - Date.now() < 15000;
      if (ws && ws.readyState === 1) {
        if (leaseStale) refreshNow();
        return;
      }
      if (ws) { dropSocket(); return; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      attempt = 0;
      negotiate();
    }

    try { document.addEventListener('visibilitychange', onVisible); } catch (_) {}

    negotiate();

    return {
      owns: function () { return owns; },
      /** Valid only while connected; null makes the server write liveness. */
      lease: function () {
        if (!owns || !lease || Date.now() >= leaseExpiresAt) return null;
        return lease;
      },
      stop: function () {
        closed = true;
        setOwns(false);
        clearRefresh();
        try { document.removeEventListener('visibilitychange', onVisible); } catch (_) {}
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (ws) { try { ws.close(); } catch (_) {} ws = null; }
      },
    };
  }


  // ─── Visitor tracking (background, identity owned by HttpOnly cookie) ───
  function startTracking(apiBase, workspaceId, token) {
    if (!apiBase || !workspaceId) return;
    // The path; its query string only when the workspace keeps it
    // (config.privacy.keepQuery: `?email=…` or `?token=…` is not tracked by
    // default, P-01). Hash is excluded — most apps treat it as in-page state.
    var keepQuery = (configData.privacy || {}).keepQuery;
    function currentPage() {
      try { return window.location.pathname + (keepQuery && window.location.search || ''); }
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
    // ─── Token state (owned by the canonical session manager) ─────────
    // The widget session token has a short TTL (15 min). The loader NEVER
    // runs its own refresh engine any more — it asks the canonical session
    // manager on the shared bus, which is single-flight, so a loader
    // heartbeat recovery and a runtime proactive refresh that happen at the
    // same moment produce exactly ONE network request and one new token
    // that both layers adopt.
    try {
      if (window.__gs_token && window.__gs_token.configure) {
        window.__gs_token.configure({ apiBase: apiBase, workspaceId: workspaceId, token: token });
      } else if (window.__gs_token && token) {
        window.__gs_token.set(token);
      }
    } catch (_) {}

    function tokenNow() {
      try {
        var t = window.__gs_token && window.__gs_token.get();
        return t || token;
      } catch (_) { return token; }
    }
    var heartbeatTimer = null;
    var consecutiveFailures = 0;
    var STOPPED = false;

    function recoverToken() {
      try {
        if (window.__gs_token && window.__gs_token.recover) return window.__gs_token.recover();
      } catch (_) {}
      return Promise.resolve(null);
    }

    // NOTE: window.__gs_token.recover/.refresh/.bootstrap are the canonical
    // widget session manager installed once above (installSessionManager)
    // — recoverToken() here is just a thin local wrapper around that same
    // bus method (see its definition above), so nothing needs to be
    // (re)assigned onto the bus from inside startTracking.

    // Public custom-event API for Web Analytics — a workspace's own site
    // code calls window.gsAnalytics.track("signup_completed", {plan:"pro"}).
    // Never auto-fired; purely opt-in. Best-effort: never throws, never
    // blocks the caller's page.
    try {
      window.gsAnalytics = window.gsAnalytics || {};
      window.gsAnalytics.track = function (eventName, properties) {
        try {
          if (!eventName || typeof eventName !== "string" || !tracks()) return;
          fetch(apiBase + "/api/widget/event", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", "X-Widget-Token": tokenNow() },
            body: JSON.stringify({
              workspace_id: workspaceId,
              session_id: window.__gs_session_id || null,
              event_name: eventName,
              properties: properties || {},
              page_url: currentPage(),
              consent: consent,
            }),
          }).catch(function () {});
        } catch (_) {}
      };
    } catch (_) {}

    var trackQuery = currentQuery();
    // CORS-simple when the backend takes the token in the body (tokenPost).
    tokenPost(apiBase + "/api/widget/track", {
      workspace_id: workspaceId,
      event: "page_view",
      current_page: currentPage(),
      page_title: currentTitle(),
      referrer: document.referrer.split(/[?#]/)[0] || null,
      // Given (the server tracks nothing without it while consent is asked).
      consent: consent,
      browser: detectBrowser(),
      device: /Mobi|Android/i.test(navigator.userAgent) ? "Mobile" : "Desktop",
      os: detectOS(),
      // First-touch attribution for Web Analytics (server only persists
      // these on brand-new sessions — see server/routes/widget.ts).
      utm_source: trackQuery.utm_source || null,
      utm_medium: trackQuery.utm_medium || null,
      utm_campaign: trackQuery.utm_campaign || null,
      utm_term: trackQuery.utm_term || null,
      utm_content: trackQuery.utm_content || null,
      language: (configData.locale || document.documentElement.lang || navigator.language || null),
    }, tokenNow())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var sessionId = data && data.session_id ? data.session_id : null;
        if (!sessionId) return;
        try { window.__gs_session_id = sessionId; } catch (_) {}
        var lastPage = currentPage();
        // Realtime presence owns liveness while its subscription is live; the
        // periodic heartbeat is then suppressed entirely (navigation still
        // reports, because that is durable business data, not liveness).
        var presenceOwnsLiveness = false;
        var presence = startVisitorPresence(apiBase, workspaceId, sessionId, tokenNow, function (owns) {
          presenceOwnsLiveness = owns;
          log('presence owns liveness:', owns);
        });
        try { window.__gs_visitor_presence = presence; } catch (_) {}
        function doPing(tokenToUse, isRetry, force) {
          if (STOPPED || !tracks()) return;
          // Liveness is suppressed only while we hold a VALID lease — an open
          // socket whose lease lapsed must resume heartbeating, otherwise the
          // visitor would silently age out of the operator's list.
          var lease = presence.lease();
          if (presenceOwnsLiveness && lease && !force) return;
          // Skip when the page is hidden — saves battery and avoids
          // burning rate-limit budget on backgrounded tabs.
          if (typeof document !== 'undefined' && document.hidden) return;
          fetch(apiBase + "/api/widget/action", {
            method: "PUT",
            credentials: "include",
            headers: vh({ "Content-Type": "application/json", "X-Widget-Token": tokenToUse }),
            body: JSON.stringify({
              workspace_id: workspaceId,
              action: "heartbeat",
              session_id: sessionId,
              current_page: currentPage(),
              page_title: currentTitle(),
              presence_lease: lease,
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
        function ping(force) { doPing(tokenNow(), false, force); }
        function resumeHeartbeat(reason) {
          return recoverToken().then(function (newTok) {
            if (!newTok) return;
            STOPPED = false;
            consecutiveFailures = 0;
            if (!heartbeatTimer) heartbeatTimer = setInterval(ping, 60000);
            log('heartbeat resumed', reason);
            return doPing(newTok, false);
          });
        }
        // Background heartbeat — keeps presence "online" and refreshes
        // last_seen_at so the operator UI stays accurate. The server
        // coalesces these writes (only persists on navigation or once the
        // liveness row ages out), so the cadence costs ~no DB writes.
        heartbeatTimer = setInterval(ping, 60000);
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
          // Navigation is a durable business fact, so it is reported even
          // when realtime presence owns liveness.
          ping(true);
        }
        onHistoryChange(onUrlChange);
        window.addEventListener("popstate", onUrlChange);
        window.addEventListener("hashchange", onUrlChange);
      })
      .catch(function () {});
  }

  // Top-level query-param reader. `startSmart` has its own local copy; this
  // one exists so `startTracking` (a sibling scope) can read UTM params
  // without throwing "currentQuery is not defined".
  function currentQuery() {
    var out = {};
    try {
      var sp = new URLSearchParams(window.location.search || "");
      sp.forEach(function (v, k) { out[k.toLowerCase()] = v; });
    } catch (_) {}
    return out;
  }

  // On iOS every browser is WebKit and says "Safari"; Chrome, Firefox and
  // Edge there add CriOS, FxiOS and EdgiOS. Edge says Edg/ on computers,
  // EdgA/ on Android and Edge/ in its old EdgeHTML version.
  function detectBrowser() {
    var ua = navigator.userAgent;
    if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
    if (/CriOS/.test(ua)) return "Chrome";
    if (/FxiOS|Firefox/.test(ua)) return "Firefox";
    if (ua.indexOf("Chrome") > -1) return "Chrome";
    if (ua.indexOf("Safari") > -1) return "Safari";
    return "Other";
  }
  // Phones before computers: an iPhone says "like Mac OS X" and Android
  // says "Linux", so the old Mac/Linux-first order filed every iPhone under
  // macOS and every Android phone under Linux. An iPad asks for the desktop
  // site as a Mac; only its touch screen tells it apart.
  function detectOS() {
    var ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
    if (/Android/i.test(ua)) return "Android";
    if (ua.indexOf("Win") > -1) return "Windows";
    if (ua.indexOf("Mac") > -1) return navigator.maxTouchPoints > 1 ? "iOS" : "macOS";
    if (ua.indexOf("Linux") > -1) return "Linux";
    return "Other";
  }

  // OpenCart opts into identity before bootstrap: login upgrades the SAME
  // guest; logout/account switch requests a fresh visitor before history loads.
  // The response is never cached or embedded in cacheable storefront HTML.
  function prepareStoreIdentity() {
    if (attr("data-commerce-context-eager") !== "true") { bootstrap(); return; }
    var url;
    try {
      url = new URL(attr("data-commerce-context-url"), window.location.href);
      if (url.origin !== window.location.origin) { bootstrap(); return; }
    } catch (_) { bootstrap(); return; }
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 4000);
    fetch(url.href, { credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json" }, signal: controller ? controller.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("store_context_failed"); return r.json(); })
      .then(function (ctx) {
        if (ctx && ctx.subject && /^(anon|u[a-f0-9]{64})$/.test(ctx.subject)) {
          _loaderScript.setAttribute("data-commerce-subject", ctx.subject);
        }
        if (ctx && ctx.signed_in === false) _loaderScript.setAttribute("data-commerce-subject", "anon");
        if (ctx && ctx.assertion) _loaderScript.setAttribute("data-commerce-assertion", String(ctx.assertion));
        _commerceContextChecked = true;
      }).catch(function () {
        // A previous account must never restore private history while the
        // store cannot establish who is now signed in.
        _loaderScript.setAttribute("data-commerce-subject", "anon");
      }).then(function () { clearTimeout(timer); bootstrap(); });
  }

  // ─── Boot ───
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", prepareStoreIdentity);
  } else {
    prepareStoreIdentity();
  }
})();
