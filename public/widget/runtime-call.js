/**
 * Pass 2 — Headless LiveKit call adapter (visitor side).
 *
 * This file used to own its own shadow root, mount a card on document.body,
 * handle a legacy `call:incoming` push bus, and even render an unrelated
 * "callback request" form. All of that violated the strict architecture
 * rule that "no call UI should ever render outside the main widget panel".
 *
 * Pass 2 deletes the entire UI layer of this module. What remains is a
 * tiny headless engine — a thin wrapper over the LiveKit JS SDK — that
 * runtime.js drives directly from the in-panel call surface.
 *
 * Public API (window.__gs_call):
 *   engine.connect({ wsUrl, token, turn, ice_policy, publishMic, publishCamera })
 *     → Promise<void> resolved when the LiveKit room reaches 'connected'.
 *   engine.disconnect()        → tears the room down idempotently.
 *   engine.toggleMic()         → Promise<boolean> next state.
 *   engine.toggleCamera()      → Promise<boolean> next state.
 *   engine.on(event, handler)  → subscribe; events:
 *       'state'           (state: 'idle'|'connecting'|'connected'|'reconnecting'|'disconnected'|'failed')
 *       'remote'          ({ audio: MediaStreamTrack|null, video: MediaStreamTrack|null })
 *       'local'           ({ video: MediaStreamTrack|null })  // local preview
 *       'micEnabled'      (bool)
 *       'cameraEnabled'   (bool)
 *       'error'           ({ code, message })
 *   engine.getState()          → snapshot.
 *
 * Strict rules:
 *   - SDK URL ALWAYS comes from window.__gs_call_sdk_url, which the
 *     loader sets from /api/widget/config → livekitSdkUrl. NO CDN
 *     fallback. If the global is missing we fail with code='sdk_url_missing'.
 *   - This module renders NOTHING. No shadow root, no document.body
 *     mount, no styles. The widget panel owns presentation entirely.
 *   - No legacy `call:incoming` / `call:ringing-poll` push handlers.
 *     The invitation flow drives connect() directly with a token bundle
 *     returned by /api/widget/call-invitations/:id/join.
 */
