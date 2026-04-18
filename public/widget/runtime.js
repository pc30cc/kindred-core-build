/**
 * Widget Runtime v2 — Shell + lazy feature modules.
 *
 * Layer 2: UI Shell (panel, tabs, open/close)
 * Layer 3: Feature modules loaded on demand
 *
 * Loaded ONLY when user clicks the launcher.
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
    div.textContent = text;
    return div.innerHTML;
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

    var container = els.container;
    var launcher = els.launcher;

    // State
    var isOpen = false;
    var activeTab = chatEnabled ? 'chat' : (kbEnabled ? 'help' : 'chat');
    var messages = [];
    var kbArticles = [];
    var chatModuleLoaded = false;
    var kbModuleLoaded = false;

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
        (locale === 'fa' ? 'گفتگو' : locale === 'tr' ? 'Sohbet' : 'Chat') + '</button>' +
        '<button class="__gs-tab' + (activeTab === 'help' ? ' active' : '') + '" data-tab="help">' +
        (locale === 'fa' ? 'راهنما' : locale === 'tr' ? 'Yardım' : 'Help') + '</button>' +
        '</div>';
    }

    var bodyHtml = '<div class="__gs-body" id="__gs-body"></div>';
    var inputHtml = chatEnabled
      ? '<div class="__gs-input-bar" id="__gs-input-bar">' +
        '<input class="__gs-input" id="__gs-msg-input" placeholder="' +
        (locale === 'fa' ? 'پیام خود را بنویسید...' : locale === 'tr' ? 'Mesajınızı yazın...' : 'Type a message...') +
        '" />' +
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
    if (msgInput) setTimeout(function () { msgInput.focus(); }, 300);

    // ─── Tab switching ───
    var tabs = panel.querySelectorAll('.__gs-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        activeTab = tab.getAttribute('data-tab');
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        renderBody();
        if (inputBar) inputBar.style.display = activeTab === 'chat' ? 'flex' : 'none';
      });
    });

    // ─── Send message (lazy loads chat module) ───
    function sendMessage() {
      if (!msgInput) return;
      var text = msgInput.value.trim();
      if (!text) return;
      messages.push({ body: text, sender: 'visitor', time: new Date() });
      msgInput.value = '';
      renderBody();

      // Lazy load chat module for API communication
      ensureChatModule(function () {
        if (modules.chat && modules.chat.sendMessage) {
          modules.chat.sendMessage({
            apiBase: apiBase,
            workspaceId: workspaceId,
            sessionToken: sessionToken,
            text: text,
            onReply: function (reply) {
              messages.push({ body: reply, sender: 'operator', time: new Date() });
              renderBody();
            },
            onError: function () { debugLog('Message send failed'); },
          });
        } else {
          // Inline fallback if module not available
          sendMessageFallback(text);
        }
      });
    }

    function sendMessageFallback(text) {
      if (!apiBase || !workspaceId) return;
      fetch(apiBase + '/api/widget/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Widget-Token': sessionToken,
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          visitor_id: localStorage.getItem('__gs_vid') || '',
          session_id: localStorage.getItem('__gs_sid') || undefined,
          conversation_id: localStorage.getItem('__gs_cid') || undefined,
          message: text,
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.reply) {
            messages.push({ body: data.reply, sender: 'operator', time: new Date() });
            renderBody();
          }
        })
        .catch(function (err) { debugLog('Message fallback failed', err); });
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
        // Load KB articles
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
        renderChat();
      } else if (activeTab === 'help') {
        ensureKbModule(function () { renderKb(); });
      }
    }

    function renderChat() {
      if (messages.length === 0) {
        body.innerHTML =
          '<div class="__gs-empty">' +
          '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
          '<p>' +
          (locale === 'fa'
            ? 'سوالی دارید؟ اینجا بنویسید.'
            : locale === 'tr'
              ? 'Bir soru mu var? Buraya yazın.'
              : "Send us a message and we'll get back to you shortly.") +
          '</p></div>';
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
        '<input class="__gs-kb-search" id="__gs-kb-search" placeholder="' +
        (locale === 'fa' ? 'جستجو در مقالات...' : locale === 'tr' ? 'Makalelerde ara...' : 'Search articles...') +
        '" />';
      var articlesHtml = '';
      if (kbArticles.length === 0) {
        articlesHtml = '<div class="__gs-empty"><p>' + (locale === 'fa' ? 'مقاله‌ای یافت نشد' : 'No articles yet') + '</p></div>';
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

    // Initial render
    renderBody();
    if (inputBar && activeTab !== 'chat') {
      inputBar.style.display = 'none';
    }

    // ─── Public API ───
    var api = {
      open: function () {
        if (!isOpen) {
          isOpen = true;
          launcher.classList.add('open');
          panel.classList.add('visible');
          if (msgInput) setTimeout(function () { msgInput.focus(); }, 300);
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
