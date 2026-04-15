/**
 * Widget Loader — Crisp-style thin loader.
 * Served as static asset. Bootstraps widget via backend API.
 *
 * Install on customer site:
 * <script type="text/javascript">
 *   window.__gs = [];
 *   window.__gs_id = "WORKSPACE_ID";
 *   (function(){
 *     var d = document;
 *     var s = d.createElement("script");
 *     s.src = "https://your-widget-domain.com/widget/loader.js";
 *     s.async = 1;
 *     d.getElementsByTagName("head")[0].appendChild(s);
 *   })();
 * </script>
 */
(function() {
  'use strict';

  var GS = window.__gs || [];
  var WORKSPACE_ID = window.__gs_id || null;
  var RESOLVE_BY_ORIGIN = !WORKSPACE_ID;

  var queue = [];
  var ready = false;
  var widget = null;

  function processQueue() {
    while (queue.length > 0) {
      var cmd = queue.shift();
      if (widget && typeof widget[cmd[0]] === 'function') {
        widget[cmd[0]].apply(widget, cmd.slice(1));
      }
    }
  }

  window.__gs = {
    push: function() {
      var args = Array.prototype.slice.call(arguments);
      if (ready && widget) {
        for (var i = 0; i < args.length; i++) {
          if (typeof widget[args[i][0]] === 'function') {
            widget[args[i][0]].apply(widget, args[i].slice(1));
          }
        }
      } else {
        for (var j = 0; j < arguments.length; j++) {
          queue.push(arguments[j]);
        }
      }
    },
    _id: WORKSPACE_ID
  };

  if (Array.isArray(GS)) {
    for (var i = 0; i < GS.length; i++) {
      queue.push(GS[i]);
    }
  }

  function getLoaderScript() {
    if (document.currentScript && (document.currentScript.src || '').indexOf('/widget/loader.js') !== -1) {
      return document.currentScript;
    }

    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].src || '';
      if (src.indexOf('/widget/loader.js') !== -1) {
        return scripts[i];
      }
    }

    return null;
  }

  function getAssetBase() {
    var loaderScript = getLoaderScript();
    var src = loaderScript && loaderScript.src ? loaderScript.src : '';
    return src ? src.replace(/\/widget\/loader\.js.*$/, '') : '';
  }

  function getApiBase(assetBase) {
    var loaderScript = getLoaderScript();
    var configured = loaderScript && loaderScript.getAttribute('data-api-base');

    if (configured && configured.indexOf('%VITE_') !== 0) {
      return configured.replace(/\/$/, '');
    }

    if (window.__gs_api_base && typeof window.__gs_api_base === 'string' && window.__gs_api_base.indexOf('%VITE_') !== 0) {
      return window.__gs_api_base.replace(/\/$/, '');
    }

    return assetBase;
  }

  function bootstrap() {
    var assetBase = getAssetBase();
    var apiBase = getApiBase(assetBase);
    var origin = window.location.origin;
    var params = new URLSearchParams({ origin: origin });

    if (assetBase) {
      params.set('loader_origin', assetBase);
    }

    if (WORKSPACE_ID) {
      params.set('workspace_id', WORKSPACE_ID);
    }

    var configUrl = apiBase + '/api/widget/config?' + params.toString();
    console.info('[Widget] Config URL:', configUrl);

    fetch(configUrl)
      .then(function(res) {
        console.info('[Widget] Config fetch status:', res.status, res.ok);
        if (!res.ok) throw new Error('Widget config failed: ' + res.status);
        return res.json();
      })
      .then(function(config) {
        if (!config.enabled) return;

        WORKSPACE_ID = config.workspaceId || WORKSPACE_ID;
        window.__gs_id = WORKSPACE_ID;
        window.__gs._id = WORKSPACE_ID;

        var runtimeApiBase = (config.apiBase || apiBase || '').replace(/\/$/, '');

        if (config.features && config.features.visitorTracking && runtimeApiBase && WORKSPACE_ID) {
          var visitorId = localStorage.getItem('__gs_vid') || generateId();
          localStorage.setItem('__gs_vid', visitorId);

          fetch(runtimeApiBase + '/api/visitors/track?workspace_id=' + encodeURIComponent(WORKSPACE_ID), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspace_id: WORKSPACE_ID,
              visitor_id: visitorId,
              current_page: window.location.pathname,
              referrer: document.referrer || null,
              browser: detectBrowser(),
              device: detectDevice(),
              os: detectOS()
            })
          }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.session_id) {
              localStorage.setItem('__gs_sid', data.session_id);
              startHeartbeat(runtimeApiBase, WORKSPACE_ID, data.session_id);
            }
          }).catch(function() {});
        }

        var runtimeCss = config.styleUrl || (assetBase + '/widget/runtime.css');
        var runtimeJs = config.runtimeUrl || (assetBase + '/widget/runtime.js');
        console.info('[Widget] Runtime assets:', { runtimeUrl: runtimeJs, styleUrl: runtimeCss });

        if (!runtimeCss || !runtimeJs) {
          console.warn('[Widget] Missing runtime asset URLs in widget config.');
          return;
        }

        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = runtimeCss;
        link.onerror = function() {
          console.warn('[Widget] Runtime stylesheet failed to load:', runtimeCss);
        };
        document.head.appendChild(link);

        var script = document.createElement('script');
        script.src = runtimeJs;
        script.async = true;
        script.onload = function() {
          if (window.__gs_runtime) {
            widget = window.__gs_runtime.init(config);
            ready = true;
            processQueue();
          }
        };
        script.onerror = function() {
          console.warn('[Widget] Runtime script failed to load:', runtimeJs);
        };
        document.head.appendChild(script);
      })
      .catch(function(err) {
        console.warn('[Widget] Bootstrap failed:', err);
      });
  }

  function startHeartbeat(apiBase, workspaceId, sessionId) {
    setInterval(function() {
      fetch(apiBase + '/api/visitors/heartbeat?workspace_id=' + encodeURIComponent(workspaceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          session_id: sessionId,
          current_page: window.location.pathname
        })
      }).catch(function() {});
    }, 30000);
  }

  function generateId() {
    return 'v_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  function detectBrowser() {
    var ua = navigator.userAgent;
    if (ua.indexOf('Chrome') > -1 && ua.indexOf('Edg') === -1) return 'Chrome';
    if (ua.indexOf('Firefox') > -1) return 'Firefox';
    if (ua.indexOf('Safari') > -1 && ua.indexOf('Chrome') === -1) return 'Safari';
    if (ua.indexOf('Edg') > -1) return 'Edge';
    return 'Other';
  }

  function detectDevice() {
    return /Mobi|Android/i.test(navigator.userAgent) ? 'Mobile' : 'Desktop';
  }

  function detectOS() {
    var ua = navigator.userAgent;
    if (ua.indexOf('Win') > -1) return 'Windows';
    if (ua.indexOf('Mac') > -1) return 'macOS';
    if (ua.indexOf('Linux') > -1) return 'Linux';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad/i.test(ua)) return 'iOS';
    return 'Other';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
