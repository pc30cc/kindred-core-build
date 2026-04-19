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

  var SUPABASE_JS_URL = 'https://esm.sh/@supabase/supabase-js@2?bundle';
  var loadingClientLib = null;

  function loadSupabaseClient() {
    if (window.__gs_supabase_client_factory) {
      return Promise.resolve(window.__gs_supabase_client_factory);
    }
    if (loadingClientLib) return loadingClientLib;
    loadingClientLib = new Promise(function (resolve, reject) {
      // Use dynamic import via a module script — works in all evergreen browsers.
      var s = document.createElement('script');
      s.type = 'module';
      s.textContent =
        "import { createClient } from '" + SUPABASE_JS_URL + "';" +
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
          auth: { persistSession: false, autoRefreshToken: false },
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

      ch.subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          channels[name] = ch;
          if (!connected) {
            connected = true;
            setState('online');
            if (hooks.onReconnect) hooks.onReconnect();
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