(function () {
  'use strict';
  if (window.__gs_call_loaded) return;
  window.__gs_call_loaded = true;

  // ───── SDK loader (strict — no CDN) ─────
  var sdkPromise = null;
  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
    if (sdkPromise) return sdkPromise;
    var url = window.__gs_call_sdk_url || '';
    if (!url) {
      return Promise.reject(makeErr('sdk_url_missing', 'LiveKit SDK URL not provided by widget config.'));
    }
    sdkPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      // crossOrigin is required so the browser sets CORS-mode for the
      // request — the asset host serves the vendor file with the right
      // CORP/Access-Control headers (see Pass 1).
      s.crossOrigin = 'anonymous';
      s.setAttribute('data-gs-livekit-sdk', 'true');
      s.onload = function () {
        if (window.LivekitClient) resolve(window.LivekitClient);
        else reject(makeErr('sdk_load_failed', 'LiveKit SDK loaded but global missing.'));
      };
      s.onerror = function () { reject(makeErr('sdk_load_failed', 'Failed to load LiveKit SDK.')); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  function makeErr(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  // ───── Event bus (per-engine) ─────
  function createEmitter() {
    var listeners = {};
    return {
      on: function (evt, fn) {
        (listeners[evt] = listeners[evt] || []).push(fn);
        return function () {
          listeners[evt] = (listeners[evt] || []).filter(function (h) { return h !== fn; });
        };
      },
      emit: function (evt, payload) {
        var arr = listeners[evt] || [];
        for (var i = 0; i < arr.length; i++) {
          try { arr[i](payload); } catch (_) { /* swallow */ }
        }
      },
      clear: function () { listeners = {}; },
    };
  }

  // ───── Singleton engine state ─────
  // Only one active call at a time. Re-entrant connect() calls are
  // rejected — the caller must disconnect() first.
  var room = null;
  var connecting = false;
  var emitter = createEmitter();
  var state = 'idle';
  var lastRemote = { audio: null, video: null };
  var lastLocalVideo = null;
  var micEnabled = false;
  var cameraEnabled = false;
  var connectedAt = 0;
  // Visitor-side preferred video capture preset. Mirrors the operator
  // VoiceVideoPage presets so workspace defaults can be honored.
  var videoQuality = 'auto';
  // Track current camera deviceId + facingMode hint so switchCamera can
  // pick a different one without re-prompting the user.
  var currentCameraDeviceId = '';
  var currentFacingMode = 'user';
  var availableCameras = [];
  // ── Connect-lifecycle flags (visitor-side regression fix) ──
  // Keep signaling, publishing, and "usable call" separate. LiveKit can
  // emit Disconnected while the initial signal/media path is still settling;
  // tearing down there closes the visitor before ICE/media establishes.
  var signalingConnectStarted = false;
  var signalingConnected = false;
  var mediaPublishStarted = false;
  var mediaPublished = false;
  var engineFullyConnected = false;
  var explicitDisconnectRequested = false;
  var connectPromiseSettled = false;
  var alreadyTornDown = false;
  // Diagnostics — visitor browser logs we always want when debugging
  // a failed-to-connect scenario.
  function dlog() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[gs-call]');
      console.log.apply(console, args);
    } catch (_) {}
  }
  function dwarn() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[gs-call]');
      console.warn.apply(console, args);
    } catch (_) {}
  }
  // Active-call window listeners for unhandled errors. Installed only
  // while a call is in progress so we don't pollute global error reporting.
  var __activeErrHandler = null;
  var __activeRejHandler = null;
  function installActiveCallDiagnostics() {
    if (__activeErrHandler || typeof window === 'undefined') return;
    __activeErrHandler = function (ev) {
      dwarn('window error during call', { message: ev && ev.message, filename: ev && ev.filename, lineno: ev && ev.lineno });
    };
    __activeRejHandler = function (ev) {
      var r = ev && ev.reason;
      dwarn('unhandledrejection during call', { message: (r && r.message) || String(r) });
    };
    try { window.addEventListener('error', __activeErrHandler); } catch (_) {}
    try { window.addEventListener('unhandledrejection', __activeRejHandler); } catch (_) {}
  }
  function removeActiveCallDiagnostics() {
    if (typeof window === 'undefined') return;
    try { if (__activeErrHandler) window.removeEventListener('error', __activeErrHandler); } catch (_) {}
    try { if (__activeRejHandler) window.removeEventListener('unhandledrejection', __activeRejHandler); } catch (_) {}
    __activeErrHandler = null;
    __activeRejHandler = null;
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    emitter.emit('state', state);
  }

  // Map a quality preset name → getUserMedia constraints. Auto/High
  // target 720p which is the SDK's canonical "good default". We do not
  // force low quality.
  function videoConstraintsForQuality(q) {
    var preset = (q || 'auto').toLowerCase();
    if (preset === 'low') {
      return { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 15, max: 20 } };
    }
    if (preset === 'medium') {
      return { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } };
    }
    if (preset === 'hd' || preset === 'high' || preset === 'auto') {
      return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    }
    return { width: { ideal: 1280 }, height: { ideal: 720 } };
  }

  function refreshAvailableCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      availableCameras = [];
      emitter.emit('cameras', { cameras: [], currentDeviceId: currentCameraDeviceId });
      return Promise.resolve(availableCameras);
    }
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      availableCameras = devices.filter(function (d) { return d.kind === 'videoinput'; }).map(function (d) {
        return { deviceId: d.deviceId, label: d.label || '' };
      });
      emitter.emit('cameras', { cameras: availableCameras.slice(), currentDeviceId: currentCameraDeviceId });
      return availableCameras;
    }).catch(function () {
      availableCameras = [];
      return availableCameras;
    });
  }

  function emitRemote(LK) {
    var firstAudio = null, firstVideo = null;
    if (room) {
      room.remoteParticipants.forEach(function (p) {
        p.trackPublications.forEach(function (pub) {
          if (!pub.track || !pub.track.mediaStreamTrack) return;
          if (pub.kind === LK.Track.Kind.Audio && !firstAudio) firstAudio = pub.track.mediaStreamTrack;
          if (pub.kind === LK.Track.Kind.Video && !firstVideo) firstVideo = pub.track.mediaStreamTrack;
        });
      });
    }
    lastRemote = { audio: firstAudio, video: firstVideo };
    emitter.emit('remote', lastRemote);
  }

  function emitLocalVideo(LK) {
    var v = null;
    if (room && room.localParticipant) {
      room.localParticipant.trackPublications.forEach(function (pub) {
        if (pub.kind === LK.Track.Kind.Video && pub.track && pub.track.mediaStreamTrack && !v) {
          v = pub.track.mediaStreamTrack;
        }
      });
    }
    lastLocalVideo = v;
    emitter.emit('local', { video: v });
  }

  function teardownInternal(reasonState) {
    if (alreadyTornDown) {
      // Idempotent — but still flip state so callers waiting on
      // `disconnected` see the final state.
      setState(reasonState || 'disconnected');
      return;
    }
    alreadyTornDown = true;
    dlog('teardown', { reasonState: reasonState, connectStarted: connectStarted, connectSucceeded: connectSucceeded, explicitDisconnectRequested: explicitDisconnectRequested });
    if (room) {
      try { room.disconnect(); } catch (_) { /* ignore */ }
    }
    room = null;
    connecting = false;
    micEnabled = false;
    cameraEnabled = false;
    lastRemote = { audio: null, video: null };
    lastLocalVideo = null;
    connectedAt = 0;
    currentCameraDeviceId = '';
    // NB: do NOT clear connectStarted / connectSucceeded here — the
    // caller's connect()-promise catch needs to inspect them. They are
    // reset at the start of the next connect() call instead.
    emitter.emit('remote', lastRemote);
    emitter.emit('local', { video: null });
    emitter.emit('micEnabled', false);
    emitter.emit('cameraEnabled', false);
    setState(reasonState || 'disconnected');
    removeActiveCallDiagnostics();
  }

  /**
   * Connect to a LiveKit room.
   *
   * Required: wsUrl (origin-only wss://), token.
   * Optional: turn { urls: string[], username, credential }, ice_policy,
   *           publishMic (default true), publishCamera (default false).
   *
   * Resolves once the SDK reports 'connected' AND the requested local
   * tracks were published (or rejected with a permission error). Rejects
   * with err.code from the canonical error vocabulary so the panel UI
   * can render a stable message + i18n key.
   */
  function connect(opts) {
    opts = opts || {};
    if (room || connecting) {
      return Promise.reject(makeErr('already_connected', 'Engine already has an active call.'));
    }
    if (!opts.wsUrl) return Promise.reject(makeErr('livekit_connect_failed', 'Missing wsUrl.'));
    if (!opts.token) return Promise.reject(makeErr('token_mint_failed', 'Missing token.'));
    // Defensive client-side normalization. Backend already runs
    // normalizeClientWsUrl(), but a stale frontend bundle paired with a
    // stale backend (or an admin-saved value like `wss://host/rtc/v1`)
    // would otherwise hand the SDK a path-bearing URL and trigger
    // `/rtc/v1/validate 404`. Strip everything but `wss://host[:port]`.
    var wsUrl = opts.wsUrl;
    try {
      var parsed = new URL(String(wsUrl).trim().replace(/\/+$/, ''));
      var proto = parsed.protocol;
      if (proto === 'http:') proto = 'ws:';
      else if (proto === 'https:') proto = 'wss:';
      if ((proto === 'ws:' || proto === 'wss:') && parsed.host) {
        var rebuilt = proto + '//' + parsed.host;
        if (rebuilt !== wsUrl) {
          try { console.warn('[gs-call] ws_url normalized client-side:', wsUrl, '→', rebuilt); } catch (_) {}
          wsUrl = rebuilt;
        }
      }
    } catch (_) { /* leave wsUrl as-is; SDK will surface the error */ }
    var publishMic = opts.publishMic !== false;
    var publishCamera = !!opts.publishCamera;
    if (opts.videoQuality) videoQuality = opts.videoQuality;
    // Reset all per-call flags at the start of a new connect.
    connectStarted = true;
    connectSucceeded = false;
    publishStarted = false;
    publishSucceeded = false;
    explicitDisconnectRequested = false;
    alreadyTornDown = false;
    connecting = true;
    setState('connecting');
    installActiveCallDiagnostics();
    dlog('connect start', {
      callId: opts.callId || null,
      channel: opts.channel || null,
      publishMic: publishMic,
      publishCamera: publishCamera,
      videoQuality: videoQuality,
      hasTurn: !!(opts.turn && opts.turn.urls && opts.turn.urls.length),
      icePolicy: opts.ice_policy || 'all',
    });

    return loadSdk().then(function (LK) {
      dlog('sdk loaded');
      var iceServers = [];
      if (opts.turn && Array.isArray(opts.turn.urls) && opts.turn.urls.length) {
        iceServers.push({
          urls: opts.turn.urls,
          username: opts.turn.username || undefined,
          credential: opts.turn.credential || undefined,
        });
      }
      var connectOptions = iceServers.length ? {
        rtcConfig: {
          iceServers: iceServers,
          iceTransportPolicy: opts.ice_policy === 'relay' ? 'relay' : 'all',
        },
      } : undefined;

      var nextRoom = new LK.Room({ adaptiveStream: true, dynacast: true });
      room = nextRoom;

      nextRoom
        .on(LK.RoomEvent.ParticipantConnected, function () { emitRemote(LK); })
        .on(LK.RoomEvent.ParticipantDisconnected, function () { emitRemote(LK); })
        .on(LK.RoomEvent.TrackSubscribed, function () { emitRemote(LK); })
        .on(LK.RoomEvent.TrackUnsubscribed, function () { emitRemote(LK); })
        // Track pause/resume / stream-state events: re-emit the snapshot
        // so the panel UI clears stale frames and re-attaches when the
        // SFU swaps simulcast layers without unsubscribing.
        .on(LK.RoomEvent.TrackMuted, function () { emitRemote(LK); })
        .on(LK.RoomEvent.TrackUnmuted, function () { emitRemote(LK); })
        .on(LK.RoomEvent.TrackStreamStateChanged, function () { emitRemote(LK); })
        .on(LK.RoomEvent.TrackSubscriptionStatusChanged, function () { emitRemote(LK); })
        .on(LK.RoomEvent.LocalTrackPublished, function (pub) {
          if (pub.kind === LK.Track.Kind.Audio) {
            micEnabled = true; emitter.emit('micEnabled', true);
          }
          if (pub.kind === LK.Track.Kind.Video) {
            cameraEnabled = true; emitter.emit('cameraEnabled', true);
            emitLocalVideo(LK);
          }
        })
        .on(LK.RoomEvent.LocalTrackUnpublished, function (pub) {
          if (pub.kind === LK.Track.Kind.Audio) {
            micEnabled = false; emitter.emit('micEnabled', false);
          }
          if (pub.kind === LK.Track.Kind.Video) {
            cameraEnabled = false; emitter.emit('cameraEnabled', false);
            emitLocalVideo(LK);
          }
        })
        .on(LK.RoomEvent.Reconnecting, function () { setState('reconnecting'); })
        .on(LK.RoomEvent.Reconnected, function () { setState('connected'); })
        .on(LK.RoomEvent.Disconnected, function (reason) {
          // CRITICAL: a Disconnected event during the initial signaling
          // handshake is NOT a user hangup. The SDK occasionally drops
          // the WS once during /rtc/v1 retry — if we tear down here the
          // visitor browser closes the signal socket and LiveKit reports
          // `removing participant without connection`, which the operator
          // side then mis-classifies as `visitor_left`.
          //
          // Rule:
          //   - explicitDisconnectRequested → real hangup → teardown
          //   - connectSucceeded → real session ended → teardown
          //   - otherwise (still in /rtc/v1 handshake or publish) →
          //     log only. The connect() promise will reject in its own
          //     `.catch` if the SDK actually fails, and that path tears
          //     down with reasonState='failed'.
          if (room !== nextRoom) return;
          dlog('room disconnected', {
            reason: reason,
            connectStarted: connectStarted,
            connectSucceeded: connectSucceeded,
            publishStarted: publishStarted,
            publishSucceeded: publishSucceeded,
            explicitDisconnectRequested: explicitDisconnectRequested,
            currentState: state,
          });
          if (explicitDisconnectRequested || connectSucceeded) {
            teardownInternal('disconnected');
          } else {
            // Stay in 'connecting' — the connect() promise owns the
            // success/failure decision. Do NOT teardown here.
            dlog('disconnected ignored: connect still pending');
          }
        });

      return nextRoom.connect(wsUrl, opts.token, connectOptions).then(function () {
        dlog('room.connect success');
        // Race guard: caller may have invoked disconnect() while we were
        // awaiting the WS handshake.
        if (room !== nextRoom) {
          try { nextRoom.disconnect(); } catch (_) {}
          throw makeErr('livekit_connect_failed', 'Connection cancelled before establishment.');
        }
        // Mark the room as connected from a signaling point of view.
        // From this point onwards, a Disconnected event IS a real teardown.
        connectSucceeded = true;
        var publishChain = Promise.resolve();
        if (publishMic) {
          publishChain = publishChain.then(function () {
            publishStarted = true;
            dlog('publish mic start');
            return nextRoom.localParticipant.setMicrophoneEnabled(true).catch(function (e) {
              dwarn('publish mic failed', { message: e && e.message });
              throw makeErr('permission_denied_microphone', (e && e.message) || 'Microphone permission denied.');
            }).then(function () { dlog('publish mic success'); });
          });
        }
        if (publishCamera) {
          publishChain = publishChain.then(function () {
            publishStarted = true;
            dlog('publish camera start');
            return nextRoom.localParticipant.setCameraEnabled(true).catch(function (e) {
              dwarn('publish camera failed', { message: e && e.message });
              throw makeErr('permission_denied_camera', (e && e.message) || 'Camera permission denied.');
            }).then(function () { dlog('publish camera success'); });
          });
        }
        return publishChain.then(function () {
          if (room !== nextRoom) {
            try { nextRoom.disconnect(); } catch (_) {}
            throw makeErr('livekit_connect_failed', 'Connection cancelled during publish.');
          }
          publishSucceeded = true;
          connecting = false;
          connectedAt = Date.now();
          setState('connected');
          dlog('engine connected');
          emitRemote(LK);
          emitLocalVideo(LK);
          // Best-effort: enumerate cameras AFTER permission so labels
          // become available. Never blocks the connect resolution.
          try { refreshAvailableCameras(); } catch (_) {}
        });
      });
    }).catch(function (err) {
      var code = (err && err.code) || 'livekit_connect_failed';
      var message = (err && err.message) || 'Failed to connect.';
      dwarn('connect failed', { code: code, message: message, connectSucceeded: connectSucceeded, publishStarted: publishStarted });
      emitter.emit('error', { code: code, message: message });
      teardownInternal('failed');
      // Re-throw a normalized error so the caller's promise chain sees it.
      throw makeErr(code, message);
    });
  }

  function disconnect() {
    if (!room && !connecting) return Promise.resolve();
    dlog('explicit disconnect requested');
    explicitDisconnectRequested = true;
    teardownInternal('disconnected');
    return Promise.resolve();
  }

  function toggleMic() {
    if (!room) return Promise.resolve(false);
    var lp = room.localParticipant;
    var next = !lp.isMicrophoneEnabled;
    return lp.setMicrophoneEnabled(next).then(function () {
      micEnabled = next;
      emitter.emit('micEnabled', next);
      return next;
    }).catch(function (e) {
      emitter.emit('error', { code: 'permission_denied_microphone', message: (e && e.message) || 'Mic toggle failed.' });
      return micEnabled;
    });
  }

  function toggleCamera() {
    if (!room) return Promise.resolve(false);
    var lp = room.localParticipant;
    var next = !lp.isCameraEnabled;
    var opts = next ? {
      videoCaptureDefaults: undefined,
      // Pass current preset constraints when re-enabling so we don't
      // get a tiny default frame.
    } : undefined;
    var captureOptions = next ? { resolution: undefined, deviceId: currentCameraDeviceId || undefined } : undefined;
    return lp.setCameraEnabled(next, captureOptions).then(function () {
      cameraEnabled = next;
      emitter.emit('cameraEnabled', next);
      try {
        var LK = window.LivekitClient;
        if (LK) emitLocalVideo(LK);
      } catch (_) {}
      return next;
    }).catch(function (e) {
      emitter.emit('error', { code: 'permission_denied_camera', message: (e && e.message) || 'Camera toggle failed.' });
      return cameraEnabled;
    });
  }

  /**
   * Switch front/back camera. Picks the next videoinput device in the
   * enumerated list. If only one camera exists, resolves with the
   * existing deviceId (UI can hide the button by inspecting cameras list).
   *
   * Strategy:
   *   1. Enumerate devices (labels exist post-permission).
   *   2. Pick the next deviceId different from the current one.
   *   3. Acquire a new MediaStreamTrack with that deviceId + the active
   *      quality preset.
   *   4. Replace the published video track in place so the call stays alive.
   *   5. Update local preview emission.
   */
  function switchCamera() {
    if (!room) return Promise.resolve(null);
    var LK = window.LivekitClient;
    if (!LK) return Promise.resolve(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.resolve(null);
    }
    return refreshAvailableCameras().then(function (cams) {
      if (!cams || cams.length < 2) return null;
      var nextDev = null;
      for (var i = 0; i < cams.length; i++) {
        if (cams[i].deviceId && cams[i].deviceId !== currentCameraDeviceId) {
          nextDev = cams[i];
          break;
        }
      }
      if (!nextDev) nextDev = cams[0];
      var quality = videoConstraintsForQuality(videoQuality);
      var videoConstraints = Object.assign({}, quality, { deviceId: { exact: nextDev.deviceId } });
      // If we have no current track yet (camera off), we still want to
      // enable + publish using this deviceId.
      var lp = room.localParticipant;
      // Find current video publication.
      var currentPub = null;
      lp.trackPublications.forEach(function (pub) {
        if (pub.kind === LK.Track.Kind.Video && pub.track) currentPub = pub;
      });
      // Create a new local video track using the LiveKit helper if
      // available, fall back to raw getUserMedia.
      function createTrack() {
        if (LK.createLocalVideoTrack) {
          return LK.createLocalVideoTrack({
            deviceId: nextDev.deviceId,
            resolution: undefined,
            // pass through raw constraints so quality preset is honored
            // — LiveKit forwards video constraints to getUserMedia.
          }).then(function (lkTrack) { return { lkTrack: lkTrack, mediaTrack: lkTrack.mediaStreamTrack }; });
        }
        return navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false })
          .then(function (stream) {
            var t0 = stream.getVideoTracks()[0];
            return { lkTrack: null, mediaTrack: t0 };
          });
      }
      return createTrack().then(function (made) {
        currentCameraDeviceId = nextDev.deviceId;
        if (currentPub && currentPub.track && typeof currentPub.track.replaceTrack === 'function') {
          return currentPub.track.replaceTrack(made.mediaTrack).then(function () {
            cameraEnabled = true;
            emitter.emit('cameraEnabled', true);
            try { emitLocalVideo(LK); } catch (_) {}
            try { refreshAvailableCameras(); } catch (_) {}
            return { deviceId: currentCameraDeviceId };
          });
        }
        // No existing video track — publish fresh.
        if (made.lkTrack) {
          return lp.publishTrack(made.lkTrack).then(function () {
            cameraEnabled = true;
            emitter.emit('cameraEnabled', true);
            try { emitLocalVideo(LK); } catch (_) {}
            return { deviceId: currentCameraDeviceId };
          });
        }
        // raw track path — wrap with LiveKit and publish.
        if (LK.LocalVideoTrack) {
          var lkLocal = new LK.LocalVideoTrack(made.mediaTrack);
          return lp.publishTrack(lkLocal).then(function () {
            cameraEnabled = true;
            emitter.emit('cameraEnabled', true);
            try { emitLocalVideo(LK); } catch (_) {}
            return { deviceId: currentCameraDeviceId };
          });
        }
        return null;
      });
    }).catch(function (e) {
      try { console.warn('[gs-call] switchCamera failed', e && e.message); } catch (_) {}
      // Never break the call.
      return null;
    });
  }

  function setVideoQuality(q) {
    videoQuality = q || 'auto';
    return Promise.resolve(videoQuality);
  }

  // ───── Public API ─────
  window.__gs_call = {
    engine: {
      connect: connect,
      disconnect: disconnect,
      toggleMic: toggleMic,
      toggleCamera: toggleCamera,
      switchCamera: switchCamera,
      setVideoQuality: setVideoQuality,
      listCameras: function () { return refreshAvailableCameras(); },
      on: emitter.on,
      getState: function () {
        return {
          state: state,
          remote: lastRemote,
          localVideo: lastLocalVideo,
          micEnabled: micEnabled,
          cameraEnabled: cameraEnabled,
          connectedAt: connectedAt,
          cameras: availableCameras.slice(),
          currentCameraDeviceId: currentCameraDeviceId,
          videoQuality: videoQuality,
        };
      },
    },
    /** Convenience: load + warm the SDK before the visitor clicks Join. */
    preload: function () {
      return loadSdk().then(function () { return true; }, function () { return false; });
    },
    isActive: function () { return !!room; },
  };

  // Resolve the deferred readiness promise the loader created so anyone
  // awaiting `window.__gs_call_ready` (legacy chat handler in runtime.js)
  // can proceed without further script injection.
  try {
    if (typeof window.__gs_call_resolveReady === 'function') {
      window.__gs_call_resolveReady(window.__gs_call);
    }
  } catch (_) { /* noop */ }
})();