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

  // Same three opt-in mechanisms as every other widget module (loader.js,
  // runtime.js Util.debug, runtime-chat.js isDebug()): OFF by default in
  // production. This module previously logged every call/track/device event
  // unconditionally — including participant identities and normalized WS
  // URLs — straight to the visitor's production console.
  function isDebug() {
    try {
      if (typeof window !== 'undefined' && window.__gs_debug === true) return true;
      return typeof localStorage !== 'undefined' && localStorage.getItem('gs:debug') === '1';
    } catch (_) { return false; }
  }
  function dlog() {
    if (!isDebug()) return;
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[gs-call]');
      console.log.apply(console, args);
    } catch (_) {}
  }

  function dwarn() {
    if (!isDebug()) return;
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
  // True only when a front AND a back camera were both found — see
  // computeCanSwitchCamera(). Never assume switchable before the
  // first enumeration completes.
  var canSwitchCamera = false;
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
            // Prefer the user-facing camera by default. Use ideal (not
            // exact) so desktops without a front camera still work, and
            // so we don't force portrait/landscape constraints that
            // would fight the device's natural capture orientation.
            return nextRoom.localParticipant.setCameraEnabled(true, {
              facingMode: 'user',
              resolution: { width: 1280, height: 720, frameRate: 30 },
            }).then(function () {
              cameraEnabled = !!nextRoom.localParticipant.isCameraEnabled;
              emitter.emit('cameraEnabled', cameraEnabled);
              dlog('publish camera success');
              emitLocalVideo(LK);
              // Best-effort detect facing so the UI knows whether to
              // show "switch to back" or "switch to front". Safe to fail.
              try {
                var ms = nextRoom.localParticipant.trackPublications;
                ms.forEach(function (pub) {
                  if (pub.kind !== LK.Track.Kind.Video || !pub.track) return;
                  var settings = pub.track.mediaStreamTrack && pub.track.mediaStreamTrack.getSettings && pub.track.mediaStreamTrack.getSettings();
                  if (settings) {
                    if (settings.facingMode) currentCameraFacing = settings.facingMode;
                    if (settings.deviceId) currentCameraDeviceId = settings.deviceId;
                  }
                });
              } catch (_) {}
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

  // ─── Camera enumeration / switching ────────────────────────────────
  // Re-enabled now that the base connection is stable. All operations
  // are gated on engineFullyConnected and use track replacement (not
  // room reconnect) so the call stays alive across switches.

  function inferFacingFromLabel(label) {
    if (!label) return '';
    var s = String(label).toLowerCase();
    if (s.indexOf('back') !== -1 || s.indexOf('rear') !== -1 || s.indexOf('environment') !== -1) return 'environment';
    if (s.indexOf('front') !== -1 || s.indexOf('user') !== -1 || s.indexOf('face') !== -1 || s.indexOf('selfie') !== -1) return 'user';
    return '';
  }

  /**
   * Which way a camera points, most reliable source first.
   *
   * `InputDeviceInfo.getCapabilities().facingMode` is the authoritative
   * answer and, crucially, it is the one that tells desktops apart: a
   * laptop webcam reports an EMPTY facingMode list, while a phone camera
   * reports ['user'] or ['environment']. Labels are the fallback for
   * browsers without that API (notably Safari, which does name its
   * cameras "Front Camera" / "Back Camera" once permission is granted).
   */
  function facingOfDevice(device) {
    try {
      if (device && typeof device.getCapabilities === 'function') {
        var caps = device.getCapabilities() || {};
        var modes = caps.facingMode;
        if (modes && modes.length) {
          for (var i = 0; i < modes.length; i++) {
            if (modes[i] === 'environment' || modes[i] === 'user') return modes[i];
          }
        }
      }
    } catch (_) { /* getCapabilities can throw on some builds */ }
    return inferFacingFromLabel((device && device.label) || '');
  }

  /**
   * Whether "switch camera" is a real operation on this device.
   *
   * switchCamera() flips between the front and the back camera, so the
   * only thing that makes the control meaningful is having BOTH. Counting
   * cameras is not enough and was the old bug: a laptop with a built-in
   * webcam plus a USB or virtual camera reported two devices, showed the
   * button, and then failed — there is no `environment` camera to switch
   * to. A device whose cameras we could not classify at all counts as not
   * switchable; a control that does nothing is worse than an absent one.
   */
  function computeCanSwitchCamera(cams) {
    var hasUser = false;
    var hasEnvironment = false;
    for (var i = 0; i < cams.length; i++) {
      if (cams[i].facing === 'user') hasUser = true;
      else if (cams[i].facing === 'environment') hasEnvironment = true;
    }
    return hasUser && hasEnvironment;
  }

  function enumerateCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return Promise.resolve([]);
    }
    if (enumerateInFlight) return Promise.resolve(availableCameras);
    enumerateInFlight = true;
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var cams = (devices || [])
        .filter(function (d) { return d.kind === 'videoinput'; })
        .map(function (d) {
          return {
            deviceId: d.deviceId || '',
            label: d.label || '',
            facing: facingOfDevice(d),
          };
        });
      availableCameras = cams;
      canSwitchCamera = computeCanSwitchCamera(cams);
      try {
        dlog('available cameras', { count: cams.length, canSwitch: canSwitchCamera, cameras: cams.map(function (c) { return { id: c.deviceId.slice(0, 8), label: c.label, facing: c.facing }; }) });
      } catch (_) {}
      emitter.emit('cameras', {
        cameras: cams.slice(),
        facing: currentCameraFacing,
        deviceId: currentCameraDeviceId,
        canSwitch: canSwitchCamera,
      });
      enumerateInFlight = false;
      return cams;
    }).catch(function (e) {
      enumerateInFlight = false;
      try { dlog('enumerate cameras failed', describeError(e)); } catch (_) {}
      return [];
    });
  }

  function getCurrentCameraTrack() {
    if (!room || !room.localParticipant) return null;
    var current = null;
    try {
      room.localParticipant.trackPublications.forEach(function (pub) {
        if (pub.kind === 'video' && pub.track && !current) current = pub.track;
      });
    } catch (_) {}
    return current;
  }

  function detectCurrentFacing() {
    var t = getCurrentCameraTrack();
    if (!t) return '';
    try {
      var ms = t.mediaStreamTrack;
      if (ms && typeof ms.getSettings === 'function') {
        var s = ms.getSettings() || {};
        if (s.facingMode === 'environment' || s.facingMode === 'user') return s.facingMode;
        if (s.deviceId) {
          for (var i = 0; i < availableCameras.length; i++) {
            if (availableCameras[i].deviceId === s.deviceId) {
              currentCameraDeviceId = s.deviceId;
              return availableCameras[i].facing || '';
            }
          }
          currentCameraDeviceId = s.deviceId;
        }
      }
    } catch (_) {}
    return '';
  }

  function switchCamera() {
    if (!room || !engineFullyConnected) {
      dlog('switch camera ignored: not fully connected');
      return Promise.resolve(null);
    }
    // The UI hides the control on a device with no back camera, but the
    // engine is a public API and the enumeration can land after a render,
    // so the refusal lives here too. Failing silently beats tearing the
    // live camera track down for a switch that cannot succeed.
    if (!canSwitchCamera) {
      dlog('switch camera ignored: no front/back camera pair on this device');
      return Promise.resolve(currentCameraFacing);
    }
    if (switchInFlight) {
      dlog('switch camera ignored: already switching');
      return Promise.resolve(currentCameraFacing);
    }
    if (!cameraEnabled) {
      dlog('switch camera ignored: camera off');
      return Promise.resolve(currentCameraFacing);
    }
    switchInFlight = true;
    dlog('switch camera requested', { from: currentCameraFacing || 'unknown' });

    return enumerateCameras().then(function () {
      var currentFacing = currentCameraFacing || detectCurrentFacing() || 'user';
      var nextFacing = currentFacing === 'environment' ? 'user' : 'environment';
      var lp = room.localParticipant;

      // Strategy 1 — facingMode exact via setCameraEnabled toggle.
      // LiveKit will release the prior camera track and create a new one
      // with the requested facingMode without renegotiating the room.
      function tryFacing(mode, exact) {
        var constraints = exact
          ? { facingMode: { exact: mode } }
          : { facingMode: mode };
        return lp.setCameraEnabled(false).then(function () {
          return lp.setCameraEnabled(true, constraints);
        });
      }

      // Strategy 2 — explicit deviceId from enumerated cameras.
      function tryDeviceId(deviceId) {
        return lp.setCameraEnabled(false).then(function () {
          return lp.setCameraEnabled(true, { deviceId: { exact: deviceId } });
        });
      }

      return tryFacing(nextFacing, true)
        .catch(function (e1) {
          dlog('switch camera facing exact failed; retrying ideal', describeError(e1));
          return tryFacing(nextFacing, false);
        })
        .catch(function (e2) {
          dlog('switch camera facing ideal failed; trying deviceId', describeError(e2));
          // Pick a different camera than currentDeviceId, prefer matching facing.
          var candidate = null;
          for (var i = 0; i < availableCameras.length; i++) {
            var c = availableCameras[i];
            if (c.deviceId === currentCameraDeviceId) continue;
            if (c.facing === nextFacing) { candidate = c; break; }
            if (!candidate) candidate = c;
          }
          if (!candidate) throw e2;
          return tryDeviceId(candidate.deviceId);
        })
        .then(function () {
          currentCameraFacing = nextFacing;
          cameraEnabled = !!room.localParticipant.isCameraEnabled;
          emitter.emit('cameraEnabled', cameraEnabled);
          var LK = window.LivekitClient;
          if (LK) emitLocalVideo(LK);
          dlog('switch camera success', { facing: nextFacing });
          dlog('camera facing changed', { facing: nextFacing });
          // Refresh enumeration (labels become available after permission).
          enumerateInFlight = false;
          enumerateCameras();
          switchInFlight = false;
          return nextFacing;
        })
        .catch(function (err) {
          switchInFlight = false;
          dlog('switch camera failed', describeError(err));
          // Best-effort: re-enable original camera so the call doesn't go dark.
          try {
            room.localParticipant.setCameraEnabled(true).then(function () {
              cameraEnabled = !!room.localParticipant.isCameraEnabled;
              emitter.emit('cameraEnabled', cameraEnabled);
              var LK = window.LivekitClient;
              if (LK) emitLocalVideo(LK);
            }, function () { /* swallow */ });
          } catch (_) {}
          emitter.emit('error', { code: 'camera_switch_failed', message: (err && err.message) || 'Camera switch failed.' });
          return currentCameraFacing;
        });
    });
  }

  function listCameras() {
    return enumerateCameras();
  }

  // Quality control intentionally remains a no-op until separately
  // re-enabled. Operator-side already exposes an in-call quality selector.
  function setVideoQuality(q) { return Promise.resolve(q || 'auto'); }

  // Auto-enumerate after the engine is fully connected so the UI can
  // show / hide the switch-camera button. Uses the 'state' event already
  // emitted by setState(). We hook this via a one-shot subscription.
  emitter.on('state', function (s) {
    if (s === 'connected' && engineFullyConnected) {
      enumerateCameras();
    }
    if (s === 'disconnected' || s === 'failed') {
      availableCameras = [];
      canSwitchCamera = false;
      currentCameraFacing = '';
      currentCameraDeviceId = '';
      switchInFlight = false;
      enumerateInFlight = false;
    }
  });

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
          cameras: availableCameras.slice(),
          canSwitchCamera: canSwitchCamera,
          currentCameraDeviceId: currentCameraDeviceId,
          currentCameraFacing: currentCameraFacing,
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
