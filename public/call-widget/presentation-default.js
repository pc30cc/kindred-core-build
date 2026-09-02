/*!
 * Default Call Widget presentation.
 * This adapter owns presentation lifecycle and safe design-token application.
 * Transport, media-provider integration and persistence remain in runtime.js.
 */
(function (global) {
  'use strict';
  var registry = global.CallWidgetPresentations;
  if (!registry) throw new Error('call_widget_presentation_registry_missing');

  var THEME_KEYS = {
    primary: '--ccw-primary',
    accent: '--ccw-accent',
    surface: '--ccw-surface',
    text: '--ccw-ink',
    muted: '--ccw-muted',
    danger: '--ccw-danger',
  };

  function hexToHslChannels(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return null;
    var r = parseInt(hex.slice(1, 3), 16) / 255;
    var g = parseInt(hex.slice(3, 5), 16) / 255;
    var b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return Math.round(h * 360) + ' ' + Math.round(s * 100) + '% ' + Math.round(l * 100) + '%';
  }

  function applyTheme(root, theme) {
    theme = theme || {};
    Object.keys(THEME_KEYS).forEach(function (key) {
      var value = hexToHslChannels(theme[key]);
      if (value) root.style.setProperty(THEME_KEYS[key], value);
    });
    var surface = hexToHslChannels(theme.surface);
    if (surface) root.style.setProperty('--ccw-panel', surface);
    root.dataset.radius = ['sm', 'md', 'lg'].indexOf(theme.radius) >= 0 ? theme.radius : 'md';
    root.dataset.density = theme.density === 'compact' ? 'compact' : 'comfortable';
  }

  registry.register('default', {
    contractVersion: 1,
    mount: function (context) {
      context.root.classList.add('ccw-presentation-default');
      applyTheme(context.root, context.theme);
      context.render();
      return { root: context.root };
    },
    update: function (instance, context) {
      applyTheme(instance.root, context.theme);
      context.render();
    },
    destroy: function (instance) {
      if (instance && instance.root) instance.root.replaceChildren();
    },
    ready: function () { return Promise.resolve(); },
    prepare: function () { return Promise.resolve(); },
  });
})(window);
