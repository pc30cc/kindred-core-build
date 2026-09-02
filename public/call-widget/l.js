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

  var s = document.currentScript || (function () {
    var arr = document.getElementsByTagName('script');
    return arr[arr.length - 1];
  })();
  var src = s.src || '';
  var origin = '';
  try { origin = new URL(src).origin; } catch (_) { origin = window.location.origin; }

  var workspaceId = s.getAttribute('workspace-id') || s.getAttribute('data-workspace-id');
  var publicKey = s.getAttribute('public-key') || s.getAttribute('data-public-key');
  if (!workspaceId && !publicKey) {
    console.warn('[call-widget] missing workspace-id or public-key');
    return;
  }

  var apiBase = (s.getAttribute('api-base') || origin).replace(/\/$/, '');
  var activeSessionKey = 'ccw_active_call_session:' + (workspaceId || publicKey || 'default') + ':' + apiBase;
  var activeSession = null;
  try { activeSession = window.sessionStorage.getItem(activeSessionKey); } catch (_) {}

  var qs = workspaceId
    ? 'workspaceId=' + encodeURIComponent(workspaceId)
    : 'publicKey=' + encodeURIComponent(publicKey);

  var bootstrapHeaders = { 'Accept': 'application/json' };
  if (activeSession) bootstrapHeaders['x-cc-active-call'] = activeSession;
  fetch(apiBase + '/api/call-widget/bootstrap?' + qs, {
    credentials: 'include',
    headers: bootstrapHeaders,
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
    .then(function (resp) {
      if (!resp.ok || resp.body.status !== 'ok') {
        if (resp.body && resp.body.status === 'disabled') return; // silent: globally disabled
        console.warn('[call-widget] bootstrap failed', resp);
        return;
      }
      var bootstrap = resp.body;
      // Cache-bust the unhashed runtime assets. The loader itself is
      // served no-store, so this version token is fresh on every page
      // load. Browsers + CDNs that ignore Cache-Control: no-store still
      // can't reuse a stale entry because the URL changes per load.
      var v = (bootstrap && (bootstrap.assets_version || bootstrap.session)) || String(Date.now());
      var versionToken = encodeURIComponent(String(v).slice(0, 16));
      // Per-page-load suffix: this widget is distributed cross-origin and
      // some customer/CDN/browser layers have already cached old fixed-path
      // assets. A deterministic token is not enough when frontend/API deploys
      // are split, so include time to force a fresh runtime every load.
      var bust = '?v=' + versionToken + '&t=' + Date.now();
      // Inject CSS
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = origin + '/call-widget/runtime.css' + bust;
      document.head.appendChild(link);

      var presentationAssets = (bootstrap && bootstrap.assets) || {};
      function assetUrl(value, fallback) {
        var path = (typeof value === 'string' && /^\/call-widget\/[a-z0-9.-]+$/i.test(value))
          ? value : fallback;
        return origin + path + bust;
      }
      var presentationCss = document.createElement('link');
      presentationCss.rel = 'stylesheet';
      presentationCss.href = assetUrl(
        presentationAssets.presentation_style_url,
        '/call-widget/presentation-default.css'
      );
      document.head.appendChild(presentationCss);

      // Load the LiveKit SDK locally if the host page hasn't provided one.
      // We reuse the SDK file shipped alongside the chat widget so customers
      // only paste a single call-widget script tag — no external CDN.
      function loadScript(src, done) {
        var sc = document.createElement('script');
        sc.async = true;
        sc.src = src;
        sc.onload = done;
        sc.onerror = done;
        document.body.appendChild(sc);
      }

      function loadRuntime() {
        loadScript(origin + '/call-widget/runtime.js' + bust, function () {
          if (window.CallCenterWidget && typeof window.CallCenterWidget.mount === 'function') {
            window.CallCenterWidget.mount({
              apiBase: apiBase,
              origin: origin,
              assetsVersion: versionToken,
              runtimeAssetSuffix: bust,
              activeSessionKey: activeSessionKey,
              pageTitle: document.title,
              bootstrap: bootstrap,
            });
          }
        });
      }

      function loadPresentation() {
        loadScript(assetUrl(
          presentationAssets.presentation_registry_url,
          '/call-widget/presentation-registry.js'
        ), function () {
          loadScript(assetUrl(
            presentationAssets.presentation_script_url,
            '/call-widget/presentation-default.js'
          ), loadRuntime);
        });
      }

      function ensureLiveKitSdk(cb) {
        if (window.LivekitClient || window.LiveKit) return cb();
        // Idempotent: avoid double-injection if another widget instance is loading.
        var existing = document.querySelector('script[data-cc-livekit-sdk]');
        if (existing) {
          existing.addEventListener('load', cb);
          existing.addEventListener('error', cb); // runtime will surface media_client_missing
          return;
        }
        var lk = document.createElement('script');
        lk.async = true;
        lk.setAttribute('data-cc-livekit-sdk', '1');
        // Local asset only — never an external CDN.
        // Self-hosted SDK. Prefer the standalone call-widget vendor path
        // (served by both the frontend image and the API server). Falls
        // back is unnecessary — both origins serve this file.
        lk.src = origin + '/call-widget/vendor/livekit-client.umd.min.js';
        lk.onload = cb;
        lk.onerror = cb; // runtime will detect missing window.LivekitClient and show media_client_missing
        document.head.appendChild(lk);
      }

      ensureLiveKitSdk(loadPresentation);
    })
    .catch(function (err) {
      console.warn('[call-widget] bootstrap error', err);
    });
})();
