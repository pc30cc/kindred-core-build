/**
 * Widget Module: Realtime — Supabase Realtime driver.
 *
 * Subscribes to Supabase Broadcast channels using the SAME channel name
 * (`ws:<workspace_id>:conv:<cid>`) and SAME envelope shape
 * (`{ type: 'message' | 'typing' | 'seen', payload: {...} }`) used by
 * Centrifugo end-to-end, so the widget UI consumes one stable contract.
 *
 * Loads `@supabase/supabase-js` from a public CDN (esm.sh) on demand.
 * The anon key is already a public/publishable key — exposing it to the
 * widget is safe; service-role keys are NEVER sent to the browser.
 *
 * Drop-in for the same hook contract as runtime-rt-centrifugo.js:
 *   create(ctx, resolved, hooks) → driver
 *   driver: connect / disconnect / subscribeConversation /
 *           unsubscribeConversation / sendTyping /
 *           getCapabilities / hasCapability / getDriverName
 *
 * `resolved` must contain:
 *   { vendor: 'supabase', supabase_url, anon_key, capabilities? }
 */
(function () {
  'use strict';

  // Self-host friendly: never hardcode a third-party CDN. Operators that
  // want the Supabase realtime driver MUST expose the supabase-js bundle
  // from one of these sources, in order:
  //   1. window.__gs_supabase_client_factory          (already loaded)
  //   2. window.__gs_supabase_js_url                  (runtime override
  //      injected by the loader/runtime, e.g. the asset CDN configured in
  //      widget_platform_settings)
  //   3. <script data-supabase-js-url="…">           (data attribute on
  //      this asset's <script> tag, set by the loader when it knows the
  //      asset base URL)
  // If none of those resolve, the driver fails fast and the runtime falls
  // back to polling rather than pulling code from an unaudited third-party
  // origin (esm.sh / unpkg / jsDelivr).
  function resolveSupabaseJsUrl() {
    if (typeof window.__gs_supabase_js_url === 'string' && window.__gs_supabase_js_url) {
      return window.__gs_supabase_js_url;
    }
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (!s || !s.getAttribute) continue;
      var attr = s.getAttribute('data-supabase-js-url');
      if (attr) return attr;
    }
    return null;
  }
  var loadingClientLib = null;

  function loadSupabaseClient() {
    if (window.__gs_supabase_client_factory) {
      return Promise.resolve(window.__gs_supabase_client_factory);
    }
    if (loadingClientLib) return loadingClientLib;
    var supabaseJsUrl = resolveSupabaseJsUrl();
    if (!supabaseJsUrl) {
      // No self-hosted bundle URL configured — refuse to load from any
      // third-party CDN. Caller should fall back to polling.
      loadingClientLib = Promise.reject(new Error('supabase_js_url_unconfigured'));
      return loadingClientLib;
    }
    loadingClientLib = new Promise(function (resolve, reject) {
      // Use dynamic import via a module script — works in all evergreen browsers.
      var s = document.createElement('script');
      s.type = 'module';
      s.textContent =
        "import { createClient } from '" + supabaseJsUrl + "';" +
        'window.__gs_supabase_client_factory = createClient;' +
        "window.dispatchEvent(new Event('__gs_supabase_lib_ready'));";
      var done = false;
      function onReady() {
        if (done) return;
        done = true;
        window.removeEventListener('__gs_supabase_lib_ready', onReady);
        if (window.__gs_supabase_client_factory) {
          resolve(window.__gs_supabase_client_factory);
        } else {
          reject(new Error('supabase_lib_missing'));
        }
      }
      window.addEventListener('__gs_supabase_lib_ready', onReady);
      s.onerror = function () {
        if (done) return;
        done = true;
        reject(new Error('supabase_lib_load_failed'));
      };
      // Safety timeout — fall back to polling if CDN is unreachable.
      setTimeout(function () {
        if (done) return;
        if (window.__gs_supabase_client_factory) onReady();
        else { done = true; reject(new Error('supabase_lib_timeout')); }
      }, 8000);
      document.head.appendChild(s);
    });
    return loadingClientLib;
  }

  function noop() {}

  function createSupabaseDriver(ctx, resolved, hooks) {
    var client = null;
    var manuallyClosed = false;
    var subscribedConversation = null;
    var channels = {}; // channel name → realtime channel handle
    var connected = false;

    var capabilities = Object.assign({
      driver: 'supabase',
      supportsRealtime: true,
      // Supabase Broadcast doesn't give us native typing/presence with the
      // same shape Centrifugo offers; widget treats these as best-effort.
      supportsTyping: false,
      supportsPresence: false,
      supportsHistoryLoad: true,
      supportsReconnectSignals: true,
    }, resolved.capabilities || {});

    function log() {
      if (!ctx || !ctx._log) return;
      try { ctx._log.apply(null, arguments); } catch (_) {}
    }

    function buildChannel(cid) {
      return 'ws:' + ctx.workspaceId + ':conv:' + cid;
    }

    function setState(s) {
      if (hooks.onConnectionState) hooks.onConnectionState(s);
    }

    function ensureClient() {
      if (client) return Promise.resolve(client);
      var url = resolved.supabase_url;
      var key = resolved.anon_key;
      if (!url || !key) {
        return Promise.reject(new Error('supabase_config_missing'));
      }
      return loadSupabaseClient().then(function (createClient) {
        client = createClient(url, key, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
            // The host page may run the dashboard app (its own supabase-js).
            // A dedicated storage key + no-op lock keeps the two instances
            // from contending for the same Navigator LockManager lock.
            storageKey: 'gs-widget-no-auth',
            lock: function (_name, _timeout, fn) { return fn(); },
          },
          realtime: { params: { eventsPerSecond: 10 } },
        });
        return client;
      });
    }

    function unwrapPayload(msg) {
      // supabase-js delivers `{ payload: <whatever-was-sent> }`. Our server
      // publisher sends `{ type, event, payload: <envelope.payload> }`.
      // We accept both nested and flat shapes for forward-compat.
      if (!msg) return null;
      if (msg.payload && typeof msg.payload === 'object') {
        if (Object.prototype.hasOwnProperty.call(msg.payload, 'payload')) {
          return msg.payload.payload;
        }
        return msg.payload;
      }
      return msg;
    }

    function bindChannel(cid) {
      var name = buildChannel(cid);
      if (channels[name]) return;
      var ch = client.channel(name, { config: { broadcast: { self: false, ack: false } } });

      ch.on('broadcast', { event: 'message' }, function (msg) {
        var payload = unwrapPayload(msg);
        if (payload && hooks.onMessage) {
          hooks.onMessage({ channel: name, messages: [payload] });
        }
      });
      ch.on('broadcast', { event: 'typing' }, function (msg) {
        if (hooks.onTyping) hooks.onTyping({ channel: name, payload: unwrapPayload(msg) || {} });
      });
      ch.on('broadcast', { event: 'seen' }, function (msg) {
        // Re-emit as a message-level update so existing UI seen handler picks it up.
        var p = unwrapPayload(msg);
        if (p && hooks.onMessage) hooks.onMessage({ channel: name, messages: [p] });
      });

      // Phase 8B — operator-only `event` envelopes carry kind:'call:incoming'
      // for ringing the widget instantly. Every OTHER operator kind
      // (note_added, conversation_updated, …) is silently dropped — they have
      // no widget UI surface. Sidecar dispatch only; FSM untouched.
      ch.on('broadcast', { event: 'event' }, function (msg) {
        var p = unwrapPayload(msg);
        if (!p) return;
        try {
          if (p.kind === 'call:incoming') {
            if (window.__gs_call && typeof window.__gs_call.incoming === 'function') {
              window.__gs_call.incoming(p);
            } else if (window.__gs && typeof window.__gs.push === 'function') {
              window.__gs.push(['call:incoming', p]);
            }
          } else if (p.kind === 'call:ended') {
            // Pass A — server fan-out of operator/visitor hangup.
            if (window.__gs_call && typeof window.__gs_call.ended === 'function') {
              window.__gs_call.ended(p);
            }
          }
        } catch (_) {}
      });

      ch.subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          channels[name] = ch;
          if (!connected) {
            connected = true;
            setState('online');
            if (hooks.onReconnect) hooks.onReconnect();
          }
          // Fire subscribe-ack so the runtime FSM can complete
          // 'subscribing' → 'connected'. Mirrors centrifugo driver.
          if (hooks.onSubscribed) {
            try { hooks.onSubscribed({ channel: name }); } catch (_) {}
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          log('[rt:supabase] channel ' + name + ' status=' + status);
          delete channels[name];
          if (!manuallyClosed && status !== 'CLOSED') {
            // Soft-degrade — let the runtime escalate to polling fallback if
            // nothing recovers. supabase-js auto-reconnects internally for
            // transient drops, so we don't tear down the client here.
            setState('reconnecting');
          }
        }
      });
    }

    function unbindChannel(cid) {
      var name = buildChannel(cid);
      var ch = channels[name];
      if (!ch) return;
      try { client && client.removeChannel(ch); } catch (_) {}
      delete channels[name];
    }

    return {
      connect: function () {
        manuallyClosed = false;
        setState('connecting');
        ensureClient()
          .then(function () {
            // The realtime socket opens lazily on first subscribe — flag
            // online once a channel reaches SUBSCRIBED. If no conversation
            // exists yet, we stay in `connecting` until one is bound.
            if (subscribedConversation) bindChannel(subscribedConversation);
            else {
              // No active conversation yet — treat as ready so the UI
              // doesn't sit on "connecting" forever. Actual liveness is
              // proven on first channel SUBSCRIBED.
              setState('online');
            }
          })
          .catch(function (err) {
            log('[rt:supabase] connect failed', err && err.message);
            if (hooks.fallbackToPolling) hooks.fallbackToPolling('supabase_init_failed');
          });
      },
      disconnect: function () {
        manuallyClosed = true;
        var names = Object.keys(channels);
        for (var i = 0; i < names.length; i++) {
          try { client && client.removeChannel(channels[names[i]]); } catch (_) {}
        }
        channels = {};
        connected = false;
        if (client && client.realtime && client.realtime.disconnect) {
          try { client.realtime.disconnect(); } catch (_) {}
        }
        setState('idle');
      },
      subscribeConversation: function (cid) {
        if (!cid) return;
        subscribedConversation = cid;
        if (client) bindChannel(cid);
      },
      unsubscribeConversation: function (cid) {
        if (!cid) return;
        if (subscribedConversation === cid) subscribedConversation = null;
        if (client) unbindChannel(cid);
      },
      sendTyping: noop, // Best-effort no-op; widget UX doesn't depend on it.
      getCapabilities: function () {
        var copy = {};
        for (var k in capabilities) {
          if (Object.prototype.hasOwnProperty.call(capabilities, k)) copy[k] = capabilities[k];
        }
        return copy;
      },
      hasCapability: function (k) { return !!capabilities[k]; },
      getDriverName: function () { return 'supabase'; },
    };
  }

  window.__gs_mod_rt_supabase = { create: createSupabaseDriver };
})();
