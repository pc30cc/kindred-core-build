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

  // ───── Debug logger ─────
  // Always logs to console with a [gs-call] prefix. Cheap, no PII; helps
  // diagnose visibility/lifecycle issues across the widget call surface.
  // Caller can disable with `window.__gs_call_debug = false`.
  function dlog() {
    if (window.__gs_call_debug === false) return;
    try {
      var args = ['[gs-call]'].concat(Array.prototype.slice.call(arguments));
      // eslint-disable-next-line no-console
      console.log.apply(console, args);
    } catch (_) {}
  }

  function normalizeLiveKitWsUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
    try {
      var url = new URL(rawUrl);
      // CRITICAL: livekit-client appends its own signaling path
      // (`/rtc`, `/rtc/v1`, `/rtc/validate`, etc.) to whatever base
      // URL we hand it. We must therefore return an ORIGIN-ONLY base
      // (`wss://host[:port]`) and strip any pre-existing signaling suffix,
      // including malformed duplicates like `/rtc/rtc/v1`.
      url.pathname = url.pathname.replace(/(?:\/rtc)+(?:\/v1)?(?:\/validate)?\/?$/i, '');
      url.pathname = url.pathname.replace(/\/+$/, '');
      if (!url.pathname) url.pathname = '';
      // Reconstruct origin-only (drop search/hash too — signaling base
      // never carries query params).
      return (url.protocol + '//' + url.host + url.pathname).replace(/\/+$/, '');
    } catch (_) {
      return rawUrl;
    }
  }

  // CDN fallback. Self-hosters can override via window.__gs_call_sdk_url.
  var LIVEKIT_SDK_URL = (window && window.__gs_call_sdk_url)
    || 'https://cdn.jsdelivr.net/npm/livekit-client@2.18.6/dist/livekit-client.umd.min.js';
  // ─── Version-alignment note ──────────────────────────────────────────
  // The operator app installs livekit-client 2.18.x via npm and the server
  // is on 1.9.x. Keeping the widget on 2.5.0 caused a signaling-protocol
  // skew where the visitor (widget) side periodically dropped with
  // SIGNAL_SOURCE_CLOSE while the operator stayed connected. Bumping the
  // CDN pin to 2.18.6 puts both sides on the same major/minor family.

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
  var localVideoEl = null;
  var statusEl = null;
  var btnAccept = null;
  var btnReject = null;
  var btnMic = null;
  var btnCam = null;
  var btnHangup = null;
  var degradedEl = null;
  // Phase 9 — track the mount mode so we know whether we are inside the
  // widget panel (preferred) or floating as a sidecar (legacy fallback).
  var mountMode = 'sidecar'; // 'in-panel' | 'sidecar'
  // Re-mount when the widget shell appears late (loader→runtime race) so
  // late-arriving incoming calls still mount inside the panel.
  var remountWatcher = null;

  function getWidgetMountTarget() {
    try {
      var inst = window.__gs_runtime && window.__gs_runtime._instance;
      if (inst && typeof inst.getCallMountHost === 'function') {
        var host = inst.getCallMountHost();
        if (host && host.appendChild) {
          dlog('mount target resolved → in-panel call-host', {
            w: host.clientWidth, h: host.clientHeight,
            display: host.style.display,
          });
          return host;
        }
      }
      dlog('mount target unresolved → will fall back to body sidecar');
    } catch (_) {}
    return null;
  }

  // If the widget panel mounts AFTER an incoming call surface has been
  // shown (e.g. polling-mode delivers the invite before the chat tab is
  // opened), migrate the existing host into the panel. This keeps the
  // call UI bounded by the widget frame even on the slow path.
  function watchForPanelMount() {
    if (remountWatcher || mountMode === 'in-panel') return;
    var tries = 0;
    remountWatcher = setInterval(function () {
      tries++;
      var target = getWidgetMountTarget();
      if (target && hostEl && hostEl.parentNode !== target) {
        try {
          target.appendChild(hostEl);
          mountMode = 'in-panel';
          applyMountStyles();
        } catch (_) {}
      }
      if (mountMode === 'in-panel' || tries > 50) {
        clearInterval(remountWatcher);
        remountWatcher = null;
      }
    }, 200);
  }

  function applyMountStyles() {
    if (!hostEl) return;
    if (mountMode === 'in-panel') {
      // Inside the dedicated stable call mount root (sibling of .panel
      // inside .shell). The mount root itself is already sized/positioned
      // to overlay the panel area — we just fill it.
      hostEl.style.cssText = [
        'all:initial',
        'display:block',
        'position:absolute',
        'inset:0',
        'z-index:1',
        'pointer-events:auto',
      ].join(';');
    } else {
      // Sidecar fallback — only used when the widget shell isn't present
      // (e.g. legacy direct-incoming on a page without an open panel).
      hostEl.style.cssText = [
        'all:initial',
        'position:fixed',
        'inset:auto 16px 16px auto',
        'z-index:2147483646',
      ].join(';');
    }
  }

  function ensureShell() {
    if (hostEl) {
      // Re-evaluate mount target on every show in case the widget shell
      // appeared since last call (loader→runtime race).
      var nowTarget = getWidgetMountTarget();
      if (nowTarget && hostEl.parentNode !== nowTarget) {
        try {
          nowTarget.appendChild(hostEl);
          mountMode = 'in-panel';
          if (hostEl.setAttribute) hostEl.setAttribute('data-mode', mountMode);
          applyMountStyles();
          dlog('host migrated into in-panel target');
        } catch (_) {}
      }
      return;
    }
    hostEl = document.createElement('div');
    hostEl.setAttribute('data-gs-call-host', '');
    var initialTarget = getWidgetMountTarget();
    mountMode = initialTarget ? 'in-panel' : 'sidecar';
    dlog('ensureShell → first mount', { mountMode: mountMode });
    applyMountStyles();
    shadow = hostEl.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = [
      ':host,*{box-sizing:border-box}',
      // In-panel: fill the available space; sidecar: a 320px floating card.
      // Layout uses container-style breakpoints rather than hard pixel
      // widths so the call surface stays inside whatever frame hosts it.
      ':host([data-mode="in-panel"]) .card{width:100%;height:100%;min-height:100%;border:0;border-radius:0;box-shadow:none;padding:12px;display:none;flex-direction:column}',
      ':host([data-mode="sidecar"]) .card{width:320px;min-height:300px;padding:14px;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 32px -8px rgba(0,0,0,.18);display:none;flex-direction:column}',
      '.card{font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#fff;color:#0f172a;overflow:hidden}',
      '.card.show{display:flex}',
      '@media (prefers-color-scheme: dark){.card{background:#0f172a;color:#f1f5f9;border-color:#1e293b}}',
      '.title{font-weight:600;font-size:14px;margin:0 0 4px}',
      '.sub{color:#64748b;font-size:12px;margin:0 0 10px}',
      '.row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;flex:0 0 auto}',
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
      // Video stage — fills available card area inside the panel,
      // capped at 220px in sidecar mode so the floating card stays
      // small. The local self-view is a 25%-wide PIP in the bottom-right.
      '.stage{position:relative;width:100%;background:#000;border-radius:8px;overflow:hidden;display:none;flex:1 1 280px;min-height:220px;isolation:isolate}',
      '.stage.show{display:block}',
      ':host([data-mode="sidecar"]) .stage{height:220px;min-height:220px;flex:0 0 220px}',
      ':host([data-mode="in-panel"]) .stage{margin-bottom:8px;flex:1 1 320px;min-height:260px}',
      '.stage video.remote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;display:block}',
      '.stage .pip{position:absolute;right:8px;bottom:8px;width:30%;max-width:120px;aspect-ratio:4/3;border-radius:6px;overflow:hidden;border:2px solid rgba(255,255,255,.7);background:#111;box-shadow:0 4px 12px rgba(0,0,0,.4)}',
      '.stage .pip video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}',
      '.stage .nostream{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12px;z-index:1}',
      // Audio-only stage — compact pulse + status, never a fake video tile.
      '.audio-stage{display:none;flex-direction:column;align-items:center;justify-content:center;padding:18px 12px;background:linear-gradient(135deg,#f1f5f9,#e2e8f0);border-radius:8px;gap:10px;flex:1 1 auto;min-height:120px}',
      '.audio-stage.show{display:flex}',
      '@media (prefers-color-scheme: dark){.audio-stage{background:linear-gradient(135deg,#1e293b,#0f172a)}}',
      '.audio-stage .pulse{width:54px;height:54px;border-radius:50%;background:#16a34a;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;box-shadow:0 0 0 0 rgba(22,163,74,.5);animation:ringpulse 1.6s infinite}',
      '@keyframes ringpulse{0%{box-shadow:0 0 0 0 rgba(22,163,74,.45)}70%{box-shadow:0 0 0 16px rgba(22,163,74,0)}100%{box-shadow:0 0 0 0 rgba(22,163,74,0)}}',
      '.audio-stage .label{font-size:12px;color:#475569;font-weight:500}',
      '@media (prefers-color-scheme: dark){.audio-stage .label{color:#cbd5e1}}',
      '.status{font-size:11px;color:#64748b;margin-top:6px}',
      '.status.ended{color:#dc2626;font-weight:600}',
      '.degraded{font-size:11px;color:#b45309;background:#fef3c7;border-radius:6px;padding:6px 8px;margin-top:6px;display:none}',
      '.degraded.show{display:block}',
      '.cbfield{display:flex;flex-direction:column;gap:3px;margin-top:8px}',
      '.cblabel{font-size:11px;color:#64748b;font-weight:500}',
      '.cbinput{width:100%;border:1px solid #e2e8f0;border-radius:6px;padding:7px 9px;font:inherit;color:inherit;background:transparent;outline:none}',
      '.cbinput:focus{border-color:#16a34a}',
      '.cbinput.invalid{border-color:#dc2626}',
      '@media (prefers-color-scheme: dark){.cbinput{border-color:#1e293b}}',
      '.cbnote{resize:vertical;min-height:48px;max-height:120px;font-family:inherit}',
      '.cbsched{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}',
      '.cbchip{flex:1 1 calc(50% - 6px);min-width:0;border:1px solid #e2e8f0;background:transparent;color:inherit;border-radius:6px;padding:7px 8px;font:inherit;font-size:11px;cursor:pointer;text-align:center}',
      '.cbchip:hover{background:#f8fafc}',
      '.cbchip.selected{background:#16a34a;color:#fff;border-color:#16a34a}',
      '@media (prefers-color-scheme: dark){.cbchip{border-color:#1e293b}.cbchip:hover{background:#1e293b}}',
      '.cbcustom{display:none;margin-top:6px}',
      '.cbcustom.show{display:block}',
      '.cberr{font-size:11px;color:#dc2626;margin-top:4px;display:none}',
      '.cberr.show{display:block}',
      '.pending{display:none;margin-top:8px;padding:8px 10px;border-radius:8px;background:#ecfeff;color:#0e7490;border:1px solid #a5f3fc;font-size:12px;line-height:1.4}',
      '.pending.show{display:block}',
      '.pending .pdot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#0891b2;margin-right:6px;vertical-align:middle;animation:pulse 1.4s infinite}',
      '.pending b{font-weight:600}',
      '.pending .cd{display:block;margin-top:2px;font-size:11px;color:#0891b2;opacity:.85}',
      '@media (prefers-color-scheme: dark){.pending{background:#0c2a30;color:#a5f3fc;border-color:#155e75}.pending .cd{color:#a5f3fc}}',
      '.greet{display:none;position:relative;margin:0 0 10px;padding:10px 32px 10px 12px;border-radius:10px;background:linear-gradient(135deg,#eff6ff,#ecfeff);color:#0c4a6e;border:1px solid #bae6fd;font-size:12px;line-height:1.45}',
      '.greet.show{display:block}',
      '.greet b{font-weight:600;display:block;margin-bottom:2px}',
      '.greet .gx{position:absolute;top:6px;right:8px;background:transparent;border:0;color:inherit;opacity:.6;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:4px}',
      '.greet .gx:hover{opacity:1;background:rgba(0,0,0,.06)}',
      '@media (prefers-color-scheme: dark){.greet{background:linear-gradient(135deg,#0c2a30,#0e3a4a);color:#a5f3fc;border-color:#155e75}}',
    ].join('');
    shadow.appendChild(style);
    // Drive layout via a host attribute so CSS can branch on mode.
    hostEl.setAttribute('data-mode', mountMode);

    rootEl = document.createElement('div');
    rootEl.className = 'card';
    rootEl.setAttribute('role', 'dialog');
    rootEl.setAttribute('aria-label', 'Incoming call');
    rootEl.innerHTML = [
      '<div class="greet" data-el="greet" role="status" aria-live="polite"><button class="gx" data-el="greet-x" type="button" aria-label="Dismiss">×</button><b data-el="greet-title">Need help?</b><span data-el="greet-body">Talk to our team in seconds.</span></div>',
      '<p class="title" data-el="title">Incoming call</p>',
      '<p class="sub" data-el="sub">Audio call from support</p>',
      '<div class="degraded" data-el="degraded">Audio-only mode (network limited)</div>',
      // Video call stage — main remote tile + local self-view PIP.
      '<div class="stage" data-el="stage">',
      '  <video class="remote" data-el="video" autoplay playsinline></video>',
      '  <div class="pip" data-el="pip" style="display:none"><video data-el="local-video" autoplay playsinline muted></video></div>',
      '  <div class="nostream" data-el="nostream" style="display:none">Waiting for video…</div>',
      '</div>',
      // Audio-only stage — separate, never used during video calls.
      '<div class="audio-stage" data-el="audio-stage">',
      '  <div class="pulse" aria-hidden="true">📞</div>',
      '  <div class="label" data-el="audio-label">Connected</div>',
      '</div>',
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
      '  <div class="cbfield"><label class="cblabel">When should we call?</label>',
      '    <div class="cbsched" data-el="cb-sched" role="radiogroup" aria-label="Callback time">',
      '      <button class="cbchip selected" type="button" data-sched="now">As soon as possible</button>',
      '      <button class="cbchip" type="button" data-sched="30m">In 30 minutes</button>',
      '      <button class="cbchip" type="button" data-sched="1h">In 1 hour</button>',
      '      <button class="cbchip" type="button" data-sched="tomorrow">Tomorrow</button>',
      '      <button class="cbchip" type="button" data-sched="custom">Custom time</button>',
      '    </div>',
      '    <div class="cbcustom" data-el="cb-custom"><input class="cbinput" data-el="cb-custom-input" type="datetime-local" /></div>',
      '  </div>',
      '  <div class="cberr" data-el="cb-error"></div>',
      '  <div class="row" style="margin-top:10px"><button class="btn primary" data-el="cb-submit" type="button">Request callback</button><button class="btn ghost" data-el="cb-cancel" type="button">Cancel</button></div>',
      '</div>',
      '<div class="pending" data-el="cb-pending" role="status" aria-live="polite" aria-atomic="true"><span class="pdot" aria-hidden="true"></span><b data-el="cb-pending-title">Callback pending</b><span class="cd" data-el="cb-pending-cd"></span></div>',
      '<p class="status" data-el="status"></p>',
    ].join('');
    shadow.appendChild(rootEl);
    var mountTarget = initialTarget || document.body;
    mountTarget.appendChild(hostEl);
    // If we landed on body, watch for the panel so a late mount migrates.
    if (mountMode !== 'in-panel') watchForPanelMount();

    audioEl = rootEl.querySelector('[data-el="audio"]');
    videoEl = rootEl.querySelector('[data-el="video"]');
    localVideoEl = rootEl.querySelector('[data-el="local-video"]');
    statusEl = rootEl.querySelector('[data-el="status"]');
    btnAccept = rootEl.querySelector('[data-el="accept"]');
    btnReject = rootEl.querySelector('[data-el="reject"]');
    btnMic = rootEl.querySelector('[data-el="mic"]');
    btnCam = rootEl.querySelector('[data-el="cam"]');
    btnHangup = rootEl.querySelector('[data-el="hangup"]');
    degradedEl = rootEl.querySelector('[data-el="degraded"]');
    bindVideoDebugOnce();
  }

  function getParticipantDescriptor(participant) {
    var participantType = 'unknown';
    var identity = participant && participant.identity ? String(participant.identity) : null;
    if (identity && identity.indexOf(':') !== -1) participantType = identity.split(':', 1)[0] || participantType;
    if (participant && participant.metadata) {
      try {
        var parsed = JSON.parse(participant.metadata);
        if (parsed && parsed.participant_type) participantType = String(parsed.participant_type);
      } catch (_) {}
    }
    return {
      participantIdentity: identity,
      participantType: participantType,
      isOperator: participantType === 'operator' || !!(identity && identity.indexOf('operator:') === 0),
    };
  }

  function readBox(el) {
    if (!el) return null;
    var rect = null;
    var style = null;
    try { rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch (_) {}
    try { style = window.getComputedStyle ? window.getComputedStyle(el) : null; } catch (_) {}
    return {
      w: typeof el.clientWidth === 'number' ? el.clientWidth : 0,
      h: typeof el.clientHeight === 'number' ? el.clientHeight : 0,
      rectW: rect ? Math.round(rect.width) : 0,
      rectH: rect ? Math.round(rect.height) : 0,
      display: style ? style.display : null,
      position: style ? style.position : null,
      minH: style ? style.minHeight : null,
      height: style ? style.height : null,
      flex: style ? style.flex : null,
    };
  }

  function getLayoutSnapshot() {
    var inst = null;
    var mountHost = null;
    var stage = null;
    try {
      inst = window.__gs_runtime && window.__gs_runtime._instance;
      mountHost = inst && inst.getCallMountHost ? inst.getCallMountHost() : null;
    } catch (_) {}
    try { stage = rootEl && rootEl.querySelector ? rootEl.querySelector('[data-el="stage"]') : null; } catch (_) {}
    return {
      mountMode: mountMode,
      mountHost: readBox(mountHost),
      hostEl: readBox(hostEl),
      card: readBox(rootEl),
      stage: readBox(stage),
      video: readBox(videoEl),
    };
  }

  function dlogLayout(label, extra) {
    var payload = getLayoutSnapshot();
    if (extra && typeof extra === 'object') {
      var keys = Object.keys(extra);
      for (var i = 0; i < keys.length; i++) payload[keys[i]] = extra[keys[i]];
    }
    dlog(label, payload);
  }

  function ensureStageLayout(reason) {
    if (!rootEl) return;
    var stage = rootEl.querySelector('[data-el="stage"]');
    if (!stage) return;
    if (!stage.classList.contains('show')) {
      stage.style.height = '';
      return;
    }
    if (mountMode === 'sidecar') {
      stage.style.height = '220px';
      stage.style.minHeight = '220px';
      dlogLayout('stage layout applied', { reason: reason, stageHeightPx: 220 });
      return;
    }
    var snap = getLayoutSnapshot();
    var availableHeight = (snap.mountHost && snap.mountHost.h) || (snap.hostEl && snap.hostEl.h) || (snap.card && snap.card.h) || 0;
    var stageHeight = availableHeight > 0 ? Math.max(240, Math.min(availableHeight - 180, 420)) : 300;
    stage.style.height = stageHeight + 'px';
    stage.style.minHeight = stageHeight + 'px';
    dlogLayout('stage layout applied', { reason: reason, stageHeightPx: stageHeight });
  }

  function bindVideoDebugOnce() {
    if (!videoEl || videoEl.__gsDebugBound) return;
    videoEl.__gsDebugBound = true;
    ['loadedmetadata', 'playing', 'resize', 'pause', 'waiting', 'emptied'].forEach(function (evtName) {
      videoEl.addEventListener(evtName, function () {
        dlogLayout('remote video ' + evtName, {
          readyState: typeof videoEl.readyState === 'number' ? videoEl.readyState : null,
          networkState: typeof videoEl.networkState === 'number' ? videoEl.networkState : null,
          paused: !!videoEl.paused,
          currentTime: Number(videoEl.currentTime || 0),
          videoWidth: typeof videoEl.videoWidth === 'number' ? videoEl.videoWidth : 0,
          videoHeight: typeof videoEl.videoHeight === 'number' ? videoEl.videoHeight : 0,
          hasSrcObject: !!videoEl.srcObject,
        });
      });
    });
    if (window.ResizeObserver) {
      var stage = rootEl && rootEl.querySelector ? rootEl.querySelector('[data-el="stage"]') : null;
      var lastSig = '';
      var ro = new ResizeObserver(function () {
        var snap = getLayoutSnapshot();
        var sig = [
          snap.mountHost ? snap.mountHost.w + 'x' + snap.mountHost.h : '0x0',
          snap.hostEl ? snap.hostEl.w + 'x' + snap.hostEl.h : '0x0',
          snap.card ? snap.card.w + 'x' + snap.card.h : '0x0',
          snap.stage ? snap.stage.w + 'x' + snap.stage.h : '0x0',
          snap.video ? snap.video.w + 'x' + snap.video.h : '0x0',
        ].join('|');
        if (sig === lastSig) return;
        lastSig = sig;
        dlog('remote video resize-observed', snap);
      });
      if (stage) ro.observe(stage);
      ro.observe(videoEl);
      videoEl.__gsResizeObserver = ro;
    }
  }

  function isCallActiveOrConnecting() {
    if (!current) return false;
    if (current.room) return true;
    // While accept() is running we have `current` but no room yet — the
    // SDK is mid-handshake. Treat that as active so a stray hide() can't
    // pull the rug out from under it.
    return !!current.invite;
  }

  function show() {
    ensureShell();
    rootEl.classList.add('show');
    dlog('show() → .card.show added', { mountMode: mountMode });
    // Defensive: if our hostEl somehow lost its in-panel target between
    // calls (shell rerender, stale parent), re-attach to the live mount
    // root so the surface is always inside the widget frame.
    try {
      var liveTarget = getWidgetMountTarget();
      if (liveTarget && hostEl && hostEl.parentNode !== liveTarget) {
        liveTarget.appendChild(hostEl);
        mountMode = 'in-panel';
        if (hostEl.setAttribute) hostEl.setAttribute('data-mode', mountMode);
        applyMountStyles();
        dlog('show() → re-attached host to live in-panel target');
      }
    } catch (_) {}
  }
  function hide(opts) {
    var force = !!(opts && opts.force);
    // Guard: never hide a live call surface from stale paths (e.g. a
    // delayed pending-callback timer firing while a real call started).
    if (!force && isCallActiveOrConnecting()) {
      dlog('hide() suppressed — call active/connecting');
      return;
    }
    if (rootEl) rootEl.classList.remove('show');
    // Release the stable widget mount root so chat clicks pass through
    // again and the host stops covering the panel area.
    try {
      var inst = window.__gs_runtime && window.__gs_runtime._instance;
      if (inst && typeof inst.releaseCallMountHost === 'function') {
        inst.releaseCallMountHost();
        dlog('hide() → released call mount host');
      }
    } catch (_) {}
  }
  function setStatus(t, kind) {
    if (!statusEl) return;
    statusEl.textContent = t || '';
    statusEl.classList.toggle('ended', kind === 'ended');
  }
  function setRingingMode() {
    if (!rootEl) return;
    rootEl.querySelector('[data-el="ring-row"]').style.display = 'flex';
    rootEl.querySelector('[data-el="call-row"]').style.display = 'none';
    var stage = rootEl.querySelector('[data-el="stage"]');
    var astage = rootEl.querySelector('[data-el="audio-stage"]');
    if (stage) stage.classList.remove('show');
    if (astage) astage.classList.remove('show');
    dlog('setRingingMode()');
  }
  function setInCallMode(isVideo) {
    if (!rootEl) return;
    rootEl.querySelector('[data-el="ring-row"]').style.display = 'none';
    rootEl.querySelector('[data-el="call-row"]').style.display = 'flex';
    var stage = rootEl.querySelector('[data-el="stage"]');
    var astage = rootEl.querySelector('[data-el="audio-stage"]');
    if (isVideo) {
      if (stage) stage.classList.add('show');
      if (astage) astage.classList.remove('show');
    } else {
      if (stage) stage.classList.remove('show');
      if (astage) astage.classList.add('show');
    }
    // Hide camera toggle on audio calls — it's never relevant.
    if (btnCam) btnCam.style.display = isVideo ? '' : 'none';
    // Re-assert host visibility — at this point the user has already
    // accepted, so anything that disabled the host surface is a bug. We
    // explicitly re-show via the runtime API.
    try {
      var inst = window.__gs_runtime && window.__gs_runtime._instance;
      if (inst && typeof inst.getCallMountHost === 'function') {
        // Re-running getCallMountHost() also re-asserts display:block +
        // pointer-events:auto on the stable mount root.
        inst.getCallMountHost();
      }
    } catch (_) {}
    if (rootEl) rootEl.classList.add('show');
    ensureStageLayout('setInCallMode:' + (isVideo ? 'video' : 'audio'));
    // If a remote video track was attached BEFORE the stage became
    // visible (the original Bug A), the <video> element will be paused
    // with zero layout. Now that the stage is shown, re-issue play() so
    // it actually displays frames. Safe to call repeatedly.
    if (isVideo && videoEl && videoEl.srcObject) {
      try {
        var p = videoEl.play();
        if (p && p.catch) p.catch(function () {});
      } catch (_) {}
    }
    dlogLayout('setInCallMode()', {
      isVideo: isVideo,
      cardVisible: rootEl ? rootEl.classList.contains('show') : false,
      stageOn: stage ? stage.classList.contains('show') : false,
      audioStageOn: astage ? astage.classList.contains('show') : false,
    });
  }

  // ───── Single active call state ─────
  var current = null; // { invite, room, micEnabled, camEnabled }
  var lastDispatchedCallId = null; // dedupe poll-mode dispatch
  // Phase 8D+ — Callback request guard (in-memory).
  var isSubmittingCallback = false;
  var lastCallbackSubmitTs = 0;
  var callbackRequestedFlag = false;
  // Phase 8D++ — Cooldown + persistent pending state (UI-only).
  var callbackCooldownUntilMs = 0;
  var callbackCooldownTimer = null;
  var callbackStatusChecked = false;

  function fmtRemaining(ms) {
    // Zero-state — show a positive cue instead of the raw "0 minutes" string.
    if (ms <= 0) return 'You can request again';
    var totalSec = Math.ceil(ms / 1000);
    if (totalSec < 60) return 'You can request again in ' + totalSec + 's';
    var min = Math.ceil(totalSec / 60);
    return 'You can request again in ' + min + ' minute' + (min === 1 ? '' : 's');
  }

  function startCooldownTicker() {
    if (callbackCooldownTimer) { clearInterval(callbackCooldownTimer); callbackCooldownTimer = null; }
    if (!rootEl) return;
    var cdEl = rootEl.querySelector('[data-el="cb-pending-cd"]');
    if (!cdEl) return;
    function tick() {
      var remain = callbackCooldownUntilMs - Date.now();
      if (remain <= 0) {
        // Stop the timer and switch to the friendly zero-state message
        // (announced once via the aria-live region — no further updates).
        cdEl.textContent = 'You can request again';
        if (callbackCooldownTimer) { clearInterval(callbackCooldownTimer); callbackCooldownTimer = null; }
        return;
      }
      cdEl.textContent = fmtRemaining(remain);
    }
    tick();
    callbackCooldownTimer = setInterval(tick, 15000);
  }

  function showPendingBadge(opts) {
    ensureShell();
    var pendingEl = rootEl.querySelector('[data-el="cb-pending"]');
    var titleEl = rootEl.querySelector('[data-el="cb-pending-title"]');
    if (!pendingEl || !titleEl) return;
    titleEl.textContent = (opts && opts.message) || 'Callback pending';
    // Combined accessible label so screen readers get one descriptive phrase
    // rather than the raw countdown number when the region updates.
    pendingEl.setAttribute('aria-label', titleEl.textContent + '. We will contact you soon.');
    pendingEl.classList.add('show');
    startCooldownTicker();
  }

  function hidePendingBadge() {
    if (!rootEl) return;
    var pendingEl = rootEl.querySelector('[data-el="cb-pending"]');
    if (pendingEl) {
      pendingEl.classList.remove('show');
      var cdEl = pendingEl.querySelector('[data-el="cb-pending-cd"]');
      if (cdEl) cdEl.textContent = '';
    }
    if (callbackCooldownTimer) { clearInterval(callbackCooldownTimer); callbackCooldownTimer = null; }
    callbackCooldownUntilMs = 0;
  }

  // ───── Phase 8E — Smart Greeting (dismissible, in-shell) ─────
  // Pure UI helper. Never touches widget FSM, identity, or transports.
  // The greeting's content is resolved deterministically from the page
  // context the caller passes in (or sniffed at call time as fallback).
  var greetDismissed = false;
  try {
    if (window.sessionStorage && window.sessionStorage.getItem('__gs_greet_dismissed') === '1') {
      greetDismissed = true;
    }
  } catch (_) {}

  function resolveWidgetGreeting(ctx) {
    var c = ctx || {};
    var path = (c.path || (typeof location !== 'undefined' ? location.pathname || '' : '')).toLowerCase();
    var timeOnPage = typeof c.time_on_page_ms === 'number' ? c.time_on_page_ms : 0;
    var scrolled = !!c.scrolled_significantly;
    if (path.indexOf('pricing') !== -1 || path.indexOf('plans') !== -1) {
      return { title: 'Need help choosing a plan?', body: 'Talk to us instantly — we can answer pricing questions in seconds.' };
    }
    if (path.indexOf('checkout') !== -1 || path.indexOf('cart') !== -1) {
      return { title: 'Stuck at checkout?', body: 'Start a quick call and we will walk you through it.' };
    }
    if (path.indexOf('docs') !== -1 || path.indexOf('help') !== -1 || path.indexOf('support') !== -1) {
      return { title: 'Looking for something specific?', body: 'A quick call usually beats searching the docs.' };
    }
    if (timeOnPage >= 20_000 || scrolled) {
      return { title: 'Have questions?', body: 'Start a quick call with our team — no wait if an agent is free.' };
    }
    return { title: 'Need help?', body: 'Talk to our team in seconds.' };
  }

  function showGreeting(ctx) {
    if (greetDismissed) return;
    ensureShell();
    var greetEl = rootEl.querySelector('[data-el="greet"]');
    var titleEl = rootEl.querySelector('[data-el="greet-title"]');
    var bodyEl = rootEl.querySelector('[data-el="greet-body"]');
    var xBtn = rootEl.querySelector('[data-el="greet-x"]');
    if (!greetEl || !titleEl || !bodyEl) return;
    var g = resolveWidgetGreeting(ctx);
    titleEl.textContent = g.title;
    bodyEl.textContent = g.body;
    greetEl.classList.add('show');
    if (xBtn && !xBtn.__bound) {
      xBtn.__bound = true;
      xBtn.addEventListener('click', function () {
        greetEl.classList.remove('show');
        greetDismissed = true;
        try { window.sessionStorage && window.sessionStorage.setItem('__gs_greet_dismissed', '1'); } catch (_) {}
      });
    }
    show();
  }

  // Phase 8D++ — Restore "pending" state across widget reopen.
  // Workspace + visitor scoped via existing widget auth. Best-effort.
  function checkCallbackStatus() {
    if (callbackStatusChecked) return;
    var ctx = getWidgetCtx();
    if (!ctx.apiBase || !ctx.token) return;
    callbackStatusChecked = true;
    try {
      fetch(ctx.apiBase + '/api/widget/callback/status', {
        method: 'GET',
        credentials: 'include',
        headers: { 'X-Widget-Token': ctx.token },
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        // Treat any non-open status (completed/cancelled/missing) as "no
        // pending callback" — clear the badge and reset local flags so the
        // CTA can render normally next time.
        var open = !!(j && j.has_open_callback &&
          (j.status === 'requested' || j.status === 'scheduled' || j.status === 'in_progress'));
        if (!open) {
          callbackRequestedFlag = false;
          hidePendingBadge();
          return;
        }
        callbackRequestedFlag = true;
        if (j.cooldown_until) {
          var t = new Date(j.cooldown_until).getTime();
          if (!isNaN(t)) callbackCooldownUntilMs = t;
        }
        showPendingBadge({ message: 'Callback pending' });
      }).catch(function () {});
    } catch (_) {}
  }

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
    var remoteVideoTrack = null;
    var remoteVideoAttachedEl = null;

    function safePlay(el) {
      if (!el || !el.isConnected) return;
      try {
        var p = el.play();
        dlog('video.play() attempted', {
          target: el === videoEl ? 'remote' : (el === localVideoEl ? 'local' : 'audio'),
          hasSrcObject: !!el.srcObject,
          isConnected: !!el.isConnected,
        });
        if (p && typeof p.catch === 'function') {
          p.catch(function (err) {
            if (err && err.name) Util.log && Util.log('[call] play suppressed', err.name);
            dlog('video.play() suppressed', {
              errorName: err && err.name,
              errorMessage: err && err.message,
              target: el === videoEl ? 'remote' : (el === localVideoEl ? 'local' : 'audio'),
            });
          });
        }
      } catch (_) {}
    }

    function setMediaStreamSrc(el, track) {
      if (!el || !el.isConnected) return false;
      var nextStream = track ? new MediaStream([track]) : null;
      var cur = el.srcObject;
      if (!track && !cur) return false;
      if (track && cur && cur.getTracks && cur.getTracks().indexOf(track) !== -1) return false;
      try { el.srcObject = nextStream; } catch (_) { return false; }
      return true;
    }

    function detachRemoteVideo(reason) {
      if (remoteVideoTrack && remoteVideoAttachedEl) {
        try { remoteVideoTrack.detach(remoteVideoAttachedEl); } catch (_) {}
      }
      remoteVideoTrack = null;
      remoteVideoAttachedEl = null;
      if (videoEl) {
        try { videoEl.srcObject = null; } catch (_) {}
      }
      dlogLayout('remote video detached', { reason: reason });
    }

    function attachRemoteVideo(track, publication, participant, reason) {
      if (!videoEl || !videoEl.isConnected || !track) return false;
      if (remoteVideoTrack === track && remoteVideoAttachedEl === videoEl) {
        dlogLayout('remote video attach skipped (same track)', { reason: reason });
        return false;
      }
      detachRemoteVideo('swap');
      ensureStageLayout('attachRemoteVideo:' + reason);
      try {
        track.attach(videoEl);
        remoteVideoTrack = track;
        remoteVideoAttachedEl = videoEl;
        dlogLayout('remote srcObject assigned', {
          reason: reason,
          participant: getParticipantDescriptor(participant),
          trackSid: track.sid || null,
          source: publication && publication.source ? String(publication.source) : null,
          muted: !!(publication && publication.isMuted),
          hasSrcObject: !!videoEl.srcObject,
        });
        safePlay(videoEl);
        return true;
      } catch (err) {
        dlog('remote video attach failed', {
          reason: reason,
          error: err && err.message,
          participant: getParticipantDescriptor(participant),
        });
        return false;
      }
    }

    function refresh() {
      if (!rootEl || !rootEl.isConnected) return;
      var firstAudio = null;
      var operatorVideo = null;
      room.remoteParticipants.forEach(function (p) {
        p.trackPublications.forEach(function (pub) {
          if (!pub.track || !pub.track.mediaStreamTrack) return;
          if (pub.kind === LK.Track.Kind.Audio && !firstAudio) firstAudio = pub.track.mediaStreamTrack;
          if (pub.kind === LK.Track.Kind.Video && !operatorVideo) {
            operatorVideo = { track: pub.track, publication: pub, participant: p };
          }
        });
      });
      var audioChanged = setMediaStreamSrc(audioEl, firstAudio);
      if (audioChanged && firstAudio) safePlay(audioEl);
      var videoChanged = false;
      if (operatorVideo && operatorVideo.track) {
        videoChanged = attachRemoteVideo(operatorVideo.track, operatorVideo.publication, operatorVideo.participant, 'refresh');
      } else if (remoteVideoTrack) {
        detachRemoteVideo('no-remote-video');
        videoChanged = true;
      }
      if (audioChanged || videoChanged || operatorVideo) {
        dlogLayout('refresh remote media', {
          audio: !!firstAudio,
          video: !!(operatorVideo && operatorVideo.track),
          operatorParticipant: operatorVideo ? getParticipantDescriptor(operatorVideo.participant) : null,
          remoteTrackSid: operatorVideo && operatorVideo.track ? (operatorVideo.track.sid || null) : null,
          remotePublicationSource: operatorVideo && operatorVideo.publication && operatorVideo.publication.source ? String(operatorVideo.publication.source) : null,
          videoElConnected: videoEl ? videoEl.isConnected : false,
          videoElW: videoEl ? videoEl.clientWidth : 0,
          videoElH: videoEl ? videoEl.clientHeight : 0,
          videoReadyState: videoEl ? videoEl.readyState : null,
          videoPaused: videoEl ? !!videoEl.paused : null,
          videoHasSrcObject: videoEl ? !!videoEl.srcObject : null,
        });
      }
      if (rootEl) {
        var ns = rootEl.querySelector('[data-el="nostream"]');
        var isVideoCall = current && current.invite && current.invite.call_type === 'video';
        if (ns) ns.style.display = (isVideoCall && !(operatorVideo && operatorVideo.track)) ? 'flex' : 'none';
      }
    }

    function refreshLocal() {
      if (!localVideoEl || !rootEl) return;
      if (!rootEl.isConnected) return;
      var pip = rootEl.querySelector('[data-el="pip"]');
      var lp = room.localParticipant;
      var localVideoTrack = null;
      if (lp && lp.trackPublications) {
        lp.trackPublications.forEach(function (pub) {
          if (pub.kind === LK.Track.Kind.Video && pub.track && pub.track.mediaStreamTrack) {
            localVideoTrack = pub.track.mediaStreamTrack;
          }
        });
      }
      if (localVideoTrack) {
        if (setMediaStreamSrc(localVideoEl, localVideoTrack)) {
          safePlay(localVideoEl);
          dlog('local PIP attached');
        }
        if (pip) pip.style.display = '';
      } else {
        setMediaStreamSrc(localVideoEl, null);
        if (pip) pip.style.display = 'none';
      }
    }

    room
      .on(LK.RoomEvent.ParticipantConnected, function (participant) {
        dlog('room event: participant connected', getParticipantDescriptor(participant));
        refresh();
      })
      .on(LK.RoomEvent.ParticipantDisconnected, function (participant) {
        dlog('room event: participant disconnected', getParticipantDescriptor(participant));
        refresh();
      })
      .on(LK.RoomEvent.TrackSubscribed, function (track, publication, participant) {
        dlog('room event: TrackSubscribed', {
          participant: getParticipantDescriptor(participant),
          trackKind: track && track.kind ? String(track.kind) : null,
          trackSid: track && track.sid ? String(track.sid) : null,
          source: publication && publication.source ? String(publication.source) : null,
          isSubscribed: publication ? !!publication.isSubscribed : null,
          isMuted: publication ? !!publication.isMuted : null,
        });
        refresh();
      })
      .on(LK.RoomEvent.TrackUnsubscribed, function (track, publication, participant) {
        dlog('room event: TrackUnsubscribed', {
          participant: getParticipantDescriptor(participant),
          trackKind: track && track.kind ? String(track.kind) : null,
          trackSid: track && track.sid ? String(track.sid) : null,
          source: publication && publication.source ? String(publication.source) : null,
        });
        if (track && remoteVideoTrack && track === remoteVideoTrack) detachRemoteVideo('track-unsubscribed');
        refresh();
      })
      .on(LK.RoomEvent.LocalTrackPublished, refreshLocal)
      .on(LK.RoomEvent.LocalTrackUnpublished, refreshLocal)
      .on(LK.RoomEvent.Reconnecting, function () {
        dlog('room event: reconnecting');
        setStatus('Reconnecting...');
      })
      .on(LK.RoomEvent.Reconnected, function () {
        dlog('room event: reconnected');
        setStatus('');
      })
      .on(LK.RoomEvent.Disconnected, function (reason) {
        dlog('room event: disconnected', { reason: reason });
        teardown('remote:' + String(reason == null ? 'unknown' : reason));
      });
    if (window.addEventListener && !window.__gsCallWindowResizeBound) {
      window.__gsCallWindowResizeBound = true;
      window.addEventListener('resize', function () {
        ensureStageLayout('window-resize');
        dlogLayout('window resize', {});
      });
    }
    refresh();
    refreshLocal();
  }

  function teardown(reason) {
    dlog('teardown', {
      reason: reason,
      hasCurrent: !!current,
      hasRoom: !!(current && current.room),
      connecting: !!(current && current.connecting),
    });
    if (current && current.room) {
      try { current.room.disconnect(); } catch (_) {}
    }
    current = null;
    // Distinguish "operator ended" (remote-initiated) from local actions
    // so the visitor sees a real explanation, not a generic "ended".
    var msg = '';
    if (reason === 'remote' || (typeof reason === 'string' && reason.indexOf('remote:') === 0)) msg = 'Operator ended the call';
    else if (reason === 'local') msg = 'Call ended';
    else if (reason === 'error') msg = ''; // accept() already set a reason
    setStatus(msg, reason === 'remote' ? 'ended' : null);
    setRingingMode();
    if (audioEl) audioEl.srcObject = null;
    if (videoEl) videoEl.srcObject = null;
    if (localVideoEl) localVideoEl.srcObject = null;
    if (degradedEl) degradedEl.classList.remove('show');
    // Show the terminal message a bit longer when the operator hung up so
    // the visitor actually reads it before the surface auto-closes.
    var hideDelay = (reason === 'remote' || (typeof reason === 'string' && reason.indexOf('remote:') === 0)) ? 2200 : 600;
    // teardown() is the legitimate close path — bypass the active-guard
    // we added to hide() so the surface actually disappears.
    setTimeout(function () { hide({ force: true }); }, hideDelay);
  }

  function reject() {
    teardown('reject');
  }

  function accept() {
    if (!current || !current.invite) return;
    var invite = current.invite;
    // Re-entrancy guard. accept() can be called from multiple paths:
    //   - manual user click on the Answer button
    //   - auto_accept on the invitation flow
    //   - duplicate showIncoming() dispatches (poll + realtime racing)
    // Each one would mint a new LK.Room with the same identity, and
    // LiveKit kicks the older one with SIGNAL_SOURCE_CLOSE — which is
    // exactly the visitor-side instability we're chasing. Bail silently
    // if a connect is already in flight or a room is already alive.
    if (current.connecting || current.room) {
      dlog('accept() ignored — already connecting/connected', {
        connecting: !!current.connecting,
        hasRoom: !!current.room,
      });
      return;
    }
    current.connecting = true;
    dlog('accept() start', { call_id: invite.call_id, call_type: invite.call_type });
    setStatus('Connecting...');
    btnAccept.disabled = true;
    btnReject.disabled = true;
    // Re-assert host visibility BEFORE the SDK starts so that any stale
    // hide() between invite-show and accept can't leave the surface
    // hidden while media starts streaming behind it.
    show();
    // ─── Bug A fix: activate the in-call stage BEFORE room.connect() ──
    // Previously setInCallMode() ran only AFTER the mic published, which
    // meant the .stage element was still display:none when the operator's
    // remote video TrackSubscribed fired. The <video> element therefore
    // measured 0×0 and never auto-played, even though the track was
    // attached. By switching the stage on up-front (using the call_type
    // we already know from the invite), the video element has real layout
    // size from the moment the first remote track is subscribed.
    try { setInCallMode(invite.call_type === 'video'); } catch (_) {}
    loadSdk().then(function (LK) {
      var iceServers = [];
      if (invite.turn && invite.turn.urls && invite.turn.urls.length) {
        iceServers.push({
          urls: invite.turn.urls,
          username: invite.turn.username || undefined,
          credential: invite.turn.credential || undefined,
        });
      }
      var normalizedWsUrl = normalizeLiveKitWsUrl(invite.ws_url);
      var signalingPathPreview = '/ → /rtc/v1';
      try {
        signalingPathPreview = ((new URL(normalizedWsUrl)).pathname || '/') + ' → /rtc/v1';
      } catch (_) {}
      dlog('room.connect start', {
        ws_url: invite.ws_url,
        normalizedWsUrl: normalizedWsUrl,
        signalingPathPreview: signalingPathPreview,
        duplicatedPathDetected: /\/rtc\/rtc(?:\/|$)|\/rtc\/v1\/v1(?:\/|$)/i.test(invite.ws_url) || /\/rtc\/rtc(?:\/|$)|\/rtc\/v1\/v1(?:\/|$)/i.test(normalizedWsUrl),
        call_id: invite.call_id,
      });
      var room = new LK.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: false });
      // Race guard: if teardown() ran between loadSdk() and here, do not
      // create a zombie connection — `current` was cleared.
      if (!current || current.invite !== invite) {
        dlog('accept() pre-connect race: invite changed, aborting');
        try { room.disconnect(); } catch (_) {}
        return;
      }
      current.room = room;
      attachRemote(room, LK);
      var connectOpts = iceServers.length ? {
        rtcConfig: {
          iceServers: iceServers,
          iceTransportPolicy: invite.ice_policy === 'relay' ? 'relay' : 'all',
        },
      } : undefined;
      return room.connect(normalizedWsUrl, invite.token, connectOpts).then(function () {
        dlog('room.connect resolved', { call_id: invite.call_id });
        // Race guard: teardown() during the WS handshake clears current.
        // The freshly-joined room is now orphaned; disconnect it cleanly
        // so LiveKit doesn't see a dangling participant.
        if (!current || current.room !== room) {
          dlog('accept() post-connect race: ref changed, disconnecting orphan');
          try { room.disconnect(); } catch (_) {}
          return;
        }
        setStatus('');
        return room.localParticipant.setMicrophoneEnabled(true).then(function () {
          if (!current || current.room !== room) {
            try { room.disconnect(); } catch (_) {}
            return;
          }
          current.micEnabled = true;
          btnMic.textContent = 'Mute';
          btnMic.classList.remove('off');
          var isVideo = invite.call_type === 'video';
          // Re-assert stage mode (it was set up-front; this is a no-op
          // re-assertion that also re-runs the host-visibility re-show).
          setInCallMode(isVideo);
          // Nudge the remote video to play now that the stage has real
          // size — this is the critical step when a track arrived while
          // the element was momentarily detached/hidden.
          try {
            if (videoEl && videoEl.srcObject) {
              var pp = videoEl.play();
              if (pp && pp.catch) pp.catch(function () {});
            }
            // Diagnostic: log the layout size of every node in the chain
            // so any future zero-size regression is immediately visible.
            var inst = window.__gs_runtime && window.__gs_runtime._instance;
            var mountHost = inst && inst.getCallMountHost ? inst.getCallMountHost() : null;
            dlogLayout('layout sizes after setInCallMode', {
              mountHost: mountHost ? { w: mountHost.clientWidth, h: mountHost.clientHeight, display: mountHost.style.display } : null,
              videoHasSrc: videoEl ? !!videoEl.srcObject : false,
            });
          } catch (_) {}
          dlog('mic published; mode set', { isVideo: isVideo });
          if (isVideo) {
            return room.localParticipant.setCameraEnabled(true).then(function () {
              if (!current || current.room !== room) {
                try { room.disconnect(); } catch (_) {}
                return;
              }
              current.camEnabled = true;
              btnCam.textContent = 'Stop cam';
              btnCam.classList.remove('off');
              dlog('camera published');
            });
          }
        });
      });
    }).catch(function (err) {
      dlog('accept() failed', { error: err && err.message });
      setStatus('Could not join: ' + (err && err.message ? err.message : 'unknown'));
      btnAccept.disabled = false;
      btnReject.disabled = false;
      teardown('error');
    }).then(function () {
      // Always clear the connecting flag whether resolve or catch ran.
      if (current) current.connecting = false;
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
    // If we already have an in-flight or active call for the SAME call_id,
    // ignore the duplicate dispatch. Polling + realtime can both deliver
    // the same invite within milliseconds, and tearing down the active
    // room here is what produces the visitor-side SIGNAL_SOURCE_CLOSE
    // (LiveKit kicks the just-joined participant when the local SDK
    // disconnects mid-handshake).
    if (current && current.invite && invite.call_id &&
        current.invite.call_id === invite.call_id) {
      dlog('showIncoming() ignored — same call_id already active', {
        call_id: invite.call_id,
        connecting: !!current.connecting,
        hasRoom: !!current.room,
      });
      return;
    }
    // Genuine replacement (different call_id) — tear the previous one down.
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
    // Phase 9 — Invitation flow auto-accepts (the visitor already consented
    // by clicking Join on the conversation card). Kept opt-in via the
    // `auto_accept` flag so the legacy direct-incoming path still requires
    // an explicit Answer tap.
    if (invite.auto_accept) {
      try { accept(); } catch (_) {}
    }
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
     * Phase 8D++ — Probe for an existing open callback for this visitor and
     * render the persistent "Callback pending" badge if one exists. UI-only.
     */
    refreshCallbackStatus: function () {
      callbackStatusChecked = false;
      ensureShell();
      checkCallbackStatus();
    },
    /**
     * Phase 8E — Smart greeting. Caller passes context; we resolve copy
     * deterministically. Dismissible & sessionStorage-persistent.
     * Example: window.__gs_call.greet({ path: '/pricing', time_on_page_ms: 25000 });
     */
    greet: showGreeting,
    resolveWidgetGreeting: resolveWidgetGreeting,
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
      var titleEl = rootEl.querySelector('[data-el="title"]');
      var subEl = rootEl.querySelector('[data-el="sub"]');
      var ctaBtn = rootEl.querySelector('[data-el="callback"]');
      var modalEl = rootEl.querySelector('[data-el="callback-modal"]');
      var phoneInput = rootEl.querySelector('[data-el="cb-phone"]');
      var emailInput = rootEl.querySelector('[data-el="cb-email"]');
      var notesInput = rootEl.querySelector('[data-el="cb-notes"]');
      var errEl = rootEl.querySelector('[data-el="cb-error"]');
      var submitBtn = rootEl.querySelector('[data-el="cb-submit"]');
      var cancelBtn = rootEl.querySelector('[data-el="cb-cancel"]');

      // Pre-fill from known visitor identity if available — never force re-entry.
      var ident = (window.__gs_identity || {});
      try {
        if (ident.phone && !phoneInput.value) phoneInput.value = ident.phone;
        if (ident.email && !emailInput.value) emailInput.value = ident.email;
        if (opts.notes && !notesInput.value) notesInput.value = opts.notes;
      } catch (_) {}

      titleEl.textContent = 'No operator available';
      subEl.textContent = 'Request a callback and we will get back to you.';
      rootEl.querySelector('[data-el="ring-row"]').style.display = 'none';
      rootEl.querySelector('[data-el="call-row"]').style.display = 'none';
      rootEl.querySelector('[data-el="callback-row"]').style.display = 'flex';
      modalEl.style.display = 'none';
      errEl.classList.remove('show');
      ctaBtn.disabled = !!callbackRequestedFlag;
      ctaBtn.textContent = callbackRequestedFlag ? 'Callback requested' : 'Request callback';
      // Best-effort: restore pending state if visitor already has one.
      checkCallbackStatus();
      if (callbackRequestedFlag) {
        showPendingBadge({ message: 'Callback pending' });
      }
      show();

      function openModal() {
        if (callbackRequestedFlag) return; // already requested in this session
        modalEl.style.display = 'block';
        ctaBtn.style.display = 'none';
        errEl.classList.remove('show');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Request callback';
      }
      function closeModal() {
        modalEl.style.display = 'none';
        ctaBtn.style.display = '';
      }

      ctaBtn.onclick = openModal;
      cancelBtn.onclick = closeModal;

      // Phase 8E — Schedule chip group (single-select, default = now).
      var schedGroup = rootEl.querySelector('[data-el="cb-sched"]');
      var customWrap = rootEl.querySelector('[data-el="cb-custom"]');
      var customInput = rootEl.querySelector('[data-el="cb-custom-input"]');
      var selectedSched = 'now';
      function selectSched(key) {
        selectedSched = key;
        var chips = schedGroup.querySelectorAll('.cbchip');
        for (var i = 0; i < chips.length; i++) {
          chips[i].classList.toggle('selected', chips[i].getAttribute('data-sched') === key);
        }
        customWrap.classList.toggle('show', key === 'custom');
      }
      schedGroup.onclick = function (ev) {
        var t = ev.target;
        if (t && t.getAttribute && t.getAttribute('data-sched')) {
          selectSched(t.getAttribute('data-sched'));
        }
      };
      function resolveScheduledForIso() {
        if (selectedSched === 'now') return null;
        var ms = Date.now();
        if (selectedSched === '30m') return new Date(ms + 30 * 60 * 1000).toISOString();
        if (selectedSched === '1h') return new Date(ms + 60 * 60 * 1000).toISOString();
        if (selectedSched === 'tomorrow') {
          var d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
          return d.toISOString();
        }
        if (selectedSched === 'custom') {
          var v = (customInput.value || '').trim();
          if (!v) return null;
          var t = new Date(v).getTime();
          if (isNaN(t) || t < Date.now() - 60_000) return null;
          return new Date(t).toISOString();
        }
        return null;
      }

      submitBtn.onclick = function () {
        // Client-side guards: in-flight + 3s debounce + post-success lock.
        var now = Date.now();
        if (isSubmittingCallback) return;
        if (callbackRequestedFlag) return;
        if (now - lastCallbackSubmitTs < 3000) return;
        lastCallbackSubmitTs = now;

        var ctx = getWidgetCtx();
        if (!ctx.apiBase || !ctx.token) {
          errEl.textContent = 'Connection not ready. Please try again.';
          errEl.classList.add('show');
          return;
        }
        var phone = (phoneInput.value || '').trim();
        var email = (emailInput.value || '').trim();
        var notes = (notesInput.value || '').trim();
        var scheduledForIso = resolveScheduledForIso();
        if (selectedSched === 'custom' && !scheduledForIso) {
          errEl.textContent = 'Please pick a valid future time.';
          errEl.classList.add('show');
          return;
        }

        isSubmittingCallback = true;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Requesting...';
        errEl.classList.remove('show');

        fetch(ctx.apiBase + '/api/widget/callback/request', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Widget-Token': ctx.token },
          body: JSON.stringify({
            channel: channel,
            conversation_id: opts.conversation_id || undefined,
            contact_phone: phone || undefined,
            contact_email: email || undefined,
            notes: notes || undefined,
            queue_entry_id: opts.queue_entry_id || undefined,
            scheduled_for: scheduledForIso || undefined,
            department_id: (function () {
              try {
                var d = (typeof window !== 'undefined') ? window.__gs_departments : null;
                return d && d.getSelectedId ? (d.getSelectedId() || undefined) : undefined;
              } catch (_) { return undefined; }
            })(),
          }),
        }).then(function (r) {
          if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) {
            throw new Error(b.error || ('http_' + r.status));
          });
          return r.json();
        }).then(function (resp) {
          callbackRequestedFlag = true;
          // Derive cooldown window from server response when present.
          var cdUntil = resp && resp.cooldown_until ? new Date(resp.cooldown_until).getTime() : 0;
          if (!cdUntil || isNaN(cdUntil)) cdUntil = Date.now() + 10 * 60 * 1000;
          callbackCooldownUntilMs = cdUntil;
          modalEl.style.display = 'none';
          ctaBtn.style.display = '';
          ctaBtn.disabled = true;
          ctaBtn.textContent = 'Callback requested';
          titleEl.textContent = 'Callback requested';
          if (scheduledForIso) {
            try {
              var when = new Date(scheduledForIso);
              subEl.textContent = "We'll call you on " + when.toLocaleString();
            } catch (_) { subEl.textContent = "We'll call you at the scheduled time."; }
          } else {
            subEl.textContent = "We'll call you back shortly.";
          }
          showPendingBadge({ message: 'Callback pending' });
          // Keep the badge visible after auto-hide so reopen still shows status.
          setTimeout(function () { hide({ force: true }); }, 3500);
        }).catch(function (err) {
          errEl.textContent = (err && err.message) ? ('Could not request callback: ' + err.message) : 'Could not request callback';
          errEl.classList.add('show');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Try again';
        }).then(function () {
          isSubmittingCallback = false;
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
        if (Array.isArray(item) && item[0] === 'call:greet') {
          showGreeting(item[1] || {});
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
      if (Array.isArray(item) && item[0] === 'call:greet') {
        showGreeting(item[1] || {});
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