/**
 * Widget Call Module - Phase 8B (incoming-only).
 *
 * Bounded, isolated module layered on top of the widget runtime. It is
 * incoming-only: visitors NEVER initiate calls in this phase. The module
 * exposes a single entry point on the widget global so the runtime (or a
 * future realtime channel handler) can deliver an incoming-call signal:
 *
 *     window.__gs.push(['call:incoming', {
 *       call_id, call_type, ws_url, token,
 *       turn: { urls, username, credential },
 *       ice_policy, recording, operator_name
 *     }]);
 *
 * Strict rules:
 *   - Does NOT touch widget FSM, transport, identity, or chat stores.
 *   - Does NOT mint tokens. Token + ws_url + TURN MUST be supplied by the
 *     backend (resolver-backed). No URL is hardcoded here.
 *   - Loads the LiveKit client on demand so chat-only widgets stay slim.
 *   - Hosts its own UI inside a fresh shadow root so widget styling never
 *     bleeds in either direction.
 */
(function () {
  'use strict';
  if (window.__gs_call_loaded) return;
  window.__gs_call_loaded = true;

  // CDN fallback. Self-hosters can override via window.__gs_call_sdk_url.
  var LIVEKIT_SDK_URL = (window && window.__gs_call_sdk_url)
    || 'https://cdn.jsdelivr.net/npm/livekit-client@2.5.0/dist/livekit-client.umd.min.js';

  var sdkPromise = null;
  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = LIVEKIT_SDK_URL;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = function () {
        if (window.LivekitClient) resolve(window.LivekitClient);
        else reject(new Error('LiveKit SDK loaded but global missing'));
      };
      s.onerror = function () { reject(new Error('Failed to load LiveKit SDK')); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  // ───── UI shell (its own shadow root) ─────
  var hostEl = null;
  var shadow = null;
  var rootEl = null;
  var audioEl = null;
  var videoEl = null;
  var statusEl = null;
  var btnAccept = null;
  var btnReject = null;
  var btnMic = null;
  var btnCam = null;
  var btnHangup = null;
  var degradedEl = null;

  function ensureShell() {
    if (hostEl) return;
    hostEl = document.createElement('div');
    hostEl.setAttribute('data-gs-call-host', '');
    hostEl.style.cssText = 'all:initial;position:fixed;inset:auto 16px 16px auto;z-index:2147483646;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = [
      ':host,*{box-sizing:border-box}',
      '.card{font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 32px -8px rgba(0,0,0,.18);width:300px;padding:14px;display:none}',
      '.card.show{display:block}',
      '@media (prefers-color-scheme: dark){.card{background:#0f172a;color:#f1f5f9;border-color:#1e293b}}',
      '.title{font-weight:600;font-size:14px;margin:0 0 4px}',
      '.sub{color:#64748b;font-size:12px;margin:0 0 10px}',
      '.row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}',
      '.btn{flex:1;min-width:80px;border:0;border-radius:8px;padding:9px 10px;font-weight:600;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}',
      '.btn.primary{background:#16a34a;color:#fff}',
      '.btn.primary:hover{background:#15803d}',
      '.btn.danger{background:#dc2626;color:#fff}',
      '.btn.danger:hover{background:#b91c1c}',
      '.btn.ghost{background:#f1f5f9;color:#0f172a}',
      '.btn.ghost:hover{background:#e2e8f0}',
      '.btn.ghost.off{background:#fee2e2;color:#991b1b}',
      '.btn:disabled{opacity:.6;cursor:not-allowed}',
      '@media (prefers-color-scheme: dark){.btn.ghost{background:#1e293b;color:#f1f5f9}.btn.ghost:hover{background:#334155}}',
      '.dot{width:8px;height:8px;border-radius:50%;background:#16a34a;display:inline-block;margin-right:6px;animation:pulse 1.4s infinite}',
      '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      'video{width:100%;max-height:200px;border-radius:8px;background:#000;margin-top:8px;display:none}',
      'video.show{display:block}',
      '.status{font-size:11px;color:#64748b;margin-top:6px}',
      '.degraded{font-size:11px;color:#b45309;background:#fef3c7;border-radius:6px;padding:6px 8px;margin-top:6px;display:none}',
      '.degraded.show{display:block}',
      '.cbfield{display:flex;flex-direction:column;gap:3px;margin-top:8px}',
      '.cblabel{font-size:11px;color:#64748b;font-weight:500}',
      '.cbinput{width:100%;border:1px solid #e2e8f0;border-radius:6px;padding:7px 9px;font:inherit;color:inherit;background:transparent;outline:none}',
      '.cbinput:focus{border-color:#16a34a}',
      '.cbinput.invalid{border-color:#dc2626}',
      '@media (prefers-color-scheme: dark){.cbinput{border-color:#1e293b}}',
      '.cbnote{resize:vertical;min-height:48px;max-height:120px;font-family:inherit}',
      '.cberr{font-size:11px;color:#dc2626;margin-top:4px;display:none}',
      '.cberr.show{display:block}',
    ].join('');
    shadow.appendChild(style);

    rootEl = document.createElement('div');
    rootEl.className = 'card';
    rootEl.setAttribute('role', 'dialog');
    rootEl.setAttribute('aria-label', 'Incoming call');
    rootEl.innerHTML = [
      '<p class="title" data-el="title">Incoming call</p>',
      '<p class="sub" data-el="sub">Audio call from support</p>',
      '<div class="degraded" data-el="degraded">Audio-only mode (network limited)</div>',
      '<video data-el="video" autoplay playsinline></video>',
      '<audio data-el="audio" autoplay></audio>',
      '<div class="row" data-el="ring-row">',
      '  <button class="btn primary" data-el="accept" type="button">Answer</button>',
      '  <button class="btn danger" data-el="reject" type="button">Decline</button>',
      '</div>',
      '<div class="row" data-el="call-row" style="display:none">',
      '  <button class="btn ghost" data-el="mic" type="button" aria-label="Toggle microphone">Mic</button>',
      '  <button class="btn ghost" data-el="cam" type="button" aria-label="Toggle camera">Cam</button>',
      '  <button class="btn danger" data-el="hangup" type="button" aria-label="Hang up">End</button>',
      '</div>',
      '<div class="row" data-el="callback-row" style="display:none">',
      '  <button class="btn ghost" data-el="callback" type="button">Request callback</button>',
      '</div>',
      '<div data-el="callback-modal" style="display:none">',
      '  <div class="cbfield"><label class="cblabel" data-el="cb-phone-label">Phone (optional)</label><input class="cbinput" data-el="cb-phone" type="tel" autocomplete="tel" placeholder="+1 555 123 4567" /></div>',
      '  <div class="cbfield"><label class="cblabel" data-el="cb-email-label">Email (optional)</label><input class="cbinput" data-el="cb-email" type="email" autocomplete="email" placeholder="you@example.com" /></div>',
      '  <div class="cbfield"><label class="cblabel">Note (optional)</label><textarea class="cbinput cbnote" data-el="cb-notes" rows="2" placeholder="Anything we should know?"></textarea></div>',
      '  <div class="cberr" data-el="cb-error"></div>',
      '  <div class="row" style="margin-top:10px"><button class="btn primary" data-el="cb-submit" type="button">Request callback</button><button class="btn ghost" data-el="cb-cancel" type="button">Cancel</button></div>',
      '</div>',
      '<p class="status" data-el="status"></p>',
    ].join('');
    shadow.appendChild(rootEl);
    document.body.appendChild(hostEl);

    audioEl = rootEl.querySelector('[data-el="audio"]');
    videoEl = rootEl.querySelector('[data-el="video"]');
    statusEl = rootEl.querySelector('[data-el="status"]');
    btnAccept = rootEl.querySelector('[data-el="accept"]');
    btnReject = rootEl.querySelector('[data-el="reject"]');
    btnMic = rootEl.querySelector('[data-el="mic"]');
    btnCam = rootEl.querySelector('[data-el="cam"]');
    btnHangup = rootEl.querySelector('[data-el="hangup"]');
    degradedEl = rootEl.querySelector('[data-el="degraded"]');
  }

  function show() { ensureShell(); rootEl.classList.add('show'); }
  function hide() { if (rootEl) rootEl.classList.remove('show'); }
  function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }
  function setRingingMode() {
    if (!rootEl) return;
    rootEl.querySelector('[data-el="ring-row"]').style.display = 'flex';
    rootEl.querySelector('[data-el="call-row"]').style.display = 'none';
    if (videoEl) videoEl.classList.remove('show');
  }
  function setInCallMode(isVideo) {
    if (!rootEl) return;
    rootEl.querySelector('[data-el="ring-row"]').style.display = 'none';
    rootEl.querySelector('[data-el="call-row"]').style.display = 'flex';
    if (videoEl) videoEl.classList[isVideo ? 'add' : 'remove']('show');
  }

  // ───── Single active call state ─────
  var current = null; // { invite, room, micEnabled, camEnabled }
  var lastDispatchedCallId = null; // dedupe poll-mode dispatch
  // Phase 8D+ — Callback request guard (in-memory).
  var isSubmittingCallback = false;
  var lastCallbackSubmitTs = 0;
  var callbackRequestedFlag = false;

  // Resolve widget context (workspace, apiBase, identity) from globals the
  // loader/runtime expose. Polling fallback uses these to fetch a visitor
  // token. Never throws — callers must tolerate nulls.
  function getWidgetCtx() {
    try {
      var gs = window.__gs || {};
      var workspaceId = gs._id || null;
      var apiBase = gs._api || (window.__gs_config && window.__gs_config._apiBase) || '';
      var token = (window.__gs_token && window.__gs_token.get && window.__gs_token.get()) || '';
      var ident = (window.__gs_identity || {});
      return {
        workspaceId: workspaceId,
        apiBase: apiBase,
        token: token,
        visitorId: ident.visitorId || null,
        sessionId: ident.sessionId || null,
      };
    } catch (_) { return { workspaceId: null, apiBase: '', token: '', visitorId: null, sessionId: null }; }
  }

  function fetchVisitorToken(callId, ctx) {
    if (!ctx.apiBase || !ctx.workspaceId || !ctx.token) {
      return Promise.reject(new Error('widget context not ready'));
    }
    return fetch(ctx.apiBase + '/api/widget/calls/' + encodeURIComponent(callId) + '/visitor-token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Widget-Token': ctx.token },
      body: JSON.stringify({
        workspace_id: ctx.workspaceId,
        visitor_id: ctx.visitorId || undefined,
        session_id: ctx.sessionId || undefined,
      }),
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) {
        throw new Error(b.error || 'visitor_token_http_' + r.status);
      });
      return r.json();
    });
  }

  function attachRemote(room, LK) {
    function refresh() {
      var firstAudio = null, firstVideo = null;
      room.remoteParticipants.forEach(function (p) {
        p.trackPublications.forEach(function (pub) {
          if (!pub.track || !pub.track.mediaStreamTrack) return;
          if (pub.kind === LK.Track.Kind.Audio && !firstAudio) firstAudio = pub.track.mediaStreamTrack;
          if (pub.kind === LK.Track.Kind.Video && !firstVideo) firstVideo = pub.track.mediaStreamTrack;
        });
      });
      if (audioEl) {
        audioEl.srcObject = firstAudio ? new MediaStream([firstAudio]) : null;
        if (firstAudio) { try { audioEl.play(); } catch (_) {} }
      }
      if (videoEl) {
        videoEl.srcObject = firstVideo ? new MediaStream([firstVideo]) : null;
        if (firstVideo) { try { videoEl.play(); } catch (_) {} }
      }
    }
    room
      .on(LK.RoomEvent.ParticipantConnected, refresh)
      .on(LK.RoomEvent.ParticipantDisconnected, refresh)
      .on(LK.RoomEvent.TrackSubscribed, refresh)
      .on(LK.RoomEvent.TrackUnsubscribed, refresh)
      .on(LK.RoomEvent.Reconnecting, function () { setStatus('Reconnecting...'); })
      .on(LK.RoomEvent.Reconnected, function () { setStatus(''); })
      .on(LK.RoomEvent.Disconnected, function () { teardown('remote'); });
    refresh();
  }

  function teardown(reason) {
    if (current && current.room) {
      try { current.room.disconnect(); } catch (_) {}
    }
    current = null;
    setStatus(reason === 'remote' ? 'Call ended' : '');
    setRingingMode();
    if (audioEl) audioEl.srcObject = null;
    if (videoEl) videoEl.srcObject = null;
    if (degradedEl) degradedEl.classList.remove('show');
    setTimeout(hide, 600);
  }

  function reject() {
    teardown('reject');
  }

  function accept() {
    if (!current || !current.invite) return;
    var invite = current.invite;
    setStatus('Connecting...');
    btnAccept.disabled = true;
    btnReject.disabled = true;
    loadSdk().then(function (LK) {
      var iceServers = [];
      if (invite.turn && invite.turn.urls && invite.turn.urls.length) {
        iceServers.push({
          urls: invite.turn.urls,
          username: invite.turn.username || undefined,
          credential: invite.turn.credential || undefined,
        });
      }
      var room = new LK.Room({ adaptiveStream: true, dynacast: true });
      current.room = room;
      attachRemote(room, LK);
      var connectOpts = iceServers.length ? {
        rtcConfig: {
          iceServers: iceServers,
          iceTransportPolicy: invite.ice_policy === 'relay' ? 'relay' : 'all',
        },
      } : undefined;
      return room.connect(invite.ws_url, invite.token, connectOpts).then(function () {
        setStatus('');
        return room.localParticipant.setMicrophoneEnabled(true).then(function () {
          current.micEnabled = true;
          btnMic.textContent = 'Mute';
          btnMic.classList.remove('off');
          var isVideo = invite.call_type === 'video';
          setInCallMode(isVideo);
          if (isVideo) {
            return room.localParticipant.setCameraEnabled(true).then(function () {
              current.camEnabled = true;
              btnCam.textContent = 'Stop cam';
              btnCam.classList.remove('off');
            });
          }
        });
      });
    }).catch(function (err) {
      setStatus('Could not join: ' + (err && err.message ? err.message : 'unknown'));
      btnAccept.disabled = false;
      btnReject.disabled = false;
      teardown('error');
    });
  }

  function toggleMic() {
    if (!current || !current.room) return;
    var room = current.room;
    var next = !room.localParticipant.isMicrophoneEnabled;
    room.localParticipant.setMicrophoneEnabled(next).then(function () {
      current.micEnabled = next;
      btnMic.textContent = next ? 'Mute' : 'Unmute';
      btnMic.classList[next ? 'remove' : 'add']('off');
    });
  }

  function toggleCam() {
    if (!current || !current.room) return;
    var room = current.room;
    var next = !room.localParticipant.isCameraEnabled;
    room.localParticipant.setCameraEnabled(next).then(function () {
      current.camEnabled = next;
      btnCam.textContent = next ? 'Stop cam' : 'Start cam';
      btnCam.classList[next ? 'remove' : 'add']('off');
    });
  }

  function hangup() {
    teardown('local');
  }

  function bindHandlersOnce() {
    if (btnAccept.__bound) return;
    btnAccept.__bound = true;
    btnAccept.addEventListener('click', accept);
    btnReject.addEventListener('click', reject);
    btnMic.addEventListener('click', toggleMic);
    btnCam.addEventListener('click', toggleCam);
    btnHangup.addEventListener('click', hangup);
  }

  function showIncoming(invite) {
    if (!invite || !invite.token || !invite.ws_url) {
      // Polling-mode invites arrive without token/ws_url. If we have a
      // call_id, try to mint the visitor token before showing the popup.
      if (invite && invite.call_id) {
        if (lastDispatchedCallId === invite.call_id) return; // dedupe
        lastDispatchedCallId = invite.call_id;
        var ctx = getWidgetCtx();
        fetchVisitorToken(invite.call_id, ctx).then(function (bundle) {
          showIncoming({
            call_id: invite.call_id,
            call_type: bundle.call_type || invite.call_type || 'audio',
            operator_name: invite.operator_name || null,
            ws_url: bundle.ws_url,
            token: bundle.token,
            turn: bundle.turn || { urls: [] },
            ice_policy: bundle.ice_policy || 'all',
            recording: !!bundle.recording,
            degraded: true,
          });
        }).catch(function (err) {
          try { console.warn('[gs-call] visitor token fetch failed:', err && err.message); } catch (_) {}
          // Allow retry on next poll tick.
          lastDispatchedCallId = null;
        });
      } else {
        try { console.warn('[gs-call] incoming invite missing token/ws_url and call_id'); } catch (_) {}
      }
      return;
    }
    if (invite.call_id) lastDispatchedCallId = invite.call_id;
    ensureShell();
    bindHandlersOnce();
    // Replace any in-flight call.
    if (current) teardown('replaced');
    current = { invite: invite, room: null, micEnabled: false, camEnabled: false };
    var titleEl = rootEl.querySelector('[data-el="title"]');
    var subEl = rootEl.querySelector('[data-el="sub"]');
    titleEl.textContent = invite.call_type === 'video' ? 'Incoming video call' : 'Incoming call';
    subEl.textContent = (invite.operator_name || 'Support') + ' is calling';
    if (invite.degraded && degradedEl) degradedEl.classList.add('show');
    btnAccept.disabled = false;
    btnReject.disabled = false;
    setStatus('');
    setRingingMode();
    show();
  }

  // ───── Public API ─────
  // Two ways to deliver an incoming call:
  //   1. Direct:   window.__gs_call.incoming(invite)
  //   2. Queued:   window.__gs.push(['call:incoming', invite])
  window.__gs_call = {
    incoming: showIncoming,
    hangup: hangup,
    isActive: function () { return !!(current && current.room); },
    /**
     * Polling-mode entry: receives a slim {id, call_type, state} from
     * /api/widget/poll's `active_call` field. If we already have an active
     * call OR we already dispatched this call_id, this is a no-op.
     */
    ringingFromPoll: function (slim) {
      if (!slim || !slim.id) return;
      if (current && current.invite && current.invite.call_id === slim.id) return;
      if (lastDispatchedCallId === slim.id) return;
      showIncoming({ call_id: slim.id, call_type: slim.call_type || 'audio' });
    },
    /**
     * Phase 8D — Show callback-request CTA. Used when queue is unavailable,
     * SLA exceeded, or no operator can take a live call. Reuses the visitor's
     * existing identity (token + workspace context). Never asks for a new form.
     *
     * options: { channel: 'audio'|'video', conversation_id?, notes?, queue_entry_id? }
     */
    offerCallback: function (options) {
      ensureShell();
      var opts = options || {};
      var channel = opts.channel === 'video' ? 'video' : 'audio';
      rootEl.querySelector('[data-el="title"]').textContent = 'No operator available';
      rootEl.querySelector('[data-el="sub"]').textContent = 'Request a callback and we will get back to you.';
      rootEl.querySelector('[data-el="ring-row"]').style.display = 'none';
      rootEl.querySelector('[data-el="call-row"]').style.display = 'none';
      rootEl.querySelector('[data-el="callback-row"]').style.display = 'flex';
      var btn = rootEl.querySelector('[data-el="callback"]');
      btn.disabled = false;
      btn.textContent = 'Request callback';
      show();
      btn.onclick = function () {
        btn.disabled = true;
        btn.textContent = 'Requesting...';
        var ctx = getWidgetCtx();
        if (!ctx.apiBase || !ctx.token) {
          setStatus('Could not request callback');
          btn.disabled = false; btn.textContent = 'Try again';
          return;
        }
        fetch(ctx.apiBase + '/api/widget/callback/request', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Widget-Token': ctx.token },
          body: JSON.stringify({
            channel: channel,
            conversation_id: opts.conversation_id || undefined,
            notes: opts.notes || undefined,
            queue_entry_id: opts.queue_entry_id || undefined,
          }),
        }).then(function (r) {
          if (!r.ok) throw new Error('http_' + r.status);
          return r.json();
        }).then(function () {
          rootEl.querySelector('[data-el="title"]').textContent = 'Callback requested';
          rootEl.querySelector('[data-el="sub"]').textContent = 'An operator will reach out shortly.';
          btn.textContent = 'Done';
          setTimeout(function () { hide(); }, 2500);
        }).catch(function () {
          setStatus('Could not request callback');
          btn.disabled = false; btn.textContent = 'Try again';
        });
      };
    },
  };
  // Adopt any pre-queued items.
  try {
    var q = window.__gs;
    if (Array.isArray(q)) {
      for (var i = 0; i < q.length; i++) {
        var item = q[i];
        if (Array.isArray(item) && item[0] === 'call:incoming' && item[1]) {
          showIncoming(item[1]);
        }
        if (Array.isArray(item) && item[0] === 'call:ringing-poll' && item[1]) {
          window.__gs_call.ringingFromPoll(item[1]);
        }
        if (Array.isArray(item) && item[0] === 'call:callback-offer' && item[1]) {
          window.__gs_call.offerCallback(item[1]);
        }
      }
    }
  } catch (_) {}

  // Patch the loader's queue API so future pushes route through us.
  // The loader replaces `window.__gs` with a real api object; we wrap
  // its `push` once it appears. Safe even if the object doesn't exist.
  function tryAttachToGs() {
    var gs = window.__gs;
    if (!gs || typeof gs !== 'object' || gs.__gs_call_patched) return false;
    var origPush = typeof gs.push === 'function' ? gs.push.bind(gs) : null;
    gs.push = function (item) {
      if (Array.isArray(item) && item[0] === 'call:incoming' && item[1]) {
        showIncoming(item[1]);
        return;
      }
      if (Array.isArray(item) && item[0] === 'call:ringing-poll' && item[1]) {
        window.__gs_call.ringingFromPoll(item[1]);
        return;
      }
      if (Array.isArray(item) && item[0] === 'call:callback-offer' && item[1]) {
        window.__gs_call.offerCallback(item[1]);
        return;
      }
      if (origPush) return origPush(item);
    };
    gs.__gs_call_patched = true;
    return true;
  }
  if (!tryAttachToGs()) {
    // The loader may install __gs later. Poll briefly.
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (tryAttachToGs() || tries > 50) clearInterval(iv);
    }, 200);
  }
})();