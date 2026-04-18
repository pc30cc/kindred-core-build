/**
 * Widget Module: Realtime — Centrifugo driver.
 *
 * Phase 3 drop-in: implements the SAME transport contract as the polling driver,
 * so runtime.js can switch drivers without touching UI modules.
 *
 * Contract:
 *   connect()
 *   disconnect()
 *   subscribeConversation(cid)
 *   unsubscribeConversation(cid)
 *   sendMessage(payload, hooks)        // still goes through REST (/api/widget/message)
 *   sendTyping({ conversationId })     // publishes ephemeral typing event over WS
 *   loadHistory({ onResult })          // REST (chat module)
 *   on(event, fn)                      // events: message | typing | presence | reconnect | connectionstate
 *   getCapabilities() / hasCapability(k)
 *
 * Security:
 *   - Browser NEVER receives the Centrifugo admin API key.
 *   - Backend issues short-lived HMAC connection token via /api/realtime/connect.
 *   - Backend issues per-channel subscription token via /api/realtime/subscribe.
 *   - Channels follow ws:{workspace_id}:conv:{conversation_id}.
 *
 * Strict drop-in. NEVER imported by UI modules directly.
 */
(function () {
  'use strict';

  function noop() {}

  /**
   * @param {Object} ctx        runtime context (apiBase, workspaceId, sessionToken, assetBase, _log)
   * @param {Object} resolved   server resolution payload (vendor, ws_url, token, capabilities, ...)
   * @param {Object} hooks      { onConnectionState, onMessage, onTyping, onPresence, onReconnect, fallbackToPolling }
   */
  function createCentrifugoDriver(ctx, resolved, hooks) {
    var ws = null;
    var manuallyClosed = false;
    var reconnectAttempt = 0;
    var reconnectTimer = null;
    var nextRpcId = 1;
    var pendingRpc = {}; // id → { resolve, reject }
    var subscribed = {}; // channel → true
    var subscribedConversation = null;
    var connectToken = resolved.token;
    var connectTokenExpiresAt = resolved.expires_at || 0;
    var wsUrl = resolved.ws_url;
    var capabilities = Object.assign({
      driver: 'centrifugo',
      supportsRealtime: true,
      supportsTyping: !!(resolved.public_config && resolved.public_config.typing_enabled),
      supportsPresence: !!(resolved.public_config && resolved.public_config.presence_enabled),
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

    function fetchSubToken(cid) {
      return fetch(ctx.apiBase + '/api/realtime/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Widget-Token': ctx.sessionToken || '' },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, conversation_id: cid }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.vendor !== 'centrifugo' || !data.token) return null;
          return { channel: data.channel, token: data.token };
        })
        .catch(function () { return null; });
    }

    function refreshConnectToken() {
      return fetch(ctx.apiBase + '/api/realtime/connect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Widget-Token': ctx.sessionToken || '' },
        body: JSON.stringify({ workspace_id: ctx.workspaceId }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.vendor === 'centrifugo' && data.token) {
            connectToken = data.token;
            connectTokenExpiresAt = data.expires_at || 0;
            wsUrl = data.ws_url || wsUrl;
            return true;
          }
          return false;
        })
        .catch(function () { return false; });
    }

    function send(obj) {
      if (!ws || ws.readyState !== 1) return false;
      try { ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
    }

    function rpc(method, params) {
      return new Promise(function (resolve, reject) {
        var id = nextRpcId++;
        pendingRpc[id] = { resolve: resolve, reject: reject };
        var ok = send({ id: id, method: method, params: params || {} });
        if (!ok) {
          delete pendingRpc[id];
          reject(new Error('socket_not_open'));
        }
      });
    }

    function handleFrame(frame) {
      // Centrifugo v5 protocol: { id?, push?, error? }
      if (frame.id && pendingRpc[frame.id]) {
        var p = pendingRpc[frame.id];
        delete pendingRpc[frame.id];
        if (frame.error) p.reject(frame.error);
        else p.resolve(frame.result || {});
        return;
      }
      if (frame.push) {
        var ch = frame.push.channel;
        var pub = frame.push.pub;
        var join = frame.push.join;
        var leave = frame.push.leave;
        if (pub && pub.data) {
          var data = pub.data;
          // Convention: { type: 'message'|'typing', payload: ... }
          if (data.type === 'message' && hooks.onMessage) {
            hooks.onMessage({ channel: ch, messages: [data.payload] });
          } else if (data.type === 'typing' && hooks.onTyping) {
            hooks.onTyping({ channel: ch, payload: data.payload });
          }
        }
        if ((join || leave) && hooks.onPresence) {
          hooks.onPresence({ channel: ch, join: join, leave: leave });
        }
      }
    }

    function setState(s) {
      if (hooks.onConnectionState) hooks.onConnectionState(s);
    }

    function scheduleReconnect() {
      if (manuallyClosed) return;
      reconnectAttempt += 1;
      var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempt, 5)));
      setState('reconnecting');
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        openSocket();
      }, delay);
    }

    function openSocket() {
      if (!wsUrl || !connectToken) {
        log('[rt:centrifugo] missing url/token → fallback to polling');
        if (hooks.fallbackToPolling) hooks.fallbackToPolling('no_token');
        return;
      }
      if (typeof WebSocket === 'undefined') {
        if (hooks.fallbackToPolling) hooks.fallbackToPolling('no_websocket');
        return;
      }
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        log('[rt:centrifugo] WS construct failed', e);
        scheduleReconnect();
        return;
      }
      setState('connecting');

      ws.onopen = function () {
        // Connect frame (Centrifugo v5 client RPC).
        rpc('connect', { token: connectToken })
          .then(function () {
            reconnectAttempt = 0;
            setState('online');
            if (hooks.onReconnect && reconnectAttempt === 0) {
              // Re-subscribe to last known conversation if any.
              if (subscribedConversation) doSubscribe(subscribedConversation);
            }
          })
          .catch(function (err) {
            log('[rt:centrifugo] connect rejected', err);
            try { ws.close(); } catch (_) {}
          });
      };

      ws.onmessage = function (ev) {
        var raw = ev.data;
        // Centrifugo can batch with newlines.
        var lines = String(raw || '').split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line) continue;
          try { handleFrame(JSON.parse(line)); } catch (_) {}
        }
      };

      ws.onclose = function () {
        ws = null;
        if (manuallyClosed) { setState('idle'); return; }
        // Token might have expired — refresh on next attempt.
        if (Date.now() > connectTokenExpiresAt - 5000) {
          refreshConnectToken().then(scheduleReconnect);
        } else {
          scheduleReconnect();
        }
      };

      ws.onerror = function () {
        // Let onclose drive the state; just log here.
        log('[rt:centrifugo] socket error');
      };
    }

    function doSubscribe(cid) {
      var channel = buildChannel(cid);
      if (subscribed[channel]) return;
      fetchSubToken(cid).then(function (tk) {
        if (!tk || !ws || ws.readyState !== 1) return;
        rpc('subscribe', { channel: tk.channel || channel, token: tk.token })
          .then(function () { subscribed[tk.channel || channel] = true; })
          .catch(function (err) { log('[rt:centrifugo] subscribe failed', err); });
      });
    }

    function doUnsubscribe(cid) {
      var channel = buildChannel(cid);
      if (!subscribed[channel]) return;
      rpc('unsubscribe', { channel: channel })
        .then(function () { delete subscribed[channel]; })
        .catch(noop);
    }

    return {
      connect: function () {
        manuallyClosed = false;
        openSocket();
      },
      disconnect: function () {
        manuallyClosed = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) { try { ws.close(); } catch (_) {} ws = null; }
        setState('idle');
      },
      subscribeConversation: function (cid) {
        if (!cid) return;
        subscribedConversation = cid;
        if (ws && ws.readyState === 1) doSubscribe(cid);
      },
      unsubscribeConversation: function (cid) {
        if (!cid) return;
        if (subscribedConversation === cid) subscribedConversation = null;
        if (ws && ws.readyState === 1) doUnsubscribe(cid);
      },
      sendTyping: function (payload) {
        if (!capabilities.supportsTyping) return;
        if (!payload || !payload.conversationId) return;
        var channel = buildChannel(payload.conversationId);
        // Centrifugo v5 client publish (server-side allow_publish must be enabled,
        // OR server proxies typing). We attempt publish; failures are silent.
        send({ id: nextRpcId++, method: 'publish', params: {
          channel: channel,
          data: { type: 'typing', payload: { ts: Date.now() } },
        }});
      },
      getCapabilities: function () {
        var copy = {};
        for (var k in capabilities) {
          if (Object.prototype.hasOwnProperty.call(capabilities, k)) copy[k] = capabilities[k];
        }
        return copy;
      },
      hasCapability: function (k) { return !!capabilities[k]; },
      getDriverName: function () { return 'centrifugo'; },
    };
  }

  window.__gs_mod_rt_centrifugo = { create: createCentrifugoDriver };
})();
