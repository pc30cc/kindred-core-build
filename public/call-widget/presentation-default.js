/*!
 * Default Call Widget presentation — "وب یار" visual language.
 * This adapter owns presentation lifecycle and safe design-token application.
 * Transport, media-provider integration and persistence remain in runtime.js.
 */
(function (global) {
  'use strict';
  var registry = global.CallWidgetPresentations;
  if (!registry) throw new Error('call_widget_presentation_registry_missing');

  // Presentation-owned state vocabulary. The runtime only publishes these
  // values; deciding what markup each state produces belongs here.
  var STATES = {
    LOADING: 'loading',
    ONLINE: 'online_available',
    OFFLINE: 'offline',
    PRE_CALL: 'pre_call_form',
    QUEUE: 'queue_waiting',
    IN_CALL: 'in_call',
    ENDED: 'ended',
    CALLBACK: 'callback_form',
    ERROR: 'error',
  };

  var THEME_KEYS = {
    primary: '--ccw-primary',
    accent: '--ccw-accent',
    surface: '--ccw-surface',
    text: '--ccw-ink',
    muted: '--ccw-muted',
    danger: '--ccw-danger',
  };

  function hexToHslChannels(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return null;
    var r = parseInt(hex.slice(1, 3), 16) / 255;
    var g = parseInt(hex.slice(3, 5), 16) / 255;
    var b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return Math.round(h * 360) + ' ' + Math.round(s * 100) + '% ' + Math.round(l * 100) + '%';
  }

  function applyTheme(root, theme) {
    theme = theme || {};
    Object.keys(THEME_KEYS).forEach(function (key) {
      var value = hexToHslChannels(theme[key]);
      if (value) root.style.setProperty(THEME_KEYS[key], value);
    });
    var surface = hexToHslChannels(theme.surface);
    if (surface) root.style.setProperty('--ccw-panel', surface);
    root.dataset.radius = ['sm', 'md', 'lg'].indexOf(theme.radius) >= 0 ? theme.radius : 'md';
    root.dataset.density = theme.density === 'compact' ? 'compact' : 'comfortable';
  }

  var LOCALE_META = {
    en: { short: 'EN', dir: 'ltr' },
    fa: { short: 'فا', dir: 'rtl' },
    tr: { short: 'TR', dir: 'ltr' },
  };
  var activeAudio = {};

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (key === 'class') node.className = value;
      else if (key === 'on') Object.keys(value).forEach(function (event) { node.addEventListener(event, value[event]); });
      else if (key === 'html') node.textContent = value;
      // Boolean attributes (disabled, etc.) are present/absent, not
      // "true"/"false" strings — setAttribute(key, false) still marks an
      // element disabled since the attribute's mere presence is what counts.
      else if (value === true) node.setAttribute(key, '');
      else if (value === false || value == null) { /* omit */ }
      else node.setAttribute(key, value);
    });
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function svgIcon(paths, size) {
    var s = size || 17;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(s));
    svg.setAttribute('height', String(s));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    (Array.isArray(paths) ? paths : [paths]).forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }
  var PHONE_PATH = 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z';
  var CHEVRON_DOWN = 'M19 9l-7 7-7-7';
  var VIDEO_PATH = 'M23 7l-7 5 7 5V7z M1 5h15v14H1z';

  function fmtTime(ms) {
    var seconds = Math.floor(ms / 1000);
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function prepareMediaElement(node, local) {
    if (!node) return node;
    var isVideo = String(node.tagName || '').toLowerCase() === 'video';
    if (isVideo) {
      node.setAttribute(local ? 'data-local-video' : 'data-remote-video', 'true');
      node.setAttribute('data-orientation-correction', 'scaleX(-1)');
      node.style.transform = 'scaleX(-1)';
      node.style.scale = '1';
      node.style.rotate = '0deg';
    }
    return node;
  }

  // The launcher and panel are the two elements CSS animates on open/close
  // (grow-from-launcher, hover flip). A transition only ever plays on an
  // element whose style changes while it stays the same DOM node — a freshly
  // created node's first style resolution is never "from" anything, so these
  // two outer containers are built once per mount and reused on every
  // subsequent render; only their contents are replaced each time.
  function ensureShell(self) {
    if (self._launcherWrap && self._panel) return;
    self._launcherWrap = el('div', { class: 'ccw-launcher-wrap' });
    self._panel = el('div', { class: 'ccw-panel' });
    self.root.appendChild(self._launcherWrap);
    self.root.appendChild(self._panel);
  }

  function renderWidget() {
    if (!this.root) return;
    var self = this;
    var tr = function (key, vars) { return self.t(key, vars); };
    var pos = this.position();
    ensureShell(self);
    this.root.setAttribute('lang', this.locale);
    this.root.setAttribute('dir', (LOCALE_META[this.locale] && LOCALE_META[this.locale].dir) || 'ltr');
    this.root.classList.toggle('ccw-is-open', !!this.open);
    var caps = (this.bootstrap && this.bootstrap.capabilities) || {};
    var cfg = (this.bootstrap && this.bootstrap.config) || {};
    var offlineBehavior = cfg.offline_behavior || 'show_callback';

    // The hide policy applies only while offline. In-flight states remain
    // visible so a network/status transition can never strand a visitor.
    var hideWidget = this.state === STATES.OFFLINE && offlineBehavior === 'hide';
    self._launcherWrap.hidden = hideWidget;
    self._panel.hidden = hideWidget;
    if (hideWidget) return;

    // Launcher: a circular icon button (flips from the workspace logo to a
    // phone icon on hover) plus an adjacent floating text pill.
    var launcherText = this.isOnline()
      ? tr('talk_now')
      : (offlineBehavior === 'show_callback' ? tr('callback') : tr('support'));
    var launcherSub = this.isOnline() ? tr('live_support')
      : (offlineBehavior === 'show_callback' ? tr('leave_details') : tr('offline'));

    var launcherFace = el('span', { class: 'ccw-launcher-face' });
    if (cfg.avatar_url) {
      launcherFace.appendChild(el('span', { class: 'ccw-launcher-logo' }, [el('img', { src: cfg.avatar_url, alt: '' })]));
    } else {
      launcherFace.appendChild(el('span', { class: 'ccw-launcher-logo ccw-launcher-logo-fallback' }, [svgIcon(PHONE_PATH, 20)]));
    }
    launcherFace.appendChild(el('span', { class: 'ccw-launcher-icon' }, [svgIcon(PHONE_PATH, 20)]));

    var launcherBtn = el('button', {
      class: 'ccw-launcher-btn',
      'aria-label': launcherText,
      on: { click: function () { self.toggleOpen(); } },
    }, [launcherFace]);

    var launcherLabel = el('div', { class: 'ccw-launcher-label' }, [
      el('span', { class: 'ccw-launcher-text' }, [launcherText]),
      el('span', { class: 'ccw-launcher-sub' }, [launcherSub]),
    ]);

    self._launcherWrap.className = 'ccw-launcher-wrap ' + pos;
    self._launcherWrap.replaceChildren(launcherBtn, launcherLabel);

    if (!this.open) return;

    var header = el('div', { class: 'ccw-header' }, [
      el('div', { class: 'ccw-avatar' }, [
        cfg.avatar_url ? el('img', { src: cfg.avatar_url, alt: '' }) : svgIcon(PHONE_PATH, 17),
      ]),
      el('div', { class: 'ccw-header-copy' }, [
        el('div', { class: 'ccw-title' }, [cfg.display_name || tr('support')]),
        el('div', { class: 'ccw-sub' }, [
          el('span', { class: 'ccw-status-dot ' + (this.isOnline() ? 'online' : 'offline') }),
          this.isOnline() ? tr('operators_available') : tr('callback_desk'),
        ]),
      ]),
      renderLocaleSwitcher.call(this),
      el('button', { class: 'ccw-close', 'aria-label': tr('back'), on: { click: function () { self.toggleOpen(); } } }, [svgIcon(CHEVRON_DOWN, 16)]),
    ]);

    var body = el('div', { class: 'ccw-body ccw-scroll' });
    body.appendChild(renderState.call(this, caps, cfg));

    var footer = el('div', { class: 'ccw-footer' }, [
      el('a', { href: '#', class: 'ccw-powered', on: { click: function (e) { e.preventDefault(); } } }, [tr('powered_by')]),
    ]);

    self._panel.className = 'ccw-panel ' + pos;
    self._panel.replaceChildren(header, body, footer);
  }

  function renderLocaleSwitcher() {
    var self = this;
    if (!this.availableLocales || this.availableLocales.length <= 1) return null;
    var select = el('select', { class: 'ccw-lang', 'aria-label': 'Widget language' });
    this.availableLocales.forEach(function (code) {
      var meta = LOCALE_META[code] || { short: code.toUpperCase() };
      var option = el('option', { value: code }, [meta.short]);
      if (self.locale === code) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', function (e) { self.setLocale(e.target.value); });
    return select;
  }

  /** A pair of soft expanding rings around a filled circle — used for both queue and in-call avatars. */
  function ringAvatar(size, coreSize, coreChildren, coreClass) {
    return el('div', { class: 'ccw-ring-avatar', style: 'width:' + size + 'px;height:' + size + 'px;' }, [
      el('span', { class: 'ccw-ring r1' }),
      el('span', { class: 'ccw-ring r2' }),
      el('div', {
        class: 'ccw-ring-core' + (coreClass ? ' ' + coreClass : ''),
        style: 'width:' + coreSize + 'px;height:' + coreSize + 'px;',
      }, coreChildren),
    ]);
  }

  function renderState(caps, cfg) {
    var self = this;
    var tr = function (key, vars) { return self.t(key, vars); };
    var offlineBehavior = cfg.offline_behavior || 'show_callback';
    switch (this.state) {
      case STATES.LOADING:
        return el('div', { class: 'ccw-loading' }, [el('div', { class: 'ccw-spinner' }), el('div', { class: 'ccw-muted' }, [tr('loading')])]);

      case STATES.OFFLINE: {
        var off = el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-hero-copy' }, [
            el('h2', { class: 'ccw-hero-title' }, [tr('leave_callback_request')]),
            el('p', { class: 'ccw-hero-sub' }, [tr('offline_copy')]),
          ]),
        ]);
        if (offlineBehavior === 'show_callback' && caps.callback) {
          off.appendChild(el('button', { class: 'ccw-btn primary', on: { click: function () { self.openCallback(); } } }, [tr('request_callback')]));
        }
        return off;
      }

      case STATES.ONLINE: {
        var pol = (self.bootstrap && self.bootstrap.callback_policy) || {};
        var showCbOnline = pol.show_when_online !== false;
        var box = el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-hero-copy' }, [
            el('h2', { class: 'ccw-hero-title' }, [tr('talk_to_team')]),
            el('p', { class: 'ccw-hero-sub' }, [tr('online_copy')]),
          ]),
        ]);
        var row = el('div', { class: 'ccw-row' });
        if (caps.voice) row.appendChild(el('button', { class: 'ccw-btn primary', on: { click: function () { self.startCall('voice'); } } }, [svgIcon(PHONE_PATH, 15), tr('voice_call')]));
        if (caps.video) row.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.startCall('video'); } } }, [svgIcon(VIDEO_PATH, 15), tr('video_call')]));
        box.appendChild(row);
        if (caps.callback && showCbOnline) {
          box.appendChild(el('button', { class: 'ccw-btn ghost', on: { click: function () { self.openCallback(); } } }, [tr('request_callback_instead')]));
        }
        return box;
      }

      case STATES.PRE_CALL:
        return renderForm.call(this, cfg, /*forCall*/true);

      case STATES.CALLBACK:
        return renderForm.call(this, cfg, /*forCall*/false);

      case STATES.QUEUE: {
        var qe = (self.bootstrap && self.bootstrap.queue_experience) || {};
        var capsForCallback = (self.bootstrap && self.bootstrap.capabilities) || {};
        var queueTitle = self.queuePosition === 1 ? tr('you_are_next') : tr('holding_place');
        var queueCopy = self.queuePosition && self.queuePosition > 1 ? tr('queue_copy_many') : tr('queue_copy_next');
        var ringing = activeAudio.isActive && activeAudio.isActive();
        var stack = [
          el('div', { class: 'ccw-queue-block' }, [
            ringAvatar(64, 52, [svgIcon(PHONE_PATH, 20)], 'ccw-ring-core-phone'),
            el('span', { class: 'ccw-pill live' }, [ringing ? tr('ringing_enabled') : tr('ringing_operator')]),
            el('div', { class: 'ccw-queue-copy-block' }, [
              el('h3', { class: 'ccw-queue-title' }, [queueTitle]),
              el('p', { class: 'ccw-queue-copy' }, [queueCopy]),
            ]),
            el('div', { class: 'ccw-wait-row' }, [
              el('span', { class: 'ccw-muted' }, [tr('waiting_time')]),
              el('span', { class: 'ccw-wait-timer' }, [fmtTime(self.queueStartedAt ? (Date.now() - self.queueStartedAt) : 0)]),
              el('button', {
                class: 'ccw-sound-toggle' + ((activeAudio.isMuted && activeAudio.isMuted()) || (activeAudio.needsGesture && activeAudio.needsGesture()) ? ' muted' : ''),
                type: 'button',
                'aria-label': activeAudio.isMuted && activeAudio.isMuted() ? tr('unmute_sound') : tr('mute_sound'),
                on: {
                  click: function (ev) {
                    try { ev && ev.stopPropagation && ev.stopPropagation(); } catch (_) {}
                    var nowMuted = !(activeAudio.isMuted && activeAudio.isMuted());
                    if (nowMuted) {
                      activeAudio.setMuted(true);
                    } else {
                      activeAudio.setMuted(false);
                      if (activeAudio.needsGesture && activeAudio.needsGesture()) {
                        try { activeAudio.startFromGesture((self.bootstrap && self.bootstrap.queue_experience) || {}); } catch (_) {}
                      }
                    }
                    self.render();
                  },
                },
              }, [(activeAudio.isMuted && activeAudio.isMuted()) || (activeAudio.needsGesture && activeAudio.needsGesture()) ? '🔇' : '🔊']),
            ]),
          ]),
        ];
        if (activeAudio.needsGesture && activeAudio.needsGesture()) {
          stack.push(el('div', { class: 'ccw-tap-hint' }, [tr('tap_to_hear')]));
        }
        var chips = el('div', { class: 'ccw-chip-row' });
        if (qe.show_position !== false && self.queuePosition) {
          var posLabel = self.queuePosition === 1 ? tr('you_next_line') : tr('you_queue_number', { n: self.queuePosition });
          chips.appendChild(el('span', { class: 'ccw-chip' }, [posLabel]));
        }
        if (qe.show_eta !== false && typeof self.queueEta === 'number' && self.queueEta > 0) {
          var mins = Math.max(1, Math.round(self.queueEta / 60));
          chips.appendChild(el('span', { class: 'ccw-chip' }, [mins <= 1 ? tr('eta_under_min') : tr('eta_minutes', { n: mins })]));
        }
        if (chips.childNodes.length) stack.push(chips);

        var threshold = qe.offer_callback_after_seconds;
        var elapsed = self.queueStartedAt ? Math.floor((Date.now() - self.queueStartedAt) / 1000) : 0;
        if (capsForCallback.callback && threshold && threshold > 0 && elapsed >= threshold) {
          stack.push(el('div', { class: 'ccw-offer-card' }, [
            el('span', {}, [tr('tired_waiting')]),
            el('button', { class: 'ccw-btn secondary', on: { click: function () { self.cancelCall(); setTimeout(function () { self.openCallback(); }, 50); } } }, [tr('request_callback')]),
          ]));
        }
        stack.push(el('button', { class: 'ccw-btn danger', on: { click: function () { self.cancelCall(); } } }, [tr('cancel_call')]));
        return el('div', { class: 'ccw-stack' }, stack);
      }

      case STATES.IN_CALL: {
        var status = self.connectStatus || 'connecting';
        var msg = tr('call_accepted_connecting');
        if (status === 'in_call') msg = tr('connected');
        if (status === 'waiting_for_operator') msg = tr('operator_joining');
        if (status === 'operator_connected') msg = tr('operator_connected');
        if (status === 'operator_left') msg = tr('operator_left');
        if (status === 'media_reconnecting') msg = tr('reconnecting_media');
        if (status === 'media_disconnected') msg = tr('media_disconnected');
        if (status === 'connecting_media') msg = tr('connecting_av');
        if (status === 'fallback') msg = tr('fallback');
        if (status === 'accepted_no_sdk') msg = tr('accepted_no_sdk');
        if (status === 'media_not_configured') msg = tr('media_not_configured');
        if (status === 'provider_client_not_configured') msg = tr('provider_not_configured');
        if (status === 'provider_client_not_supported') msg = tr('provider_not_supported');
        if (status === 'media_client_missing') msg = tr('media_client_missing');
        if (status === 'media_client_invalid') msg = tr('media_client_invalid');
        if (status === 'loading_media_client') msg = tr('loading_media_client');
        if (status === 'microphone_permission_denied') msg = tr('mic_denied');
        if (status === 'camera_permission_denied') msg = tr('camera_denied');
        if (status === 'room_connect_failed') msg = tr('room_failed', { error: self.error || tr('unknown') });
        if (status === 'token_expired') msg = tr('token_expired');
        var isLive = (status === 'in_call' || status === 'operator_connected');
        var isVideoCall = (self.call && self.call.call_type === 'video') || self.formData.call_type === 'video';
        var hideHero = isVideoCall && isLive && !self.transferring;

        var stackChildren = [el('span', { class: 'ccw-pill live' }, [isLive ? tr('in_call') : status === 'waiting_for_operator' ? tr('connected_waiting') : tr('connecting')])];

        if (self.transferring) {
          stackChildren.push(el('div', { class: 'ccw-transfer' }, [
            el('span', { class: 'ccw-spinner small' }),
            el('span', {}, [tr('transferring_call')]),
          ]));
        } else if (!hideHero) {
          var initial = self.operatorName ? self.operatorName.charAt(0).toUpperCase() : '؟';
          stackChildren.push(el('div', { class: 'ccw-call-hero' }, [
            ringAvatar(76, 64, [el('span', { class: 'ccw-ring-core-initial' }, [initial])]),
            el('div', { class: 'ccw-call-meta' }, [
              self.operatorName ? el('span', { class: 'ccw-call-op-name' }, [self.operatorName]) : null,
              el('span', { class: 'ccw-call-op-role' }, [tr('operator_label')]),
              isLive ? el('span', { class: 'ccw-call-timer' }, [fmtTime(self.callStartedAt ? (Date.now() - self.callStartedAt) : 0)]) : el('span', { class: 'ccw-call-timer' }, [msg]),
            ]),
          ]));
        } else if (!self.transferring) {
          stackChildren.push(el('div', { class: 'ccw-muted', style: 'text-align:center;' }, [msg]));
        }

        if (self.call && self.call.recording_state === 'recording') {
          stackChildren.push(el('span', { class: 'ccw-pill recording' }, [tr('recording_progress')]));
        } else {
          var recBoot = (self.bootstrap && self.bootstrap.recording) || {};
          if (recBoot.effective_enabled) stackChildren.push(el('div', { class: 'ccw-muted' }, [tr('recording_may_start')]));
        }

        var media = el('div', { class: 'ccw-media' + (isVideoCall ? ' video' : '') });
        self._remoteHolder = media;
        if (self._attachedTracks) {
          var keys = Object.keys(self._attachedTracks);
          for (var i = 0; i < keys.length; i++) {
            try {
              var remoteNode = prepareMediaElement(self._attachedTracks[keys[i]], false);
              remoteNode.setAttribute('data-track-sid', keys[i]);
              media.appendChild(remoteNode);
            } catch (_) {}
          }
        }
        if (isLive && isVideoCall && !self.transferring) {
          if (self._localVideoEl && self.camOn) {
            var pip = el('div', { class: 'ccw-local-pip' });
            try { pip.appendChild(prepareMediaElement(self._localVideoEl, true)); } catch (_) {}
            media.appendChild(pip);
          }
          media.appendChild(el('div', { class: 'ccw-video-info' }, [
            el('span', { class: 'ccw-video-info-name' }, [self.operatorName || tr('operator_label')]),
            el('span', { class: 'ccw-video-info-duration' }, [fmtTime(self.callStartedAt ? (Date.now() - self.callStartedAt) : 0)]),
          ]));
          stackChildren.push(media);
        } else if (isVideoCall) {
          stackChildren.push(media);
        }

        var controls = el('div', { class: 'ccw-controls' });
        if (status === 'in_call' || status === 'operator_connected' || status === 'waiting_for_operator' || status === 'media_reconnecting') {
          var ctrlRow = el('div', { class: 'ccw-row' }, [
            el('button', { class: 'ccw-btn' + (self.call && self.call.muted ? ' primary' : ' secondary'), on: { click: function () { self.toggleMic(); } } }, [self.micOn === false ? tr('unmute') : tr('mute')]),
          ]);
          var wantVideo = (self.call && self.call.call_type === 'video') || self.formData.call_type === 'video';
          if (wantVideo) {
            ctrlRow.appendChild(el('button', { class: 'ccw-btn' + (self.camOn === false ? ' primary' : ' secondary'), on: { click: function () { self.toggleCam(); } } }, [self.camOn === false ? tr('camera_on') : tr('camera_off')]));
          }
          controls.appendChild(ctrlRow);
        }
        controls.appendChild(el('button', { class: 'ccw-btn danger full', on: { click: function () { self.cancelCall(); } } }, [tr('end')]));
        stackChildren.push(controls);

        return el('div', { class: 'ccw-stack ccw-centered' }, stackChildren);
      }

      case STATES.ENDED: {
        if (self.callbackId) {
          var ref = String(self.callbackId).slice(0, 8).toUpperCase();
          var when = self.formData.callback_when === 'later' && self.formData.callback_scheduled_for
            ? new Date(self.formData.callback_scheduled_for).toLocaleString()
            : tr('asap');
          var chLabel = self.formData.callback_channel === 'video' ? tr('video_callback') : tr('phone_callback');
          return el('div', { class: 'ccw-stack ccw-centered' }, [
            ringAvatar(52, 52, [svgIcon('M20 6L9 17l-5-5', 20)], 'ccw-ring-core-success ccw-no-ring'),
            el('h3', { class: 'ccw-confirm-title' }, [tr('callback_scheduled')]),
            el('p', { class: 'ccw-muted', style: 'text-align:center;' }, [tr('reach_out', { when: when })]),
            el('div', { class: 'ccw-summary-card' }, [
              el('div', { class: 'ccw-summary-row' }, [el('span', { class: 'ccw-muted' }, [tr('type')]), el('span', { class: 'ccw-summary-val' }, [chLabel])]),
              el('div', { class: 'ccw-summary-row' }, [el('span', { class: 'ccw-muted' }, [tr('reference')]), el('span', { class: 'ccw-summary-val ccw-mono' }, [ref])]),
            ]),
            el('button', { class: 'ccw-btn primary full', on: { click: function () { self.reset(); } } }, [tr('done')]),
          ]);
        }
        var stack = [
          ringAvatar(44, 44, [svgIcon('M20 6L9 17l-5-5', 18)], 'ccw-ring-core-success ccw-no-ring'),
          el('div', { class: 'ccw-ended-copy' }, [
            el('span', { class: 'ccw-ended-title' }, [tr('call_ended')]),
            self.endedDuration > 0 ? el('span', { class: 'ccw-muted' }, [tr('call_duration') + ': ' + fmtTime(self.endedDuration * 1000)]) : null,
          ]),
        ];
        if (self.endedCallId && !self.ratingSubmitted) {
          var stars = el('div', { class: 'ccw-stars' });
          var submitBtn;
          var renderStars = function () {
            stars.replaceChildren();
            for (var i = 1; i <= 5; i++) {
              (function (n) {
                var starIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                starIcon.setAttribute('width', '24'); starIcon.setAttribute('height', '24'); starIcon.setAttribute('viewBox', '0 0 24 24');
                starIcon.setAttribute('fill', self.ratingValue >= n ? 'currentColor' : 'none');
                starIcon.setAttribute('stroke', 'currentColor'); starIcon.setAttribute('stroke-width', '1.5');
                var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                p.setAttribute('d', 'M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z');
                starIcon.appendChild(p);
                var btn = el('button', {
                  class: 'ccw-star' + (self.ratingValue >= n ? ' filled' : ''), type: 'button', 'aria-label': String(n),
                  on: {
                    click: function () {
                      self.ratingValue = n;
                      renderStars();
                      // Picking a star only rebuilds the star icons locally
                      // (no full re-render, so the comment textarea keeps
                      // focus) — the submit button's disabled state is kept
                      // in sync here instead.
                      if (submitBtn) submitBtn.disabled = self.ratingValue === 0;
                    },
                  },
                }, [starIcon]);
                stars.appendChild(btn);
              })(i);
            }
          };
          renderStars();
          var ta = el('textarea', { class: 'ccw-textarea', placeholder: tr('rate_comment_ph') });
          ta.value = self.ratingComment || '';
          ta.addEventListener('input', function (e) { self.ratingComment = e.target.value; });
          stack.push(el('div', { class: 'ccw-rate-block' }, [
            el('span', { class: 'ccw-rate-title' }, [tr('rate_call_title')]),
            el('span', { class: 'ccw-muted' }, [tr('rate_call_sub')]),
          ]));
          stack.push(stars);
          stack.push(ta);
          submitBtn = el('button', { class: 'ccw-btn primary', disabled: self.ratingValue === 0, on: { click: function () { self.submitRating(); } } }, [tr('rate_submit')]);
          stack.push(el('div', { class: 'ccw-row' }, [
            el('button', { class: 'ccw-btn secondary', on: { click: function () { self.skipRating ? self.skipRating() : self.reset(); } } }, [tr('rate_skip')]),
            submitBtn,
          ]));
        } else if (self.ratingSubmitted) {
          stack.push(el('span', { class: 'ccw-rate-title' }, [tr('rate_thanks')]));
          stack.push(el('button', { class: 'ccw-btn secondary full', on: { click: function () { self.reset(); } } }, [tr('done')]));
        } else {
          stack.push(el('button', { class: 'ccw-btn primary full', on: { click: function () { self.reset(); } } }, [tr('done')]));
        }
        return el('div', { class: 'ccw-stack ccw-centered' }, stack);
      }

      case STATES.ERROR:
        return el('div', { class: 'ccw-stack ccw-centered' }, [
          el('div', { class: 'ccw-error' }, [tr('error_prefix', { error: self.error || tr('unknown') })]),
          el('button', { class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, [tr('back')]),
        ]);
    }
    return el('div', {}, ['…']);
  }

  function segmentedControl(options, current, onChange) {
    var seg = el('div', { class: 'ccw-segment' });
    options.forEach(function (opt) {
      var active = current === opt.value;
      seg.appendChild(el('button', {
        class: 'ccw-seg-btn' + (active ? ' active' : '') + (opt.danger && active ? ' danger' : ''),
        type: 'button',
        on: { click: function () { onChange(opt.value); } },
      }, [opt.label]));
    });
    return seg;
  }

  function renderForm(cfg, forCall) {
    var self = this;
    var tr = function (key, vars) { return self.t(key, vars); };
    var policy = (self.bootstrap && self.bootstrap.callback_policy) || {};
    var box = el('form', {
      class: 'ccw-stack',
      on: { submit: function (e) { e.preventDefault(); forCall ? self.submitCall() : self.submitCallback(); } },
    });
    if (!forCall) {
      box.appendChild(el('p', { class: 'ccw-form-intro' }, [tr('callback_intro')]));
    }
    if (!forCall) {
      var caps2 = (self.bootstrap && self.bootstrap.capabilities) || {};
      var channelOpts = [{ value: 'audio', label: tr('phone') }];
      if (caps2.video) channelOpts.push({ value: 'video', label: tr('video') });
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('callback_type')]));
      box.appendChild(segmentedControl(channelOpts, self.formData.callback_channel, function (v) { self.formData.callback_channel = v; self.render(); }));
    }
    var depts = (self.bootstrap && self.bootstrap.departments) || {};
    var deptList = forCall ? (depts[self.formData.call_type === 'video' ? 'video' : 'voice'] || []) : (depts.callback || []);
    if (deptList.length > 0) {
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('department')]));
      var sel = el('select', { class: 'ccw-input' }, [el('option', { value: '' }, [tr('choose_department')])]);
      deptList.forEach(function (d) {
        var opt = el('option', { value: d.id }, [d.name]);
        if (self.formData.department_id === d.id) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function (e) { self.formData.department_id = e.target.value; });
      box.appendChild(sel);
    }
    var alreadyIdentified = !!(self.identifiedContact && self.identifiedContact.id);
    if (alreadyIdentified) {
      var knownName = self.identifiedContact.name || self.formData.name || tr('known_contact');
      box.appendChild(el('div', { class: 'ccw-known-contact' }, [
        el('span', { class: 'ccw-known-dot' }, ['✓']),
        el('div', {}, [
          el('div', { class: 'ccw-known-title' }, [knownName]),
          el('div', { class: 'ccw-muted' }, [tr('contact_saved')]),
        ]),
      ]));
    }
    var configuredFields = forCall && Array.isArray(cfg.pre_call_form_schema) ? cfg.pre_call_form_schema : [];
    var fields = configuredFields.length ? configuredFields : (alreadyIdentified
      ? [['subject', tr('subject'), 'text']]
      : [
        ['name', tr('full_name'), 'text'],
        ['email', !forCall && policy.require_contact ? tr('email_required') : tr('email'), 'email'],
        ['phone', !forCall && policy.require_contact ? tr('phone_required') : tr('phone_field'), 'tel'],
        ['subject', tr('subject'), 'text'],
      ]);
    if (configuredFields.length && alreadyIdentified) {
      fields = fields.filter(function (field) { return ['name', 'email', 'phone'].indexOf(field.id) < 0; });
    }
    fields.forEach(function (f) {
      var descriptor = Array.isArray(f) ? { id: f[0], label: f[1], type: f[2], required: false } : f;
      box.appendChild(el('label', { class: 'ccw-label' }, [descriptor.label + (descriptor.required ? ' *' : '')]));
      var builtIn = ['name', 'email', 'phone', 'subject'].indexOf(descriptor.id) >= 0;
      self.formData.custom = self.formData.custom || {};
      var current = builtIn ? self.formData[descriptor.id] : self.formData.custom[descriptor.id];
      var input;
      if (descriptor.type === 'textarea') {
        input = el('textarea', { class: 'ccw-textarea', placeholder: descriptor.placeholder || '' });
        input.value = current || '';
      } else if (descriptor.type === 'select') {
        input = el('select', { class: 'ccw-input' }, [el('option', { value: '' }, [descriptor.placeholder || '—'])]);
        (descriptor.options || []).forEach(function (option) {
          var optionEl = el('option', { value: option.value }, [option.label]);
          if (current === option.value) optionEl.selected = true;
          input.appendChild(optionEl);
        });
      } else if (descriptor.type === 'checkbox') {
        input = el('input', { type: 'checkbox' });
        input.checked = current === true;
      } else {
        input = el('input', { class: 'ccw-input', type: descriptor.type || 'text', value: current || '', placeholder: descriptor.placeholder || '' });
      }
      input.addEventListener(descriptor.type === 'checkbox' ? 'change' : 'input', function (e) {
        var value = descriptor.type === 'checkbox' ? !!e.target.checked : e.target.value;
        if (builtIn) self.formData[descriptor.id] = value;
        else self.formData.custom[descriptor.id] = value;
      });
      box.appendChild(input);
    });
    if (!forCall && policy.require_contact && !alreadyIdentified) {
      box.appendChild(el('div', { class: 'ccw-note' }, [tr('contact_required_note')]));
    }
    if (!forCall) {
      if (policy.honeypot_enabled !== false) {
        var hp = el('input', {
          type: 'text', name: 'company_website', autocomplete: 'off', tabindex: '-1', 'aria-hidden': 'true',
          style: 'position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;opacity:0;',
        });
        hp.value = self.formData.hp_company || '';
        hp.addEventListener('input', function (e) { self.formData.hp_company = e.target.value; });
        box.appendChild(hp);
      }
      box.appendChild(el('label', { class: 'ccw-label' }, [policy.min_message_length > 0 ? tr('message_min', { n: policy.min_message_length }) : tr('message_optional')]));
      var ta = el('textarea', { class: 'ccw-textarea', placeholder: tr('message_placeholder') });
      ta.value = self.formData.message || '';
      ta.addEventListener('input', function (e) { self.formData.message = e.target.value; });
      box.appendChild(ta);

      box.appendChild(el('label', { class: 'ccw-label' }, [tr('when_call')]));
      box.appendChild(segmentedControl(
        [{ value: 'now', label: '⚡ ' + tr('asap') }, { value: 'later', label: tr('schedule') }],
        self.formData.callback_when,
        function (v) { self.formData.callback_when = v; self.render(); },
      ));
      if (self.formData.callback_when === 'later') {
        var dt = el('input', { class: 'ccw-input', type: 'datetime-local' });
        dt.value = self.formData.callback_scheduled_for || '';
        var minDate = new Date(Date.now() + 5 * 60000);
        dt.min = new Date(minDate.getTime() - minDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        dt.addEventListener('input', function (e) { self.formData.callback_scheduled_for = e.target.value; });
        box.appendChild(dt);
      }
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('priority')]));
      box.appendChild(segmentedControl(
        [{ value: 'normal', label: tr('normal') }, { value: 'urgent', label: '🔥 ' + tr('urgent'), danger: true }],
        self.formData.callback_urgency,
        function (v) { self.formData.callback_urgency = v; self.render(); },
      ));
    }
    if (forCall) {
      var rec = (self.bootstrap && self.bootstrap.recording) || {};
      if (rec.effective_enabled && rec.consent_required) {
        var cb = el('label', { class: 'ccw-checkbox' });
        var ci = el('input', { type: 'checkbox' });
        ci.checked = !!self.formData.consent;
        ci.addEventListener('change', function (e) { self.formData.consent = !!e.target.checked; });
        cb.appendChild(ci);
        cb.appendChild(document.createTextNode(tr('consent_required')));
        box.appendChild(cb);
      } else if (rec.effective_enabled) {
        box.appendChild(el('div', { class: 'ccw-muted' }, [tr('call_may_record')]));
      }
    }
    if (self.error) box.appendChild(el('div', { class: 'ccw-error' }, [self.error]));
    box.appendChild(el('div', { class: 'ccw-row' }, [
      el('button', { type: 'button', class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, [tr('back')]),
      el('button', { type: 'submit', class: 'ccw-btn primary' }, [forCall ? tr('start_call') : tr('send_request')]),
    ]));
    return box;
  }

  registry.register('default', {
    contractVersion: 1,
    createHost: function (context) {
      var host = document.createElement('div');
      host.id = 'call-center-widget-host';
      host.style.all = 'initial';
      document.body.appendChild(host);
      var shadow = host.attachShadow({ mode: 'open' });
      var runtimeStyle = document.createElement('link');
      runtimeStyle.rel = 'stylesheet';
      runtimeStyle.href = context.origin + '/call-widget/runtime.css' + context.runtimeAssetSuffix;
      shadow.appendChild(runtimeStyle);
      var assets = (context.bootstrap && context.bootstrap.assets) || {};
      var presentationPath = /^\/call-widget\/[a-z0-9.-]+$/i.test(assets.presentation_style_url || '')
        ? assets.presentation_style_url : '/call-widget/presentation-default.css';
      var presentationStyle = document.createElement('link');
      presentationStyle.rel = 'stylesheet';
      presentationStyle.href = context.origin + presentationPath + context.runtimeAssetSuffix;
      shadow.appendChild(presentationStyle);
      var fontHref = assets.font_style_url;
      if (fontHref && !document.getElementById('gs-presentation-fonts')) {
        var fontStyle = document.createElement('link');
        fontStyle.id = 'gs-presentation-fonts';
        fontStyle.rel = 'stylesheet';
        fontStyle.href = /^https?:/i.test(fontHref) ? fontHref : context.origin + fontHref;
        document.head.appendChild(fontStyle);
      }
      var root = document.createElement('div');
      root.className = 'ccw-root';
      shadow.appendChild(root);
      return { host: host, root: root };
    },
    mount: function (context) {
      context.root.classList.add('ccw-presentation-default');
      applyTheme(context.root, context.theme);
      activeAudio = context.audio || {};
      renderWidget.call(context.controller);
      return { root: context.root };
    },
    update: function (instance, context) {
      applyTheme(instance.root, context.theme);
      activeAudio = context.audio || {};
      renderWidget.call(context.controller);
    },
    destroy: function (instance) {
      if (instance && instance.root) instance.root.replaceChildren();
    },
    ready: function () { return Promise.resolve(); },
    prepare: function () { return Promise.resolve(); },
  });
})(window);
