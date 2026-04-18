/**
 * Widget Runtime v3 — Cookie-based visitor identity (no localStorage).
 *
 * The HttpOnly `dvsid` cookie is the single source of truth for visitor
 * identity. All API calls use `credentials: 'include'` so the cookie is sent
 * automatically. We never read or write visitor_id / conversation_id to
 * localStorage.
 *
 * Flow:
 *  1. On open → GET /identity/me → resolves visitor + linked contact + prechat policy
 *  2. If no contact yet AND any prechat field is required → show pre-chat form
 *  3. Submit → POST /identity/prechat → server merges into a contact
 *  4. Smart history continuation → GET /identity/history (returns conv if within window)
 *  5. Send message / poll for replies — conversation_id lives in memory only
 */
(function () {
  'use strict';

  var __gs_runtime = {};

  // ─── Module registry ───
  var modules = {};
  var moduleLoading = {};

  function loadModule(name, url, cb) {
    if (modules[name]) return cb(modules[name]);
    if (moduleLoading[name]) {
      moduleLoading[name].push(cb);
      return;
    }
    moduleLoading[name] = [cb];
    debugLog('Loading module: ' + name, url);
    var _t = Date.now();

    var script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = function () {
      debugLog('Module loaded: ' + name, (Date.now() - _t) + 'ms');
      var mod = window['__gs_mod_' + name];
      if (mod) modules[name] = mod;
      var cbs = moduleLoading[name] || [];
      delete moduleLoading[name];
      cbs.forEach(function (fn) { fn(mod || null); });
    };
    script.onerror = function () {
      debugLog('Module failed: ' + name);
      delete moduleLoading[name];
    };
    document.head.appendChild(script);
  }

  // ─── Debug ───
  var _debug = false;
  function debugLog(msg, data) {
    if (!_debug) return;
    console.info('[Widget Runtime]', msg, data !== undefined ? data : '');
  }

  // ─── HTML escape ───
  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  // ─── Validators (Section 6: basic email + phone format) ───
  function isValidEmail(v) {
    if (!v) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim());
  }
  function isValidPhone(v) {
    if (!v) return false;
    var s = String(v).trim().replace(/[\s\-().]/g, '');
    return /^\+?\d{6,20}$/.test(s);
  }

  // ─── Init (called by loader on first click) ───
  __gs_runtime.init = function (config, els) {
    _debug = !!config.debugMode;
    debugLog('Runtime init');

    var primaryColor = config.primaryColor || '#3B82F6';
    var position = config.position || 'bottom-right';
    var posClass = position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
    var welcomeMessage = config.welcomeMessage || 'Hi there 👋\nHow can we help you today?';
    var brandName = config.brandName || '';
    var locale = config.locale || 'en';
    var apiBase = config._apiBase || config.apiBase || '';
    var assetBase = config._assetBase || config.assetBase || '';
    var workspaceId = config.workspaceId || '';
    var sessionToken = config._sessionToken || '';
    var chatEnabled = config.features && config.features.chat !== false;
    var kbEnabled = config.features && config.features.knowledgeBase;

    // Fallback prechat policy derived from /config (used if /identity/me fails)
    var configPrechatFallback = (function () {
      var pc = config.preChat || {};
      function fieldEnabled(key) {
        var f = pc[key] || {};
        return !!f.enabled && !f.locked;
      }
      return {
        ask_name: fieldEnabled('name'),
        ask_email: fieldEnabled('email'),
        ask_phone: fieldEnabled('phone'),
        require_name: fieldEnabled('name'),
        require_email: fieldEnabled('email'),
        require_phone: fieldEnabled('phone'),
        verify_email: false,
        verify_phone: false,
      };
    })();

    var container = els.container;
    var launcher = els.launcher;

    // ─── In-memory state (NO localStorage) ───
    var isOpen = false;
    var activeTab = chatEnabled ? 'chat' : (kbEnabled ? 'help' : 'chat');
    var messages = [];
    var kbArticles = [];
    var chatModuleLoaded = false;
    var kbModuleLoaded = false;

    // Identity state from server
    var identity = {
      loaded: false,
      identityState: 'anonymous', // 'anonymous' | 'identified'
      contact: null, // { id, name, email, phone, avatar_url } | null
      prechat: null, // { ask_*, require_*, verify_* }
    };
    var conversationId = null; // Lives in memory only — server is truth
    var pollHandle = null;

    // ─── i18n helpers ───
    function t(key) {
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
      var l = dict[locale] ? locale : 'en';
      return (dict[l] && dict[l][key]) || dict.en[key] || key;
    }

    // ═══════════════════════════════════════════════
    // Identity API (server-side, cookie-based)
    // ═══════════════════════════════════════════════
    function fetchIdentity(cb) {
      if (!apiBase || !workspaceId) {
        identity.loaded = true;
        if (cb) cb(false);
        return;
      }
      fetch(
        apiBase + '/api/widget/identity/me?workspace_id=' + encodeURIComponent(workspaceId),
        {
          credentials: 'include',
          headers: { 'X-Widget-Token': sessionToken || '' },
        }
      )
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          identity.loaded = true;
          if (res.ok && res.body) {
            identity.identityState = res.body.identity_state || 'anonymous';
            identity.contact = res.body.contact || null;
            identity.prechat = res.body.prechat || configPrechatFallback;
          } else {
            // Server-side identity unavailable — use /config-derived policy so
            // pre-chat still appears for new visitors.
            debugLog('/identity/me failed, using config fallback', res.body);
            identity.identityState = 'anonymous';
            identity.contact = null;
            identity.prechat = configPrechatFallback;
          }
          debugLog('identity resolved', identity);
          if (cb) cb(true);
        })
        .catch(function (err) {
          debugLog('/identity/me network error, using config fallback', err);
          identity.loaded = true;
          identity.identityState = 'anonymous';
          identity.contact = null;
          identity.prechat = configPrechatFallback;
          if (cb) cb(false);
        });
    }

    function submitPrechat(payload, cb) {
      fetch(apiBase + '/api/widget/identity/prechat', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Widget-Token': sessionToken || '',
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          name: payload.name || null,
          email: payload.email || null,
          phone: payload.phone || null,
        }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok) { if (cb) cb(false, res.body); return; }
          // Update local identity snapshot
          identity.identityState = 'identified';
          identity.contact = {
            id: res.body.contact_id,
            name: payload.name || (identity.contact && identity.contact.name) || null,
            email: payload.email || (identity.contact && identity.contact.email) || null,
            phone: payload.phone || (identity.contact && identity.contact.phone) || null,
          };
          if (cb) cb(true, res.body);
        })
        .catch(function (err) { if (cb) cb(false, { error: 'network', _e: err }); });
    }

    // Pre-chat field requirements (from server-side policy)
    function isFieldAsked(field) {
      if (!identity.prechat) return false;
      return !!identity.prechat['ask_' + field];
    }
    function isFieldRequired(field) {
      if (!identity.prechat) return false;
      return !!identity.prechat['require_' + field];
    }
    function needsPrechat() {
      if (identity.identityState === 'identified') return false;
      if (!identity.prechat) return false;
      // If no field is asked, no need
      if (!identity.prechat.ask_name && !identity.prechat.ask_email && !identity.prechat.ask_phone) {
        return false;
      }
      // If any required field is missing, need prechat
      return !!(identity.prechat.require_name || identity.prechat.require_email || identity.prechat.require_phone);
    }

    // ─── Build panel ───
    var panel = document.createElement('div');
    panel.className = '__gs-panel ' + posClass;

    var headerHtml = '<div class="__gs-header">' +
      '<div class="__gs-header-title">' + escapeHtml(brandName || 'Support') + '</div>' +
      '<div class="__gs-header-subtitle">' + escapeHtml(welcomeMessage).replace(/\n/g, '<br>') + '</div>' +
      '</div>';

    var tabsHtml = '';
    if (chatEnabled && kbEnabled) {
      tabsHtml = '<div class="__gs-tabs">' +
        '<button class="__gs-tab' + (activeTab === 'chat' ? ' active' : '') + '" data-tab="chat">' +
        escapeHtml(t('chat')) + '</button>' +
        '<button class="__gs-tab' + (activeTab === 'help' ? ' active' : '') + '" data-tab="help">' +
        escapeHtml(t('help')) + '</button>' +
        '</div>';
    }

    var bodyHtml = '<div class="__gs-body" id="__gs-body"></div>';
    var inputHtml = chatEnabled
      ? '<div class="__gs-input-bar" id="__gs-input-bar">' +
        '<input class="__gs-input" id="__gs-msg-input" placeholder="' + escapeHtml(t('typeMsg')) + '" />' +
        '<button class="__gs-send-btn" id="__gs-send-btn" style="background:' + primaryColor + '">' +
        '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
        '</button></div>'
      : '';
    var poweredHtml = brandName
      ? '<div class="__gs-powered">Powered by <a href="#">' + escapeHtml(brandName) + '</a></div>'
      : '';

    panel.innerHTML = headerHtml + tabsHtml + bodyHtml + inputHtml + poweredHtml;
    container.appendChild(panel);

    var body = panel.querySelector('#__gs-body');
    var msgInput = panel.querySelector('#__gs-msg-input');
    var sendBtn = panel.querySelector('#__gs-send-btn');
    var inputBar = panel.querySelector('#__gs-input-bar');

    // ─── Open immediately (since user clicked) ───
    isOpen = true;
    panel.classList.add('visible');

    // ─── Tab switching ───
    var tabs = panel.querySelectorAll('.__gs-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        activeTab = tab.getAttribute('data-tab');
        tabs.forEach(function (t2) { t2.classList.remove('active'); });
        tab.classList.add('active');
        renderBody();
        if (inputBar) inputBar.style.display = activeTab === 'chat' ? 'flex' : 'none';
      });
    });

    // ─── Send message ───
    function sendMessage() {
      if (!msgInput) return;
      var text = msgInput.value.trim();
      if (!text) return;

      // Block sending until identity is resolved + prechat satisfied
      if (!identity.loaded) return;
      if (needsPrechat()) {
        renderBody();
        return;
      }

      messages.push({ body: text, sender: 'visitor', time: new Date() });
      msgInput.value = '';
      renderBody();

      ensureChatModule(function () {
        if (modules.chat && modules.chat.sendMessage) {
          modules.chat.sendMessage({
            apiBase: apiBase,
            workspaceId: workspaceId,
            sessionToken: sessionToken,
            conversationId: conversationId,
            text: text,
            onConversation: function (cid) {
              if (cid && cid !== conversationId) {
                conversationId = cid;
                debugLog('conversation_id resolved', cid);
              }
            },
            onReply: function (reply) {
              messages.push({ body: reply, sender: 'operator', time: new Date() });
              renderBody();
            },
            onError: function () { debugLog('Message send failed'); },
          });
        }
      });
    }

    if (sendBtn) sendBtn.addEventListener('click', sendMessage);
    if (msgInput)
      msgInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

    // ─── Lazy module loaders ───
    function getModuleUrl(name) {
      var base = assetBase || '';
      return base + '/widget/runtime-' + name + '.js?v=' + (config.loaderVersion || 'dev');
    }

    function ensureChatModule(cb) {
      if (chatModuleLoaded) return cb();
      loadModule('chat', getModuleUrl('chat'), function () {
        chatModuleLoaded = true;
        cb();
      });
    }

    function ensureKbModule(cb) {
      if (kbModuleLoaded) return cb();
      loadModule('kb', getModuleUrl('kb'), function () {
        kbModuleLoaded = true;
        if (modules.kb && modules.kb.loadArticles) {
          modules.kb.loadArticles({
            apiBase: apiBase,
            workspaceId: workspaceId,
            sessionToken: sessionToken,
            locale: locale,
            onArticles: function (articles) {
              kbArticles = articles;
              if (activeTab === 'help') renderBody();
            },
          });
        }
        cb();
      });
    }

    // ─── Render ───
    function renderBody() {
      if (!body) return;
      if (activeTab === 'chat') {
        if (!identity.loaded) { renderLoading(); return; }
        if (needsPrechat()) { renderPreChat(); return; }
        renderChat();
      } else if (activeTab === 'help') {
        ensureKbModule(function () { renderKb(); });
      }
    }

    function renderLoading() {
      body.innerHTML = '<div class="__gs-empty"><p>' + escapeHtml(t('loading')) + '</p></div>';
    }

    function renderPreChat() {
      var fieldsHtml = '';
      var contact = identity.contact || {};
      function fieldRow(key, type, value) {
        var label = t(key);
        var req = isFieldRequired(key);
        var labelHtml = '<label style="font-size:12px;color:#64748b;display:block;margin-bottom:4px;">' +
          escapeHtml(label) + (req ? ' <span style="color:#EF4444">*</span>' : '') + '</label>';
        return '<div>' + labelHtml +
          '<input class="__gs-input" id="__gs-prechat-' + key + '" type="' + type + '" autocomplete="' +
          (key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel') +
          '" placeholder="' + escapeHtml(label) + '" value="' + escapeHtml(value || '') + '" />' +
          '<div class="__gs-prechat-error" id="__gs-prechat-err-' + key + '" style="font-size:12px;color:#EF4444;margin-top:4px;display:none;"></div>' +
        '</div>';
      }

      if (isFieldAsked('name')) fieldsHtml += fieldRow('name', 'text', contact.name);
      if (isFieldAsked('email')) fieldsHtml += fieldRow('email', 'email', contact.email);
      if (isFieldAsked('phone')) fieldsHtml += fieldRow('phone', 'tel', contact.phone);

      var dir = locale === 'fa' ? 'rtl' : 'ltr';
      body.innerHTML =
        '<div class="__gs-prechat" dir="' + dir + '" style="padding:4px 0;display:flex;flex-direction:column;gap:12px;">' +
        '<p style="margin:0 0 4px;color:#475569;font-size:14px;line-height:1.5;">' +
        escapeHtml(t('prechatIntro')) + '</p>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' + fieldsHtml + '</div>' +
        '<button class="__gs-send-btn" id="__gs-prechat-submit" style="background:' + primaryColor + ';width:100%;height:40px;border-radius:8px;color:#fff;border:none;cursor:pointer;font-weight:600;">' +
        escapeHtml(t('continue')) + '</button>' +
        '</div>';

      var nameInput = body.querySelector('#__gs-prechat-name');
      var emailInput = body.querySelector('#__gs-prechat-email');
      var phoneInput = body.querySelector('#__gs-prechat-phone');
      var submitBtn = body.querySelector('#__gs-prechat-submit');

      function clearError(key) {
        var el = body.querySelector('#__gs-prechat-err-' + key);
        if (el) { el.style.display = 'none'; el.textContent = ''; }
      }
      function showError(key, msg) {
        var el = body.querySelector('#__gs-prechat-err-' + key);
        if (el) { el.textContent = msg; el.style.display = 'block'; }
      }
      [['name', nameInput], ['email', emailInput], ['phone', phoneInput]].forEach(function (pair) {
        if (pair[1]) pair[1].addEventListener('input', function () { clearError(pair[0]); });
      });

      if (submitBtn) {
        submitBtn.addEventListener('click', function () {
          var payload = {
            name: nameInput ? nameInput.value.trim() : '',
            email: emailInput ? emailInput.value.trim() : '',
            phone: phoneInput ? phoneInput.value.trim() : '',
          };
          var ok = true;
          if (isFieldRequired('name') && !payload.name) {
            showError('name', t('required')); ok = false;
          }
          if (isFieldAsked('email') && payload.email) {
            if (!isValidEmail(payload.email)) { showError('email', t('invalidEmail')); ok = false; }
          } else if (isFieldRequired('email') && !payload.email) {
            showError('email', t('required')); ok = false;
          }
          if (isFieldAsked('phone') && payload.phone) {
            if (!isValidPhone(payload.phone)) { showError('phone', t('invalidPhone')); ok = false; }
          } else if (isFieldRequired('phone') && !payload.phone) {
            showError('phone', t('required')); ok = false;
          }
          if (!ok) return;

          submitBtn.disabled = true;
          submitBtn.style.opacity = '0.6';
          submitPrechat(payload, function (success, resp) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
            if (!success) {
              var f = resp && resp.field;
              if (f) showError(f, t('required'));
              return;
            }
            // Identity now linked → load history + start polling
            renderBody();
            if (msgInput) setTimeout(function () { msgInput.focus(); }, 100);
            bootstrapHistoryAndPoll();
          });
        });
      }
    }

    function renderChat() {
      if (messages.length === 0) {
        body.innerHTML =
          '<div class="__gs-empty">' +
          '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
          '<p>' + escapeHtml(t('intro')) + '</p></div>';
        return;
      }
      var html = '<div class="__gs-messages">';
      messages.forEach(function (m) {
        var bg = m.sender === 'visitor' ? 'style="background:' + primaryColor + '"' : '';
        var cls = m.sender === 'visitor' ? 'visitor' : 'operator';
        html += '<div class="__gs-msg ' + cls + '" ' + bg + '>' + escapeHtml(m.body) + '</div>';
      });
      html += '</div>';
      body.innerHTML = html;
      body.scrollTop = body.scrollHeight;
    }

    function renderKb() {
      var searchHtml =
        '<input class="__gs-kb-search" id="__gs-kb-search" placeholder="' + escapeHtml(t('searchKb')) + '" />';
      var articlesHtml = '';
      if (kbArticles.length === 0) {
        articlesHtml = '<div class="__gs-empty"><p>' + escapeHtml(t('noArticles')) + '</p></div>';
      } else {
        kbArticles.forEach(function (a) {
          articlesHtml +=
            '<div class="__gs-kb-article">' +
            '<div class="__gs-kb-article-title">' + escapeHtml(a.title) + '</div>' +
            '<div class="__gs-kb-article-excerpt">' + escapeHtml(a.excerpt || '') + '</div></div>';
        });
      }
      body.innerHTML = searchHtml + articlesHtml;
    }

    // ─── Message merge dedup ───
    var seenMessageIds = {};
    function mergeIncomingMessages(incoming) {
      if (!incoming || !incoming.length) return false;
      var changed = false;
      incoming.forEach(function (m) {
        var id = m.id || (m.time + ':' + (m.text || m.body || ''));
        if (seenMessageIds[id]) return;
        seenMessageIds[id] = true;
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

    function bootstrapHistoryAndPoll() {
      if (!chatEnabled) return;
      ensureChatModule(function () {
        // Smart history continuation (server-side window check)
        if (modules.chat && modules.chat.loadHistory) {
          modules.chat.loadHistory({
            apiBase: apiBase,
            workspaceId: workspaceId,
            sessionToken: sessionToken,
            onResult: function (result) {
              if (result.conversationId) {
                conversationId = result.conversationId;
              }
              if (mergeIncomingMessages(result.messages || []) && activeTab === 'chat') {
                renderBody();
              }
            },
          });
        }

        // Start polling (binds to current conversationId via getter)
        if (pollHandle && pollHandle.stop) pollHandle.stop();
        if (modules.chat && modules.chat.startPolling) {
          pollHandle = modules.chat.startPolling({
            apiBase: apiBase,
            workspaceId: workspaceId,
            sessionToken: sessionToken,
            interval: 4000,
            getConversationId: function () { return conversationId; },
            onConversation: function (cid) {
              if (cid && cid !== conversationId) conversationId = cid;
            },
            onMessages: function (msgs) {
              if (mergeIncomingMessages(msgs) && activeTab === 'chat') renderBody();
            },
          });
        }
      });
    }

    // ─── Boot ───
    renderLoading();
    if (inputBar && activeTab !== 'chat') inputBar.style.display = 'none';

    fetchIdentity(function () {
      renderBody();
      // Only load history+start polling for already-identified visitors.
      // For new visitors waiting on prechat, we wait until they submit it.
      if (!needsPrechat()) {
        bootstrapHistoryAndPoll();
        if (msgInput) setTimeout(function () { msgInput.focus(); }, 200);
      }
    });

    // ─── Public API ───
    var api = {
      open: function () {
        if (!isOpen) {
          isOpen = true;
          launcher.classList.add('open');
          panel.classList.add('visible');
          if (msgInput && !needsPrechat()) setTimeout(function () { msgInput.focus(); }, 300);
        }
      },
      close: function () {
        if (isOpen) {
          isOpen = false;
          launcher.classList.remove('open');
          panel.classList.remove('visible');
        }
      },
      toggle: function () {
        if (isOpen) api.close();
        else api.open();
      },
      setUnread: function (count) {
        var existing = launcher.querySelector('.__gs-badge');
        if (existing) existing.remove();
        if (count > 0) {
          var badge = document.createElement('span');
          badge.className = '__gs-badge';
          badge.textContent = count > 9 ? '9+' : String(count);
          launcher.appendChild(badge);
        }
      },
    };

    return api;
  };

  window.__gs_runtime = __gs_runtime;
})();
