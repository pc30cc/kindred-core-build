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
        chat: 'Chat', help: 'Help',
        typeMsg: 'Type a message...',
        intro: "Send us a message and we'll get back to you shortly.",
        name: 'Name', email: 'Email', phone: 'Phone number',
        continue: 'Continue', back: 'Back',
        prechatIntro: 'Before we start, please share a few details so we can stay in touch.',
        required: 'required',
        invalidEmail: 'Please enter a valid email address.',
        invalidPhone: 'Please enter a valid phone number.',
        searchKb: 'Search articles...',
        noArticles: 'No articles yet',
        loading: 'Loading…',
        offline: "You're offline. Messaging is paused until the connection is back.",
        reconnecting: 'Reconnecting…',
        connecting: 'Connecting…',
        offlineComposerTip: 'Disabled while offline',
      },
      fa: {
        chat: 'گفتگو', help: 'راهنما',
        typeMsg: 'پیام خود را بنویسید...',
        intro: 'سوالی دارید؟ اینجا بنویسید.',
        name: 'نام', email: 'ایمیل', phone: 'شماره تلفن',
        continue: 'ادامه', back: 'بازگشت',
        prechatIntro: 'قبل از شروع، لطفاً اطلاعات تماس را وارد کنید تا بتوانیم در ارتباط باشیم.',
        required: 'الزامی',
        invalidEmail: 'لطفاً یک ایمیل معتبر وارد کنید.',
        invalidPhone: 'لطفاً یک شماره تلفن معتبر وارد کنید.',
        searchKb: 'جستجو در مقالات...',
        noArticles: 'مقاله‌ای یافت نشد',
        loading: 'در حال بارگذاری…',
        offline: 'اتصال شما قطع است. تا برقراری دوباره، ارسال پیام در دسترس نیست.',
        reconnecting: 'در حال اتصال مجدد…',
        connecting: 'در حال اتصال…',
        offlineComposerTip: 'در حالت آفلاین غیرفعال است',
      },
      tr: {
        chat: 'Sohbet', help: 'Yardım',
        typeMsg: 'Mesajınızı yazın...',
        intro: 'Bir soru mu var? Buraya yazın.',
        name: 'İsim', email: 'E-posta', phone: 'Telefon',
        continue: 'Devam', back: 'Geri',
        prechatIntro: 'Başlamadan önce iletişim bilgilerinizi girin.',
        required: 'zorunlu',
        invalidEmail: 'Lütfen geçerli bir e-posta girin.',
        invalidPhone: 'Lütfen geçerli bir telefon numarası girin.',
        searchKb: 'Makalelerde ara...',
        noArticles: 'Henüz makale yok',
        loading: 'Yükleniyor…',
        offline: 'Çevrimdışısınız. Bağlantı geri gelene kadar mesajlaşma duraklatıldı.',
        reconnecting: 'Yeniden bağlanılıyor…',
        connecting: 'Bağlanıyor…',
        offlineComposerTip: 'Çevrimdışıyken devre dışı',
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
  function createTransport(ctx, transportStore) {
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

    function setConnectionState(next) {
      var prev = transportStore.get().connectionState;
      if (prev === next) return;
      transportStore.set({ connectionState: next, lastConnectionChange: Date.now() });
      emit('connectionstate', { state: next, previous: prev });
      if (next === 'online' && (prev === 'reconnecting' || prev === 'offline')) {
        emit('reconnect', {});
      }
    }

    // ─── Polling driver (default and only real transport in Phase 2) ───
    var pollingHandle = null;
    var lastSuccessAt = 0;
    var consecutiveFailures = 0;
    var browserOnline = (typeof navigator !== 'undefined' && 'onLine' in navigator) ? navigator.onLine : true;
    var subscribedConversation = null;
    var historyLoaded = false;

    function ensureChatModule(cb) {
      if (ModuleLoader.modules.chat) return cb(ModuleLoader.modules.chat);
      var url = (ctx.assetBase || '') + '/widget/runtime-chat.js?v=' +
        (ctx.config._loaderVersion || ctx.config.loaderVersion || 'dev');
      ModuleLoader.load('chat', url, function (mod) { cb(mod); });
    }

    function loadHistory(opts) {
      ensureChatModule(function (mod) {
        if (!mod || !mod.loadHistory) {
          // Module unavailable counts as a failure signal for connection state
          markPollFailure();
          if (opts && opts.onResult) opts.onResult({ conversationId: null, messages: [] });
          return;
        }
        mod.loadHistory({
          apiBase: ctx.apiBase,
          workspaceId: ctx.workspaceId,
          sessionToken: ctx.sessionToken,
          onResult: function (result) {
            historyLoaded = true;
            // A successful history response is real backend reachability proof
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
          conversationId: payload.conversationId,
          text: payload.text,
          onConversation: function (cid) {
            if (cid) subscribedConversation = cid;
            if (hooks.onConversation) hooks.onConversation(cid);
          },
          onReply: function (reply) {
            if (hooks.onReply) hooks.onReply(reply);
            // Treat a successful send as a healthy connection signal
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
      // Only flip to online on actual successful backend communication.
      if (browserOnline) setConnectionState('online');
    }
    function markPollFailure() {
      consecutiveFailures += 1;
      if (!browserOnline) {
        setConnectionState('offline');
        return;
      }
      var cur = transportStore.get().connectionState;
      // First failure during initial connect → reconnecting (not online).
      // Subsequent failures while we were online → reconnecting after 2 in a row.
      if (cur === 'connecting') {
        setConnectionState('reconnecting');
      } else if (cur === 'online' && consecutiveFailures >= 2) {
        setConnectionState('reconnecting');
      } else if (cur === 'reconnecting') {
        // stay reconnecting
      }
    }

    function subscribeConversation(cid) {
      if (!cid || subscribedConversation === cid) return;
      subscribedConversation = cid;
      // Polling already keys on subscribedConversation through getConversationId
    }
    function unsubscribeConversation(cid) {
      if (subscribedConversation === cid) subscribedConversation = null;
    }

    function startPolling() {
      ensureChatModule(function (mod) {
        if (!mod || !mod.startPolling) return;
        if (pollingHandle && pollingHandle.stop) pollingHandle.stop();
        pollingHandle = mod.startPolling({
          apiBase: ctx.apiBase,
          workspaceId: ctx.workspaceId,
          sessionToken: ctx.sessionToken,
          interval: 4000,
          getConversationId: function () { return subscribedConversation; },
          onConversation: function (cid) {
            if (cid) subscribedConversation = cid;
          },
          onMessages: function (msgs) {
            markPollSuccess();
            if (msgs && msgs.length) emit('message', { messages: msgs });
          },
          // Optional success/error hooks if module supports them; safe if ignored
          onTick: function (ok) { if (ok) markPollSuccess(); else markPollFailure(); },
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
      // Don't mark online — wait for real successful poll/load.
      setConnectionState('reconnecting');
    }
    function handleBrowserOffline() {
      browserOnline = false;
      setConnectionState('offline');
    }

    function connect() {
      // Stay in 'connecting' until first successful backend response
      // (loadHistory or poll). Do NOT flip to online based on navigator.onLine.
      consecutiveFailures = 0;
      lastSuccessAt = 0;
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('online', handleBrowserOnline);
        window.addEventListener('offline', handleBrowserOffline);
      }
      if (!browserOnline) {
        setConnectionState('offline');
      } else {
        setConnectionState('connecting');
      }
      startPolling();
    }
    function disconnect() {
      stopPolling();
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('online', handleBrowserOnline);
        window.removeEventListener('offline', handleBrowserOffline);
      }
      setConnectionState('idle');
    }

    // ─── Typing / presence — no-op hooks under polling.
    // Future WS/SSE driver implements them; UI already calls them.
    function sendTyping(_payload) { /* no-op under polling */ }

    // ─── Capabilities (provider-agnostic). Future drivers (WS/SSE/Centrifugo)
    // implement the same shape so UI modules can guard optional behavior.
    var capabilities = {
      driver: 'polling',
      supportsRealtime: false,
      supportsTyping: false,
      supportsPresence: false,
      supportsHistoryLoad: true,
      supportsReconnectSignals: true,
    };

    return {
      // lifecycle
      connect: connect,
      disconnect: disconnect,
      // subscriptions
      subscribeConversation: subscribeConversation,
      unsubscribeConversation: unsubscribeConversation,
      // actions
      sendMessage: sendMessage,
      sendTyping: sendTyping,
      loadHistory: loadHistory,
      // events
      on: on,
      // introspection
      getDriverName: function () { return capabilities.driver; },
      getCapabilities: function () {
        // Return a shallow copy so callers can't mutate the driver contract.
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
      fetch(
        ctx.apiBase + '/api/widget/identity/me?workspace_id=' + encodeURIComponent(ctx.workspaceId),
        {
          credentials: 'include',
          headers: { 'X-Widget-Token': ctx.sessionToken || '' },
        }
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
      fetch(ctx.apiBase + '/api/widget/identity/prechat', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Widget-Token': ctx.sessionToken || '',
        },
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
      if (!s.prechat.ask_name && !s.prechat.ask_email && !s.prechat.ask_phone) return false;
      return !!(s.prechat.require_name || s.prechat.require_email || s.prechat.require_phone);
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
  // UI.Notify — connection banner + unread badge
  // ════════════════════════════════════════════════════════════════════
  function createNotify(ctx, transportStore, t) {
    var bannerEl = null;

    function attach(panel) {
      bannerEl = document.createElement('div');
      bannerEl.className = 'connection-banner';
      bannerEl.setAttribute('role', 'status');
      bannerEl.setAttribute('aria-live', 'polite');
      // Insert just below the header
      var header = panel.querySelector('.header');
      if (header && header.nextSibling) {
        panel.insertBefore(bannerEl, header.nextSibling);
      } else {
        panel.insertBefore(bannerEl, panel.firstChild);
      }
      transportStore.subscribe(render);
      render(transportStore.get());
    }

    function render(state) {
      if (!bannerEl) return;
      var s = state.connectionState;
      if (s === 'online' || s === 'idle') {
        bannerEl.className = 'connection-banner';
        bannerEl.textContent = '';
        return;
      }
      var label = '';
      var cls = 'connection-banner visible';
      var withDot = true;
      if (s === 'offline') { label = t('offline'); cls += ' offline'; }
      else if (s === 'reconnecting') { label = t('reconnecting'); cls += ' reconnecting'; }
      else if (s === 'connecting') { label = t('connecting'); cls += ' connecting'; }
      bannerEl.className = cls;
      // Light DOM rebuild — dot + label. Honest & static, no countdown timers.
      bannerEl.innerHTML = '';
      if (withDot) {
        var dot = document.createElement('span');
        dot.className = 'conn-dot';
        dot.setAttribute('aria-hidden', 'true');
        bannerEl.appendChild(dot);
      }
      var span = document.createElement('span');
      span.textContent = label;
      bannerEl.appendChild(span);
    }

    return {
      attach: attach,
      setUnread: function (count) { if (ctx.shell.setUnread) ctx.shell.setUnread(count); },
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

    function mergeIncoming(incoming) {
      if (!incoming || !incoming.length) return false;
      var s = chatStore.get();
      var messages = s.messages.slice();
      var seenIds = Object.assign({}, s.seenIds);
      var changed = false;

      incoming.forEach(function (m) {
        var id = m.id || (m.time + ':' + (m.text || m.body || ''));
        if (seenIds[id]) return;
        seenIds[id] = true;
        var senderRaw = m.role || m.sender || m.sender_type || 'agent';
        var sender = (senderRaw === 'visitor' || senderRaw === 'contact') ? 'visitor' : 'operator';
        var text = m.text || m.body || '';
        if (sender === 'visitor') {
          var dup = messages.some(function (lm) {
            return lm.sender === 'visitor' && lm.body === text && !lm.__id;
          });
          if (dup) {
            for (var i = 0; i < messages.length; i++) {
              if (messages[i].sender === 'visitor' && messages[i].body === text && !messages[i].__id) {
                messages[i].__id = id;
                break;
              }
            }
            return;
          }
        }
        messages.push({
          body: text,
          sender: sender,
          time: m.time ? new Date(m.time) : new Date(),
          __id: id,
        });
        changed = true;
      });

      if (changed) chatStore.set({ messages: messages, seenIds: seenIds });
      return changed;
    }

    function renderEmpty(body) {
      body.innerHTML =
        '<div class="empty">' +
        '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
        '<p>' + Util.escapeHtml(t('intro')) + '</p></div>';
    }

    function renderChat(body) {
      var s = chatStore.get();
      if (!s.messages.length) { renderEmpty(body); return; }
      var html = '<div class="messages">';
      s.messages.forEach(function (m) {
        var bg = m.sender === 'visitor' ? 'style="background:' + ctx.primaryColor + '"' : '';
        var cls = m.sender === 'visitor' ? 'visitor' : 'operator';
        html += '<div class="msg ' + cls + '" ' + bg + '>' + Util.escapeHtml(m.body) + '</div>';
      });
      html += '</div>';
      body.innerHTML = html;
      body.scrollTop = body.scrollHeight;
    }

    function renderPreChat(body, identity, locale, onSubmitted) {
      var contact = (identityStore.get().contact) || {};
      function fieldRow(key, type, value) {
        var label = t(key);
        var req = identity.isRequired(key);
        var labelHtml = '<label class="prechat-label">' + Util.escapeHtml(label) +
          (req ? ' <span class="prechat-required">*</span>' : '') + '</label>';
        return '<div>' + labelHtml +
          '<input class="input" data-prechat="' + key + '" type="' + type + '" autocomplete="' +
          (key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel') +
          '" placeholder="' + Util.escapeHtml(label) + '" value="' + Util.escapeHtml(value || '') + '" />' +
          '<div class="prechat-error" data-err="' + key + '"></div>' +
        '</div>';
      }

      var fieldsHtml = '';
      if (identity.isAsked('name')) fieldsHtml += fieldRow('name', 'text', contact.name);
      if (identity.isAsked('email')) fieldsHtml += fieldRow('email', 'email', contact.email);
      if (identity.isAsked('phone')) fieldsHtml += fieldRow('phone', 'tel', contact.phone);

      var dir = locale === 'fa' ? 'rtl' : 'ltr';
      body.innerHTML =
        '<div class="prechat" dir="' + dir + '">' +
        '<p class="prechat-intro">' + Util.escapeHtml(t('prechatIntro')) + '</p>' +
        '<div class="prechat-fields">' + fieldsHtml + '</div>' +
        '<button type="button" class="prechat-submit" data-prechat-submit>' + Util.escapeHtml(t('continue')) + '</button>' +
        '</div>';

      function getInput(key) { return body.querySelector('[data-prechat="' + key + '"]'); }
      function clearError(key) {
        var el = body.querySelector('[data-err="' + key + '"]');
        if (el) { el.classList.remove('visible'); el.textContent = ''; }
      }
      function showError(key, msg) {
        var el = body.querySelector('[data-err="' + key + '"]');
        if (el) { el.textContent = msg; el.classList.add('visible'); }
      }
      ['name', 'email', 'phone'].forEach(function (k) {
        var input = getInput(k);
        if (input) input.addEventListener('input', function () { clearError(k); });
      });

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

    function sendMessage(text, onChange) {
      // Hard guard: never send while not online
      var conn = transportStore.get().connectionState;
      if (conn !== 'online') return;

      var s = chatStore.get();
      var messages = s.messages.slice();
      messages.push({ body: text, sender: 'visitor', time: new Date() });
      chatStore.set({ messages: messages });
      onChange();

      transport.sendMessage(
        { text: text, conversationId: s.conversationId },
        {
          onConversation: function (cid) {
            if (cid && cid !== chatStore.get().conversationId) {
              chatStore.set({ conversationId: cid });
              transport.subscribeConversation(cid);
            }
          },
          onReply: function (reply) {
            var ns = chatStore.get();
            var arr = ns.messages.slice();
            arr.push({ body: reply, sender: 'operator', time: new Date() });
            chatStore.set({ messages: arr });
            onChange();
          },
          onError: function () { Util.warn('Send failed'); },
        }
      );
    }

    function bootstrapHistory(onChange) {
      transport.loadHistory({
        onResult: function (result) {
          if (result.conversationId) {
            chatStore.set({ conversationId: result.conversationId });
            transport.subscribeConversation(result.conversationId);
          }
          if (mergeIncoming(result.messages || [])) onChange();
        },
      });
    }

    return {
      renderChat: renderChat,
      renderPreChat: renderPreChat,
      sendMessage: sendMessage,
      bootstrapHistory: bootstrapHistory,
      mergeIncoming: mergeIncoming,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // UI.KB
  // ════════════════════════════════════════════════════════════════════
  function createKbUI(deps) {
    var ctx = deps.ctx;
    var t = deps.t;
    var kbStore = deps.kbStore;

    function moduleUrl() {
      var base = ctx.assetBase || '';
      return base + '/widget/runtime-kb.js?v=' + (ctx.config._loaderVersion || ctx.config.loaderVersion || 'dev');
    }

    function ensure(cb) {
      var s = kbStore.get();
      if (s.loaded) return cb();
      ModuleLoader.load('kb', moduleUrl(), function () {
        var mod = ModuleLoader.modules.kb;
        if (mod && mod.loadArticles) {
          mod.loadArticles({
            apiBase: ctx.apiBase,
            workspaceId: ctx.workspaceId,
            sessionToken: ctx.sessionToken,
            locale: ctx.locale,
            onArticles: function (a) {
              kbStore.set({ loaded: true, articles: a });
              cb();
            },
          });
        } else {
          kbStore.set({ loaded: true });
          cb();
        }
      });
    }

    function render(body) {
      var s = kbStore.get();
      var html = '<input class="kb-search" type="search" placeholder="' + Util.escapeHtml(t('searchKb')) + '" />';
      if (!s.articles.length) {
        html += '<div class="empty"><p>' + Util.escapeHtml(t('noArticles')) + '</p></div>';
      } else {
        s.articles.forEach(function (a) {
          html +=
            '<div class="kb-article">' +
            '<div class="kb-article-title">' + Util.escapeHtml(a.title) + '</div>' +
            '<div class="kb-article-excerpt">' + Util.escapeHtml(a.excerpt || '') + '</div></div>';
        });
      }
      body.innerHTML = html;
    }

    return { ensure: ensure, render: render };
  }

  // ════════════════════════════════════════════════════════════════════
  // Core — orchestrates everything inside the shadow root
  // ════════════════════════════════════════════════════════════════════
  __gs_runtime.init = function (config, shell) {
    Util.debug = !!config.debugMode;
    Util.log('Runtime init (Shadow DOM, Phase 2)');

    var shadowRoot = (shell && shell.shadowRoot) || (shell && shell.shellEl && shell.shellEl.shadowRoot) || null;
    if (!shell || !shadowRoot) {
      Util.warn('FATAL: no shadowRoot provided by loader');
      return { open: function(){}, close: function(){}, toggle: function(){}, setUnread: function(){} };
    }

    var ctx = {
      config: config,
      apiBase: config._apiBase || config.apiBase || '',
      assetBase: config._assetBase || config.assetBase || '',
      workspaceId: config.workspaceId || '',
      sessionToken: config._sessionToken || '',
      locale: config.locale || 'en',
      primaryColor: config.primaryColor || '#3B82F6',
      shell: shell,
    };
    var t = function (key) { return I18n.t(ctx.locale, key); };

    var chatEnabled = config.features && config.features.chat !== false;
    var kbEnabled = config.features && config.features.knowledgeBase;

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
    var launcher = shell.launcher;

    // ─── Domain stores (each one isolated, with pub/sub) ───
    var shellStore = createStore({
      isOpen: false,
      activeTab: chatEnabled ? 'chat' : (kbEnabled ? 'help' : 'chat'),
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
    var kbStore = createStore({
      loaded: false,
      articles: [],
    });
    var notifyStore = createStore({
      unread: 0,
    });
    var uiPrefsStore = createStore({
      position: config.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
    });

    // ─── Layers ───
    var transport = createTransport(ctx, transportStore);
    var identity = createIdentity(ctx, identityStore);
    var chatUI = createChatUI({
      ctx: ctx, t: t,
      chatStore: chatStore,
      identityStore: identityStore,
      transportStore: transportStore,
      transport: transport,
    });
    var kbUI = createKbUI({ ctx: ctx, t: t, kbStore: kbStore });
    var notify = createNotify(ctx, transportStore, t);

    // ─── Build panel ───
    var posClass = uiPrefsStore.get().position;
    var brandName = config.brandName || '';
    var welcomeMessage = config.welcomeMessage || 'Hi there 👋\nHow can we help you today?';

    var existingPanel = shadowRoot.querySelector ? shadowRoot.querySelector('.panel') : null;
    if (existingPanel && existingPanel.parentNode) existingPanel.parentNode.removeChild(existingPanel);

    var panel = document.createElement('div');
    panel.className = 'panel ' + posClass;

    var headerHtml = '<div class="header">' +
      '<div class="header-title">' + Util.escapeHtml(brandName || 'Support') + '</div>' +
      '<div class="header-subtitle">' + Util.escapeHtml(welcomeMessage).replace(/\n/g, '<br>') + '</div>' +
      '</div>';
    var tabsHtml = '';
    if (chatEnabled && kbEnabled) {
      tabsHtml = '<div class="tabs">' +
        '<button type="button" class="tab' + (shellStore.get().activeTab === 'chat' ? ' active' : '') + '" data-tab="chat">' + Util.escapeHtml(t('chat')) + '</button>' +
        '<button type="button" class="tab' + (shellStore.get().activeTab === 'help' ? ' active' : '') + '" data-tab="help">' + Util.escapeHtml(t('help')) + '</button>' +
        '</div>';
    }
    var bodyHtml = '<div class="body" data-body></div>';
    var inputHtml = chatEnabled
      ? '<div class="input-bar" data-input-bar>' +
        '<input class="input" data-msg-input placeholder="' + Util.escapeHtml(t('typeMsg')) + '" />' +
        '<button type="button" class="send-btn" data-send-btn style="background:' + ctx.primaryColor + '">' +
        '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
        '</button></div>'
      : '';
    var poweredHtml = brandName
      ? '<div class="powered">Powered by <a href="#">' + Util.escapeHtml(brandName) + '</a></div>'
      : '';

    panel.innerHTML = headerHtml + tabsHtml + bodyHtml + inputHtml + poweredHtml;
    shellDiv.appendChild(panel);

    var body = panel.querySelector('[data-body]');
    var msgInput = panel.querySelector('[data-msg-input]');
    var sendBtn = panel.querySelector('[data-send-btn]');
    var inputBar = panel.querySelector('[data-input-bar]');

    notify.attach(panel);

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
        if (inputBar) inputBar.style.display = shellStore.get().activeTab === 'chat' ? 'flex' : 'none';
        // Restore preserved draft when returning to chat tab
        if (shellStore.get().activeTab === 'chat') restoreDraftToInput();
      });
    });

    // ─── Composer state driven by transport store ───
    function applyComposerState() {
      if (!msgInput || !sendBtn) return;
      var conn = transportStore.get().connectionState;
      var canSend = conn === 'online' && shellStore.get().activeTab === 'chat';
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
    if (msgInput) {
      msgInput.addEventListener('input', syncDraftFromInput);
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
      if (!text) return;
      if (!identityStore.get().loaded) return;
      // Hard guard: never send while not online. Draft remains preserved.
      if (transportStore.get().connectionState !== 'online') return;
      if (identity.needsPrechat()) { renderBody(); return; }
      msgInput.value = '';
      // Clear draft for the active conversation scope (per-conversation).
      setDraftFor(currentDraftKey(), '');
      // Typing hook (no-op under polling, ready for realtime drivers).
      // Capability-gated so UI never assumes typing support.
      if (transport.hasCapability && transport.hasCapability('supportsTyping')) {
        transport.sendTyping({ conversationId: chatStore.get().conversationId });
      }
      chatUI.sendMessage(text, renderBody);
    }
    if (sendBtn) sendBtn.addEventListener('click', trySend);
    if (msgInput) msgInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); trySend(); }
    });

    // ─── Render dispatcher ───
    function renderLoading() {
      if (body) body.innerHTML = '<div class="empty"><p>' + Util.escapeHtml(t('loading')) + '</p></div>';
    }
    function renderBody() {
      if (!body) return;
      var tab = shellStore.get().activeTab;
      if (tab === 'chat') {
        if (!identityStore.get().loaded) { renderLoading(); return; }
        if (identity.needsPrechat()) {
          chatUI.renderPreChat(body, identity, ctx.locale, function () {
            renderBody();
            if (msgInput) setTimeout(function () { msgInput.focus(); }, 100);
          });
          return;
        }
        chatUI.renderChat(body);
      } else if (tab === 'help') {
        kbUI.ensure(function () { kbUI.render(body); });
      }
    }

    // ─── Wire transport events to UI ───
    transport.on('message', function (payload) {
      if (chatUI.mergeIncoming(payload.messages)) {
        if (shellStore.get().activeTab === 'chat') renderBody();
        if (!shellStore.get().isOpen) {
          var n = notifyStore.get().unread + (payload.messages || []).length;
          notifyStore.set({ unread: n });
          notify.setUnread(n);
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
    if (transport.hasCapability && transport.hasCapability('supportsPresence')) {
      transport.on('presence', function (_e) { /* future: render presence */ });
    }
    if (transport.hasCapability && transport.hasCapability('supportsTyping')) {
      transport.on('typing', function (_e) { /* future: render typing indicator */ });
    }

    // ─── Boot sequence ───
    renderLoading();
    if (inputBar && shellStore.get().activeTab !== 'chat') inputBar.style.display = 'none';
    applyComposerState();

    // 1) Identity → 2) Transport connect → 3) History (if supported)
    identity.fetchMe(function () {
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

    // ─── Public API back to loader ───
    return {
      open: function () {
        if (shellStore.get().isOpen) return;
        shellStore.set({ isOpen: true });
        if (launcher) launcher.classList.add('open');
        panel.classList.add('visible');
        // Clear unread on open
        notifyStore.set({ unread: 0 });
        notify.setUnread(0);
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
        notifyStore.set({ unread: count });
        notify.setUnread(count);
      },
      // Introspection for future runtime-ui modules — provider-agnostic.
      getTransportCapabilities: function () {
        return transport.getCapabilities ? transport.getCapabilities() : {};
      },
    };
  };

  window.__gs_runtime = __gs_runtime;
})();
