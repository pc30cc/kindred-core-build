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

  var qs = workspaceId
    ? 'workspaceId=' + encodeURIComponent(workspaceId)
    : 'publicKey=' + encodeURIComponent(publicKey);

  fetch(apiBase + '/api/call-widget/bootstrap?' + qs, {
    credentials: 'omit',
    headers: { 'Accept': 'application/json' },
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
    .then(function (resp) {
      if (!resp.ok || resp.body.status !== 'ok') {
        if (resp.body && resp.body.status === 'disabled') return; // silent: globally disabled
        console.warn('[call-widget] bootstrap failed', resp);
        return;
      }
      var bootstrap = resp.body;
      // Inject CSS
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = origin + '/call-widget/runtime.css';
      document.head.appendChild(link);
      // Inject runtime
      var sc = document.createElement('script');
      sc.async = true;
      sc.src = origin + '/call-widget/runtime.js';
      sc.onload = function () {
        if (window.CallCenterWidget && typeof window.CallCenterWidget.mount === 'function') {
          window.CallCenterWidget.mount({
            apiBase: apiBase,
            origin: origin,
            bootstrap: bootstrap,
          });
        }
      };
      document.body.appendChild(sc);
    })
    .catch(function (err) {
      console.warn('[call-widget] bootstrap error', err);
    });
})();