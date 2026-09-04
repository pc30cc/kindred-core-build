/**
 * Widget Module: Realtime — Centrifugo driver (v5 bidirectional JSON protocol).
 *
 * Speaks the official Centrifugo v5 client protocol over a raw WebSocket,
 * WITHOUT pulling in centrifuge-js. Frame shape is field-based, NOT
 * `{method, params}` RPC. That earlier RPC shape caused Centrifugo to reply
 * with `bad request` and immediately disconnect, producing the reconnect loop.
 *
 * Protocol summary (JSON, one command per line, '\n'-delimited batches):
 *
 *   Connect:
 *     → { "id": 1, "connect": { "token": "<JWT>", "name": "widget" } }
 *     ← { "id": 1, "connect": { "client": "...", "version": "...", "ttl": 600 } }
 *
 *   Subscribe (private channel needs a sub token):
 *     → { "id": 2, "subscribe": { "channel": "ws:<ws>:conv:<cid>", "token": "<JWT>" } }
 *     ← { "id": 2, "subscribe": { "recoverable": false, ... } }
 *
 *   Unsubscribe:
 *     → { "id": 3, "unsubscribe": { "channel": "ws:<ws>:conv:<cid>" } }
 *
 *   Publish (only if server allow_publish=true on namespace):
 *     → { "id": 4, "publish": { "channel": "...", "data": { ... } } }
 *
 *   Ping (server → client): { } (empty object). Client replies with { }.
 *
 *   Push (server → client):
 *     ← { "push": { "channel": "...", "pub": { "data": { ... } } } }
 *     ← { "push": { "channel": "...", "join": { "info": { ... } } } }
 *     ← { "push": { "channel": "...", "leave": { "info": { ... } } } }
 *
 * Application convention for our own payloads (set by backend `publish`):
 *   { "type": "message" | "typing", "payload": { ... } }
 *
 * Security:
 *   - Browser NEVER receives the Centrifugo admin API key.
 *   - Backend issues the connection token via /api/realtime/connect.
 *   - Backend issues per-channel subscription tokens via /api/realtime/subscribe.
 *
 * Strict drop-in for the runtime transport contract:
 *   connect / disconnect / subscribeConversation / unsubscribeConversation
 *   sendTyping / getCapabilities / hasCapability / getDriverName
 */
