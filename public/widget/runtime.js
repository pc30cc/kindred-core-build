(function () {
  'use strict';

  /* ── SVG Icon Library ── */
  var ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    message_circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    headset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
    help_circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
    zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    hand_wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>',
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    megaphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  };

  /* ── Theme Definitions ── */
  var THEMES = {
    modern:    { style:'dark', chatBg:'#0f1420', headerStyle:'gradient', msgBg:'#1e2538', inputBg:'#1a2030', textColor:'#e2e8f0', borderColor:'#1e2538', panelRadius:'16px' },
    minimal:   { style:'light', chatBg:'#ffffff', headerStyle:'solid', msgBg:'#f1f5f9', inputBg:'#f8fafc', textColor:'#0f172a', borderColor:'#e2e8f0', panelRadius:'24px' },
    gradient:  { style:'light', chatBg:'#ffffff', headerStyle:'bold-gradient', msgBg:'#f0f4ff', inputBg:'#fafbfc', textColor:'#0f172a', borderColor:'#e2e8f0', panelRadius:'20px' },
    bubble:    { style:'dark', chatBg:'#1a1a2e', headerStyle:'gradient', msgBg:'#16213e', inputBg:'#0f3460', textColor:'#e2e8f0', borderColor:'#16213e', panelRadius:'28px' },
    classic:   { style:'light', chatBg:'#ffffff', headerStyle:'solid', msgBg:'#f9fafb', inputBg:'#ffffff', textColor:'#0f172a', borderColor:'#e5e7eb', panelRadius:'12px' },
    neon:      { style:'dark', chatBg:'#0a0a0f', headerStyle:'neon', msgBg:'#12121c', inputBg:'#0e0e16', textColor:'#e2e8f0', borderColor:'#1a1a2e', panelRadius:'16px' },
    glass:     { style:'dark', chatBg:'rgba(15,20,32,0.92)', headerStyle:'glass', msgBg:'rgba(255,255,255,0.06)', inputBg:'rgba(255,255,255,0.04)', textColor:'#e2e8f0', borderColor:'rgba(255,255,255,0.1)', panelRadius:'20px' },
    flat:      { style:'light', chatBg:'#fefefe', headerStyle:'flat', msgBg:'#f3f4f6', inputBg:'#f9fafb', textColor:'#0f172a', borderColor:'#e5e7eb', panelRadius:'8px' },
    rounded:   { style:'light', chatBg:'#ffffff', headerStyle:'solid', msgBg:'#eef2ff', inputBg:'#f8fafc', textColor:'#0f172a', borderColor:'#e2e8f0', panelRadius:'28px' },
    corporate: { style:'dark', chatBg:'#111827', headerStyle:'corporate', msgBg:'#1f2937', inputBg:'#1a2332', textColor:'#d1d5db', borderColor:'#374151', panelRadius:'10px' },
  };

  function getShapeRadius(shape) {
    switch (shape) {
      case 'circle': return '50%';
      case 'square': return '14px';
      case 'pill': return '28px';
      case 'dual': return '16px';
      default: return '50%';
    }
  }

  function createNoopApi() {
    return { open: function(){}, close: function(){}, toggle: function(){} };
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (typeof text === 'string') e.textContent = text;
    return e;
  }

  function init(config) {
    if (!config || !config.enabled) return createNoopApi();

    var existing = document.getElementById('gs-widget-root');
    if (existing) existing.parentNode.removeChild(existing);

    var branding = config.branding || {};
    var theme = config.theme || {};
    var themeId = theme.id || 'modern';
    var themeDef = THEMES[themeId] || THEMES.modern;

    var primaryColor = branding.primaryColor || '#3B82F6';
    var secondaryColor = branding.secondaryColor || '#6366f1';
    var fabIcon = theme.fabIcon || 'chat';
    var fabShape = theme.fabShape || 'circle';
    var fabScale = (theme.fabScale || 100) / 100;
    var fabIconColor = theme.fabIconColor || '#ffffff';
    var fabTextColor = theme.fabTextColor || '#ffffff';
    var fabAnimation = theme.fabAnimation !== false;
    var showLogo = theme.showLogo !== false;
    var launcherText = branding.launcherText || 'Chat with us';
    var welcomeMessage = branding.welcomeMessage || 'Hello! How can we help you?';
    var platformName = branding.platformName || 'Support';
    var positionClass = config.position === 'bottom-left' ? 'gs-pos-bottom-left' : 'gs-pos-bottom-right';

    /* ── Root ── */
    var root = el('div', 'gs-widget-root gs-theme-' + themeId + ' ' + positionClass);
    root.id = 'gs-widget-root';
    root.style.setProperty('--gs-primary', primaryColor);
    root.style.setProperty('--gs-secondary', secondaryColor);
    root.style.setProperty('--gs-chat-bg', themeDef.chatBg);
    root.style.setProperty('--gs-msg-bg', themeDef.msgBg);
    root.style.setProperty('--gs-input-bg', themeDef.inputBg);
    root.style.setProperty('--gs-text-color', themeDef.textColor);
    root.style.setProperty('--gs-border-color', themeDef.borderColor);
    root.style.setProperty('--gs-panel-radius', themeDef.panelRadius);
    root.style.setProperty('--gs-fab-scale', fabScale);

    /* ── Panel ── */
    var panel = el('section', 'gs-panel');
    panel.setAttribute('aria-hidden', 'true');

    // Header
    var header = el('div', 'gs-panel-header gs-header-' + themeDef.headerStyle);
    var headerMeta = el('div', 'gs-panel-meta');

    if (showLogo && branding.logoUrl) {
      var logo = document.createElement('img');
      logo.className = 'gs-panel-logo';
      logo.src = branding.logoUrl;
      logo.alt = platformName;
      headerMeta.appendChild(logo);
    }

    var heading = el('div', 'gs-panel-title-wrap');
    heading.appendChild(el('strong', 'gs-panel-title', platformName));
    heading.appendChild(el('p', 'gs-panel-subtitle', 'Online now'));
    headerMeta.appendChild(heading);
    header.appendChild(headerMeta);

    var closeBtn = el('button', 'gs-close-button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = ICONS.close;
    header.appendChild(closeBtn);

    // Body
    var body = el('div', 'gs-panel-body');
    body.appendChild(el('p', 'gs-panel-message', welcomeMessage));

    if (branding.greetingMessage) {
      body.appendChild(el('p', 'gs-panel-greeting', branding.greetingMessage));
    }

    var statusRow = el('div', 'gs-status-row');
    statusRow.appendChild(el('span', 'gs-status-dot'));
    statusRow.appendChild(el('span', 'gs-status-text', 'Widget loaded'));
    body.appendChild(statusRow);

    // Input area
    var inputArea = el('div', 'gs-input-area');
    var inputField = document.createElement('input');
    inputField.type = 'text';
    inputField.className = 'gs-input-field';
    inputField.placeholder = branding.placeholderText || 'Type a message...';
    inputArea.appendChild(inputField);

    var sendBtn = el('button', 'gs-send-button');
    sendBtn.type = 'button';
    sendBtn.innerHTML = ICONS.send;
    inputArea.appendChild(sendBtn);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(inputArea);

    /* ── Launcher ── */
    var launcherRow = el('div', 'gs-launcher-row');

    if (fabShape === 'dual') {
      // Dual button mode
      var dualWrap = el('div', 'gs-dual-launcher');

      var chatBtn = el('button', 'gs-dual-btn gs-dual-chat');
      chatBtn.style.background = primaryColor;
      chatBtn.style.color = fabTextColor;
      var chatIconWrap = el('span', 'gs-dual-icon');
      chatIconWrap.innerHTML = ICONS[fabIcon] || ICONS.chat;
      chatBtn.appendChild(chatIconWrap);
      chatBtn.appendChild(el('span', 'gs-dual-label', theme.fabChatLabel || 'Chat'));

      var helpBtn = el('button', 'gs-dual-btn gs-dual-help');
      helpBtn.style.background = secondaryColor;
      helpBtn.style.color = fabTextColor;
      var helpIconWrap = el('span', 'gs-dual-icon');
      helpIconWrap.innerHTML = ICONS[theme.fabHelpIcon] || ICONS.help_circle;
      helpBtn.appendChild(helpIconWrap);
      helpBtn.appendChild(el('span', 'gs-dual-label', theme.fabHelpLabel || 'Help'));

      dualWrap.appendChild(chatBtn);
      dualWrap.appendChild(helpBtn);
      launcherRow.appendChild(dualWrap);

      chatBtn.addEventListener('click', function() { toggle(); });
      helpBtn.addEventListener('click', function() { toggle(); });
    } else {
      // Single launcher
      if (fabShape !== 'pill') {
        launcherRow.appendChild(el('div', 'gs-launcher-label', launcherText));
      }

      var launcher = el('button', 'gs-launcher gs-fab-' + fabShape + (fabAnimation ? ' gs-fab-animated' : ''));
      launcher.type = 'button';
      launcher.setAttribute('aria-label', launcherText);
      launcher.style.background = primaryColor;
      launcher.style.borderRadius = getShapeRadius(fabShape);
      launcher.style.transform = 'scale(' + fabScale + ')';

      var iconWrap = el('span', 'gs-launcher-icon');
      iconWrap.innerHTML = ICONS[fabIcon] || ICONS.chat;
      iconWrap.style.color = fabIconColor;
      launcher.appendChild(iconWrap);

      if (fabShape === 'pill') {
        var pillText = el('span', 'gs-pill-text', theme.fabLabel || launcherText);
        pillText.style.color = fabTextColor;
        launcher.appendChild(pillText);
        launcher.style.width = 'auto';
        launcher.style.paddingLeft = '16px';
        launcher.style.paddingRight = '20px';
        launcher.style.gap = '8px';
      }

      launcherRow.appendChild(launcher);
      launcher.addEventListener('click', function() { toggle(); });
    }

    root.appendChild(panel);
    root.appendChild(launcherRow);
    document.body.appendChild(root);

    /* ── Auto-open ── */
    if (theme.autoOpenDelay > 0) {
      setTimeout(function() { open(); }, theme.autoOpenDelay * 1000);
    }

    /* ── API ── */
    function open() {
      root.classList.add('gs-open');
      panel.setAttribute('aria-hidden', 'false');
    }
    function close() {
      root.classList.remove('gs-open');
      panel.setAttribute('aria-hidden', 'true');
    }
    function toggle() {
      root.classList.contains('gs-open') ? close() : open();
    }

    closeBtn.addEventListener('click', close);

    return { open: open, close: close, toggle: toggle };
  }

  window.__gs_runtime = { init: init };
})();
