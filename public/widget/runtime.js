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

    // Kick off proactive timer immediately.
    scheduleProactiveRefresh();

    return {
      get: get,
      onChange: onChange,
      refresh: refresh,
      fetchWith: fetchWith,
      destroy: destroy,
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

    // ─── Transport state shared by polling + realtime drivers ───
    var pollingHandle = null;
    var lastSuccessAt = 0;
    var consecutiveFailures = 0;
    var browserOnline = (typeof navigator !== 'undefined' && 'onLine' in navigator) ? navigator.onLine : true;
    var subscribedConversation = null;
    var historyLoaded = false;

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
      if (rtDriver && rtDriver.subscribeConversation) rtDriver.subscribeConversation(cid);
    }
    function unsubscribeConversation(cid) {
      if (subscribedConversation === cid) subscribedConversation = null;
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
            rtDriver = null;
            capabilities.driver = 'polling';
            capabilities.supportsRealtime = false;
            capabilities.supportsTyping = false;
            capabilities.supportsPresence = false;
            if (fallbackPolicy === 'lenient') startPolling();
            else setConnectionState('offline');
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
                  onConnectionState: function (s) { setConnectionState(s); },
                  onMessage: function (e) { emit('message', e); },
                  onTyping: function (e) { emit('typing', e); },
                  onPresence: function (e) { emit('presence', e); },
                  onReconnect: function () { emit('reconnect', {}); },
                  fallbackToPolling: fallback,
                });
                rtDriver.connect();
                if (subscribedConversation) rtDriver.subscribeConversation(subscribedConversation);
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
      resolveRealtimeAndStart();
    }
    function disconnect() {
      stopPolling();
      if (rtDriver && rtDriver.disconnect) {
        try { rtDriver.disconnect(); } catch (_) {}
        rtDriver = null;
      }
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('online', handleBrowserOnline);
        window.removeEventListener('offline', handleBrowserOffline);
      }
      setConnectionState('idle');
    }

    // ─── Typing — delegated to realtime driver if available, no-op otherwise.
    function sendTyping(payload) {
      if (rtDriver && rtDriver.sendTyping) rtDriver.sendTyping(payload);
    }

    return {
      connect: connect,
      disconnect: disconnect,
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
    function playBeep() {
      if (!uiPrefsStore.get().soundEnabled) return;
      if (!userInteracted) return;
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!audioCtx) audioCtx = new Ctx();
        var t0 = audioCtx.currentTime;
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, t0);
        osc.frequency.exponentialRampToValueAtTime(660, t0 + 0.12);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.2);
      } catch (_) { /* never break on audio */ }
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
      var name = senderName ? String(senderName) : (ctx.config.brandName || 'Support');
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
      if (s === 'online' || s === 'idle') {
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
          return;
        }
        seenIds[id] = true;

        if (sender === 'visitor') {
          // Reconcile with optimistic bubble (text match, no canonical id yet).
          var dupIdx = -1;
          for (var d = 0; d < messages.length; d++) {
            if (messages[d].sender === 'visitor' && messages[d].body === text && !messages[d].__id) {
              dupIdx = d; break;
            }
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
      var welcome = (ctx.config && typeof ctx.config.welcomeMessage === 'string' && ctx.config.welcomeMessage.trim().length > 0)
        ? ctx.config.welcomeMessage
        : t('intro');
      var lines = String(welcome).split(/\n+/).map(function (l) {
        return Util.escapeHtml(l);
      }).join('<br>');
      body.innerHTML =
        '<div class="messages welcome-only">' +
          '<div class="msg-row operator">' +
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
      s.messages.forEach(function (m, idx) {
        var bg = m.sender === 'visitor' ? 'style="background:' + ctx.primaryColor + '"' : '';
        var cls = m.sender === 'visitor' ? 'visitor' : 'operator';
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
        html += '<div class="msg-row ' + cls + '">' +
          '<div class="msg ' + cls + extraCls + '" ' + bg + '>' +
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
        var badge = req
          ? '<span class="prechat-badge req">' + Util.escapeHtml(t('required')) + '</span>'
          : '<span class="prechat-badge opt">' + Util.escapeHtml(t('prechatOptional')) + '</span>';
        var ac = key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel';
        var inputDir = key === 'email' || key === 'phone' ? 'ltr' : '';
        return '<div class="prechat-field" data-field="' + key + '">' +
            '<div class="prechat-row">' +
              '<label class="prechat-label" for="prechat-' + key + '">' + Util.escapeHtml(label) + '</label>' +
              badge +
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
        { text: text, conversationId: s.conversationId, attachmentId: attachmentId || null },
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
      if (s.loaded) return cb && cb();
      ModuleLoader.load('kb', moduleUrl(), function () {
        var mod = ModuleLoader.modules.kb;
        if (mod && mod.loadCategories) {
          mod.loadCategories({
            apiBase: ctx.apiBase,
            workspaceId: ctx.workspaceId,
            sessionToken: ctx.sessionToken,
            locale: ctx.locale,
            onResult: function (r) {
              kbStore.set({ loaded: true, categories: r.categories || [] });
              cb && cb();
            },
          });
        } else {
          kbStore.set({ loaded: true, categories: [] });
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
          html += '<div class="kb-empty">' +
            '<p>' + Util.escapeHtml(t('kbZeroResults')) + '</p>' +
            '<button type="button" class="kb-cta" data-kb-action="switch-chat">' +
              Util.escapeHtml(t('kbSwitchToChat')) +
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
        // 'list' — categories + (no search)
        var cats = s.categories || [];
        if (!cats.length) {
          html += '<div class="kb-empty"><p>' + Util.escapeHtml(t('noArticles')) + '</p>' +
            '<button type="button" class="kb-cta" data-kb-action="switch-chat">' +
              Util.escapeHtml(t('kbSwitchToChat')) +
            '</button></div>';
        } else {
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

  // Expose for debugging / future runtime template registration from outside.
  __gs_runtime.templates = TemplateRegistry;

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

    // ─── Token manager (Task 2): proactive refresh + reactive 401/403 retry.
    // Wraps every authenticated widget request. ctx.sessionToken stays as a
    // *snapshot* for backward compatibility, but ctx.fetchWith is the real
    // path used by all new code and by the chat/kb modules below.
    var tokenMgr = createTokenManager(ctx.sessionToken, ctx.apiBase);
    tokenMgr.onChange(function (t) { ctx.sessionToken = t; });
    ctx.fetchWith = tokenMgr.fetchWith;
    ctx.getToken = tokenMgr.get;
    ctx.tokenManager = tokenMgr;
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
      categories: [],
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
      soundEnabled: !!(config.features && config.features.notificationSound) || false,
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
    var transport = createTransport(ctx, transportStore);
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
        renderBody();
        if (inputBar) inputBar.style.display = 'flex';
        restoreDraftToInput();
        if (msgInput) { try { msgInput.focus(); } catch (_) {} }
      },
    });
    var notify = createNotify(ctx, transportStore, notifyStore, uiPrefsStore, shellStore, t);
    var presence = createPresence(ctx, presenceStore, transport, transportStore, t);

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
      '<div class="presence" data-presence aria-live="polite">' +
        '<span class="presence-dot" data-presence-dot></span>' +
        '<span class="presence-label" data-presence-label></span>' +
      '</div>' +
      '</div>';
    var tabsHtml = '';
    if (chatEnabled && kbEnabled) {
      tabsHtml = '<div class="tabs">' +
        '<button type="button" class="tab' + (shellStore.get().activeTab === 'chat' ? ' active' : '') + '" data-tab="chat">' + Util.escapeHtml(t('chat')) + '</button>' +
        '<button type="button" class="tab' + (shellStore.get().activeTab === 'help' ? ' active' : '') + '" data-tab="help">' + Util.escapeHtml(t('help')) + '</button>' +
        '</div>';
    }
    var bodyHtml = '<div class="body" data-body></div>';
    var attachCfg = (ctx.config && ctx.config.attachments) || { enabled: false };
    var inputHtml = chatEnabled
      ? '<div class="typing-row" data-typing-row hidden aria-live="polite">' +
          '<span class="typing-dots"><span></span><span></span><span></span></span>' +
          '<span class="typing-label" data-typing-label></span>' +
        '</div>' +
        '<div class="attach-tray" data-attach-tray hidden></div>' +
        '<div class="input-bar" data-input-bar>' +
        (attachCfg.enabled
          ? '<button type="button" class="attach-btn" data-attach-btn title="' + Util.escapeHtml(t('attachFile') || 'Attach file') + '" aria-label="' + Util.escapeHtml(t('attachFile') || 'Attach file') + '">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
            '</button>' +
            '<input type="file" data-attach-input hidden accept="' + (attachCfg.allowedMimes || []).join(',') + '" />'
          : '') +
        '<input class="input" data-msg-input placeholder="' + Util.escapeHtml(t('typeMsg')) + '" />' +
        '<button type="button" class="send-btn" data-send-btn style="background:' + ctx.primaryColor + '">' +
        '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
        '</button>' +
        '</div>'
      : '';
    var poweredHtml = brandName
      ? '<div class="powered">Powered by <a href="#">' + Util.escapeHtml(brandName) + '</a></div>'
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
      presenceWrap.className = 'presence status-' + status;
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
        if (inputBar) inputBar.style.display = shellStore.get().activeTab === 'chat' ? 'flex' : 'none';
        // Restore preserved draft when returning to chat tab
        if (shellStore.get().activeTab === 'chat') restoreDraftToInput();
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
          // Composer must be invisible while pre-chat is showing — visitor
          // cannot send a message until they've identified themselves.
          if (inputBar) inputBar.style.display = 'none';
          chatUI.renderPreChat(body, identity, ctx.locale, function () {
            // Pre-chat just submitted → reveal composer for the now-identified visitor.
            if (inputBar) inputBar.style.display = 'flex';
            renderBody();
            if (msgInput) setTimeout(function () { msgInput.focus(); }, 100);
          });
          return;
        }
        // Identified visitor on chat tab → composer visible.
        if (inputBar) inputBar.style.display = 'flex';
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
