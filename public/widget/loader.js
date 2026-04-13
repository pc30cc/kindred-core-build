/**
 * Widget Loader (public/widget/loader.js)
 * 
 * Thin, Crisp-style loader script.
 * This file is served as a static asset from the widget base URL.
 * It bootstraps the widget runtime by fetching config from the backend.
 * 
 * Usage in customer's site:
 * <script type="text/javascript">
 *   window.__gs = [];
 *   window.__gs_id = "WORKSPACE_ID";
 *   (function(){
 *     var d = document;
 *     var s = d.createElement("script");
 *     s.src = "https://widget.example.com/loader.js";
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
    console.warn('[GrowthSuite] Missing workspace ID. Set window.__gs_id before loading.');
    return;
  }

  // Command queue — supports queueing commands before widget is ready
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

  // Override push to process commands when widget is ready
  window.__gs = {
    push: function() {
      if (ready && widget) {
        var args = Array.prototype.slice.call(arguments);
        for (var i = 0; i < args.length; i++) {
          if (widget && typeof widget[args[i][0]] === 'function') {
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

  // Process any commands queued before loader ran
  if (Array.isArray(GS)) {
    for (var i = 0; i < GS.length; i++) {
      queue.push(GS[i]);
    }
  }

  // Bootstrap: fetch widget config from backend
  function bootstrap() {
    var origin = window.location.origin;
    // Widget config endpoint — resolved from environment, not hardcoded
    var configUrl = getApiBase() + '/api/widget/config?workspace_id=' + encodeURIComponent(WORKSPACE_ID) + '&origin=' + encodeURIComponent(origin);

    fetch(configUrl)
      .then(function(res) {
        if (!res.ok) throw new Error('Widget config fetch failed: ' + res.status);
        return res.json();
      })
      .then(function(config) {
        if (!config.enabled) return;

        // Load widget runtime
        var script = document.createElement('script');
        script.src = config.runtimeUrl || (getApiBase() + '/widget/runtime.js');
        script.async = true;
        script.onload = function() {
          if (window.__gs_runtime) {
            widget = window.__gs_runtime.init(config);
            ready = true;
            processQueue();
          }
        };
        document.head.appendChild(script);

        // Load widget styles
        if (config.styleUrl) {
          var link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = config.styleUrl;
          document.head.appendChild(link);
        }
      })
      .catch(function(err) {
        console.warn('[GrowthSuite] Widget bootstrap failed:', err.message);
      });
  }

  function getApiBase() {
    // Derive API base from the loader script's own src URL
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].src || '';
      if (src.indexOf('loader.js') !== -1) {
        return src.replace(/\/loader\.js.*$/, '');
      }
    }
    return '';
  }

  // Start bootstrap when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
