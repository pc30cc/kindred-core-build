/**
 * Widget Runtime v5 — Phase 2 architecture.
 *
 * Layered, Shadow-DOM-only, transport-abstracted, domain-store-based.
 *
 *   Stores       — small pub/sub stores per domain (shell / transport / identity / chat / kb / notify / uiPrefs)
 *   Transport    — provider-agnostic interface (connect/disconnect/subscribe/onMessage/onPresence/onTyping/...)
 *                  Polling is the only real driver shipped here. SSE/WS/Centrifugo can drop in later.
 *   Identity     — visitor identity / pre-chat / continuity (cookie-backed; unchanged security model)
 *   UI.Chat      — chat rendering + composer (consumes stores + transport, never touches polling directly)
 *   UI.KB        — knowledge base UI
 *   UI.Notify    — connection banner + unread badge
 *   Core         — shell lifecycle, panel mount/open/close, view switching
 *
 * Strict rules:
 *   - HttpOnly `dvsid` cookie unchanged. credentials: 'include' on every API call.
 *   - No localStorage for identity. Server is the only source of truth.
 *   - UI never imports polling specifics.
 *   - No offline message queue in this phase. Composer disabled while offline.
 *   - Public API returned to loader: { open, close, toggle, setUnread }.
 */
(function () {
  'use strict';

  var __gs_runtime = {};

  // ════════════════════════════════════════════════════════════════════
  // Util
  // ════════════════════════════════════════════════════════════════════
  var Util = {
    escapeHtml: function (text) {
      var div = document.createElement('div');
      div.textContent = text == null ? '' : String(text);
      return div.innerHTML;
    },
    isValidEmail: function (v) {
      if (!v) return false;
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim());
    },
    isValidPhone: function (v) {
      if (!v) return false;
      var s = String(v).trim().replace(/[\s\-().]/g, '');
      return /^\+?\d{6,20}$/.test(s);
    },
    debug: false,
    log: function () {
      if (!Util.debug) return;
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[Widget Runtime]');
      try { console.info.apply(console, args); } catch (_) {}
    },
    warn: function () {
      if (!Util.debug) return;
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[Widget Runtime]');
      try { console.warn.apply(console, args); } catch (_) {}
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // Phase 6C — Effective realtime policy snapshot.
  //
  // The loader stashes the latest snapshot at `window.__gs_policy` from
  // every handshake response (bootstrap / session refresh). The runtime
  // additionally updates it from /api/realtime/connect.
  //
  // Hot paths (typing emit, reconnect scheduling) read SYNCHRONOUSLY from
  // here. Safe defaults are returned when the field is missing or stale.
  // No hard dependency on the field being present — older servers and
  // older loaders simply yield the safe default.
  // ════════════════════════════════════════════════════════════════════
  var Policy = {
    get: function () {
      try {
        var p = (typeof window !== 'undefined') ? window.__gs_policy : null;
        return (p && typeof p === 'object') ? p : {};
      } catch (_) { return {}; }
    },
    set: function (p) {
      if (!p || typeof p !== 'object') return;
      try { if (typeof window !== 'undefined') window.__gs_policy = p; } catch (_) {}
    },
    typingSuppressed: function () { return !!Policy.get().typing_suppressed; },
    forcePolling: function () { return !!Policy.get().force_polling; },
    degraded: function () {
      var p = Policy.get();
      return !!(p.degraded_mode || p.force_polling);
    },
    backoffMultiplier: function () {
      var m = Number(Policy.get().reconnect_backoff_multiplier);
      if (!isFinite(m) || m < 1) return 1;
      if (m > 10) return 10; // hard ceiling — no runaway delays
      return m;
    },
  };
  // Expose for in-file access from nested closures (driver factories etc.).
  __gs_runtime.Policy = Policy;

  // ════════════════════════════════════════════════════════════════════
  // TokenManager — long-lived widget session resilience
  //
  // Strategy: proactive refresh ~60s before expiry + reactive single-retry
  // when a request fails with 401/403/TOKEN_EXPIRED. Bounded retries; no
  // infinite loops. Refresh failures degrade gracefully and pause the
  // refresh timer until the next page load or successful manual recovery.
  //
  // Security model is unchanged:
  //   - we only call the existing /api/widget/session/refresh endpoint
  //   - refresh requires the (possibly recently-expired) current token
  //   - origin enforcement on the server side is untouched
  // ════════════════════════════════════════════════════════════════════
  function createTokenManager(initialToken, apiBase, opts) {
    opts = opts || {};
    var token = initialToken || '';
    var refreshTimer = null;
    var inflight = null;
    var consecutiveFailures = 0;
    var maxFailures = 3;
    var disabled = false;
    var listeners = [];

    function get() { return token; }

    function adopt(newToken) {
      if (!newToken || newToken === token) return token;
      token = newToken;
      disabled = false;
      consecutiveFailures = 0;
      scheduleProactiveRefresh();
      notify();
      return token;
    }

    function onChange(fn) { listeners.push(fn); return function () {
      var i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1);
    }; }

    function notify() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](token); } catch (e) { Util.warn('token listener err', e); }
      }
    }

    /**
     * Decode the exp claim from an HMAC session token. We only read the
     * payload — the server is the only authority on validity.
     * Token format: wss_<base64url(payload)>.<base64url(sig)>
     */
    function readExpiry(t) {
      try {
        if (!t || typeof t !== 'string' || t.indexOf('wss_') !== 0) return 0;
        var raw = t.slice(4);
        var dot = raw.lastIndexOf('.');
        if (dot < 1) return 0;
        var b64 = raw.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
        // pad
        while (b64.length % 4) b64 += '=';
        var json = JSON.parse(atob(b64));
        return (json && typeof json.exp === 'number') ? json.exp * 1000 : 0;
      } catch (_) { return 0; }
    }

    function scheduleProactiveRefresh() {
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      if (disabled || !token || !apiBase) return;
      var expMs = readExpiry(token);
      if (!expMs) return; // unknown TTL — rely on reactive refresh only
      // Refresh 60s before expiry; never less than 5s away.
      var now = Date.now();
      var refreshAt = expMs - 60_000;
      var delay = Math.max(5_000, refreshAt - now);
      refreshTimer = setTimeout(function () { refresh().catch(function () {}); }, delay);
    }

    /**
     * Refresh the session token. Single-flight: concurrent calls await the
     * same in-flight promise. Returns the new token (or rejects).
     */
    function refresh() {
      if (disabled) return Promise.reject(new Error('token_refresh_disabled'));
      if (inflight) return inflight;
      if (!token || !apiBase) return Promise.reject(new Error('no_token_or_api'));
      inflight = fetch(apiBase + '/api/widget/session/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Widget-Token': token },
      })
        .then(function (r) {
          if (r.status === 401 || r.status === 403) {
            // Hard fail — token cannot be refreshed. Disable manager.
            disabled = true;
            throw new Error('refresh_unauthorized_' + r.status);
          }
          if (!r.ok) throw new Error('refresh_http_' + r.status);
          return r.json();
        })
        .then(function (data) {
          if (!data || !data.session_token) throw new Error('refresh_no_token');
          token = data.session_token;
          consecutiveFailures = 0;
          Util.log('[token] refreshed');
          notify();
          scheduleProactiveRefresh();
          return token;
        })
        .catch(function (err) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= maxFailures) {
            disabled = true;
            Util.warn('[token] refresh disabled after', consecutiveFailures, 'failures');
          } else {
            // Back off and retry later for transient failures.
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(function () { refresh().catch(function () {}); },
              Math.min(60_000, 5_000 * Math.pow(2, consecutiveFailures - 1)));
          }
          throw err;
        })
        .then(function (t) { inflight = null; return t; }, function (e) { inflight = null; throw e; });
      return inflight;
    }

    /**
     * Fetch wrapper that injects the current token and retries ONCE on
     * 401/403/TOKEN_EXPIRED with a freshly refreshed token. Caps loops.
     */
    function fetchWith(url, init) {
      init = init || {};
      function doFetch(t) {
        var headers = {};
        var src = init.headers || {};
        // Copy headers without mutating caller-owned object.
        if (src.forEach) src.forEach(function (v, k) { headers[k] = v; });
        else for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) headers[k] = src[k];
        if (t) headers['X-Widget-Token'] = t;
        var next = {};
        for (var k2 in init) if (Object.prototype.hasOwnProperty.call(init, k2)) next[k2] = init[k2];
        next.headers = headers;
        if (next.credentials == null) next.credentials = 'include';
        return fetch(url, next);
      }
      return doFetch(token).then(function (r) {
        if ((r.status !== 401 && r.status !== 403) || disabled) return r;
        // Try to detect token-related failure codes before refreshing.
        // Some 403s (origin/workspace mismatch) cannot be recovered by refresh.
        return r.clone().json().then(function (body) {
          var code = body && body.code;
          var refreshable = code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN' || code === 'MISSING_TOKEN' || !code;
          if (!refreshable) return r;
          return refresh().then(function (newT) { return doFetch(newT); }, function () { return r; });
        }, function () {
          // Body wasn't JSON — best-effort retry once.
          return refresh().then(function (newT) { return doFetch(newT); }, function () { return r; });
        });
      });
    }

    function destroy() {
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      listeners.length = 0;
      disabled = true;
    }

    /**
     * Revive a disabled TokenManager. Called when the page becomes visible
     * again after a long sleep — the token may have failed all refresh
     * attempts in the background, but the HttpOnly `dvsid` cookie is still
     * valid, so we should give it another shot before staying stuck on
     * "Connecting…" forever.
     */
    function revive(newToken) {
      disabled = false;
      consecutiveFailures = 0;
      if (newToken) token = newToken;
      scheduleProactiveRefresh();
      // Best-effort: try a refresh now to confirm we're back online.
      refresh().catch(function () { /* swallowed — caller decides next steps */ });
    }

    // Kick off proactive timer immediately.
    scheduleProactiveRefresh();

    return {
      adopt: adopt,
      get: get,
      onChange: onChange,
      refresh: refresh,
      fetchWith: fetchWith,
      destroy: destroy,
      revive: revive,
      isDisabled: function () { return disabled; },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // createStore — tiny domain store with pub/sub
  //   store.get()              → current state
  //   store.set(partial|fn)    → merge update + notify
  //   store.subscribe(listener)→ unsubscribe()
  // ════════════════════════════════════════════════════════════════════
  function createStore(initial) {
    var state = initial || {};
    var listeners = [];
    function get() { return state; }
    function set(update) {
      var next = typeof update === 'function' ? update(state) : update;
      if (!next) return;
      var changed = false;
      for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k) && state[k] !== next[k]) {
          state[k] = next[k];
          changed = true;
        }
      }
      if (!changed) return;
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](state); } catch (e) { Util.warn('store listener err', e); }
      }
    }
    function subscribe(fn) {
      listeners.push(fn);
      return function () {
        var idx = listeners.indexOf(fn);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    }
    return { get: get, set: set, subscribe: subscribe };
  }

  // ════════════════════════════════════════════════════════════════════
  // LifecycleFSM — Phase 2 deterministic widget lifecycle
  //
  // Single source of truth for the widget's connection/session lifecycle.
  // The transport/identity/UI layers ASK the FSM what to render and TELL
  // the FSM about events — they never fabricate transitions on their own.
  //
  // States (intentionally distinct, do NOT collapse):
  //   bootstrapping       — initial load, identity not yet resolved
  //   restoring_session   — identity resolved, history fetch in flight
  //   connecting          — first transport connect attempt
  //   subscribing         — connected, awaiting per-conversation subscribe
  //   connected           — realtime healthy + (no cid) or (cid subscribed)
  //   degraded            — primary realtime failed, polling fallback active
  //   reconnecting        — transient transport drop, retry in flight
  //   waking              — wake from page-visibility/BFCache, full recovery
  //   offline             — browser navigator.onLine === false
  //   unavailable         — server says widget disabled / business hours
  //   auth_expired        — session token cannot be refreshed (cookie dead)
  //   failed              — terminal: bootstrap permanently failed
  //   idle                — manually disconnected (panel destroyed)
  //
  // Allowed transitions are EXPLICIT in TRANSITIONS below. Any disallowed
  // transition is logged (debug only) and ignored — the FSM never silently
  // drifts into an inconsistent state.
  // ════════════════════════════════════════════════════════════════════
  function createLifecycleFSM() {
    var TRANSITIONS = {
      bootstrapping:     ['restoring_session', 'unavailable', 'auth_expired', 'failed', 'idle'],
      restoring_session: ['connecting', 'unavailable', 'failed', 'idle'],
      connecting:        ['subscribing', 'connected', 'degraded', 'reconnecting', 'offline', 'unavailable', 'auth_expired', 'failed', 'idle'],
      subscribing:       ['connected', 'degraded', 'reconnecting', 'offline', 'auth_expired', 'idle'],
      connected:         ['subscribing', 'reconnecting', 'degraded', 'offline', 'waking', 'auth_expired', 'idle'],
      degraded:          ['connecting', 'reconnecting', 'connected', 'offline', 'waking', 'auth_expired', 'idle'],
      reconnecting:      ['connecting', 'subscribing', 'connected', 'degraded', 'offline', 'waking', 'auth_expired', 'failed', 'idle'],
      waking:            ['restoring_session', 'connecting', 'reconnecting', 'subscribing', 'connected', 'degraded', 'offline', 'auth_expired', 'failed', 'idle'],
      offline:           ['waking', 'reconnecting', 'connecting', 'idle'],
      unavailable:       ['waking', 'connecting', 'reconnecting', 'connected', 'idle'],
      auth_expired:      ['waking', 'restoring_session', 'idle'],
      failed:            ['waking', 'idle'],
      idle:              ['bootstrapping', 'waking'],
    };

    // States that map to "transport actively connected" — used by the
    // composer/banner to decide if sending is allowed.
    var SENDABLE = { connected: 1, degraded: 1 };
    // States considered "in-flight" — banner shows reconnecting/connecting.
    var BUSY = { bootstrapping: 1, restoring_session: 1, connecting: 1, subscribing: 1, reconnecting: 1, waking: 1 };

    var current = 'idle';
    var listeners = [];
    var history = [];   // last 20 transitions, debug only
    var activeConversationId = null;
    // Stable contract for UI: a single "connection_state" mapping for the
    // existing transportStore consumers (banner, composer). One mapping,
    // computed in one place.
    function toLegacy(state) {
      if (state === 'idle') return 'idle';
      if (state === 'offline') return 'offline';
      if (state === 'unavailable' || state === 'failed' || state === 'auth_expired') return 'offline';
      if (SENDABLE[state]) return 'online';
      return state === 'bootstrapping' || state === 'restoring_session' || state === 'connecting' || state === 'subscribing' || state === 'waking'
        ? 'connecting'
        : 'reconnecting';
    }

    function get() { return current; }

    function transition(next, meta) {
      if (next === current) return false;
      var allowed = TRANSITIONS[current] || [];
      if (allowed.indexOf(next) === -1) {
        Util.warn('[fsm] illegal transition', current, '→', next, meta || '');
        return false;
      }
      var prev = current;
      current = next;
      var entry = { at: Date.now(), from: prev, to: next, meta: meta || null };
      history.push(entry);
      if (history.length > 20) history.shift();
      Util.log('[fsm]', prev, '→', next, meta || '');
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i]({ state: next, previous: prev, meta: meta }); }
        catch (e) { Util.warn('fsm listener err', e); }
      }
      return true;
    }

    return {
      get: get,
      transition: transition,
      legacyConnectionState: function () { return toLegacy(current); },
      isSendable: function () { return !!SENDABLE[current]; },
      isBusy: function () { return !!BUSY[current]; },
      isOffline: function () { return current === 'offline' || current === 'unavailable' || current === 'failed' || current === 'auth_expired'; },
      isDegraded: function () { return current === 'degraded'; },
      onChange: function (fn) {
        listeners.push(fn);
        return function () {
          var i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1);
        };
      },
      setConversation: function (cid) { activeConversationId = cid || null; },
      getConversation: function () { return activeConversationId; },
      history: function () { return history.slice(); },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Lazy module loader (chat / kb)
  // ════════════════════════════════════════════════════════════════════
  var ModuleLoader = (function () {
    var modules = {};
    var loading = {};
    return {
      modules: modules,
      load: function (name, url, cb) {
        if (modules[name]) return cb(modules[name]);
        if (loading[name]) { loading[name].push(cb); return; }
        loading[name] = [cb];
        var script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = function () {
          var mod = window['__gs_mod_' + name];
          if (mod) modules[name] = mod;
          var cbs = loading[name] || [];
          delete loading[name];
          cbs.forEach(function (fn) { fn(mod || null); });
        };
        script.onerror = function () {
          Util.warn('Module failed: ' + name);
          var cbs = loading[name] || [];
          delete loading[name];
          cbs.forEach(function (fn) { fn(null); });
        };
        document.head.appendChild(script);
      },
    };
  })();

  // ════════════════════════════════════════════════════════════════════
  // i18n
  // ════════════════════════════════════════════════════════════════════
  var I18n = (function () {
    var dict = {
      en: {
        chat: 'Chat', help: 'Help Center',
        voiceCall: 'Voice', videoCall: 'Video',
        typeMsg: 'Type a message...',
        intro: "Send us a message and we'll get back to you shortly.",
        name: 'Name', email: 'Email', phone: 'Phone number',
        continue: 'Continue', back: 'Back',
        prechatIntro: 'Before we start, please share a few details so we can stay in touch.',
        required: 'required',
        invalidEmail: 'Please enter a valid email address.',
        invalidPhone: 'Please enter a valid phone number.',
        prechatTitle: 'Welcome 👋',
        prechatSubtitle: "Tell us a bit about you so we can help faster.",
        prechatOptional: 'optional',
        prechatNamePh: 'Your full name',
        prechatEmailPh: 'name@example.com',
        prechatPhonePh: '+1 555 123 4567',
        prechatPrivacy: 'We only use your details to reply to this conversation.',
        searchKb: 'Search articles...',
        noArticles: 'No articles yet',
        loading: 'Loading…',
        kbCategories: 'Browse by category',
        kbAllArticles: 'Popular articles',
        kbBack: 'Back',
        kbOpenInBrowser: 'Open in browser',
        kbZeroResults: 'No articles match your search.',
        kbSwitchToChat: 'Start a chat instead',
        kbSearching: 'Searching…',
        offline: "You're offline. Messaging is paused until the connection is back.",
        reconnecting: 'Reconnecting…',
        connecting: 'Connecting…',
        offlineComposerTip: 'Disabled while offline',
        // Phase 5 — availability
        availOnline: "We're online",
        availAway: 'Replies may be slower',
        availOffline: "We're offline",
        availUnavailable: 'Live chat unavailable',
        offlineIntro: "We're not online right now. Leave us a message and we'll reply as soon as we can.",
        fallbackIntro: "Our team is offline. Share your details and a short message — we'll get back to you.",
        fallbackMessageLabel: 'Message',
        fallbackSubmit: 'Send message',
        fallbackSent: "Thanks — we've got your message and will reply shortly.",
        fallbackSentTransitioning: "Thanks — we've got your message. We may be back online sooner than expected and will reply right away.",
        fallbackError: "Couldn't send right now. Please try again.",
        // Phase 6a — attachments
        attachFile: 'Attach file',
        uploading: 'Uploading…',
        readyToSend: 'Ready to send',
        uploadFailed: 'Upload failed',
        typeNotAllowed: 'File type not allowed',
        tooLarge: 'File is too large',
        selected: 'Selected',
        // Phase 6b — preview / file actions
        retry: 'Retry',
        download: 'Download',
        openFile: 'Open',
        closePreview: 'Close preview',
        imageUnavailable: 'Image unavailable',
        // Phase 7 — message lifecycle
        msgSending: 'Sending…',
        msgSent: 'Sent',
        msgSeen: 'Seen',
        msgFailed: 'Not delivered',
        typingOperator: 'Support is typing…',
        // Phase 9 — Call invitation card (visitor side)
        ciJoinAudio: 'Join call',
        ciJoinVideo: 'Join video call',
        ciDecline: 'Decline',
        ciJoining: 'Joining…',
        ciDeclining: 'Declining…',
        ciOpeningCall: 'Opening call…',
        ciErrCallRuntime: 'Call service is starting. Please tap Join again.',
        ciErrJoin: 'Could not join the call. Please try again.',
        ciHeadlineAudio: 'You\u2019ve been invited to a voice call',
        ciHeadlineVideo: 'You\u2019ve been invited to a video call',
        ciHeadlineAudioFrom: '{op} invited you to a voice call',
        ciHeadlineVideoFrom: '{op} invited you to a video call',
        ciStateJoined: 'You joined the call',
        ciStateExpired: 'Invitation expired',
        ciStateCancelled: 'Operator cancelled the invitation',
        ciStateDeclined: 'You declined this call',
        ciTimeLeft: '{time} left',
        ciMinutes: '{m}m',
        ciMinutesSeconds: '{m}m {s}s',
        ciSeconds: '{s}s',
        ciExpiringSoon: 'Expiring soon',
        ciAriaCard: 'Call invitation',
        ciAriaJoinAudio: 'Join the audio call now',
        ciAriaJoinVideo: 'Join the video call now',
        ciAriaDecline: 'Decline this call invitation',
        ciBodyAudio: 'An operator is inviting you to a voice call.',
        ciBodyVideo: 'An operator is inviting you to a video call.',
        ciWaitMinutes: 'The operator will wait up to {m} minutes for you to join.',
        ciWaitOneMinute: 'The operator will wait up to one minute for you to join.',
        // Pass A — call-ended summary message
        csEndedByOperator: 'Call ended by operator · Duration {duration}',
        csEndedByVisitor: 'Call ended by visitor · Duration {duration}',
        csEndedBySystem: 'Call ended · Duration {duration}',
        csEndedNotConnected: 'Call did not connect',
        // Pass 2 — In-panel call surface
        csConnecting: 'Connecting to the call\u2026',
        csReconnecting: 'Reconnecting\u2026',
        csInCall: 'In call',
        csEnded: 'Call ended',
        csMicMute: 'Mute',
        csMicUnmute: 'Unmute',
        csCamOn: 'Start camera',
        csCamOff: 'Stop camera',
        csHangup: 'End call',
        csClose: 'Close',
        csWaitingPeer: 'Waiting for the other side\u2026',
        // Canonical engine error codes (mirrors server callErrorBody)
        csErrSdkMissing: 'Call service unavailable. Please refresh and try again.',
        csErrSdkLoad: 'Could not load the call service. Check your network and retry.',
        csErrConnect: 'Could not connect to the call. Please retry.',
        csErrTokenMint: 'Could not get a call token. Please retry.',
        csErrProviderNotReady: 'Call service is not ready. Please try again shortly.',
        csErrTurnMissing: 'Network configuration is missing. Please contact support.',
        csErrPermMic: 'Microphone access was blocked. Allow it in your browser settings.',
        csErrPermCam: 'Camera access was blocked. Allow it in your browser settings.',
        csErrInvitationExpired: 'This invitation has expired.',
        csErrInvitationJoined: 'This invitation was already used.',
        csErrAccessDenied: 'You do not have access to this call.',
        csErrOriginDenied: 'This site is not allowed to start a call.',
        csErrUnknown: 'Something went wrong. Please retry.',
        // Pass — Widget Call UX
        csAudioCall: 'Voice call',
        csVideoCall: 'Video call',
        csSwitchCamera: 'Switch camera',
        csCameraUnavailable: 'Camera unavailable',
        csBackToChat: 'Back to chat',
        csDuration: 'Duration',
        csOperatorEnded: 'Operator ended the call',
        csVisitorEnded: 'You ended the call',
        csCallEnded: 'Call ended',
        // Misc fallbacks
        support: 'Support',
        operator: 'Operator',
        team: 'Team',
        anonymous: 'Anonymous',
        poweredBy: 'Powered by',
        welcomeFallback: 'Hi there 👋\nHow can we help you today?',
        teamLabel: 'Support team',
        onlineLabel: 'online',
        home: 'Home',
        homeGreeting: 'Hi there 👋',
        homeGreetingSub: 'How can we help you today?',
        resumeTitle: 'Continue previous conversation',
        resumeCta: 'Continue',
        actionAi: 'Ask the AI assistant',
        actionAiSub: 'Fastest way to get an answer',
        actionHuman: 'Chat with support',
        actionHumanSub: 'Talk to a human operator',
        actionKb: 'Search the help center',
        actionKbSub: 'Find answers to your questions',
        categories: 'Categories',
        viewAll: 'View all',
        awayLabel: 'away',
        offlineLabel: 'offline',
        aiAnswer: 'Automated reply',
        closeWidget: 'Close',
        noCategories: 'No categories available',
      },
      fa: {
        chat: 'گفتگو', help: 'مرکز راهنما',
        voiceCall: 'تماس صوتی', videoCall: 'تماس تصویری',
        typeMsg: 'پیام خود را بنویسید...',
        intro: 'سوالی دارید؟ اینجا بنویسید.',
        name: 'نام', email: 'ایمیل', phone: 'شماره تلفن',
        continue: 'ادامه', back: 'بازگشت',
        prechatIntro: 'قبل از شروع، لطفاً اطلاعات تماس را وارد کنید تا بتوانیم در ارتباط باشیم.',
        required: 'الزامی',
        invalidEmail: 'لطفاً یک ایمیل معتبر وارد کنید.',
        invalidPhone: 'لطفاً یک شماره تلفن معتبر وارد کنید.',
        prechatTitle: 'خوش آمدید 👋',
        prechatSubtitle: 'برای پاسخ‌گویی سریع‌تر، چند نکته کوتاه دربارهٔ خودتان بگویید.',
        prechatOptional: 'اختیاری',
        prechatNamePh: 'نام و نام خانوادگی',
        prechatEmailPh: 'name@example.com',
        prechatPhonePh: '۰۹۱۲ ۳۴۵ ۶۷۸۹',
        prechatPrivacy: 'اطلاعات شما فقط برای پاسخ به همین گفتگو استفاده می‌شود.',
        searchKb: 'جستجو در مقالات...',
        noArticles: 'مقاله‌ای یافت نشد',
        loading: 'در حال بارگذاری…',
        kbCategories: 'دسته‌بندی‌ها',
        kbAllArticles: 'مقالات پرکاربرد',
        kbBack: 'بازگشت',
        kbOpenInBrowser: 'باز کردن در مرورگر',
        kbZeroResults: 'مقاله‌ای با جست‌وجوی شما مطابقت ندارد.',
        kbSwitchToChat: 'به‌جای آن گفتگو را شروع کنید',
        kbSearching: 'در حال جست‌وجو…',
        offline: 'اتصال شما قطع است. تا برقراری دوباره، ارسال پیام در دسترس نیست.',
        reconnecting: 'در حال اتصال مجدد…',
        connecting: 'در حال اتصال…',
        offlineComposerTip: 'در حالت آفلاین غیرفعال است',
        availOnline: 'ما آنلاین هستیم',
        availAway: 'پاسخ‌گویی ممکن است کندتر باشد',
        availOffline: 'در حال حاضر آفلاین هستیم',
        availUnavailable: 'گفتگوی زنده در دسترس نیست',
        offlineIntro: 'الان آنلاین نیستیم. پیام بگذارید، در اولین فرصت پاسخ می‌دهیم.',
        fallbackIntro: 'تیم ما در حال حاضر آفلاین است. اطلاعات تماس و یک پیام کوتاه بنویسید تا با شما تماس بگیریم.',
        fallbackMessageLabel: 'پیام',
        fallbackSubmit: 'ارسال پیام',
        fallbackSent: 'پیام شما دریافت شد. به‌زودی پاسخ می‌دهیم.',
        fallbackSentTransitioning: 'پیام شما دریافت شد. ممکن است زودتر از انتظار آنلاین شویم و فوراً پاسخ دهیم.',
        fallbackError: 'ارسال انجام نشد. لطفاً دوباره تلاش کنید.',
        // Phase 6a — attachments
        attachFile: 'پیوست فایل',
        uploading: 'در حال بارگذاری…',
        readyToSend: 'آماده ارسال',
        uploadFailed: 'بارگذاری ناموفق بود',
        typeNotAllowed: 'این نوع فایل مجاز نیست',
        tooLarge: 'حجم فایل بیش از حد مجاز است',
        selected: 'انتخاب شده',
        // Phase 6b — preview / file actions
        retry: 'تلاش مجدد',
        download: 'دانلود',
        openFile: 'باز کردن',
        closePreview: 'بستن پیش‌نمایش',
        imageUnavailable: 'تصویر در دسترس نیست',
        // Phase 7 — message lifecycle
        msgSending: 'در حال ارسال…',
        msgSent: 'ارسال شد',
        msgSeen: 'دیده شد',
        msgFailed: 'ارسال نشد',
        typingOperator: 'پشتیبانی در حال نوشتن…',
        ciJoinAudio: 'پیوستن به تماس',
        ciJoinVideo: 'پیوستن به تماس تصویری',
        ciDecline: 'رد کردن',
        ciJoining: 'در حال پیوستن…',
        ciDeclining: 'در حال رد کردن…',
        ciOpeningCall: 'در حال باز کردن تماس…',
        ciErrCallRuntime: 'سرویس تماس در حال آماده‌سازی است. لطفاً دوباره روی پیوستن بزنید.',
        ciErrJoin: 'پیوستن به تماس ممکن نشد. لطفاً دوباره تلاش کنید.',
        ciHeadlineAudio: 'به یک تماس صوتی دعوت شده‌اید',
        ciHeadlineVideo: 'به یک تماس تصویری دعوت شده‌اید',
        ciHeadlineAudioFrom: '{op} شما را به تماس صوتی دعوت کرد',
        ciHeadlineVideoFrom: '{op} شما را به تماس تصویری دعوت کرد',
        ciStateJoined: 'به تماس پیوستید',
        ciStateExpired: 'دعوت منقضی شد',
        ciStateCancelled: 'اپراتور دعوت را لغو کرد',
        ciStateDeclined: 'این تماس را رد کردید',
        ciTimeLeft: '{time} باقی‌مانده',
        ciMinutes: '{m} دقیقه',
        ciMinutesSeconds: '{m} دقیقه و {s} ثانیه',
        ciSeconds: '{s} ثانیه',
        ciExpiringSoon: 'در حال انقضا',
        ciAriaCard: 'دعوت تماس',
        ciAriaJoinAudio: 'هم‌اکنون به تماس صوتی بپیوندید',
        ciAriaJoinVideo: 'هم‌اکنون به تماس تصویری بپیوندید',
        ciAriaDecline: 'رد این دعوت تماس',
        ciBodyAudio: 'یک اپراتور شما را به تماس صوتی دعوت می‌کند.',
        ciBodyVideo: 'یک اپراتور شما را به تماس تصویری دعوت می‌کند.',
        ciWaitMinutes: 'اپراتور حداکثر {m} دقیقه منتظر پیوستن شما می‌ماند.',
        ciWaitOneMinute: 'اپراتور حداکثر یک دقیقه منتظر پیوستن شما می‌ماند.',
        csEndedByOperator: 'تماس از طرف اپراتور پایان یافت · مدت مکالمه {duration}',
        csEndedByVisitor: 'تماس از طرف کاربر پایان یافت · مدت مکالمه {duration}',
        csEndedBySystem: 'تماس پایان یافت · مدت مکالمه {duration}',
        csEndedNotConnected: 'تماس برقرار نشد',
        csConnecting: 'در حال اتصال به تماس…',
        csReconnecting: 'در حال اتصال مجدد…',
        csInCall: 'در حال مکالمه',
        csEnded: 'تماس پایان یافت',
        csMicMute: 'بی‌صدا کردن میکروفون',
        csMicUnmute: 'فعال کردن میکروفون',
        csCamOn: 'روشن کردن دوربین',
        csCamOff: 'خاموش کردن دوربین',
        csHangup: 'پایان تماس',
        csClose: 'بستن',
        csWaitingPeer: 'در انتظار طرف مقابل…',
        csAudioCall: 'تماس صوتی',
        csVideoCall: 'تماس تصویری',
        csSwitchCamera: 'تعویض دوربین',
        csCameraUnavailable: 'دوربین در دسترس نیست',
        csBackToChat: 'بازگشت به گفتگو',
        csDuration: 'مدت',
        csOperatorEnded: 'اپراتور تماس را پایان داد',
        csVisitorEnded: 'شما تماس را پایان دادید',
        csCallEnded: 'تماس پایان یافت',
        csErrSdkMissing: 'سرویس تماس در دسترس نیست. لطفاً صفحه را تازه کنید.',
        csErrSdkLoad: 'بارگذاری سرویس تماس ممکن نشد. لطفاً دوباره تلاش کنید.',
        csErrConnect: 'اتصال به تماس ممکن نشد. لطفاً دوباره تلاش کنید.',
        csErrTokenMint: 'دریافت توکن تماس ممکن نشد. لطفاً دوباره تلاش کنید.',
        csErrProviderNotReady: 'سرویس تماس آماده نیست. لطفاً کمی بعد تلاش کنید.',
        csErrTurnMissing: 'تنظیمات شبکه ناقص است. با پشتیبانی تماس بگیرید.',
        csErrPermMic: 'دسترسی به میکروفون مسدود است. در تنظیمات مرورگر اجازه دهید.',
        csErrPermCam: 'دسترسی به دوربین مسدود است. در تنظیمات مرورگر اجازه دهید.',
        csErrInvitationExpired: 'این دعوت منقضی شده است.',
        csErrInvitationJoined: 'این دعوت قبلاً استفاده شده است.',
        csErrAccessDenied: 'به این تماس دسترسی ندارید.',
        csErrOriginDenied: 'این سایت مجاز به برقراری تماس نیست.',
        csErrUnknown: 'مشکلی پیش آمد. لطفاً دوباره تلاش کنید.',
        support: 'پشتیبانی',
        operator: 'اپراتور',
        team: 'تیم',
        anonymous: 'ناشناس',
        poweredBy: 'قدرت گرفته از',
        welcomeFallback: 'سلام 👋\nچطور می‌توانیم به شما کمک کنیم؟',
        teamLabel: 'تیم پشتیبانی',
        onlineLabel: 'آنلاین',
        home: 'خانه',
        homeGreeting: 'سلام! 👋',
        homeGreetingSub: 'چطور می‌توانیم کمک کنیم؟',
        resumeTitle: 'ادامه گفتگوی قبلی',
        resumeCta: 'ادامه گفتگو',
        actionAi: 'پرسش از دستیار هوشمند',
        actionAiSub: 'سریع‌ترین راه برای دریافت پاسخ',
        actionHuman: 'گفتگو با پشتیبانی',
        actionHumanSub: 'با اپراتور انسانی صحبت کنید',
        actionKb: 'جست‌وجو در راهنما',
        actionKbSub: 'پاسخ سوالات خود را بیابید',
        categories: 'دسته‌بندی‌ها',
        viewAll: 'مشاهده همه',
        awayLabel: 'در دسترس نیست',
        offlineLabel: 'آفلاین',
        aiAnswer: 'پاسخ خودکار',
        closeWidget: 'بستن',
        noCategories: 'دسته‌بندی موجود نیست',
      },
      tr: {
        chat: 'Sohbet', help: 'Yardım Merkezi',
        voiceCall: 'Sesli', videoCall: 'Görüntülü',
        typeMsg: 'Mesajınızı yazın...',
        intro: 'Bir soru mu var? Buraya yazın.',
        name: 'İsim', email: 'E-posta', phone: 'Telefon',
        continue: 'Devam', back: 'Geri',
        prechatIntro: 'Başlamadan önce iletişim bilgilerinizi girin.',
        required: 'zorunlu',
        invalidEmail: 'Lütfen geçerli bir e-posta girin.',
        invalidPhone: 'Lütfen geçerli bir telefon numarası girin.',
        prechatTitle: 'Hoş geldiniz 👋',
        prechatSubtitle: 'Size daha hızlı yardımcı olabilmemiz için kendinizden kısaca bahsedin.',
        prechatOptional: 'isteğe bağlı',
        prechatNamePh: 'Ad ve soyad',
        prechatEmailPh: 'ad@ornek.com',
        prechatPhonePh: '+90 555 123 45 67',
        prechatPrivacy: 'Bilgileriniz yalnızca bu sohbete yanıt vermek için kullanılır.',
        searchKb: 'Makalelerde ara...',
        noArticles: 'Henüz makale yok',
        loading: 'Yükleniyor…',
        kbCategories: 'Kategoriye göre göz at',
        kbAllArticles: 'Popüler makaleler',
        kbBack: 'Geri',
        kbOpenInBrowser: 'Tarayıcıda aç',
        kbZeroResults: 'Aramanızla eşleşen makale yok.',
        kbSwitchToChat: 'Bunun yerine sohbet başlat',
        kbSearching: 'Aranıyor…',
        offline: 'Çevrimdışısınız. Bağlantı geri gelene kadar mesajlaşma duraklatıldı.',
        reconnecting: 'Yeniden bağlanılıyor…',
        connecting: 'Bağlanıyor…',
        offlineComposerTip: 'Çevrimdışıyken devre dışı',
        availOnline: 'Çevrimiçiyiz',
        availAway: 'Yanıtlar gecikebilir',
        availOffline: 'Şu an çevrimdışıyız',
        availUnavailable: 'Canlı sohbet kullanılamıyor',
        offlineIntro: 'Şu an çevrimdışıyız. Bize bir mesaj bırakın, en kısa sürede dönüş yapalım.',
        fallbackIntro: 'Ekibimiz şu an çevrimdışı. Bilgilerinizi ve kısa bir mesaj bırakın, size geri döneceğiz.',
        fallbackMessageLabel: 'Mesaj',
        fallbackSubmit: 'Mesaj gönder',
        fallbackSent: 'Mesajınızı aldık, kısa süre içinde yanıtlayacağız.',
        fallbackSentTransitioning: 'Mesajınızı aldık. Beklenenden önce çevrimiçi olabiliriz ve hemen yanıt verebiliriz.',
        fallbackError: 'Şu an gönderilemedi. Lütfen tekrar deneyin.',
        // Phase 6a — attachments
        attachFile: 'Dosya ekle',
        uploading: 'Yükleniyor…',
        readyToSend: 'Göndermeye hazır',
        uploadFailed: 'Yükleme başarısız',
        typeNotAllowed: 'Bu dosya türü desteklenmiyor',
        tooLarge: 'Dosya çok büyük',
        selected: 'Seçildi',
        // Phase 6b — preview / file actions
        retry: 'Yeniden dene',
        download: 'İndir',
        openFile: 'Aç',
        closePreview: 'Önizlemeyi kapat',
        imageUnavailable: 'Görsel kullanılamıyor',
        // Phase 7 — message lifecycle
        msgSending: 'Gönderiliyor…',
        msgSent: 'Gönderildi',
        msgSeen: 'Görüldü',
        msgFailed: 'İletilemedi',
        typingOperator: 'Destek yazıyor…',
        ciJoinAudio: 'Aramaya katıl',
        ciJoinVideo: 'Görüntülü aramaya katıl',
        ciDecline: 'Reddet',
        ciJoining: 'Katılınıyor…',
        ciDeclining: 'Reddediliyor…',
        ciOpeningCall: 'Arama açılıyor…',
        ciErrCallRuntime: 'Arama hizmeti başlatılıyor. Lütfen tekrar Katıl\'a dokunun.',
        ciErrJoin: 'Aramaya katılınamadı. Lütfen tekrar deneyin.',
        ciHeadlineAudio: 'Sesli aramaya davet edildiniz',
        ciHeadlineVideo: 'Görüntülü aramaya davet edildiniz',
        ciHeadlineAudioFrom: '{op} sizi sesli aramaya davet etti',
        ciHeadlineVideoFrom: '{op} sizi görüntülü aramaya davet etti',
        ciStateJoined: 'Aramaya katıldınız',
        ciStateExpired: 'Davet süresi doldu',
        ciStateCancelled: 'Operatör daveti iptal etti',
        ciStateDeclined: 'Bu aramayı reddettiniz',
        ciTimeLeft: '{time} kaldı',
        ciMinutes: '{m} dk',
        ciMinutesSeconds: '{m} dk {s} sn',
        ciSeconds: '{s} sn',
        ciExpiringSoon: 'Süresi doluyor',
        ciAriaCard: 'Arama daveti',
        ciAriaJoinAudio: 'Sesli aramaya hemen katıl',
        ciAriaJoinVideo: 'Görüntülü aramaya hemen katıl',
        ciAriaDecline: 'Bu arama davetini reddet',
        ciBodyAudio: 'Bir operatör sizi sesli aramaya davet ediyor.',
        ciBodyVideo: 'Bir operatör sizi görüntülü aramaya davet ediyor.',
        ciWaitMinutes: 'Operatör katılmanız için en fazla {m} dakika bekleyecek.',
        ciWaitOneMinute: 'Operatör katılmanız için en fazla bir dakika bekleyecek.',
        csEndedByOperator: 'Görüşme operatör tarafından sonlandırıldı · Süre {duration}',
        csEndedByVisitor: 'Görüşme ziyaretçi tarafından sonlandırıldı · Süre {duration}',
        csEndedBySystem: 'Görüşme sona erdi · Süre {duration}',
        csEndedNotConnected: 'Görüşme bağlanamadı',
        csConnecting: 'Aramaya bağlanılıyor…',
        csReconnecting: 'Yeniden bağlanılıyor…',
        csInCall: 'Görüşmede',
        csEnded: 'Arama sona erdi',
        csMicMute: 'Mikrofonu kapat',
        csMicUnmute: 'Mikrofonu aç',
        csCamOn: 'Kamerayı aç',
        csCamOff: 'Kamerayı kapat',
        csHangup: 'Aramayı sonlandır',
        csClose: 'Kapat',
        csWaitingPeer: 'Karşı taraf bekleniyor…',
        csAudioCall: 'Sesli arama',
        csVideoCall: 'Görüntülü arama',
        csSwitchCamera: 'Kamerayı değiştir',
        csCameraUnavailable: 'Kamera kullanılamıyor',
        csBackToChat: 'Sohbete dön',
        csDuration: 'Süre',
        csOperatorEnded: 'Operatör aramayı sonlandırdı',
        csVisitorEnded: 'Aramayı siz sonlandırdınız',
        csCallEnded: 'Arama sona erdi',
        csErrSdkMissing: 'Arama hizmeti kullanılamıyor. Sayfayı yenileyip tekrar deneyin.',
        csErrSdkLoad: 'Arama hizmeti yüklenemedi. Lütfen tekrar deneyin.',
        csErrConnect: 'Aramaya bağlanılamadı. Lütfen tekrar deneyin.',
        csErrTokenMint: 'Arama jetonu alınamadı. Lütfen tekrar deneyin.',
        csErrProviderNotReady: 'Arama hizmeti hazır değil. Biraz sonra tekrar deneyin.',
        csErrTurnMissing: 'Ağ yapılandırması eksik. Lütfen destekle iletişime geçin.',
        csErrPermMic: 'Mikrofon erişimi engellendi. Tarayıcı ayarlarından izin verin.',
        csErrPermCam: 'Kamera erişimi engellendi. Tarayıcı ayarlarından izin verin.',
        csErrInvitationExpired: 'Bu davet süresi dolmuş.',
        csErrInvitationJoined: 'Bu davet zaten kullanılmış.',
        csErrAccessDenied: 'Bu aramaya erişiminiz yok.',
        csErrOriginDenied: 'Bu site arama başlatamaz.',
        csErrUnknown: 'Bir şeyler ters gitti. Lütfen tekrar deneyin.',
        support: 'Destek',
        operator: 'Operatör',
        team: 'Ekip',
        anonymous: 'Anonim',
        poweredBy: 'Sağlayan',
        welcomeFallback: 'Merhaba 👋\nSize nasıl yardımcı olabiliriz?',
        teamLabel: 'Destek ekibi',
        onlineLabel: 'çevrimiçi',
        home: 'Ana sayfa',
        homeGreeting: 'Merhaba 👋',
        homeGreetingSub: 'Size nasıl yardımcı olabiliriz?',
        resumeTitle: 'Önceki sohbete devam et',
        resumeCta: 'Devam et',
        actionAi: 'Yapay zekâ asistanına sor',
        actionAiSub: 'Yanıt almanın en hızlı yolu',
        actionHuman: 'Destek ile sohbet et',
        actionHumanSub: 'Bir temsilci ile görüşün',
        actionKb: 'Yardım merkezinde ara',
        actionKbSub: 'Sorularınızın yanıtını bulun',
        categories: 'Kategoriler',
        viewAll: 'Tümünü gör',
        awayLabel: 'uzakta',
        offlineLabel: 'çevrimdışı',
        aiAnswer: 'Otomatik yanıt',
        closeWidget: 'Kapat',
        noCategories: 'Kategori bulunamadı',
      },
    };
    return {
      t: function (locale, key) {
        var l = dict[locale] ? locale : 'en';
        return (dict[l] && dict[l][key]) || dict.en[key] || key;
      },
    };
  })();

  // ════════════════════════════════════════════════════════════════════
  // Transport — provider-agnostic interface.
  //
  // Connection states: 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline'
  //
  // Public contract (drop-in for future SSE/WS/Centrifugo):
  //   connect()
  //   disconnect()
  //   subscribeConversation(cid)
  //   unsubscribeConversation(cid)
  //   sendMessage({ text, conversationId }, { onReply, onConversation, onError })
  //   loadHistory({ onResult })
  //   sendTyping({ conversationId })
  //   on(event, fn) → off()
  //     events: 'message' | 'typing' | 'presence' | 'reconnect' | 'connectionstate'
  //
  // The polling driver implements message/connectionstate/reconnect for real,
  // and exposes typing/presence as no-op hooks that future drivers can fulfill.
  // ════════════════════════════════════════════════════════════════════
  function createTransport(ctx, transportStore, fsm) {
    var subs = { message: [], typing: [], presence: [], reconnect: [], connectionstate: [] };
    function on(event, fn) {
      if (!subs[event]) return function () {};
      subs[event].push(fn);
      return function () {
        var i = subs[event].indexOf(fn);
        if (i !== -1) subs[event].splice(i, 1);
      };
    }
    function emit(event, payload) {
      var arr = subs[event] || [];
      for (var i = 0; i < arr.length; i++) {
        try { arr[i](payload); } catch (e) { Util.warn('transport listener err', e); }
      }
    }

    // Legacy bridge: external callers (chat UI, banner, composer) still
    // subscribe to transportStore.connectionState. We compute the legacy
    // value from the FSM in ONE place and only emit when it actually
    // changes — the FSM remains the source of truth.
    // `everOnline` flips to true the FIRST time we reach 'online'. Without
    // it, the very first connecting → online transition would emit a
    // 'reconnect' event (because prev was 'connecting'), causing the chat
    // UI to call bootstrapHistory() again right after the initial load —
    // the source of the duplicate "transport reconnect — refreshing
    // history" log on a healthy first connect.
    var everOnline = false;
    function syncLegacyState(reason) {
      var legacy = fsm ? fsm.legacyConnectionState() : 'idle';
      var prev = transportStore.get().connectionState;
      if (prev === legacy) return;
      transportStore.set({ connectionState: legacy, lastConnectionChange: Date.now() });
      emit('connectionstate', { state: legacy, previous: prev, reason: reason || null });
      if (legacy === 'online') {
        // Only emit 'reconnect' on a TRUE reconnect — i.e. we were online
        // at least once before and just came back from a degraded state.
        // Initial connect MUST NOT fire 'reconnect' (it would double-load
        // history and is semantically wrong).
        if (everOnline && (prev === 'reconnecting' || prev === 'offline')) {
          emit('reconnect', { reason: reason || null });
        }
        everOnline = true;
      }
    }
    if (fsm) fsm.onChange(function () { syncLegacyState('fsm'); });
    // Driver-level state callback. Drivers report low-level transport state
    // ('idle' | 'connecting' | 'online' | 'reconnecting'); we translate to FSM.
    function onDriverState(driverState, reason) {
      if (!fsm) return;
      var cur = fsm.get();
      if (driverState === 'connecting') {
        if (cur === 'connected' || cur === 'subscribing' || cur === 'degraded') {
          fsm.transition('reconnecting', reason || 'driver:connecting');
        } else if (cur !== 'reconnecting' && cur !== 'connecting') {
          fsm.transition('connecting', reason || 'driver:connecting');
        }
      } else if (driverState === 'online') {
        // If we have an active conversation but no subscribe-completion
        // signal yet, stay in 'subscribing' — a connected socket without a
        // subscribed channel is NOT sendable for that conversation. The
        // driver flips to 'connected' indirectly via onReconnect once the
        // subscribe ack lands (Centrifugo) or when channel SUBSCRIBED
        // event fires (Supabase).
        var cid = fsm.getConversation();
        var hasDriverWithSubscribe = !!(rtDriver && rtDriver.subscribeConversation);
        if (cid && hasDriverWithSubscribe) {
          fsm.transition('subscribing', reason || 'driver:online-pending-sub');
        } else {
          fsm.transition('connected', reason || 'driver:online');
        }
      } else if (driverState === 'reconnecting') {
        fsm.transition('reconnecting', reason || 'driver:reconnecting');
      } else if (driverState === 'idle') {
        // Driver intentionally idle (manual disconnect) — only transition
        // to idle if we initiated it. Otherwise this is a transient drop.
        if (manuallyClosed) fsm.transition('idle', 'driver:idle');
        else fsm.transition('reconnecting', 'driver:dropped');
      }
    }
    // Legacy alias kept for old call sites inside this file.
    function setConnectionState(legacy) {
      // Map legacy strings used inside the polling/online handling code
      // back into FSM transitions. This keeps the rest of createTransport
      // unchanged at the call sites while routing everything through FSM.
      if (!fsm) return;
      if (legacy === 'online') {
        var cid = fsm.getConversation();
        var hasRT = !!(rtDriver && rtDriver.subscribeConversation);
        if (cid && hasRT) fsm.transition('subscribing', 'legacy:online');
        else fsm.transition('connected', 'legacy:online');
      } else if (legacy === 'offline') {
        fsm.transition('offline', 'legacy:offline');
      } else if (legacy === 'connecting') {
        if (fsm.get() !== 'connecting' && fsm.get() !== 'reconnecting') {
          fsm.transition('connecting', 'legacy:connecting');
        }
      } else if (legacy === 'reconnecting') {
        fsm.transition('reconnecting', 'legacy:reconnecting');
      } else if (legacy === 'idle') {
        fsm.transition('idle', 'legacy:idle');
      }
    }

    // ─── Transport state shared by polling + realtime drivers ───
    var pollingHandle = null;
    var lastSuccessAt = 0;
    var consecutiveFailures = 0;
    var browserOnline = (typeof navigator !== 'undefined' && 'onLine' in navigator) ? navigator.onLine : true;
    var subscribedConversation = null;
    var historyLoaded = false;
    var manuallyClosed = false;

    // ─── Realtime driver (Phase 3) — drop-in for polling ───
    // When the server resolves vendor=centrifugo, we add a real WS driver alongside.
    // UI/transport contract stays identical; polling is paused while WS owns state.
    var rtDriver = null;
    var fallbackPolicy = 'lenient';
    var resolvedVendor = 'polling_builtin';

    // ─── Capabilities (provider-agnostic). Updated dynamically after resolve.
    var capabilities = {
      driver: 'polling',
      supportsRealtime: false,
      supportsTyping: false,
      supportsPresence: false,
      supportsHistoryLoad: true,
      supportsReconnectSignals: true,
    };

    function ensureChatModule(cb) {
      if (ModuleLoader.modules.chat) return cb(ModuleLoader.modules.chat);
      var url = (ctx.assetBase || '') + '/widget/runtime-chat.js?v=' +
        (ctx.config._loaderVersion || ctx.config.loaderVersion || 'dev');
      ModuleLoader.load('chat', url, function (mod) { cb(mod); });
    }

    function assetVersion() {
      return ctx.config._loaderVersion || ctx.config.loaderVersion || 'dev';
    }

    function ensureResolverModule(cb) {
      if (window.__gs_mod_rt_resolver) return cb(window.__gs_mod_rt_resolver);
      var url = (ctx.assetBase || '') + '/widget/runtime-rt-resolver.js?v=' + assetVersion();
      ModuleLoader.load('rt_resolver', url, function () { cb(window.__gs_mod_rt_resolver); });
    }

    /**
     * Lazy-load the realtime driver matching `vendor` via the resolver.
     * Calls cb(driverModule|null). Driver module exposes `.create(...)`.
     */
    function ensureRealtimeDriver(vendor, cb) {
      ensureResolverModule(function (resolver) {
        if (!resolver || !resolver.isDriverVendor(vendor)) return cb(null);
        var desc = resolver.resolveDriverDescriptor(vendor);
        if (!desc) return cb(null);
        if (window[desc.globalKey]) return cb(window[desc.globalKey]);
        var url = (ctx.assetBase || '') + '/widget/' + desc.asset + '?v=' + assetVersion();
        ModuleLoader.load('rt_' + vendor, url, function () { cb(window[desc.globalKey] || null); });
      });
    }

    function loadHistory(opts) {
      ensureChatModule(function (mod) {
        if (!mod || !mod.loadHistory) {
          markPollFailure();
          if (opts && opts.onResult) opts.onResult({ conversationId: null, messages: [] });
          return;
        }
        mod.loadHistory({
          apiBase: ctx.apiBase,
          workspaceId: ctx.workspaceId,
          sessionToken: ctx.sessionToken,
          // Token-aware fetch: proactive refresh + single 401/403 retry.
          // Modules call fetchWith() so an expired token mid-poll never
          // surfaces as a permanent failure to the user.
          fetchWith: ctx.fetchWith,
          onResult: function (result) {
            historyLoaded = true;
            markPollSuccess();
            if (opts && opts.onResult) opts.onResult(result);
          },
        });
      });
    }

    function sendMessage(payload, hooks) {
      hooks = hooks || {};
      ensureChatModule(function (mod) {
        if (!mod || !mod.sendMessage) {
          if (hooks.onError) hooks.onError('module_unavailable');
          return;
        }
        mod.sendMessage({
          apiBase: ctx.apiBase,
          workspaceId: ctx.workspaceId,
          sessionToken: ctx.sessionToken,
          fetchWith: ctx.fetchWith,
          conversationId: payload.conversationId,
          // Phase 6b — attachment id flows through to the message endpoint.
          attachmentId: payload.attachmentId || null,
          text: payload.text,
          onConversation: function (cid) {
            if (cid) {
              subscribedConversation = cid;
              if (rtDriver && rtDriver.subscribeConversation) rtDriver.subscribeConversation(cid);
            }
            if (hooks.onConversation) hooks.onConversation(cid);
          },
          // Phase 7 — backend confirmation. Carries the canonical message id
          // so the widget can transition its optimistic bubble to "sent".
          onAccepted: function (info) {
            if (hooks.onAccepted) hooks.onAccepted(info || {});
          },
          onReply: function (reply) {
            if (hooks.onReply) hooks.onReply(reply);
            markPollSuccess();
          },
          onError: function (err) {
            markPollFailure();
            if (hooks.onError) hooks.onError(err);
          },
        });
      });
    }

    function markPollSuccess() {
      lastSuccessAt = Date.now();
      consecutiveFailures = 0;
      // While realtime owns the connection state, REST success doesn't flip it.
      if (browserOnline && !rtDriver) setConnectionState('online');
    }
    function markPollFailure() {
      consecutiveFailures += 1;
      if (!browserOnline) {
        setConnectionState('offline');
        return;
      }
      if (rtDriver) return; // realtime driver owns connection state
      var cur = transportStore.get().connectionState;
      if (cur === 'connecting') {
        setConnectionState('reconnecting');
      } else if (cur === 'online' && consecutiveFailures >= 2) {
        setConnectionState('reconnecting');
      }
    }

    function subscribeConversation(cid) {
      if (!cid) return;
      if (subscribedConversation !== cid) subscribedConversation = cid;
      // Canonical cid lives in the FSM — survives driver swaps, BFCache
      // restores, and rt→polling fallbacks. Any future driver reload
      // re-subscribes from this value, eliminating the lost-subscription race.
      if (fsm) fsm.setConversation(cid);
      if (rtDriver && rtDriver.subscribeConversation) rtDriver.subscribeConversation(cid);
    }
    function unsubscribeConversation(cid) {
      if (subscribedConversation === cid) subscribedConversation = null;
      if (fsm && fsm.getConversation() === cid) fsm.setConversation(null);
      if (rtDriver && rtDriver.unsubscribeConversation) rtDriver.unsubscribeConversation(cid);
    }

    function startPolling() {
      ensureChatModule(function (mod) {
        if (!mod || !mod.startPolling) return;
        if (pollingHandle && pollingHandle.stop) pollingHandle.stop();
        pollingHandle = mod.startPolling({
          apiBase: ctx.apiBase,
          workspaceId: ctx.workspaceId,
          sessionToken: ctx.sessionToken,
          fetchWith: ctx.fetchWith,
          interval: 4000,
          getConversationId: function () { return subscribedConversation; },
          onConversation: function (cid) {
            if (cid) subscribedConversation = cid;
          },
          onMessages: function (msgs) {
            markPollSuccess();
            if (msgs && msgs.length) emit('message', { messages: msgs });
          },
          onTick: function (ok) { if (ok) markPollSuccess(); else markPollFailure(); },
          // 403 from /poll on an unknown / foreign / closed conversation id
          // — drop the local cid so the next tick re-resolves via cookie
          // identity. Stops infinite 403 loops on a stale id.
          onConversationDenied: function (deniedCid) {
            if (subscribedConversation === deniedCid) {
              subscribedConversation = null;
              chatStore.set({ conversationId: null });
            }
          },
        });
      });
    }
    function stopPolling() {
      if (pollingHandle && pollingHandle.stop) {
        pollingHandle.stop();
        pollingHandle = null;
      }
    }

    function handleBrowserOnline() {
      browserOnline = true;
      setConnectionState('reconnecting');
    }
    function handleBrowserOffline() {
      browserOnline = false;
      setConnectionState('offline');
    }

    // ─── Realtime resolver: ask backend which transport to use ───
    //
    // Backend returns one of:
    //   { vendor: 'centrifugo', ws_url, token, expires_at, capabilities, ... }
    //   { vendor: 'supabase',   supabase_url, anon_key, capabilities, ... }
    //   { vendor: 'polling_builtin', capabilities }
    //   { vendor: 'disabled',        capabilities }
    //
    // Driver vendors ('centrifugo', 'supabase') are dispatched through the
    // resolver module + driver-specific runtime script. Non-driver vendors
    // ('polling_builtin', 'disabled') are handled inline.
    function resolveRealtimeAndStart() {
      var url = ctx.apiBase + '/api/realtime/connect';
      // Use the token-aware wrapper — realtime resolve is one of the most
      // expensive widget bootstraps and a stale token here would otherwise
      // poison every downstream subscribe attempt.
      ctx.fetchWith(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: ctx.workspaceId }),
      })
        .then(function (r) { return r.json(); })
        .then(function (resolved) {
          // Phase 6C — refresh the policy snapshot from the realtime
          // negotiation BEFORE we decide which transport to start. The
          // backend may flip force_polling to true even if the lock /
          // priority would otherwise yield centrifugo.
          if (resolved && resolved.effective_policy) {
            Policy.set(resolved.effective_policy);
          }
          // If policy says force polling, do not even attempt a real
          // realtime driver — drop straight into polling. The backend
          // already returns vendor: 'polling_builtin' in that case, but
          // be defensive in case an older server omits the override.
          if (Policy.forcePolling()) {
            resolved = resolved || {};
            resolved.vendor = 'polling_builtin';
          }
          resolvedVendor = (resolved && resolved.vendor) || 'polling_builtin';
          fallbackPolicy = (resolved && resolved.fallback_policy) || 'lenient';
          if (resolved && resolved.capabilities) {
            for (var k in resolved.capabilities) {
              if (Object.prototype.hasOwnProperty.call(resolved.capabilities, k)) {
                capabilities[k] = resolved.capabilities[k];
              }
            }
            capabilities.driver = resolvedVendor;
          }

          function fallback(reason) {
            Util.warn('[transport] realtime fallback:', reason);
            // Tear down the realtime driver — it lost; polling owns state now.
            if (rtDriver) {
              try { rtDriver.disconnect && rtDriver.disconnect(); } catch (_) {}
              rtDriver = null;
            }
            capabilities.driver = 'polling';
            capabilities.supportsRealtime = false;
            capabilities.supportsTyping = false;
            capabilities.supportsPresence = false;
            if (fallbackPolicy === 'lenient') {
              startPolling();
              // FSM: 'degraded' makes the fallback explicit. Composer stays
              // sendable (polling can deliver), but diagnostics + future
              // recovery hooks know we are NOT on the primary path.
              if (fsm && fsm.get() !== 'degraded') {
                fsm.transition('degraded', 'fallback:' + (reason || 'rt_failed'));
              }
            } else {
              if (fsm) fsm.transition('offline', 'strict_fallback:' + (reason || 'rt_failed'));
              else setConnectionState('offline');
            }
          }

          // Vendor needs a real driver module — load via resolver.
          ensureResolverModule(function (resolver) {
            var isDriverVendor = !!(resolver && resolver.isDriverVendor(resolvedVendor));

            if (isDriverVendor) {
              // Per-vendor minimal config sanity check before loading.
              if (resolvedVendor === 'centrifugo' && !(resolved.token && resolved.ws_url)) {
                fallback('centrifugo_config_missing');
                return;
              }
              if (resolvedVendor === 'supabase' && !(resolved.supabase_url && resolved.anon_key)) {
                fallback('supabase_config_missing');
                return;
              }

              ensureRealtimeDriver(resolvedVendor, function (mod) {
                if (!mod || !mod.create) {
                  fallback(resolvedVendor + '_module_load_failed');
                  return;
                }
                rtDriver = mod.create(ctx, resolved, {
                  onConnectionState: function (s) { onDriverState(s, resolvedVendor); },
                  onMessage: function (e) { emit('message', e); },
                  onTyping: function (e) { emit('typing', e); },
                  onPresence: function (e) { emit('presence', e); },
                  onReconnect: function () { emit('reconnect', {}); },
                  // Subscribe-ack from the driver — proves the per-conversation
                  // channel is live and the visitor is sendable. This is the
                  // ONLY signal that completes 'subscribing' → 'connected'
                  // after refresh. Without it the FSM would hang in
                  // 'subscribing' (incoming pushes still work, but composer
                  // stays disabled because BUSY[subscribing]=1).
                  onSubscribed: function (e) {
                    if (!fsm) return;
                    var cur = fsm.get();
                    var activeCid = fsm.getConversation();
                    // Only complete if this ack is for the active conversation
                    // (or the driver didn't tell us which one — be permissive).
                    if (e && e.conversationId && activeCid && e.conversationId !== activeCid) return;
                    if (cur === 'subscribing' || cur === 'reconnecting' || cur === 'waking' || cur === 'degraded') {
                      fsm.transition('connected', 'driver:subscribed');
                    }
                  },
                  fallbackToPolling: fallback,
                });
                rtDriver.connect();
                // Resubscribe canonical conversation. FSM is the source of
                // truth for the active cid — it survives driver swaps and
                // BFCache restores, so a freshly loaded driver always
                // re-binds the right channel.
                var cidNow = (fsm && fsm.getConversation()) || subscribedConversation;
                if (cidNow) {
                  subscribedConversation = cidNow;
                  rtDriver.subscribeConversation(cidNow);
                }
              });
              return;
            }

            if (resolvedVendor === 'disabled') {
              // Realtime disabled by admin — REST history still works on demand.
              setConnectionState('offline');
              return;
            }

            // polling_builtin (default / fallback) or any unknown vendor.
            startPolling();
          });
        })
        .catch(function (err) {
          // Resolver itself failed → conservative fallback to polling.
          Util.warn('[transport] resolver error, fallback to polling:', err);
          startPolling();
        });
    }

    function connect() {
      manuallyClosed = false;
      consecutiveFailures = 0;
      lastSuccessAt = 0;
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('online', handleBrowserOnline);
        window.addEventListener('offline', handleBrowserOffline);
      }
      if (!browserOnline) {
        if (fsm) fsm.transition('offline', 'connect:no-network');
        else setConnectionState('offline');
      } else if (fsm) {
        if (fsm.get() !== 'connecting' && fsm.get() !== 'reconnecting' && fsm.get() !== 'subscribing') {
          fsm.transition('connecting', 'connect');
        }
      } else {
        setConnectionState('connecting');
      }
      resolveRealtimeAndStart();
    }
    function disconnect() {
      manuallyClosed = true;
      stopPolling();
      if (rtDriver && rtDriver.disconnect) {
        try { rtDriver.disconnect(); } catch (_) {}
        rtDriver = null;
      }
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('online', handleBrowserOnline);
        window.removeEventListener('offline', handleBrowserOffline);
      }
      if (fsm) fsm.transition('idle', 'disconnect');
      else setConnectionState('idle');
    }

    /**
     * Force a clean reconnect cycle. Used after the page returns from a
     * long background sleep (visibilitychange / pageshow) where the
     * realtime socket may have died silently and the token may have been
     * disabled by max-failure backoff. Idempotent — safe to call multiple
     * times.
     */
    function reconnect() {
      // ── Guard: do not yank an in-flight bootstrap/connect/subscribe.
      //    The wake handler already enforces this, but second-line
      //    defense here protects against any other caller (debug
      //    tooling, future code paths) from dropping a live handshake.
      if (fsm) {
        var preState = fsm.get();
        if (preState === 'bootstrapping' || preState === 'restoring_session' ||
            preState === 'connecting'    || preState === 'subscribing') {
          Util.log('[transport] reconnect skipped — handshake in flight (' + preState + ')');
          return;
        }
      }
      Util.log('[transport] forced reconnect');
      manuallyClosed = false;
      try {
        if (rtDriver && rtDriver.disconnect) rtDriver.disconnect();
      } catch (_) {}
      rtDriver = null;
      stopPolling();
      consecutiveFailures = 0;
      lastSuccessAt = 0;
      browserOnline = (typeof navigator === 'undefined') ? true : navigator.onLine !== false;
      if (!browserOnline) {
        if (fsm) fsm.transition('offline', 'reconnect:no-network');
        else setConnectionState('offline');
        return;
      }
      if (fsm) {
        // Honor an externally-set 'waking' state — the lifecycle controller
        // sets it before calling reconnect() so diagnostics + UI can
        // distinguish wake-from-sleep from initial connect / outage.
        var cur = fsm.get();
        if (cur !== 'waking' && cur !== 'connecting' && cur !== 'reconnecting' && cur !== 'subscribing') {
          fsm.transition('connecting', 'reconnect');
        }
      } else {
        setConnectionState('connecting');
      }
      resolveRealtimeAndStart();
    }

    // ─── Typing — delegated to realtime driver if available, no-op otherwise.
    function sendTyping(payload) {
      if (rtDriver && rtDriver.sendTyping) rtDriver.sendTyping(payload);
    }

    return {
      connect: connect,
      disconnect: disconnect,
      reconnect: reconnect,
      subscribeConversation: subscribeConversation,
      unsubscribeConversation: unsubscribeConversation,
      sendMessage: sendMessage,
      sendTyping: sendTyping,
      loadHistory: loadHistory,
      on: on,
      getDriverName: function () { return capabilities.driver; },
      getCapabilities: function () {
        var copy = {};
        for (var k in capabilities) {
          if (Object.prototype.hasOwnProperty.call(capabilities, k)) copy[k] = capabilities[k];
        }
        return copy;
      },
      hasCapability: function (key) { return !!capabilities[key]; },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Identity layer — server-driven, cookie-backed (UNCHANGED security model)
  // ════════════════════════════════════════════════════════════════════
  function createIdentity(ctx, identityStore) {
    function configFallback() {
      var pc = ctx.config.preChat || {};
      function on(key) {
        var f = pc[key] || {};
        return !!f.enabled && !f.locked;
      }
      return {
        ask_name: on('name'), ask_email: on('email'), ask_phone: on('phone'),
        require_name: on('name'), require_email: on('email'), require_phone: on('phone'),
        verify_email: false, verify_phone: false,
      };
    }

    function fetchMe(cb) {
      if (!ctx.apiBase || !ctx.workspaceId) {
        identityStore.set({ loaded: true });
        if (cb) cb(false);
        return;
      }
      ctx.fetchWith(
        ctx.apiBase + '/api/widget/identity/me?workspace_id=' + encodeURIComponent(ctx.workspaceId),
        {}
      )
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (res.ok && res.body) {
            identityStore.set({
              loaded: true,
              identityState: res.body.identity_state || 'anonymous',
              contact: res.body.contact || null,
              prechat: res.body.prechat || configFallback(),
            });
          } else {
            identityStore.set({
              loaded: true,
              identityState: 'anonymous',
              contact: null,
              prechat: configFallback(),
            });
          }
          Util.log('identity resolved', identityStore.get());
          if (cb) cb(true);
        })
        .catch(function () {
          identityStore.set({
            loaded: true,
            identityState: 'anonymous',
            contact: null,
            prechat: configFallback(),
          });
          if (cb) cb(false);
        });
    }

    function submitPrechat(payload, cb) {
      ctx.fetchWith(ctx.apiBase + '/api/widget/identity/prechat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: ctx.workspaceId,
          name: payload.name || null,
          email: payload.email || null,
          phone: payload.phone || null,
        }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok) { if (cb) cb(false, res.body); return; }
          var prev = identityStore.get().contact || {};
          identityStore.set({
            identityState: 'identified',
            contact: {
              id: res.body.contact_id,
              name: payload.name || prev.name || null,
              email: payload.email || prev.email || null,
              phone: payload.phone || prev.phone || null,
            },
          });
          if (cb) cb(true, res.body);
        })
        .catch(function (err) { if (cb) cb(false, { error: 'network', _e: err }); });
    }

    function isAsked(field) {
      var p = identityStore.get().prechat;
      return !!(p && p['ask_' + field]);
    }
    function isRequired(field) {
      var p = identityStore.get().prechat;
      return !!(p && p['require_' + field]);
    }
    function needsPrechat() {
      var s = identityStore.get();
      if (s.identityState === 'identified') return false;
      if (!s.prechat) return false;
      // Show pre-chat whenever any field is asked. Required fields gate
      // submission inside the form; optional fields can be skipped.
      return !!(s.prechat.ask_name || s.prechat.ask_email || s.prechat.ask_phone);
    }

    return {
      fetchMe: fetchMe,
      submitPrechat: submitPrechat,
      isAsked: isAsked,
      isRequired: isRequired,
      needsPrechat: needsPrechat,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // UI.Notify — connection banner + launcher unread badge + in-shell toast
  //             + optional sound + document.title indicator.
  //
  // Rules (Phase 4):
  //   - Driven ONLY by transport.on('message') flow upstream — this module
  //     never fetches, never queues, never duplicates messages.
  //   - All UI lives inside the Shadow DOM (toast appended next to launcher
  //     via the shell's shadowRoot). No browser Notifications API.
  //   - Sound only after a real user interaction (browser autoplay policy).
  //     Disabled by default; toggled via uiPrefsStore.soundEnabled.
  //   - document.title is the only host-page surface we touch, and it is
  //     fully restored when unread → 0. We snapshot the original title once.
  // ════════════════════════════════════════════════════════════════════
  function createNotify(ctx, transportStore, notifyStore, uiPrefsStore, shellStore, t) {
    var bannerEl = null;
    var toastEl = null;
    var toastTimer = null;
    var shadowRoot = (ctx.shell && ctx.shell.shadowRoot) ||
      (ctx.shell && ctx.shell.shellEl && ctx.shell.shellEl.shadowRoot) || null;

    // ─── document.title snapshot (restore on unread = 0) ───
    var originalTitle = (typeof document !== 'undefined' && document.title) ? document.title : '';
    var titleHasPrefix = false;
    function applyTitle(unread) {
      if (typeof document === 'undefined') return;
      if (unread > 0) {
        var prefix = '(' + (unread > 9 ? '9+' : unread) + ') ';
        // If we previously prefixed, strip our prefix before re-applying so
        // we never stack "(1) (2) Original Title".
        var base = titleHasPrefix ? originalTitle : document.title;
        // If the host page mutated the title since we snapshotted, refresh
        // the snapshot so we restore the *current* title later.
        if (!titleHasPrefix) originalTitle = document.title;
        document.title = prefix + base;
        titleHasPrefix = true;
      } else if (titleHasPrefix) {
        document.title = originalTitle;
        titleHasPrefix = false;
      }
    }

    // ─── Sound (lazy, gated by user interaction + uiPrefsStore) ───
    var audioCtx = null;
    var userInteracted = false;
    function markUserInteracted() { userInteracted = true; }
    if (typeof window !== 'undefined') {
      var once = { once: true, capture: true };
      window.addEventListener('pointerdown', markUserInteracted, once);
      window.addEventListener('keydown', markUserInteracted, once);
      window.addEventListener('touchstart', markUserInteracted, once);
    }
    function ensureAudioCtx() {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!audioCtx) audioCtx = new Ctx();
        if (audioCtx.state === 'suspended' && audioCtx.resume) {
          try { audioCtx.resume(); } catch (_) {}
        }
        return audioCtx;
      } catch (_) { return null; }
    }
    /**
     * Soft two-note chime for incoming operator messages.
     * E5 → A5, sine, gentle envelope. Pleasant, non-aggressive.
     */
    function playBeep() {
      if (!uiPrefsStore.get().soundEnabled) return;
      if (!userInteracted) return;
      var ctx = ensureAudioCtx();
      if (!ctx) return;
      try {
        var t0 = ctx.currentTime;
        var notes = [
          { f: 659.25, at: 0.00, dur: 0.22 }, // E5
          { f: 880.00, at: 0.14, dur: 0.30 }, // A5
        ];
        for (var i = 0; i < notes.length; i++) {
          var n = notes[i];
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(n.f, t0 + n.at);
          gain.gain.setValueAtTime(0.0001, t0 + n.at);
          gain.gain.exponentialRampToValueAtTime(0.16, t0 + n.at + 0.025);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t0 + n.at);
          osc.stop(t0 + n.at + n.dur + 0.02);
        }
      } catch (_) { /* never break on audio */ }
    }

    /**
     * Ringtone for incoming call invitations. Loops a short two-tone
     * cadence (classic phone-style: ~1s ring, ~1s rest) until stopped.
     * Honors the same user-interaction + soundEnabled gates as playBeep.
     */
    var ringNodes = null; // { interval, stop() }
    // Tracks whether a ringtone was requested but blocked by the autoplay
    // policy (no user gesture yet). Surfaces a "Tap to enable sound" hint
    // and starts the audio as soon as the visitor interacts with the page.
    var ringPendingUnlock = false;
    function playRingtone() {
      if (ringNodes) return; // already ringing
      if (!uiPrefsStore.get().soundEnabled) return;
      if (!userInteracted) {
        ringPendingUnlock = true;
        try { notifyStore.set({ ringPendingUnlock: true }); } catch (_) {}
        try { console.debug('[gs-widget] ringtone blocked: awaiting user gesture'); } catch (_) {}
        return;
      }
      var ctx = ensureAudioCtx();
      if (!ctx) return;
      function ringOnce() {
        try {
          var t0 = ctx.currentTime;
          // Two-tone alternation A4↔E5 over ~0.9s, gentle warble.
          var pattern = [
            { f: 440.00, at: 0.00, dur: 0.22 },
            { f: 659.25, at: 0.22, dur: 0.22 },
            { f: 440.00, at: 0.46, dur: 0.22 },
            { f: 659.25, at: 0.68, dur: 0.22 },
          ];
          for (var i = 0; i < pattern.length; i++) {
            var n = pattern[i];
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(n.f, t0 + n.at);
            gain.gain.setValueAtTime(0.0001, t0 + n.at);
            gain.gain.exponentialRampToValueAtTime(0.14, t0 + n.at + 0.03);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
            osc.connect(gain).connect(ctx.destination);
            osc.start(t0 + n.at);
            osc.stop(t0 + n.at + n.dur + 0.02);
          }
        } catch (_) { /* swallow */ }
      }
      ringOnce();
      var interval = setInterval(ringOnce, 1900);
      ringNodes = {
        stop: function () {
          try { clearInterval(interval); } catch (_) {}
          ringNodes = null;
        },
      };
      ringPendingUnlock = false;
      try { notifyStore.set({ ringPendingUnlock: false }); } catch (_) {}
    }
    function stopRingtone(reason) {
      if (ringNodes) ringNodes.stop();
      ringPendingUnlock = false;
      try { notifyStore.set({ ringPendingUnlock: false }); } catch (_) {}
      try { console.debug('[gs-widget] ringtone stop', reason || 'unspecified'); } catch (_) {}
    }
    // When the visitor finally interacts with the page after a blocked
    // ringtone request, start it immediately if the call is still pending.
    function tryStartPendingRing() {
      if (!ringPendingUnlock) return;
      ringPendingUnlock = false;
      try { notifyStore.set({ ringPendingUnlock: false }); } catch (_) {}
      // Re-enter playRingtone now that userInteracted is true.
      playRingtone();
    }
    if (typeof window !== 'undefined') {
      var unlockOpts = { capture: true };
      var onAnyInteraction = function () { tryStartPendingRing(); };
      window.addEventListener('pointerdown', onAnyInteraction, unlockOpts);
      window.addEventListener('keydown', onAnyInteraction, unlockOpts);
      window.addEventListener('touchstart', onAnyInteraction, unlockOpts);
    }

    // ─── Toast (Shadow DOM only, lives next to launcher) ───
    function currentPositionClass() {
      var pos = (uiPrefsStore.get() && uiPrefsStore.get().position) === 'bottom-left'
        ? 'bottom-left' : 'bottom-right';
      return pos;
    }
    function ensureToastEl() {
      if (toastEl || !shadowRoot) return toastEl;
      var shellDiv = shadowRoot.querySelector('.shell') || shadowRoot;
      toastEl = document.createElement('div');
      toastEl.className = 'gs-toast ' + currentPositionClass();
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      toastEl.style.display = 'none';
      // Click → open the panel.
      toastEl.addEventListener('click', function () {
        hideToast();
        if (ctx.shell && ctx.shell.shellEl) {
          // Trigger via launcher to reuse loader's open path.
          var btn = shellDiv.querySelector('.launcher');
          if (btn) btn.click();
        }
      });
      shellDiv.appendChild(toastEl);
      // Keep toast position in sync if widget position ever changes at runtime.
      uiPrefsStore.subscribe(function () {
        if (!toastEl) return;
        toastEl.classList.remove('bottom-right', 'bottom-left');
        toastEl.classList.add(currentPositionClass());
      });
      return toastEl;
    }
    function hideToast() {
      if (!toastEl) return;
      toastEl.classList.remove('visible');
      // Wait for transition before hiding (CSS uses 0.2s)
      setTimeout(function () { if (toastEl && !toastEl.classList.contains('visible')) toastEl.style.display = 'none'; }, 220);
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    }
    function showToast(senderName, preview) {
      // Never show toast while panel is open (user is already looking at chat).
      if (shellStore.get().isOpen) return;
      ensureToastEl();
      if (!toastEl) return;
      var name = senderName ? String(senderName) : (ctx.config.brandName || I18n.t(ctx.locale, 'support'));
      var msg = String(preview || '');
      if (msg.length > 90) msg = msg.slice(0, 87) + '…';
      toastEl.innerHTML =
        '<div class="gs-toast-title">' + Util.escapeHtml(name) + '</div>' +
        '<div class="gs-toast-body">' + Util.escapeHtml(msg) + '</div>';
      toastEl.style.display = 'block';
      // Force reflow so the transition runs even when replacing content fast.
      void toastEl.offsetWidth;
      toastEl.classList.add('visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 5000);
    }

    // ─── Connection banner (existing behavior, unchanged) ───
    function attach(panel) {
      bannerEl = document.createElement('div');
      bannerEl.className = 'connection-banner';
      bannerEl.setAttribute('role', 'status');
      bannerEl.setAttribute('aria-live', 'polite');
      var header = panel.querySelector('.header');
      if (header && header.nextSibling) {
        panel.insertBefore(bannerEl, header.nextSibling);
      } else {
        panel.insertBefore(bannerEl, panel.firstChild);
      }
      transportStore.subscribe(renderBanner);
      renderBanner(transportStore.get());

      // Wire global unread → launcher badge + title.
      notifyStore.subscribe(function (s) {
        if (ctx.shell.setUnread) ctx.shell.setUnread(s.totalUnread || 0);
        applyTitle(s.totalUnread || 0);
      });
      // Initial paint (in case state is non-zero on remount).
      var s0 = notifyStore.get();
      if (ctx.shell.setUnread) ctx.shell.setUnread(s0.totalUnread || 0);
      applyTitle(s0.totalUnread || 0);
    }

    function renderBanner(state) {
      if (!bannerEl) return;
      var s = state.connectionState;
      // Phase 6C — when the platform is in degraded / force-polling mode
      // AND the connection is otherwise healthy, surface a non-blocking
      // "limited" line. Messaging stays usable; this is informational only.
      // Phase 7.6 — also surface enforcement-driven throttling/priority
      // states with non-scary copy. Highest-severity wins.
      var degradedLabel = null;
      try {
        var pol = window.__gs_policy || null;
        if (pol) {
          if (pol.force_polling) degradedLabel = 'Connection limited — messaging still works';
          else if (pol.degraded_mode) degradedLabel = 'Limited mode — messaging still works';
          else if (pol.throttle_new_conversations) degradedLabel = 'High volume — new chats may take a moment';
          else if (pol.priority_only_mode) degradedLabel = 'Priority routing active — replies may be delayed';
          else if (pol.slow_mode_messages) degradedLabel = 'Slow mode — short delay between messages';
        }
      } catch (_) {}
      if (s === 'online' || s === 'idle') {
        if (degradedLabel && s === 'online') {
          bannerEl.className = 'connection-banner visible reconnecting';
          bannerEl.innerHTML = '';
          var ddot = document.createElement('span');
          ddot.className = 'conn-dot';
          ddot.setAttribute('aria-hidden', 'true');
          bannerEl.appendChild(ddot);
          var dspan = document.createElement('span');
          dspan.className = 'conn-label';
          dspan.textContent = degradedLabel;
          bannerEl.appendChild(dspan);
          if (bannerEl.__gsShowTimer) {
            clearTimeout(bannerEl.__gsShowTimer);
            bannerEl.__gsShowTimer = null;
          }
          return;
        }
        bannerEl.className = 'connection-banner';
        bannerEl.textContent = '';
        if (bannerEl.__gsShowTimer) {
          clearTimeout(bannerEl.__gsShowTimer);
          bannerEl.__gsShowTimer = null;
        }
        return;
      }
      // Offline is shown immediately (user needs to know).
      // connecting/reconnecting are transient — show only if they persist
      // longer than the grace window so brief blips don't flash a noisy banner.
      var paint = function () {
        var label = '';
        var cls = 'connection-banner visible';
        if (s === 'offline') { label = t('offline'); cls += ' offline'; }
        else if (s === 'reconnecting') { label = t('reconnecting'); cls += ' reconnecting'; }
        else if (s === 'connecting') { label = t('connecting'); cls += ' connecting'; }
        bannerEl.className = cls;
        bannerEl.innerHTML = '';
        var dot = document.createElement('span');
        dot.className = 'conn-dot';
        dot.setAttribute('aria-hidden', 'true');
        bannerEl.appendChild(dot);
        var span = document.createElement('span');
        span.className = 'conn-label';
        span.textContent = label;
        bannerEl.appendChild(span);
      };
      if (bannerEl.__gsShowTimer) {
        clearTimeout(bannerEl.__gsShowTimer);
        bannerEl.__gsShowTimer = null;
      }
      if (s === 'offline') {
        paint();
      } else {
        // Keep current banner state until grace window elapses; if currently
        // hidden, schedule a delayed reveal. Avoids flashing on quick recovery.
        var alreadyVisible = bannerEl.classList.contains('visible');
        if (alreadyVisible) {
          paint();
        } else {
          bannerEl.__gsShowTimer = setTimeout(function () {
            bannerEl.__gsShowTimer = null;
            // Re-check latest state — only paint if still not online.
            var latest = transportStore.get().connectionState;
            if (latest === 'connecting' || latest === 'reconnecting') {
              s = latest;
              paint();
            }
          }, 3500);
        }
      }
    }

    return {
      attach: attach,
      showToast: showToast,
      hideToast: hideToast,
      playBeep: playBeep,
      playRingtone: playRingtone,
      stopRingtone: stopRingtone,
      // Legacy API kept for the public runtime.setUnread bridge — sets the
      // global counter directly. UI redraws via notifyStore subscription.
      setUnread: function (count) {
        notifyStore.set(function (s) {
          var per = {};
          for (var k in s.perConversation) if (Object.prototype.hasOwnProperty.call(s.perConversation, k)) per[k] = s.perConversation[k];
          return { perConversation: per, totalUnread: Math.max(0, count | 0) };
        });
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Presence / Availability — Phase 5
  //
  // Resolves whether human help is currently available, completely
  // SEPARATE from transport state (a healthy WS connection does NOT mean
  // an operator is online) and SEPARATE from unread/notification state.
  //
  // Layered inputs (highest priority first):
  //   1. live_chat_enabled === false                  → 'unavailable'
  //   2. business_hours says closed (if enabled)      → 'offline'
  //   3. realtime presence event (if driver supports) → 'online' / 'away' / 'offline'
  //   4. backend snapshot (onlineOperators in config) → 'online' / 'offline'
  //   5. conservative default                         → 'offline'
  //
  // Capability-aware: if transport doesn't emit presence, we never wait
  // for it and never assume online. Polling fallback always produces a
  // valid availability state from the snapshot + business hours.
  // ════════════════════════════════════════════════════════════════════
  function createPresence(ctx, presenceStore, transport, transportStore, t) {
    var availability = (ctx.config && ctx.config.availability) || {};
    var liveChatEnabled = availability.liveChatEnabled !== false;
    // Phase 8 — three-mode shape from server resolver. Legacy two-mode
    // ('contact_fallback'/'accept_messages') still honored for older
    // backends until /config catches up.
    var offlineMode = (function () {
      var m = availability.offlineMode || availability.offline_mode;
      if (m === 'hide_widget' || m === 'show_offline_message' || m === 'capture_message') return m;
      if (m === 'contact_fallback') return 'capture_message';
      return 'capture_message';
    })();
    var businessHours = availability.businessHours || { enabled: false, schedule: [], timezone: 'UTC' };
    var customLabels = availability.labels || {};
    // Phase 8 — server-authoritative state. When present, runtime trusts it
    // and skips client-side hours math. Legacy clients without it fall back
    // to local hours below.
    var serverState = (availability.state === 'online' || availability.state === 'offline')
      ? availability.state : null;

    // Snapshot from /config (best-effort hint, refreshed on reconnect via REST is OUT OF SCOPE here).
    var snapshotOnlineOps = (typeof ctx.config.onlineOperators === 'number')
      ? ctx.config.onlineOperators : 0;

    // Last realtime presence signal: null = unknown, otherwise { online: bool, count: number, ts }.
    var rtPresence = null;

    // ─── Business hours check (visitor-local time, schedule:[{day:0..6, open:"HH:MM", close:"HH:MM"}]) ───
    function isWithinBusinessHours() {
      if (!businessHours || !businessHours.enabled) return true;
      var schedule = Array.isArray(businessHours.schedule) ? businessHours.schedule : [];
      if (!schedule.length) return true;
      var now = new Date();
      var day = now.getDay(); // 0=Sun..6=Sat
      var minutes = now.getHours() * 60 + now.getMinutes();
      for (var i = 0; i < schedule.length; i++) {
        var slot = schedule[i] || {};
        if (slot.day !== day) continue;
        var open = parseHM(slot.open);
        var close = parseHM(slot.close);
        if (open == null || close == null) continue;
        if (close > open && minutes >= open && minutes < close) return true;
        // Overnight slot (e.g. 22:00 → 02:00)
        if (close < open && (minutes >= open || minutes < close)) return true;
      }
      return false;
    }
    function parseHM(s) {
      if (!s || typeof s !== 'string') return null;
      var m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
      if (!m) return null;
      var h = +m[1], mn = +m[2];
      if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
      return h * 60 + mn;
    }

    function resolveStatus() {
      // 1. Master switch
      if (!liveChatEnabled) return 'unavailable';
      // 2. Phase 8 — trust server-authoritative state when provided.
      if (serverState === 'offline') return 'offline';
      if (serverState === 'online') {
        if (rtPresence) return rtPresence.online ? (rtPresence.away ? 'away' : 'online') : 'online';
        return 'online';
      }
      // 2b. Legacy fallback — client-side business hours.
      if (!isWithinBusinessHours()) return 'offline';
      // 3. Realtime signal (when supported)
      if (rtPresence) {
        if (rtPresence.online) return rtPresence.away ? 'away' : 'online';
        return 'offline';
      }
      // 4. Backend snapshot hint
      if (snapshotOnlineOps > 0) return 'online';
      // 5. Conservative default
      return 'offline';
    }

    function labelFor(status) {
      if (customLabels[status]) return String(customLabels[status]);
      if (status === 'online') return t('availOnline');
      if (status === 'away') return t('availAway');
      if (status === 'unavailable') return t('availUnavailable');
      return t('availOffline');
    }

    function publish() {
      var status = resolveStatus();
      var prev = presenceStore.get().status;
      if (prev === status) return;
      presenceStore.set({
        status: status,
        label: labelFor(status),
        offlineMode: offlineMode,
        liveChatEnabled: liveChatEnabled,
        lastChange: Date.now(),
      });
    }

    // Wire transport presence — only if the driver advertises support.
    function wire() {
      if (transport.hasCapability && transport.hasCapability('supportsPresence')) {
        transport.on('presence', function (e) {
          // Centrifugo emits { channel, join, leave }. Operators joining the
          // workspace channel = online. We treat any join as online; leave
          // without remaining joiners = offline. We do NOT track exact counts
          // here — that's a future enhancement.
          var hasJoin = !!(e && e.join);
          var hasLeave = !!(e && e.leave);
          if (!rtPresence) rtPresence = { online: false, count: 0, ts: 0 };
          if (hasJoin) { rtPresence.online = true; rtPresence.count = (rtPresence.count || 0) + 1; }
          else if (hasLeave) { rtPresence.count = Math.max(0, (rtPresence.count || 0) - 1); rtPresence.online = rtPresence.count > 0; }
          rtPresence.away = false;
          rtPresence.ts = Date.now();
          publish();
        });
      }
      // Republish on reconnect — but reconnect itself does NOT imply operator online.
      // We just re-evaluate from current inputs; rtPresence is left as-is.
      transport.on('reconnect', function () { publish(); });
      // Re-evaluate periodically so business-hours transitions take effect
      // without requiring a new transport event. Lightweight (60s tick).
      setInterval(publish, 60_000);
      // Initial publish
      publish();
    }

    return {
      wire: wire,
      publish: publish,
      isLiveChatEnabled: function () { return liveChatEnabled; },
      getOfflineMode: function () { return offlineMode; },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // UI.Chat — renders chat thread + pre-chat into shadow root.
  // Consumes: chatStore, identityStore, transportStore (read-only) + transport (actions)
  // ════════════════════════════════════════════════════════════════════
  function createChatUI(deps) {
    var ctx = deps.ctx;
    var t = deps.t;
    var chatStore = deps.chatStore;
    var identityStore = deps.identityStore;
    var transportStore = deps.transportStore;
    var transport = deps.transport;
    // Phase 6b — supplied by shell so lightbox lives in the panel's Shadow DOM
    var openImageLightbox = typeof deps.openImageLightbox === 'function'
      ? deps.openImageLightbox
      : function () {};
    // Pass 2 fix — the in-panel call surface helpers live in
    // __gs_runtime.init's closure (callSurfaceStore + subscribeToEngineOnce
    // + openCallSurface + renderBody). They were previously referenced
    // directly from handleCallInvitationClick, which is defined inside this
    // outer function and therefore had no visibility into them — causing
    // `subscribeToEngineOnce is not defined` at click time.
    //
    // We now require the shell to inject them via deps. All four are
    // defensively wrapped so a partial wiring still degrades gracefully
    // instead of throwing inside an event handler.
    var callBridge = (deps && deps.callBridge) || {};
    var subscribeToEngineOnce = typeof callBridge.subscribeToEngineOnce === 'function'
      ? callBridge.subscribeToEngineOnce
      : function () { try { console.warn('[gs-call] subscribeToEngineOnce missing — build wiring bug'); } catch (_) {} return false; };
    var openCallSurface = typeof callBridge.openCallSurface === 'function'
      ? callBridge.openCallSurface
      : function () { try { console.warn('[gs-call] openCallSurface missing'); } catch (_) {} };
    var renderBody = typeof callBridge.renderBody === 'function'
      ? callBridge.renderBody
      : function () {};

    function mergeIncoming(incoming) {
      if (!incoming || !incoming.length) return false;
      var s = chatStore.get();
      var messages = s.messages.slice();
      var seenIds = Object.assign({}, s.seenIds);
      var changed = false;

      incoming.forEach(function (m) {
        var id = m.id || (m.time + ':' + (m.text || m.body || ''));
        var senderRaw = m.role || m.sender || m.sender_type || 'agent';
        var sender = (senderRaw === 'visitor' || senderRaw === 'contact') ? 'visitor' : 'operator';
        var text = m.text || m.body || '';
        var seenAt = m.seen_at || null;

        // Phase 7 — monotonic seen merge: if we already rendered this message
        // (by canonical id), update lifecycle status forward only. Never
        // regress sent → sending or seen → sent.
        if (seenIds[id]) {
          if (sender === 'visitor' && seenAt) {
            for (var u = 0; u < messages.length; u++) {
              if (messages[u].__id === id && messages[u].status !== 'seen') {
                messages[u].status = 'seen';
                messages[u].seenAt = seenAt;
                changed = true;
                break;
              }
            }
          }
          // Phase 9 — system invitation cards mutate (pending → joined /
          // expired / cancelled / declined). When the same message id comes
          // back with a different invitation status, patch it in place so
          // the card re-renders without duplicating.
          if (senderRaw === 'system' && m.metadata && typeof m.metadata === 'object'
              && m.metadata.kind === 'call_invitation') {
            for (var sm = 0; sm < messages.length; sm++) {
              if (messages[sm].__id === id) {
                var prevMeta = messages[sm].metadata || {};
                if (!prevMeta || prevMeta.status !== m.metadata.status
                    || prevMeta.expires_at !== m.metadata.expires_at) {
                  messages[sm].metadata = m.metadata;
                  changed = true;
                }
                break;
              }
            }
          }
          return;
        }
        seenIds[id] = true;

        if (sender === 'visitor') {
          // Reconcile with optimistic bubble. Two cases:
          //   (a) onAccepted already bound the canonical id → match by __id.
          //   (b) realtime/poll arrived before onAccepted → match by text on
          //       the most recent visitor bubble that is still in 'sending'
          //       and has no __id yet.
          // Without (a), the optimistic bubble would never be found again
          // (its __id is set) and the message would be pushed a second time.
          var dupIdx = -1;
          for (var d = messages.length - 1; d >= 0; d--) {
            if (messages[d].sender !== 'visitor') continue;
            if (messages[d].__id === id) { dupIdx = d; break; }
            if (!messages[d].__id && messages[d].body === text) { dupIdx = d; break; }
          }
          if (dupIdx >= 0) {
            messages[dupIdx].__id = id;
            // Lifecycle: optimistic 'sending'/'sent' is at least 'sent' once
            // backend echoes it back; promote to 'seen' only if backend says so.
            var prev = messages[dupIdx].status;
            if (seenAt) {
              messages[dupIdx].status = 'seen';
              messages[dupIdx].seenAt = seenAt;
            } else if (prev !== 'seen') {
              messages[dupIdx].status = 'sent';
            }
            changed = true;
            return;
          }
        }

        messages.push({
          body: text,
          sender: sender,
          time: m.time ? new Date(m.time) : new Date(),
          __id: id,
          attachment: m.attachment || null,
          // Operator identity surfaced by /poll and /history. Used by the
          // chat renderer to draw a small avatar next to each agent bubble
          // (Intercom-style). Null on visitor / system / AI messages with no
          // resolvable profile.
          senderName: m.sender_name || null,
          senderAvatar: m.sender_avatar || null,
          // Phase 7 — lifecycle (visitor messages only have a meaningful status).
          status: sender === 'visitor' ? (seenAt ? 'seen' : 'sent') : null,
          seenAt: sender === 'visitor' ? seenAt : null,
          // Phase 9 — system messages may carry a metadata payload (e.g.
          // { kind: 'call_invitation', invitation_id, channel, status,
          // expires_at }). Plain chat bubbles ignore this; the renderer
          // detects the kind and draws an interactive card instead.
          senderType: senderRaw,
          metadata: (m.metadata && typeof m.metadata === 'object') ? m.metadata : null,
        });
        changed = true;
      });

      if (changed) chatStore.set({ messages: messages, seenIds: seenIds });
      return changed;
    }

    function renderEmpty(body) {
      // Server-authoritative welcome message (workspace override → platform default).
      // Rendered as a real operator bubble — same look & feel as a live operator
      // reply — so the visitor immediately sees the conversation has "started".
      // Falls back to the i18n `intro` string only if backend sent nothing.
      // Phase 4 — when AI Agent is enabled in an auto-reply mode AND the
      // pre-chat AI intro is enabled, the AI intro IS the first assistant
      // message. Skip the generic greeting entirely so we don't show two.
      var ai = ctx.config && ctx.config.aiAgent;
      if (ai && ai.suppressGreeting === true) {
        try { console.debug('[Widget AI Agent] generic greeting suppressed'); } catch (_) {}
        body.innerHTML = '<div class="messages welcome-only"></div>';
        return;
      }
      var welcome = (ctx.config && typeof ctx.config.welcomeMessage === 'string' && ctx.config.welcomeMessage.trim().length > 0)
        ? ctx.config.welcomeMessage
        : t('intro');
      var lines = String(welcome).split(/\n+/).map(function (l) {
        return Util.escapeHtml(l);
      }).join('<br>');
      body.innerHTML =
        '<div class="messages welcome-only">' +
          '<div class="msg-row operator">' +
            (function () {
              var logo = ctx.config && ctx.config.logoUrl;
              if (logo) {
                return '<span class="msg-avatar has-img"><img src="' + Util.escapeHtml(logo) + '" alt="" loading="lazy" decoding="async" /></span>';
              }
              var initial = ((ctx.config && ctx.config.brandName ? ctx.config.brandName : 'S').trim().charAt(0) || 'S').toUpperCase();
              return '<span class="msg-avatar" aria-hidden="true">' + Util.escapeHtml(initial) + '</span>';
            })() +
            '<div class="msg operator welcome-bubble">' + lines + '</div>' +
          '</div>' +
        '</div>';
      body.scrollTop = body.scrollHeight;
    }

    // ─── Phase 6b — attachment renderer (provider-safe) ───
    // Always loads files via the backend proxy route /api/widget/attachments/:id.
    // We never inline file bytes, never expose provider URLs, never embed
    // arbitrary uploaded HTML/SVG. Only the safe metadata is used here.
    function humanSize(bytes) {
      var n = Number(bytes) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
      return (n / (1024 * 1024)).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    }
    function attachmentProxyUrl(id) {
      var apiBase = ctx.config.apiBase || '';
      return apiBase + '/api/widget/attachments/' + encodeURIComponent(id);
    }
    function renderMessageAttachment(att) {
      if (!att || !att.id) return '';
      var url = attachmentProxyUrl(att.id);
      var name = Util.escapeHtml(att.file_name || 'file');
      var size = humanSize(att.size_bytes);
      var isImage = att.kind === 'image' || (att.mime_type && /^image\//.test(att.mime_type));
      if (isImage) {
        return '<div class="msg-att msg-att-image">' +
          '<button type="button" class="msg-att-img-btn" data-att-preview="' + Util.escapeHtml(att.id) + '" aria-label="' + Util.escapeHtml(t('openFile')) + '">' +
            '<img loading="lazy" decoding="async" src="' + Util.escapeHtml(url) + '" alt="' + name + '" />' +
            '<span class="msg-att-img-fallback">' + Util.escapeHtml(t('imageUnavailable')) + '</span>' +
          '</button>' +
          '</div>';
      }
      var iconSvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
      return '<div class="msg-att msg-att-file">' +
        '<div class="msg-att-icon">' + iconSvg + '</div>' +
        '<div class="msg-att-meta">' +
          '<div class="msg-att-name" title="' + name + '">' + name + '</div>' +
          '<div class="msg-att-sub">' + Util.escapeHtml(size) + '</div>' +
        '</div>' +
        '<a class="msg-att-action" href="' + Util.escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" download="' + name + '" aria-label="' + Util.escapeHtml(t('download')) + '">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v12m0 0l-4-4m4 4l4-4"/><path d="M5 20h14"/></svg>' +
        '</a>' +
        '</div>';
    }

    // ─── Phase 9 — Call invitation card renderer ───
    // System messages with metadata.kind === 'call_invitation' are rendered
    // as an interactive card. The persisted system message is the canonical
    // source; this is purely presentation. Click handlers are wired via
    // event delegation in renderChat() below, so re-renders never leak
    // listeners.
    function fmtInvitationRemaining(expiresAtIso) {
      var ms = new Date(expiresAtIso).getTime() - Date.now();
      if (!isFinite(ms) || ms <= 0) return t('ciStateExpired') || 'Expired';
      var total = Math.ceil(ms / 1000);
      var timeStr;
      if (total < 60) {
        timeStr = (t('ciSeconds') || '{s}s').replace('{s}', String(total));
      } else {
        var m = Math.floor(total / 60);
        var s = total % 60;
        if (s === 0) timeStr = (t('ciMinutes') || '{m}m').replace('{m}', String(m));
        else timeStr = (t('ciMinutesSeconds') || '{m}m {s}s').replace('{m}', String(m)).replace('{s}', String(s));
      }
      return (t('ciTimeLeft') || '{time} left').replace('{time}', timeStr);
    }

    // Pass A — Format duration_seconds as mm:ss / hh:mm:ss.
    function fmtCallDuration(seconds) {
      var s = Math.max(0, Math.floor(Number(seconds) || 0));
      var hh = Math.floor(s / 3600);
      var mm = Math.floor((s % 3600) / 60);
      var ss = s % 60;
      function pad(n) { return n < 10 ? '0' + n : '' + n; }
      return hh > 0 ? pad(hh) + ':' + pad(mm) + ':' + pad(ss) : pad(mm) + ':' + pad(ss);
    }

    // Pass A — Render the system "call ended" summary row in chat.
    function renderCallEndedRow(msg) {
      var meta = msg.metadata || {};
      var endedBy = String(meta.ended_by || 'system');
      var endReason = String(meta.end_reason || '');
      var dur = Number(meta.duration_seconds) || 0;
      var isMissed = endReason === 'failed' || dur <= 0;
      var key;
      if (isMissed) {
        key = 'csEndedNotConnected';
      } else if (endedBy === 'operator') {
        key = 'csEndedByOperator';
      } else if (endedBy === 'visitor') {
        key = 'csEndedByVisitor';
      } else {
        key = 'csEndedBySystem';
      }
      var fallback;
      if (isMissed) {
        fallback = 'Call did not connect';
      } else if (endedBy === 'operator') {
        fallback = 'Call ended by operator · Duration ' + fmtCallDuration(dur);
      } else if (endedBy === 'visitor') {
        fallback = 'Call ended by visitor · Duration ' + fmtCallDuration(dur);
      } else {
        fallback = 'Call ended · Duration ' + fmtCallDuration(dur);
      }
      var raw = t(key);
      var text = (raw && raw !== key)
        ? String(raw).replace('{duration}', fmtCallDuration(dur))
        : fallback;
      var icon = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 8.63 18.5"/>'
        + '<line x1="23" y1="1" x2="1" y2="23"/></svg>';
      return '<div class="msg-row system"><div class="msg-system-pill">'
        + icon + '<span>' + Util.escapeHtml(text) + '</span>'
        + '</div></div>';
    }

    function renderCallInvitationCard(msg) {
      var meta = msg.metadata || {};
      var channel = meta.channel === 'video' ? 'video' : 'audio';
      var status = meta.status || 'pending';
      var inviteId = Util.escapeHtml(meta.invitation_id || '');
      var op = meta.operator_name ? Util.escapeHtml(meta.operator_name) : '';
      var headlineKey = channel === 'video'
        ? (op ? 'ciHeadlineVideoFrom' : 'ciHeadlineVideo')
        : (op ? 'ciHeadlineAudioFrom' : 'ciHeadlineAudio');
      var headlineTpl = t(headlineKey) || (channel === 'video' ? 'You have been invited to a video call' : 'You have been invited to an audio call');
      var headline = op ? headlineTpl.replace('{op}', op) : headlineTpl;
      var iconSvg = channel === 'video'
        ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>';

      var statusBlock = '';
      var actionBlock = '';
      var bodyBlock = '';
      var stateLabel = '';
      if (status === 'pending') {
        // Body line: "An operator is inviting you to a voice call."
        // + "The operator will wait up to X minutes for you to join."
        var bodyKey = channel === 'video' ? 'ciBodyVideo' : 'ciBodyAudio';
        var bodyText = t(bodyKey) || (channel === 'video'
          ? 'An operator is inviting you to a video call.'
          : 'An operator is inviting you to a voice call.');
        var waitMinutes = (typeof meta.wait_minutes === 'number' && isFinite(meta.wait_minutes) && meta.wait_minutes > 0)
          ? Math.round(meta.wait_minutes)
          : 0;
        // Fallback: derive from expires_at if server didn't provide wait_minutes.
        if (!waitMinutes && meta.expires_at) {
          var deltaMs = new Date(meta.expires_at).getTime() - new Date(msg.createdAt || Date.now()).getTime();
          if (isFinite(deltaMs) && deltaMs > 0) {
            waitMinutes = Math.max(1, Math.round(deltaMs / 60000));
          }
        }
        var waitLine = '';
        if (waitMinutes === 1) {
          waitLine = t('ciWaitOneMinute') || 'The operator will wait up to one minute for you to join.';
        } else if (waitMinutes > 1) {
          waitLine = (t('ciWaitMinutes') || 'The operator will wait up to {m} minutes for you to join.')
            .replace('{m}', String(waitMinutes));
        }
        bodyBlock = '<div class="ci-body">' +
          '<div>' + Util.escapeHtml(bodyText) + '</div>' +
          (waitLine ? '<div class="ci-wait">' + Util.escapeHtml(waitLine) + '</div>' : '') +
        '</div>';

        var rem = Util.escapeHtml(fmtInvitationRemaining(meta.expires_at));
        statusBlock = '<div class="ci-meta ci-countdown" aria-live="polite">' +
          '<span class="ci-pulse" aria-hidden="true"></span>' + rem +
        '</div>';
        var joinLabel = channel === 'video'
          ? (t('ciJoinVideo') || 'Join video call')
          : (t('ciJoinAudio') || 'Join call');
        var joinAria = channel === 'video'
          ? (t('ciAriaJoinVideo') || 'Join the video call now')
          : (t('ciAriaJoinAudio') || 'Join the audio call now');
        var declineLabel = t('ciDecline') || 'Decline';
        var declineAria = t('ciAriaDecline') || 'Decline this call invitation';
        actionBlock = '<div class="ci-actions">' +
          '<button type="button" class="ci-btn ci-btn-primary" data-ci-action="join" data-ci-id="' + inviteId +
            '" data-ci-channel="' + channel + '" aria-label="' + Util.escapeHtml(joinAria) + '">' +
            Util.escapeHtml(joinLabel) +
          '</button>' +
          '<button type="button" class="ci-btn ci-btn-ghost" data-ci-action="decline" data-ci-id="' + inviteId +
            '" aria-label="' + Util.escapeHtml(declineAria) + '">' +
            Util.escapeHtml(declineLabel) +
          '</button>' +
        '</div>';
      } else {
        if (status === 'joined') stateLabel = t('ciStateJoined') || 'You joined the call';
        else if (status === 'expired') stateLabel = t('ciStateExpired') || 'Invitation expired';
        else if (status === 'cancelled') stateLabel = t('ciStateCancelled') || 'Operator cancelled the invitation';
        else if (status === 'declined') stateLabel = t('ciStateDeclined') || 'You declined this call';
        statusBlock = '<div class="ci-meta ci-status ci-status-' + Util.escapeHtml(status) + '">' + Util.escapeHtml(stateLabel) + '</div>';
      }

      var ariaCard = (t('ciAriaCard') || 'Call invitation') + ' — ' +
        (channel === 'video' ? (t('videoCall') || 'Video') : (t('voiceCall') || 'Voice'));
      return '<div class="msg-row system">' +
        '<div class="ci-card ci-channel-' + channel + ' ci-status-' + Util.escapeHtml(status) +
          '" data-ci-card="' + inviteId + '" role="group" aria-label="' + Util.escapeHtml(ariaCard) + '">' +
          '<div class="ci-row">' +
            '<span class="ci-icon" aria-hidden="true">' + iconSvg + '</span>' +
            '<div class="ci-text">' +
              '<div class="ci-title">' + Util.escapeHtml(headline) + '</div>' +
              bodyBlock +
              statusBlock +
            '</div>' +
          '</div>' +
          actionBlock +
        '</div>' +
      '</div>';
    }

    function callInvitationContext() {
      try {
        var apiBase = ctx && ctx.apiBase ? ctx.apiBase : '';
        var workspaceId = ctx && ctx.workspaceId ? ctx.workspaceId : '';
        var token = (window.__gs_token && window.__gs_token.get && window.__gs_token.get()) || '';
        var ident = window.__gs_identity || {};
        return {
          apiBase: apiBase,
          workspaceId: workspaceId,
          token: token,
          visitorId: ident.visitorId || null,
          sessionId: ident.sessionId || null,
        };
      } catch (_) {
        return { apiBase: '', workspaceId: '', token: '', visitorId: null, sessionId: null };
      }
    }

    function postCallInvitationAction(invitationId, action) {
      var c = callInvitationContext();
      if (!c.apiBase || !c.workspaceId || !c.token) {
        return Promise.reject(new Error('widget context not ready'));
      }
      return fetch(c.apiBase + '/api/widget/call-invitations/' + encodeURIComponent(invitationId) + '/' + action, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Widget-Token': c.token },
        body: JSON.stringify({
          workspace_id: c.workspaceId,
          visitor_id: c.visitorId || undefined,
          session_id: c.sessionId || undefined,
        }),
      }).then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; })
          .then(function (b) { throw new Error(b.error || 'http_' + r.status); });
        return r.json();
      });
    }

    // Local optimistic patch: swap the in-memory metadata for an invitation
    // card so the UI reflects state instantly. The next /poll tick will
    // confirm with the server-canonical metadata.
    function patchInvitationStatusLocally(invitationId, status) {
      var s = chatStore.get();
      var arr = s.messages.slice();
      var changed = false;
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        if (m.senderType === 'system' && m.metadata && m.metadata.kind === 'call_invitation'
            && m.metadata.invitation_id === invitationId) {
          arr[i] = Object.assign({}, m, {
            metadata: Object.assign({}, m.metadata, { status: status }),
          });
          changed = true;
        }
      }
      if (changed) chatStore.set({ messages: arr });
    }

    function handleCallInvitationClick(ev) {
      ev.preventDefault();
      var btn = ev.currentTarget;
      if (!btn || btn.disabled) return;
      var action = btn.getAttribute('data-ci-action');
      var invitationId = btn.getAttribute('data-ci-id');
      if (!action || !invitationId) return;

      btn.disabled = true;
      var prevText = btn.textContent;
      btn.textContent = action === 'join'
        ? (t('ciJoining') || 'Joining…')
        : (t('ciDeclining') || 'Declining…');
      btn.setAttribute('aria-busy', 'true');
      // Either action ends the "ringing" phase from the visitor's POV.
      try {
        if (deps.callBridge && typeof deps.callBridge.stopRingtone === 'function') {
          deps.callBridge.stopRingtone();
        }
      } catch (_) {}

      if (action === 'decline') {
        postCallInvitationAction(invitationId, 'decline')
          .then(function () {
            patchInvitationStatusLocally(invitationId, 'declined');
          })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = prevText;
            btn.removeAttribute('aria-busy');
            try { console.warn('[gs-call] decline failed:', err && err.message); } catch (_) {}
          });
        return;
      }

      // Join — reuse the existing runtime-call accept/connect path.
      var channel = btn.getAttribute('data-ci-channel') === 'video' ? 'video' : 'audio';
      // Phase 9 hardening — the call runtime is loaded asynchronously
      // alongside the chat runtime (see loader.js). Visitors who click
      // Join very fast (or whose network slowed the runtime-call.js
      // request) used to hit `call_runtime_unavailable` because we
      // checked the global synchronously. We now:
      //   1. Show a real "Opening call…" state on the button.
      //   2. Await loader's readiness promise (or lazy-inject if missing).
      //   3. Only call the join API once the runtime is actually ready.
      //   4. Surface a real error if the runtime never becomes available.
      btn.textContent = (t('ciOpeningCall') || 'Opening call…');
      ensureCallRuntimeReady(8000)
        .then(function () {
          return postCallInvitationAction(invitationId, 'join');
        })
        .then(function (bundle) {
          // Pass 2 — drive the headless engine directly. No popup, no
          // legacy `incoming(...)` shim. The in-panel call surface
          // (renderCallSurface) is wired up via callSurfaceStore.
          var engine = window.__gs_call && window.__gs_call.engine;
          if (!engine || typeof engine.connect !== 'function') {
            throw new Error('call_runtime_unavailable');
          }
          subscribeToEngineOnce();
          openCallSurface({
            invitationId: invitationId,
            callId: bundle.call_id,
            channel: bundle.call_type || channel,
          });
          patchInvitationStatusLocally(invitationId, 'joined');
          renderBody();
          return engine.connect({
            wsUrl: bundle.ws_url,
            token: bundle.token,
            turn: bundle.turn || { urls: [] },
            ice_policy: bundle.ice_policy || 'all',
            publishMic: true,
            publishCamera: (bundle.call_type || channel) === 'video',
            videoQuality: window.__gs_call_video_quality || (bundle && bundle.video_quality) || 'auto',
          });
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = prevText;
          btn.removeAttribute('aria-busy');
          var msg = (err && err.message) || 'unknown';
          try { console.warn('[gs-call] join failed:', msg); } catch (_) {}
          // Surface a visible message under the card so the visitor isn't
          // left wondering. Reuses the existing card so we don't introduce
          // a new toast surface.
          showCallInvitationError(invitationId, msg);
        });
    }

    /**
     * Resolve when window.__gs_call.incoming is callable. Strategy:
     *   1. If already present → immediate.
     *   2. Else await loader's readiness promise (set when loader injects
     *      runtime-call.js).
     *   3. If neither exists, lazy-inject the script ourselves using the
     *      asset base hint loader exposed via window.__gs_call_url.
     *   4. Bound by a hard timeout so the visitor never hangs forever.
     */
    function ensureCallRuntimeReady(timeoutMs) {
      if (window.__gs_call && typeof window.__gs_call.incoming === 'function') {
        return Promise.resolve();
      }
      var ready = window.__gs_call_ready;
      if (!ready) {
        // Lazy-inject if loader never queued it (e.g. asset base unknown
        // until config landed). Best-effort — failure rejects the promise.
        ready = new Promise(function (resolve, reject) {
          var url = (window.__gs_call_config && window.__gs_call_config.url) || window.__gs_call_url;
          if (!url) {
            // Derive from current runtime script tag if loader didn't
            // expose it. The selector matches both unhashed
            // (`/widget/runtime.js`) and hashed (`/widget/runtime-abc.js`
            // or `/widget/runtime.abc.js`) filenames so production
            // CDN-hashed builds resolve correctly.
            try {
              var rs = document.querySelector('script[data-gs-runtime]')
                    || document.querySelector('script[src*="/widget/runtime"][src$=".js"]')
                    || document.querySelector('script[src*="/widget/runtime.js"]');
              if (rs && rs.src) url = rs.src.replace(/runtime(?:[.-][A-Za-z0-9]+)?\.js(?:\?[^#]*)?(?:#.*)?$/, 'runtime-call.js');
            } catch (_) { /* noop */ }
          }
          if (!url) {
            try { console.warn('[gs-call] runtime URL unknown — missing config.callRuntimeUrl/window.__gs_call_url and runtime <script> tag fallback failed'); } catch (_) {}
            return reject(new Error('call_runtime_url_unknown'));
          }
          // Cache so subsequent re-tries don't re-derive.
          window.__gs_call_url = url;
          window.__gs_call_config = window.__gs_call_config || {};
          window.__gs_call_config.url = url;
          var existing = document.querySelector('script[data-gs-runtime-call]');
          if (existing) {
            // Already injected; just poll.
            var t0 = Date.now();
            var iv = setInterval(function () {
              if (window.__gs_call && typeof window.__gs_call.incoming === 'function') {
                clearInterval(iv); resolve();
              } else if (Date.now() - t0 > (timeoutMs || 8000)) {
                clearInterval(iv); reject(new Error('call_runtime_timeout'));
              }
            }, 100);
            return;
          }
          var s = document.createElement('script');
          s.src = url;
          s.async = true;
          s.setAttribute('data-gs-runtime-call', 'true');
          s.onload = function () {
            if (window.__gs_call && typeof window.__gs_call.incoming === 'function') resolve();
            else reject(new Error('call_runtime_loaded_but_missing_api'));
          };
          s.onerror = function () { reject(new Error('call_runtime_load_failed')); };
          document.head.appendChild(s);
        });
        window.__gs_call_ready = ready;
      }
      // Wrap in a hard timeout so a stuck network never freezes the UI.
      return new Promise(function (resolve, reject) {
        var done = false;
        var to = setTimeout(function () {
          if (done) return;
          done = true;
          reject(new Error('call_runtime_timeout'));
        }, timeoutMs || 8000);
        ready.then(function (v) {
          if (done) return; done = true; clearTimeout(to); resolve(v);
        }).catch(function (err) {
          if (done) return; done = true; clearTimeout(to); reject(err);
        });
      });
    }

    /**
     * Render a small inline error row beneath an invitation card so the
     * visitor sees a real failure reason instead of a silently re-enabled
     * button. Idempotent — replaces previous error for the same card.
     */
    function showCallInvitationError(invitationId, message) {
      try {
        var card = document.querySelector('[data-ci-card="' + invitationId + '"]');
        if (!card) return;
        var prev = card.querySelector('.ci-err');
        if (prev) prev.remove();
        var div = document.createElement('div');
        div.className = 'ci-err';
        div.setAttribute('role', 'alert');
        var label;
        if (message === 'call_runtime_timeout' || message === 'call_runtime_load_failed' || message === 'call_runtime_loaded_but_missing_api' || message === 'call_runtime_unavailable') {
          label = (t('ciErrCallRuntime') || 'Call service is starting. Please tap Join again.');
        } else {
          label = (t('ciErrJoin') || 'Could not join the call. Please try again.');
        }
        div.textContent = label;
        card.appendChild(div);
      } catch (_) { /* noop */ }
    }

    function renderChat(body) {
      var s = chatStore.get();
      if (!s.messages.length) { renderEmpty(body); return; }
      // Phase 7 — read-receipts toggle (admin-controlled, surfaced via /config).
      var rrCfg = ctx.config && ctx.config.readReceipts;
      var receiptsEnabled = !rrCfg || rrCfg.enabled !== false;
      // Find last visitor message — only it shows the lifecycle indicator
      // (chat-app convention; reduces visual noise).
      var lastVisitorIdx = -1;
      for (var lv = s.messages.length - 1; lv >= 0; lv--) {
        if (s.messages[lv].sender === 'visitor') { lastVisitorIdx = lv; break; }
      }
      var html = '<div class="messages">';
      // Group consecutive operator messages so we only show the avatar on the
      // last bubble of a streak (Intercom/Zendesk convention). Otherwise a
      // long agent reply produces a wall of repeated avatars.
      var groupKeys = s.messages.map(function (m) {
        return m.sender === 'visitor' ? 'v' : ('op:' + (m.senderName || '') + '|' + (m.senderAvatar || ''));
      });
      s.messages.forEach(function (m, idx) {
        // Phase 9 — Call invitation card. System messages with
        // metadata.kind === 'call_invitation' render as an interactive
        // card (Join / state) instead of a normal chat bubble.
        if (m.senderType === 'system' && m.metadata && m.metadata.kind === 'call_invitation') {
          html += renderCallInvitationCard(m);
          return;
        }
        // Pass A — Call-ended summary. System message with
        // metadata.kind === 'call_ended' renders as a centered system row
        // ("Call ended by operator · Duration 00:34"). Localized.
        if (m.senderType === 'system' && m.metadata && m.metadata.kind === 'call_ended') {
          html += renderCallEndedRow(m);
          return;
        }
        var bg = m.sender === 'visitor' ? 'style="background:' + ctx.primaryColor + '"' : '';
        var cls = m.sender === 'visitor' ? 'visitor' : 'operator';
        var isAi = m.senderType === 'ai';
        var aiBadgeHtml = isAi
          ? '<span class="msg-ai-badge" aria-label="AI assistant" title="AI assistant">AI</span>'
          : '';
        var hasText = m.body && String(m.body).trim().length > 0;
        var attHtml = renderMessageAttachment(m.attachment);
        var extraCls = (attHtml && !hasText) ? ' has-att-only' : (attHtml ? ' has-att' : '');
        // Phase 7 — lifecycle row (sending/sent/seen/failed). Only on the last
        // visitor message, only when read receipts are enabled in config.
        var statusHtml = '';
        if (m.sender === 'visitor' && idx === lastVisitorIdx && receiptsEnabled && m.status) {
          var label, icon;
          if (m.status === 'sending') {
            label = t('msgSending'); icon = '<span class="msg-status-spinner"></span>';
          } else if (m.status === 'failed') {
            label = t('msgFailed'); icon = '<span class="msg-status-icon">!</span>';
          } else if (m.status === 'seen') {
            label = t('msgSeen'); icon = '<span class="msg-status-icon seen">✓✓</span>';
          } else { // 'sent'
            label = t('msgSent'); icon = '<span class="msg-status-icon">✓</span>';
          }
          statusHtml = '<div class="msg-status status-' + m.status + '">' + icon +
            '<span class="msg-status-label">' + Util.escapeHtml(label) + '</span></div>';
        }

        // Avatar slot: only shown on the LAST bubble of an operator streak,
        // so the visitor sees one face per message group. Visitor messages
        // have no avatar slot (their bubbles are right-aligned).
        var avatarHtml = '';
        if (cls === 'operator') {
          var isLastInStreak = idx === s.messages.length - 1 || groupKeys[idx + 1] !== groupKeys[idx];
          if (isLastInStreak) {
            if (m.senderAvatar) {
              avatarHtml = '<span class="msg-avatar has-img">' +
                '<img src="' + Util.escapeHtml(m.senderAvatar) + '" alt="' + Util.escapeHtml(m.senderName || t('operator')) + '" loading="lazy" decoding="async" />' +
              '</span>';
            } else {
              var initial = ((m.senderName || ctx.config.brandName || 'S').trim().charAt(0) || 'S').toUpperCase();
              avatarHtml = '<span class="msg-avatar" aria-hidden="true">' + Util.escapeHtml(initial) + '</span>';
            }
          } else {
            avatarHtml = '<span class="msg-avatar msg-avatar-spacer" aria-hidden="true"></span>';
          }
        }

        html += '<div class="msg-row ' + cls + '">' +
          avatarHtml +
          '<div class="msg ' + cls + extraCls + (isAi ? ' is-ai' : '') + '" ' + bg + '>' +
            aiBadgeHtml +
            (hasText ? Util.escapeHtml(m.body) : '') + attHtml +
          '</div>' +
          statusHtml +
          '</div>';
      });
      html += '</div>';
      body.innerHTML = html;
      // Wire up image preview triggers (lightbox) — Shadow-DOM scoped.
      var triggers = body.querySelectorAll('[data-att-preview]');
      for (var i = 0; i < triggers.length; i++) {
        triggers[i].addEventListener('click', function (e) {
          var id = this.getAttribute('data-att-preview');
          if (id) openImageLightbox(id);
        });
      }
      // Phase 9 — Call invitation card actions (Join / Decline). Re-bound
      // on every render; safe because each render replaces innerHTML.
      var ciButtons = body.querySelectorAll('[data-ci-action]');
      for (var ci = 0; ci < ciButtons.length; ci++) {
        ciButtons[ci].addEventListener('click', handleCallInvitationClick);
      }
      // Image load failure: swap in fallback label without breaking layout.
      var imgs = body.querySelectorAll('.msg-att-image img');
      for (var j = 0; j < imgs.length; j++) {
        imgs[j].addEventListener('error', function () {
          var btn = this.closest('.msg-att-img-btn');
          if (btn) btn.classList.add('failed');
        });
      }
      body.scrollTop = body.scrollHeight;
    }

    function renderPreChat(body, identity, locale, onSubmitted) {
      var contact = (identityStore.get().contact) || {};
      var ICONS = {
        name: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
        phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
        lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
      };

      function fieldRow(key, type, value) {
        var label = t(key);
        var ph = t('prechat' + key.charAt(0).toUpperCase() + key.slice(1) + 'Ph') || label;
        var req = identity.isRequired(key);
        // Inline "required" marker — single red asterisk next to the label,
        // matching native form conventions. Optional fields show nothing.
        var badge = req
          ? '<span class="prechat-req-mark" aria-label="' + Util.escapeHtml(t('required')) + '" title="' + Util.escapeHtml(t('required')) + '">*</span>'
          : '';
        var ac = key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel';
        var inputDir = key === 'email' || key === 'phone' ? 'ltr' : '';
        return '<div class="prechat-field" data-field="' + key + '">' +
            '<div class="prechat-row">' +
              '<label class="prechat-label" for="prechat-' + key + '">' +
                Util.escapeHtml(label) + badge +
              '</label>' +
            '</div>' +
            '<div class="prechat-control">' +
              '<span class="prechat-icon" aria-hidden="true">' + ICONS[key] + '</span>' +
              '<input id="prechat-' + key + '" class="prechat-input" data-prechat="' + key + '" type="' + type +
                '" autocomplete="' + ac + '"' +
                (inputDir ? ' dir="' + inputDir + '"' : '') +
                ' placeholder="' + Util.escapeHtml(ph) + '"' +
                ' value="' + Util.escapeHtml(value || '') + '" />' +
              '<span class="prechat-status" aria-hidden="true"></span>' +
            '</div>' +
            '<div class="prechat-error" data-err="' + key + '"></div>' +
          '</div>';
      }

      var fieldsHtml = '';
      if (identity.isAsked('name')) fieldsHtml += fieldRow('name', 'text', contact.name);
      if (identity.isAsked('email')) fieldsHtml += fieldRow('email', 'email', contact.email);
      if (identity.isAsked('phone')) fieldsHtml += fieldRow('phone', 'tel', contact.phone);

      var dir = locale === 'fa' ? 'rtl' : 'ltr';
      body.innerHTML =
        '<div class="prechat prechat-pro" dir="' + dir + '">' +
          '<div class="prechat-hero">' +
            '<h3 class="prechat-title">' + Util.escapeHtml(t('prechatTitle')) + '</h3>' +
            '<p class="prechat-subtitle">' + Util.escapeHtml(t('prechatSubtitle')) + '</p>' +
          '</div>' +
          '<div class="prechat-fields">' + fieldsHtml + '</div>' +
          '<button type="button" class="prechat-submit" data-prechat-submit>' +
            '<span class="prechat-submit-label">' + Util.escapeHtml(t('continue')) + '</span>' +
            '<span class="prechat-submit-arrow" aria-hidden="true">' +
              (dir === 'rtl'
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>') +
            '</span>' +
          '</button>' +
          '<p class="prechat-privacy">' +
            '<span class="prechat-privacy-icon" aria-hidden="true">' + ICONS.lock + '</span>' +
            Util.escapeHtml(t('prechatPrivacy')) +
          '</p>' +
        '</div>';

      function getInput(key) { return body.querySelector('[data-prechat="' + key + '"]'); }
      function clearError(key) {
        var el = body.querySelector('[data-err="' + key + '"]');
        if (el) { el.classList.remove('visible'); el.textContent = ''; }
        var f = body.querySelector('[data-field="' + key + '"]');
        if (f) f.classList.remove('has-error');
      }
      function showError(key, msg) {
        var el = body.querySelector('[data-err="' + key + '"]');
        if (el) { el.textContent = msg; el.classList.add('visible'); }
        var f = body.querySelector('[data-field="' + key + '"]');
        if (f) f.classList.add('has-error');
        var input = getInput(key);
        if (input) try { input.focus(); } catch (_) {}
      }
      function markValid(key, valid) {
        var f = body.querySelector('[data-field="' + key + '"]');
        if (!f) return;
        if (valid) f.classList.add('is-valid'); else f.classList.remove('is-valid');
      }
      function liveValidate(k, val) {
        var v = (val || '').trim();
        if (!v) { markValid(k, false); return; }
        if (k === 'email') markValid(k, Util.isValidEmail(v));
        else if (k === 'phone') markValid(k, Util.isValidPhone(v));
        else markValid(k, v.length >= 2);
      }
      ['name', 'email', 'phone'].forEach(function (k) {
        var input = getInput(k);
        if (!input) return;
        liveValidate(k, input.value);
        input.addEventListener('input', function () {
          clearError(k);
          liveValidate(k, input.value);
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            var btn = body.querySelector('[data-prechat-submit]');
            if (btn) btn.click();
          }
        });
      });
      var firstInput = body.querySelector('.prechat-input');
      if (firstInput) try { firstInput.focus({ preventScroll: true }); } catch (_) {}

      var submitBtn = body.querySelector('[data-prechat-submit]');
      if (submitBtn) {
        submitBtn.addEventListener('click', function () {
          var payload = {
            name: getInput('name') ? getInput('name').value.trim() : '',
            email: getInput('email') ? getInput('email').value.trim() : '',
            phone: getInput('phone') ? getInput('phone').value.trim() : '',
          };
          var ok = true;
          if (identity.isRequired('name') && !payload.name) { showError('name', t('required')); ok = false; }
          if (identity.isAsked('email') && payload.email) {
            if (!Util.isValidEmail(payload.email)) { showError('email', t('invalidEmail')); ok = false; }
          } else if (identity.isRequired('email') && !payload.email) { showError('email', t('required')); ok = false; }
          if (identity.isAsked('phone') && payload.phone) {
            if (!Util.isValidPhone(payload.phone)) { showError('phone', t('invalidPhone')); ok = false; }
          } else if (identity.isRequired('phone') && !payload.phone) { showError('phone', t('required')); ok = false; }
          if (!ok) return;

          submitBtn.disabled = true;
          submitBtn.style.opacity = '0.6';
          identity.submitPrechat(payload, function (success, resp) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
            if (!success) {
              var f = resp && resp.field;
              if (f) showError(f, t('required'));
              return;
            }
            if (typeof onSubmitted === 'function') onSubmitted();
          });
        });
      }
    }

    function sendMessage(text, onChange, attachmentId, optimisticAttachment) {
      var conn = transportStore.get().connectionState;
      if (conn !== 'online') return;
      var s = chatStore.get();
      var messages = s.messages.slice();
      // Phase 7 — optimistic local id used to find this bubble later when
      // the backend confirms (sending → sent) or rejects (→ failed).
      var localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      messages.push({
        body: text,
        sender: 'visitor',
        time: new Date(),
        attachmentId: attachmentId || null,
        attachment: optimisticAttachment || null,
        // Phase 7 — lifecycle starts as 'sending'. Transitions only on
        // honest backend signals (onAccepted → 'sent', onError → 'failed',
        // poll/history echo with seen_at → 'seen'). Never faked.
        status: 'sending',
        localId: localId,
      });
      chatStore.set({ messages: messages });
      onChange();

      function updateByLocalId(patch) {
        var cs = chatStore.get();
        var arr = cs.messages.slice();
        for (var i = 0; i < arr.length; i++) {
          if (arr[i].localId === localId) {
            // Monotonic guard: never regress past 'seen'.
            if (arr[i].status === 'seen') return;
            arr[i] = Object.assign({}, arr[i], patch);
            chatStore.set({ messages: arr });
            onChange();
            return;
          }
        }
      }

      transport.sendMessage(
        {
          text: text,
          conversationId: s.conversationId,
          attachmentId: attachmentId || null,
          departmentId: (function () {
            try {
              var d = (typeof window !== 'undefined') ? window.__gs_departments : null;
              return d && d.getSelectedId ? d.getSelectedId() : null;
            } catch (_) { return null; }
          })(),
        },
        {
          onConversation: function (cid) {
            if (cid && cid !== chatStore.get().conversationId) {
              chatStore.set({ conversationId: cid });
              transport.subscribeConversation(cid);
            }
          },
          onAccepted: function (info) {
            // Bind canonical message id and flip to 'sent'. The next merge
            // (poll/history) will reconcile by __id and may promote to 'seen'.
            updateByLocalId({
              status: 'sent',
              __id: info && info.messageId ? info.messageId : undefined,
            });
          },
          onReply: function (reply) {
            var ns = chatStore.get();
            var arr = ns.messages.slice();
            arr.push({ body: reply, sender: 'operator', time: new Date() });
            chatStore.set({ messages: arr });
            onChange();
          },
          onError: function () {
            Util.warn('Send failed');
            updateByLocalId({ status: 'failed' });
          },
        }
      );
    }

    function bootstrapHistory(onChange) {
      transport.loadHistory({
        onResult: function (result) {
          if (result.conversationId) {
          chatStore.set({ conversationId: result.conversationId });
            try { document.cookie = 'gs_active=1; path=/; max-age=86400; SameSite=Lax'; } catch (_) {}
            transport.subscribeConversation(result.conversationId);
          }
          if (mergeIncoming(result.messages || [])) onChange();
        },
      });
    }

    // ─── Phase 5: Contact fallback (offline_mode === 'contact_fallback') ───
    // Lightweight in-panel form. Reuses the existing identity prechat backend
    // for contact details and the existing message endpoint for the message.
    // No new endpoints, no parallel submission system, no localStorage drafts.
    function renderContactFallback(body, identity, locale, presence, onSent) {
      var contact = (identityStore.get().contact) || {};
      var introCustom = (presence && presence.introLabel) ? presence.introLabel : '';
      var intro = introCustom || t('fallbackIntro');
      var dir = locale === 'fa' ? 'rtl' : 'ltr';

      function fieldRow(key, type, value, required) {
        var label = t(key);
        return '<div>' +
          '<label class="prechat-label">' + Util.escapeHtml(label) +
            (required ? ' <span class="prechat-required">*</span>' : '') + '</label>' +
          '<input class="input" data-fb="' + key + '" type="' + type +
          '" autocomplete="' + (key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel') +
          '" placeholder="' + Util.escapeHtml(label) + '" value="' + Util.escapeHtml(value || '') + '" />' +
          '<div class="prechat-error" data-err="' + key + '"></div>' +
        '</div>';
      }

      // Always ask for at least one contact channel + the message body.
      var askPhone = identity.isAsked('phone');
      var fieldsHtml = '';
      fieldsHtml += fieldRow('name', 'text', contact.name, identity.isRequired('name'));
      fieldsHtml += fieldRow('email', 'email', contact.email, !askPhone);
      if (askPhone) fieldsHtml += fieldRow('phone', 'tel', contact.phone, identity.isRequired('phone'));

      body.innerHTML =
        '<div class="prechat fallback" dir="' + dir + '">' +
        '<p class="prechat-intro">' + Util.escapeHtml(intro) + '</p>' +
        '<div class="prechat-fields">' + fieldsHtml +
          '<div>' +
            '<label class="prechat-label">' + Util.escapeHtml(t('fallbackMessageLabel')) +
            ' <span class="prechat-required">*</span></label>' +
            '<textarea class="input" data-fb="message" rows="3" placeholder="' +
              Util.escapeHtml(t('typeMsg')) + '"></textarea>' +
            '<div class="prechat-error" data-err="message"></div>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="prechat-submit" data-fb-submit>' + Util.escapeHtml(t('fallbackSubmit')) + '</button>' +
        '<div class="fallback-status" data-fb-status></div>' +
        '</div>';

      var statusEl = body.querySelector('[data-fb-status]');
      var submitBtn = body.querySelector('[data-fb-submit]');
      function get(k) { var el = body.querySelector('[data-fb="' + k + '"]'); return el ? el.value.trim() : ''; }
      function showErr(k, msg) {
        var el = body.querySelector('[data-err="' + k + '"]');
        if (el) { el.textContent = msg; el.classList.add('visible'); }
      }
      function clearErr(k) {
        var el = body.querySelector('[data-err="' + k + '"]');
        if (el) { el.textContent = ''; el.classList.remove('visible'); }
      }
      ['name', 'email', 'phone', 'message'].forEach(function (k) {
        var input = body.querySelector('[data-fb="' + k + '"]');
        if (input) input.addEventListener('input', function () { clearErr(k); });
      });

      if (!submitBtn) return;
      submitBtn.addEventListener('click', function () {
        var payload = {
          name: get('name'),
          email: get('email'),
          phone: get('phone'),
          message: get('message'),
        };
        var ok = true;
        if (identity.isRequired('name') && !payload.name) { showErr('name', t('required')); ok = false; }
        if (payload.email && !Util.isValidEmail(payload.email)) { showErr('email', t('invalidEmail')); ok = false; }
        if (payload.phone && !Util.isValidPhone(payload.phone)) { showErr('phone', t('invalidPhone')); ok = false; }
        if (!payload.email && !payload.phone) { showErr('email', t('required')); ok = false; }
        if (!payload.message) { showErr('message', t('required')); ok = false; }
        if (!ok) return;

        submitBtn.disabled = true; submitBtn.style.opacity = '0.6';
        if (statusEl) { statusEl.textContent = ''; statusEl.className = 'fallback-status'; }

        // Dedicated offline capture endpoint. This MUST NOT hit /message —
        // /message is only valid when the workspace is online. The server
        // re-resolves availability and creates a conversation tagged
        // 'offline' with a captured_offline event + best-effort email
        // notification to admins. Honeypot + rate-limit headers are sent
        // exactly like the regular /message path.
        var body = {
          workspace_id: ctx.workspaceId,
          message: payload.message,
          locale: ctx.locale || 'en',
          honeypot: '',
        };
        if (payload.name) body.name = payload.name;
        if (payload.email) body.email = payload.email;
        if (payload.phone) body.phone = payload.phone;

        ctx.fetchWith(ctx.apiBase + '/api/widget/offline-messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) {
            if (!r.ok) throw new Error('http_' + r.status);
            return r.json();
          })
          .then(function (data) {
            // captured: false only happens for the honeypot path; treat
            // visually as success since the real path always returns true.
            if (data && data.conversation_id) {
              chatStore.set({ conversationId: data.conversation_id });
            }
            // Echo the visitor message locally so they see what they sent.
            var s = chatStore.get();
            var messages = s.messages.slice();
            messages.push({ body: payload.message, sender: 'visitor', time: new Date() });
            chatStore.set({ messages: messages });

            // Persist contact details locally so subsequent prechat checks
            // don't re-prompt this visitor for the same info on this device.
            if (payload.name || payload.email || payload.phone) {
              identityStore.set({
                contact: Object.assign({}, identityStore.get().contact || {}, {
                  name: payload.name || (identityStore.get().contact || {}).name || '',
                  email: payload.email || (identityStore.get().contact || {}).email || '',
                  phone: payload.phone || (identityStore.get().contact || {}).phone || '',
                }),
              });
            }

            var msgKey = (data && data.transitioning) ? 'fallbackSentTransitioning' : 'fallbackSent';
            if (statusEl) { statusEl.textContent = t(msgKey); statusEl.className = 'fallback-status ok'; }
            if (typeof onSent === 'function') onSent();
          })
          .catch(function () {
            submitBtn.disabled = false; submitBtn.style.opacity = '1';
            if (statusEl) { statusEl.textContent = t('fallbackError'); statusEl.className = 'fallback-status error'; }
          });
      });
    }

    return {
      renderChat: renderChat,
      renderPreChat: renderPreChat,
      renderContactFallback: renderContactFallback,
      sendMessage: sendMessage,
      bootstrapHistory: bootstrapHistory,
      mergeIncoming: mergeIncoming,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // UI.KB
  // ════════════════════════════════════════════════════════════════════
  function createKbUI(deps) {
    return createKbUIImpl(deps);
  }

  // ════════════════════════════════════════════════════════════════════
  // Home view — dynamic entry surface. Presentation only: every piece of
  // data comes from stores/config that already exist (presence, chat
  // history, KB categories, feature flags). No fabricated capabilities.
  // ════════════════════════════════════════════════════════════════════
  function createHomeUI(deps) {
    var ctx = deps.ctx, t = deps.t;
    var presenceStore = deps.presenceStore;
    var chatStore = deps.chatStore;
    var kbStore = deps.kbStore;

    var ICON = {
      ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.2"/></svg>',
      human: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/></svg>',
      kb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
      chevron: '<svg class="ico-dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
      search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
      folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    };

    function relTime(iso) {
      var ts = iso ? Date.parse(iso) : NaN;
      if (!ts || isNaN(ts)) return '';
      try {
        return new Intl.DateTimeFormat(ctx.locale || 'en', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
      } catch (_) { return ''; }
    }

    function skeleton() {
      return '<div class="gs-skel-group" aria-hidden="true">' +
        '<div class="gs-skel gs-skel-line w60"></div>' +
        '<div class="gs-skel gs-skel-card"></div>' +
        '<div class="gs-skel gs-skel-row"></div>' +
        '<div class="gs-skel gs-skel-row"></div>' +
        '<div class="gs-skel gs-skel-row"></div>' +
      '</div>';
    }

    function actionRow(key, icon, title, sub, badgeHtml) {
      return '<button type="button" class="home-action" data-home-action="' + key + '">' +
        '<span class="home-action-icon">' + icon + '</span>' +
        '<span class="home-action-text">' +
          '<span class="home-action-title">' + Util.escapeHtml(title) + (badgeHtml || '') + '</span>' +
          '<span class="home-action-sub">' + Util.escapeHtml(sub) + '</span>' +
        '</span>' +
        ICON.chevron +
      '</button>';
    }

    function render(body, opts) {
      opts = opts || {};
      if (opts.loading) { body.innerHTML = '<div class="home-root">' + skeleton() + '</div>'; return; }

      var cfg = ctx.config || {};
      var feats = cfg.features || {};
      var pres = presenceStore.get();
      var msgs = (chatStore.get().messages || []);
      var last = msgs.length ? msgs[msgs.length - 1] : null;
      var aiEnabled = !!(cfg.aiAgent && cfg.aiAgent.enabled !== false && cfg.aiAgent.mode && cfg.aiAgent.mode !== 'off');
      var chatEnabled = feats.chat !== false;
      var kbEnabled = feats.knowledgeBase !== false && feats.kb !== false;

      var greetTitle = t('homeGreeting');
      var greetSub = (typeof cfg.welcomeMessage === 'string' && cfg.welcomeMessage.trim())
        ? cfg.welcomeMessage.trim()
        : t('homeGreetingSub');

      var html = '<div class="home-root">';
      html += '<div class="home-greeting">' +
        '<h2 class="home-greeting-title">' + Util.escapeHtml(greetTitle) + '</h2>' +
        '<p class="home-greeting-sub">' + Util.escapeHtml(greetSub).replace(/\n/g, '<br>') + '</p>' +
      '</div>';

      if (last) {
        var who = last.sender === 'visitor' ? '' : (last.senderName || '');
        html += '<div class="home-card home-resume">' +
          '<div class="home-resume-head">' +
            '<span class="home-resume-title">' + Util.escapeHtml(t('resumeTitle')) + '</span>' +
            '<span class="home-resume-time">' + Util.escapeHtml(relTime(last.createdAt || last.created_at)) + '</span>' +
          '</div>' +
          (who ? '<div class="home-resume-who">' + Util.escapeHtml(who) + '</div>' : '') +
          '<div class="home-resume-msg">' + Util.escapeHtml(String(last.body || '').slice(0, 120)) + '</div>' +
          '<button type="button" class="home-primary-btn" data-home-action="chat">' + Util.escapeHtml(t('resumeCta')) + '</button>' +
        '</div>';
      }

      html += '<div class="home-actions">';
      if (aiEnabled && chatEnabled) html += actionRow('ai', ICON.ai, t('actionAi'), t('actionAiSub'), '');
      if (chatEnabled) {
        var st = pres.status || 'offline';
        var stLabel = st === 'online' ? t('onlineLabel') : (st === 'away' ? t('awayLabel') : t('offlineLabel'));
        var badge = '<span class="home-status status-' + Util.escapeHtml(st) + '"><i></i>' + Util.escapeHtml(stLabel) + '</span>';
        html += actionRow('chat', ICON.human, t('actionHuman'), t('actionHumanSub'), badge);
      }
      if (kbEnabled) html += actionRow('help', ICON.kb, t('actionKb'), t('actionKbSub'), '');
      html += '</div>';

      if (kbEnabled) {
        html += '<div class="home-search">' + ICON.search +
          '<input class="home-search-input" type="search" data-home-search autocomplete="off" ' +
          'placeholder="' + Util.escapeHtml(t('searchKb')) + '" aria-label="' + Util.escapeHtml(t('searchKb')) + '" />' +
        '</div>';
        var cats = (kbStore.get().categories || []).slice(0, 6);
        html += '<div class="home-section-head"><span>' + Util.escapeHtml(t('categories')) + '</span>' +
          '<button type="button" class="home-link" data-home-action="help">' + Util.escapeHtml(t('viewAll')) + '</button></div>';
        if (!cats.length) {
          html += '<div class="home-empty">' + ICON.folder + '<span>' + Util.escapeHtml(t('noCategories')) + '</span></div>';
        } else {
          html += '<div class="home-cats">' + cats.map(function (c) {
            var name = (c && (c.name || c.title || c.slug)) || '';
            return '<button type="button" class="home-cat" data-home-action="help">' +
              '<span class="home-cat-icon">' + ICON.folder + '</span>' +
              '<span class="home-cat-name">' + Util.escapeHtml(String(name)) + '</span>' +
            '</button>';
          }).join('') + '</div>';
        }
      }

      html += '</div>';
      body.innerHTML = html;

      var btns = body.querySelectorAll('[data-home-action]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function () {
          var a = this.getAttribute('data-home-action');
          if (a === 'help') { deps.onOpenHelp && deps.onOpenHelp(); return; }
          deps.onOpenChat && deps.onOpenChat(a === 'ai' ? 'ai' : 'human');
        });
      }
      var si = body.querySelector('[data-home-search]');
      if (si) {
        si.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { deps.onOpenHelp && deps.onOpenHelp(si.value || ''); }
        });
        si.addEventListener('focus', function () { /* keeps focus local; search runs in Help */ });
      }
    }

    return { render: render };
  }

  function createKbUIImpl(deps) {
    var ctx = deps.ctx;
    var t = deps.t;
    var kbStore = deps.kbStore;
    var onSwitchToChat = deps.onSwitchToChat || function () {};

    // Per-instance ephemeral state (not persisted).
    var rootEl = null;          // current tab body element
    var searchAbort = null;     // AbortController for in-flight search
    var searchDebounce = null;  // setTimeout handle
    var currentQuery = '';
    var view = 'list';          // 'list' | 'article' | 'searching' | 'results' | 'empty'
    var currentArticle = null;
    var pendingSlug = null;

    function moduleUrl() {
      var base = ctx.assetBase || '';
      return base + '/widget/runtime-kb.js?v=' + (ctx.config._loaderVersion || ctx.config.loaderVersion || 'dev');
    }

    function isRtl() { return (ctx.locale || 'en').toLowerCase().split('-')[0] === 'fa'; }

    function publicArticleUrl(slug) {
      // Articles are served by the same public host as the site that mounted
      // the widget. We deliberately use window.location.origin so workspaces
      // with their own host get the right canonical URL — the SSR layer
      // resolves workspace from Host as well.
      var origin = (typeof window !== 'undefined' && window.location && window.location.origin) || '';
      return origin + '/help/' + encodeURIComponent(ctx.locale || 'en') + '/a/' + encodeURIComponent(slug);
    }

    function ensure(cb) {
      var s = kbStore.get();
      var TTL_MS = 60 * 1000;
      var fresh = s.loaded && s.loadedAt && (Date.now() - s.loadedAt) < TTL_MS;
      if (fresh) return cb && cb();
      ModuleLoader.load('kb', moduleUrl(), function () {
        var mod = ModuleLoader.modules.kb;
        if (mod && mod.loadCategories) {
          mod.loadCategories({
            apiBase: ctx.apiBase,
            workspaceId: ctx.workspaceId,
            sessionToken: ctx.sessionToken,
            locale: ctx.locale,
            onResult: function (r) {
              var arts = r.articles || [];
              var cats = r.categories || [];
              try { console.info('[Widget KB] loaded articles', { count: arts.length, categories: cats.length, locale: ctx.locale, workspaceId: ctx.workspaceId }); } catch (_) {}
              kbStore.set({ loaded: true, loadedAt: Date.now(), categories: cats, articles: arts });
              cb && cb();
            },
          });
        } else {
          kbStore.set({ loaded: true, loadedAt: Date.now(), categories: [], articles: [] });
          cb && cb();
        }
      });
    }

    function cancelSearch() {
      if (searchAbort) { try { searchAbort.abort(); } catch (_) {} searchAbort = null; }
      if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
    }

    function paint() {
      if (!rootEl) return;
      var s = kbStore.get();
      var rtl = isRtl();
      var dirAttr = rtl ? ' dir="rtl"' : '';
      var html = '<div class="kb-root"' + dirAttr + '>';

      html += '<div class="kb-search-wrap">' +
        '<input class="kb-search" type="search" autocomplete="off" autocorrect="off" spellcheck="false" ' +
        'placeholder="' + Util.escapeHtml(t('searchKb')) + '" value="' + Util.escapeHtml(currentQuery) + '" />' +
        '</div>';

      if (view === 'article' && currentArticle) {
        var publicUrl = publicArticleUrl(currentArticle.slug);
        html +=
          '<div class="kb-article-view">' +
            '<button type="button" class="kb-back" data-kb-action="back">' +
              (rtl ? '→ ' : '← ') + Util.escapeHtml(t('kbBack')) +
            '</button>' +
            '<h2 class="kb-article-h">' + Util.escapeHtml(currentArticle.title) + '</h2>' +
            (currentArticle.excerpt ? '<p class="kb-article-excerpt-full">' + Util.escapeHtml(currentArticle.excerpt) + '</p>' : '') +
            '<div class="kb-article-body">' + sanitizeHtml(currentArticle.content || '') + '</div>' +
            '<div class="kb-article-footer">' +
              '<a class="kb-open-browser" href="' + Util.escapeHtml(publicUrl) + '" target="_blank" rel="noopener noreferrer">' +
                Util.escapeHtml(t('kbOpenInBrowser')) +
              '</a>' +
            '</div>' +
          '</div>';
      } else if (view === 'searching') {
        html += '<div class="kb-status">' + Util.escapeHtml(t('kbSearching')) + '</div>';
      } else if (view === 'results') {
        var results = s.searchResults || [];
        if (!results.length) {
          html += '<div class="kb-empty kb-empty-centered">' +
            '<div class="kb-empty-icon" aria-hidden="true">' +
              '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
                '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
              '</svg>' +
            '</div>' +
            '<p class="kb-empty-text">' + Util.escapeHtml(t('kbZeroResults')) + '</p>' +
            '<button type="button" class="kb-cta kb-cta-pro" data-kb-action="switch-chat">' +
              '<span class="kb-cta-icon" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
              '</span>' +
              '<span>' + Util.escapeHtml(t('kbSwitchToChat')) + '</span>' +
            '</button>' +
          '</div>';
        } else {
          html += '<div class="kb-list">';
          results.forEach(function (a) {
            html +=
              '<button type="button" class="kb-article" data-kb-action="open" data-kb-slug="' +
                Util.escapeHtml(a.slug) + '">' +
                '<div class="kb-article-title">' + Util.escapeHtml(a.title) + '</div>' +
                (a.excerpt ? '<div class="kb-article-excerpt">' + Util.escapeHtml(a.excerpt) + '</div>' : '') +
              '</button>';
          });
          html += '</div>';
        }
      } else {
        // 'list' — published articles first, then categories.
        var cats = s.categories || [];
        var articles = s.articles || [];
        if (!cats.length && !articles.length) {
          html += '<div class="kb-empty kb-empty-centered">' +
            '<div class="kb-empty-icon" aria-hidden="true">' +
              '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' +
              '</svg>' +
            '</div>' +
            '<p class="kb-empty-text">' + Util.escapeHtml(t('noArticles')) + '</p>' +
            '<button type="button" class="kb-cta kb-cta-pro" data-kb-action="switch-chat">' +
              '<span class="kb-cta-icon" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
              '</span>' +
              '<span>' + Util.escapeHtml(t('kbSwitchToChat')) + '</span>' +
            '</button>' +
          '</div>';
        } else {
          if (articles.length) {
            html += '<div class="kb-section-h">' + Util.escapeHtml(t('kbAllArticles')) + '</div>';
            html += '<div class="kb-list">';
            articles.forEach(function (a) {
              html +=
                '<button type="button" class="kb-article" data-kb-action="open" data-kb-slug="' +
                  Util.escapeHtml(a.slug) + '">' +
                  '<div class="kb-article-title">' + Util.escapeHtml(a.title) + '</div>' +
                  (a.excerpt ? '<div class="kb-article-excerpt">' + Util.escapeHtml(a.excerpt) + '</div>' : '') +
                '</button>';
            });
            html += '</div>';
          }
          if (cats.length) {
          html += '<div class="kb-section-h">' + Util.escapeHtml(t('kbCategories')) + '</div>';
          html += '<div class="kb-list">';
          cats.forEach(function (c) {
            html +=
              '<a class="kb-category" target="_blank" rel="noopener noreferrer" ' +
                'href="' + Util.escapeHtml(window.location.origin + '/help/' + encodeURIComponent(ctx.locale || 'en') + '/c/' + encodeURIComponent(c.slug)) + '">' +
                '<div class="kb-article-title">' + Util.escapeHtml(c.name) + '</div>' +
                (c.description ? '<div class="kb-article-excerpt">' + Util.escapeHtml(c.description) + '</div>' : '') +
              '</a>';
          });
          html += '</div>';
          }
        }
      }

      html += '</div>';
      rootEl.innerHTML = html;
      bindEvents();
    }

    // Defence-in-depth sanitizer for KB content displayed inside the widget
    // (the content was authored by an operator but we still strip script/style/iframe/on*).
    function sanitizeHtml(input) {
      if (!input) return '';
      return String(input)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
        .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
        .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
        .replace(/javascript:/gi, '');
    }

    function bindEvents() {
      if (!rootEl) return;
      var input = rootEl.querySelector('.kb-search');
      if (input) {
        input.addEventListener('input', function (e) {
          currentQuery = e.target.value || '';
          if (searchDebounce) clearTimeout(searchDebounce);
          if (!currentQuery.trim()) {
            cancelSearch();
            view = 'list';
            paint();
            try { input.focus(); restoreCaret(rootEl.querySelector('.kb-search'), currentQuery.length); } catch (_) {}
            return;
          }
          searchDebounce = setTimeout(runSearch, 220);
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            currentQuery = '';
            cancelSearch();
            view = 'list';
            paint();
          }
        });
      }

      var actionEls = rootEl.querySelectorAll('[data-kb-action]');
      for (var i = 0; i < actionEls.length; i++) {
        (function (el) {
          el.addEventListener('click', function (ev) {
            var action = el.getAttribute('data-kb-action');
            if (action === 'open') {
              ev.preventDefault();
              openArticle(el.getAttribute('data-kb-slug'));
            } else if (action === 'back') {
              ev.preventDefault();
              currentArticle = null;
              view = currentQuery.trim() ? 'results' : 'list';
              paint();
            } else if (action === 'switch-chat') {
              ev.preventDefault();
              try { onSwitchToChat(); } catch (_) {}
            }
          });
        })(actionEls[i]);
      }
    }

    function restoreCaret(el, pos) {
      if (!el || typeof el.setSelectionRange !== 'function') return;
      try { el.setSelectionRange(pos, pos); } catch (_) {}
    }

    function runSearch() {
      cancelSearch();
      var q = currentQuery.trim();
      if (!q) { view = 'list'; paint(); return; }
      view = 'searching'; paint();
      try { searchAbort = new AbortController(); } catch (_) { searchAbort = null; }
      ModuleLoader.load('kb', moduleUrl(), function () {
        var mod = ModuleLoader.modules.kb;
        if (!mod || !mod.searchArticles) {
          kbStore.set({ searchResults: [] });
          view = 'results'; paint();
          return;
        }
        mod.searchArticles({
          apiBase: ctx.apiBase,
          workspaceId: ctx.workspaceId,
          sessionToken: ctx.sessionToken,
          locale: ctx.locale,
          query: q,
          limit: 8,
          signal: searchAbort ? searchAbort.signal : null,
          onResult: function (r) {
            // Ignore if user has cleared / changed query meanwhile.
            if (currentQuery.trim() !== q) return;
            kbStore.set({ searchResults: r.results || [] });
            view = 'results';
            paint();
            // Keep focus + caret in the input.
            try {
              var input = rootEl && rootEl.querySelector('.kb-search');
              if (input) { input.focus(); restoreCaret(input, currentQuery.length); }
            } catch (_) {}
          },
        });
      });
    }

    function openArticle(slug) {
      if (!slug) return;
      pendingSlug = slug;
      ModuleLoader.load('kb', moduleUrl(), function () {
        var mod = ModuleLoader.modules.kb;
        if (!mod || !mod.loadArticle) return;
        mod.loadArticle({
          apiBase: ctx.apiBase,
          workspaceId: ctx.workspaceId,
          sessionToken: ctx.sessionToken,
          locale: ctx.locale,
          slug: slug,
          onResult: function (r) {
            if (pendingSlug !== slug) return;
            if (r.ok && r.article) {
              currentArticle = r.article;
              view = 'article';
              paint();
            }
          },
        });
      });
    }

    function render(body) {
      rootEl = body;
      // Re-paint with current view (preserves search query when toggling tabs).
      paint();
    }

    return { ensure: ensure, render: render };
  }

  // ════════════════════════════════════════════════════════════════════
  // Template Registry (Task 4)
  //
  // Lightweight template-aware foundation. Today only `default` is registered
  // — additional templates can plug in later WITHOUT a new runtime bundle.
  //
  // Each template is just a small descriptor. Future templates can override
  // `prepareShell` / `prepareCtx` to influence rendering (CSS variables,
  // skin classes, behavioral hooks) while the core pipeline is unchanged.
  //
  // Resolution order in init():
  //   1. config.templateSlug (server-resolved against widget_templates)
  //   2. fallback to 'default' if slug unknown to the runtime registry
  //
  // The selected slug is exposed as:
  //   - ctx.templateSlug                (string)
  //   - data-template="<slug>" on <gs-widget> AND on .shell
  //   - body class `gs-template-<slug>` is NOT used (Shadow DOM scoping only)
  // ════════════════════════════════════════════════════════════════════
  var TemplateRegistry = (function () {
    var entries = {};
    function register(descriptor) {
      if (!descriptor || !descriptor.slug) return;
      entries[descriptor.slug] = descriptor;
    }
    function get(slug) { return entries[slug] || null; }
    function resolve(requestedSlug) {
      var slug = requestedSlug || 'default';
      var entry = entries[slug] || entries['default'] || null;
      return {
        slug: entry ? entry.slug : 'default',
        descriptor: entry,
        // True when caller asked for X but we fell back to default. Useful
        // for diagnostics — the server still owns the canonical decision,
        // this is purely a runtime safety net.
        fellBack: !!requestedSlug && (!entry || entry.slug !== requestedSlug),
      };
    }
    return { register: register, get: get, resolve: resolve, all: function () { return entries; } };
  })();

  // Register the only real template that ships today. Future templates are
  // additive — they just call TemplateRegistry.register(...).
  TemplateRegistry.register({
    slug: 'default',
    name: 'Default',
    /** Hook: optionally tweak the ctx object before any UI is built. */
    prepareCtx: function (_ctx) { /* no-op for default */ },
    /** Hook: called once shellDiv exists, before panel mounts. */
    prepareShell: function (_shellDiv, _ctx) { /* no-op for default */ },
  });

  // ── Widget Template 2 — premium skin ─────────────────────────────────
  // Pure CSS skin scoped to .shell[data-template="template2"]. Loads the
  // Vazirmatn webfont (Google Fonts) into both the host document and the
  // shadow root so Persian + Latin text renders with the correct family.
  TemplateRegistry.register({
    slug: 'template2',
    name: 'Widget Template 2',
    prepareCtx: function (_ctx) { /* no-op */ },
    prepareShell: function (_shellDiv, _ctx) {
      try {
        if (typeof document === 'undefined') return;
        var FONT_HREF = 'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;500;600;700&display=swap';
        if (!document.getElementById('gs-t2-fonts')) {
          var l = document.createElement('link');
          l.id = 'gs-t2-fonts';
          l.rel = 'stylesheet';
          l.href = FONT_HREF;
          document.head.appendChild(l);
        }
        var sh = (_shellDiv && _shellDiv.shadowRoot) || null;
        if (sh && !sh.getElementById('gs-t2-fonts-shadow')) {
          var l2 = document.createElement('link');
          l2.id = 'gs-t2-fonts-shadow';
          l2.rel = 'stylesheet';
          l2.href = FONT_HREF;
          sh.appendChild(l2);
        }
      } catch (_) { /* font injection optional */ }
    },
  });

  // Expose for debugging / future runtime template registration from outside.
  __gs_runtime.templates = TemplateRegistry;

  // ════════════════════════════════════════════════════════════════════
  // Core — orchestrates everything inside the shadow root
  // ════════════════════════════════════════════════════════════════════
  __gs_runtime.init = function (config, shell) {
    // Debug flag resolution (any one enables verbose `[Widget Runtime]` logs):
    //   1) server-driven `config.debugMode` (admin → widget settings)
    //   2) per-tab override: `localStorage.setItem('gs:debug','1')`
    //   3) global override: `window.__gs_debug = true`
    // All three are read-only signals — no token/PII is ever logged.
    var lsDebug = false;
    try { lsDebug = (typeof localStorage !== 'undefined') && localStorage.getItem('gs:debug') === '1'; } catch (_) {}
    Util.debug = !!(config.debugMode || lsDebug || (typeof window !== 'undefined' && window.__gs_debug));
    Util.log('Runtime init (Shadow DOM, Phase 2)');
    try {
      if (config && config.callRuntimeUrl) {
        window.__gs_call_url = config.callRuntimeUrl;
        window.__gs_call_config = window.__gs_call_config || {};
        window.__gs_call_config.url = config.callRuntimeUrl;
      }
      // Pass 2 — vendor LiveKit SDK URL (hashed, self-hosted). Mirror it
      // onto the global so the runtime-call.js engine's strict loadSdk()
      // can find it whether the loader pre-set it or not.
      if (config && config.livekitSdkUrl && !window.__gs_call_sdk_url) {
        window.__gs_call_sdk_url = config.livekitSdkUrl;
      }
      // Visitor-side video quality preset surfaced via widget config so
      // workspace defaults reach the engine before the call starts.
      if (config && config.callDefaultVideoQuality && !window.__gs_call_video_quality) {
        window.__gs_call_video_quality = String(config.callDefaultVideoQuality);
      }
    } catch (_) { /* noop */ }

    var shadowRoot = (shell && shell.shadowRoot) || (shell && shell.shellEl && shell.shellEl.shadowRoot) || null;
    if (!shell || !shadowRoot) {
      Util.warn('FATAL: no shadowRoot provided by loader');
      return { open: function(){}, close: function(){}, toggle: function(){}, setUnread: function(){} };
    }

     // Honor the workspace's "Widget Language" setting. When set to a
     // specific locale (fa/en/tr) it overrides the workspace default
     // locale that drives the rest of the platform. 'auto' falls back
     // to the workspace locale (which itself falls back to the visitor
     // browser language during signup).
     var resolvedLocale = (function () {
       var wl = config.widgetLanguage;
       if (typeof wl === 'string' && wl && wl !== 'auto') return wl;
       return config.locale || 'en';
     })();
     var ctx = {
       config: config,
       apiBase: config._apiBase || config.apiBase || '',
       assetBase: config._assetBase || config.assetBase || '',
       workspaceId: config.workspaceId || '',
       sessionToken: config._sessionToken || '',
       locale: resolvedLocale,
       primaryColor: config.primaryColor || '#3B82F6',
       shell: shell,
     };

    // ─── Token manager (Task 2): proactive refresh + reactive 401/403 retry.
    // Wraps every authenticated widget request. ctx.sessionToken stays as a
    // *snapshot* for backward compatibility, but ctx.fetchWith is the real
    // path used by all new code and by the chat/kb modules below.
    var tokenMgr = createTokenManager(ctx.sessionToken, ctx.apiBase);
    tokenMgr.onChange(function (t) { ctx.sessionToken = t; });
    ctx.fetchWith = tokenMgr.fetchWith;
    ctx.getToken = tokenMgr.get;
    ctx.tokenManager = tokenMgr;

    // ─── Shared token bus integration ─────────────────────────────────
    // Bridge runtime tokenManager ↔ window.__gs_token (set up by loader).
    // After this:
    //   - any refresh by the runtime is published to the bus, so the
    //     loader's heartbeat picks it up on the very next ping;
    //   - any refresh done by the loader's heartbeat is mirrored into
    //     the runtime tokenManager so /api/realtime/connect and
    //     /api/realtime/subscribe never go out with a stale token.
    // This eliminates the "stale token snapshot" reconnect-churn loop.
    try {
      if (window.__gs_token) {
        // Publish current token so any subscriber that came up before
        // the runtime mounted gets the freshest value.
        if (ctx.sessionToken) window.__gs_token.set(ctx.sessionToken);
        // Mirror runtime refreshes → bus.
        tokenMgr.onChange(function (t) {
          try { window.__gs_token.set(t); } catch (_) {}
        });
        // Mirror bus updates → runtime ctx.sessionToken so the realtime
        // driver (which reads ctx.sessionToken at call time) always sees
        // the latest value, even if the loader-side refresh fired first.
        window.__gs_token.onChange(function (t) {
          if (!t) return;
          if (tokenMgr && tokenMgr.adopt) tokenMgr.adopt(t);
          if (t !== ctx.sessionToken) ctx.sessionToken = t;
        });
      }
    } catch (_) { /* bus optional */ }

    // Expose template slug in the runtime context for CSS scoping + future
    // template-aware behavior. Today only 'default' is registered server-side.
    var __tplResolve = TemplateRegistry.resolve(config.templateSlug);
    ctx.templateSlug = __tplResolve.slug;
    ctx.template = __tplResolve.descriptor;
    if (__tplResolve.fellBack) {
      Util.warn('[template] requested "' + config.templateSlug + '" not registered — using "default"');
    }
    try {
      var rootEl = (shell && shell.shellEl) || null;
      if (rootEl) rootEl.setAttribute('data-template', ctx.templateSlug);
    } catch (_) {}
    // Run the template's prepareCtx hook (no-op for default today) so future
    // templates can adjust ctx values (icons, colors, copy keys) before any
    // rendering happens.
    if (ctx.template && typeof ctx.template.prepareCtx === 'function') {
      try { ctx.template.prepareCtx(ctx); } catch (e) { Util.warn('template.prepareCtx err', e); }
    }

    // Tear down the token manager when the panel is unloaded by the host
    // page (SPA route swap). Prevents orphaned refresh timers.
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', function () { try { tokenMgr.destroy(); } catch (_) {} }, { once: true });
    }

    // ─── Visibility / wake-up recovery ───────────────────────────────
    // When the user returns to a tab that was backgrounded for a long
    // time, the realtime socket has often been killed by the browser or
    // the OS, and the proactive token refresh may have hit its failure
    // ceiling and disabled itself. Without an explicit recovery hook
    // the widget would sit on "Connecting…" until full reload.
    //
    // On every visibility/pageshow transition back to foreground we:
    //   1) revive the token manager (resets failure counter, kicks a
    //      fresh /session/refresh round-trip — the HttpOnly `dvsid`
    //      cookie is still valid as long as the user has any session),
    //   2) ask the transport to reconnect from scratch — which will
    //      re-resolve the realtime vendor and re-open the socket with
    //      a fresh token.
    if (typeof document !== 'undefined' && document.addEventListener) {
      var __wakeInflight = false;
      // States during which a wake-triggered reconnect MUST NOT run.
      // The widget is already mid-handshake — forcing a reconnect at
      // this moment yanks the in-flight subscribe and produces the
      // observed "subscribing → reconnecting (driver:dropped)" loop.
      var WAKE_BLOCK = {
        bootstrapping: 1,
        restoring_session: 1,
        connecting: 1,
        subscribing: 1,
      };
      // States from which a wake recovery is actually meaningful.
      // Anything outside this set means the transport is either healthy
      // (no need to recover) or already mid-flight (do not interrupt).
      //
      // IMPORTANT: 'connected' is NOT in this set. A healthy active
      // connection must NEVER be yanked just because the tab regained
      // visibility — that produced the destructive
      //   connected → waking → reconnecting (driver:dropped)
      // loop in production. If the socket is actually dead the driver's
      // own ping/onclose path will detect it and trigger reconnect via
      // the proper channel; we don't need to second-guess it here.
      var WAKE_RECOVERABLE = {
        offline: 1,
        reconnecting: 1,
        unavailable: 1,
        failed: 1,
        auth_expired: 1,
        degraded: 1,
        idle: 1,        // never connected yet, allow first kick
      };
      var triggerWake = function (reason) {
        if (__wakeInflight) return;
        // ── Hard guard: never interrupt an in-flight bootstrap/connect/subscribe.
        var lcState = (ctx.lifecycle && ctx.lifecycle.get) ? ctx.lifecycle.get() : null;
        if (lcState && WAKE_BLOCK[lcState]) {
          Util.log('[wake] skipped — lifecycle busy (' + lcState + ', reason=' + reason + ')');
          return;
        }
        // ── Only recover from states we know are recoverable. Unknown
        //    states fall through to "no-op" rather than forcing a reset.
        if (lcState && !WAKE_RECOVERABLE[lcState]) {
          Util.log('[wake] skipped — lifecycle not recoverable (' + lcState + ', reason=' + reason + ')');
          return;
        }
        __wakeInflight = true;
        try {
          // FSM: enter 'waking' so banner/composer can distinguish wake
          // recovery from initial connect or transient outage.
          // If the transition is rejected (illegal), abort — do not
          // continue into reconnect, since that is exactly the bug we
          // are guarding against.
          var wakeOk = true;
          if (ctx.lifecycle && ctx.lifecycle.get() !== 'idle' && ctx.lifecycle.get() !== 'bootstrapping') {
            try {
              wakeOk = ctx.lifecycle.transition('waking', 'wake:' + reason) !== false;
            } catch (_) { wakeOk = false; }
          }
          if (!wakeOk) {
            Util.log('[wake] aborted — illegal transition from ' + lcState + ' (reason=' + reason + ')');
            return;
          }
          if (tokenMgr && tokenMgr.isDisabled && tokenMgr.isDisabled()) {
            try { tokenMgr.revive(); } catch (_) {}
          } else if (tokenMgr && tokenMgr.refresh) {
            // Even when not disabled, the token may be near expiry after a
            // long sleep. Fire-and-forget refresh; failure is handled
            // internally by the manager.
            try { tokenMgr.refresh().catch(function () {}); } catch (_) {}
          }
          if (ctx && ctx.transport && typeof ctx.transport.reconnect === 'function') {
            ctx.transport.reconnect();
          }
          Util.log('[wake] recovery triggered (' + reason + ')');
        } finally {
          // Debounce: ignore duplicate wake events for ~2s.
          setTimeout(function () { __wakeInflight = false; }, 2000);
        }
      };
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') triggerWake('visibilitychange');
      });
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('pageshow', function (e) {
          // pageshow with persisted=true means restored from BFCache —
          // a definitive signal that all sockets are dead. Plain pageshow
          // (persisted=false) fires on EVERY navigation including the
          // initial load; suppress it to avoid racing the bootstrap path.
          if (e && e.persisted) triggerWake('bfcache');
        });
        window.addEventListener('focus', function () {
          // focus is a weaker signal; only act if we know we're offline.
          try {
            var s = transportStore && transportStore.get && transportStore.get();
            if (s && (s.connectionState === 'offline' || s.connectionState === 'reconnecting')) {
              triggerWake('focus');
            }
          } catch (_) {}
        });
      }
    }

    var t = function (key) { return I18n.t(ctx.locale, key); };

    var chatEnabled = config.features && config.features.chat !== false;
    var kbEnabled = config.features && config.features.knowledgeBase;

    // ─── Phase 8C — Call channel state (read from effective policy) ───
    // Single source of truth: window.__gs_policy injected by handshakes.
    // No hardcoded defaults — when the policy is missing or call channels
    // are off the buttons are hidden so visitors see no broken UI.
    // ─── Pass 2 — In-panel call surface store ───
    // Drives the call view that lives INSIDE the widget panel Shadow DOM
    // (see renderCallSurface below). Replaces the legacy out-of-panel
    // popup that runtime-call.js used to mount on document.body. The
    // surface is open whenever phase !== 'idle'; while open the panel
    // hides tabs + composer and renders the call view full-bleed inside
    // the .body container.
    //
    // Phases:
    //   'idle'        — no call active.
    //   'connecting'  — engine.connect() in flight.
    //   'connected'   — at least one media track flowing.
    //   'reconnecting'— transient SDK reconnect.
    //   'failed'      — connect rejected; `error` carries { code, message }.
    //   'ended'       — engine disconnected normally; surface lingers
    //                   briefly so visitor sees "Call ended" before we
    //                   restore the previous view.
    var callSurfaceStore = createStore({
      phase: 'idle',
      invitationId: null,
      callId: null,
      channel: null,        // 'audio' | 'video'
      previousTab: 'chat',  // restored when the surface closes
      micEnabled: false,
      cameraEnabled: false,
      remote: { audio: null, video: null }, // MediaStreamTracks (live)
      localVideo: null,
      error: null,          // { code, message }
      connectedAt: 0,       // ms epoch — timer baseline
      endedDuration: 0,     // seconds — sticky after call ends
      cameras: [],          // [{ deviceId, label }]
      switchingCamera: false,
    });

    // Wire engine events ONCE the global engine appears. The engine is
    // loaded asynchronously (runtime-call.js) — we set up subscriptions
    // lazily the first time we need them.
    var __engineSubscribed = false;
    function subscribeToEngineOnce() {
      if (__engineSubscribed) return;
      var engine = window.__gs_call && window.__gs_call.engine;
      if (!engine) return; // try again later when caller invokes us
      __engineSubscribed = true;
      engine.on('state', function (state) {
        var cur = callSurfaceStore.get();
        if (cur.phase === 'idle') return; // surface already closed
        if (state === 'connected') {
          var patch = { phase: 'connected' };
          if (!cur.connectedAt) patch.connectedAt = Date.now();
          callSurfaceStore.set(patch);
        }
        else if (state === 'reconnecting') callSurfaceStore.set({ phase: 'reconnecting' });
        else if (state === 'connecting') callSurfaceStore.set({ phase: 'connecting' });
        else if (state === 'failed') {
          // 'error' event already populated callSurfaceStore.error;
          // just flip the phase. Don't auto-close — visitor needs to see
          // the message and click Close.
          callSurfaceStore.set({ phase: 'failed' });
        } else if (state === 'disconnected') {
          if (cur.phase !== 'failed') {
            var dur = cur.connectedAt ? Math.max(0, Math.floor((Date.now() - cur.connectedAt) / 1000)) : 0;
            callSurfaceStore.set({ phase: 'ended', endedDuration: dur });
          }
          // Auto-close the surface a moment later so the visitor sees
          // "Call ended" briefly. Closing restores the previous tab.
          setTimeout(function () {
            var s = callSurfaceStore.get();
            if (s.phase === 'ended') closeCallSurface(false);
          }, 2400);
        }
      });
      engine.on('remote', function (tracks) {
        callSurfaceStore.set({ remote: tracks || { audio: null, video: null } });
      });
      engine.on('local', function (payload) {
        callSurfaceStore.set({ localVideo: (payload && payload.video) || null });
      });
      engine.on('micEnabled', function (v) { callSurfaceStore.set({ micEnabled: !!v }); });
      engine.on('cameraEnabled', function (v) { callSurfaceStore.set({ cameraEnabled: !!v }); });
      engine.on('cameras', function (info) {
        callSurfaceStore.set({ cameras: (info && info.cameras) || [] });
      });
      engine.on('error', function (err) {
        // Normalize into a stable { code, message } shape for the UI.
        callSurfaceStore.set({ error: { code: (err && err.code) || 'livekit_connect_failed', message: (err && err.message) || 'Call failed.' } });
      });
    }

    function openCallSurface(opts) {
      var prev = shellStore.get().activeTab || 'chat';
      // Joining/connecting a call ends any incoming-call ringing UX.
      try { if (notify && notify.stopRingtone) notify.stopRingtone('call_surface_open'); } catch (_) {}
      callSurfaceStore.set({
        phase: 'connecting',
        invitationId: opts.invitationId || null,
        callId: opts.callId || null,
        channel: opts.channel || 'audio',
        previousTab: prev,
        error: null,
        remote: { audio: null, video: null },
        localVideo: null,
        micEnabled: false,
        cameraEnabled: false,
        connectedAt: 0,
        endedDuration: 0,
        cameras: [],
        switchingCamera: false,
      });
    }

    function closeCallSurface(manualHangup) {
      var prev = callSurfaceStore.get().previousTab || 'chat';
      var snap = callSurfaceStore.get();
      try { if (notify && notify.stopRingtone) notify.stopRingtone('call_surface_close'); } catch (_) {}
      // Pass A — best-effort tell the server the visitor ended the call
      // BEFORE we tear down LiveKit locally, so the operator inbox sees
      // a `call:ended` event with reason='visitor_ended' and a duration.
      // Idempotent server-side; we never block the local teardown.
      try {
        if (manualHangup && snap && snap.invitationId) {
          try {
            console.info('[gs-call] visitor ending call', {
              call_session_id: snap.callId || null,
              invitation_id: snap.invitationId,
            });
          } catch (_) {}
          postCallInvitationAction(snap.invitationId, 'end')
            .then(function (resp) {
              try {
                console.info('[gs-call] visitor end endpoint success', {
                  duration_seconds: resp && resp.duration_seconds,
                  call_session_id: resp && resp.call_session_id,
                });
              } catch (_) {}
            })
            .catch(function (err) {
              try {
                console.warn('[gs-call] visitor end endpoint failed', err && (err.message || err));
              } catch (_) {}
            });
        }
      } catch (_) {}
      // Best-effort: ensure the engine is torn down. Idempotent.
      try {
        var engine = window.__gs_call && window.__gs_call.engine;
        if (engine) engine.disconnect();
      } catch (_) {}
      callSurfaceStore.set({
        phase: 'idle',
        invitationId: null,
        callId: null,
        channel: null,
        error: null,
        remote: { audio: null, video: null },
        localVideo: null,
        micEnabled: false,
        cameraEnabled: false,
        connectedAt: 0,
        endedDuration: 0,
        cameras: [],
        switchingCamera: false,
      });
      // Restore the previous tab + re-render so the chat view comes back.
      shellStore.set({ activeTab: prev });
    }

    // Pass A — handle a server-published `call:ended` envelope. Closes the
    // call surface immediately, returns to chat, and appends a local
    // system message reflecting who ended it + the duration. Polling will
    // overwrite with the canonical server message if there is one.
    function handleServerCallEnded(payload) {
      try {
        try { if (notify && notify.stopRingtone) notify.stopRingtone('server_call_ended'); } catch (_) {}
        var snap = callSurfaceStore.get();
        var matchesActive = snap && snap.callId && payload &&
          (payload.call_session_id === snap.callId || payload.call_id === snap.callId);
        if (snap && snap.phase !== 'idle' && (matchesActive || !snap.callId)) {
          var prev = snap.previousTab || 'chat';
          try {
            var engine = window.__gs_call && window.__gs_call.engine;
            if (engine) engine.disconnect();
          } catch (_) {}
          callSurfaceStore.set({
            phase: 'idle', invitationId: null, callId: null, channel: null,
            error: null, remote: { audio: null, video: null }, localVideo: null,
            micEnabled: false, cameraEnabled: false,
          });
          shellStore.set({ activeTab: prev });
        }
        // Append a local system message so the visitor sees the outcome.
        var dur = (payload && typeof payload.duration_seconds === 'number') ? payload.duration_seconds : 0;
        var mm = String(Math.floor(dur / 60)); if (mm.length < 2) mm = '0' + mm;
        var ss = String(dur % 60); if (ss.length < 2) ss = '0' + ss;
        var who = (payload && payload.ended_by) || 'system';
        var headline = who === 'operator' ? (t('csOperatorEnded') || 'Operator ended the call')
          : who === 'visitor' ? (t('csVisitorEnded') || 'You ended the call')
          : (t('csCallEnded') || 'Call ended');
        var body = headline + ' · ' + mm + ':' + ss;
        var s = chatStore.get();
        var msgs = (s.messages || []).slice();
        msgs.push({
          id: 'call-ended-' + (payload && (payload.call_session_id || payload.call_id) || Date.now()),
          sender: 'system', senderType: 'system', text: body, body: body,
          time: (payload && payload.ended_at) || new Date().toISOString(),
          metadata: { kind: 'call_ended_local' },
        });
        chatStore.set({ messages: msgs });
      } catch (_) {}
    }
    // Expose so the realtime drivers (centrifugo/supabase) can dispatch
    // without importing this scope. Idempotent guard.
    if (!window.__gs_call) window.__gs_call = {};
    window.__gs_call.ended = handleServerCallEnded;

    // Map a canonical engine error code → translated message. Falls back
    // to the engine's raw message when no i18n key matches the code.
    function callErrorMessage(err) {
      if (!err) return t('csErrUnknown') || 'Something went wrong.';
      var code = err.code || '';
      var map = {
        sdk_url_missing: 'csErrSdkMissing',
        sdk_load_failed: 'csErrSdkLoad',
        livekit_connect_failed: 'csErrConnect',
        token_mint_failed: 'csErrTokenMint',
        provider_not_ready: 'csErrProviderNotReady',
        turn_missing: 'csErrTurnMissing',
        permission_denied_microphone: 'csErrPermMic',
        permission_denied_camera: 'csErrPermCam',
        invitation_expired: 'csErrInvitationExpired',
        invitation_already_joined: 'csErrInvitationJoined',
        invitation_access_denied: 'csErrAccessDenied',
        origin_denied: 'csErrOriginDenied',
      };
      var key = map[code];
      var msg = key ? t(key) : '';
      return msg || err.message || (t('csErrUnknown') || 'Something went wrong.');
    }

    /** Format seconds → mm:ss. */
    function csFormatDuration(sec) {
      var s = Math.max(0, Math.floor(sec || 0));
      var mm = String(Math.floor(s / 60)); if (mm.length < 2) mm = '0' + mm;
      var ss = String(s % 60); if (ss.length < 2) ss = '0' + ss;
      return mm + ':' + ss;
    }

    // Inline SVG icon set — Shadow-DOM safe, no external font dependency.
    var GS_ICON = {
      micOn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
      micOff: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
      camOn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
      camOff: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
      switchCam: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
      hangup: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" transform="rotate(135 12 12)"/></svg>',
      phone: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"/></svg>',
      back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
    };

    /**
     * Render the in-panel call surface. Owns the .body container while
     * a call is active. Mounts <audio>/<video> elements directly inside
     * the widget Shadow DOM and binds their srcObject to the live
     * MediaStreamTracks the engine emits via callSurfaceStore.
     *
     * Layouts:
     *   - Video call: remote video full-bleed, polished local PiP, control
     *     bar with mic/cam/switch/hangup. Camera-off shows a tile, never a
     *     frozen frame.
     *   - Audio call: dedicated voice screen — avatar orb, animated
     *     equalizer, live timer, mic + speaker(future) + hangup. No
     *     <video> element so there is no black rectangle.
     */
    function renderCallSurface(container, s) {
      if (!container) return;
      var phase = s.phase;
      var isVideo = s.channel === 'video';
      var hasRemoteVideo = !!(s.remote && s.remote.video);
      var hasMultiCam = isVideo && Array.isArray(s.cameras) && s.cameras.length >= 2;
      var statusKey = phase === 'connecting' ? 'csConnecting'
        : phase === 'reconnecting' ? 'csReconnecting'
        : phase === 'connected' ? (isVideo ? 'csVideoCall' : 'csAudioCall')
        : phase === 'ended' ? 'csEnded'
        : '';
      var statusText = phase === 'failed' ? callErrorMessage(s.error)
        : statusKey ? (t(statusKey) || statusKey)
        : '';
      var showWaiting = phase === 'connected' && isVideo && !hasRemoteVideo;
      // Build a skeleton signature — only rebuild innerHTML when the
      // structural shape changes. Live data (timer, srcObject) updates
      // in place to avoid tearing down <video> mid-playback.
      var sig = [
        phase, isVideo ? 'v' : 'a',
        s.micEnabled ? '1' : '0',
        s.cameraEnabled ? '1' : '0',
        hasMultiCam ? 'm' : 's',
        showWaiting ? 'w' : '-',
      ].join('|');
      var existing = container.querySelector('[data-call-surface]');
      var sigChanged = !existing || existing.getAttribute('data-call-sig') !== sig;

      if (!sigChanged) {
        bindCallTracks(container, s);
        updateCallSurfaceLive(container, s, statusText);
        return;
      }

      var html = '';
      if (isVideo) {
        html += '<div class="gs-call-surface gs-call-video" data-call-surface data-phase="' + phase + '" data-call-sig="' + Util.escapeHtml(sig) + '" data-channel="video">';
        html += '  <div class="gs-call-stage" data-call-stage>';
        html += '    <video class="gs-call-remote-video" data-call-remote-video data-call-video-role="visitor-remote" data-orientation-correction="scaleX(-1)" autoplay playsinline style="transform:scaleX(-1);scale:1;rotate:0deg"></video>';
        html += '    <audio data-call-remote-audio autoplay></audio>';
        // Remote placeholder (no remote video yet)
        html += '    <div class="gs-call-stage-placeholder" data-call-remote-placeholder' + (hasRemoteVideo ? ' hidden' : '') + '>';
        html += '      <div class="gs-call-stage-orb" aria-hidden="true">' + GS_ICON.phone + '</div>';
        html += '      <div class="gs-call-stage-msg" data-call-remote-msg>' + Util.escapeHtml(showWaiting ? (t('csWaitingPeer') || 'Waiting…') : (t('csConnecting') || 'Connecting…')) + '</div>';
        html += '    </div>';
        // Top bar — status + live timer
        html += '    <div class="gs-call-topbar">';
        html += '      <span class="gs-call-topbar-dot" data-call-phase-dot></span>';
        html += '      <span class="gs-call-topbar-status" data-call-status>' + Util.escapeHtml(statusText) + '</span>';
        html += '      <span class="gs-call-topbar-timer" data-call-timer>00:00</span>';
        html += '    </div>';
        // Local PiP
        html += '    <div class="gs-call-pip" data-call-local-pip>';
        html += '      <video class="gs-call-local-video" data-call-local-video data-call-video-role="visitor-local" data-orientation-correction="scaleX(-1)" autoplay playsinline muted style="transform:scaleX(-1);scale:1;rotate:0deg"' + (s.cameraEnabled ? '' : ' hidden') + '></video>';
        html += '      <div class="gs-call-pip-off"' + (s.cameraEnabled ? ' hidden' : '') + ' aria-hidden="true">' + GS_ICON.camOff + '</div>';
        html += '    </div>';
        if (isCallOrientationDebugEnabled()) {
          html += '    <div class="gs-call-orientation-debug"><strong>REAL ORIENTATION TEST</strong><span class="left">LEFT</span><span class="right">RIGHT</span><small>visitor · scaleX(-1)</small></div>';
        }
        html += '  </div>';
        // Control bar
        html += '  <div class="gs-call-controls" data-call-controls>';
        if (phase === 'failed' || phase === 'ended') {
          html += renderTerminalControls(s);
        } else {
          html += renderControlButton('mic', s.micEnabled ? GS_ICON.micOn : GS_ICON.micOff, s.micEnabled ? 'csMicMute' : 'csMicUnmute', !s.micEnabled);
          html += renderControlButton('cam', s.cameraEnabled ? GS_ICON.camOn : GS_ICON.camOff, s.cameraEnabled ? 'csCamOff' : 'csCamOn', !s.cameraEnabled);
          if (hasMultiCam) {
            html += renderControlButton('switch-cam', GS_ICON.switchCam, 'csSwitchCamera', false);
          }
          html += '<button type="button" class="gs-call-btn gs-call-btn-hangup" data-call-action="hangup" aria-label="' + Util.escapeHtml(t('csHangup') || 'End call') + '">' + GS_ICON.hangup + '</button>';
        }
        html += '  </div>';
        html += '</div>';
      } else {
        // Audio-only voice call screen
        html += '<div class="gs-call-surface gs-call-audio" data-call-surface data-phase="' + phase + '" data-call-sig="' + Util.escapeHtml(sig) + '" data-channel="audio">';
        html += '  <audio data-call-remote-audio autoplay></audio>';
        html += '  <div class="gs-call-voice-stage">';
        html += '    <div class="gs-call-voice-orb" aria-hidden="true">';
        html += '      <span class="gs-call-voice-pulse"></span>';
        html += '      <span class="gs-call-voice-icon">' + GS_ICON.phone + '</span>';
        html += '    </div>';
        html += '    <div class="gs-call-voice-status" data-call-status>' + Util.escapeHtml(statusText) + '</div>';
        html += '    <div class="gs-call-voice-timer" data-call-timer>00:00</div>';
        html += '    <div class="gs-call-eq" aria-hidden="true">';
        for (var bi = 0; bi < 7; bi++) {
          html += '<span class="gs-call-eq-bar" style="animation-delay:' + (bi * 80) + 'ms"></span>';
        }
        html += '    </div>';
        html += '  </div>';
        html += '  <div class="gs-call-controls" data-call-controls>';
        if (phase === 'failed' || phase === 'ended') {
          html += renderTerminalControls(s);
        } else {
          html += renderControlButton('mic', s.micEnabled ? GS_ICON.micOn : GS_ICON.micOff, s.micEnabled ? 'csMicMute' : 'csMicUnmute', !s.micEnabled);
          html += '<button type="button" class="gs-call-btn gs-call-btn-hangup" data-call-action="hangup" aria-label="' + Util.escapeHtml(t('csHangup') || 'End call') + '">' + GS_ICON.hangup + '</button>';
        }
        html += '  </div>';
        html += '</div>';
      }
      container.innerHTML = html;
      bindCallTracks(container, s);
      updateCallSurfaceLive(container, s, statusText);

      var ctrls = container.querySelector('[data-call-controls]');
      if (ctrls) {
        ctrls.addEventListener('click', function (ev) {
          var btn = ev.target && ev.target.closest && ev.target.closest('[data-call-action]');
          if (!btn) return;
          var action = btn.getAttribute('data-call-action');
          var engine = window.__gs_call && window.__gs_call.engine;
          if (action === 'mic' && engine) { engine.toggleMic(); }
          else if (action === 'cam' && engine) { engine.toggleCamera(); }
          else if (action === 'switch-cam' && engine && typeof engine.switchCamera === 'function') {
            btn.setAttribute('disabled', 'disabled');
            engine.switchCamera().then(function () {
              try { btn.removeAttribute('disabled'); } catch (_) {}
            }, function () { try { btn.removeAttribute('disabled'); } catch (_) {} });
          }
          else if (action === 'hangup') { closeCallSurface(true); }
          else if (action === 'close') { closeCallSurface(false); }
        });
      }
    }

    function renderControlButton(action, icon, labelKey, isOff) {
      var label = t(labelKey) || labelKey;
      return '<button type="button" class="gs-call-btn gs-call-btn-toggle' + (isOff ? ' off' : '') + '" data-call-action="' + Util.escapeHtml(action) + '" aria-label="' + Util.escapeHtml(label) + '" title="' + Util.escapeHtml(label) + '">' + icon + '</button>';
    }

    function renderTerminalControls(s) {
      var dur = (s.endedDuration || (s.connectedAt ? Math.floor((Date.now() - s.connectedAt) / 1000) : 0));
      var label = (t('csCallEnded') || 'Call ended') + (dur > 0 ? ' · ' + (t('csDuration') || 'Duration') + ' ' + csFormatDuration(dur) : '');
      var html = '<div class="gs-call-terminal-card">';
      html += '<span class="gs-call-terminal-label">' + Util.escapeHtml(label) + '</span>';
      html += '<button type="button" class="gs-call-btn-back" data-call-action="close" aria-label="' + Util.escapeHtml(t('csBackToChat') || 'Back to chat') + '">' + GS_ICON.back + '<span>' + Util.escapeHtml(t('csBackToChat') || 'Back to chat') + '</span></button>';
      html += '</div>';
      return html;
    }

    /**
     * Update only the dynamic bits inside an already-rendered surface:
     * status text, live timer, local PiP visibility, remote placeholder.
     * Avoids destroying the <video> element while a call is alive.
     */
    function updateCallSurfaceLive(container, s, statusText) {
      try {
        var statusEl = container.querySelector('[data-call-status]');
        if (statusEl && statusEl.textContent !== statusText) statusEl.textContent = statusText || '';
        var timerEl = container.querySelector('[data-call-timer]');
        if (timerEl) {
          var dur = 0;
          if (s.phase === 'connected' || s.phase === 'reconnecting') {
            if (s.connectedAt) dur = Math.floor((Date.now() - s.connectedAt) / 1000);
          } else if (s.phase === 'ended') {
            dur = s.endedDuration || 0;
          }
          timerEl.textContent = csFormatDuration(dur);
          timerEl.style.visibility = (dur > 0 || s.phase === 'connected' || s.phase === 'reconnecting') ? 'visible' : 'hidden';
        }
        // Camera-off tile vs. local video visibility
        var pipVid = container.querySelector('[data-call-local-video]');
        var pipOff = container.querySelector('.gs-call-pip-off');
        if (pipVid) {
          if (s.cameraEnabled) pipVid.removeAttribute('hidden');
          else pipVid.setAttribute('hidden', 'hidden');
        }
        if (pipOff) {
          if (s.cameraEnabled) pipOff.setAttribute('hidden', 'hidden');
          else pipOff.removeAttribute('hidden');
        }
        // Remote placeholder vs. live video
        var rmEl = container.querySelector('[data-call-remote-placeholder]');
        var hasRemote = !!(s.remote && s.remote.video);
        if (rmEl) {
          if (hasRemote) rmEl.setAttribute('hidden', 'hidden');
          else rmEl.removeAttribute('hidden');
          var rmMsg = container.querySelector('[data-call-remote-msg]');
          if (rmMsg) rmMsg.textContent = (s.phase === 'connected') ? (t('csWaitingPeer') || 'Waiting…') : (t('csConnecting') || 'Connecting…');
        }
      } catch (_) { /* noop */ }
    }

    // 1Hz timer ticker — re-renders the surface only when the call is
    // active so the visible mm:ss advances. Defensive: only queues a
    // re-render if the body is actually showing the call surface.
    setInterval(function () {
      try {
        var s = callSurfaceStore.get();
        if (s && s.phase !== 'idle') {
          // Just trigger a subscriber notification by re-setting same
          // values — no-op store changes would be dropped, so update a
          // dedicated tick counter via the body refresh hook instead.
          var b = (typeof body !== 'undefined') ? body : null;
          var surf = b && b.querySelector && b.querySelector('[data-call-surface]');
          if (surf) updateCallSurfaceLive(surf, s, surf.querySelector('[data-call-status]') ? surf.querySelector('[data-call-status]').textContent : '');
        }
      } catch (_) {}
    }, 1000);

    // Track binding helper — re-attaches MediaStreamTracks to <video> /
    // <audio> elements without rebuilding them. We track the bound track
    // id per element so we only swap srcObject when the underlying track
    // changes (or when the track id is the same but the element has
    // stalled — a sign of a simulcast layer switch the SDK didn't
    // surface as TrackUnsubscribed).
    function bindCallTracks(container, s) {
      try {
        var aEl = container.querySelector('[data-call-remote-audio]');
        if (aEl) bindTrack(aEl, s.remote && s.remote.audio, s.remote && s.remote.audioTrack, 'remote-audio');
        var rvEl = container.querySelector('[data-call-remote-video]');
        if (rvEl) bindTrack(rvEl, s.remote && s.remote.video, s.remote && s.remote.videoTrack, 'remote-video');
        var lvEl = container.querySelector('[data-call-local-video]');
        if (lvEl) bindTrack(lvEl, s.localVideo, null, 'local-video');
      } catch (_) { /* noop */ }
    }
    function isCallOrientationDebugEnabled() {
      try {
        return /(?:^|[?&])callOrientationDebug=1(?:&|$)/.test(window.location.search || '') ||
          window.localStorage.getItem('call_orientation_debug') === '1';
      } catch (_) { return false; }
    }
    function logCallVideoOrientation(el) {
      try {
        var dataAttrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
          var attr = el.attributes[i];
          if (attr.name.indexOf('data-') === 0) dataAttrs[attr.name] = attr.value || 'true';
        }
        var cs = window.getComputedStyle(el);
        console.info('[call-ui] video orientation', {
          role: el.getAttribute('data-call-video-role') || 'visitor-video',
          computedTransform: cs.transform,
          inlineTransform: el.style.transform || '',
          correctionMode: 'scaleX(-1)',
          className: el.className,
          dataAttrs: dataAttrs,
        });
      } catch (_) { /* diagnostic only */ }
    }
    function getCallVideoOrientation(el) {
      if (!el) return null;
      var w = el.videoWidth || 0;
      var h = el.videoHeight || 0;
      if (!w || !h) return null;
      if (h > w * 1.05) return 'portrait';
      if (w > h * 1.05) return 'landscape';
      return 'square';
    }
    function applyCallVideoOrientation(el, role) {
      if (!el) return null;
      var orientation = getCallVideoOrientation(el);
      if (!orientation) return null;
      var classes = ['gs-call-video--portrait', 'gs-call-video--landscape', 'gs-call-video--square'];
      classes.forEach(function (c) { el.classList.remove(c); });
      el.classList.add('gs-call-video--' + orientation);
      // Local PiP video lives inside .gs-call-pip; remote video lives
      // inside [data-call-stage]. Propagate the orientation class to the
      // nearest meaningful wrapper so CSS can react.
      var stage = el.closest('.gs-call-pip, [data-call-stage], [data-call-surface]');
      if (stage) {
        classes.forEach(function (c) { stage.classList.remove(c); });
        stage.classList.add('gs-call-video--' + orientation);
        stage.setAttribute('data-video-orientation', orientation);
      }
      try {
        console.info('[call-ui] video dimensions', {
          role: role,
          videoWidth: el.videoWidth,
          videoHeight: el.videoHeight,
          orientation: orientation,
        });
        console.info('[call-ui] orientation class applied', {
          role: role,
          orientation: orientation,
          cls: 'gs-call-video--' + orientation,
        });
      } catch (_) {}
      return orientation;
    }
    function bindTrack(el, track, lkTrack, role) {
      if (el && el.tagName === 'VIDEO') {
        try { el.style.transform = 'scaleX(-1)'; } catch (_) {}
        try { el.style.scale = '1'; } catch (_) {}
        try { el.style.rotate = '0deg'; } catch (_) {}
        logCallVideoOrientation(el);
        applyCallVideoOrientation(el, role);
      }
      var prevId = el.__gsBoundTrackId || '';
      var prevAttachedLkTrack = el.__gsAttachedLkTrack || null;
      // No track? Detach and clear.
      if (!track && !lkTrack) {
        if (prevAttachedLkTrack && typeof prevAttachedLkTrack.detach === 'function') {
          try { prevAttachedLkTrack.detach(el); } catch (_) {}
        }
        if (prevId) {
          try { el.srcObject = null; } catch (_) {}
        }
        el.__gsBoundTrackId = '';
        el.__gsAttachedLkTrack = null;
        return;
      }
      // Attach video media event listeners once for diagnostics.
      if (el.tagName === 'VIDEO' && !el.__gsCallEventsBound) {
        el.__gsCallEventsBound = true;
        var roleTag = role || 'video';
        ['loadedmetadata', 'playing', 'waiting', 'stalled', 'error', 'resize'].forEach(function (evt) {
          el.addEventListener(evt, function () {
            try {
              console.info('[gs-call-ui] remote video event', {
                role: roleTag,
                event: evt,
                width: el.videoWidth,
                height: el.videoHeight,
                readyState: el.readyState,
                paused: el.paused,
              });
            } catch (_) {}
            if (evt === 'loadedmetadata' || evt === 'resize' || evt === 'playing') {
              try { applyCallVideoOrientation(el, roleTag); } catch (_) {}
            }
          });
        });
      }
      // Prefer LiveKit RemoteTrack.attach() — mirrors the operator-side
      // flow that proved stable. attach() handles srcObject creation and
      // re-attachment across simulcast layer changes for us.
      var newTrackId = (track && track.id) || (lkTrack && lkTrack.sid) || '';
      if (lkTrack && typeof lkTrack.attach === 'function') {
        if (prevAttachedLkTrack !== lkTrack) {
          try {
            console.info('[gs-call-ui] bind remote video start', { role: role, via: 'lk-attach', sid: lkTrack.sid });
          } catch (_) {}
          if (prevAttachedLkTrack && typeof prevAttachedLkTrack.detach === 'function') {
            try { prevAttachedLkTrack.detach(el); } catch (_) {}
          }
          try {
            lkTrack.attach(el);
            el.__gsAttachedLkTrack = lkTrack;
            el.__gsBoundTrackId = newTrackId;
            try {
              console.info('[gs-call-ui] bind remote video success', {
                role: role,
                width: el.videoWidth,
                height: el.videoHeight,
                readyState: el.readyState,
              });
            } catch (_) {}
          } catch (e) {
            try { console.warn('[gs-call-ui] lk attach failed; fallback to srcObject', e && e.message); } catch (_) {}
            if (track) {
              try { el.srcObject = new MediaStream([track]); el.__gsBoundTrackId = track.id; } catch (_) {}
            }
          }
        }
      } else if (track) {
        var stalled = el.tagName === 'VIDEO' && el.readyState < 2 && prevId === track.id;
        var dead = track.readyState !== 'live';
        if (prevId !== track.id || stalled || dead) {
          try {
            console.info('[gs-call-ui] bind remote video start', { role: role, via: 'srcObject', trackId: track.id });
          } catch (_) {}
          try {
            el.srcObject = new MediaStream([track]);
            el.__gsBoundTrackId = track.id;
            el.__gsAttachedLkTrack = null;
          } catch (_) {}
        }
      }
      var p;
      try { p = el.play(); } catch (_) {}
      if (p && typeof p.catch === 'function') {
        p.catch(function (err) {
          try { console.warn('[gs-call-ui] remote video play failed', { role: role, error: err && err.message }); } catch (_) {}
        });
      }
    }

    // ─── Phase 8H — Department resolver + state (additive) ────────────
    // Optional, lightweight department layer. Default behavior (general
    // mode / no departments configured) is identical to pre-8H.
    //
    // Session rules:
    //   - Resolve mode ONCE per (workspace, channel) per browser session.
    //   - Persist resolution + selection in sessionStorage so close+reopen
    //     within the same tab session does NOT flicker UI.
    //   - NEVER re-evaluate live during an open widget session.
    //
    // The store carries:
    //   modes:    { chat?, audio?, video? } — frozen resolutions per channel
    //   selectedId:    chosen department id (single mode auto-binds; multi
    //                  mode user-picks; general mode stays null)
    //   selectedFromCh: which channel the selection was made for (for debug)
    var __DEPT_SS_KEY = 'gs:dept:' + (ctx.workspaceId || 'unknown');
    function __deptLoadFromSession() {
      try {
        if (typeof sessionStorage === 'undefined') return null;
        var raw = sessionStorage.getItem(__DEPT_SS_KEY);
        if (!raw) return null;
        var p = JSON.parse(raw);
        if (!p || typeof p !== 'object') return null;
        return p;
      } catch (_) { return null; }
    }
    function __deptSaveToSession(state) {
      try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.setItem(__DEPT_SS_KEY, JSON.stringify({
          modes: state.modes || {},
          selectedId: state.selectedId || null,
          selectedFromCh: state.selectedFromCh || null,
        }));
      } catch (_) {}
    }
    var __deptInit = __deptLoadFromSession() || {};
    var departmentStore = createStore({
      modes: __deptInit.modes || {},          // { chat?: Resolution, audio?, video? }
      selectedId: __deptInit.selectedId || null,
      selectedFromCh: __deptInit.selectedFromCh || null,
      // In-flight fetch promises keyed by channel — prevents duplicate calls.
      _inflight: {},
    });
    // Persist whenever a meaningful field changes.
    departmentStore.subscribe(function (s) { __deptSaveToSession(s); });

    // Fetch and freeze the department mode for a given channel. Idempotent.
    // Returns a Promise<Resolution> where Resolution is:
    //   { mode: 'general'|'single'|'multi', visible_departments: [...],
    //     default_department_id: string|null, channel: 'chat'|'audio'|'video' }
    function resolveDepartmentMode(channel) {
      var ch = channel === 'audio' || channel === 'video' ? channel : 'chat';
      var s = departmentStore.get();
      if (s.modes && s.modes[ch]) return Promise.resolve(s.modes[ch]);
      if (s._inflight && s._inflight[ch]) return s._inflight[ch];
      if (!ctx.apiBase || !ctx.workspaceId) {
        // No API base available — degrade to general mode silently.
        var fallback = { mode: 'general', visible_departments: [], default_department_id: null, channel: ch };
        var modes0 = Object.assign({}, s.modes); modes0[ch] = fallback;
        departmentStore.set({ modes: modes0 });
        return Promise.resolve(fallback);
      }
      var url = ctx.apiBase + '/api/widget/departments/visible?channel=' + encodeURIComponent(ch);
      var p = ctx.fetchWith(url, { method: 'GET' })
        .then(function (r) {
          if (!r.ok) throw new Error('dept_http_' + r.status);
          return r.json();
        })
        .then(function (j) {
          var resolution = {
            mode: (j && j.mode) || 'general',
            visible_departments: (j && j.visible_departments) || [],
            default_department_id: (j && j.default_department_id) || null,
            channel: ch,
          };
          var ns = departmentStore.get();
          var modes = Object.assign({}, ns.modes); modes[ch] = resolution;
          var inflight = Object.assign({}, ns._inflight); delete inflight[ch];
          var nextSel = ns.selectedId;
          var nextFrom = ns.selectedFromCh;
          // Single mode → auto-bind selection if none yet.
          if (resolution.mode === 'single' && !nextSel && resolution.default_department_id) {
            nextSel = resolution.default_department_id;
            nextFrom = ch;
          }
          departmentStore.set({ modes: modes, _inflight: inflight, selectedId: nextSel, selectedFromCh: nextFrom });
          Util.log('[dept] resolved', ch, resolution.mode, 'visible=' + resolution.visible_departments.length);
          return resolution;
        })
        .catch(function (err) {
          // Network/server error → degrade to general mode for this channel.
          var ns2 = departmentStore.get();
          var inflight2 = Object.assign({}, ns2._inflight); delete inflight2[ch];
          var fb = { mode: 'general', visible_departments: [], default_department_id: null, channel: ch };
          var modes2 = Object.assign({}, ns2.modes); modes2[ch] = fb;
          departmentStore.set({ modes: modes2, _inflight: inflight2 });
          Util.warn('[dept] resolve failed for ' + ch + ' → general fallback', err && err.message);
          return fb;
        });
      var inflight = Object.assign({}, s._inflight); inflight[ch] = p;
      departmentStore.set({ _inflight: inflight });
      return p;
    }

    function deptSelect(deptId, fromChannel) {
      if (!deptId) return;
      departmentStore.set({ selectedId: deptId, selectedFromCh: fromChannel || null });
      Util.log('[dept] selected', deptId, 'from', fromChannel);
    }

    // Public helper read by chat send / call enqueue / callback request.
    // Returns null when general mode (no department to attach).
    function getSelectedDepartmentId() {
      var s = departmentStore.get();
      return s.selectedId || null;
    }

    // Resolve effective channel capabilities given the current selection.
    // When no department is selected (general mode) this returns
    // { chat:true, audio:true, video:true } so policy/widget gates remain
    // the only filter. When a department is selected the intersection of
    // its channel toggles applies. Useful for hiding tabs/buttons.
    function deptChannelCaps() {
      var s = departmentStore.get();
      if (!s.selectedId) return { chat: true, audio: true, video: true };
      // Find the department descriptor across any resolved channel.
      var modes = s.modes || {};
      var keys = ['chat', 'audio', 'video'];
      for (var i = 0; i < keys.length; i++) {
        var m = modes[keys[i]];
        if (!m || !m.visible_departments) continue;
        for (var j = 0; j < m.visible_departments.length; j++) {
          var d = m.visible_departments[j];
          if (d && d.id === s.selectedId && d.capabilities) {
            return {
              chat: d.capabilities.chat !== false,
              audio: !!d.capabilities.audio,
              video: !!d.capabilities.video,
            };
          }
        }
      }
      // Selected dept not found in any cached resolution → permissive default.
      return { chat: true, audio: true, video: true };
    }

    // Kick off chat-channel resolution at init time so the store is warm
    // before the panel opens. Best-effort; never blocks any UI.
    try { resolveDepartmentMode('chat'); } catch (_) {}

    // Expose for debug + future templates.
    ctx.departments = {
      resolve: resolveDepartmentMode,
      select: deptSelect,
      getSelectedId: getSelectedDepartmentId,
      caps: deptChannelCaps,
      store: departmentStore,
    };
    try { window.__gs_departments = ctx.departments; } catch (_) {}

    // ─── Mount target ───
    var shellDiv = shadowRoot.querySelector ? shadowRoot.querySelector('.shell') : null;
    if (!shellDiv) {
      shellDiv = document.createElement('div');
      shellDiv.className = 'shell';
      if (typeof shadowRoot.appendChild === 'function') shadowRoot.appendChild(shellDiv);
    }
    if (!shellDiv || typeof shellDiv.appendChild !== 'function') {
      Util.warn('FATAL: no mount target available inside shadow root');
      return { open: function(){}, close: function(){}, toggle: function(){}, setUnread: function(){} };
    }
    // Mirror data-template onto .shell so Shadow-DOM-scoped CSS can target
    // the entire UI subtree (e.g. `.shell[data-template="default"] .panel`).
    try { shellDiv.setAttribute('data-template', ctx.templateSlug); } catch (_) {}
    if (ctx.template && typeof ctx.template.prepareShell === 'function') {
      try { ctx.template.prepareShell(shellDiv, ctx); } catch (e) { Util.warn('template.prepareShell err', e); }
    }
    var launcher = shell.launcher;

    // ─── Domain stores (each one isolated, with pub/sub) ───
    var shellStore = createStore({
      isOpen: false,
      activeTab: 'home',
      mounted: false,
    });
    var transportStore = createStore({
      connectionState: 'idle',
      lastConnectionChange: 0,
    });
    var identityStore = createStore({
      loaded: false,
      identityState: 'anonymous',
      contact: null,
      prechat: null,
    });
    var chatStore = createStore({
      conversationId: null,
      messages: [],
      seenIds: {},
      // In-memory only. Never persisted to localStorage/cookies.
      // Per-conversation drafts: { [conversationId|'__pending__']: text }.
      // '__pending__' is the safe scope used before a conversation id exists;
      // it is migrated to the real cid as soon as one is known, so the user
      // never loses what they typed during the transition.
      drafts: {},
    });
    var DRAFT_PENDING_KEY = '__pending__';

    // ─── Phase 6a: Attachment domain store ───
    // Kept SEPARATE from chatStore (per Part 12 rule). Tracks the single
    // pending attachment for the current draft. State machine:
    //   idle → selected → uploading → ready → (sent → idle) | error
    // No persistence, no auto-retry, no background queueing.
    var attachmentStore = createStore({
      file: null,            // browser-side only, never sent raw
      fileName: '',
      mimeType: '',
      sizeBytes: 0,
      status: 'idle',        // 'idle'|'selected'|'uploading'|'ready'|'error'
      progress: 0,           // 0..100
      error: '',
      attachmentId: null,    // server-issued, used in /message payload
    });
    function resetAttachment() {
      attachmentStore.set({
        file: null, fileName: '', mimeType: '', sizeBytes: 0,
        status: 'idle', progress: 0, error: '', attachmentId: null,
      });
    }
    var kbStore = createStore({
      loaded: false,
      loadedAt: 0,
      categories: [],
      articles: [],
      searchResults: [],
    });
    // notifyStore — Phase 4
    //   perConversation: { [cid]: count }   (per-conversation unread)
    //   totalUnread:    aggregated count for the launcher badge
    //   lastMessageIds: { [id]: 1 }         de-dupe across reconnects/polls
    // In-memory only. Never persisted.
    var notifyStore = createStore({
      perConversation: {},
      totalUnread: 0,
      lastMessageIds: {},
    });
    var uiPrefsStore = createStore({
      position: config.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
      // Sound is OFF by default. Toggle via window.__gs.push(['setSoundEnabled', true]).
      // Default ON — message chime + incoming-call ringtone are core widget
      // UX. Hosts can override via window.__gs.push(['setSoundEnabled', false]).
      soundEnabled: (config.features && config.features.notificationSound === false)
        ? false : true,
    });
    // Phase 5 — presence/availability store. Separate from transport + notify stores.
    var presenceStore = createStore({
      status: 'offline',          // online | away | offline | unavailable
      label: '',
      offlineMode: 'accept_messages',
      liveChatEnabled: true,
      lastChange: 0,
    });

    // ─── Layers ───
    // Phase 2 — lifecycle FSM is the single source of truth for connection
    // state. Transport drives it via onDriverState(); identity/history/wake
    // call into ctx.lifecycle for the higher-level transitions. Existing
    // store consumers keep working unchanged via the legacy bridge inside
    // createTransport (which mirrors fsm.legacyConnectionState() into
    // transportStore.connectionState).
    var fsm = createLifecycleFSM();
    ctx.lifecycle = fsm;
    fsm.transition('bootstrapping', 'init');
    var transport = createTransport(ctx, transportStore, fsm);
    // Expose transport on ctx so the wake-up recovery hook (registered
    // earlier) can call transport.reconnect() when the tab returns from
    // background. ctx is captured by closure inside the wake handler.
    ctx.transport = transport;
    var identity = createIdentity(ctx, identityStore);
    // Phase 6b — lightbox lives in the panel's Shadow DOM. We expose a
    // function to chatUI so renderChat can open it without reaching into shell.
    var lightboxOpener = function (id) { /* set after panel mount */ };
    var chatUI = createChatUI({
      ctx: ctx, t: t,
      chatStore: chatStore,
      identityStore: identityStore,
      transportStore: transportStore,
      transport: transport,
      openImageLightbox: function (id) { lightboxOpener(id); },
      // Pass 2 fix — bridge the in-panel call-surface helpers defined later
      // in this same init() closure into createChatUI so its invitation
      // Join handler can drive the headless engine without relying on
      // module-global lookups (which previously threw
      // `subscribeToEngineOnce is not defined`).
      callBridge: {
        subscribeToEngineOnce: function () { return subscribeToEngineOnce(); },
        openCallSurface: function (opts) { return openCallSurface(opts); },
        renderBody: function () { return renderBody(); },
        // Forwarded lazily because `notify` is constructed below this
        // call. By the time the visitor clicks a Join/Decline button,
        // notify is fully wired.
        stopRingtone: function () {
          try { if (notify && notify.stopRingtone) notify.stopRingtone(); } catch (_) {}
        },
      },
    });
    var kbUI = createKbUI({
      ctx: ctx,
      t: t,
      kbStore: kbStore,
      onSwitchToChat: function () {
        if (!chatEnabled) return;
        shellStore.set({ activeTab: 'chat' });
        // Sync tab UI + body without requiring user click. The tab listener
        // takes care of class toggling but only fires on user click; do it
        // manually here so KB → Chat transitions feel instant.
        try {
          var allTabs = panel.querySelectorAll('.tab');
          Array.prototype.forEach.call(allTabs, function (t2) {
            t2.classList.toggle('active', t2.getAttribute('data-tab') === 'chat');
          });
        } catch (_) {}
        // renderBody() is the single source of truth for composer visibility:
        // it hides the input bar when pre-chat is required (unidentified
        // visitor) or when the offline contact-fallback form owns the input.
        // Do NOT force inputBar to flex here — that would let an unidentified
        // visitor type before completing pre-chat.
        renderBody();
        if (identityStore.get().loaded && !identity.needsPrechat()) {
          restoreDraftToInput();
          if (msgInput) { try { msgInput.focus(); } catch (_) {} }
        }
      },
    });
    var notify = createNotify(ctx, transportStore, notifyStore, uiPrefsStore, shellStore, t);
    var presence = createPresence(ctx, presenceStore, transport, transportStore, t);

    // ─── Build panel ───
    var posClass = uiPrefsStore.get().position;
    var brandName = config.brandName || '';
     var welcomeMessage = config.welcomeMessage || t('welcomeFallback');
    // Header title — show the workspace's "Launcher Text" (configurable per
    // workspace under Widget settings). Falls back to brand name only if the
    // workspace hasn't customized it.
    var headerTitle = (config.launcherText && String(config.launcherText).trim())
      || brandName
      || t('support');
    // Operator team — surfaced in the header as a stacked avatar row, the
    // way Intercom / Crisp / Drift do. Replaces the single workspace-logo
    // badge that used to sit there.
    var teamMembers = Array.isArray(config.teamMembers) ? config.teamMembers.slice(0, 4) : [];

    var existingPanel = shadowRoot.querySelector ? shadowRoot.querySelector('.panel') : null;
    if (existingPanel && existingPanel.parentNode) existingPanel.parentNode.removeChild(existingPanel);

    var panel = document.createElement('div');
    panel.className = 'panel ' + posClass;
    // Apply RTL to the entire panel when the resolved widget locale is RTL
    // (currently only fa). Without this, the body, tabs, composer and
    // attachments stay LTR even though the strings are Persian.
    if ((ctx.locale || 'en').toLowerCase().split('-')[0] === 'fa') {
      panel.setAttribute('dir', 'rtl');
      panel.classList.add('panel-rtl');
    } else {
      panel.setAttribute('dir', 'ltr');
    }

    // Operator avatar stack (max 4). Each operator becomes a small circular
    // avatar overlapping the next one, falling back to their initial when no
    // avatar_url is set. The whole stack is hidden when there are no team
    // members configured.
    var teamStackHtml = '';
    if (teamMembers.length) {
      var stackInner = teamMembers.map(function (op) {
         var name = (op && op.name) ? String(op.name) : t('operator');
        var avatar = op && op.avatar ? String(op.avatar) : '';
        var online = !!(op && op.online);
        var onlineCls = online ? ' is-online' : '';
         var dotHtml = online ? '<span class="header-op-dot" aria-label="' + Util.escapeHtml(t('onlineLabel')) + '"></span>' : '';
        if (avatar) {
          return '<span class="header-op-avatar has-img' + onlineCls + '" title="' + Util.escapeHtml(name) + '">' +
            '<img src="' + Util.escapeHtml(avatar) + '" alt="' + Util.escapeHtml(name) + '" loading="lazy" decoding="async" />' +
            dotHtml +
          '</span>';
        }
        var initial = (name.trim().charAt(0) || 'O').toUpperCase();
        return '<span class="header-op-avatar' + onlineCls + '" title="' + Util.escapeHtml(name) + '">' +
          '<span aria-hidden="true">' + Util.escapeHtml(initial) + '</span>' +
          dotHtml +
        '</span>';
      }).join('');
       teamStackHtml = '<div class="header-op-stack" aria-label="' + Util.escapeHtml(t('teamLabel')) + '">' + stackInner + '</div>';
    }

    var headerRtl = (ctx.locale || 'en').toLowerCase().split('-')[0] === 'fa';
    var headerDirAttr = headerRtl ? ' dir="rtl"' : '';
    var headerCls = 'header' + (headerRtl ? ' header-rtl' : '');
    var headerHtml = '<div class="' + headerCls + '"' + headerDirAttr + '>' +
      '<div class="header-brand">' +
        teamStackHtml +
        '<div class="header-brand-text">' +
          '<div class="header-title">' + Util.escapeHtml(headerTitle) + '</div>' +
          '<div class="presence" data-presence aria-live="polite">' +
            '<span class="presence-dot" data-presence-dot></span>' +
            '<span class="presence-label" data-presence-label></span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="header-close" data-header-close aria-label="' + Util.escapeHtml(t('closeWidget')) + '" title="' + Util.escapeHtml(t('closeWidget')) + '">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</button>' +
      '</div>';
    // Visitor-initiated voice/video tabs were removed — calls are now only
    // initiated from the operator side. Keep chat + help tabs only.
    var NAV_ICONS = {
      home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
      chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/></svg>',
      help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    };
    var tabDefs = [{ key: 'home', label: t('home') }];
    if (chatEnabled) tabDefs.push({ key: 'chat', label: t('chat') });
    if (kbEnabled) tabDefs.push({ key: 'help', label: t('help') });
    var tabsHtml = '';
    if (tabDefs.length > 1) {
      var act = shellStore.get().activeTab;
      tabsHtml = '<nav class="tabs" role="tablist" aria-label="' + Util.escapeHtml(t('support')) + '">' + tabDefs.map(function (d) {
        return '<button type="button" role="tab" aria-selected="' + (act === d.key ? 'true' : 'false') +
          '" class="tab' + (act === d.key ? ' active' : '') + '" data-tab="' + d.key + '">' +
          '<span class="tab-icon">' + NAV_ICONS[d.key] + '</span>' +
          '<span class="tab-label">' + Util.escapeHtml(d.label) + '</span>' +
        '</button>';
      }).join('') + '</nav>';
    }
    var bodyHtml = '<div class="body" data-body></div>';
    var attachCfg = (ctx.config && ctx.config.attachments) || { enabled: false };
    var isT2 = (ctx.templateSlug === 'template2');
    var inputHtml = chatEnabled
      ? '<div class="typing-row" data-typing-row hidden aria-live="polite">' +
          '<span class="typing-dots"><span></span><span></span><span></span></span>' +
          '<span class="typing-label" data-typing-label></span>' +
        '</div>' +
        '<div class="attach-tray" data-attach-tray hidden></div>' +
        '<div class="input-bar" data-input-bar>' +
        '<button type="button" class="send-btn" data-send-btn style="background:' + ctx.primaryColor + '">' +
        '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
        '</button>' +
        (isT2
          ? '<button type="button" class="emoji-btn" data-emoji-btn aria-label="Emoji" title="Emoji">' +
              '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>' +
            '</button>'
          : '') +
        (attachCfg.enabled
          ? '<button type="button" class="attach-btn" data-attach-btn title="' + Util.escapeHtml(t('attachFile') || 'Attach file') + '" aria-label="' + Util.escapeHtml(t('attachFile') || 'Attach file') + '">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
            '</button>' +
            '<input type="file" data-attach-input hidden accept="' + (attachCfg.allowedMimes || []).join(',') + '" />'
          : '') +
        '<input class="input" data-msg-input placeholder="' + Util.escapeHtml(t('typeMsg')) + '" />' +
        (isT2
          ? '<button type="button" class="mic-btn" data-mic-btn aria-label="Voice" title="Voice">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
            '</button>'
          : '') +
        '</div>'
      : '';
     var poweredHtml = brandName
       ? '<div class="powered">' + Util.escapeHtml(t('poweredBy')) + ' <a href="#">' + Util.escapeHtml(brandName) + '</a></div>'
      : '';

    panel.innerHTML = headerHtml + tabsHtml + bodyHtml + inputHtml + poweredHtml +
      // Phase 6b — lightbox container, hidden by default.
      '<div class="att-lightbox" data-att-lightbox hidden role="dialog" aria-modal="true" aria-label="' + Util.escapeHtml(t('openFile')) + '">' +
        '<button type="button" class="att-lightbox-close" data-att-lightbox-close aria-label="' + Util.escapeHtml(t('closePreview')) + '">×</button>' +
        '<img data-att-lightbox-img alt="" />' +
      '</div>';
    shellDiv.appendChild(panel);

    var typingRow = panel.querySelector('[data-typing-row]');
    var typingLabel = panel.querySelector('[data-typing-label]');
    var body = panel.querySelector('[data-body]');
    var msgInput = panel.querySelector('[data-msg-input]');
    var sendBtn = panel.querySelector('[data-send-btn]');
    var inputBar = panel.querySelector('[data-input-bar]');
    var attachBtn = panel.querySelector('[data-attach-btn]');
    var attachInput = panel.querySelector('[data-attach-input]');
    var attachTray = panel.querySelector('[data-attach-tray]');

    // ─── Phase 6a: Attachment UX wiring (separate domain) ───
    function renderAttachmentChip() {
      if (!attachTray) return;
      var s = attachmentStore.get();
      if (s.status === 'idle') { attachTray.hidden = true; attachTray.innerHTML = ''; return; }
      attachTray.hidden = false;
      var statusLabel = s.status === 'uploading' ? (t('uploading') || 'Uploading…')
        : s.status === 'ready' ? (t('readyToSend') || 'Ready')
        : s.status === 'error' ? (s.error || (t('uploadFailed') || 'Upload failed'))
        : (t('selected') || 'Selected');
      var sizeStr = humanSizeShell(s.sizeBytes || 0);
      // Phase 6b — honest progress: show % only while uploading; never fake 100% early.
      var pct = Math.max(0, Math.min(100, s.progress | 0));
      var subRight = s.status === 'uploading' ? (' · ' + pct + '%') : '';
      var canRetry = s.status === 'error' && !!s.file;
      attachTray.innerHTML =
        '<div class="attach-chip status-' + s.status + '">' +
          '<div class="attach-chip-meta">' +
            '<div class="attach-chip-name" title="' + Util.escapeHtml(s.fileName) + '">' + Util.escapeHtml(s.fileName) + '</div>' +
            '<div class="attach-chip-sub">' + Util.escapeHtml(statusLabel) + ' · ' + Util.escapeHtml(sizeStr) + subRight + '</div>' +
            (s.status === 'uploading'
              ? '<div class="attach-chip-progress" aria-hidden="true"><div class="attach-chip-progress-bar" style="width:' + pct + '%"></div></div>'
              : '') +
          '</div>' +
          (canRetry
            ? '<button type="button" class="attach-chip-retry" data-attach-retry aria-label="' + Util.escapeHtml(t('retry')) + '" title="' + Util.escapeHtml(t('retry')) + '">↺</button>'
            : '') +
          '<button type="button" class="attach-chip-remove" data-attach-remove aria-label="Remove">×</button>' +
        '</div>';
      var rm = attachTray.querySelector('[data-attach-remove]');
      if (rm) rm.addEventListener('click', function () { resetAttachment(); });
      var rt = attachTray.querySelector('[data-attach-retry]');
      if (rt) rt.addEventListener('click', function () {
        var cur = attachmentStore.get();
        if (cur.file) startUpload(cur.file);
      });
    }
    // Phase 6b — small helper used by both the chip & in-message file cards.
    function humanSizeShell(bytes) {
      var n = Number(bytes) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
      return (n / (1024 * 1024)).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    }
    attachmentStore.subscribe(renderAttachmentChip);

    // ─── Phase 6b — Lightbox (Shadow-DOM scoped image preview) ───
    var lightboxEl = panel.querySelector('[data-att-lightbox]');
    var lightboxImg = panel.querySelector('[data-att-lightbox-img]');
    var lightboxClose = panel.querySelector('[data-att-lightbox-close]');
    function closeLightbox() {
      if (!lightboxEl) return;
      lightboxEl.hidden = true;
      lightboxEl.classList.remove('visible');
      if (lightboxImg) { lightboxImg.removeAttribute('src'); lightboxImg.alt = ''; }
    }
    lightboxOpener = function (attachmentId) {
      if (!lightboxEl || !lightboxImg || !attachmentId) return;
      var url = (ctx.config.apiBase || '') + '/api/widget/attachments/' + encodeURIComponent(attachmentId);
      lightboxImg.src = url;
      lightboxImg.alt = '';
      lightboxEl.hidden = false;
      // Defer to next frame so transition can run
      requestAnimationFrame(function () { lightboxEl.classList.add('visible'); });
    };
    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
    if (lightboxEl) lightboxEl.addEventListener('click', function (e) {
      if (e.target === lightboxEl) closeLightbox();
    });
    // ESC closes — bound on the host document because focus may be outside the shadow root.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && lightboxEl && !lightboxEl.hidden) closeLightbox();
    });

    function startUpload(file) {
      var allowed = (attachCfg.allowedMimes || []);
      var maxBytes = (attachCfg.maxSizeMb || 10) * 1024 * 1024;
      if (allowed.indexOf(file.type) < 0) {
        attachmentStore.set({ file: null, fileName: file.name, mimeType: file.type, sizeBytes: file.size, status: 'error', error: t('typeNotAllowed') || 'File type not allowed', attachmentId: null });
        return;
      }
      if (file.size > maxBytes) {
        attachmentStore.set({ file: null, fileName: file.name, mimeType: file.type, sizeBytes: file.size, status: 'error', error: t('tooLarge') || 'File too large', attachmentId: null });
        return;
      }
      attachmentStore.set({ file: file, fileName: file.name, mimeType: file.type, sizeBytes: file.size, status: 'uploading', progress: 10, error: '', attachmentId: null });
      // Use ctx.apiBase (canonical) — ctx.config.apiBase can be undefined
      // when bootstrap stamped only _apiBase. Token-aware wrapper handles
      // 401/403 refresh transparently for both /init and /upload.
      var apiBase = ctx.apiBase || ctx.config.apiBase;
      var jsonHeaders = { 'Content-Type': 'application/json' };
      ctx.fetchWith(apiBase + '/api/widget/attachments/init', {
        method: 'POST', headers: jsonHeaders,
        body: JSON.stringify({ file_name: file.name, mime_type: file.type, size_bytes: file.size, conversation_id: chatStore.get().conversationId || null }),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }); })
        .then(function (resp) {
          if (!resp.ok || !resp.data || !resp.data.attachment_id) throw new Error((resp.data && resp.data.error) || 'init_failed');
          attachmentStore.set({ attachmentId: resp.data.attachment_id, progress: 40 });
          return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () {
              var b64 = String(reader.result || '').split(',')[1] || '';
              ctx.fetchWith(apiBase + '/api/widget/attachments/' + resp.data.attachment_id + '/upload', {
                method: 'POST', headers: jsonHeaders, body: JSON.stringify({ data: b64 }),
              }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }); }).then(resolve).catch(reject);
            };
            reader.onerror = function () { reject(new Error('read_failed')); };
            reader.readAsDataURL(file);
          });
        })
        .then(function (resp) {
          if (!resp.ok) throw new Error((resp.data && resp.data.error) || 'upload_failed');
          attachmentStore.set({ status: 'ready', progress: 100, error: '' });
        })
        .catch(function (err) {
          attachmentStore.set({ status: 'error', progress: 0, error: (err && err.message) || (t('uploadFailed') || 'Upload failed') });
        });
    }
    if (attachBtn && attachInput) {
      attachBtn.addEventListener('click', function () {
        if (attachmentStore.get().status === 'uploading') return;
        attachInput.value = ''; attachInput.click();
      });
      attachInput.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (file) startUpload(file);
      });
    }
    function syncAttachButton() {
      if (!attachBtn) return;
      var conn = transportStore.get().connectionState;
      var pState = presenceStore.get();
      var availOk = pState.liveChatEnabled !== false
        && !((pState.status === 'offline' || pState.status === 'unavailable')
          && (pState.offlineMode === 'contact_fallback' || pState.offlineMode === 'capture_message'));
      attachBtn.disabled = !(conn === 'online' && availOk);
    }
    transportStore.subscribe(syncAttachButton);
    presenceStore.subscribe(syncAttachButton);
    syncAttachButton();

    notify.attach(panel);

    // Phase 5 — presence indicator: keep header dot/label in sync with presenceStore.
    var presenceDot = panel.querySelector('[data-presence-dot]');
    var presenceLabel = panel.querySelector('[data-presence-label]');
    var presenceWrap = panel.querySelector('[data-presence]');
    function renderPresence(s) {
      if (!presenceDot || !presenceLabel || !presenceWrap) return;
      var status = s.status || 'offline';
      // sr-only kept so the row stays accessible-only — visual presence
      // is now communicated by the green dot on operator avatars.
      presenceWrap.className = 'presence sr-only status-' + status;
      presenceLabel.textContent = s.label || '';
    }
    presenceStore.subscribe(renderPresence);
    renderPresence(presenceStore.get());

    // Open immediately (user clicked launcher)
    shellStore.set({ isOpen: true, mounted: true });
    panel.classList.add('visible');

    // ─── Tab switching ───
    var tabs = panel.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        shellStore.set({ activeTab: tab.getAttribute('data-tab') });
        Array.prototype.forEach.call(tabs, function (t2) { t2.classList.remove('active'); });
        tab.classList.add('active');
        renderBody();
        // NOTE: do NOT force inputBar visibility here. renderBody() is the
        // single source of truth — it hides the composer when pre-chat is
        // required, when the offline contact-fallback form owns the input,
        // or when on the help tab. Forcing 'flex' would re-show the composer
        // for an unidentified visitor (pre-chat bypass bug).
        if (shellStore.get().activeTab === 'chat'
            && identityStore.get().loaded
            && !identity.needsPrechat()) {
          restoreDraftToInput();
        }
      });
    });

    // ─── Composer state driven by transport store ───
    function applyComposerState() {
      if (!msgInput || !sendBtn) return;
      var conn = transportStore.get().connectionState;
      // Phase 5 — composer is also gated by availability:
      //   - liveChatEnabled === false       → never enable
      //   - offline_mode === contact_fallback when offline → fallback form owns input
      var pState = presenceStore.get();
      var availOk = pState.liveChatEnabled !== false
        && !((pState.status === 'offline' || pState.status === 'unavailable')
          && (pState.offlineMode === 'contact_fallback' || pState.offlineMode === 'capture_message'));
      var canSend = conn === 'online' && shellStore.get().activeTab === 'chat' && availOk;
      msgInput.disabled = !canSend;
      sendBtn.disabled = !canSend;
      if (canSend) {
        msgInput.removeAttribute('title');
        sendBtn.style.opacity = '';
        msgInput.style.opacity = '';
      } else {
        var tip = t('offlineComposerTip');
        msgInput.setAttribute('title', tip);
        sendBtn.setAttribute('title', tip);
        sendBtn.style.opacity = '0.5';
        msgInput.style.opacity = '0.7';
      }
    }
    transportStore.subscribe(applyComposerState);
    shellStore.subscribe(applyComposerState);
    presenceStore.subscribe(applyComposerState);

    // ─── Draft preservation (in-memory only, per-conversation) ───
    // Drafts live in chatStore.drafts keyed by conversationId. Before a
    // conversation exists we use DRAFT_PENDING_KEY as a temporary scope and
    // migrate the text to the real cid as soon as one is assigned. This keeps
    // drafts isolated between conversations and survives offline/reconnect,
    // tab switches, and panel close/open within the same page session.
    // No localStorage, no cookies, no auto-resend.
    function currentDraftKey() {
      var cid = chatStore.get().conversationId;
      return cid || DRAFT_PENDING_KEY;
    }
    function getDraftFor(key) {
      var d = chatStore.get().drafts || {};
      return d[key] || '';
    }
    function setDraftFor(key, value) {
      var d = chatStore.get().drafts || {};
      if (d[key] === value) return;
      var next = {};
      for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) next[k] = d[k];
      if (value) next[key] = value; else delete next[key];
      chatStore.set({ drafts: next });
    }
    function syncDraftFromInput() {
      if (!msgInput) return;
      setDraftFor(currentDraftKey(), msgInput.value);
    }
    function restoreDraftToInput() {
      if (!msgInput) return;
      var d = getDraftFor(currentDraftKey());
      if (msgInput.value !== d) msgInput.value = d;
    }
    // ─── Visitor typing emit (throttled to ≤1 publish per 2s) ───
    // Realtime-only; if no realtime driver is active the call becomes a no-op
    // server-side and the operator simply doesn't see typing.
    var lastTypingSent = 0;
    function maybeEmitTyping() {
      var cid = chatStore.get().conversationId;
      if (!cid) return;
      if (transportStore.get().connectionState !== 'online') return;
      // Phase 6C — drop typing client-side when policy suppresses it.
      // Server-side suppression is the backstop; this just avoids the
      // round-trip when we know it'll be dropped.
      if (Policy.typingSuppressed()) return;
      var now = Date.now();
      if (now - lastTypingSent < 2000) return;
      lastTypingSent = now;
      // Backend route: PUT /api/widget/action with action='typing' publishes
      // an ephemeral envelope on ws:<workspace>:conv:<cid>. Best-effort.
      try {
        // Typing is best-effort and very high-frequency. Wrap with the
        // token manager so an expired token does not silently swallow
        // typing for the rest of the session, but still swallow errors.
        ctx.fetchWith(ctx.apiBase + '/api/widget/action', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'typing',
            workspace_id: ctx.workspaceId,
            conversation_id: cid,
            visitor_id: identityStore.get().visitorId || undefined,
            session_id: identityStore.get().sessionId || undefined,
          }),
        }).catch(function () {});
      } catch (_) {}
    }
    if (msgInput) {
      msgInput.addEventListener('input', function () { syncDraftFromInput(); maybeEmitTyping(); });
    }

    // Migrate pending draft → real conversationId the moment one is assigned.
    var __lastSeenCid = chatStore.get().conversationId;
    chatStore.subscribe(function (s) {
      if (s.conversationId && s.conversationId !== __lastSeenCid) {
        var pending = (s.drafts || {})[DRAFT_PENDING_KEY];
        if (pending && !(s.drafts || {})[s.conversationId]) {
          var next = {};
          for (var k in s.drafts) {
            if (Object.prototype.hasOwnProperty.call(s.drafts, k) && k !== DRAFT_PENDING_KEY) {
              next[k] = s.drafts[k];
            }
          }
          next[s.conversationId] = pending;
          chatStore.set({ drafts: next });
        }
        __lastSeenCid = s.conversationId;
      }
    });

    // ─── Send handler ───
    function trySend() {
      if (!msgInput) return;
      var text = msgInput.value.trim();
      var att = attachmentStore.get();
      var hasReadyAttach = att.status === 'ready' && att.attachmentId;
      if (!text && !hasReadyAttach) return;
      if (att.status === 'uploading') return; // wait for upload to finish
      if (!identityStore.get().loaded) return;
      if (transportStore.get().connectionState !== 'online') return;
      if (identity.needsPrechat()) { renderBody(); return; }
      msgInput.value = '';
      setDraftFor(currentDraftKey(), '');
      if (transport.hasCapability && transport.hasCapability('supportsTyping')) {
        transport.sendTyping({ conversationId: chatStore.get().conversationId });
      }
      var attachmentId = hasReadyAttach ? att.attachmentId : null;
      // Phase 6b — optimistic attachment shown in the bubble immediately.
      // Same id, same metadata; the server-canonical record will replace
      // it on the next poll/history merge (de-duped by message id).
      var optimisticAtt = hasReadyAttach ? {
        id: att.attachmentId,
        file_name: att.fileName,
        mime_type: att.mimeType,
        size_bytes: att.sizeBytes,
        kind: (att.mimeType && /^image\//.test(att.mimeType)) ? 'image' : 'file',
      } : null;
      if (hasReadyAttach) resetAttachment();
      chatUI.sendMessage(text, renderBody, attachmentId, optimisticAtt);
    }
    if (sendBtn) sendBtn.addEventListener('click', trySend);
    if (msgInput) msgInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); trySend(); }
    });

    // ─── Template2 — emoji picker + mic placeholder ───
    var emojiBtn = panel.querySelector('[data-emoji-btn]');
    var micBtn = panel.querySelector('[data-mic-btn]');
    var emojiPop = null;
    function closeEmojiPop() {
      if (emojiPop && emojiPop.parentNode) emojiPop.parentNode.removeChild(emojiPop);
      emojiPop = null;
      document.removeEventListener('click', onDocClickEmoji, true);
    }
    function onDocClickEmoji(e) {
      if (!emojiPop) return;
      if (emojiPop.contains(e.target) || (emojiBtn && emojiBtn.contains(e.target))) return;
      closeEmojiPop();
    }
    if (emojiBtn && msgInput) {
      emojiBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (emojiPop) { closeEmojiPop(); return; }
        var emojis = ['😀','😁','😂','🤣','😊','😍','🥰','😘','😎','🤩','🤔','😅','😉','😢','😭','😡','👍','👎','👏','🙏','💙','💚','💛','❤️','🔥','✨','🎉','✅','❌','📎','📷','📝'];
        emojiPop = document.createElement('div');
        emojiPop.className = 'emoji-pop';
        emojiPop.setAttribute('role', 'dialog');
        emojiPop.innerHTML = emojis.map(function (em) {
          return '<button type="button" class="emoji-pop-item" data-em="' + em + '">' + em + '</button>';
        }).join('');
        var inputBarEl = panel.querySelector('[data-input-bar]');
        if (inputBarEl && inputBarEl.parentNode) {
          inputBarEl.parentNode.insertBefore(emojiPop, inputBarEl);
        } else {
          panel.appendChild(emojiPop);
        }
        emojiPop.addEventListener('click', function (ev) {
          var btn = ev.target.closest('[data-em]');
          if (!btn) return;
          var em = btn.getAttribute('data-em');
          try {
            var start = msgInput.selectionStart || 0;
            var end = msgInput.selectionEnd || 0;
            var v = msgInput.value || '';
            msgInput.value = v.slice(0, start) + em + v.slice(end);
            msgInput.selectionStart = msgInput.selectionEnd = start + em.length;
          } catch (_) {
            msgInput.value = (msgInput.value || '') + em;
          }
          msgInput.focus();
          closeEmojiPop();
        });
        setTimeout(function () { document.addEventListener('click', onDocClickEmoji, true); }, 0);
      });
    }
    if (micBtn) {
      micBtn.addEventListener('click', function () {
        // Voice input not yet implemented — keep as visual control.
        try { micBtn.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.92)' }, { transform: 'scale(1)' }], { duration: 180 }); } catch (_) {}
      });
    }

    // ─── Render dispatcher ───
    function renderLoading() {
      if (body) body.innerHTML = '<div class="empty"><p>' + Util.escapeHtml(t('loading')) + '</p></div>';
    }
    // Phase 8H — Department gate. Returns true when the gate rendered
    // (caller must NOT render any further body content for this pass).
    // Resolves the channel-specific mode lazily; while in-flight shows
    // a brief loading state and re-renders on completion.
    function renderDepartmentGateIfNeeded(channel) {
      var ch = channel === 'audio' || channel === 'video' ? channel : 'chat';
      var s = departmentStore.get();
      var resolution = s.modes && s.modes[ch];
      if (!resolution) {
        // Not yet resolved — kick fetch (no-op if already inflight) and
        // show loading. When resolution arrives the subscriber re-renders.
        renderLoading();
        resolveDepartmentMode(ch);
        return true;
      }
      // General mode → never gates anything.
      if (resolution.mode === 'general') return false;
      // Single mode → resolver auto-binds selectedId. No UI step needed.
      if (resolution.mode === 'single') return false;
      // Multi mode — show selector unless visitor already picked one.
      if (s.selectedId) return false;
      renderDepartmentPicker(channel, resolution);
      return true;
    }

    var __DEPT_ICONS = {
      chat:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>',
      video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
    };
    function renderDepartmentPicker(channel, resolution) {
      if (!body) return;
      var depts = (resolution && resolution.visible_departments) || [];
      var subtitleKey = channel === 'audio'
        ? 'Choose who you would like to call'
        : channel === 'video'
          ? 'Choose who you would like to video call'
          : 'Choose a team to chat with';
      var html = '<div class="dept-picker" role="group" aria-label="Department selector">' +
        '<h3 class="dept-picker__title">How can we help?</h3>' +
        '<p class="dept-picker__subtitle">' + Util.escapeHtml(subtitleKey) + '</p>' +
        '<div class="dept-picker__list">';
      for (var i = 0; i < depts.length; i++) {
        var d = depts[i];
        if (!d || !d.id) continue;
        var caps = d.capabilities || {};
        var capHtml = '';
        if (caps.chat) capHtml += '<span class="dept-option__cap" title="Chat" aria-label="Chat">' + __DEPT_ICONS.chat + '</span>';
        if (caps.audio) capHtml += '<span class="dept-option__cap" title="Voice" aria-label="Voice">' + __DEPT_ICONS.audio + '</span>';
        if (caps.video) capHtml += '<span class="dept-option__cap" title="Video" aria-label="Video">' + __DEPT_ICONS.video + '</span>';
        html += '<button type="button" class="dept-option" data-dept-id="' + Util.escapeHtml(d.id) + '">' +
          '<span class="dept-option__name">' + Util.escapeHtml(d.name || t('team')) + '</span>' +
          '<span class="dept-option__caps" aria-hidden="true">' + capHtml + '</span>' +
        '</button>';
      }
      html += '</div></div>';
      body.innerHTML = html;
      var btns = body.querySelectorAll('[data-dept-id]');
      Array.prototype.forEach.call(btns, function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-dept-id');
          if (!id) return;
          deptSelect(id, channel);
          renderBody();
        });
      });
      // Hide composer while picker is shown.
      if (inputBar) inputBar.style.display = 'none';
    }

    // Re-render body when department state changes (mode resolves, or user
    // selects). Only redraw if currently visible to avoid wasted paints.
    departmentStore.subscribe(function () {
      if (shellStore.get().isOpen) renderBody();
    });

    // ─── Phase 3 — AI Agent pre-chat intro ───
    // Fire-and-forget POST to /api/widget/ai-agent/intro after the visitor
    // completes pre-chat. Backend is authoritative — it decides whether to
    // send (enabled + auto mode + ai_intro_enabled) and dedupes by
    // conversation/session. We additionally guard locally against double
    // calls within the same tab (re-renders, visibilitychange).
    var __aiIntroRequested = false;
    function requestAiAgentIntro(source) {
      if (__aiIntroRequested) {
        try { console.debug('[Widget AI Agent] intro skipped (already requested)'); } catch (_) {}
        return;
      }
      __aiIntroRequested = true;
      var conversationId = (chatStore.get() || {}).conversationId || null;
      var identitySnap = identityStore.get() || {};
      var sessionId = identitySnap.sessionId || identitySnap.session_id || null;
      try { console.debug('[Widget AI Agent] intro requested', { source: source || 'auto', conversationId: conversationId, sessionId: sessionId, locale: ctx.locale }); } catch (_) {}

      ctx.fetchWith(ctx.apiBase + '/api/widget/ai-agent/intro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId || undefined,
          session_id: sessionId || undefined,
          locale: ctx.locale || undefined,
        }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (resp) {
          try { console.debug('[Widget AI Agent] intro response', { sent: resp && resp.sent, reason: resp && resp.reason, messageId: resp && resp.messageId, conversationId: resp && resp.conversationId }); } catch (_) {}
          if (!resp || resp.sent !== true) {
            // Adopt conversationId even on already_sent so the next message
            // lands in the same conversation.
            if (resp && resp.conversationId && !chatStore.get().conversationId) {
              chatStore.set({ conversationId: resp.conversationId });
              try { if (transport && transport.subscribeConversation) transport.subscribeConversation(resp.conversationId); } catch (_) {}
            }
            return;
          }
          if (!resp.body) return;
          try {
            var s = chatStore.get();
            // Adopt the (possibly newly-created) conversationId so the
            // visitor's first message goes into the same conversation.
            var patch = {};
            if (resp.conversationId && resp.conversationId !== s.conversationId) {
              patch.conversationId = resp.conversationId;
            }
            var msgs = (s.messages || []).slice();
            var seenIds = Object.assign({}, s.seenIds || {});
            // ─── Dedup: skip if intro already in store ───
            var localId = resp.messageId || ('ai-intro-local-' + Date.now());
            var isDup = false;
            for (var i = 0; i < msgs.length; i++) {
              var m = msgs[i];
              var meta = m && m.metadata;
              if (m && m.__id === localId) { isDup = true; break; }
              if (meta && (meta.source === 'ai_agent_intro' || meta.source === 'ai_agent_intro_local')) {
                isDup = true;
                break;
              }
            }
            if (isDup) {
              try { console.debug('[Widget AI Agent] intro deduped'); } catch (_) {}
              if (Object.keys(patch).length) {
                chatStore.set(patch);
                try { if (patch.conversationId && transport && transport.subscribeConversation) transport.subscribeConversation(patch.conversationId); } catch (_) {}
              }
              return;
            }
            msgs.push({
              body: resp.body,
              sender: 'operator',
              senderType: 'ai',
              senderName: resp.agentName || null,
              senderAvatar: resp.agentLogoUrl || null,
              time: new Date(),
              __id: localId,
              status: null,
              metadata: { source: resp.messageId ? 'ai_agent_intro' : 'ai_agent_intro_local' },
            });
            // Mark as seen so the inevitable poll/history echo of the same
            // messageId does not duplicate the bubble.
            if (resp.messageId) seenIds[resp.messageId] = true;
            patch.messages = msgs;
            patch.seenIds = seenIds;
            chatStore.set(patch);
            try { if (patch.conversationId && transport && transport.subscribeConversation) transport.subscribeConversation(patch.conversationId); } catch (_) {}
            // Force an immediate re-render — chatStore listeners debounce
            // through renderBody, but we want zero-delay paint of the intro.
            try { renderBody(); } catch (_) {}
            try { if (body) body.scrollTop = body.scrollHeight; } catch (_) {}
            try { console.debug('[Widget AI Agent] intro rendered immediately'); } catch (_) {}
          } catch (_) {}
        })
        .catch(function (err) {
          // Reset so a future re-attempt is possible (e.g. transient network).
          __aiIntroRequested = false;
          try { console.debug('[Widget AI Agent] intro failed', err && err.message); } catch (_) {}
        });
    }

    function renderBody() {
      if (!body) return;
      // Pass 2 — when an in-panel call surface is open it owns the
      // entire body. Tabs + composer are hidden; we render the call view
      // full-bleed inside the existing .body container (Shadow DOM).
      var __cs = callSurfaceStore.get();
      if (__cs.phase !== 'idle') {
        if (inputBar) inputBar.style.display = 'none';
        try {
          var allTabs = panel.querySelectorAll('.tab');
          Array.prototype.forEach.call(allTabs, function (t2) { t2.style.display = 'none'; });
        } catch (_) {}
        renderCallSurface(body, __cs);
        return;
      }
      // Restore tab visibility when the surface is closed.
      try {
        var allTabs2 = panel.querySelectorAll('.tab');
        Array.prototype.forEach.call(allTabs2, function (t2) { t2.style.display = ''; });
      } catch (_) {}
      var tab = shellStore.get().activeTab;
      if (tab === 'chat') {
        if (!identityStore.get().loaded) { renderLoading(); return; }
        // Phase 8H — department gate (chat). Multi mode shows a lightweight
        // selector BEFORE pre-chat. Single mode auto-binds in resolver.
        // General mode is a no-op. Resolved-once-per-session via store.
        if (renderDepartmentGateIfNeeded('chat')) return;
        if (identity.needsPrechat()) {
          // Composer must be invisible while pre-chat is showing — visitor
          // cannot send a message until they've identified themselves.
          if (inputBar) inputBar.style.display = 'none';
          chatUI.renderPreChat(body, identity, ctx.locale, function () {
            // Pre-chat just submitted → reveal composer for the now-identified visitor.
            if (inputBar) inputBar.style.display = 'flex';
            renderBody();
            if (msgInput) setTimeout(function () { msgInput.focus(); }, 100);
            // Phase 3 — AI Agent pre-chat intro. Fire-and-forget; never
            // blocks the chat. Backend enforces mode/intro_enabled and
            // dedupes by (conversation_id | session_id).
            try { requestAiAgentIntro('prechat_submit'); } catch (_) {}
          });
          return;
        }
        // Identified visitor on chat tab → composer visible.
        if (inputBar) inputBar.style.display = 'flex';
        // Phase 4 — already-identified visitors (no pre-chat needed) still
        // get the AI intro the first time they open chat with no history.
        // Backend dedupes by conversation/session so it's safe to call
        // every render — the in-flight guard prevents duplicate requests.
        try {
          var __ai = ctx.config && ctx.config.aiAgent;
          var __hasMsgs = (chatStore.get().messages || []).length > 0;
          if (__ai && __ai.suppressGreeting === true && !__hasMsgs) {
            requestAiAgentIntro('chat_open');
          }
        } catch (_) {}
        // Phase 5 — when offline + contact_fallback mode and there's no
        // active thread yet, render the fallback form instead of the chat.
        var pStatus = presenceStore.get().status;
        var pMode = presenceStore.get().offlineMode;
        var hasMessages = (chatStore.get().messages || []).length > 0;
        var shouldFallback = (pStatus === 'offline' || pStatus === 'unavailable')
          && (pMode === 'contact_fallback' || pMode === 'capture_message')
          && !hasMessages;
        if (shouldFallback) {
          // Contact-fallback form owns the input area — hide the chat composer.
          if (inputBar) inputBar.style.display = 'none';
          chatUI.renderContactFallback(body, identity, ctx.locale, presenceStore.get(), function () {
            renderBody();
          });
          return;
        }
        chatUI.renderChat(body);
      } else if (tab === 'help') {
        if (inputBar) inputBar.style.display = 'none';
        kbUI.ensure(function () { kbUI.render(body); });
      }
    }

    // Pass 2 — re-render whenever the in-panel call surface changes so
    // status text, mic/cam state, and remote tracks paint immediately.
    callSurfaceStore.subscribe(function () { renderBody(); });
    // Re-render body when presence flips so fallback/normal swap takes effect.
    presenceStore.subscribe(function () {
      if (shellStore.get().activeTab === 'chat') renderBody();
    });

    // ─── Wire transport events to UI ───
    //
    // Phase 4: This is the SINGLE source of truth for incoming-message side
    // effects. We never duplicate this elsewhere. From one event we:
    //   1. merge into chat store (existing behavior)
    //   2. update unread (per-conversation + global) — skip own messages,
    //      skip duplicates by id, skip when active conversation is visible
    //   3. show in-shell toast (panel closed)
    //   4. play optional sound (if user-enabled + has interacted)
    transport.on('message', function (payload) {
      var incoming = (payload && payload.messages) || [];
      var changed = chatUI.mergeIncoming(incoming);
      if (changed && shellStore.get().activeTab === 'chat') renderBody();
      if (!incoming.length) return;

      var ns = notifyStore.get();
      var seen = ns.lastMessageIds;
      var per = {};
      for (var k in ns.perConversation) {
        if (Object.prototype.hasOwnProperty.call(ns.perConversation, k)) per[k] = ns.perConversation[k];
      }
      var seenNext = {};
      for (var sk in seen) if (Object.prototype.hasOwnProperty.call(seen, sk)) seenNext[sk] = 1;

      var activeCid = chatStore.get().conversationId;
      var panelOpen = shellStore.get().isOpen;
      var activeTab = shellStore.get().activeTab;

      var newCount = 0;
      var lastIncoming = null;

      for (var i = 0; i < incoming.length; i++) {
        var m = incoming[i] || {};
        // Skip own messages (visitor/contact = the user themselves).
        var sender = m.role || m.sender || m.sender_type || 'agent';
        if (sender === 'visitor' || sender === 'contact') continue;
        // De-dupe by stable id (prevents reconnect/poll from double-counting).
        var id = m.id || (m.time ? (m.time + ':' + (m.text || m.body || '')) : null);
        if (id) {
          if (seenNext[id]) continue;
          seenNext[id] = 1;
        }
        // Resolve cid for this message; fall back to active.
        var cid = m.conversation_id || m.conversationId || activeCid || '__default__';
        // Active conversation visible to the user → no unread bump.
        var isActiveVisible = panelOpen && activeTab === 'chat' && cid === activeCid;
        if (isActiveVisible) continue;
        per[cid] = (per[cid] || 0) + 1;
        newCount += 1;
        lastIncoming = m;
      }

      // Cap the de-dupe map so it can't grow unbounded across long sessions.
      var keys = Object.keys(seenNext);
      if (keys.length > 500) {
        var trimmed = {};
        for (var t2 = keys.length - 500; t2 < keys.length; t2++) trimmed[keys[t2]] = 1;
        seenNext = trimmed;
      }

      var total = 0;
      for (var ck in per) if (Object.prototype.hasOwnProperty.call(per, ck)) total += per[ck];
      notifyStore.set({ perConversation: per, totalUnread: total, lastMessageIds: seenNext });

      // ─── Call invitation ringtone ───────────────────────────────
      // Scan EVERY incoming message (not just newly-counted ones) for
      // system call_invitation events. Status === 'pending' starts the
      // ringtone; any other status stops it. This stays in sync whether
      // the invitation arrives fresh or as a status patch (joined /
      // expired / cancelled / declined).
      try {
        for (var ri = 0; ri < incoming.length; ri++) {
          var rm = incoming[ri] || {};
          var rmSender = rm.role || rm.sender || rm.sender_type || '';
          var rmMeta = rm.metadata || (rm.message && rm.message.metadata) || null;
          if (rmSender !== 'system' || !rmMeta || rmMeta.kind !== 'call_invitation') continue;
          if (rmMeta.status === 'pending') {
            if (notify.playRingtone) notify.playRingtone();
          } else if (notify.stopRingtone) {
            notify.stopRingtone();
          }
        }
      } catch (_) { /* never break on audio */ }

      if (newCount > 0 && lastIncoming) {
        // Toast only when the user can't see the message (panel closed or KB tab).
        var canToast = !panelOpen || (activeTab !== 'chat');
        if (canToast) {
          var senderName = lastIncoming.sender_name || lastIncoming.from_name ||
            (ctx.config.brandName || '');
          var preview = lastIncoming.text || lastIncoming.body || '';
          notify.showToast(senderName, preview);
        }
        notify.playBeep();
        // ─── Operator-initiated outreach: auto-open the panel ───
        // When the visitor receives an agent message but has never sent one
        // themselves, treat it as proactive outreach (operator clicked
        // "Start chat" from the Visitors page). Auto-open the chat panel so
        // the visitor immediately sees the incoming message instead of just
        // a launcher badge. We keep this gated to:
        //   • panel currently closed
        //   • zero visitor-authored messages in the merged history
        //   • we have an active conversation id (set by mergeIncoming via
        //     bootstrapHistory or polling's onConversation callback)
        // After the visitor replies once, this branch never fires again on
        // the same conversation (subsequent agent messages only buzz/toast).
        if (!panelOpen) {
          var msgsNow = chatStore.get().messages || [];
          var hasVisitorMsg = false;
          for (var vm = 0; vm < msgsNow.length; vm++) {
            if (msgsNow[vm].sender === 'visitor') { hasVisitorMsg = true; break; }
          }
          if (!hasVisitorMsg) {
            // Switch to chat tab + open. Mirrors the public open() path so
            // launcher state, focus, and unread clearing all behave normally.
            shellStore.set({ activeTab: 'chat', isOpen: true });
            if (launcher) launcher.classList.add('open');
            if (panel) panel.classList.add('visible');
            notify.hideToast();
            renderBody();
          }
        }
      }
    });
    transport.on('reconnect', function () {
      Util.log('transport reconnect — refreshing history');
      // Capability-gated: only call history load if the driver supports it.
      if (transport.hasCapability && transport.hasCapability('supportsHistoryLoad')) {
        chatUI.bootstrapHistory(function () {
          if (shellStore.get().activeTab === 'chat') renderBody();
        });
      }
    });
    transport.on('connectionstate', function (e) {
      Util.log('connection state →', e.state);
    });
    // Presence/typing inbound hooks — only wire if driver advertises support.
    // Under the polling driver these are no-ops; future WS/SSE drivers can
    // emit real events without UI changes.
    // Phase 5 — wire presence layer (no-op for polling, real for realtime drivers
    // that advertise supportsPresence). Always publishes initial state.
    presence.wire();
    // Typing inbound hook — only wire if driver advertises support.
    // Operator typing renders a small "Support is typing…" indicator above
    // the composer; auto-hides after 3.5s. Visitor self-echo is filtered.
    var typingHideTimer = null;
    function showOperatorTyping() {
      if (!typingRow || !typingLabel) return;
      typingLabel.textContent = t('typingOperator') || 'Support is typing…';
      typingRow.hidden = false;
      if (typingHideTimer) clearTimeout(typingHideTimer);
      typingHideTimer = setTimeout(function () {
        if (typingRow) typingRow.hidden = true;
      }, 3500);
    }
    if (transport.hasCapability && transport.hasCapability('supportsTyping')) {
      transport.on('typing', function (e) {
        var actor = e && e.payload && e.payload.actor;
        if (actor === 'visitor') return; // ignore self-echo
        showOperatorTyping();
      });
    }

    // ─── Boot sequence ───
    renderLoading();
    // Always hide the composer until identity resolves. Otherwise the
    // visitor sees an empty chat with a usable composer for one frame
    // before the pre-chat form takes over (flash of wrong UI).
    if (inputBar) inputBar.style.display = 'none';
    applyComposerState();

    // 1) Identity → 2) Transport connect → 3) History (if supported)
    identity.fetchMe(function () {
      // FSM: identity resolved → restoring_session
      if (fsm.get() === 'bootstrapping') fsm.transition('restoring_session', 'identity:resolved');
      renderBody();
      transport.connect();
      if (!identity.needsPrechat()) {
        if (transport.hasCapability && transport.hasCapability('supportsHistoryLoad')) {
          chatUI.bootstrapHistory(function () {
            if (shellStore.get().activeTab === 'chat') renderBody();
            // After history resolves, conversationId may exist — restore the
            // matching per-conversation draft into the composer.
            restoreDraftToInput();
          });
        }
        if (msgInput) setTimeout(function () {
          if (transportStore.get().connectionState === 'online') msgInput.focus();
        }, 200);
      }
    });

    // ─── Helper: clear unread for the currently-active conversation ───
    // Only the visible conversation is cleared; other conversations keep
    // their unread counts. Re-derives totalUnread from perConversation.
    function clearUnreadForActive() {
      var activeCid = chatStore.get().conversationId || '__default__';
      var ns = notifyStore.get();
      if (!ns.perConversation || !ns.perConversation[activeCid]) {
        // Still re-publish to refresh badge/title if total is stale.
        if (ns.totalUnread !== 0 && Object.keys(ns.perConversation || {}).length === 0) {
          notifyStore.set({ totalUnread: 0 });
        }
        return;
      }
      var per = {};
      for (var k in ns.perConversation) {
        if (Object.prototype.hasOwnProperty.call(ns.perConversation, k) && k !== activeCid) {
          per[k] = ns.perConversation[k];
        }
      }
      var total = 0;
      for (var ck in per) if (Object.prototype.hasOwnProperty.call(per, ck)) total += per[ck];
      notifyStore.set({ perConversation: per, totalUnread: total });
    }

    // When the user switches to the chat tab while panel is open, clear unread.
    shellStore.subscribe(function (s) {
      if (s.isOpen && s.activeTab === 'chat') clearUnreadForActive();
    });

    // ─── Public API back to loader ───
    return {
      open: function () {
        if (shellStore.get().isOpen) return;
        shellStore.set({ isOpen: true });
        if (launcher) launcher.classList.add('open');
        panel.classList.add('visible');
        // Hide any pending toast — user is now looking at the panel.
        notify.hideToast();
        // Phase 4: clear unread for the ACTIVE conversation only.
        if (shellStore.get().activeTab === 'chat') clearUnreadForActive();
        // Restore preserved draft on reopen (in-memory only)
        if (shellStore.get().activeTab === 'chat') restoreDraftToInput();
        if (msgInput && transportStore.get().connectionState === 'online' && !identity.needsPrechat()) {
          setTimeout(function () { msgInput.focus(); }, 300);
        }
      },
      close: function () {
        if (!shellStore.get().isOpen) return;
        // Capture any in-flight typed text before hiding
        syncDraftFromInput();
        shellStore.set({ isOpen: false });
        if (launcher) launcher.classList.remove('open');
        panel.classList.remove('visible');
      },
      toggle: function () {
        if (shellStore.get().isOpen) this.close(); else this.open();
      },
      setUnread: function (count) {
        // Public bridge: sets the global counter directly (loader API parity).
        notify.setUnread(count);
      },
      setSoundEnabled: function (enabled) {
        uiPrefsStore.set({ soundEnabled: !!enabled });
      },
      // Introspection for future runtime-ui modules — provider-agnostic.
      getTransportCapabilities: function () {
        return transport.getCapabilities ? transport.getCapabilities() : {};
      },
    };
  };

  window.__gs_runtime = __gs_runtime;
})();