(function () {
  'use strict';

  function noop() {}

  function createCentrifugoDriver(ctx, resolved, hooks) {
    var ws = null;
    var manuallyClosed = false;
    var reconnectAttempt = 0;
    var reconnectTimer = null;
    var pingTimer = null;
    var nextCmdId = 1;
    var pending = {};                 // id → { resolve, reject, timeout }
    var subscribedChannels = {};      // channel → true
    var subscribedConversation = null;
    var connectToken = resolved.token;
    var connectTokenExpiresAt = resolved.expires_at || 0;
    var wsUrl = resolved.ws_url;
    var clientId = null;
    /**
     * `firstConnectDone` flips to true the FIRST time the Centrifugo
     * `connect` reply lands. Without it, the very first successful
     * connect would fire `hooks.onReconnect()` — which the runtime
     * transport treats as a real reconnect and re-runs `bootstrapHistory`,
     * producing the duplicate "transport reconnect — refreshing history"
     * log on a healthy first load AND racing with the initial subscribe.
     *
     * Semantics: `onReconnect` MUST mean "we were connected, dropped, and
     * came back". It must NOT fire on initial connect.
     */
    var firstConnectDone = false;

    var capabilities = Object.assign({
      driver: 'centrifugo',
      supportsRealtime: true,
      supportsTyping: !!(resolved.public_config && resolved.public_config.typing_enabled),
      supportsPresence: !!(resolved.public_config && resolved.public_config.presence_enabled),
      supportsHistoryLoad: true,
      supportsReconnectSignals: true,
      // Whether the widget is allowed to publish directly into the
      // conversation channel from the browser. Defaults to false because
      // our standard Centrifugo namespace is consume-only for visitors
      // (publish goes through the backend). Without this guard, the widget
      // emits `command('publish', ...)` for every keystroke and Centrifugo
      // floods server logs with code 103 "insufficient permission".
      // Backend can opt-in by setting `public_config.allow_client_publish`.
      allowClientPublish: !!(resolved.public_config && resolved.public_config.allow_client_publish),
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

    // ── Backend token endpoints ─────────────────────────────────────────
    function fetchSubToken(cid) {
      return fetch(ctx.apiBase + '/api/realtime/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Widget-Token': ctx.sessionToken || '' },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, conversation_id: cid }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || data.vendor !== 'centrifugo' || !data.token) return null;
          return { channel: data.channel || buildChannel(cid), token: data.token };
        })
        .catch(function () { return null; });
    }

    // intent: 'initial' (no token yet — see connect() below) or 'reconnect'
    // (scheduleReconnect, which only fires after ws.onclose — a real drop).
    function refreshConnectToken(intent) {
      return fetch(ctx.apiBase + '/api/realtime/connect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Widget-Token': ctx.sessionToken || '' },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, intent: intent || 'initial' }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.vendor === 'centrifugo' && data.token) {
            connectToken = data.token;
            connectTokenExpiresAt = data.expires_at || 0;
            wsUrl = data.ws_url || wsUrl;
            return true;
          }
          return false;
        })
        .catch(function () { return false; });
    }

    // ── Wire send (one JSON object per frame; Centrifugo accepts both
    //    single-frame and '\n'-delimited batches) ────────────────────────
    function rawSend(obj) {
      if (!ws || ws.readyState !== 1) return false;
      try { ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
    }

    /**
     * Send a Centrifugo command using the v5 field-based shape.
     *   commandKey: 'connect' | 'subscribe' | 'unsubscribe' | 'publish' | 'ping' | ...
     *   commandBody: command-specific object
     * Returns a Promise resolving with the matching reply body or rejecting on error.
     */
    function command(commandKey, commandBody, opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        var id = nextCmdId++;
        var frame = { id: id };
        frame[commandKey] = commandBody || {};
        var timeout = setTimeout(function () {
          if (pending[id]) {
            delete pending[id];
            reject(new Error(commandKey + '_timeout'));
          }
        }, opts.timeoutMs || 8000);
        pending[id] = {
          key: commandKey,
          resolve: function (v) { clearTimeout(timeout); resolve(v); },
          reject: function (e) { clearTimeout(timeout); reject(e); },
        };
        if (!rawSend(frame)) {
          clearTimeout(timeout);
          delete pending[id];
          reject(new Error('socket_not_open'));
        }
      });
    }

    // ── Frame handling ──────────────────────────────────────────────────
    function handleFrame(frame) {
      if (!frame || typeof frame !== 'object') return;

      // Server ping is an empty object {}. Reply with empty object.
      if (!frame.id && !frame.push && !frame.error) {
        // Treat any non-id, non-push frame as ping/keepalive.
        rawSend({});
        return;
      }

      // Reply to a previous command.
      if (frame.id && pending[frame.id]) {
        var p = pending[frame.id];
        delete pending[frame.id];
        if (frame.error) {
          p.reject(frame.error);
        } else {
          // Reply body lives under the same key as the command, e.g. frame.connect, frame.subscribe.
          var body = frame[p.key] || {};
          p.resolve(body);
        }
        return;
      }

      // Server push.
      if (frame.push) {
        var ch = frame.push.channel;
        var pub = frame.push.pub;
        var join = frame.push.join;
        var leave = frame.push.leave;
        var disconnect = frame.push.disconnect;

        if (pub && pub.data) {
          var data = pub.data;
          // Phase 5 — operator-only `event` envelopes (kind: conversation_updated,
          // note_added, etc.) are published to per-conversation channels for the
          // Inbox UI. The widget MUST ignore them: notes/timeline are private
          // and these envelopes have no widget-facing meaning. Defensive guard
          // so future operator-only types remain forward-safe.
          if (data && data.type === 'event') {
            // Phase 8B — `call:incoming` is the ONE event-kind the widget cares
            // about. Every other operator-only kind (conversation_updated,
            // note_added, …) is silently dropped. The call dispatch is a
            // sidecar — it does NOT touch the chat FSM or transport store.
            try {
              var p = data.payload;
              if (p && p.kind === 'call:incoming' && window.__gs_call && typeof window.__gs_call.incoming === 'function') {
                window.__gs_call.incoming(p);
              } else if (p && p.kind === 'call:incoming' && window.__gs && typeof window.__gs.push === 'function') {
                // Module not yet loaded — queue via the loader's command bus.
                window.__gs.push(['call:incoming', p]);
              }
              // Pass A — server-pushed call:ended → close the visitor's
              // call surface and append a local "Operator ended the call"
              // system message. Sidecar dispatch only.
              if (p && p.kind === 'call:ended' && window.__gs_call && typeof window.__gs_call.ended === 'function') {
                window.__gs_call.ended(p);
              }
            } catch (_) {}
          } else if (data && data.type === 'message' && hooks.onMessage) {
            hooks.onMessage({ channel: ch, messages: [data.payload] });
          } else if (data && data.type === 'typing' && hooks.onTyping) {
            hooks.onTyping({ channel: ch, payload: data.payload });
          } else if (data && data.type === 'call:incoming') {
            // Forward-safe: legacy publishers may emit the call envelope at
            // the top level instead of nested under `event`. Same dispatch.
            try {
              var p2 = data.payload || data;
              if (window.__gs_call && typeof window.__gs_call.incoming === 'function') {
                window.__gs_call.incoming(p2);
              } else if (window.__gs && typeof window.__gs.push === 'function') {
                window.__gs.push(['call:incoming', p2]);
              }
            } catch (_) {}
          }
        }
        if ((join || leave) && hooks.onPresence) {
          hooks.onPresence({ channel: ch, join: join, leave: leave });
        }
        if (disconnect) {
          log('[rt:centrifugo] server disconnect push', disconnect);
        }
      }
    }

    // ── Reconnect ───────────────────────────────────────────────────────
    function scheduleReconnect() {
      if (manuallyClosed) return;
      reconnectAttempt += 1;
      var baseDelay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempt, 5)));
      // Phase 6C — apply the effective policy reconnect backoff multiplier
      // so admins can stretch reconnect spacing during overload events.
      // Hard-cap at 60s (2x baseline) so a misconfigured multiplier can
      // never produce minute-scale stalls. Preserve the existing jitter
      // style by adding ±15% randomness to avoid synchronized retries.
      var mult = 1;
      try {
        var p = (typeof window !== 'undefined') ? window.__gs_policy : null;
        var raw = p && Number(p.reconnect_backoff_multiplier);
        if (isFinite(raw) && raw >= 1 && raw <= 10) mult = raw;
      } catch (_) {}
      var scaled = Math.min(60000, baseDelay * mult);
      var jitter = Math.round(scaled * (0.85 + Math.random() * 0.30));
      var delay = Math.max(0, jitter);
      setState('reconnecting');
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        // Decide whether we MUST re-negotiate before opening a new socket.
        // We don't trust the local `connectTokenExpiresAt` alone — server
        // clock skew or a previous server-side rejection of our token can
        // leave us with a "locally fresh" but server-rejected token, which
        // would loop forever. Force a refresh when:
        //   1) we have no token, OR
        //   2) the token is at/near expiry by our clock (60s lead), OR
        //   3) we've already failed to (re)open the socket at least once
        //      (reconnectAttempt > 1) — the previous failure was almost
        //      certainly a token issue at the server.
        var localExpired = !connectToken || Date.now() > (connectTokenExpiresAt - 60000);
        var mustRefreshDueToFailure = reconnectAttempt > 1;
        if (localExpired || mustRefreshDueToFailure) {
          refreshConnectToken('reconnect').then(function (ok) {
            if (!ok) {
              log('[rt:centrifugo] token refresh failed; will retry');
              scheduleReconnect();
              return;
            }
            openSocket();
          });
        } else {
          openSocket();
        }
      }, delay);
    }

    function rejectAllPending(reason) {
      var ids = Object.keys(pending);
      for (var i = 0; i < ids.length; i++) {
        try { pending[ids[i]].reject(new Error(reason || 'socket_closed')); } catch (_) {}
      }
      pending = {};
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
        // v5 connect frame — field-based, NOT {method,params}.
        command('connect', { token: connectToken, name: 'widget' }, { timeoutMs: 10000 })
          .then(function (reply) {
            clientId = (reply && reply.client) || null;
            reconnectAttempt = 0;
            setState('online');
            // Re-subscribe to the active conversation if any.
            if (subscribedConversation) doSubscribe(subscribedConversation);
            // ONLY fire onReconnect on a real reconnect, never on the
            // first successful connect. The transport layer interprets
            // onReconnect → re-run bootstrapHistory; if we fire it on
            // initial connect we get a redundant history fetch racing
            // with the boot-sequence one (and the visible duplicate
            // "transport reconnect — refreshing history" log).
            if (firstConnectDone) {
              if (hooks.onReconnect) hooks.onReconnect();
            } else {
              firstConnectDone = true;
            }
          })
          .catch(function (err) {
            log('[rt:centrifugo] connect rejected', err);
            // If server rejected our token (code 109 / message contains
            // "expired"/"token"), invalidate the local expiry so the next
            // reconnect cycle ALWAYS fetches a fresh one.
            var msg = (err && (err.message || err.reason)) || '';
            var code = err && err.code;
            if (code === 109 || /token|expired|unauthorized/i.test(String(msg))) {
              connectTokenExpiresAt = 0;
              connectToken = '';
            }
            try { ws.close(); } catch (_) {}
          });
      };

      ws.onmessage = function (ev) {
        var raw = ev.data;
        // Centrifugo can batch frames separated by '\n'.
        var lines = String(raw == null ? '' : raw).split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line) continue;
          var parsed = null;
          try { parsed = JSON.parse(line); } catch (_) { continue; }
          handleFrame(parsed);
        }
      };

      ws.onclose = function () {
        ws = null;
        clientId = null;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        rejectAllPending('socket_closed');
        // Forget channel subscription state — Centrifugo requires re-subscribe after reconnect.
        subscribedChannels = {};
        if (manuallyClosed) { setState('idle'); return; }
        scheduleReconnect();
      };

      ws.onerror = function () {
        log('[rt:centrifugo] socket error');
      };
    }

    // ── Subscriptions ───────────────────────────────────────────────────
    function doSubscribe(cid) {
      var fallbackChannel = buildChannel(cid);
      if (subscribedChannels[fallbackChannel]) return;
      fetchSubToken(cid).then(function (tk) {
        if (!tk || !ws || ws.readyState !== 1) return;
        var channel = tk.channel || fallbackChannel;
        if (subscribedChannels[channel]) return;
        command('subscribe', { channel: channel, token: tk.token }, { timeoutMs: 8000 })
          .then(function () {
            subscribedChannels[channel] = true;
            // Fire the subscribe-ack hook so the runtime FSM can transition
            // 'subscribing' → 'connected'. Without this signal the widget
            // stays in 'subscribing' forever after refresh, leaving the
            // composer non-sendable even though incoming pushes work.
            if (hooks.onSubscribed) {
              try { hooks.onSubscribed({ channel: channel, conversationId: cid }); } catch (_) {}
            }
          })
          .catch(function (err) { log('[rt:centrifugo] subscribe failed', channel, err); });
      });
    }

    function doUnsubscribe(cid) {
      var channel = buildChannel(cid);
      if (!subscribedChannels[channel]) return;
      command('unsubscribe', { channel: channel })
        .then(function () { delete subscribedChannels[channel]; })
        .catch(noop);
    }

    return {
      connect: function () {
        manuallyClosed = false;
        // If we have no token yet (resolver gave one already, but be defensive), fetch one.
        if (!connectToken) {
          refreshConnectToken('initial').then(openSocket);
        } else {
          openSocket();
        }
      },
      disconnect: function () {
        manuallyClosed = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        rejectAllPending('manual_disconnect');
        subscribedChannels = {};
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
        // Backend-mediated typing is the default. Skip the direct publish
        // attempt entirely unless the namespace explicitly allows it —
        // otherwise Centrifugo logs `attempt to publish without
        // sufficient permission (code 103)` for every keystroke.
        if (!capabilities.allowClientPublish) return;
        if (!payload || !payload.conversationId) return;
        if (!ws || ws.readyState !== 1) return;
        var channel = buildChannel(payload.conversationId);
        // Field-based publish frame. Will be rejected silently if namespace
        // doesn't have allow_publish — that's fine, typing is best-effort.
        command('publish', {
          channel: channel,
          data: { type: 'typing', payload: { ts: Date.now() } },
        }, { timeoutMs: 3000 }).catch(noop);
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
