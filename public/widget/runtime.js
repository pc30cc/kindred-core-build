/**
 * Widget Runtime v4 — Shadow DOM aware, internal layered architecture.
 *
 * External shape unchanged: ships as one runtime.js file (plus the lazy
 * runtime-chat.js / runtime-kb.js modules). Internally split into namespaces:
 *
 *   Core         — shell lifecycle, panel mount/open/close, view switching
 *   Identity     — visitor identity / pre-chat policy / continuity hooks
 *   UI.Chat      — chat list + composer rendering
 *   UI.KB        — knowledge base UI
 *   UI.Notify    — unread badge / inline status messages
 *
 * Cookie-based identity (HttpOnly `dvsid`) is unchanged. `credentials: 'include'`
 * on every API call. No localStorage. No client-side trust expansion.
 *
 * The loader hands us:
 *   shell.shadowRoot — where ALL UI must render
 *   shell.launcher   — launcher button (in the shadow root)
 *   shell.setUnread  — badge updater
 *
 * Public API returned to loader: { open, close, toggle, setUnread }.
 */
(function () {
  'use strict';

  var __gs_runtime = {};

  // ════════════════════════════════════════════════════════════════════
  // Shared utilities
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
  };

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
          Util.log('Module failed: ' + name);
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
  // Identity layer — server-driven, cookie-backed
  // ════════════════════════════════════════════════════════════════════
  function createIdentity(ctx) {
    var state = {
      loaded: false,
      identityState: 'anonymous',
      contact: null,
      prechat: null,
    };

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
        state.loaded = true;
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
          state.loaded = true;
          if (res.ok && res.body) {
            state.identityState = res.body.identity_state || 'anonymous';
            state.contact = res.body.contact || null;
            state.prechat = res.body.prechat || configFallback();
          } else {
            state.identityState = 'anonymous';
            state.contact = null;
            state.prechat = configFallback();
          }
          Util.log('identity resolved', state);
          if (cb) cb(true);
        })
        .catch(function () {
          state.loaded = true;
          state.identityState = 'anonymous';
          state.contact = null;
          state.prechat = configFallback();
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
          state.identityState = 'identified';
          state.contact = {
            id: res.body.contact_id,
            name: payload.name || (state.contact && state.contact.name) || null,
            email: payload.email || (state.contact && state.contact.email) || null,
            phone: payload.phone || (state.contact && state.contact.phone) || null,
          };
          if (cb) cb(true, res.body);
        })
        .catch(function (err) { if (cb) cb(false, { error: 'network', _e: err }); });
    }

    function isAsked(field) { return !!(state.prechat && state.prechat['ask_' + field]); }
    function isRequired(field) { return !!(state.prechat && state.prechat['require_' + field]); }
    function needsPrechat() {
      if (state.identityState === 'identified') return false;
      if (!state.prechat) return false;
      if (!state.prechat.ask_name && !state.prechat.ask_email && !state.prechat.ask_phone) return false;
      return !!(state.prechat.require_name || state.prechat.require_email || state.prechat.require_phone);
    }

    return {
      state: state,
      fetchMe: fetchMe,
      submitPrechat: submitPrechat,
      isAsked: isAsked,
      isRequired: isRequired,
      needsPrechat: needsPrechat,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // UI.Notify — unread badge + simple inline status
  // ════════════════════════════════════════════════════════════════════
  function createNotify(ctx) {
    return {
      setUnread: function (count) { if (ctx.shell.setUnread) ctx.shell.setUnread(count); },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // UI.Chat — renders chat thread + pre-chat form into shadow root
  // ════════════════════════════════════════════════════════════════════
  function createChatUI(ctx) {
    var messages = [];
    var seenIds = {};
    var conversationId = null;
    var pollHandle = null;

    function mergeIncoming(incoming) {
      if (!incoming || !incoming.length) return false;
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
      return changed;
    }

    function chatModuleUrl() {
      var base = ctx.assetBase || '';
      return base + '/widget/runtime-chat.js?v=' + (ctx.config._loaderVersion || ctx.config.loaderVersion || 'dev');
    }

    function ensureChatModule(cb) {
      if (ModuleLoader.modules.chat) return cb();
      ModuleLoader.load('chat', chatModuleUrl(), function () { cb(); });
    }

    function renderEmpty(body, t) {
      body.innerHTML =
        '<div class="empty">' +
        '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
        '<p>' + Util.escapeHtml(t('intro')) + '</p></div>';
    }

    function renderChat(body, t) {
      if (messages.length === 0) { renderEmpty(body, t); return; }
      var html = '<div class="messages">';
      messages.forEach(function (m) {
        var bg = m.sender === 'visitor' ? 'style="background:' + ctx.primaryColor + '"' : '';
        var cls = m.sender === 'visitor' ? 'visitor' : 'operator';
        html += '<div class="msg ' + cls + '" ' + bg + '>' + Util.escapeHtml(m.body) + '</div>';
      });
      html += '</div>';
      body.innerHTML = html;
      body.scrollTop = body.scrollHeight;
    }

    function renderPreChat(body, identity, t, locale, onSubmitted) {
      var contact = identity.state.contact || {};
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
      messages.push({ body: text, sender: 'visitor', time: new Date() });
      onChange();
      ensureChatModule(function () {
        var mod = ModuleLoader.modules.chat;
        if (!mod || !mod.sendMessage) return;
        mod.sendMessage({
          apiBase: ctx.apiBase,
          workspaceId: ctx.workspaceId,
          sessionToken: ctx.sessionToken,
          conversationId: conversationId,
          text: text,
          onConversation: function (cid) {
            if (cid && cid !== conversationId) conversationId = cid;
          },
          onReply: function (reply) {
            messages.push({ body: reply, sender: 'operator', time: new Date() });
            onChange();
          },
          onError: function () { Util.log('Send failed'); },
        });
      });
    }

    function bootstrapHistoryAndPoll(onChange) {
      ensureChatModule(function () {
        var mod = ModuleLoader.modules.chat;
        if (!mod) return;

        if (mod.loadHistory) {
          mod.loadHistory({
            apiBase: ctx.apiBase,
            workspaceId: ctx.workspaceId,
            sessionToken: ctx.sessionToken,
            onResult: function (result) {
              if (result.conversationId) conversationId = result.conversationId;
              if (mergeIncoming(result.messages || [])) onChange();
            },
          });
        }

        if (pollHandle && pollHandle.stop) pollHandle.stop();
        if (mod.startPolling) {
          pollHandle = mod.startPolling({
            apiBase: ctx.apiBase,
            workspaceId: ctx.workspaceId,
            sessionToken: ctx.sessionToken,
            interval: 4000,
            getConversationId: function () { return conversationId; },
            onConversation: function (cid) { if (cid && cid !== conversationId) conversationId = cid; },
            onMessages: function (msgs) { if (mergeIncoming(msgs)) onChange(); },
          });
        }
      });
    }

    function teardown() {
      if (pollHandle && pollHandle.stop) pollHandle.stop();
      pollHandle = null;
    }

    return {
      renderChat: renderChat,
      renderPreChat: renderPreChat,
      sendMessage: sendMessage,
      bootstrapHistoryAndPoll: bootstrapHistoryAndPoll,
      teardown: teardown,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // UI.KB
  // ════════════════════════════════════════════════════════════════════
  function createKbUI(ctx) {
    var articles = [];
    var loaded = false;

    function moduleUrl() {
      var base = ctx.assetBase || '';
      return base + '/widget/runtime-kb.js?v=' + (ctx.config._loaderVersion || ctx.config.loaderVersion || 'dev');
    }

    function ensure(cb) {
      if (loaded) return cb();
      ModuleLoader.load('kb', moduleUrl(), function () {
        loaded = true;
        var mod = ModuleLoader.modules.kb;
        if (mod && mod.loadArticles) {
          mod.loadArticles({
            apiBase: ctx.apiBase,
            workspaceId: ctx.workspaceId,
            sessionToken: ctx.sessionToken,
            locale: ctx.locale,
            onArticles: function (a) { articles = a; cb(); },
          });
        } else {
          cb();
        }
      });
    }

    function render(body, t) {
      var html = '<input class="kb-search" type="search" placeholder="' + Util.escapeHtml(t('searchKb')) + '" />';
      if (articles.length === 0) {
        html += '<div class="empty"><p>' + Util.escapeHtml(t('noArticles')) + '</p></div>';
      } else {
        articles.forEach(function (a) {
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
    Util.log('Runtime init (Shadow DOM)');

    if (!shell || !shell.shadowRoot) {
      Util.log('FATAL: no shadowRoot provided by loader');
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

    var shadowRoot = shell.shadowRoot;
    var shellDiv = shadowRoot.querySelector('.shell') || shadowRoot;
    var launcher = shell.launcher;

    // ─── State containers (kept domain-separated) ───
    var ui = { activeTab: chatEnabled ? 'chat' : (kbEnabled ? 'help' : 'chat'), isOpen: false };

    // ─── Layers ───
    var identity = createIdentity(ctx);
    var notify = createNotify(ctx);
    var chatUI = createChatUI(ctx);
    var kbUI = createKbUI(ctx);

    // ─── Build panel ───
    var position = config.position || 'bottom-right';
    var posClass = position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
    var brandName = config.brandName || '';
    var welcomeMessage = config.welcomeMessage || 'Hi there 👋\nHow can we help you today?';

    var panel = document.createElement('div');
    panel.className = 'panel ' + posClass;

    var headerHtml = '<div class="header">' +
      '<div class="header-title">' + Util.escapeHtml(brandName || 'Support') + '</div>' +
      '<div class="header-subtitle">' + Util.escapeHtml(welcomeMessage).replace(/\n/g, '<br>') + '</div>' +
      '</div>';
    var tabsHtml = '';
    if (chatEnabled && kbEnabled) {
      tabsHtml = '<div class="tabs">' +
        '<button type="button" class="tab' + (ui.activeTab === 'chat' ? ' active' : '') + '" data-tab="chat">' + Util.escapeHtml(t('chat')) + '</button>' +
        '<button type="button" class="tab' + (ui.activeTab === 'help' ? ' active' : '') + '" data-tab="help">' + Util.escapeHtml(t('help')) + '</button>' +
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

    // Open immediately (user clicked launcher)
    ui.isOpen = true;
    panel.classList.add('visible');

    // ─── Tab switching ───
    var tabs = panel.querySelectorAll('.tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        ui.activeTab = tab.getAttribute('data-tab');
        tabs.forEach(function (t2) { t2.classList.remove('active'); });
        tab.classList.add('active');
        renderBody();
        if (inputBar) inputBar.style.display = ui.activeTab === 'chat' ? 'flex' : 'none';
      });
    });

    // ─── Send handler ───
    function trySend() {
      if (!msgInput) return;
      var text = msgInput.value.trim();
      if (!text) return;
      if (!identity.state.loaded) return;
      if (identity.needsPrechat()) { renderBody(); return; }
      msgInput.value = '';
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
      if (ui.activeTab === 'chat') {
        if (!identity.state.loaded) { renderLoading(); return; }
        if (identity.needsPrechat()) {
          chatUI.renderPreChat(body, identity, t, ctx.locale, function () {
            renderBody();
            if (msgInput) setTimeout(function () { msgInput.focus(); }, 100);
            chatUI.bootstrapHistoryAndPoll(function () {
              if (ui.activeTab === 'chat') renderBody();
            });
          });
          return;
        }
        chatUI.renderChat(body, t);
      } else if (ui.activeTab === 'help') {
        kbUI.ensure(function () { kbUI.render(body, t); });
      }
    }

    // ─── Boot sequence ───
    renderLoading();
    if (inputBar && ui.activeTab !== 'chat') inputBar.style.display = 'none';

    identity.fetchMe(function () {
      renderBody();
      if (!identity.needsPrechat()) {
        chatUI.bootstrapHistoryAndPoll(function () {
          if (ui.activeTab === 'chat') renderBody();
        });
        if (msgInput) setTimeout(function () { msgInput.focus(); }, 200);
      }
    });

    // ─── Public API back to loader ───
    return {
      open: function () {
        if (ui.isOpen) return;
        ui.isOpen = true;
        if (launcher) launcher.classList.add('open');
        panel.classList.add('visible');
        if (msgInput && !identity.needsPrechat()) setTimeout(function () { msgInput.focus(); }, 300);
      },
      close: function () {
        if (!ui.isOpen) return;
        ui.isOpen = false;
        if (launcher) launcher.classList.remove('open');
        panel.classList.remove('visible');
      },
      toggle: function () {
        if (ui.isOpen) this.close(); else this.open();
      },
      setUnread: function (count) { notify.setUnread(count); },
    };
  };

  window.__gs_runtime = __gs_runtime;
})();
