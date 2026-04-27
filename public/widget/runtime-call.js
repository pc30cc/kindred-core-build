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

  function makeErr(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function describeError(err) {
    return {
      name: (err && err.name) || 'Error',
      message: (err && err.message) || String(err || 'Unknown error'),
      code: err && err.code,
      stack: err && err.stack,
    };
  }

  function getSdkVersion(LK) {
    if (!LK) return 'unknown';
    return LK.version || LK.VERSION || LK.LiveKitVersion || LK.sdkVersion || 'unknown';
  }

  // ───── SDK loader (strict — no CDN) ─────
  var sdkPromise = null;
  function loadSdk() {
    if (window.LivekitClient) {
      dlog('sdk loaded');
      dlog('livekit-client version', getSdkVersion(window.LivekitClient));
      return Promise.resolve(window.LivekitClient);
    }
    if (sdkPromise) return sdkPromise;
    var url = window.__gs_call_sdk_url || '';
    dlog('sdk url', url || '(missing)');
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
        if (window.LivekitClient) {
          dlog('sdk loaded');
          dlog('livekit-client version', getSdkVersion(window.LivekitClient));
          resolve(window.LivekitClient);
        } else {
          reject(makeErr('sdk_load_failed', 'LiveKit SDK loaded but global missing.'));
        }
      };
      s.onerror = function () { reject(makeErr('sdk_load_failed', 'Failed to load LiveKit SDK.')); };
      document.head.appendChild(s);
    });
    return sdkPromise;
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
  var room = null;
  var connecting = false;
  var emitter = createEmitter();
  var state = 'idle';
  var lastRemote = { audio: null, video: null, audioTrack: null, videoTrack: null };
  var lastLocalVideo = null;
  var micEnabled = false;
  var cameraEnabled = false;
  var connectedAt = 0;
  var explicitDisconnectRequested = false;
  var roomConnectStarted = false;
  var roomConnectSettled = false;
  var roomConnectSucceeded = false;
  var roomConnectFinalRejectLogged = false;
  var engineFullyConnected = false;
  var alreadyTornDown = false;
  var currentCameraFacing = ''; // 'user' | 'environment' | ''
  var currentCameraDeviceId = '';
  var availableCameras = [];     // [{ deviceId, label, facing? }]
  var enumerateInFlight = false;
  var switchInFlight = false;

  function setState(next) {
    if (state === next) return;
    state = next;
    emitter.emit('state', state);
  }

  function emitRemote(LK) {
    var firstAudio = null, firstVideo = null;
    var firstAudioTrack = null, firstVideoTrack = null;
    if (room) {
      room.remoteParticipants.forEach(function (p) {
        p.trackPublications.forEach(function (pub) {
          if (!pub.track) return;
          var mst = pub.track.mediaStreamTrack || null;
          if (pub.kind === LK.Track.Kind.Audio && !firstAudio) {
            firstAudio = mst;
            firstAudioTrack = pub.track;
          }
          if (pub.kind === LK.Track.Kind.Video && !firstVideo) {
            firstVideo = mst;
            firstVideoTrack = pub.track;
          }
        });
      });
    }
    lastRemote = {
      audio: firstAudio,
      video: firstVideo,
      audioTrack: firstAudioTrack,
      videoTrack: firstVideoTrack,
    };
    try {
      dlog('emit remote', {
        hasAudio: !!firstAudio,
        hasVideo: !!firstVideo,
        audioReadyState: firstAudio && firstAudio.readyState,
        videoReadyState: firstVideo && firstVideo.readyState,
        hasVideoTrack: !!firstVideoTrack,
        hasAudioTrack: !!firstAudioTrack,
      });
    } catch (_) {}
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
      setState(reasonState || 'disconnected');
      return;
    }
    alreadyTornDown = true;
    dlog('teardown', {
      reasonState: reasonState,
      explicitDisconnectRequested: explicitDisconnectRequested,
      roomConnectSettled: roomConnectSettled,
      roomConnectSucceeded: roomConnectSucceeded,
      engineFullyConnected: engineFullyConnected,
    });
    if (room) {
      try { room.disconnect(); } catch (_) { /* ignore */ }
    }
    room = null;
    connecting = false;
    micEnabled = false;
    cameraEnabled = false;
    lastRemote = { audio: null, video: null, audioTrack: null, videoTrack: null };
    lastLocalVideo = null;
    connectedAt = 0;
    emitter.emit('remote', lastRemote);
    emitter.emit('local', { video: null });
    emitter.emit('micEnabled', false);
    emitter.emit('cameraEnabled', false);
    setState(reasonState || 'disconnected');
  }

  function connect(opts) {
    opts = opts || {};
    if (room || connecting) {
      return Promise.reject(makeErr('already_connected', 'Engine already has an active call.'));
    }
    if (!opts.wsUrl) return Promise.reject(makeErr('livekit_connect_failed', 'Missing wsUrl.'));
    if (!opts.token) return Promise.reject(makeErr('token_mint_failed', 'Missing token.'));

    var wsUrl = opts.wsUrl;
    try {
      var parsed = new URL(String(wsUrl).trim().replace(/\/+$/, ''));
      var proto = parsed.protocol;
      if (proto === 'http:') proto = 'ws:';
      else if (proto === 'https:') proto = 'wss:';
      if ((proto === 'ws:' || proto === 'wss:') && parsed.host) {
        var rebuilt = proto + '//' + parsed.host;
        if (rebuilt !== wsUrl) {
          dwarn('ws_url normalized client-side:', wsUrl, '→', rebuilt);
          wsUrl = rebuilt;
        }
      }
    } catch (_) { /* leave wsUrl as-is; SDK will surface the error */ }

    var publishMic = opts.publishMic !== false;
    var publishCamera = !!opts.publishCamera;
    explicitDisconnectRequested = false;
    roomConnectStarted = false;
    roomConnectSettled = false;
    roomConnectSucceeded = false;
    roomConnectFinalRejectLogged = false;
    engineFullyConnected = false;
    alreadyTornDown = false;
    connecting = true;
    connectedAt = 0;
    setState('connecting');
    dlog('connect start', {
      callId: opts.callId || null,
      channel: opts.channel || null,
      publishMic: publishMic,
      publishCamera: publishCamera,
      hasTurn: !!(opts.turn && opts.turn.urls && opts.turn.urls.length),
      icePolicy: opts.ice_policy || 'all',
    });

    return loadSdk().then(function (LK) {
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
        .on(LK.RoomEvent.ParticipantConnected, function (p) {
          try { dlog('participant connected', { identity: p && p.identity }); } catch (_) {}
          emitRemote(LK);
        })
        .on(LK.RoomEvent.ParticipantDisconnected, function (p) {
          try { dlog('participant disconnected', { identity: p && p.identity }); } catch (_) {}
          emitRemote(LK);
        })
        .on(LK.RoomEvent.TrackSubscribed, function (track, pub, p) {
          try {
            dlog('track subscribed', {
              participant: p && p.identity,
              kind: pub && pub.kind,
              trackSid: pub && pub.trackSid,
              source: pub && pub.source,
              muted: pub && pub.isMuted,
              mediaStreamTrackReadyState: track && track.mediaStreamTrack && track.mediaStreamTrack.readyState,
            });
          } catch (_) {}
          emitRemote(LK);
        })
        .on(LK.RoomEvent.TrackUnsubscribed, function (track, pub, p) {
          try {
            dlog('track unsubscribed', {
              participant: p && p.identity,
              kind: pub && pub.kind,
              trackSid: pub && pub.trackSid,
            });
          } catch (_) {}
          emitRemote(LK);
        })
        .on(LK.RoomEvent.TrackMuted, function (pub, p) {
          try { dlog('track muted', { participant: p && p.identity, kind: pub && pub.kind }); } catch (_) {}
          emitRemote(LK);
        })
        .on(LK.RoomEvent.TrackUnmuted, function (pub, p) {
          try { dlog('track unmuted', { participant: p && p.identity, kind: pub && pub.kind }); } catch (_) {}
          emitRemote(LK);
        })
        .on(LK.RoomEvent.TrackStreamStateChanged, function (pub, streamState, p) {
          try {
            dlog('stream state changed', {
              participant: p && p.identity,
              kind: pub && pub.kind,
              streamState: streamState,
            });
          } catch (_) {}
          emitRemote(LK);
        })
        .on(LK.RoomEvent.TrackSubscriptionStatusChanged, function (pub, status, p) {
          try {
            dlog('subscription status changed', {
              participant: p && p.identity,
              kind: pub && pub.kind,
              status: status,
            });
          } catch (_) {}
          emitRemote(LK);
        })
        .on(LK.RoomEvent.LocalTrackPublished, function (pub) {
          if (pub.kind === LK.Track.Kind.Audio) {
            micEnabled = true;
            emitter.emit('micEnabled', true);
          }
          if (pub.kind === LK.Track.Kind.Video) {
            cameraEnabled = true;
            emitter.emit('cameraEnabled', true);
            emitLocalVideo(LK);
          }
        })
        .on(LK.RoomEvent.LocalTrackUnpublished, function (pub) {
          if (pub.kind === LK.Track.Kind.Audio) {
            micEnabled = false;
            emitter.emit('micEnabled', false);
          }
          if (pub.kind === LK.Track.Kind.Video) {
            cameraEnabled = false;
            emitter.emit('cameraEnabled', false);
            emitLocalVideo(LK);
          }
        })
        .on(LK.RoomEvent.Reconnecting, function () { setState('reconnecting'); })
        .on(LK.RoomEvent.Reconnected, function () {
          setState('connected');
          emitRemote(LK);
        })
        .on(LK.RoomEvent.Disconnected, function (reason) {
          if (room !== nextRoom) return;
          dlog('room disconnected', {
            reason: reason,
            explicitDisconnectRequested: explicitDisconnectRequested,
            roomConnectSettled: roomConnectSettled,
            roomConnectSucceeded: roomConnectSucceeded,
            engineFullyConnected: engineFullyConnected,
            state: state,
          });
          if (explicitDisconnectRequested || engineFullyConnected) {
            teardownInternal('disconnected');
          } else {
            setState('connecting');
            dlog('disconnected ignored: connect still pending');
          }
        });

      dlog('room.connect start');
      roomConnectStarted = true;
      return nextRoom.connect(wsUrl, opts.token, connectOptions).then(function () {
        roomConnectSucceeded = true;
        roomConnectSettled = true;
        dlog('room.connect success');
        if (room !== nextRoom || explicitDisconnectRequested) {
          throw makeErr('livekit_connect_failed', 'Connection cancelled before establishment.');
        }

        var publishChain = Promise.resolve();
        if (publishMic) {
          publishChain = publishChain.then(function () {
            dlog('publish mic start');
            return nextRoom.localParticipant.setMicrophoneEnabled(true).then(function () {
              micEnabled = !!nextRoom.localParticipant.isMicrophoneEnabled;
              emitter.emit('micEnabled', micEnabled);
              dlog('publish mic success');
            }).catch(function (e) {
              micEnabled = false;
              emitter.emit('micEnabled', false);
              dlog('publish mic fail', describeError(e));
              emitter.emit('error', { code: 'permission_denied_microphone', message: (e && e.message) || 'Microphone permission denied.' });
            });
          });
        }
        if (publishCamera) {
          publishChain = publishChain.then(function () {
            dlog('publish camera start');
            return nextRoom.localParticipant.setCameraEnabled(true).then(function () {
              cameraEnabled = !!nextRoom.localParticipant.isCameraEnabled;
              emitter.emit('cameraEnabled', cameraEnabled);
              dlog('publish camera success');
              emitLocalVideo(LK);
            }).catch(function (e) {
              cameraEnabled = false;
              emitter.emit('cameraEnabled', false);
              emitter.emit('local', { video: null });
              dlog('publish camera fail', describeError(e));
              emitter.emit('error', { code: 'permission_denied_camera', message: (e && e.message) || 'Camera permission denied.' });
            });
          });
        }

        return publishChain.then(function () {
          if (room !== nextRoom || explicitDisconnectRequested) {
            throw makeErr('livekit_connect_failed', 'Connection cancelled during publish.');
          }
          connecting = false;
          connectedAt = Date.now();
          engineFullyConnected = true;
          setState('connected');
          dlog('engine fully connected');
          emitRemote(LK);
          emitLocalVideo(LK);
        });
      }).catch(function (err) {
        roomConnectSettled = true;
        if (explicitDisconnectRequested || alreadyTornDown) {
          if (!alreadyTornDown) teardownInternal('disconnected');
          return undefined;
        }
        if (!roomConnectSucceeded) {
          roomConnectFinalRejectLogged = true;
          dlog('room.connect final reject', describeError(err));
        }
        var code = (err && err.code) || 'livekit_connect_failed';
        var message = (err && err.message) || 'Failed to connect.';
        emitter.emit('error', { code: code, message: message });
        teardownInternal('failed');
        throw makeErr(code, message);
      });
    }).catch(function (err) {
      var code = (err && err.code) || 'livekit_connect_failed';
      var message = (err && err.message) || 'Failed to connect.';
      if (explicitDisconnectRequested || code === 'call_cancelled') {
        if (!alreadyTornDown) teardownInternal('disconnected');
        return undefined;
      }
      if (roomConnectStarted && !roomConnectSucceeded && !roomConnectFinalRejectLogged) {
        roomConnectFinalRejectLogged = true;
        dlog('room.connect final reject', describeError(err));
      }
      emitter.emit('error', { code: code, message: message });
      if (!alreadyTornDown) teardownInternal('failed');
      throw makeErr(code, message);
    });
  }

  function disconnect() {
    if (!room && !connecting) return Promise.resolve();
    explicitDisconnectRequested = true;
    teardownInternal('disconnected');
    return Promise.resolve();
  }

  function toggleMic() {
    if (!room || !engineFullyConnected) return Promise.resolve(micEnabled);
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
    if (!room || !engineFullyConnected) return Promise.resolve(cameraEnabled);
    var lp = room.localParticipant;
    var next = !lp.isCameraEnabled;
    return lp.setCameraEnabled(next).then(function () {
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

  // Optional media features are intentionally disabled while basic visitor
  // connection stability is being re-established. Re-enable one at a time.
  function switchCamera() { return Promise.resolve(null); }
  function setVideoQuality(q) { return Promise.resolve(q || 'auto'); }
  function listCameras() { return Promise.resolve([]); }

  // ───── Public API ─────
  window.__gs_call = {
    engine: {
      connect: connect,
      disconnect: disconnect,
      toggleMic: toggleMic,
      toggleCamera: toggleCamera,
      switchCamera: switchCamera,
      setVideoQuality: setVideoQuality,
      listCameras: listCameras,
      on: emitter.on,
      getState: function () {
        return {
          state: state,
          remote: lastRemote,
          localVideo: lastLocalVideo,
          micEnabled: micEnabled,
          cameraEnabled: cameraEnabled,
          connectedAt: connectedAt,
          cameras: [],
          currentCameraDeviceId: '',
          videoQuality: 'auto',
        };
      },
    },
    /** Convenience: load + warm the SDK before the visitor clicks Join. */
    preload: function () {
      return loadSdk().then(function () { return true; }, function () { return false; });
    },
    isActive: function () { return !!room; },
  };

  try {
    if (typeof window.__gs_call_resolveReady === 'function') {
      window.__gs_call_resolveReady(window.__gs_call);
    }
  } catch (_) { /* noop */ }
})();
