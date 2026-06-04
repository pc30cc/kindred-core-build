/*!
 * Call Center Widget Runtime — independent from Chat Widget.
 * Mounts inside a Shadow DOM root. Idempotent.
 */
(function () {
  'use strict';
  if (window.CallCenterWidget && window.CallCenterWidget.__mounted__) return;

  var STATES = {
    LOADING: 'loading',
    ONLINE: 'online_available',
    OFFLINE: 'offline',
    PRE_CALL: 'pre_call_form',
    QUEUE: 'queue_waiting',
    RINGING: 'ringing',
    IN_CALL: 'in_call',
    ENDED: 'ended',
    CALLBACK: 'callback_form',
    ERROR: 'error',
  };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'on') Object.keys(attrs[k]).forEach(function (ev) { n.addEventListener(ev, attrs[k][ev]); });
      else if (k === 'html') n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c == null) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /**
   * CC-2H Phase 6 — Strip access_token query params and JWT-shaped
   * blobs from any string before it reaches the UI or console.log.
   */
  function sanitize(s) {
    if (s == null) return s;
    var str = String(s);
    str = str.replace(/access_token=[^&\s"']+/gi, 'access_token=[redacted]');
    str = str.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-token]');
    return str;
  }

  /**
   * CC-2H Phase 5 — Map common LiveKit transport failures to
   * actionable, secret-free messages.
   */
  function friendlyConnectError(raw) {
    var s = sanitize(String(raw || '')).toLowerCase();
    if (s.indexOf('v1 rtc path') >= 0 || s.indexOf('rtc/v1') >= 0 || s.indexOf('404') >= 0 && s.indexOf('validate') >= 0) {
      return 'The call media server does not support the RTC v1 path required by this client. Please ask the platform admin to upgrade LiveKit or fix the reverse proxy.';
    }
    if (s.indexOf('connection refused') >= 0 || s.indexOf('1006') >= 0) {
      return 'Could not reach the call media server. Please try again or contact support.';
    }
    if (s.indexOf('expired') >= 0 || s.indexOf('unauthorized') >= 0 || s.indexOf('invalid token') >= 0) {
      return 'Your call session expired. Please end and start a new call.';
    }
    return null;
  }

  // ── Visitor-side ringback (on-hold) audio ────────────────────────────
  var Ringback = (function () {
    var ctx = null, timer = null, active = false, audioEl = null, mode = 'off';
    function ensure() {
      try {
        if (typeof window === 'undefined') return null;
        var C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        if (!ctx) ctx = new C();
        if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
        return ctx;
      } catch (_) { return null; }
    }
    function ringOnce() {
      var c = ensure(); if (!c) return;
      try {
        var t0 = c.currentTime;
        // Classic phone-style "brrring" — two tones at 440/480Hz, 1.2s on, then silent.
        var pattern = [
          { f1: 440, f2: 480, at: 0.0, dur: 0.5 },
          { f1: 440, f2: 480, at: 0.55, dur: 0.5 },
        ];
        for (var i = 0; i < pattern.length; i++) {
          var n = pattern[i];
          [n.f1, n.f2].forEach(function (f) {
            var osc = c.createOscillator();
            var g = c.createGain();
            osc.type = 'sine'; osc.frequency.setValueAtTime(f, t0 + n.at);
            g.gain.setValueAtTime(0.0001, t0 + n.at);
            g.gain.exponentialRampToValueAtTime(0.08, t0 + n.at + 0.03);
            g.gain.setValueAtTime(0.08, t0 + n.at + n.dur - 0.05);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
            osc.connect(g).connect(c.destination);
            osc.start(t0 + n.at);
            osc.stop(t0 + n.at + n.dur + 0.02);
          });
        }
      } catch (_) {}
    }
    return {
      start: function (cfg) {
        if (active) return;
        active = true;
        mode = (cfg && cfg.ringback_mode) || 'tone';
        if (!cfg || cfg.ringback_enabled === false || mode === 'off') { active = false; return; }
        if (mode === 'music' && cfg.ringback_music_url) {
          try {
            audioEl = new Audio(cfg.ringback_music_url);
            audioEl.loop = true; audioEl.volume = 0.5;
            var p = audioEl.play();
            if (p && p.catch) p.catch(function () { /* autoplay blocked */ });
          } catch (_) {}
          return;
        }
        // tone
        ringOnce();
        timer = setInterval(ringOnce, 3000);
      },
      stop: function () {
        active = false;
        if (timer) { try { clearInterval(timer); } catch (_) {} timer = null; }
        if (audioEl) { try { audioEl.pause(); audioEl.src = ''; } catch (_) {} audioEl = null; }
      },
      isActive: function () { return active; },
    };
  })();

  function CallCenterWidgetCtor() {
    this.state = STATES.LOADING;
    this.bootstrap = null;
    this.apiBase = '';
    this.origin = '';
    this.session = null;
    this.callId = null;
    this.call = null;
    this.callbackId = null;
    this.error = null;
    this.queueStartedAt = null;
    this.timer = null;
    this.poll = null;
    this.open = false;
    this.formData = {
      name: '', email: '', phone: '', subject: '', message: '',
      call_type: 'voice', consent: false, department_id: '',
      callback_channel: 'audio', callback_urgency: 'normal',
      callback_when: 'now', callback_scheduled_for: '',
      hp_company: '',
    };
    this.callbackOpenedAt = 0;
    this.callbackCooldownUntil = 0;
  }

  CallCenterWidgetCtor.prototype.mount = function (opts) {
    if (this.__mounted__) return;
    this.__mounted__ = true;
    this.apiBase = opts.apiBase;
    this.origin = opts.origin;
    this.bootstrap = opts.bootstrap;
    this.session = opts.bootstrap && opts.bootstrap.session;

    // Pre-fill from previously identified contact (returning visitor).
    var prefill = opts.bootstrap && opts.bootstrap.visitor && opts.bootstrap.visitor.contact;
    if (prefill) {
      this.formData.name = prefill.name || '';
      this.formData.email = prefill.email || '';
      this.formData.phone = prefill.phone || '';
      this.identifiedContact = prefill;
    }

    var host = document.createElement('div');
    host.id = 'call-center-widget-host';
    host.style.all = 'initial';
    document.body.appendChild(host);
    var shadow = host.attachShadow({ mode: 'open' });
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = this.origin + '/call-widget/runtime.css';
    shadow.appendChild(link);
    var root = document.createElement('div');
    root.className = 'ccw-root';
    shadow.appendChild(root);
    this.root = root;

    if (!this.bootstrap || this.bootstrap.status !== 'ok') {
      this.state = STATES.OFFLINE; this.render(); return;
    }
    if (!this.bootstrap.provider_ready) {
      // still allow visit but warn — will block at request time
    }
    this.state = (this.isOnline() ? STATES.ONLINE : STATES.OFFLINE);
    this.render();
  };

  CallCenterWidgetCtor.prototype.isOnline = function () {
    var caps = this.bootstrap && this.bootstrap.capabilities;
    return !!caps && (caps.voice || caps.video);
  };

  CallCenterWidgetCtor.prototype.position = function () {
    var p = (this.bootstrap && this.bootstrap.config && this.bootstrap.config.widget_position) || 'right';
    return p === 'left' ? 'left' : 'right';
  };

  CallCenterWidgetCtor.prototype.api = function (path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (this.session) headers['x-cc-session'] = this.session;
    return fetch(this.apiBase + path, {
      method: opts.method || 'GET',
      headers: Object.assign(headers, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'include',
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  };

  CallCenterWidgetCtor.prototype.toggleOpen = function () {
    this.open = !this.open;
    if (this.open && this.state === STATES.OFFLINE) {
      // allow callback path
    }
    this.render();
  };

  CallCenterWidgetCtor.prototype.startCall = function (callType) {
    var cfg = this.bootstrap.config || {};
    this.formData.call_type = callType;
    // Auto-select sole department for the chosen channel, otherwise reset.
    var depts = (this.bootstrap && this.bootstrap.departments) || {};
    var list = (callType === 'video' ? depts.video : depts.voice) || [];
    this.formData.department_id = (list.length === 1) ? list[0].id : '';
    var rec = (this.bootstrap && this.bootstrap.recording) || {};
    var consentNeeded = !!(rec.effective_enabled && rec.consent_required);
    var passiveNotice = !!(rec.effective_enabled && !rec.consent_required);
    var depts2 = (this.bootstrap && this.bootstrap.departments) || {};
    var list2 = (callType === 'video' ? depts2.video : depts2.voice) || [];
    var needsDepartmentChoice = list2.length > 1;
    // Returning visitors with a known contact identity skip the pre-call
    // form unless we still need consent / department choice / a notice.
    var alreadyIdentified = !!(this.identifiedContact && this.identifiedContact.id);
    var needFormFields = cfg.pre_call_form_enabled && !alreadyIdentified;
    if (needFormFields || consentNeeded || passiveNotice || needsDepartmentChoice) {
      this.state = STATES.PRE_CALL; this.render(); return;
    }
    this.submitCall();
  };

  CallCenterWidgetCtor.prototype.submitCall = function () {
    var self = this;
    var rec = (this.bootstrap && this.bootstrap.recording) || {};
    var consentNeeded = !!(rec.effective_enabled && rec.consent_required);
    if (consentNeeded && !this.formData.consent) {
      this.error = 'Recording consent is required to continue.';
      this.render(); return;
    }
    var consentAt = this.formData.consent ? new Date().toISOString() : null;
    this.error = null;
    this.state = STATES.LOADING; this.render();
    this.api('/api/call-widget/calls/request', {
      method: 'POST',
      body: {
        call_type: this.formData.call_type,
        visitor_name: this.formData.name || null,
        visitor_email: this.formData.email || null,
        visitor_phone: this.formData.phone || null,
        subject: this.formData.subject || null,
        page_url: location.href,
        page_title: document.title,
        consent_recording: !!this.formData.consent,
        recording_consent: !!this.formData.consent,
        recording_consent_at: consentAt,
        department_id: this.formData.department_id || null,
      },
    }).then(function (r) {
      if (!r.ok) {
        var code = r.body && r.body.error;
        if (code === 'recording_consent_required') {
          self.error = 'Please accept the recording consent to start the call.';
          self.state = STATES.PRE_CALL; self.render(); return;
        }
        if (code === 'department_channel_disabled' || code === 'department_not_found') {
          self.error = 'This department is not available for this call type. Please choose another department.';
          self.state = STATES.PRE_CALL; self.render(); return;
        }
        self.error = (r.body && (r.body.message || r.body.error)) || 'Failed to start call.';
        self.state = STATES.ERROR; self.render(); return;
      }
      self.session = r.body.session || self.session;
      if (r.body.contact && r.body.contact.id) {
        self.identifiedContact = r.body.contact;
        self.formData.name = r.body.contact.name || self.formData.name || '';
        self.formData.email = r.body.contact.email || self.formData.email || '';
        self.formData.phone = r.body.contact.phone || self.formData.phone || '';
      }
      self.callId = r.body.call_id;
      self.queueStartedAt = Date.now();
      self.state = STATES.QUEUE;
      self.render();
      self.startPolling();
      self.startTimer();
    }).catch(function (e) {
      self.error = sanitize(String(e && e.message || e));
      self.state = STATES.ERROR; self.render();
    });
  };

  CallCenterWidgetCtor.prototype.startTimer = function () {
    var self = this;
    this.stopTimer();
    this.timer = setInterval(function () {
      var t = self.root.querySelector('.ccw-wait-timer');
      if (t && self.queueStartedAt) t.textContent = fmtTime(Date.now() - self.queueStartedAt);
    }, 1000);
  };
  CallCenterWidgetCtor.prototype.stopTimer = function () { if (this.timer) clearInterval(this.timer); this.timer = null; };

  CallCenterWidgetCtor.prototype.startPolling = function () {
    var self = this;
    this.stopPolling();
    this.poll = setInterval(function () { self.pollOnce(); }, 5000);
    self.pollOnce();
  };
  CallCenterWidgetCtor.prototype.stopPolling = function () { if (this.poll) clearInterval(this.poll); this.poll = null; };

  CallCenterWidgetCtor.prototype.pollOnce = function () {
    if (!this.callId) return;
    var self = this;
    this.api('/api/call-widget/calls/' + this.callId + '/status').then(function (r) {
      if (!r.ok) return;
      var c = r.body.call; if (!c) return;
      self.call = c;
      if (['cancelled', 'ended', 'missed', 'failed'].indexOf(c.state) >= 0) {
        self.stopPolling(); self.stopTimer();
        self.state = STATES.ENDED; self.render(); return;
      }
      if (['active', 'ringing', 'connecting'].indexOf(c.state) >= 0) {
        if (self.state !== STATES.IN_CALL) {
          self.state = STATES.IN_CALL; self.render();
          self.requestJoinToken();
        }
      }
    });
  };

  CallCenterWidgetCtor.prototype.requestJoinToken = function () {
    var self = this;
    this.api('/api/call-widget/calls/' + this.callId + '/join-token', { method: 'POST' }).then(function (r) {
      if (!r.ok) {
        self.connectStatus = 'pending';
        self.render(); return;
      }
      self.joinInfo = r.body;
      self.connectStatus = 'token_ready';
      self.render();
      self.connectMedia();
    }).catch(function () { self.connectStatus = 'pending'; self.render(); });
  };

  CallCenterWidgetCtor.prototype.connectMedia = function () {
    var self = this;
    var info = this.joinInfo || {};
    var connect = info.connect || {};
    if (!connect.supported || !connect.server_url || !info.token) {
      var reason = connect.reason || 'media_not_configured';
      self.connectStatus = reason === 'livekit_url_missing' ? 'provider_client_not_configured'
        : reason === 'provider_client_not_supported' ? 'provider_client_not_supported'
        : 'media_not_configured';
      self.render();
      return;
    }
    if (connect.provider !== 'livekit') {
      self.connectStatus = 'provider_client_not_supported';
      self.render();
      return;
    }
    self.connectStatus = 'loading_media_client';
    self.render();
    var LK = window.LivekitClient || window.LiveKit || null;
    if (!LK) {
      self.connectStatus = 'media_client_missing';
      self.render();
      return;
    }
    if (!LK.Room) {
      self.connectStatus = 'media_client_invalid';
      self.render();
      return;
    }
    self.connectStatus = 'connecting_media';
    self.render();
    try {
      var room = new LK.Room({ adaptiveStream: true, dynacast: true });
      self.lkRoom = room;
      self._attachedTracks = self._attachedTracks || {};
      var wantVideo = (self.call && self.call.call_type === 'video') || self.formData.call_type === 'video';
      var RE = LK.RoomEvent || {};
      room.on(RE.Disconnected || 'disconnected', function (reason) {
        var r = String(reason || '').toLowerCase();
        if (r.indexOf('expired') >= 0 || r.indexOf('token') >= 0) {
          self.connectStatus = 'token_expired';
        } else if (self.connectStatus !== 'in_call_ended') {
          self.connectStatus = 'media_disconnected';
        }
        self.render();
      });
      room.on(RE.Reconnecting || 'reconnecting', function () {
        self.connectStatus = 'media_reconnecting'; self.render();
      });
      room.on(RE.Reconnected || 'reconnected', function () {
        self.connectStatus = self._remoteCount > 0 ? 'in_call' : 'waiting_for_operator';
        self.render();
      });
      function attach(track, participant) {
        try {
          var sid = track.sid || track.trackSid || (participant && participant.identity) + ':' + track.kind;
          if (self._attachedTracks[sid]) return;
          var el = track.attach();
          el.autoplay = true;
          if (track.kind === 'video') { el.playsInline = true; }
          el.setAttribute('data-track-sid', sid);
          self._attachedTracks[sid] = el;
          self._remoteHolder && self._remoteHolder.appendChild(el);
        } catch (_) {}
      }
      function detach(track) {
        try {
          var sid = track.sid || track.trackSid;
          var el = sid && self._attachedTracks[sid];
          if (el) { try { el.remove(); } catch (_) {} delete self._attachedTracks[sid]; }
          try { track.detach && track.detach(); } catch (_) {}
        } catch (_) {}
      }
      room.on(RE.TrackSubscribed || 'trackSubscribed', function (track, _pub, participant) {
        attach(track, participant);
      });
      room.on(RE.TrackUnsubscribed || 'trackUnsubscribed', function (track) {
        detach(track);
      });
      room.on(RE.ParticipantConnected || 'participantConnected', function (p) {
        self._remoteCount = (self._remoteCount || 0) + 1;
        self.connectStatus = 'operator_connected';
        self.render();
        try {
          var pubs = p.trackPublications || p.tracks;
          pubs && pubs.forEach && pubs.forEach(function (pub) {
            if (pub && pub.track) attach(pub.track, p);
          });
        } catch (_) {}
      });
      room.on(RE.ParticipantDisconnected || 'participantDisconnected', function () {
        self._remoteCount = Math.max(0, (self._remoteCount || 1) - 1);
        if (self._remoteCount === 0) {
          self.connectStatus = 'operator_left';
          self.render();
        }
      });
      room.connect(connect.server_url, info.token).then(function () {
        return room.localParticipant.setMicrophoneEnabled(true).catch(function (err) {
          self.connectStatus = 'microphone_permission_denied';
          self.error = sanitize(String(err && err.message || err));
          self.render();
          throw err;
        });
      }).then(function () {
        if (wantVideo) {
          return room.localParticipant.setCameraEnabled(true).catch(function (err) {
            self.connectStatus = 'camera_permission_denied';
            self.error = sanitize(String(err && err.message || err));
            self.render();
          });
        }
      }).then(function () {
        if (self.connectStatus !== 'microphone_permission_denied' && self.connectStatus !== 'camera_permission_denied') {
          // Detect already-present remote participants
          try {
            var existing = [];
            if (room.remoteParticipants && room.remoteParticipants.forEach) {
              room.remoteParticipants.forEach(function (p) { existing.push(p); });
            }
            self._remoteCount = existing.length;
            existing.forEach(function (p) {
              var pubs = p.trackPublications || p.tracks;
              pubs && pubs.forEach && pubs.forEach(function (pub) {
                if (pub && pub.track) attach(pub.track, p);
              });
            });
          } catch (_) {}
          self.connectStatus = self._remoteCount > 0 ? 'in_call' : 'waiting_for_operator';
          self.micOn = true; self.camOn = !!wantVideo;
          self.render();
        }
      }).catch(function (err) {
        if (self.connectStatus !== 'microphone_permission_denied' && self.connectStatus !== 'camera_permission_denied') {
          var rawEm = String(err && err.message || err);
          var em = sanitize(rawEm).toLowerCase();
          var friendly = friendlyConnectError(rawEm);
          if (em.indexOf('expired') >= 0 || em.indexOf('unauthorized') >= 0 || em.indexOf('invalid token') >= 0) {
            self.connectStatus = 'token_expired';
          } else if (em.indexOf('rtc/v1') >= 0 || em.indexOf('v1 rtc') >= 0) {
            self.connectStatus = 'rtc_v1_unsupported';
            self.error = friendly;
          } else {
            self.connectStatus = 'room_connect_failed';
            self.error = friendly || sanitize(rawEm);
          }
          self.render();
        }
      });
    } catch (err) {
      self.connectStatus = 'room_connect_failed';
      self.error = sanitize(String(err && err.message || err));
      self.render();
    }
  };

  CallCenterWidgetCtor.prototype.toggleMic = function () {
    if (!this.lkRoom) return;
    var next = !this.micOn;
    var self = this;
    this.lkRoom.localParticipant.setMicrophoneEnabled(next).then(function () {
      self.micOn = next; self.render();
    });
  };
  CallCenterWidgetCtor.prototype.toggleCam = function () {
    if (!this.lkRoom) return;
    var next = !this.camOn;
    var self = this;
    this.lkRoom.localParticipant.setCameraEnabled(next).then(function () {
      self.camOn = next; self.render();
    });
  };
  CallCenterWidgetCtor.prototype.disconnectRoom = function () {
    try { if (this.lkRoom) this.lkRoom.disconnect(); } catch (_) {}
    this.lkRoom = null;
    if (this._attachedTracks) {
      var keys = Object.keys(this._attachedTracks);
      for (var i = 0; i < keys.length; i++) {
        try { this._attachedTracks[keys[i]].remove(); } catch (_) {}
      }
    }
    this._attachedTracks = {};
    this._remoteCount = 0;
  };

  CallCenterWidgetCtor.prototype.cancelCall = function () {
    var self = this;
    this.disconnectRoom();
    if (!this.callId) { this.reset(); return; }
    this.api('/api/call-widget/calls/' + this.callId + '/cancel', { method: 'POST' }).then(function () {
      self.stopPolling(); self.stopTimer();
      self.reset();
    });
  };

  CallCenterWidgetCtor.prototype.reset = function () {
    this.disconnectRoom();
    this.callId = null; this.call = null; this.queueStartedAt = null;
    this.connectStatus = null; this.joinInfo = null; this.error = null;
    this.micOn = false; this.camOn = false; this._remoteHolder = null;
    this.state = this.isOnline() ? STATES.ONLINE : STATES.OFFLINE;
    this.render();
  };

  CallCenterWidgetCtor.prototype.openCallback = function () {
    var depts = (this.bootstrap && this.bootstrap.departments) || {};
    var list = depts.callback || [];
    this.formData.department_id = (list.length === 1) ? list[0].id : '';
    this.formData.hp_company = '';
    this.callbackOpenedAt = Date.now();
    this.error = null;
    this.state = STATES.CALLBACK;
    this.render();
  };

  CallCenterWidgetCtor.prototype.submitCallback = function () {
    var self = this;
    this.error = null;
    var policy = (this.bootstrap && this.bootstrap.callback_policy) || {};
    // Client-side cooldown guard (server still enforces).
    if (this.callbackCooldownUntil && Date.now() < this.callbackCooldownUntil) {
      var leftSec = Math.ceil((this.callbackCooldownUntil - Date.now()) / 1000);
      this.error = 'Please wait ' + leftSec + 's before sending another request.';
      this.render(); return;
    }
    // Require contact if the platform demands it.
    if (policy.require_contact) {
      var email = (this.formData.email || '').trim();
      var phone = (this.formData.phone || '').trim();
      var alreadyId = !!(this.identifiedContact && this.identifiedContact.id);
      if (!alreadyId && !email && !phone) {
        this.error = 'Please provide your email or phone so we can reach you.';
        this.render(); return;
      }
    }
    // Minimum message length.
    var minMsg = Number(policy.min_message_length || 0);
    if (minMsg > 0) {
      var msg = (this.formData.message || '').trim();
      if (msg.length < minMsg) {
        this.error = 'Please describe your request in at least ' + minMsg + ' characters.';
        this.render(); return;
      }
    }
    var scheduledIso = null;
    if (this.formData.callback_when === 'later' && this.formData.callback_scheduled_for) {
      var t = new Date(this.formData.callback_scheduled_for);
      if (!isNaN(t.getTime()) && t.getTime() > Date.now() - 60000) {
        scheduledIso = t.toISOString();
      } else {
        this.error = 'Please pick a valid future time.';
        this.render(); return;
      }
    }
    this.api('/api/call-widget/callbacks/request', {
      method: 'POST',
      body: {
        name: this.formData.name || null,
        email: this.formData.email || null,
        phone: this.formData.phone || null,
        subject: this.formData.subject || null,
        message: this.formData.message || null,
        channel: this.formData.callback_channel || 'audio',
        urgency: this.formData.callback_urgency || 'normal',
        scheduled_for: scheduledIso,
        page_url: location.href,
        department_id: this.formData.department_id || null,
        hp_company: this.formData.hp_company || '',
        form_opened_at: this.callbackOpenedAt || null,
      },
    }).then(function (r) {
      if (!r.ok) {
        var code = r.body && r.body.error;
        if (code === 'department_channel_disabled' || code === 'department_not_found') {
          self.error = 'This department is not available for this call type. Please choose another department.';
        } else if (code === 'contact_required') {
          self.error = 'Please provide your email or phone so we can reach you.';
        } else if (code === 'message_too_short') {
          var m = (r.body && r.body.min) || 1;
          self.error = 'Please describe your request in at least ' + m + ' characters.';
        } else if (code === 'too_fast') {
          self.error = 'That was too fast. Please take a moment to fill in the form.';
        } else if (code === 'cooldown_active') {
          var ra = (r.body && r.body.retry_after) || 60;
          self.callbackCooldownUntil = Date.now() + ra * 1000;
          self.error = 'You already requested a callback. Please wait ' + ra + 's before sending another.';
        } else if (code === 'rate_limited_ip') {
          self.error = 'Too many callback requests from your network. Please try again later.';
        } else if (code === 'feature_not_available') {
          self.error = 'Callback requests are currently unavailable.';
        } else {
          self.error = (r.body && (r.body.error || r.body.message)) || 'Failed.';
        }
        self.render(); return;
      }
      self.callbackId = r.body.callback_id;
      var pol = (self.bootstrap && self.bootstrap.callback_policy) || {};
      if (pol.cooldown_seconds) {
        self.callbackCooldownUntil = Date.now() + Number(pol.cooldown_seconds) * 1000;
      }
      self.state = STATES.ENDED;
      self.render();
    });
  };

  CallCenterWidgetCtor.prototype.render = function () {
    if (!this.root) return;
    var self = this;
    var pos = this.position();
    this.root.innerHTML = '';
    var caps = (this.bootstrap && this.bootstrap.capabilities) || {};
    var cfg = (this.bootstrap && this.bootstrap.config) || {};

    // Launcher always present
    var launcherText = this.isOnline() ? 'Call us' : 'Request callback';
    var launcher = el('button', {
      class: 'ccw-launcher ' + pos,
      on: { click: function () { self.toggleOpen(); } },
    }, ['📞 ', launcherText]);
    this.root.appendChild(launcher);

    if (!this.open) return;

    var panel = el('div', { class: 'ccw-panel ' + pos });
    var header = el('div', { class: 'ccw-header' }, [
      cfg.avatar_url ? el('img', { src: cfg.avatar_url, alt: '' }) : null,
      el('div', {}, [
        el('div', { class: 'ccw-title' }, [cfg.display_name || 'Support']),
        el('div', { class: 'ccw-sub' }, [this.isOnline() ? 'Available now' : 'Currently offline']),
      ]),
      el('button', { class: 'ccw-close', on: { click: function () { self.toggleOpen(); } } }, ['×']),
    ]);
    panel.appendChild(header);

    var body = el('div', { class: 'ccw-body' });
    body.appendChild(this.renderState(caps, cfg));
    panel.appendChild(body);
    this.root.appendChild(panel);
  };

  CallCenterWidgetCtor.prototype.renderState = function (caps, cfg) {
    var self = this;
    switch (this.state) {
      case STATES.LOADING:
        return el('div', { class: 'ccw-stack' }, [el('div', { class: 'ccw-spinner' }), el('div', { class: 'ccw-muted' }, ['Loading…'])]);

      case STATES.OFFLINE: {
        var off = el('div', { class: 'ccw-stack' }, [
          el('div', {}, ['We are currently offline. Leave a callback request and we will reach out.']),
        ]);
        if (caps.callback) off.appendChild(el('button', { class: 'ccw-btn primary', on: { click: function () { self.openCallback(); } } }, ['Request callback']));
        return off;
      }

      case STATES.ONLINE: {
        var pol = (self.bootstrap && self.bootstrap.callback_policy) || {};
        var showCbOnline = pol.show_when_online !== false; // default true
        var box = el('div', { class: 'ccw-stack' }, [
          el('div', {}, ['Talk with our team in seconds.']),
        ]);
        var row = el('div', { class: 'ccw-row' });
        if (caps.voice) row.appendChild(el('button', { class: 'ccw-btn primary', on: { click: function () { self.startCall('voice'); } } }, ['🎙 Voice call']));
        if (caps.video) row.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.startCall('video'); } } }, ['🎥 Video call']));
        box.appendChild(row);
        if (caps.callback && showCbOnline) {
          box.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.openCallback(); } } }, ['Request callback instead']));
        }
        return box;
      }

      case STATES.PRE_CALL:
        return this.renderForm(cfg, /*forCall*/true);

      case STATES.CALLBACK:
        return this.renderForm(cfg, /*forCall*/false);

      case STATES.QUEUE: {
        return el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-card' }, [
            el('div', { class: 'ccw-pill' }, ['In queue']),
            el('div', { class: 'ccw-label' }, ['Waiting for an operator…']),
            el('div', { class: 'ccw-wait-timer', html: '0:00' }),
          ]),
          el('button', { class: 'ccw-btn danger', on: { click: function () { self.cancelCall(); } } }, ['Cancel']),
        ]);
      }

      case STATES.IN_CALL: {
        var status = self.connectStatus || 'connecting';
        var msg = 'Call accepted, connecting…';
        if (status === 'in_call') msg = 'Connected';
        if (status === 'waiting_for_operator') msg = 'Operator joining…';
        if (status === 'operator_connected') msg = 'Operator connected';
        if (status === 'operator_left') msg = 'Operator left the call.';
        if (status === 'media_reconnecting') msg = 'Reconnecting media…';
        if (status === 'media_disconnected') msg = 'Media disconnected.';
        if (status === 'connecting_media') msg = 'Connecting audio/video…';
        if (status === 'fallback') msg = 'Call accepted. Please continue on the operator side.';
        if (status === 'accepted_no_sdk') msg = 'Call accepted. Audio/video client unavailable on this page.';
        if (status === 'media_not_configured') msg = 'Call accepted, media connection is not configured yet.';
        if (status === 'provider_client_not_configured') msg = 'Call accepted, but the media server URL is not configured. Please request a callback.';
        if (status === 'provider_client_not_supported') msg = 'Call accepted, but this provider has no in-browser client.';
        if (status === 'media_client_missing') msg = 'Media client is not loaded. Call room is ready but the browser client is missing.';
        if (status === 'media_client_invalid') msg = 'Media client loaded but is incompatible with this widget.';
        if (status === 'loading_media_client') msg = 'Loading media client…';
        if (status === 'microphone_permission_denied') msg = 'Microphone permission denied. Please allow access and try again.';
        if (status === 'camera_permission_denied') msg = 'Camera permission denied. Audio call continues without video.';
        if (status === 'room_connect_failed') msg = 'Failed to connect to the call room: ' + (self.error || 'unknown');
        if (status === 'token_expired') msg = 'Your session expired. Please end and start a new call.';
        var card = el('div', { class: 'ccw-card' }, [
          el('div', { class: 'ccw-pill' }, [status === 'in_call' || status === 'operator_connected' ? 'In call' : status === 'waiting_for_operator' ? 'Connected — waiting' : 'Connecting']),
          el('div', { class: 'ccw-label' }, [msg]),
        ]);
        // Recording indicator (passive). Backend status drives this; never trust client.
        var recBoot = (self.bootstrap && self.bootstrap.recording) || {};
        var callRecState = self.call && self.call.recording_state;
        if (callRecState === 'recording') {
          card.appendChild(el('div', { class: 'ccw-pill', style: 'background:#dc2626;color:#fff;margin-top:6px;' }, ['● Recording in progress']));
        } else if (recBoot.effective_enabled) {
          card.appendChild(el('div', { class: 'ccw-muted', style: 'margin-top:6px;' }, [
            'Recording may start after the operator begins the call.',
          ]));
        }
        var media = el('div', { class: 'ccw-media' });
        self._remoteHolder = media;
        // Re-attach existing tracks if any (re-render can wipe DOM)
        if (self._attachedTracks) {
          var keys = Object.keys(self._attachedTracks);
          for (var i = 0; i < keys.length; i++) {
            try { media.appendChild(self._attachedTracks[keys[i]]); } catch (_) {}
          }
        }
        card.appendChild(media);
        var controls = el('div', { class: 'ccw-row' });
        if (status === 'in_call' || status === 'operator_connected' || status === 'waiting_for_operator' || status === 'media_reconnecting') {
          controls.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.toggleMic(); } } }, [self.micOn ? '🎙 Mute' : '🎙 Unmute']));
          var wantVideo = (self.call && self.call.call_type === 'video') || self.formData.call_type === 'video';
          if (wantVideo) {
            controls.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.toggleCam(); } } }, [self.camOn ? '🎥 Camera off' : '🎥 Camera on']));
          }
        }
        controls.appendChild(el('button', { class: 'ccw-btn danger', on: { click: function () { self.cancelCall(); } } }, ['End']));
        return el('div', { class: 'ccw-stack' }, [card, controls]);
      }

      case STATES.ENDED: {
        if (self.callbackId) {
          var ref = String(self.callbackId).slice(0, 8).toUpperCase();
          var when = self.formData.callback_when === 'later' && self.formData.callback_scheduled_for
            ? new Date(self.formData.callback_scheduled_for).toLocaleString()
            : 'as soon as possible';
          var chLabel = self.formData.callback_channel === 'video' ? 'Video callback' : 'Phone callback';
          return el('div', { class: 'ccw-stack' }, [
            el('div', { class: 'ccw-success-card' }, [
              el('div', { class: 'ccw-success-icon' }, ['✓']),
              el('div', { class: 'ccw-success-title' }, ['Callback scheduled']),
              el('div', { class: 'ccw-muted', style: 'text-align:center;' }, ['Our team will reach out ' + when + '.']),
              el('div', { class: 'ccw-ref-row' }, [
                el('span', { class: 'ccw-ref-label' }, ['Reference']),
                el('code', { class: 'ccw-ref-code' }, [ref]),
              ]),
              el('div', { class: 'ccw-ref-row' }, [
                el('span', { class: 'ccw-ref-label' }, ['Type']),
                el('span', {}, [chLabel]),
              ]),
            ]),
            el('button', { class: 'ccw-btn primary', on: { click: function () { self.reset(); } } }, ['Done']),
          ]);
        }
        return el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-card' }, [el('div', {}, ['Call ended.'])]),
          el('button', { class: 'ccw-btn primary', on: { click: function () { self.reset(); } } }, ['Done']),
        ]);
      }

      case STATES.ERROR:
        return el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-error' }, ['Error: ' + (self.error || 'unknown')]),
          el('button', { class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, ['Back']),
        ]);
    }
    return el('div', {}, ['…']);
  };

  CallCenterWidgetCtor.prototype.renderForm = function (cfg, forCall) {
    var self = this;
    var policy = (self.bootstrap && self.bootstrap.callback_policy) || {};
    var box = el('div', { class: 'ccw-stack' });
    if (!forCall) {
      box.appendChild(el('div', { class: 'ccw-cb-intro' }, [
        el('div', { class: 'ccw-cb-intro-title' }, ['Request a callback']),
        el('div', { class: 'ccw-muted' }, ['Tell us how to reach you — our team calls back fast.']),
      ]));
    }
    // Channel segmented control (callback only)
    if (!forCall) {
      var caps2 = (self.bootstrap && self.bootstrap.capabilities) || {};
      box.appendChild(el('label', { class: 'ccw-label' }, ['Callback type']));
      var seg = el('div', { class: 'ccw-segment' });
      function mkSeg(val, label) {
        var active = (self.formData.callback_channel === val);
        var b = el('button', { class: 'ccw-seg-btn' + (active ? ' active' : ''), type: 'button',
          on: { click: function () { self.formData.callback_channel = val; self.render(); } } }, [label]);
        return b;
      }
      seg.appendChild(mkSeg('audio', '🎙 Phone'));
      if (caps2.video) seg.appendChild(mkSeg('video', '🎥 Video'));
      box.appendChild(seg);
    }
    // Department dropdown (only if backend exposed options for this channel).
    var depts = (self.bootstrap && self.bootstrap.departments) || {};
    var deptList;
    if (forCall) {
      var ct = self.formData.call_type === 'video' ? 'video' : 'voice';
      deptList = depts[ct] || [];
    } else {
      deptList = depts.callback || [];
    }
    if (deptList.length > 0) {
      box.appendChild(el('label', { class: 'ccw-label' }, ['Department']));
      var sel = el('select', { class: 'ccw-input' });
      var ph = el('option', { value: '' }, ['Choose a department']);
      sel.appendChild(ph);
      for (var di = 0; di < deptList.length; di++) {
        var d = deptList[di];
        var opt = el('option', { value: d.id }, [d.name]);
        if (self.formData.department_id === d.id) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', function (e) { self.formData.department_id = e.target.value; });
      box.appendChild(sel);
    }
    var alreadyIdentified = !!(self.identifiedContact && self.identifiedContact.id);
    if (alreadyIdentified) {
      var knownName = self.identifiedContact.name || self.formData.name || 'Known contact';
      box.appendChild(el('div', { class: 'ccw-known-contact' }, [
        el('div', { class: 'ccw-known-dot' }, ['✓']),
        el('div', {}, [
          el('div', { class: 'ccw-known-title' }, [knownName]),
          el('div', { class: 'ccw-muted' }, ['Contact details already saved']),
        ]),
      ]));
    }
    var fields = alreadyIdentified
      ? [['subject', 'Subject', 'text']]
      : [
        ['name', 'Full name', 'text'],
        ['email', !forCall && policy.require_contact ? 'Email *' : 'Email', 'email'],
        ['phone', !forCall && policy.require_contact ? 'Phone *' : 'Phone', 'tel'],
        ['subject', 'Subject', 'text'],
      ];
    fields.forEach(function (f) {
      var label = el('label', { class: 'ccw-label' }, [f[1]]);
      var input = el('input', { class: 'ccw-input', type: f[2], value: self.formData[f[0]] || '' });
      input.addEventListener('input', function (e) { self.formData[f[0]] = e.target.value; });
      box.appendChild(label);
      box.appendChild(input);
    });
    if (!forCall && policy.require_contact && !alreadyIdentified) {
      box.appendChild(el('div', { class: 'ccw-muted', style: 'font-size:11px;margin-top:-4px;' }, [
        '* Email or phone is required so we can reach you.',
      ]));
    }
    if (!forCall) {
      // Honeypot (anti-bot): visually hidden, never tabbable.
      if (policy.honeypot_enabled !== false) {
        var hp = el('input', {
          type: 'text', name: 'company_website', autocomplete: 'off', tabindex: '-1', 'aria-hidden': 'true',
          style: 'position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;opacity:0;',
        });
        hp.value = self.formData.hp_company || '';
        hp.addEventListener('input', function (e) { self.formData.hp_company = e.target.value; });
        box.appendChild(hp);
      }
      // Message textarea
      var msgLabel = policy.min_message_length > 0
        ? 'Message (min ' + policy.min_message_length + ' chars)'
        : 'Message (optional)';
      box.appendChild(el('label', { class: 'ccw-label' }, [msgLabel]));
      var ta = el('textarea', { class: 'ccw-textarea', placeholder: 'Briefly describe what you need help with…' });
      ta.value = self.formData.message || '';
      ta.addEventListener('input', function (e) { self.formData.message = e.target.value; });
      box.appendChild(ta);
      // When
      box.appendChild(el('label', { class: 'ccw-label' }, ['When should we call?']));
      var when = el('div', { class: 'ccw-segment' });
      function mkWhen(val, label) {
        var active = (self.formData.callback_when === val);
        return el('button', { class: 'ccw-seg-btn' + (active ? ' active' : ''), type: 'button',
          on: { click: function () { self.formData.callback_when = val; self.render(); } } }, [label]);
      }
      when.appendChild(mkWhen('now', '⚡ ASAP'));
      when.appendChild(mkWhen('later', '🗓 Schedule'));
      box.appendChild(when);
      if (self.formData.callback_when === 'later') {
        var dt = el('input', { class: 'ccw-input', type: 'datetime-local' });
        dt.value = self.formData.callback_scheduled_for || '';
        var minDate = new Date(Date.now() + 5 * 60000);
        dt.min = new Date(minDate.getTime() - minDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        dt.addEventListener('input', function (e) { self.formData.callback_scheduled_for = e.target.value; });
        box.appendChild(dt);
      }
      // Urgency
      box.appendChild(el('label', { class: 'ccw-label' }, ['Priority']));
      var ur = el('div', { class: 'ccw-segment' });
      function mkUr(val, label) {
        var active = (self.formData.callback_urgency === val);
        return el('button', { class: 'ccw-seg-btn' + (active ? ' active' : '') + (val === 'urgent' && active ? ' danger' : ''), type: 'button',
          on: { click: function () { self.formData.callback_urgency = val; self.render(); } } }, [label]);
      }
      ur.appendChild(mkUr('normal', 'Normal'));
      ur.appendChild(mkUr('urgent', '🔥 Urgent'));
      box.appendChild(ur);
    }
    if (forCall) {
      var rec = (self.bootstrap && self.bootstrap.recording) || {};
      if (rec.effective_enabled && rec.consent_required) {
        var cb = el('label', { class: 'ccw-checkbox' });
        var ci = el('input', { type: 'checkbox' });
        ci.checked = !!self.formData.consent;
        ci.addEventListener('change', function (e) { self.formData.consent = !!e.target.checked; });
        cb.appendChild(ci);
        cb.appendChild(document.createTextNode(' I consent to this call being recorded for quality and security. (required)'));
        box.appendChild(cb);
      } else if (rec.effective_enabled) {
        box.appendChild(el('div', { class: 'ccw-muted' }, [
          'This call may be recorded for quality and security.',
        ]));
      }
    }
    if (self.error) box.appendChild(el('div', { class: 'ccw-error' }, [self.error]));
    var actions = el('div', { class: 'ccw-row' }, [
      el('button', { class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, ['Back']),
      el('button', { class: 'ccw-btn primary', on: { click: function () { forCall ? self.submitCall() : self.submitCallback(); } } },
        [forCall ? 'Start call' : 'Send request']),
    ]);
    box.appendChild(actions);
    return box;
  };

  window.CallCenterWidget = new CallCenterWidgetCtor();
})();