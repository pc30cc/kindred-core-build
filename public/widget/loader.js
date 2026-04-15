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

  var LOADER_VERSION = '2026-04-15-build-3';
  console.log('[Widget] Loader version: ' + LOADER_VERSION);

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

  function getWorkspaceId() {
    var loaderScript = getLoaderScript();
    var scriptWorkspaceId = loaderScript && loaderScript.getAttribute('data-workspace-id');
    return window.__gs_id || scriptWorkspaceId || null;
  }

  function getAssetBase() {
    var loaderScript = getLoaderScript();
    var explicitAssetBase = loaderScript && loaderScript.getAttribute('data-asset-base');
    if (explicitAssetBase && explicitAssetBase.indexOf('%VITE_') !== 0) {
      return explicitAssetBase.replace(/\/$/, '');
    }
    var src = loaderScript && loaderScript.src ? loaderScript.src : '';
    return src ? src.replace(/\/widget\/loader\.js.*$/, '') : '';
  }

  function getApiBase() {
    var loaderScript = getLoaderScript();
    if (window.__gs_api_base && typeof window.__gs_api_base === 'string' && window.__gs_api_base.indexOf('%VITE_') !== 0) {
      return window.__gs_api_base.replace(/\/$/, '');
    }

    var configured = loaderScript && loaderScript.getAttribute('data-api-base');
    if (configured && configured.indexOf('%VITE_') !== 0) {
      return configured.replace(/\/$/, '');
    }

    return '';
  }

  function logDebug(message, payload) {
    console.info('[Widget]', message, payload || '');
  }

  function logError(message, payload) {
    console.error('[Widget]', message, payload || '');
  }

  function getBootstrapMode(workspaceId) {
    return workspaceId ? 'explicit-workspace' : 'origin-resolved';
  }

  function isPreviewHost(hostname) {
    return /lovableproject\.com$/i.test(hostname || '') || /lovable\.app$/i.test(hostname || '');
  }

  function getPreviewFallbackConfig(assetBase, apiBase) {
    var safeAssetBase = (assetBase || '').replace(/\/$/, '');
    if (!safeAssetBase) return null;

    return {
      enabled: true,
      workspaceId: WORKSPACE_ID,
      apiBase: (apiBase || '').replace(/\/$/, ''),
      assetBase: safeAssetBase,
      brandName: document.title || 'Support',
      primaryColor: '#3B82F6',
      logoUrl: null,
      launcherText: 'Chat with us',
      welcomeMessage: 'Hello! How can we help you?',
      position: 'bottom-right',
      locale: document.documentElement.lang || 'en',
      features: {
        chat: false,
        knowledgeBase: false,
        visitorTracking: false,
      },
      runtimeUrl: safeAssetBase + '/widget/runtime.js',
      styleUrl: safeAssetBase + '/widget/runtime.css'
    };
  }

  function mountWidget(config, assetBase, apiBase) {
    WORKSPACE_ID = config.workspaceId || WORKSPACE_ID;
    window.__gs_id = WORKSPACE_ID;
    window.__gs._id = WORKSPACE_ID;

    logDebug('Bootstrap resolved mode:', getBootstrapMode(WORKSPACE_ID));
    logDebug('Resolved workspace ID:', WORKSPACE_ID || '(resolved later by backend response)');

    var runtimeApiBase = (config.apiBase || apiBase || '').replace(/\/$/, '');
    var runtimeAssetBase = (config.assetBase || assetBase || '').replace(/\/$/, '');
    logDebug('Selected apiBase:', runtimeApiBase || '(empty)');
    logDebug('Selected assetBase:', runtimeAssetBase || '(empty)');

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

    var runtimeCss = config.styleUrl || (runtimeAssetBase ? runtimeAssetBase + '/widget/runtime.css' : '');
    var runtimeJs = config.runtimeUrl || (runtimeAssetBase ? runtimeAssetBase + '/widget/runtime.js' : '');
    logDebug('Runtime assets:', { runtimeUrl: runtimeJs, styleUrl: runtimeCss });

    if (!runtimeCss || !runtimeJs) {
      console.warn('[Widget] Missing runtime asset URLs in widget config.', config);
      return;
    }

    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = runtimeCss;
    link.onerror = function() {
      logError('Runtime stylesheet failed to load:', runtimeCss);
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
      logError('Runtime script failed to load:', runtimeJs);
    };
    document.head.appendChild(script);
  }

  function bootstrap() {
    WORKSPACE_ID = getWorkspaceId();
    RESOLVE_BY_ORIGIN = !WORKSPACE_ID;
    var assetBase = getAssetBase();
    var apiBase = getApiBase();
    var origin = window.location.origin;
    var bootstrapMode = getBootstrapMode(WORKSPACE_ID);
    var params = new URLSearchParams({ origin: origin });

    logDebug('Workspace ID found:', WORKSPACE_ID || '(none)');
    logDebug('Bootstrap mode:', bootstrapMode);
    logDebug('Selected apiBase:', apiBase || '(empty)');
    logDebug('Selected assetBase:', assetBase || '(empty)');

    if (assetBase) {
      params.set('loader_origin', assetBase);
    }

    if (WORKSPACE_ID) {
      params.set('workspace_id', WORKSPACE_ID);
    }

    if (!apiBase) {
      logError('No apiBase resolved. Use window.__gs_api_base, data-api-base, or admin widget API base.');
      if (!isPreviewHost(window.location.hostname)) return;
    }

    var configUrl = (apiBase || '') + '/api/widget/config?' + params.toString();
    logDebug('Config URL:', configUrl);

    fetch(configUrl)
      .then(function(res) {
        logDebug('Config fetch status:', { status: res.status, ok: res.ok });
        if (!res.ok) throw new Error('Widget config failed: ' + res.status);
        return res.json();
      })
      .then(function(config) {
        if (!config.enabled) return;
        logDebug('Config resolved workspace:', config.workspaceId || '(none)');
        logDebug('Resolved config bases:', { apiBase: config.apiBase, assetBase: config.assetBase, runtimeUrl: config.runtimeUrl, styleUrl: config.styleUrl });
        mountWidget(config, assetBase, apiBase);
      })
      .catch(function(err) {
        logError('Bootstrap failed:', err);

        if (isPreviewHost(window.location.hostname)) {
          var fallbackConfig = getPreviewFallbackConfig(assetBase, apiBase);
          if (fallbackConfig) {
            console.info('[Widget] Using preview fallback config.');
            mountWidget(fallbackConfig, assetBase, apiBase);
          }
        }
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
