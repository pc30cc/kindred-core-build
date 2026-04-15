/**
 * Widget Runtime — WebYar-quality chat + help center widget.
 * Loaded by loader.js after config is fetched.
 */
(function() {
  'use strict';

  var __gs_runtime = {};

  __gs_runtime.init = function(config) {
    var primaryColor = config.primaryColor || '#3B82F6';
    var position = config.position || 'bottom-right';
    var posClass = position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
    var welcomeMessage = config.welcomeMessage || 'Hi there 👋\nHow can we help you today?';
    var launcherText = config.launcherText || '';
    var kbEnabled = config.features && config.features.knowledgeBase;
    var chatEnabled = config.features && config.features.chat !== false;
    var brandName = config.brandName || '';
    var locale = config.locale || 'en';
    var apiBase = config.apiBase || '';
    var workspaceId = config.workspaceId || '';

    // State
    var isOpen = false;
    var activeTab = chatEnabled ? 'chat' : 'help';
    var messages = [];
    var kbArticles = [];

    // Container
    var container = document.createElement('div');
    container.className = '__gs-widget';
    container.style.cssText = '--gs-primary:' + primaryColor;
    document.body.appendChild(container);

    // Launcher
    var launcher = document.createElement('button');
    launcher.className = '__gs-launcher ' + posClass;
    launcher.style.background = primaryColor;
    launcher.style.color = '#fff';
    launcher.setAttribute('aria-label', 'Open chat');
    launcher.innerHTML = '<svg class="chat-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' +
      '<svg class="close-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    container.appendChild(launcher);

    // Panel
    var panel = document.createElement('div');
    panel.className = '__gs-panel ' + posClass;

    // Header
    var headerHtml = '<div class="__gs-header">' +
      '<div class="__gs-header-title">' + escapeHtml(brandName || 'Support') + '</div>' +
      '<div class="__gs-header-subtitle">' + escapeHtml(welcomeMessage).replace(/\n/g, '<br>') + '</div>' +
      '</div>';

    // Tabs
    var tabsHtml = '';
    if (chatEnabled && kbEnabled) {
      tabsHtml = '<div class="__gs-tabs">' +
        '<button class="__gs-tab' + (activeTab === 'chat' ? ' active' : '') + '" data-tab="chat">' + (locale === 'fa' ? 'گفتگو' : locale === 'tr' ? 'Sohbet' : 'Chat') + '</button>' +
        '<button class="__gs-tab' + (activeTab === 'help' ? ' active' : '') + '" data-tab="help">' + (locale === 'fa' ? 'راهنما' : locale === 'tr' ? 'Yardım' : 'Help') + '</button>' +
        '</div>';
    }

    // Body
    var bodyHtml = '<div class="__gs-body" id="__gs-body"></div>';

    // Input bar
    var inputHtml = '<div class="__gs-input-bar" id="__gs-input-bar">' +
      '<input class="__gs-input" id="__gs-msg-input" placeholder="' + (locale === 'fa' ? 'پیام خود را بنویسید...' : locale === 'tr' ? 'Mesajınızı yazın...' : 'Type a message...') + '" />' +
      '<button class="__gs-send-btn" id="__gs-send-btn" style="background:' + primaryColor + '">' +
      '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
      '</button></div>';

    // Powered by
    var poweredHtml = brandName ? '<div class="__gs-powered">Powered by <a href="#">' + escapeHtml(brandName) + '</a></div>' : '';

    panel.innerHTML = headerHtml + tabsHtml + bodyHtml + (chatEnabled ? inputHtml : '') + poweredHtml;
    container.appendChild(panel);

    // Elements
    var body = panel.querySelector('#__gs-body');
    var msgInput = panel.querySelector('#__gs-msg-input');
    var sendBtn = panel.querySelector('#__gs-send-btn');
    var inputBar = panel.querySelector('#__gs-input-bar');

    // Toggle
    launcher.addEventListener('click', function() {
      isOpen = !isOpen;
      launcher.classList.toggle('open', isOpen);
      panel.classList.toggle('visible', isOpen);
      if (isOpen && msgInput) {
        setTimeout(function() { msgInput.focus(); }, 300);
      }
    });

    // Tab switching
    var tabs = panel.querySelectorAll('.__gs-tab');
    tabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        activeTab = tab.getAttribute('data-tab');
        tabs.forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        renderBody();
        if (inputBar) {
          inputBar.style.display = activeTab === 'chat' ? 'flex' : 'none';
        }
      });
    });

    // Send message
    function sendMessage() {
      if (!msgInput) return;
      var text = msgInput.value.trim();
      if (!text) return;
      messages.push({ body: text, sender: 'visitor', time: new Date() });
      msgInput.value = '';
      renderBody();

      // Send to API
      if (apiBase && workspaceId) {
        fetch(apiBase + '/api/widget/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace_id: workspaceId,
            visitor_id: localStorage.getItem('__gs_vid') || '',
            body: text,
          })
        }).then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.reply) {
            messages.push({ body: data.reply, sender: 'operator', time: new Date() });
            renderBody();
          }
        }).catch(function() {});
      }
    }

    if (sendBtn) sendBtn.addEventListener('click', sendMessage);
    if (msgInput) msgInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Render
    function renderBody() {
      if (!body) return;

      if (activeTab === 'chat') {
        if (messages.length === 0) {
          body.innerHTML = '<div class="__gs-empty">' +
            '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
            '<p>' + (locale === 'fa' ? 'سوالی دارید؟ اینجا بنویسید.' : locale === 'tr' ? 'Bir soru mu var? Buraya yazın.' : 'Send us a message and we\'ll get back to you shortly.') + '</p></div>';
          return;
        }
        var html = '<div class="__gs-messages">';
        messages.forEach(function(m) {
          var bg = m.sender === 'visitor' ? 'style="background:' + primaryColor + '"' : '';
          var cls = m.sender === 'visitor' ? 'visitor' : 'operator';
          html += '<div class="__gs-msg ' + cls + '" ' + bg + '>' + escapeHtml(m.body) + '</div>';
        });
        html += '</div>';
        body.innerHTML = html;
        body.scrollTop = body.scrollHeight;
      } else {
        // Help / KB
        var searchHtml = '<input class="__gs-kb-search" id="__gs-kb-search" placeholder="' +
          (locale === 'fa' ? 'جستجو در مقالات...' : locale === 'tr' ? 'Makalelerde ara...' : 'Search articles...') + '" />';
        var articlesHtml = '';
        if (kbArticles.length === 0) {
          articlesHtml = '<div class="__gs-empty"><p>' + (locale === 'fa' ? 'مقاله‌ای یافت نشد' : 'No articles yet') + '</p></div>';
        } else {
          kbArticles.forEach(function(a) {
            articlesHtml += '<div class="__gs-kb-article">' +
              '<div class="__gs-kb-article-title">' + escapeHtml(a.title) + '</div>' +
              '<div class="__gs-kb-article-excerpt">' + escapeHtml(a.excerpt || '') + '</div></div>';
          });
        }
        body.innerHTML = searchHtml + articlesHtml;
      }
    }

    // Load KB articles
    if (kbEnabled && apiBase && workspaceId) {
      fetch(apiBase + '/api/widget/kb?workspace_id=' + encodeURIComponent(workspaceId))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          kbArticles = data.articles || [];
          if (activeTab === 'help') renderBody();
        }).catch(function() {});
    }

    // Initial render
    renderBody();
    if (inputBar && activeTab !== 'chat') {
      inputBar.style.display = 'none';
    }

    // Public API
    return {
      open: function() { if (!isOpen) launcher.click(); },
      close: function() { if (isOpen) launcher.click(); },
      toggle: function() { launcher.click(); },
      setUnread: function(count) {
        var existing = launcher.querySelector('.__gs-badge');
        if (existing) existing.remove();
        if (count > 0) {
          var badge = document.createElement('span');
          badge.className = '__gs-badge';
          badge.textContent = count > 9 ? '9+' : String(count);
          launcher.appendChild(badge);
        }
      }
    };
  };

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  window.__gs_runtime = __gs_runtime;
})();
