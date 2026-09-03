/*!
 * Default Call Widget presentation.
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
      if (key === 'class') node.className = attrs[key];
      else if (key === 'on') Object.keys(attrs[key]).forEach(function (event) { node.addEventListener(event, attrs[key][event]); });
      else if (key === 'html') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

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

  function renderWidget() {
    if (!this.root) return;
    var self = this;
    var tr = function (key, vars) { return self.t(key, vars); };
    var pos = this.position();
    this.root.replaceChildren();
    this.root.setAttribute('lang', this.locale);
    this.root.setAttribute('dir', (LOCALE_META[this.locale] && LOCALE_META[this.locale].dir) || 'ltr');
    var caps = (this.bootstrap && this.bootstrap.capabilities) || {};
    var cfg = (this.bootstrap && this.bootstrap.config) || {};
    var offlineBehavior = cfg.offline_behavior || 'show_callback';

    // The hide policy applies only while offline. In-flight states remain
    // visible so a network/status transition can never strand a visitor.
    if (this.state === STATES.OFFLINE && offlineBehavior === 'hide') return;

    // Launcher always present
    var launcherText = this.isOnline()
      ? tr('talk_now')
      : (offlineBehavior === 'show_callback' ? tr('callback') : tr('support'));
    var launcher = el('button', {
      class: 'ccw-launcher ' + pos,
      'aria-label': launcherText,
      on: { click: function () { self.toggleOpen(); } },
    }, [
      el('span', { class: 'ccw-launcher-pulse' }, [el('span', { class: 'ccw-launcher-icon' }, ['☎'])]),
      el('span', { class: 'ccw-launcher-copy' }, [
        el('span', { class: 'ccw-launcher-text' }, [launcherText]),
        el('span', { class: 'ccw-launcher-sub' }, [
          this.isOnline() ? tr('live_support')
            : (offlineBehavior === 'show_callback' ? tr('leave_details') : tr('offline')),
        ]),
      ]),
      this.isOnline() ? el('span', { class: 'ccw-launcher-dot' }) : null,
    ]);
    this.root.appendChild(launcher);

    if (!this.open) return;

    var panel = el('div', { class: 'ccw-panel ' + pos });
    var header = el('div', { class: 'ccw-header' }, [
      el('div', { class: 'ccw-brand-wrap' }, [
        cfg.avatar_url ? el('img', { src: cfg.avatar_url, alt: '' }) : el('div', { class: 'ccw-avatar-fallback' }, ['☎']),
        el('span', { class: 'ccw-avatar-badge' }),
      ]),
      el('div', { class: 'ccw-header-copy' }, [
        el('div', { class: 'ccw-title' }, [cfg.display_name || tr('support')]),
        el('div', { class: 'ccw-sub' }, [
          el('span', { class: 'ccw-status-dot ' + (this.isOnline() ? 'online' : 'offline') }),
          this.isOnline() ? tr('operators_available') : tr('callback_desk'),
        ]),
      ]),
      renderLocaleSwitcher.call(this),
      el('button', { class: 'ccw-close', on: { click: function () { self.toggleOpen(); } } }, ['×']),
    ]);
    panel.appendChild(header);

    var body = el('div', { class: 'ccw-body' });
    body.appendChild(renderState.call(this, caps, cfg));
    panel.appendChild(body);
    this.root.appendChild(panel);
  };

  function renderLocaleSwitcher() {
    var self = this;
    if (!this.availableLocales || this.availableLocales.length <= 1) return null;
    var select = el('select', { class: 'ccw-lang', 'aria-label': 'Widget language' });
    this.availableLocales.forEach(function (code) {
      var meta = LOCALE_META[code] || { label: code.toUpperCase(), short: code.toUpperCase() };
      var option = el('option', { value: code }, [meta.short]);
      if (self.locale === code) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', function (e) { self.setLocale(e.target.value); });
    return select;
  };

  function renderState(caps, cfg) {
    var self = this;
    var tr = function (key, vars) { return self.t(key, vars); };
    var offlineBehavior = cfg.offline_behavior || 'show_callback';
    switch (this.state) {
      case STATES.LOADING:
        return el('div', { class: 'ccw-loading' }, [el('div', { class: 'ccw-spinner' }), el('div', { class: 'ccw-muted' }, [tr('loading')])]);

      case STATES.OFFLINE: {
        var off = el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-mini-hero offline' }, [
            el('div', { class: 'ccw-mini-title' }, [tr('leave_callback_request')]),
            el('div', { class: 'ccw-mini-sub' }, [tr('offline_copy')]),
          ]),
        ]);
        if (offlineBehavior === 'show_callback' && caps.callback) {
          off.appendChild(el('button', { class: 'ccw-btn primary', on: { click: function () { self.openCallback(); } } }, [tr('request_callback')]));
        }
        return off;
      }

      case STATES.ONLINE: {
        var pol = (self.bootstrap && self.bootstrap.callback_policy) || {};
        var showCbOnline = pol.show_when_online !== false; // default true
        var box = el('div', { class: 'ccw-stack' });
        var row = el('div', { class: 'ccw-row' });
        if (caps.voice) row.appendChild(el('button', { class: 'ccw-btn primary', on: { click: function () { self.startCall('voice'); } } }, [el('span', { class: 'ccw-btn-ico' }, ['☎']), tr('voice_call')]));
        if (caps.video) row.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.startCall('video'); } } }, [el('span', { class: 'ccw-btn-ico' }, ['◉']), tr('video_call')]));
        box.appendChild(row);
        if (caps.callback && showCbOnline) {
          box.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.openCallback(); } } }, [tr('request_callback_instead')]));
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
        var queueCopy = self.queuePosition && self.queuePosition > 1
          ? tr('queue_copy_many')
          : tr('queue_copy_next');
        var card = el('div', { class: 'ccw-queue-card' }, [
          el('div', { class: 'ccw-queue-head' }, [
            el('div', { class: 'ccw-queue-orbit' }, [
              el('span', { class: 'ccw-ring r1' }),
              el('span', { class: 'ccw-ring r2' }),
              el('span', { class: 'ccw-ring r3' }),
              el('span', { class: 'ccw-phone-core' }, ['☎']),
            ]),
            el('div', { class: 'ccw-queue-copy-block' }, [
              el('div', { class: 'ccw-pill live' }, [activeAudio.isActive && activeAudio.isActive() ? tr('ringing_enabled') : tr('ringing_operator')]),
              el('div', { class: 'ccw-queue-title' }, [queueTitle]),
              el('div', { class: 'ccw-queue-copy' }, [queueCopy]),
            ]),
          ]),
          el('div', { class: 'ccw-queue-progress' }, [
            el('span', { class: 'ccw-progress-bar b1' }),
            el('span', { class: 'ccw-progress-bar b2' }),
            el('span', { class: 'ccw-progress-bar b3' }),
            el('span', { class: 'ccw-progress-bar b4' }),
            el('span', { class: 'ccw-progress-bar b5' }),
          ]),
          el('div', { class: 'ccw-wait-wrap' }, [
            el('div', { class: 'ccw-wait-row' }, [
              el('span', { class: 'ccw-wait-label' }, [tr('waiting_time')]),
              el('div', { class: 'ccw-wait-timer', html: fmtTime(self.queueStartedAt ? (Date.now() - self.queueStartedAt) : 0) }),
              el('button', {
              class: 'ccw-sound-toggle' + ((activeAudio.isMuted && activeAudio.isMuted()) || (activeAudio.needsGesture && activeAudio.needsGesture()) ? ' muted' : ''),
              type: 'button',
              title: activeAudio.isMuted && activeAudio.isMuted() ? tr('unmute_sound') : tr('mute_sound'),
              'aria-label': activeAudio.isMuted && activeAudio.isMuted() ? tr('unmute_sound') : tr('mute_sound'),
              on: { click: function (ev) {
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
              } },
              }, [(activeAudio.isMuted && activeAudio.isMuted()) || (activeAudio.needsGesture && activeAudio.needsGesture()) ? '🔇' : '🔊']),
            ]),
            (activeAudio.needsGesture && activeAudio.needsGesture())
              ? el('div', { class: 'ccw-wait-hint' }, [tr('tap_to_hear')])
              : null,
          ]),
        ]);
        if (activeAudio.needsGesture && activeAudio.needsGesture()) {
          // Audio is locked by browser autoplay policy — show the same
          // small toggle styling but in "unlock" affordance. Visitor taps
          // it once to allow the queue audio without ending the call.
          var waitWrap = card.querySelector('.ccw-wait-wrap');
          if (waitWrap) {
            var unlockBtn = waitWrap.querySelector('.ccw-sound-toggle');
            if (unlockBtn) {
              unlockBtn.classList.add('locked');
              unlockBtn.setAttribute('title', tr('enable_ringing_sound'));
              unlockBtn.setAttribute('aria-label', tr('enable_ringing_sound'));
            }
          }
          // Any click anywhere on the queue card counts as a user gesture —
          // use it to unlock and resume the queue audio immediately, then
          // re-render so the locked icon disappears.
          card.addEventListener('click', function onceUnlock() {
            try { card.removeEventListener('click', onceUnlock); } catch (_) {}
            try { activeAudio.startFromGesture((self.bootstrap && self.bootstrap.queue_experience) || {}); } catch (_) {}
            setTimeout(function () { try { self.render(); } catch (_) {} }, 60);
          }, { once: true, capture: true });
        }
        // Position-in-queue chip
        if (qe.show_position !== false && self.queuePosition) {
          var posLabel = self.queuePosition === 1
            ? tr('you_next_line')
            : tr('you_queue_number', { n: self.queuePosition });
          card.appendChild(el('div', { class: 'ccw-queue-pos' }, [el('span', {}, [tr('queue_position')]), el('strong', {}, [posLabel])]));
        }
        // ETA chip
        if (qe.show_eta !== false && typeof self.queueEta === 'number' && self.queueEta > 0) {
          var mins = Math.max(1, Math.round(self.queueEta / 60));
          var etaLbl = mins <= 1 ? tr('eta_under_min') : tr('eta_minutes', { n: mins });
          card.appendChild(el('div', { class: 'ccw-queue-eta' }, [el('span', {}, [tr('eta')]), el('strong', {}, [etaLbl])]));
        }
        var stack = [card];
        // Offer a callback after the configured wait threshold
        var threshold = qe.offer_callback_after_seconds;
        var elapsed = self.queueStartedAt ? Math.floor((Date.now() - self.queueStartedAt) / 1000) : 0;
        if (capsForCallback.callback && threshold && threshold > 0 && elapsed >= threshold) {
          stack.push(el('div', { class: 'ccw-callback-offer' }, [
            el('div', { class: 'ccw-callback-offer-text' }, [tr('tired_waiting')]),
            el('button', { class: 'ccw-btn primary', on: { click: function () { self.cancelCall(); setTimeout(function () { self.openCallback(); }, 50); } } }, [tr('request_callback')]),
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
        var hideHeader = isVideoCall && isLive && !self.transferring;
        var cardChildren = hideHeader ? [] : [
          el('div', { class: 'ccw-pill' }, [isLive ? tr('in_call') : status === 'waiting_for_operator' ? tr('connected_waiting') : tr('connecting')]),
          el('div', { class: 'ccw-label' }, [self.transferring ? tr('transferring_call') : msg]),
        ];
        var card = el('div', { class: 'ccw-card ccw-incall' + (isLive ? ' live' : '') + (self.transferring ? ' transferring' : '') + (isVideoCall ? ' video' : '') }, cardChildren);
        // Beautiful "connected" hero — voice only. Video calls show the
        // video stream as the centerpiece with an overlay instead.
        if (isLive && !self.transferring && !isVideoCall) {
          var waveBars = [];
          for (var _wi = 1; _wi <= 7; _wi++) {
            waveBars.push(el('span', { class: 'b' + _wi }));
          }
          self._waveBars = waveBars;
          var waveEl = el('div', { class: 'ccw-wave live' }, waveBars);
          card.appendChild(el('div', { class: 'ccw-live-hero' }, [
            el('div', { class: 'ccw-live-avatar' }, [
              el('span', { class: 'ccw-live-pulse p1' }),
              el('span', { class: 'ccw-live-pulse p2' }),
              el('span', { class: 'ccw-live-pulse p3' }),
              el('span', { class: 'ccw-live-core' }, [self.operatorName ? self.operatorName.charAt(0).toUpperCase() : '☎']),
            ]),
            el('div', { class: 'ccw-live-meta' }, [
              self.operatorName ? el('div', { class: 'ccw-live-op-name' }, [self.operatorName]) : null,
              el('div', { class: 'ccw-live-op-role' }, [tr('operator_label')]),
              el('div', { class: 'ccw-live-duration' }, [
                el('span', { class: 'ccw-live-duration-label' }, [tr('call_duration')]),
                el('span', { class: 'ccw-call-duration-value' }, [fmtTime(self.callStartedAt ? (Date.now() - self.callStartedAt) : 0)]),
              ]),
              waveEl,
            ]),
          ]));
        } else if (self.transferring) {
          card.appendChild(el('div', { class: 'ccw-transfer-hero' }, [
            el('span', { class: 'ccw-transfer-spinner' }),
            el('div', { class: 'ccw-transfer-text' }, [tr('transferring_call')]),
          ]));
        } else if (isLive && isVideoCall) {
          // Video calls: no header strip; we overlay name + timer on the
          // video tile itself (see ccw-video-overlay).
        }
        // Recording indicator (passive). Backend status drives this; never trust client.
        var recBoot = (self.bootstrap && self.bootstrap.recording) || {};
        var callRecState = self.call && self.call.recording_state;
        if (callRecState === 'recording') {
          card.appendChild(el('div', { class: 'ccw-pill recording' }, [tr('recording_progress')]));
        } else if (recBoot.effective_enabled) {
          card.appendChild(el('div', { class: 'ccw-muted', style: 'margin-top:6px;' }, [
            tr('recording_may_start'),
          ]));
        }
        var media = el('div', { class: 'ccw-media' });
        self._remoteHolder = media;
        // Re-attach existing tracks if any (re-render can wipe DOM)
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
            el('div', { class: 'ccw-video-info-name' }, [self.operatorName || tr('operator') || 'Operator']),
            el('div', { class: 'ccw-video-info-duration' }, [
              el('span', { class: 'ccw-call-duration-value' }, [fmtTime(self.callStartedAt ? (Date.now() - self.callStartedAt) : 0)]),
            ]),
          ]));
        }
        card.appendChild(media);
        var controls = el('div', { class: 'ccw-row' });
        if (status === 'in_call' || status === 'operator_connected' || status === 'waiting_for_operator' || status === 'media_reconnecting') {
          controls.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.toggleMic(); } } }, [self.micOn ? tr('mute') : tr('unmute')]));
          var wantVideo = (self.call && self.call.call_type === 'video') || self.formData.call_type === 'video';
          if (wantVideo) {
            controls.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.toggleCam(); } } }, [self.camOn ? tr('camera_off') : tr('camera_on')]));
          }
        }
        controls.appendChild(el('button', { class: 'ccw-btn danger', on: { click: function () { self.cancelCall(); } } }, [tr('end')]));
        return el('div', { class: 'ccw-stack' }, [card, controls]);
      }

      case STATES.ENDED: {
        if (self.callbackId) {
          var ref = String(self.callbackId).slice(0, 8).toUpperCase();
          var when = self.formData.callback_when === 'later' && self.formData.callback_scheduled_for
            ? new Date(self.formData.callback_scheduled_for).toLocaleString()
            : tr('asap');
          var chLabel = self.formData.callback_channel === 'video' ? tr('video_callback') : tr('phone_callback');
          return el('div', { class: 'ccw-stack' }, [
            el('div', { class: 'ccw-success-card' }, [
              el('div', { class: 'ccw-success-icon' }, ['✓']),
              el('div', { class: 'ccw-success-title' }, [tr('callback_scheduled')]),
              el('div', { class: 'ccw-muted', style: 'text-align:center;' }, [tr('reach_out', { when: when })]),
              el('div', { class: 'ccw-ref-row' }, [
                el('span', { class: 'ccw-ref-label' }, [tr('reference')]),
                el('code', { class: 'ccw-ref-code' }, [ref]),
              ]),
              el('div', { class: 'ccw-ref-row' }, [
                el('span', { class: 'ccw-ref-label' }, [tr('type')]),
                el('span', {}, [chLabel]),
              ]),
            ]),
            el('button', { class: 'ccw-btn primary', on: { click: function () { self.reset(); } } }, [tr('done')]),
          ]);
        }
        // Post-call rating screen (only when the call actually started).
        var stack = [];
        var durLabel = self.endedDuration > 0 ? fmtTime(self.endedDuration * 1000) : null;
        var endedCard = el('div', { class: 'ccw-card ccw-ended-card' }, [
          el('div', { class: 'ccw-ended-icon' }, ['✓']),
          el('div', { class: 'ccw-ended-title' }, [tr('call_ended')]),
        ]);
        if (self.operatorName) {
          endedCard.appendChild(el('div', { class: 'ccw-muted', style: 'text-align:center;' }, [self.operatorName]));
        }
        if (durLabel) {
          endedCard.appendChild(el('div', { class: 'ccw-ended-duration' }, [
            el('span', {}, [tr('call_duration')]),
            el('strong', {}, [durLabel]),
          ]));
        }
        stack.push(endedCard);
        if (self.endedCallId && !self.ratingSubmitted) {
          var rateBox = el('div', { class: 'ccw-rate-box' }, [
            el('div', { class: 'ccw-rate-title' }, [tr('rate_call_title')]),
            el('div', { class: 'ccw-rate-sub' }, [tr('rate_call_sub')]),
          ]);
          var stars = el('div', { class: 'ccw-rate-stars' });
          var renderStars = function () {
            stars.replaceChildren();
            for (var i = 1; i <= 5; i++) {
              (function (n) {
                var btn = el('button', {
                  class: 'ccw-star' + (self.ratingValue >= n ? ' filled' : ''),
                  type: 'button',
                  'aria-label': String(n),
                  on: { click: function () { self.ratingValue = n; renderStars(); } },
                }, ['★']);
                stars.appendChild(btn);
              })(i);
            }
          };
          renderStars();
          rateBox.appendChild(stars);
          var ta = el('textarea', { class: 'ccw-textarea', placeholder: tr('rate_comment_ph') });
          ta.value = self.ratingComment || '';
          ta.addEventListener('input', function (e) { self.ratingComment = e.target.value; });
          rateBox.appendChild(ta);
          rateBox.appendChild(el('div', { class: 'ccw-row' }, [
            el('button', { class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, [tr('rate_skip')]),
            el('button', { class: 'ccw-btn primary', on: { click: function () { self.submitRating(); } } }, [tr('rate_submit')]),
          ]));
          stack.push(rateBox);
        } else if (self.ratingSubmitted) {
          stack.push(el('div', { class: 'ccw-rate-thanks' }, [tr('rate_thanks')]));
          stack.push(el('button', { class: 'ccw-btn primary', on: { click: function () { self.reset(); } } }, [tr('done')]));
        } else {
          stack.push(el('button', { class: 'ccw-btn primary', on: { click: function () { self.reset(); } } }, [tr('done')]));
        }
        return el('div', { class: 'ccw-stack' }, stack);
      }

      case STATES.ERROR:
        return el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-error' }, [tr('error_prefix', { error: self.error || tr('unknown') })]),
          el('button', { class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, [tr('back')]),
        ]);
    }
    return el('div', {}, ['…']);
  };

  function renderForm(cfg, forCall) {
    var self = this;
    var tr = function (key, vars) { return self.t(key, vars); };
    var policy = (self.bootstrap && self.bootstrap.callback_policy) || {};
    var box = el('div', { class: 'ccw-stack' });
    if (!forCall) {
      box.appendChild(el('div', { class: 'ccw-cb-intro' }, [
        el('div', { class: 'ccw-cb-intro-title' }, [tr('request_callback_title')]),
        el('div', { class: 'ccw-muted' }, [tr('callback_intro')]),
      ]));
    }
    // Channel segmented control (callback only)
    if (!forCall) {
      var caps2 = (self.bootstrap && self.bootstrap.capabilities) || {};
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('callback_type')]));
      var seg = el('div', { class: 'ccw-segment' });
      function mkSeg(val, label) {
        var active = (self.formData.callback_channel === val);
        var b = el('button', { class: 'ccw-seg-btn' + (active ? ' active' : ''), type: 'button',
          on: { click: function () { self.formData.callback_channel = val; self.render(); } } }, [label]);
        return b;
      }
      seg.appendChild(mkSeg('audio', tr('phone')));
      if (caps2.video) seg.appendChild(mkSeg('video', tr('video')));
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
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('department')]));
      var sel = el('select', { class: 'ccw-input' });
      var ph = el('option', { value: '' }, [tr('choose_department')]);
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
      var knownName = self.identifiedContact.name || self.formData.name || tr('known_contact');
      box.appendChild(el('div', { class: 'ccw-known-contact' }, [
        el('div', { class: 'ccw-known-dot' }, ['✓']),
        el('div', {}, [
          el('div', { class: 'ccw-known-title' }, [knownName]),
          el('div', { class: 'ccw-muted' }, [tr('contact_saved')]),
        ]),
      ]));
    }
    var configuredFields = forCall && Array.isArray(cfg.pre_call_form_schema)
      ? cfg.pre_call_form_schema : [];
    var fields = configuredFields.length ? configuredFields : (alreadyIdentified
      ? [['subject', tr('subject'), 'text']]
      : [
        ['name', tr('full_name'), 'text'],
        ['email', !forCall && policy.require_contact ? tr('email_required') : tr('email'), 'email'],
        ['phone', !forCall && policy.require_contact ? tr('phone_required') : tr('phone_field'), 'tel'],
        ['subject', tr('subject'), 'text'],
      ]);
    if (configuredFields.length && alreadyIdentified) {
      fields = fields.filter(function (field) {
        return ['name', 'email', 'phone'].indexOf(field.id) < 0;
      });
    }
    fields.forEach(function (f) {
      var descriptor = Array.isArray(f)
        ? { id: f[0], label: f[1], type: f[2], required: false }
        : f;
      var label = el('label', { class: 'ccw-label' }, [
        descriptor.label + (descriptor.required ? ' *' : ''),
      ]);
      var builtIn = ['name', 'email', 'phone', 'subject'].indexOf(descriptor.id) >= 0;
      self.formData.custom = self.formData.custom || {};
      var current = builtIn ? self.formData[descriptor.id] : self.formData.custom[descriptor.id];
      var input;
      if (descriptor.type === 'textarea') {
        input = el('textarea', { class: 'ccw-textarea', placeholder: descriptor.placeholder || '' });
        input.value = current || '';
      } else if (descriptor.type === 'select') {
        input = el('select', { class: 'ccw-input' });
        input.appendChild(el('option', { value: '' }, [descriptor.placeholder || '—']));
        (descriptor.options || []).forEach(function (option) {
          var optionEl = el('option', { value: option.value }, [option.label]);
          if (current === option.value) optionEl.selected = true;
          input.appendChild(optionEl);
        });
      } else if (descriptor.type === 'checkbox') {
        input = el('input', { type: 'checkbox' });
        input.checked = current === true;
      } else {
        input = el('input', {
          class: 'ccw-input',
          type: descriptor.type || 'text',
          value: current || '',
          placeholder: descriptor.placeholder || '',
        });
      }
      input.addEventListener(descriptor.type === 'checkbox' ? 'change' : 'input', function (e) {
        var value = descriptor.type === 'checkbox' ? !!e.target.checked : e.target.value;
        if (builtIn) self.formData[descriptor.id] = value;
        else self.formData.custom[descriptor.id] = value;
      });
      box.appendChild(label);
      box.appendChild(input);
    });
    if (!forCall && policy.require_contact && !alreadyIdentified) {
      box.appendChild(el('div', { class: 'ccw-muted', style: 'font-size:11px;margin-top:-4px;' }, [
        tr('contact_required_note'),
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
        ? tr('message_min', { n: policy.min_message_length })
        : tr('message_optional');
      box.appendChild(el('label', { class: 'ccw-label' }, [msgLabel]));
      var ta = el('textarea', { class: 'ccw-textarea', placeholder: tr('message_placeholder') });
      ta.value = self.formData.message || '';
      ta.addEventListener('input', function (e) { self.formData.message = e.target.value; });
      box.appendChild(ta);
      // When
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('when_call')]));
      var when = el('div', { class: 'ccw-segment' });
      function mkWhen(val, label) {
        var active = (self.formData.callback_when === val);
        return el('button', { class: 'ccw-seg-btn' + (active ? ' active' : ''), type: 'button',
          on: { click: function () { self.formData.callback_when = val; self.render(); } } }, [label]);
      }
      when.appendChild(mkWhen('now', '⚡ ' + tr('asap')));
      when.appendChild(mkWhen('later', tr('schedule')));
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
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('priority')]));
      var ur = el('div', { class: 'ccw-segment' });
      function mkUr(val, label) {
        var active = (self.formData.callback_urgency === val);
        return el('button', { class: 'ccw-seg-btn' + (active ? ' active' : '') + (val === 'urgent' && active ? ' danger' : ''), type: 'button',
          on: { click: function () { self.formData.callback_urgency = val; self.render(); } } }, [label]);
      }
      ur.appendChild(mkUr('normal', tr('normal')));
      ur.appendChild(mkUr('urgent', tr('urgent')));
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
        cb.appendChild(document.createTextNode(tr('consent_required')));
        box.appendChild(cb);
      } else if (rec.effective_enabled) {
        box.appendChild(el('div', { class: 'ccw-muted' }, [
          tr('call_may_record'),
        ]));
      }
    }
    if (self.error) box.appendChild(el('div', { class: 'ccw-error' }, [self.error]));
    var actions = el('div', { class: 'ccw-row' }, [
      el('button', { class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, [tr('back')]),
      el('button', { class: 'ccw-btn primary', on: { click: function () { forCall ? self.submitCall() : self.submitCallback(); } } },
        [forCall ? tr('start_call') : tr('send_request')]),
    ]);
    box.appendChild(actions);
    return box;
  };


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
