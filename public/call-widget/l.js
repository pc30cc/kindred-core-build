/*!
 * Call Center widget loader (standalone, independent from chat widget).
 * Embed:
 *   <script async src="https://YOUR_DOMAIN/call-widget/l.js"
 *           workspace-id="WS_ID"></script>
 * Or with a public key:
 *   <script async src="https://YOUR_DOMAIN/call-widget/l.js"
 *           public-key="cck_..."></script>
 */
(function () {
  'use strict';
  if (window.__CC_WIDGET_LOADED__) return;
  window.__CC_WIDGET_LOADED__ = true;

  // This build's content-hashed file names. scripts/call-widget-hash.js
  // writes them in when it ships this file (esbuild `define`), from the very
  // files it ships beside it in the same image, so a name here can never
  // point at another deploy's bytes. Those files are served immutable; this
  // loader is served `no-cache` (a bodiless 304 while unchanged).
  // The raw source (the API image's copy, dev, tests) has no build: it loads
  // every file by its fixed name, versioned by the bootstrap, as before.
  var BUILD = null;
  try { BUILD = typeof __CALL_WIDGET_BUILD__ === 'string' ? JSON.parse(__CALL_WIDGET_BUILD__) : null; } catch (_) {}

  var s = document.currentScript || (function () {
    var arr = document.getElementsByTagName('script');
    return arr[arr.length - 1];
  })();
  var src = s.src || '';
  var origin = '';
  try { origin = new URL(src).origin; } catch (_) { origin = window.location.origin; }

  // Same opt-in debug convention as the chat widget (window.__gs_debug /
  // localStorage 'gs:debug') — this loader previously warned unconditionally
  // on embed misconfiguration and bootstrap failures, straight to every
  // visitor's production console.
  function isDebug() {
    try {
      if (window.__gs_debug === true) return true;
      return typeof localStorage !== 'undefined' && localStorage.getItem('gs:debug') === '1';
    } catch (_) { return false; }
  }
  function dwarn() {
    if (!isDebug()) return;
    try { console.warn.apply(console, arguments); } catch (_) {}
  }

  var workspaceId = s.getAttribute('workspace-id') || s.getAttribute('data-workspace-id');
  var publicKey = s.getAttribute('public-key') || s.getAttribute('data-public-key');
  if (!workspaceId && !publicKey) {
    dwarn('[call-widget] missing workspace-id or public-key');
    return;
  }

  var apiBase = (s.getAttribute('api-base') || origin).replace(/\/$/, '');
  var activeSessionKey = 'ccw_active_call_session:' + (workspaceId || publicKey || 'default') + ':' + apiBase;
  var activeSession = null;
  try { activeSession = window.sessionStorage.getItem(activeSessionKey); } catch (_) {}

  var qs = workspaceId
    ? 'workspaceId=' + encodeURIComponent(workspaceId)
    : 'publicKey=' + encodeURIComponent(publicKey);

  var head = document.head || document.documentElement;
  var CALL_PATH = /^\/call-widget\/([a-z0-9.-]+)$/i;
  // Unhashed fallback: the bootstrap's version of the files (raw source), or a
  // per-load token once a hashed file failed to load (a stale loader meeting
  // a newer deploy: its names are gone, the fixed names are always there).
  var fallbackSuffix = '';
  var stale = false;

  function hashedName(path) {
    var m = CALL_PATH.exec(path || '');
    return (m && BUILD && BUILD.files && !stale && BUILD.files[m[1]]) || null;
  }
  /** URL of one /call-widget/ file: this build's hashed copy when it has one. */
  function assetUrl(path) {
    var hashed = hashedName(path);
    return hashed ? origin + '/call-widget/' + hashed : origin + path + fallbackSuffix;
  }

  var requested = {};   // path -> true once its <script> is in the page
  var pending = 0;      // scripts requested and not yet executed
  var failed = false;   // a hashed script did not load: retry by fixed names
  var bootstrap = null;
  var mounted = false;

  // Downloads in parallel, runs in insertion order (`async = false` on a
  // script element made by a script): registry, presentation, runtime.
  function loadScripts(paths) {
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      if (requested[path]) continue;
      requested[path] = true;
      pending++;
      var sc = document.createElement('script');
      sc.async = false;
      sc.src = assetUrl(path);
      if (hashedName(path)) sc.onerror = function () { failed = true; settle(); };
      else sc.onerror = settle;
      sc.onload = settle;
      head.appendChild(sc);
    }
  }
  function settle() {
    pending--;
    if (pending === 0 && failed && !stale) {
      stale = true;
      failed = false;
      fallbackSuffix = '?v=' + versionToken() + '&t=' + Date.now();
      requested = {};
      loadScripts(scriptPaths());
      return;
    }
    tryMount();
  }

  function versionToken() {
    var v = (bootstrap && (bootstrap.assets_version || bootstrap.session)) || String(Date.now());
    return encodeURIComponent(String(v).slice(0, 16));
  }
  function presentationAssets() {
    return (bootstrap && bootstrap.assets) || {};
  }
  function pathOr(value, fallback) {
    return (typeof value === 'string' && CALL_PATH.test(value)) ? value : fallback;
  }
  function scriptPaths() {
    var a = presentationAssets();
    return [
      pathOr(a.presentation_registry_url, '/call-widget/presentation-registry.js'),
      pathOr(a.presentation_script_url, '/call-widget/presentation-default.js'),
      '/call-widget/runtime.js',
    ];
  }

  // Media is only needed after a visitor enters a call. Keep the 159 KiB
  // SDK out of the host page's initial load and share concurrent requests.
  // This build's hashed copy (the chat widget's file: one cache entry for
  // both widgets); the fixed name when there is none, or once if it fails.
  var liveKitWaiters = null;
  function ensureLiveKitSdk(cb) {
    if (window.LivekitClient || window.LiveKit) { cb(true); return; }
    if (liveKitWaiters) { liveKitWaiters.push(cb); return; }
    liveKitWaiters = [cb];
    function done() {
      var ready = !!(window.LivekitClient || window.LiveKit);
      var waiting = liveKitWaiters;
      liveKitWaiters = null;
      for (var i = 0; i < waiting.length; i++) waiting[i](ready);
    }
    function load(src, fallback) {
      var lk = document.createElement('script');
      lk.async = true;
      lk.setAttribute('data-cc-livekit-sdk', '1');
      lk.src = src;
      lk.onload = done;
      lk.onerror = function () { lk.remove(); if (fallback) load(fallback, null); else done(); };
      head.appendChild(lk);
    }
    var fixed = origin + '/call-widget/vendor/livekit-client.umd.min.js';
    if (BUILD && BUILD.livekit && !stale) load(origin + BUILD.livekit, fixed);
    else load(fixed, null);
  }

  function tryMount() {
    if (mounted || !bootstrap || pending > 0) return;
    if (!window.CallCenterWidget || typeof window.CallCenterWidget.mount !== 'function') return;
    mounted = true;
    window.CallCenterWidget.mount({
      apiBase: apiBase,
      origin: origin,
      assetsVersion: versionToken(),
      // Older runtimes/presentations build their stylesheet URLs from this.
      runtimeAssetSuffix: stale ? fallbackSuffix : ('?v=' + versionToken()),
      assetUrl: assetUrl,
      fontsUrl: (BUILD && BUILD.fonts && !stale) ? origin + BUILD.fonts : null,
      activeSessionKey: activeSessionKey,
      pageTitle: document.title,
      bootstrap: bootstrap,
      loadLiveKitSdk: ensureLiveKitSdk,
    });
  }

  // A built loader starts the UI files right away, in parallel with the
  // bootstrap; they are immutable, so a returning visitor has them already.
  // Not where this browser last heard "disabled": a switched-off widget
  // costs the host page nothing but the bootstrap.
  var offKey = 'ccw_off:' + (workspaceId || publicKey) + ':' + apiBase;
  function knownOff(value) {
    try {
      if (value === undefined) return window.localStorage.getItem(offKey) === '1';
      if (value) window.localStorage.setItem(offKey, '1'); else window.localStorage.removeItem(offKey);
    } catch (_) {}
    return false;
  }
  if (BUILD && !knownOff()) loadScripts(scriptPaths());

  var bootstrapHeaders = { 'Accept': 'application/json' };
  if (activeSession) bootstrapHeaders['x-cc-active-call'] = activeSession;
  // A rate limit, a server error or no answer at all is asked again, once,
  // after the server's Retry-After (at most 10 s; 2 s when it names none)
  // plus a random half second, so visitors do not come back in step.
  var bootstrapRetried = false;
  function retryBootstrap(seconds) {
    if (bootstrapRetried) return false;
    bootstrapRetried = true;
    var s = Number(seconds);
    setTimeout(requestBootstrap, Math.min(s > 0 ? s * 1000 : 2000, 10000) + Math.floor(Math.random() * 500));
    return true;
  }
  function requestBootstrap() {
    fetch(apiBase + '/api/call-widget/bootstrap?' + qs, {
      credentials: 'include',
      headers: bootstrapHeaders,
    })
      .then(function (r) {
        var retryAfter = null;
        try { retryAfter = r.headers.get('Retry-After'); } catch (_) {}
        return r.json().then(
          function (j) { return { ok: r.ok, status: r.status, body: j, retryAfter: retryAfter }; },
          function () { return { ok: false, status: r.status, body: null, retryAfter: retryAfter }; }
        );
      }, function (err) { return { ok: false, status: 0, body: null, error: err }; })
      .then(function (resp) {
        var body = resp.body || {};
        if (!resp.ok || body.status !== 'ok') {
          if ((resp.status === 0 || resp.status === 429 || resp.status >= 500) &&
              retryBootstrap(resp.retryAfter || body.retry_after || body.retryAfter)) return;
          // Switched off, unknown workspace or a site not allowed: remember
          // it (not a server error, a rate limit or no answer, which pass).
          if (resp.body && resp.status > 0 && resp.status < 500 && resp.status !== 429) knownOff(true);
          if (body.status === 'disabled') return; // silent: globally disabled
          dwarn('[call-widget] bootstrap failed', resp);
          return;
        }
        bootstrap = resp.body;
        knownOff(false);
        if (!BUILD) fallbackSuffix = '?v=' + versionToken();
        // A template whose files this build did not start (raw source, or a
        // template naming another script) is requested now.
        loadScripts(scriptPaths());
        tryMount();
      })
      .catch(function (err) {
        dwarn('[call-widget] bootstrap error', err);
      });
  }
  requestBootstrap();
})();
