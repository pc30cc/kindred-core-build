(function () {
  'use strict';

  function createNoopApi() {
    return {
      open: function () {},
      close: function () {},
      toggle: function () {},
    };
  }

  function createElement(tag, className, text) {
    var element = document.createElement(tag);

    if (className) {
      element.className = className;
    }

    if (typeof text === 'string') {
      element.textContent = text;
    }

    return element;
  }

  function createLauncherIcon() {
    var wrapper = createElement('span', 'gs-launcher-icon');
    wrapper.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5.5C4 4.11929 5.11929 3 6.5 3H17.5C18.8807 3 20 4.11929 20 5.5V13.5C20 14.8807 18.8807 16 17.5 16H10.4142L6.70711 19.7071C6.07714 20.3371 5 19.891 5 19V16.5C4.44772 16.5 4 16.0523 4 15.5V5.5Z" fill="currentColor"></path></svg>';
    return wrapper;
  }

  function init(config) {
    if (!config || !config.enabled || (config.features && config.features.chat === false)) {
      return createNoopApi();
    }

    var existing = document.getElementById('gs-widget-root');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    var branding = config.branding || {};
    var launcherText = branding.launcherText || 'Chat with us';
    var welcomeMessage = branding.welcomeMessage || 'Hello! How can we help you?';
    var platformName = branding.platformName || 'Support';
    var positionClass = config.position === 'bottom-left' ? 'gs-pos-bottom-left' : 'gs-pos-bottom-right';

    var root = createElement('div', 'gs-widget-root ' + positionClass);
    root.id = 'gs-widget-root';
    root.style.setProperty('--gs-primary', branding.primaryColor || '#3B82F6');

    var panel = createElement('section', 'gs-panel');
    panel.setAttribute('aria-hidden', 'true');

    var header = createElement('div', 'gs-panel-header');
    var headerMeta = createElement('div', 'gs-panel-meta');

    if (branding.logoUrl) {
      var logo = document.createElement('img');
      logo.className = 'gs-panel-logo';
      logo.src = branding.logoUrl;
      logo.alt = platformName;
      headerMeta.appendChild(logo);
    }

    var heading = createElement('div', 'gs-panel-title-wrap');
    heading.appendChild(createElement('strong', 'gs-panel-title', platformName));
    heading.appendChild(createElement('p', 'gs-panel-subtitle', 'Online now'));
    headerMeta.appendChild(heading);
    header.appendChild(headerMeta);

    var closeButton = createElement('button', 'gs-close-button', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close chat');
    header.appendChild(closeButton);

    var body = createElement('div', 'gs-panel-body');
    body.appendChild(createElement('p', 'gs-panel-message', welcomeMessage));

    var statusRow = createElement('div', 'gs-status-row');
    statusRow.appendChild(createElement('span', 'gs-status-dot'));
    statusRow.appendChild(createElement('span', 'gs-status-text', 'Widget loaded successfully.'));
    body.appendChild(statusRow);

    var footer = createElement('div', 'gs-panel-footer');
    footer.appendChild(createElement('span', 'gs-panel-chip', launcherText));

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);

    var launcherRow = createElement('div', 'gs-launcher-row');
    launcherRow.appendChild(createElement('div', 'gs-launcher-label', launcherText));

    var launcher = createElement('button', 'gs-launcher');
    launcher.type = 'button';
    launcher.setAttribute('aria-label', launcherText);
    launcher.appendChild(createLauncherIcon());
    launcherRow.appendChild(launcher);

    root.appendChild(panel);
    root.appendChild(launcherRow);
    document.body.appendChild(root);

    function open() {
      root.classList.add('gs-open');
      panel.setAttribute('aria-hidden', 'false');
    }

    function close() {
      root.classList.remove('gs-open');
      panel.setAttribute('aria-hidden', 'true');
    }

    function toggle() {
      if (root.classList.contains('gs-open')) {
        close();
        return;
      }

      open();
    }

    launcher.addEventListener('click', toggle);
    closeButton.addEventListener('click', close);

    return {
      open: open,
      close: close,
      toggle: toggle,
    };
  }

  window.__gs_runtime = {
    init: init,
  };
})();
