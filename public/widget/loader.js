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
  var WORKSPACE_ID = window.__gs_id;

  if (!WORKSPACE_ID) {
    console.warn('[Widget] Missing workspace ID. Set window.__gs_id before loading.');
    return;
  }

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

  function getApiBase() {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].src || '';
      if (src.indexOf('/widget/loader.js') !== -1) {
        return src.replace(/\/widget\/loader\.js.*$/, '');
      }
    }
    return '';
  }

  function loadStyle(url) {
    if (!url || document.querySelector('link[data-gs-widget-style]')) {
      return;
    }

    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.setAttribute('data-gs-widget-style', 'true');
    document.head.appendChild(link);
  }

  function loadRuntime(url, config) {
    if (!url) {
      console.warn('[Widget] Missing runtime URL.');
      return;
    }

    var script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.setAttribute('data-gs-widget-runtime', 'true');
    script.onload = function() {
      if (window.__gs_runtime) {
        widget = window.__gs_runtime.init(config);
        ready = true;
        processQueue();
      }
    };
    script.onerror = function() {
      console.warn('[Widget] Failed to load runtime:', url);
    };
    document.head.appendChild(script);
  }

  function bootstrap() {
    var apiBase = getApiBase();
    var origin = window.location.origin;
    var configUrl = apiBase + '/api/widget/config?workspace_id=' + encodeURIComponent(WORKSPACE_ID) + '&origin=' + encodeURIComponent(origin);

    fetch(configUrl)
      .then(function(res) {
        if (!res.ok) throw new Error('Widget config failed: ' + res.status);
        return res.json();
      })
      .then(function(config) {
        if (!config.enabled) return;

        if (config.features && config.features.visitorTracking) {
          var visitorId = localStorage.getItem('__gs_vid') || generateId();
          localStorage.setItem('__gs_vid', visitorId);

          fetch(apiBase + '/api/visitors/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspace_id: config.workspaceId,
              visitor_id: visitorId,
              current_page: window.location.pathname,
              referrer: document.referrer || null,
              browser: detectBrowser(),
              device: detectDevice(),
              os: detectOS()
            })
          }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.session_id) {
              startHeartbeat(apiBase, config.workspaceId, data.session_id);
            }
          }).catch(function() {});
        }

        var runtimeUrl = apiBase ? apiBase + '/widget/runtime.js' : config.runtimeUrl;
        var styleUrl = apiBase ? apiBase + '/widget/widget.css' : config.styleUrl;

        loadStyle(styleUrl);
        loadRuntime(runtimeUrl, config);
      })
      .catch(function(err) {
        console.warn('[Widget] Bootstrap failed:', err.message);
      });
  }

  function startHeartbeat(apiBase, workspaceId, sessionId) {
    setInterval(function() {
      fetch(apiBase + '/api/visitors/heartbeat', {
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
