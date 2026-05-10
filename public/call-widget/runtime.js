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
    this.formData = { name: '', email: '', phone: '', subject: '', call_type: 'voice', consent: false };
  }

  CallCenterWidgetCtor.prototype.mount = function (opts) {
    if (this.__mounted__) return;
    this.__mounted__ = true;
    this.apiBase = opts.apiBase;
    this.origin = opts.origin;
    this.bootstrap = opts.bootstrap;
    this.session = opts.bootstrap && opts.bootstrap.session;

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
    if (cfg.pre_call_form_enabled || cfg.recording_consent_required) {
      this.state = STATES.PRE_CALL; this.render(); return;
    }
    this.submitCall();
  };

  CallCenterWidgetCtor.prototype.submitCall = function () {
    var self = this;
    var cfg = this.bootstrap.config || {};
    if (cfg.recording_consent_required && !this.formData.consent) {
      this.error = 'Recording consent is required to continue.';
      this.render(); return;
    }
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
      },
    }).then(function (r) {
      if (!r.ok) {
        self.error = (r.body && (r.body.error || r.body.message)) || 'Failed to start call.';
        self.state = STATES.ERROR; self.render(); return;
      }
      self.session = r.body.session || self.session;
      self.callId = r.body.call_id;
      self.queueStartedAt = Date.now();
      self.state = STATES.QUEUE;
      self.render();
      self.startPolling();
      self.startTimer();
    }).catch(function (e) {
      self.error = String(e && e.message || e);
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
    // Provider client connection: only LiveKit supported as in-page connection
    // here. If the provider/SDK isn't usable safely, we degrade to "Call accepted,
    // connecting..." so the visitor sees a clear state instead of an error.
    var self = this;
    var info = self.joinInfo;
    if (!info || info.provider !== 'livekit') {
      self.connectStatus = 'fallback';
      self.render();
      return;
    }
    // Lazy-load LiveKit client UMD if available; else degrade gracefully.
    if (window.LivekitClient && window.LivekitClient.Room) {
      try {
        var Room = window.LivekitClient.Room;
        var room = new Room({ adaptiveStream: true, dynacast: true });
        room.connect(info.provider_room_id ? '' : '', info.token).then(function () {
          self.connectStatus = 'connected';
          self.render();
        }).catch(function (e) {
          self.connectStatus = 'failed';
          self.error = String(e && e.message || e);
          self.render();
        });
      } catch (e) {
        self.connectStatus = 'failed';
        self.error = String(e && e.message || e);
        self.render();
      }
    } else {
      // No SDK present — show accepted state without auto-connecting.
      self.connectStatus = 'accepted_no_sdk';
      self.render();
    }
  };

  CallCenterWidgetCtor.prototype.cancelCall = function () {
    var self = this;
    if (!this.callId) { this.reset(); return; }
    this.api('/api/call-widget/calls/' + this.callId + '/cancel', { method: 'POST' }).then(function () {
      self.stopPolling(); self.stopTimer();
      self.reset();
    });
  };

  CallCenterWidgetCtor.prototype.reset = function () {
    this.callId = null; this.call = null; this.queueStartedAt = null;
    this.connectStatus = null; this.joinInfo = null; this.error = null;
    this.state = this.isOnline() ? STATES.ONLINE : STATES.OFFLINE;
    this.render();
  };

  CallCenterWidgetCtor.prototype.openCallback = function () {
    this.state = STATES.CALLBACK;
    this.render();
  };

  CallCenterWidgetCtor.prototype.submitCallback = function () {
    var self = this;
    this.error = null;
    this.api('/api/call-widget/callbacks/request', {
      method: 'POST',
      body: {
        name: this.formData.name || null,
        email: this.formData.email || null,
        phone: this.formData.phone || null,
        subject: this.formData.subject || null,
        page_url: location.href,
      },
    }).then(function (r) {
      if (!r.ok) { self.error = (r.body && (r.body.error || r.body.message)) || 'Failed.'; self.render(); return; }
      self.callbackId = r.body.callback_id;
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
        var box = el('div', { class: 'ccw-stack' }, [
          el('div', {}, ['Talk with our team in seconds.']),
        ]);
        var row = el('div', { class: 'ccw-row' });
        if (caps.voice) row.appendChild(el('button', { class: 'ccw-btn primary', on: { click: function () { self.startCall('voice'); } } }, ['🎙 Voice call']));
        if (caps.video) row.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.startCall('video'); } } }, ['🎥 Video call']));
        box.appendChild(row);
        if (caps.callback) box.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.openCallback(); } } }, ['Request callback instead']));
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
        if (status === 'connected') msg = 'Connected';
        if (status === 'fallback') msg = 'Call accepted. Please continue on the operator side.';
        if (status === 'accepted_no_sdk') msg = 'Call accepted. Audio/video client unavailable on this page.';
        if (status === 'failed') msg = 'Connection failed: ' + (self.error || 'unknown');
        return el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-card' }, [
            el('div', { class: 'ccw-pill' }, ['In call']),
            el('div', { class: 'ccw-label' }, [msg]),
          ]),
          el('button', { class: 'ccw-btn danger', on: { click: function () { self.cancelCall(); } } }, ['End']),
        ]);
      }

      case STATES.ENDED: {
        var endText = self.callbackId ? 'Callback received. We will reach out shortly.' : 'Call ended.';
        return el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-card' }, [el('div', {}, [endText])]),
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
    var box = el('div', { class: 'ccw-stack' });
    var fields = [
      ['name', 'Name', 'text'],
      ['email', 'Email', 'email'],
      ['phone', 'Phone', 'tel'],
      ['subject', 'Subject', 'text'],
    ];
    fields.forEach(function (f) {
      var label = el('label', { class: 'ccw-label' }, [f[1]]);
      var input = el('input', { class: 'ccw-input', type: f[2], value: self.formData[f[0]] || '' });
      input.addEventListener('input', function (e) { self.formData[f[0]] = e.target.value; });
      box.appendChild(label);
      box.appendChild(input);
    });
    if (forCall && cfg.recording_consent_required) {
      var cb = el('label', { class: 'ccw-checkbox' });
      var ci = el('input', { type: 'checkbox' });
      ci.checked = !!self.formData.consent;
      ci.addEventListener('change', function (e) { self.formData.consent = !!e.target.checked; });
      cb.appendChild(ci);
      cb.appendChild(document.createTextNode(' I consent to call recording.'));
      box.appendChild(cb);
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