/*!
 * Call widget presentation core: the templates `default` (the Iranian
 * edition's look, skin presentation-default.css) and `intl` (the
 * International edition's, skin presentation-intl.css). Same markup and
 * code; shared/widgetTemplates.ts says which edition wears which.
 *
 * This file is what a page view pays for: the host and its stylesheets, the
 * theme, the launcher, digits and dates, and the persistent panel shell. The
 * panel itself (every screen) is the panel module,
 * presentation-default-panel.js + .css, asked for on the visitor's first
 * intent and handed the helpers `H` below (contract v1, PANEL_V).
 * Transport, media and persistence stay in runtime.js.
 */
(function (global) {
  'use strict';
  var registry = global.CallWidgetPresentations;
  // No registry: its file did not load (l.js starts the files side by side,
  // and a stale loader's hashed registry may be gone while this file is
  // not). Nothing to register with; l.js then loads them again by their
  // fixed names, registry first. Silent: never an uncaught error on the
  // customer's page.
  if (!registry) return;

  /** The panel module contract; bump with the module's `v` when H or the instance changes. */
  var PANEL_V = 1;
  var PANEL_CSS = '/call-widget/presentation-default-panel.css';
  var CALL_PATH = /^\/call-widget\/[a-z0-9.-]+$/i;
  // The chat widget's phone test, so both widgets switch together.
  var PHONE_MQ = '(max-width:640px),(max-height:500px) and (pointer:coarse)';
  var INK = '#16142B';
  var BRAND_ACCENT = { default: '#0B7D6C', intl: INK };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STATE_ON = { online_available: 1, offline: 1 };

  var THEME_KEYS = {
    primary: '--ccw-primary',
    accent: '--ccw-accent',
    surface: '--ccw-surface',
    text: '--ccw-ink',
    muted: '--ccw-muted',
    danger: '--ccw-danger',
  };
  var LOCALE_DIR = { fa: 'rtl' };

  // ─── module state (one widget per page) ──────────────────────────────────
  var hostCtx = null;    // createHost's context: origin, runtimeAssetSuffix, assetUrl, fontsUrl, bootstrap
  var shadow = null;
  var skinLink = null;   // the panel stylesheet goes right before it
  var rootEl = null;
  var C = null;          // the controller of the last render
  var N = null;          // persistent nodes
  var audio = {};
  var loadPanelFn = null;
  var rendering = false;
  var UI = {
    callbackStep: 1, editingContact: false, lastOperatorName: null, previousOperatorName: null,
    bookingView: false, daySel: null, autoOpened: false,
  };
  // The panel module: module 0 none, 1 loading, 2 in, 3 failed; css the same.
  var P = { mod: 0, css: 0, inst: null, link: null, gen: 0, warm: 0, failed: false, byVisitor: false, auto: false };
  var L = { sig: '', vis: false, state: null, transferring: false, labelHidden: false, open: false, shAt: 0, shTimer: 0, mob: false };

  // ─── small helpers ───────────────────────────────────────────────────────
  function noop() {}

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      // Boolean attributes are present or absent, never "true"/"false".
      if (value === false || value == null) return;
      if (key === 'class') node.className = value;
      else if (key === 'on') Object.keys(value).forEach(function (ev) { node.addEventListener(ev, value[ev]); });
      else if (key === 'style') Object.keys(value).forEach(function (p) { node.style.setProperty(p, value[p]); });
      else node.setAttribute(key, value === true ? '' : value);
    });
    (children || []).forEach(function (child) {
      if (child == null || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  /**
   * Icons: 24×24, stroked with currentColor (HO/shared/icons). One entry is
   * a list of elements split by "|": a path's d, "c cx cy r" a circle,
   * "r x y w h rx" a rect. The panel module adds its own entries.
   */
  var PHONE = 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z';
  var ICONS = {
    phone: PHONE,
    'phone-in': PHONE + '|M15.6 3v5.2h5.2M21.4 2.4l-5.8 5.8',
    video: 'M15.5 10.2l4.7-2.8a.8.8 0 0 1 1.2.7v7.8a.8.8 0 0 1-1.2.7l-4.7-2.8|r2.6 6.2 12.9 11.6 3',
    x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    cal: 'r3.6 5 16.8 15.4 3.2|M8 3v3.6M16 3v3.6M3.6 10h16.8',
  };

  function svg(name, size, stroke, cls) {
    var rot = name === 'hangup';
    var def = ICONS[rot ? 'phone' : name] || '';
    var s = document.createElementNS(SVG_NS, 'svg');
    var attrs = {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': stroke || 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    };
    if (cls) attrs['class'] = cls;
    Object.keys(attrs).forEach(function (k) { s.setAttribute(k, String(attrs[k])); });
    def.split('|').forEach(function (part) {
      if (!part) return;
      var kind = part.charAt(0);
      var n = part.slice(1).split(' ');
      var node;
      if (kind === 'c') {
        node = document.createElementNS(SVG_NS, 'circle');
        node.setAttribute('cx', n[0]); node.setAttribute('cy', n[1]); node.setAttribute('r', n[2]);
      } else if (kind === 'r') {
        node = document.createElementNS(SVG_NS, 'rect');
        node.setAttribute('x', n[0]); node.setAttribute('y', n[1]);
        node.setAttribute('width', n[2]); node.setAttribute('height', n[3]); node.setAttribute('rx', n[4]);
      } else {
        node = document.createElementNS(SVG_NS, 'path');
        node.setAttribute('d', part);
      }
      if (rot) node.setAttribute('transform', 'rotate(135 12 12)');
      s.appendChild(node);
    });
    return s;
  }

  function setText(node, text) {
    text = text == null ? '' : String(text);
    if (node && node.textContent !== text) node.textContent = text;
  }
  function toggle(node, cls, on) {
    if (node && node.classList.contains(cls) !== !!on) node.classList.toggle(cls, !!on);
  }
  function attr(node, name, value) {
    if (!node) return;
    if (value == null || value === false) { if (node.hasAttribute(name)) node.removeAttribute(name); }
    else if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  }

  function boot() { return (C && C.bootstrap) || {}; }
  function cfgOf() { return boot().config || {}; }
  function tr(key, vars) { return C ? C.t(key, vars) : key; }

  // ─── digits, clocks, dates ───────────────────────────────────────────────
  function isFa() { return !!C && C.locale === 'fa'; }
  /** Every printed number in Persian digits in fa; typed input never goes through it. */
  function dig(x) {
    var s = String(x == null ? '' : x);
    return isFa() ? s.replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'.charAt(+d); }) : s;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** m:ss, h:mm:ss from one hour; never negative. */
  function fmtClock(ms) {
    var s = Math.max(0, Math.floor((+ms || 0) / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return dig((h ? h + ':' + pad2(m) : m) + ':' + pad2(s % 60));
  }
  function dateTag() {
    var loc = C ? C.locale : 'en';
    if (loc === 'fa') return boot().calendar === 'gregorian' ? 'fa-IR-u-ca-gregory-nu-arabext' : 'fa-IR-u-ca-persian-nu-arabext';
    return loc === 'tr' ? 'tr-TR' : 'en-US';
  }
  /** In the bootstrap's zone (an unknown zone: the visitor's); never throws. */
  function fmtIn(tag, d, opts, parts) {
    var zone = boot().time_zone;
    if (typeof zone === 'string' && zone) opts.timeZone = zone;
    for (var i = 0; i < 2; i++) {
      try {
        var f = new Intl.DateTimeFormat(tag, opts);
        return parts ? f.formatToParts(d) : f.format(d);
      } catch (_) { delete opts.timeZone; }
    }
    return parts ? [] : '';
  }
  function toDate(x) { return x instanceof Date ? x : new Date(x); }
  /** The calendar day of an instant in the bootstrap's zone (the visitor's when none): YYYY-MM-DD, built from the parts (no locale's date order). */
  function dayKey(x) {
    var p = {};
    fmtIn('en-US', toDate(x), { year: 'numeric', month: '2-digit', day: '2-digit' }, true).forEach(function (q) { p[q.type] = q.value; });
    return p.year + '-' + p.month + '-' + p.day;
  }
  function nextKey(key) {
    var p = key.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + 1));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  /** «امروز» / «فردا» / the weekday (long in fa, short in en and tr). */
  function fmtDay(x) {
    var key = dayKey(x);
    var today = dayKey(Date.now());
    if (key === today) return tr('today');
    if (key === nextKey(today)) return tr('tomorrow');
    return fmtIn(dateTag(), toDate(x), { weekday: isFa() ? 'long' : 'short' });
  }
  /** 24 h in fa and tr («۱۶:۳۰», 16:30), 12 h in en (4:30 PM). */
  function fmtTime(x) {
    var en = !C || C.locale === 'en';
    return fmtIn(dateTag(), toDate(x), en ? { hour: 'numeric', minute: '2-digit', hour12: true } : { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
  }
  /** «فردا ساعت ۱۶:۳۰» / "tomorrow at 4:30 PM": the `{when}` of `reach_out`. */
  function fmtWhen(iso) {
    var day = fmtDay(iso);
    var key = dayKey(iso);
    var today = dayKey(Date.now());
    if (C && C.locale !== 'fa' && (key === today || key === nextKey(today))) day = day.toLocaleLowerCase(C.locale);
    return day + ' ' + tr('at_time', { time: fmtTime(iso) });
  }

  // ─── theme (§2.7): stored colours win, unset ones take the design's ──────
  function hex6(v) { return /^#[0-9a-f]{6}$/i.test(v || '') ? String(v) : null; }
  function hexToHslChannels(hex) {
    if (!hex6(hex)) return null;
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
  function lum(hex) {
    var c = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  /** Text on the accent: white when it contrasts at least as well as Ink. */
  function onAccent(hex) {
    var l = lum(hex);
    return 1.05 / (l + 0.05) >= (l + 0.05) / (lum(INK) + 0.05) ? '#FFFFFF' : INK;
  }
  function applyTheme(root, theme, brand) {
    theme = theme || {};
    var st = root.style;
    function set(name, value) { if (value) st.setProperty(name, value); else st.removeProperty(name); }
    Object.keys(THEME_KEYS).forEach(function (key) {
      var value = hexToHslChannels(theme[key]);
      if (value) st.setProperty(THEME_KEYS[key], value);
    });
    var surface = hexToHslChannels(theme.surface);
    if (surface) st.setProperty('--ccw-panel', surface);
    var primary = hex6(theme.primary);
    var onA = onAccent(primary || BRAND_ACCENT[brand]);
    set('--a', primary);
    set('--on-a', onA);
    // A light accent: links, icon tiles and the focus ring keep the ink.
    set('--a-ink', onA === INK ? 'var(--ink)' : null);
    set('--ring', onA === INK ? 'var(--ink)' : null);
    // The intl stage takes a colour other than its Ink (board 12-02), held
    // dark: --a-k keeps luminance <= .15 (an oklab mix with black scales
    // linear RGB by k³); the skin does the rest where color-mix() exists.
    // WebYar's stage follows its colour (runtime.css); one lighter than the
    // lightest preset (#D9480F) is held at .195, the glow too (the skin).
    var tint = brand === 'intl' && !!primary && primary.toUpperCase() !== INK;
    var hold = brand !== 'intl' && !!primary && lum(primary) > 0.195;
    toggle(root, 'tint', tint);
    toggle(root, 'hold', hold);
    set('--a-k', tint || hold ? (100 * Math.min(1, Math.cbrt((tint ? 0.15 : 0.195) / lum(primary)))).toFixed(1) + '%' : null);
    var accent = hex6(theme.accent);
    if (brand === 'intl') set('--signal', accent);
    else {
      set('--live', accent);
      set('--live-hi', accent ? 'color-mix(in oklab,' + accent + ' 75%,#fff)' : null);
    }
    var danger = hex6(theme.danger);
    set('--end', danger);
    set('--bad', danger);
    set('--ink', hex6(theme.text));
    set('--ink-3', hex6(theme.muted));
    set('--panel', hex6(theme.surface));
    root.dataset.radius = ['sm', 'md', 'lg'].indexOf(theme.radius) >= 0 ? theme.radius : 'md';
    root.dataset.density = theme.density === 'compact' ? 'compact' : 'comfortable';
  }
  function brand() { return rootEl && rootEl.classList.contains('ccw-presentation-intl') ? 'intl' : 'default'; }
  function onA() { return (rootEl && rootEl.style.getPropertyValue('--on-a')) || '#FFFFFF'; }

  // ─── presence, placement ─────────────────────────────────────────────────
  /** Online (channels on) and someone available (presence, when the server sends it). */
  function staffed(ctrl) {
    ctrl = ctrl || C;
    var pr = ctrl && ctrl.bootstrap && ctrl.bootstrap.presence;
    return !!ctrl && ctrl.isOnline() && !(pr && pr.any_available === false);
  }
  var PLACE = { right: 'right', left: 'left', top_right: 'right top', top_left: 'left top', bottom_center: 'center' };
  function launcherStyle() {
    var s = cfgOf().launcher_style;
    return typeof s === 'string' && /^[a-z_]{1,32}$/.test(s) ? s : 'round_label';
  }
  /** The placement classes of the launcher wrap and the panel. */
  function placement() {
    var pos = (C && C.position && C.position()) || 'right';
    var cls = PLACE[pos] || 'right';
    if (launcherStyle() === 'edge_tab') cls = (pos === 'left' || pos === 'top_left' ? 'left' : 'right') + ' edge';
    // A phone has one corner: the top placements come down to it (P7).
    return isMobile() ? cls.replace(' top', '') : cls;
  }
  function isMobile() {
    try { return !!global.matchMedia && global.matchMedia(PHONE_MQ).matches; } catch (_) { return false; }
  }

  // ─── announcements, focus, root classes ──────────────────────────────────
  function announce(text) {
    if (!N || !text) return;
    // The same words again must still be heard: toggle an invisible tail.
    if (N.live.textContent === text) text += '​';
    N.live.textContent = text;
  }
  function active() {
    var sr = rootEl && rootEl.getRootNode && rootEl.getRootNode();
    return sr && sr.activeElement;
  }
  function focusNode(node) {
    try { node.focus({ preventScroll: true }); } catch (_) { try { node.focus(); } catch (__) { /* gone */ } }
  }
  /** A screen change never drops focus to <body>: the new screen's heading, else the panel. */
  function focusScreen(scr) {
    var a = active();
    if (!N || !a || !N.panel.contains(a) || (scr && scr.contains(a))) return;
    var target = scr && scr.querySelector('[data-focus],h2,h3');
    if (target) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      focusNode(target);
    } else focusNode(N.panel);
  }
  var ROOT_CLASSES = { dark: 1, incall: 1, toRate: 1, q1: 1, q2: 1, 'is-mobile': 1 };
  function rootToggle(cls, on) { if (ROOT_CLASSES[cls]) toggle(rootEl, cls, on); }
  /**
   * The stage spreads out of the pressed element (a launcher's split half
   * too, pressed while the panel is still folded: its box is read without
   * the fold's transform).
   */
  function stageOrigin(node) {
    if (!N || !node || !node.getBoundingClientRect) return;
    var p = N.panel.getBoundingClientRect();
    var x = p.left, y = p.top, w = N.panel.offsetWidth || p.width, h = N.panel.offsetHeight || p.height;
    try {
      var cs = global.getComputedStyle(N.panel);
      var l = parseFloat(cs.left) + parseFloat(cs.marginLeft);
      var t = parseFloat(cs.top) + parseFloat(cs.marginTop);
      if (isFinite(l) && isFinite(t)) { x = l; y = t; }
    } catch (_) { /* the transformed box then */ }
    var r = node.getBoundingClientRect();
    if (!w || !h) return;
    N.dk.style.setProperty('--cx', ((r.left + r.width / 2 - x) / w * 100).toFixed(1) + '%');
    N.dk.style.setProperty('--cy', ((r.top + r.height / 2 - y) / h * 100).toFixed(1) + '%');
  }
  function requestRender() { if (C && !rendering) C.render(); }

  // ─── fonts: faces warmed from the skin's own stack (no family named here) ─
  function sample() {
    var loc = rootEl && rootEl.getAttribute('lang');
    if (loc === 'fa') return 'سلام';
    return loc === 'tr' && brand() === 'intl' ? 'Aaş' : 'Aa';
  }
  /**
   * Loads the faces `weights` of the root's font stack need for its script;
   * never throws. Only the stack's first family: FontFaceSet.load() fetches
   * every listed family whose range the sample touches (a Persian face
   * covering Latin would come with an English page).
   */
  function warm(weights) {
    try {
      var fonts = document.fonts;
      var stack = rootEl && global.getComputedStyle(rootEl).fontFamily;
      var first = stack && /^\s*("[^"]*"|'[^']*'|[^,]+)/.exec(stack);
      if (!fonts || typeof fonts.load !== 'function' || !first) return Promise.resolve();
      var text = sample();
      return Promise.all(weights.map(function (w) {
        return fonts.load(w + ' 16px ' + first[1].trim(), text).then(noop, noop);
      })).then(noop, noop);
    } catch (_) { return Promise.resolve(); }
  }
  function capped(promise, ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
      promise.then(resolve, resolve);
    });
  }
  /** The fonts link has loaded (or there is none, or it failed). */
  function fontsLinked(cb) {
    var link = document.getElementById('gs-presentation-fonts');
    if (!link || link.sheet) { cb(); return; }
    var done = false;
    function once() { if (!done) { done = true; cb(); } }
    link.addEventListener('load', once);
    link.addEventListener('error', once);
  }
  /** Launchers without text: no face to wait for at page load. */
  function launcherHasText(boot0) {
    var s = boot0 && boot0.config && boot0.config.launcher_style;
    return s !== 'round' && s !== 'dark_square';
  }

  // ─── the panel module: requested on intent, open once ready ──────────────
  function assetsOf() { return boot().assets || (hostCtx && hostCtx.bootstrap && hostCtx.bootstrap.assets) || {}; }
  function panelReady() { return !!P.inst && P.css === 2 && P.warm === 2; }

  /** An intent (or an open): the panel's files and the faces of its first paint, which the open waits for. */
  function requestPanel() {
    if (!hostCtx || !N) return;
    if (!P.warm) {
      P.warm = 1;
      var fonts = document.fonts;
      if (!fonts || typeof fonts.load !== 'function') P.warm = 2;
      else capped(warm(['400', '500', '700']), 500).then(function () { P.warm = 2; requestRender(); });
    }
    prefetch();
  }
  /** The panel's script and stylesheet only (a touch screen's idle time: the faces wait for an intent). */
  function prefetch() {
    if (!hostCtx || !N) return;
    if (P.failed) {
      // A failed attempt: the next intent tries again with new elements.
      P.failed = false;
      if (P.mod === 3) P.mod = 0;
      if (P.css === 3) { if (P.link && P.link.parentNode) P.link.parentNode.removeChild(P.link); P.link = null; P.css = 0; }
    }
    if (!P.css) panelCss();
    if (!P.inst && !P.mod) panelModule();
  }

  function panelCss() {
    var a = assetsOf();
    var path = CALL_PATH.test(a.presentation_panel_style_url || '') ? a.presentation_panel_style_url : PANEL_CSS;
    var fixed = hostCtx.origin + path + (hostCtx.runtimeAssetSuffix || '');
    var first = typeof hostCtx.assetUrl === 'function' ? hostCtx.assetUrl(path) : fixed;
    var link = document.createElement('link');
    var retried = false;
    link.rel = 'stylesheet';
    link.onload = function () {
      if (P.link !== link) return;
      P.css = 2;
      requestRender();
    };
    link.onerror = function () {
      if (P.link !== link) return;
      if (!retried && fixed !== first) { retried = true; link.href = fixed; return; }
      P.css = 3;
      failed();
    };
    link.href = first;
    P.link = link;
    P.css = 1;
    // runtime.css → panel → skin: the skin keeps the last word.
    if (skinLink && skinLink.parentNode === shadow) shadow.insertBefore(link, skinLink);
    else shadow.insertBefore(link, rootEl);
  }

  function panelModule() {
    if (global.__ccw_panel) { createPanel(); return; }
    // An old loader (no hook) meeting this file: no panel on this page view.
    if (!loadPanelFn) { P.mod = 3; failed(); return; }
    P.mod = 1;
    var gen = ++P.gen;
    try {
      loadPanelFn(function (ok) {
        if (gen !== P.gen || P.mod !== 1) return;
        if (ok && global.__ccw_panel) createPanel();
        else { P.mod = 3; failed(); }
      });
    } catch (_) { P.mod = 3; failed(); }
  }

  function createPanel() {
    var mod = global.__ccw_panel;
    try {
      // Another deploy's module (another contract) is refused, never half-applied.
      if (!mod || mod.v !== PANEL_V || typeof mod.create !== 'function') throw new Error('panel');
      var inst = mod.create(H);
      if (!inst || typeof inst.render !== 'function') throw new Error('panel');
      P.inst = inst;
      P.mod = 2;
    } catch (_) {
      if (mod && mod.v !== PANEL_V) global.__ccw_panel = undefined;
      P.inst = null;
      P.mod = 3;
      failed();
      return;
    }
    requestRender();
  }

  /** The panel cannot open now: the launcher stays; a visitor's open is put back. */
  function failed() {
    P.failed = true;
    Promise.resolve().then(function () {
      if (!C || !P.failed) return;
      if (C.open && !P.auto) C.toggleOpen();
      else requestRender();
    });
  }

  // ─── launchers (§2.11): the nine styles, their states, the booked callback ─
  var STYLES = { round: 1, round_label: 1, pill: 1, card: 1, split: 1, edge_tab: 1, dark_square: 1, operator_face: 1, mobile_bar: 1 };
  /** setTimeout's longest delay. */
  var MAX_DELAY = 2147483647;
  /** A picture the server named: http(s) or a path on the page's origin; anything else is not drawn. */
  function picUrl(u) { return typeof u === 'string' && /^(https?:\/\/|\/(?!\/))/i.test(u) ? u : null; }
  /**
   * The operators presence names (card, operator_face): at most three, each
   * with a name or a photo. Without a photo the face is the person
   * silhouette (`.sil`, runtime.css), never a letter (owner, 2026-10-24).
   */
  function operators() {
    var pr = boot().presence;
    return (pr && Array.isArray(pr.operators) ? pr.operators : []).filter(function (o) {
      return !!o && typeof o === 'object' && !!(named(o) || picUrl(o.avatar_url));
    }).slice(0, 3);
  }
  function named(o) { return typeof o.name === 'string' && !!o.name.trim(); }
  /** The first operator with a name (operator_face draws them; without one it is round_label). */
  function faceOp() {
    var list = operators();
    for (var i = 0; i < list.length; i++) if (named(list[i])) return list[i];
    return null;
  }
  /** A face: the photo, else the silhouette on the tone's tile. */
  function face(cls, src) {
    return el('span', { class: 'av ' + cls + (src ? '' : ' sil') }, src ? [el('img', { src: src, alt: '' })] : null);
  }
  /**
   * The style drawn: unknown → round_label; mobile_bar on phones only (the
   * pill beside a chat launcher, whose corner a full-width bar would sit
   * under); round_label → the pill on phones; operator_face needs a named
   * operator; a dismissed label → round for the session (D6, D14, D4).
   */
  function resolvedStyle(ctrl) {
    var s = launcherStyle();
    if (!STYLES[s]) s = 'round_label';
    var mob = isMobile();
    if (s === 'mobile_bar' && (!mob || CH.on)) s = mob ? 'pill' : 'round_label';
    if (s === 'operator_face' && !faceOp()) s = 'round_label';
    if (s === 'round_label') s = mob ? 'pill' : ctrl.labelDismissed || L.labelHidden ? 'round' : s;
    return s;
  }
  /** The booked callback still ahead (D15): its instant, else 0. */
  function bookedAt(ctrl) {
    var b = ctrl.callbackBooking;
    var at = b && b.scheduled_for ? Date.parse(b.scheduled_for) : NaN;
    return at > Date.now() ? at : 0;
  }
  /** One timer to the booking's instant (capped), then a render takes it off the button. */
  function armBooking(at) {
    if (at === L.shAt) return;
    clearTimeout(L.shTimer);
    L.shAt = at;
    if (at) L.shTimer = setTimeout(function () { L.shAt = 0; requestRender(); }, Math.min(MAX_DELAY, at - Date.now() + 1));
  }

  function launcherSig(ctrl, style) {
    var cfg = cfgOf();
    var caps = (ctrl.bootstrap && ctrl.bootstrap.capabilities) || {};
    var pol = (ctrl.bootstrap && ctrl.bootstrap.callback_policy) || {};
    return [style, ctrl.isOnline() ? 1 : 0, staffed(ctrl) ? 1 : 0, cfg.offline_behavior || 'show_callback', ctrl.locale, placement(),
      picUrl(cfg.avatar_url) || '', JSON.stringify(operators()), caps.voice ? 1 : 0, caps.video ? 1 : 0, caps.callback ? 1 : 0,
      pol.show_when_online === false ? 0 : 1].join('|');
  }

  /** The launcher element focus returns to (split and the bar have no toggling button). */
  function launcherFocus() { return (N.btn && N.btn.isConnected && N.btn) || N.wrap.querySelector('button'); }

  /** `booking`: Sh's press, which shows the booked callback (screen 19); any other press never does. */
  function openFromLauncher(e, booking) {
    if (e && e.target && e.target.closest && e.target.closest('[data-action="label-close"]')) return;
    if (!C) return;
    UI.bookingView = !!booking;
    P.byVisitor = true;
    P.auto = false;
    // Open but not shown yet (its files on the way, or a failed restore):
    // a press asks again instead of closing what nobody sees.
    if (C.open && !L.vis) { requestPanel(); requestRender(); return; }
    C.toggleOpen();
  }

  /** A split half or a bar button: opens the panel, then starts its call (or the callback form) inside the click. */
  function launch(action, node) {
    if (!C) return;
    UI.bookingView = false;
    P.byVisitor = true;
    P.auto = false;
    stageOrigin(node);
    if (!C.open) C.toggleOpen();
    else requestPanel();
    if (action === 'voice' || action === 'video') C.startCall(action);
    else if (action === 'callback') C.openCallback();
  }

  function closeLabel(e) {
    e.stopPropagation();
    var had = active() === e.currentTarget;
    if (typeof C.dismissLabel === 'function') C.dismissLabel();
    else { L.labelHidden = true; requestRender(); }
    // The button leaves with its label: focus stays on the launcher, never <body>.
    if (had && N && N.btn && N.btn.isConnected) focusNode(N.btn);
  }

  function buildLauncher(ctrl, style) {
    var cfg = cfgOf();
    var caps = (ctrl.bootstrap && ctrl.bootstrap.capabilities) || {};
    var online = ctrl.isOnline();
    // The callback words only while a callback can be requested (the panel's own rule).
    var cb = !online && !!caps.callback && (cfg.offline_behavior || 'show_callback') === 'show_callback';
    var staff = staffed(ctrl);
    var left = / ?left/.test(placement());
    var ic = online ? 'phone' : 'phone-in';
    // Offline, every style keeps its shape with the callback words (or production's offline words).
    var offT = cb ? 'callback' : 'support';
    var offS = cb ? 'leave_details' : 'offline';
    var name = cb ? 'callback' : 'open_widget';
    N.btn = null;

    /** The button that toggles the panel; icon-only ones carry a name, the others are named by their words. */
    function main(cls, kids, label) {
      N.btn = el('button', {
        class: cls + ' ccw-launcher-btn', type: 'button', 'data-action': 'open', 'aria-label': label ? tr(label) : null,
        'aria-expanded': 'false', 'aria-controls': 'ccw-panel', on: { click: openFromLauncher },
      }, kids);
      return N.btn;
    }
    function dot(cls) { return el('i', { class: cls + (staff ? '' : ' off') }); }
    function lbl(kids) { return el('span', { class: 'lbl', dir: LOCALE_DIR[ctrl.locale] || 'ltr', on: { click: openFromLauncher } }, kids); }
    function lblKids(close) {
      return [close, el('b', {}, [tr(online ? 'talk_now' : offT)]), el('small', {}, [dot('dot'), tr(online ? 'live_support' : offS)])];
    }
    /** The round button; online with a business logo it wears the logo and flips to the call face (Sc, D37). */
    function round() {
      var logo = online && picUrl(cfg.avatar_url);
      if (logo) {
        return main('ln ln-c logo', [
          el('span', { class: 'fc' }, [el('span', { class: 'f1' }, [el('img', { src: logo, alt: '' })]), el('span', { class: 'f2' }, [svg('phone', 26, 1.9)])]),
          dot('ls'),
        ], name);
      }
      return main('ln ln-c' + (online ? '' : ' off'), [svg(ic, 26, 1.9, online ? 'wig' : null), dot('ls'), online ? el('i', { class: 'wv' }) : null], name);
    }
    function half(action, cls, icon, key) {
      return el('button', { class: cls, type: 'button', 'data-action': action, on: { click: function (e) { launch(action, e.currentTarget); } } }, [svg(icon, style === 'split' ? 19 : 17, 1.9), tr(key)]);
    }
    var at = left ? ' at-l' : '';
    var off = online ? '' : ' off';

    if (style === 'round') {
      // The label shows on hover and keyboard focus, without its close x
      // (D6); the button names itself. After the button: its focus shows it.
      var hover = lbl(lblKids(null));
      hover.setAttribute('aria-hidden', 'true');
      return el('div', { class: 'ln-h' + at }, [round(), hover]);
    }
    if (style === 'pill') {
      return main('ln ln-p' + off, [el('span', { class: 'pi' }, [svg(ic, 22, 1.9)]), tr(online ? 'launcher_pill' : offT), dot('ld'), online ? el('i', { class: 'wv' }) : null]);
    }
    if (style === 'card') {
      var ops = operators();
      return main('ln ln-r' + off, [
        ops.length ? el('span', { class: 'avs', 'aria-hidden': 'true' }, ops.map(function (o, i) {
          return face('c' + (i + 1), picUrl(o.avatar_url));
        })) : null,
        el('span', { class: 'tx' }, [
          el('b', {}, [tr(online ? 'talk_to_team' : offT)]),
          el('small', {}, [dot('dot'), tr(!online ? offS : staff ? 'operators_available' : 'no_operator_now')]),
        ]),
        el('span', { class: 'go2' }, [svg(ic, 22, 1.9)]),
      ]);
    }
    if (style === 'split') {
      var halves = [];
      if (!online) halves.push(half(cb ? 'callback' : 'open', 'hf pri', 'phone-in', offT));
      else {
        if (caps.voice) halves.push(half('voice', 'hf pri', 'phone', 'voice_call'));
        if (caps.voice && caps.video) halves.push(el('i', { class: 'dv' }));
        if (caps.video) halves.push(half('video', caps.voice ? 'hf' : 'hf pri', 'video', 'video'));
      }
      return el('div', { class: 'ln ln-s' + off, role: 'group', 'aria-label': tr('launcher_tab') }, halves);
    }
    if (style === 'edge_tab') {
      return main('ln ln-t' + at + off, [svg(ic, 20, 1.9), el('span', { class: 'vt' }, [tr(online ? 'launcher_tab' : offT)]), dot('ld')]);
    }
    if (style === 'dark_square') return main('ln ln-q' + off, [svg(ic, 24, 1.9), dot('ls')], name);
    if (style === 'operator_face') {
      var op = faceOp();
      var photo = picUrl(op.avatar_url);
      var fp = main('fp', [
        el('span', { class: 'pic' }, [photo ? el('img', { src: photo, alt: '' }) : face('c1')]),
        online ? el('i', { class: 'ring2' }) : null,
        el('span', { class: 'pb' }, [svg(ic, 14, 2.2)]),
      ], name);
      return el('div', { class: 'ln-f' + at }, [
        lbl([el('b', {}, [tr(online ? 'talk_now' : offT)]), el('small', {}, [dot('dot'), online ? op.name.trim() : tr(offS)])]),
        fp,
      ]);
    }
    if (style === 'mobile_bar') {
      var pol = (ctrl.bootstrap && ctrl.bootstrap.callback_policy) || {};
      var bar = [];
      if (online && (caps.voice || caps.video)) bar.push(half(caps.voice ? 'voice' : 'video', 'btn pri', caps.voice ? 'phone' : 'video', caps.voice ? 'voice_call' : 'video_call'));
      if (cb || (online && caps.callback && pol.show_when_online !== false)) bar.push(half('callback', 'btn sec', 'phone-in', 'callback'));
      if (!online && !cb) bar.push(half('open', 'btn sec', 'phone-in', offT));
      return el('div', { class: 'mbar' }, bar);
    }
    // round_label (L2): the label with its close x online (D6); the offline label (Sd) has none.
    var close = online ? el('button', {
      class: 'x', type: 'button', 'data-action': 'label-close', 'aria-label': tr('close'), on: { click: closeLabel },
    }, [svg('x', 12, 2.6)]) : null;
    return el('div', { class: 'ln-cl' + at }, [lbl(lblKids(close)), round()]);
  }

  /** Sh: the booked callback stays on the button until its time; a press shows it (screen 19). */
  function buildBooked(at) {
    N.btn = el('button', {
      class: 'sched ccw-launcher-btn', type: 'button', 'data-action': 'open', 'aria-expanded': 'false', 'aria-controls': 'ccw-panel',
      on: { click: function (e) { openFromLauncher(e, 1); } },
    }, [
      el('span', { class: 'si' }, [svg('cal', 20, 1.9)]),
      el('span', { class: 'tx' }, [el('b', {}, [tr('callback_scheduled')]), el('small', {}, [fmtDay(at) + ' ' + fmtTime(at)])]),
    ]);
    return N.btn;
  }

  function renderLauncher(ctrl, vis) {
    var mini = null;
    // The bars are styled by the panel stylesheet alone, and stand for a closed
    // panel: an open still on its way keeps the launcher, busy (§2.3).
    if (!ctrl.open && P.css === 2 && P.inst && typeof P.inst.launcherMini === 'function'
      && (ctrl.state === 'loading' || ctrl.state === 'queue_waiting' || ctrl.state === 'in_call')) {
      try { mini = P.inst.launcherMini(ctrl, N.wrap); } catch (_) { mini = null; }
    }
    var at = STATE_ON[ctrl.state] ? bookedAt(ctrl) : 0;
    var style = resolvedStyle(ctrl);
    // The phone's bottom bar spans the screen in its own wrap (it leaves and returns with it); a minimised call keeps the corner.
    attr(N.wrap, 'class', 'ccw-launcher-wrap ' + placement() + (mini || at || style !== 'mobile_bar' ? '' : ' bar'));
    if (mini) {
      if (N.wrap.firstChild !== mini || N.wrap.childNodes.length !== 1) { N.wrap.replaceChildren(mini); stackSoon(); }
      L.sig = '';
      return;
    }
    armBooking(at);
    var sig = at ? ['sched', ctrl.locale, fmtDay(at), fmtTime(at)].join('|') : launcherSig(ctrl, style);
    if (sig !== L.sig || !N.wrap.firstChild) {
      N.wrap.replaceChildren(at ? buildBooked(at) : buildLauncher(ctrl, style));
      L.sig = sig;
      stackSoon();
    }
    attr(N.btn, 'aria-expanded', vis ? 'true' : 'false');
    attr(N.btn, 'aria-busy', ctrl.open && !vis && !P.failed ? 'true' : null);
  }

  // ─── two widgets (D4): above a chat launcher in the same corner ─────────
  // The chat widget (<gs-widget>, open shadow root) is only read: its
  // launcher's box. Bottom placements lift the launcher (and the minimised
  // bars) to 16px above it when their spans meet; the open panel keeps its
  // corner, above the chat by z-index.
  var CH = { sr: null, mo: null, inner: null, ro: null, raf: 0, on: false, stack: 0 };
  function chatWatch() {
    var MO = global.MutationObserver;
    if (CH.mo || !MO || !document.body) return;
    CH.mo = new MO(chatFind);
    CH.mo.observe(document.body, { childList: true });
    // Its launcher's class and style (shown, open, its size) and its shell's.
    CH.inner = new MO(stackSoon);
    if (global.ResizeObserver) { CH.ro = new global.ResizeObserver(stackSoon); CH.ro.observe(N.wrap); }
    if (global.visualViewport) global.visualViewport.addEventListener('resize', stackSoon);
    chatFind();
  }
  function chatUnwatch() {
    [CH.mo, CH.inner, CH.ro].forEach(function (o) { if (o) o.disconnect(); });
    global.removeEventListener('resize', turned);
    global.removeEventListener('orientationchange', turned);
    if (global.visualViewport) global.visualViewport.removeEventListener('resize', stackSoon);
    CH = { sr: null, mo: null, inner: null, ro: null, raf: 0, on: false, stack: 0 };
  }
  function chatFind() {
    // A window already gone (closed while a mutation record was queued) has no document.
    var doc = global.document;
    var host = doc && doc.querySelector('gs-widget');
    var sr = (host && host.shadowRoot) || null;
    if (sr !== CH.sr) {
      CH.sr = sr;
      CH.inner.disconnect();
      if (sr) CH.inner.observe(sr, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    }
    stackSoon();
  }
  function stackSoon() {
    if (CH.raf || !N) return;
    CH.raf = 1;
    (global.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(measureStack);
  }
  /** The chat launcher's box without its own motion (hover lift, entry), or null while it does not show. */
  function chatBox() {
    var b = CH.sr && CH.sr.querySelector('.launcher');
    var sh = CH.sr && CH.sr.querySelector('.shell');
    if (!b || b.classList.contains('pending') || b.classList.contains('open')
      || (sh && sh.classList.contains('gs-mobile-open'))) return null;
    var cs = global.getComputedStyle(b);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    var r;
    if (sh && b.offsetParent === sh) {
      var s = sh.getBoundingClientRect();
      r = { left: s.left + b.offsetLeft, top: s.top + b.offsetTop, width: b.offsetWidth, height: b.offsetHeight };
    } else r = b.getBoundingClientRect();
    if (!r.width || !r.height || r.left + r.width <= 0 || r.top + r.height <= 0 || r.left >= global.innerWidth || r.top >= global.innerHeight) return null;
    return r;
  }
  function measureStack() {
    CH.raf = 0;
    if (!N || !rootEl) return;
    var box = chatBox();
    var px = 0;
    if (box && !/top|edge/.test(placement())) {
      var w = N.wrap.getBoundingClientRect();
      if (w.width && box.left - 16 < w.right && box.left + box.width + 16 > w.left) {
        // The corner offset, resolved (a phone's has the safe area in it): runtime.css mirrors it in scroll-margin-bottom.
        var y = parseFloat(global.getComputedStyle(N.wrap).scrollMarginBottom);
        px = Math.max(0, global.innerHeight - box.top + 16 - (isFinite(y) ? y : 22));
      }
    }
    if (px !== CH.stack) {
      CH.stack = px;
      N.wrap.style.setProperty('--ccw-stack', px + 'px');
    }
    if (!!box !== CH.on) {
      CH.on = !!box;
      // A phone's bottom bar turns into the pill beside a chat launcher.
      if (launcherStyle() === 'mobile_bar') requestRender();
    }
  }

  // ─── phones (D14) ───────────────────────────────────────────────────────
  /** A rotation or a resize can make a phone of a desktop and back (#343): draw again when it does. */
  function turned() {
    stackSoon();
    if (C && isMobile() !== L.mob) requestRender();
  }
  /**
   * Touch screens without hover have no intent before the tap: the panel's
   * files come when the page is idle (§2.3); its faces with the tap.
   */
  function idlePanel() {
    // Not for a widget hidden while offline.
    function go() { if (N && !N.wrap.hidden) prefetch(); }
    try {
      if (!global.matchMedia('(hover: none)').matches) return;
      if (global.requestIdleCallback) global.requestIdleCallback(go, { timeout: 2000 });
      else setTimeout(go, 1200);
    } catch (_) { /* no media queries: the first intent then */ }
  }

  // ─── media: remote audio plays from one persistent sink, open or closed ──
  function syncAudio(ctrl) {
    var tracks = ctrl._attachedTracks;
    if (!tracks) return;
    Object.keys(tracks).forEach(function (sid) {
      var m = tracks[sid];
      if (!m || String(m.tagName || '').toLowerCase() !== 'audio' || m.parentNode === N.media) return;
      m.setAttribute('data-track-sid', sid);
      N.media.appendChild(m);
    });
  }

  // ─── the persistent shell ────────────────────────────────────────────────
  function buildShell(root) {
    N = {};
    N.wrap = el('div', { class: 'ccw-launcher-wrap' });
    // Its tap moves no focus (it would drop to the page): the close gives it back to the launcher.
    N.scrim = el('div', { class: 'scrim', hidden: true, 'aria-hidden': 'true', on: { mousedown: function (e) { e.preventDefault(); }, click: function () { if (C && C.open) C.toggleOpen(); } } });
    N.ly = el('div', { class: 'ly' });
    N.dk = el('div', { class: 'dk stage-bg' });
    N.panel = el('section', {
      class: 'ccw-panel cp lv', id: 'ccw-panel', role: 'dialog', tabindex: '-1', inert: true,
    }, [N.ly, N.dk]);
    // Outside the panel: an inert subtree is hidden from assistive technology.
    N.live = el('div', { class: 'ccw-live sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    N.media = el('div', { class: 'ccw-media', hidden: true });
    root.append(N.wrap, N.scrim, N.panel, N.live, N.media);
    // Intent: the panel's files start before the click.
    ['pointerenter', 'focusin', 'pointerdown'].forEach(function (ev) { N.wrap.addEventListener(ev, requestPanel); });
    N.wrap.addEventListener('touchstart', requestPanel, { passive: true });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && C && C.open && L.vis) { e.stopPropagation(); C.toggleOpen(); }
    });
    global.addEventListener('resize', turned);
    global.addEventListener('orientationchange', turned);
    chatWatch();
  }

  function render(context) {
    var ctrl = context.controller;
    if (!rootEl || !ctrl) return;
    C = ctrl;
    audio = context.audio || {};
    loadPanelFn = typeof context.loadPanel === 'function' ? context.loadPanel : null;
    rendering = true;
    try { paint(ctrl, context); } finally { rendering = false; }
  }

  function paint(ctrl, context) {
    var root = rootEl;
    var b = brand();
    applyTheme(root, context.theme, b);
    if (b === 'intl') {
      var od = cfgOf().logoDirection === 'open';
      toggle(root, 'lg-open', od);
      toggle(root, 'lg-thread', !od);
    }
    attr(root, 'lang', ctrl.locale);
    attr(root, 'dir', LOCALE_DIR[ctrl.locale] || 'ltr');
    attr(root, 'data-state', ctrl.state);
    var mob = L.mob = isMobile();
    rootToggle('is-mobile', mob);

    // UI bookkeeping the screens share.
    if (ctrl.operatorName) UI.lastOperatorName = ctrl.operatorName;
    if (ctrl.transferring && !L.transferring) UI.previousOperatorName = UI.lastOperatorName;
    L.transferring = !!ctrl.transferring;
    var stateChanged = ctrl.state !== L.state;
    if (stateChanged) {
      if (ctrl.state === 'callback_form') { UI.callbackStep = 1; UI.daySel = null; }
      if (ctrl.state === 'callback_form' || ctrl.state === 'pre_call_form') UI.editingContact = false;
    }
    L.state = ctrl.state;

    // `hide` applies only while offline: a call in flight never strands a visitor.
    var hidden = ctrl.state === 'offline' && cfgOf().offline_behavior === 'hide';
    N.wrap.hidden = hidden;
    N.panel.hidden = hidden;
    var place = placement();
    // On a phone the light screens sit in a bottom sheet, the call takes the screen (the module sets `dark`).
    function panelClass() { attr(N.panel, 'class', 'ccw-panel cp lv ' + place + (mob && !root.classList.contains('dark') ? ' sheet' : '')); }
    panelClass();
    attr(N.panel, 'aria-label', cfgOf().display_name || tr('support'));
    // Modal on a phone only (D14).
    attr(N.panel, 'aria-modal', mob ? 'true' : null);
    syncAudio(ctrl);
    if (hidden) {
      toggle(root, 'ccw-is-open', false);
      attr(N.panel, 'inert', '');
      attr(N.scrim, 'hidden', '');
      if (L.vis) { L.vis = false; closedPanel(ctrl); }
      return;
    }

    // The panel's files: on open (an open the visitor did not ask for, a
    // restored call or an outcome, never moves focus), and at once for a
    // call being restored.
    if (ctrl.open && !L.open) {
      if (!P.byVisitor) P.auto = true;
      requestPanel();
    }
    if (!N.mounted && !STATE_ON[ctrl.state]) requestPanel();
    N.mounted = true;
    L.open = !!ctrl.open;
    if (!ctrl.open) P.byVisitor = false;

    // The panel's DOM is built as soon as the module is in; the visual open
    // waits for its stylesheet too, so no unstyled frame ever shows.
    var vis = !!ctrl.open && panelReady();
    // Not before an intent (P.warm): a touch screen's idle prefetch brings the files only, since the hidden panel's
    // text, once drawn, is laid out and would fetch its faces (a Persian panel's 500 weight) on every page view.
    if (P.inst && P.warm && (ctrl.open || stateChanged || !L.painted)) {
      try { P.inst.render(ctrl, { panel: N.panel, ly: N.ly, dk: N.dk, wrap: N.wrap, open: vis }); L.painted = true; } catch (_) { /* never the host page's error */ }
    }
    panelClass();
    // A phone's scrim stays in the page: the panel stylesheet fades it in with the open and out with the fold.
    attr(N.scrim, 'hidden', mob ? null : '');
    renderLauncher(ctrl, vis);
    if (vis !== L.vis) {
      var a = active();
      var inside = !!a && N.panel.contains(a);
      L.vis = vis;
      toggle(root, 'ccw-is-open', vis);
      if (vis) {
        attr(N.panel, 'inert', null);
        if (P.byVisitor && !P.auto) focusNode(N.panel);
      } else {
        // Focus goes back to the launcher before the panel turns inert.
        var back = inside && launcherFocus();
        if (back) focusNode(back);
        attr(N.panel, 'inert', '');
        closedPanel(ctrl);
        P.auto = false;
      }
    }
  }

  /** After the close (D26 and the phone's page lock are the module's). */
  function closedPanel(ctrl) {
    if (P.inst && typeof P.inst.closed === 'function') { try { P.inst.closed(ctrl); } catch (_) { /* ignore */ } }
  }

  // ─── what the panel module gets (v1) ─────────────────────────────────────
  var H = Object.freeze({
    v: PANEL_V,
    el: el,
    svg: svg,
    ICONS: ICONS,
    dig: dig,
    fmtClock: fmtClock,
    fmtDay: fmtDay,
    fmtTime: fmtTime,
    fmtWhen: fmtWhen,
    dayKey: dayKey,
    ui: UI,
    announce: announce,
    brand: brand,
    isMobile: isMobile,
    placement: placement,
    staffed: staffed,
    onA: onA,
    setText: setText,
    toggle: toggle,
    attr: attr,
    stageOrigin: stageOrigin,
    rootToggle: rootToggle,
    media: function () { return N && N.media; },
    audio: function () { return audio; },
    focusScreen: focusScreen,
    requestRender: requestRender,
  });

  var implementation = {
    contractVersion: 1,
    createHost: function (context) {
      hostCtx = context;
      var host = document.createElement('div');
      host.id = 'call-center-widget-host';
      host.style.all = 'initial';
      // Hidden until both stylesheets have loaded (or failed) and the
      // launcher's text has its faces: the launcher never shows unstyled.
      host.style.display = 'none';
      document.body.appendChild(host);
      shadow = host.attachShadow({ mode: 'open' });
      var assets = (context.bootstrap && context.bootstrap.assets) || {};
      var presentationPath = CALL_PATH.test(assets.presentation_style_url || '')
        ? assets.presentation_style_url : '/call-widget/presentation-default.css';
      // The loader names this build's hashed copies; an older loader (or the
      // operator preview) passes only the version suffix of the fixed names.
      var fixedUrl = function (path) { return context.origin + path + (context.runtimeAssetSuffix || ''); };
      var url = typeof context.assetUrl === 'function' ? context.assetUrl : fixedUrl;
      var waiting = 2;
      function show() { host.style.display = 'inline'; }
      function shown() {
        if (waiting <= 0) return;
        if (--waiting > 0) return;
        if (!launcherHasText(context.bootstrap) || !document.fonts || typeof document.fonts.load !== 'function') { show(); return; }
        // The launcher's faces, at most 1 s more.
        capped(new Promise(function (resolve) { fontsLinked(function () { warm(['400', '700']).then(resolve); }); }), 1000).then(show);
      }
      setTimeout(function () { if (waiting > 0) { waiting = 0; show(); } }, 10000);
      ['/call-widget/runtime.css', presentationPath].forEach(function (path) {
        var link = document.createElement('link');
        var first = url(path);
        var retried = false;
        link.rel = 'stylesheet';
        link.onload = shown;
        link.onerror = function () {
          // A hashed copy the server that answered does not have (the other
          // container during a rolling deploy): the fixed name is on every
          // build. Once, then show whatever there is.
          var fixed = fixedUrl(path);
          if (!retried && fixed !== first) { retried = true; link.href = fixed; return; }
          shown();
        };
        link.href = first;
        shadow.appendChild(link);
        skinLink = link;
      });
      // Font faces register only at document level (Chrome ignores
      // @font-face inside a shadow root), once per page for both widgets.
      var fontHref = context.fontsUrl || assets.font_style_url;
      if (fontHref && !document.getElementById('gs-presentation-fonts')) {
        var fontStyle = document.createElement('link');
        fontStyle.id = 'gs-presentation-fonts';
        fontStyle.rel = 'stylesheet';
        fontStyle.href = /^https?:/i.test(fontHref) ? fontHref : context.origin + fontHref;
        document.head.appendChild(fontStyle);
      }
      var root = document.createElement('div');
      root.className = 'ccw-root';
      shadow.appendChild(root);
      rootEl = root;
      return { host: host, root: root };
    },
    mount: function (context) {
      rootEl = context.root;
      context.root.classList.add('ccw-presentation-default');
      if (!N) { buildShell(context.root); render(context); idlePanel(); } else render(context);
      return { root: context.root };
    },
    update: function (instance, context) {
      render(context);
    },
    destroy: function (instance) {
      if (P.inst && typeof P.inst.destroy === 'function') { try { P.inst.destroy(); } catch (_) { /* ignore */ } }
      P.inst = null;
      chatUnwatch();
      clearTimeout(L.shTimer);
      L.shAt = 0;
      N = null;
      if (instance && instance.root) instance.root.replaceChildren();
    },
    ready: function () { return Promise.resolve(); },
    prepare: function () { return Promise.resolve(); },
  };

  registry.register('default', implementation);

  // The International edition's template: the same markup and lifecycle,
  // worn with its own skin (presentation-intl.css, which the bootstrap
  // names) and its own root class for it to style.
  registry.register('intl', {
    contractVersion: implementation.contractVersion,
    createHost: implementation.createHost,
    mount: function (context) {
      context.root.classList.add('ccw-presentation-intl');
      return implementation.mount(context);
    },
    update: implementation.update,
    destroy: implementation.destroy,
    ready: implementation.ready,
    prepare: implementation.prepare,
  });
})(window);
