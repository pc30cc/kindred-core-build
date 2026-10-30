/*!
 * Call widget panel module (contract v1): every screen of the open panel,
 * for the templates `default` and `intl` (presentation-default.js). Loaded
 * on the visitor's first intent (l.js `loadPanel`), never at page load; its
 * stylesheet is presentation-default-panel.css.
 *
 * One global, `__ccw_panel = { v, create(H) }`. `H` is what the core lends
 * (elements, icons, digits and dates, focus, the live region); nothing here
 * reaches the network or storage. Each screen is built once and updated in
 * place: a tick changes text, never nodes.
 */
(function (global) {
  'use strict';
  // The two brand kits: the RESPOK build drops the `@iran-kit` blocks and
  // folds LOCAL_KIT to false, the Iran build does the same with `@intl-kit`
  // and INTL_KIT (scripts/build/widgetBrand.mjs).
  var LOCAL_KIT = true;
  var INTL_KIT = true;

  /* @iran-kit:begin */
  // The Iran region's footer mark (its dots), inline in currentColor.
  var WM = 'M42.28 27.95A12.4 12.4 0 0 0 21.7 17.01A12.4 12.4 0 0 0 30.43 38.62A7.75 7.75 0 0 0 22.95 46.14A0.43 0.43 0 0 1 22.56 46.56A21.7 21.7 0 0 0 42.28 27.95ZM35.21 24.12L37.32 26.23L35.21 28.34L33.1 26.23ZM30 24.12L32.11 26.23L30 28.34L27.89 26.23ZM24.79 24.12L26.9 26.23L24.79 28.34L22.69 26.23Z';
  /* @iran-kit:end */

  /* @intl-kit:begin */
  // The International platform's lockups (Thread, Open): its symbol and
  // wordmark in currentColor (white on the stage), the second bubble Signal.
  var LK_WORD = 'M11.5 88.5V11.5M11.5 41.5A32 32 0 0 1 43.5 9.5M75.5 50H156.5M156.5 50A40.5 40.5 0 1 0 144.13 79.13M239.5 19.5C233.5 12.5 225.5 9.5 216.5 9.5C202.5 9.5 191.5 17.5 191.5 29.5C191.5 41 202.5 45.5 216.5 50C230.5 54.5 242.5 59 242.5 70.5C242.5 83.5 230.5 90.5 216.5 90.5C206.5 90.5 197.5 86.5 191.5 79.5M279.5 11.5V130.5M279.5 50a40.5 40.5 0 1 0 81 0a40.5 40.5 0 1 0 -81 0M394.5 50a40.5 40.5 0 1 0 81 0a40.5 40.5 0 1 0 -81 0M512.5 -30.5V88.5M554.5 11.5L514.5 61M530.5 41.2L556.5 88.5';
  var LK = [
    ['g-o', '0 -49.9 812.2 199.8', 'translate(0 -49.9) scale(1.85)', 'M41 0A41 41 0 0 1 82 41L82 78Q82 82 78 82L41 82A41 41 0 0 1 0 41A41 41 0 0 1 41 0Z', 'c96 96 12', 'translate(244.2 0)'],
    ['g-t', '0 -42 804.8 184', 'translate(0 -35.1) scale(1.85)', 'M21 0H41A21 21 0 0 1 62 21V21A21 21 0 0 1 41 42H4A4 4 0 0 1 0 38V21A21 21 0 0 1 21 0Z', 'M43 50H83A21 21 0 0 1 104 71V88A4 4 0 0 1 100 92H43A21 21 0 0 1 22 71V71A21 21 0 0 1 43 50Z', 'translate(236.8 0)'],
  ];
  /* @intl-kit:end */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SHORT = { en: 'EN', fa: 'فا', tr: 'TR' };
  var NAMES = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };
  var BUILT_IN = { name: 1, email: 1, phone: 1, subject: 1 };
  var FAIL = {
    operator_left: 1, media_disconnected: 1, token_expired: 1, room_connect_failed: 1, rtc_v1_unsupported: 1,
    media_client_missing: 1, media_client_invalid: 1, provider_client_not_configured: 1,
    provider_client_not_supported: 1, media_not_configured: 1,
  };
  var PANEL_ICONS = {
    'chev-d': 'M6.5 9.5l5.5 5.5 5.5-5.5',
    globe: 'c12 12 8.8|M3.2 12h17.6M12 3.2a13.6 13.6 0 0 1 3.6 8.8A13.6 13.6 0 0 1 12 20.8 13.6 13.6 0 0 1 8.4 12 13.6 13.6 0 0 1 12 3.2z',
    'arrow-f': 'M5 12h14M13.5 6.5L19 12l-5.5 5.5',
    'chevron-forward': 'M9.5 6l6 6-6 6',
    back: 'M14.5 6l-6 6 6 6',
    bolt: 'M13.2 2.8L5 13.4h6.4l-.9 7.8 8.2-10.6h-6.4z',
    check: 'M5 12.6l4.4 4.4L19 7.4',
    lock: 'r4.6 10.4 14.8 10.4 3|M8 10.4V7.6a4 4 0 0 1 8 0v2.8',
    warn: 'c12 12 8.6|M12 7.8v4.6M12 16.1h.01',
    info: 'c12 12 8.6|M12 11v5M12 7.9h.01',
    star: 'M12 3.4l2.62 5.32 5.88.86-4.25 4.14 1 5.85L12 16.8l-5.25 2.77 1-5.85L3.5 9.58l5.88-.86z',
    clock: 'c12 12 8.6|M12 7.4V12l3 1.9',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
    copy: 'r8.6 8.6 11.8 11.8 2.6|M15.4 8.6V6.2a2.6 2.6 0 0 0-2.6-2.6H6.2a2.6 2.6 0 0 0-2.6 2.6v6.6a2.6 2.6 0 0 0 2.6 2.6h2.4',
    headset: 'M4.2 14.6v-2.4a7.8 7.8 0 0 1 15.6 0v2.4|M19.8 15.2v.9a2.4 2.4 0 0 1-2.4 2.4H16v-6h1.4a2.4 2.4 0 0 1 2.4 2.4zM4.2 15.2v.9a2.4 2.4 0 0 0 2.4 2.4H8v-6H6.6a2.4 2.4 0 0 0-2.4 2.4z|M17.4 18.5c0 1.5-1.7 2.6-4.2 2.6H12',
    mic: 'M12 2.8a3 3 0 0 0-3 3v6.1a3 3 0 0 0 6 0V5.8a3 3 0 0 0-3-3z|M18.4 10.6v1.3a6.4 6.4 0 0 1-12.8 0v-1.3M12 18.3v2.9',
    'mic-off': 'M3 3l18 18|M15 9.4V5.8a3 3 0 0 0-5.6-1.5|M9 9.1v2.8a3 3 0 0 0 5.1 2.1|M18.4 10.6v1.3c0 .92-.2 1.8-.55 2.6M5.6 10.6v1.3a6.4 6.4 0 0 0 10.7 4.74M12 18.3v2.9',
    'video-off': 'M15.5 10.2l4.7-2.8a.8.8 0 0 1 1.2.7v7.8a.8.8 0 0 1-1.2.7l-4.7-2.8|M9.8 6.2h2.7a3 3 0 0 1 3 3v2.6M15.5 15.6v-.8M14.3 17.2a3 3 0 0 1-1.8.6H5.6a3 3 0 0 1-3-3V9.2a3 3 0 0 1 2.2-2.9|M3 3l18 18',
    vol: 'M10.6 5.2L6.3 8.7H3.2v6.6h3.1l4.3 3.5z|M15.2 9a4.3 4.3 0 0 1 0 6M18.2 6.2a8.2 8.2 0 0 1 0 11.6',
    'vol-x': 'M10.6 5.2L6.3 8.7H3.2v6.6h3.1l4.3 3.5z|M21 9.4l-5.2 5.2M15.8 9.4l5.2 5.2',
    mini: 'M9.6 4.2v5.4H4.2M14.4 19.8v-5.4h5.4M9.6 9.6L3.6 3.6M14.4 14.4l6 6',
    expand: 'M14.6 3.8h5.6v5.6M9.4 20.2H3.8v-5.6M20.2 3.8l-6.4 6.4M3.8 20.2l6.4-6.4',
    // Four bars: the connection's quality dims the ones it lacks.
    signal: 'M5 18.5v-3|M9.7 18.5v-6|M14.3 18.5v-9|M19 18.5v-12',
    'wifi-off': 'M3 3l18 18|M8.6 15.8a5.4 5.4 0 0 1 6.8 0M12 19.3h.01M5.4 12.4a10.2 10.2 0 0 1 4.2-2.1M2.4 8.9a14.6 14.6 0 0 1 4.3-2.6M14.6 10.4a10.2 10.2 0 0 1 4 2M10.9 4.9a14.6 14.6 0 0 1 10.7 4',
    retry: 'M20 12a8 8 0 1 1-2.34-5.66|M20.2 3.8v4.6h-4.6',
  };

  function create(H) {
    var el = H.el, svg = H.svg, ui = H.ui, setText = H.setText, toggle = H.toggle, attr = H.attr, dig = H.dig;
    Object.keys(PANEL_ICONS).forEach(function (k) { H.ICONS[k] = PANEL_ICONS[k]; });

    var C = null;            // the controller of the current render
    var screens = {};        // id → { el, sig, upd }
    var cur = null;          // the shown screen's id
    var base = '';           // what every screen's markup depends on
    var uid = 0;
    var closeTimer = null;
    var copyTimer = null;
    var lastErr = null;
    var S = null;            // the in-place updates of the screen being built

    // ─── data ──────────────────────────────────────────────────────────────
    function t(key, vars) { return C.t(key, vars); }
    function boot() { return C.bootstrap || {}; }
    function cfg() { return boot().config || {}; }
    function caps() { return boot().capabilities || {}; }
    function pol() { return boot().callback_policy || {}; }
    function rec() { return boot().recording || {}; }
    function fd() { return C.formData || (C.formData = {}); }
    function id(prefix) { uid += 1; return 'ccw-' + prefix + uid; }
    function fa() { return C.locale === 'fa'; }
    /** The visitor's own initial (their contact card); people on the team and the business never get a letter. */
    function initial(name) {
      var ch = Array.from(String(name || '').trim())[0] || '';
      return ch.toUpperCase();
    }
    function isVideo(ctrl) { return (ctrl.call && ctrl.call.call_type === 'video') || (ctrl.formData && ctrl.formData.call_type === 'video'); }
    function identified() { return !!(C.identifiedContact && C.identifiedContact.id); }
    function opName() { return C.operatorName || ui.lastOperatorName || null; }
    function focusInside(node) {
      var root = node.getRootNode && node.getRootNode();
      var a = root && root.activeElement;
      return !!a && node.contains(a);
    }

    // ─── state → screen (§2.12; D36 order inside a call) ───────────────────
    function screenId(ctrl) {
      if (ui.bookingView && ctrl.callbackBooking) return 'scheduled';
      switch (ctrl.state) {
        case 'loading': return 'connecting';
        case 'offline': return 'offline';
        case 'pre_call_form': return 'precall';
        case 'queue_waiting': return 'queue';
        case 'callback_form': return 'callback';
        case 'error': return 'error';
        case 'ended':
          if (ctrl.callbackId) return 'scheduled';
          return ctrl.endedCallId && !ctrl.ratingSubmitted ? 'rating' : 'thanks';
        case 'in_call': {
          var s = ctrl.connectStatus;
          if (FAIL[s]) return 'fail';
          if (s === 'microphone_permission_denied') return 'mic';
          if (s === 'media_reconnecting') return 'reconnect';
          if (ctrl.transferring) return 'transfer';
          if (s === 'in_call' || s === 'operator_connected' || s === 'camera_permission_denied' || ctrl.cameraDenied) {
            return isVideo(ctrl) ? 'video' : 'voice';
          }
          return 'joining';
        }
      }
      return 'home';
    }

    // ─── shared parts ──────────────────────────────────────────────────────
    /** A screen: header + its parts + footer; `ups` are its in-place updates; `cls` marks the stage's. */
    function frame(ctrl, parts, ups, cls) {
      var hd = header(ctrl);
      ups.unshift(hd.upd);
      // A phone's light screens are a bottom sheet: its grabber above the header.
      var grab = !cls && H.isMobile() ? el('i', { class: 'grab', 'aria-hidden': 'true' }) : null;
      var node = el('div', { class: 'scr' + (cls ? ' ' + cls : '') }, [grab, hd.el].concat(parts, [footer(ctrl)]));
      return { el: node, upd: function (c) { ups.forEach(function (f) { f(c); }); } };
    }

    function header(ctrl) {
      var c = cfg();
      var name = c.display_name || t('support');
      var dot = el('i', { class: 'dot' });
      var st = document.createTextNode('');
      // The business's logo, else its storefront glyph (panel css), never its first letter.
      var lg = el('span', { class: c.avatar_url ? 'lg' : 'lg ws', 'aria-hidden': 'true' }, [
        c.avatar_url ? el('img', { src: c.avatar_url, alt: '' }) : null,
      ]);
      var node = el('header', { class: 'hd' }, [
        lg,
        el('span', { class: 'hx' }, [el('span', { class: 'nm' }, [name]), el('span', { class: 'st' }, [dot, st])]),
        langPicker(ctrl),
        el('button', {
          class: 'ib', type: 'button', 'data-action': 'minimize', 'aria-label': t('minimize'),
          on: { click: function () { C.toggleOpen(); } },
        }, [svg('chev-d', 20, 2)]),
      ]);
      return {
        el: node,
        upd: function (c2) {
          var staffed = H.staffed(c2);
          toggle(dot, 'off', !staffed);
          setText(st, !c2.isOnline() ? t(cfg().offline_behavior !== 'show_message' && caps().callback ? 'callback_desk' : 'offline') : staffed ? t('operators_available') : t('no_operator_now'));
        },
      };
    }

    function langPicker(ctrl) {
      var locs = ctrl.availableLocales || [];
      if (locs.length <= 1) return null;
      var sel = el('select', { 'aria-label': t('widget_language'), 'data-action': 'lang' }, locs.map(function (code) {
        return el('option', { value: code, selected: code === ctrl.locale }, [NAMES[code] || code]);
      }));
      sel.addEventListener('change', function () { C.setLocale(sel.value); });
      return el('label', { class: 'lang' }, [svg('globe', 15, 1.8), el('span', {}, [SHORT[ctrl.locale] || String(ctrl.locale).toUpperCase()]), sel]);
    }

    function svgRaw(attrs, kids) {
      var s = document.createElementNS(SVG_NS, 'svg');
      Object.keys(attrs).forEach(function (k) { s.setAttribute(k, attrs[k]); });
      (kids || []).forEach(function (k) { s.appendChild(k); });
      return s;
    }
    function svgNode(tag, attrs) {
      var n = document.createElementNS(SVG_NS, tag);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      return n;
    }

    /**
     * The "powered by" credit (D20): the Iran region's mark and words, the
     * International platform's lockup, a logo image, plain text, or an
     * empty row when nothing is credited. A link only when one is set. The
     * logo the platform uploaded is always the image, and never the kit's
     * art: with a workspace's own words (no `parts`), they stay words.
     */
    function footer(ctrl) {
      var text = ctrl.t('powered_by');
      var wrap = el('div', { class: 'ccw-footer' });
      if (!text) { wrap.appendChild(el('span', { class: 'pw' })); return wrap; }
      var b = ctrl.bootstrap || {};
      var url = typeof ctrl.poweredByUrl === 'function' ? ctrl.poweredByUrl() : null;
      var brand = typeof ctrl.poweredByBrand === 'function' ? ctrl.poweredByBrand() : '';
      var at = brand ? text.indexOf(brand) : -1;
      var parts = typeof ctrl.poweredByParts === 'function' ? ctrl.poweredByParts() : null;
      var own = (b.edition === 'iran' ? b.powered_by_logo_custom : b.powered_by && b.powered_by.custom) === true;
      var kids = [text];
      // The words around the brand; `keep` keeps their spaces (they read
      // as one sentence, and a line's edge spaces take no room).
      function label(s, keep) { return s.trim() ? el('span', { class: 'ccw-powered-label' }, [keep ? s : s.trim()]) : null; }
      if (!own && LOCAL_KIT && b.edition === 'iran' && at >= 0) {
        kids = [
          svgRaw({ class: 'wm', viewBox: '17 13.5 26 33.5', 'aria-hidden': 'true' }, [svgNode('path', { fill: 'currentColor', 'fill-rule': 'evenodd', d: WM })]),
          label(text.slice(0, at), true), el('b', {}, [brand]), label(text.slice(at + brand.length), true),
        ];
      } else if (!own && INTL_KIT && parts && b.edition === 'international') {
        kids = [label(parts.before)].concat(LK.map(function (k) {
          var sym = svgNode('g', { transform: k[2] });
          sym.appendChild(svgNode('path', { fill: 'currentColor', d: k[3] }));
          var second = k[4].charAt(0) === 'c' ? k[4].slice(1).split(' ') : null;
          sym.appendChild(second
            ? svgNode('circle', { fill: '#FF5A3C', cx: second[0], cy: second[1], r: second[2] })
            : svgNode('path', { fill: '#FF5A3C', d: k[4] }));
          return svgRaw({ class: 'lk ' + k[0], viewBox: k[1], role: 'img', 'aria-label': parts.brand }, [
            sym,
            svgNode('path', {
              transform: k[5], d: LK_WORD, fill: 'none', stroke: 'currentColor', 'stroke-width': '23',
              'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            }),
          ]);
        }), [label(parts.after)]);
      } else if (parts) {
        var img = el('img', { class: 'ccw-powered-logo', src: parts.logo, alt: parts.brand, draggable: 'false' });
        // A logo that cannot load becomes the platform's name.
        img.addEventListener('error', function () { if (img.parentNode) img.parentNode.replaceChild(document.createTextNode(parts.brand), img); });
        kids = [label(parts.before), img, label(parts.after)];
      }
      wrap.appendChild(url
        ? el('a', { class: 'pw ccw-powered', href: url, target: '_blank', rel: 'noopener noreferrer' }, kids)
        : el('span', { class: 'pw ccw-powered' }, kids));
      return wrap;
    }

    /** The one error slot of a screen (`controller.error`); D38. */
    function errSlot(ups, onError) {
      var txt = el('span');
      var p = el('p', { class: 'msg err', role: 'alert', 'data-error': '', id: id('e'), hidden: true }, [svg('warn', 16, 2), txt]);
      ups.push(function (c) {
        var e = c.error || '';
        setText(txt, e);
        p.hidden = !e;
        if (onError) onError(e, p.id);
      });
      return p;
    }

    /**
     * A single-choice group (radio semantics, brief §7): roving tabindex,
     * arrows move and pick (mirrored in RTL), disabled items skipped.
     * `fill` marks every item up to the chosen one (stars).
     */
    function radios(node, items, label, onPick, fill, get) {
      attr(node, 'role', 'radiogroup');
      if (label) attr(node, 'aria-label', label);
      var value = null;
      var btns = items.map(function (it) {
        var b = el('button', {
          type: 'button', role: 'radio', class: it.cls || null, 'aria-checked': 'false', tabindex: '-1',
          'data-action': it.action, 'data-value': String(it.value), 'data-field': it.field || null,
          'aria-label': it.label || null, disabled: !!it.disabled, 'aria-disabled': it.disabled ? 'true' : null,
          style: it.style || null,
        }, it.kids);
        b.addEventListener('click', function () { if (!it.disabled) pick(it.value, false); });
        node.appendChild(b);
        return b;
      });
      function set(v, picked) {
        value = v;
        var at = -1, d = 0;
        items.forEach(function (it, i) { if (it.value === v) at = i; });
        var first = -1;
        btns.forEach(function (b, i) {
          if (first < 0 && !items[i].disabled) first = i;
          var on = fill ? i <= at : i === at;
          // The stars a pick adds fill one after another, 80 ms apart (`nw`, `--d`); the ones already on stay.
          if (fill && on !== b.classList.contains('on')) {
            toggle(b, 'nw', on && !!picked);
            if (on && picked) b.style.setProperty('--d', String(d++));
          }
          toggle(b, 'on', on);
          if (items[i].onCls) toggle(b, items[i].onCls, i === at);
          attr(b, 'aria-checked', i === at ? 'true' : 'false');
        });
        btns.forEach(function (b, i) { b.tabIndex = i === (at >= 0 ? at : first) ? 0 : -1; });
      }
      function pick(v, viaKey) {
        set(v, true);
        onPick(v);
        if (viaKey) {
          var i = items.map(function (x) { return x.value; }).indexOf(v);
          if (btns[i]) btns[i].focus();
        }
      }
      node.addEventListener('keydown', function (e) {
        var k = e.key;
        var rtl = (node.closest('[dir]') || document.documentElement).getAttribute('dir') === 'rtl';
        var step = k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : k === 'ArrowRight' ? (rtl ? -1 : 1) : k === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
        if (!step) return;
        e.preventDefault();
        var at = -1;
        items.forEach(function (it, i) { if (it.value === value) at = i; });
        if (at < 0) at = btns.indexOf(e.target);
        for (var n = 1; n <= items.length; n++) {
          var i = (at + step * n + items.length * n) % items.length;
          if (!items[i].disabled) { pick(items[i].value, true); return; }
        }
      });
      if (get) {
        set(get());
        sync(function () { var v = get(); if (v !== value) set(v); });
      }
      return { el: node, set: set, btns: btns };
    }

    // ─── 01 home ───────────────────────────────────────────────────────────
    function home(ctrl) {
      var cp = caps();
      var ups = [];
      // The dots in <b>: in Persian the panel CSS takes them from the 400 face
      // (the shipped Persian 500 face has no U+00B7, and the fallback would
      // fetch a Latin face for two dots).
      var chn = [];
      [cp.voice && t('channel_voice'), cp.video && t('video'), cp.callback && t('callback')].filter(Boolean).forEach(function (s, i) {
        if (i) chn.push(' ', el('b', {}, ['·']), ' ');
        chn.push(s);
      });
      var badgeDot = el('i', { class: 'dot' });
      var badgeTx = el('span', {}, [t('live_now')]);
      var badgeChn = [el('i', { class: 'sep' }), el('span', { class: 'chn' }, chn)];
      // Online but nobody available (D17): the header's words over the off dot;
      // the channel list makes room (the tiles below still name the channels).
      ups.push(function (c) {
        var on = H.staffed(c);
        toggle(badgeDot, 'off', !on);
        setText(badgeTx, t(on ? 'live_now' : 'no_operator_now'));
        badgeChn.forEach(function (n) { n.hidden = !on; });
      });
      function tile(kind) {
        var voice = kind === 'voice';
        var btn = el('button', {
          class: 'opt ' + kind, type: 'button', 'data-action': kind,
          on: { click: function () { H.stageOrigin(btn); C.startCall(kind); } },
        }, [
          voice ? el('i', { class: 'rw' }) : null, voice ? el('i', { class: 'rw' }) : null, voice ? el('i', { class: 'rw' }) : null,
          el('span', { class: 'oi' }, [svg(voice ? 'phone' : 'video', 22, 1.9)]),
          el('span', { class: 'go' }, [svg('arrow-f', 16, 2.2, 'dirf')]),
          el('span', { class: 'ol' }, [el('b', {}, [t(voice ? 'voice_call' : 'video_call')]), el('small', {}, [t(voice ? 'voice_tile_sub' : 'video_tile_sub')])]),
        ]);
        return btn;
      }
      var tiles = [cp.voice ? tile('voice') : null, cp.video ? tile('video') : null].filter(Boolean);
      var cbr = cp.callback && pol().show_when_online !== false ? el('button', {
        class: 'cbr cz', type: 'button', 'data-action': 'callback', style: { '--i': '4' },
        on: { click: function () { C.openCallback(); } },
      }, [
        el('span', { class: 'it' }, [svg('phone-in', 20, 1.8)]),
        el('span', { class: 'tx' }, [el('b', {}, [t('request_callback_instead')]), el('small', {}, [t('callback_intro')])]),
        svg('chevron-forward', 18, 2, 'ch dirf'),
      ]) : null;
      var bd = el('div', { class: 'bd' }, [
        el('span', { class: 'badge cz', style: { '--i': '0' } }, [badgeDot, badgeTx].concat(badgeChn)),
        el('h2', { class: 'hh cz', style: { '--i': '1' } }, [t('talk_to_team')]),
        el('p', { class: 'hs cz', style: { '--i': '2' } }, [t('online_copy')]),
        tiles.length ? el('div', { class: 'opts cz' + (tiles.length === 1 ? ' one' : ''), style: { '--i': '3' } }, tiles) : null,
        cbr,
        errSlot(ups),
      ]);
      return frame(ctrl, [bd], ups);
    }

    // ─── forms: shared parts ───────────────────────────────────────────────
    // Every control of a screen re-reads `formData` (and the rating) on each
    // render, so a value set elsewhere shows at once, with no rebuild.
    function sync(fn) { if (S) S.push(fn); }
    function focused(node) { var r = node.getRootNode && node.getRootNode(); return !!r && r.activeElement === node; }

    function ctxBar(icon, text, onBack, extra) {
      return el('div', { class: 'ctx' }, [
        el('button', { class: 'ib', type: 'button', 'data-action': 'back', 'aria-label': t('back'), on: { click: onBack } }, [svg('back', 18, 2, 'dirf')]),
        el('span', { class: 'ct', 'data-focus': '' }, [svg(icon, 15, 2), text]),
        extra || null,
      ]);
    }

    /** One field: a row of the group (`.fr`), or its own box (`.inp`) with a label above. */
    function field(f, get, set, row) {
      var fid = id('f');
      var input;
      if (f.type === 'textarea') {
        input = el('textarea', { class: 'ta', id: fid, placeholder: f.placeholder || null });
      } else if (f.type === 'select') {
        input = el('select', { class: 'v', id: fid }, [el('option', { value: '' }, [f.placeholder || '—'])].concat((f.options || []).map(function (o) {
          return el('option', { value: o.value }, [o.label]);
        })));
      } else {
        var ltr = f.type === 'email' || f.type === 'tel';
        input = el('input', {
          class: 'v' + (ltr ? ' ltrv' : ''), id: fid, type: f.type || 'text', dir: ltr ? 'ltr' : null,
          autocomplete: f.auto || null, placeholder: f.placeholder || null,
          // Names, addresses and numbers are no words: no spelling marks under them.
          spellcheck: ltr || f.auto === 'name' ? 'false' : null,
        });
      }
      input.addEventListener(f.type === 'select' ? 'change' : 'input', function () { set(input.value); });
      function pull() { var v = get(); v = v == null ? '' : String(v); if (input.value !== v && !focused(input)) input.value = v; }
      pull();
      sync(pull);
      var lab = el('label', { for: fid, class: row ? null : 'lb' }, [f.label, f.required ? ' ' : null, f.required ? el('i', {}, ['*']) : null]);
      var box = row ? el('div', { class: 'fr' }, [lab, input])
        : f.type === 'textarea' ? el('div', {}, [lab, input])
          : el('div', {}, [lab, el('div', { class: 'inp' }, [input])]);
      return { el: box, input: input, label: f.label, box: row ? box : f.type === 'textarea' ? input : input.parentNode };
    }

    /** A yes/no field, drawn as the consent row's switch. */
    function switchRow(icon, text, get, set, extra) {
      var tid = id('c');
      var sw = el('button', { class: 'sw', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': tid, 'data-action': 'consent' });
      function show(v) { toggle(sw, 'on', v); attr(sw, 'aria-checked', v ? 'true' : 'false'); }
      sw.addEventListener('click', function () { var v = sw.getAttribute('aria-checked') !== 'true'; show(v); set(v); });
      show(!!get());
      sync(function () { show(!!get()); });
      var node = el('div', { class: 'cons' }, [icon ? svg(icon, 18, 1.8) : null, el('span', { class: 'tx', id: tid }, [text].concat(extra || [])), sw]);
      return { el: node, sw: sw };
    }

    /** Marks the field an error names (`<label>: …`), or clears every mark. */
    function markInvalid(fields, err, errId) {
      fields.forEach(function (f) {
        var bad = !!err && (err.indexOf(f.label + ':') === 0 || (!!f.match && f.match(err)));
        toggle(f.box, 'err', bad);
        attr(f.input, 'aria-invalid', bad ? 'true' : null);
        attr(f.input, 'aria-describedby', bad ? errId : null);
      });
    }

    function deptChips(list) {
      function cur() { var v = fd().department_id; return v ? String(v) : null; }
      var g = radios(el('div', { class: 'chips' }), list.map(function (d) {
        return { value: String(d.id), action: 'dept', cls: 'chip', kids: [svg('check', 15, 2.4), d.name] };
      }), t('department'), function (v) { fd().department_id = v; }, false, cur);
      return el('div', {}, [el('span', { class: 'lb' }, [t('department')]), g.el]);
    }

    function contactGroup(required, fields) {
      var defs = [
        { id: 'name', label: t('full_name'), type: 'text', auto: 'name' },
        { id: 'email', label: t('email'), type: 'email', auto: 'email', required: required },
        { id: 'phone', label: t('phone_field'), type: 'tel', auto: 'tel', required: required },
      ];
      return el('div', { class: 'grp' }, defs.map(function (d) {
        var x = field(d, function () { return fd()[d.id]; }, function (v) { fd()[d.id] = v; }, true);
        fields.push(x);
        return x.el;
      }));
    }

    function knownCard() {
      var who = C.identifiedContact || {};
      var name = who.name || fd().name || t('known_contact');
      return el('div', { class: 'known' }, [
        el('span', { class: 'av s44 c3', 'aria-hidden': 'true' }, [initial(name)]),
        el('span', { class: 'tx' }, [el('b', {}, [name]), el('small', {}, [svg('check', 14, 2.6), t('contact_saved')])]),
        el('button', {
          class: 'ed', type: 'button', 'data-action': 'edit-contact',
          on: { click: function () { ui.editingContact = true; H.requestRender(); } },
        }, [t('edit')]),
      ]);
    }

    function acts(kids) { return el('div', { class: 'acts' }, kids); }
    function btn(cls, action, kids, onClick, type) {
      return el('button', { class: 'btn ' + cls, type: type || 'button', 'data-action': action, on: onClick ? { click: onClick } : null }, kids);
    }

    // ─── 02 / 03 pre-call form ─────────────────────────────────────────────
    function precall(ctrl) {
      var ups = S = [];
      var c = cfg();
      var f = fd();
      var video = f.call_type === 'video';
      var fields = [];
      var known = identified() && !ui.editingContact;
      var list = ((boot().departments || {})[video ? 'video' : 'voice']) || [];
      // The form switched off: this screen is only the consent, the notice or
      // the department choice, so no contact or schema field is drawn.
      var formOn = !!c.pre_call_form_enabled;
      var schema = formOn && Array.isArray(c.pre_call_form_schema) ? c.pre_call_form_schema : [];
      if (schema.length && known) schema = schema.filter(function (x) { return !BUILT_IN[x.id] || x.id === 'subject'; });
      var fm = el('div', { class: 'fm' });
      if (list.length) fm.appendChild(deptChips(list));
      if (known) fm.appendChild(knownCard());
      if (schema.length) {
        var grp = null;
        schema.forEach(function (s) {
          var builtIn = !!BUILT_IN[s.id];
          var get = function () { var d = fd(); return builtIn ? d[s.id] : (d.custom || {})[s.id]; };
          var set = function (v) { var d = fd(); if (builtIn) d[s.id] = v; else (d.custom = d.custom || {})[s.id] = v; };
          if (s.type === 'checkbox') {
            var sw = switchRow(null, s.label, function () { return get() === true; }, set, s.required ? [' ', el('i', {}, ['*'])] : null);
            fields.push({ label: s.label, input: sw.sw, box: sw.el });
            fm.appendChild(sw.el);
            grp = null;
            return;
          }
          var row = s.type !== 'textarea' && s.type !== 'select';
          var x = field({ label: s.label, type: s.type, required: s.required, placeholder: s.placeholder, options: s.options, auto: s.id === 'name' ? 'name' : s.type === 'email' ? 'email' : s.type === 'tel' ? 'tel' : null }, get, set, row);
          fields.push(x);
          // Consecutive one-line fields share a group, in the schema's order.
          if (row) {
            if (!grp) fm.appendChild(grp = el('div', { class: 'grp' }));
            grp.appendChild(x.el);
          } else {
            fm.appendChild(x.el);
            grp = null;
          }
        });
      } else if (formOn) {
        if (!known) fm.appendChild(contactGroup(false, fields));
        var subj = field({ label: t('subject'), type: 'text' }, function () { return fd().subject; }, function (v) { fd().subject = v; }, false);
        fields.push(subj);
        fm.appendChild(subj.el);
      }
      var r = rec();
      var consent = null;
      if (r.effective_enabled && r.consent_required) {
        consent = switchRow('lock', t('consent_required'), function () { return fd().consent; }, function (v) { fd().consent = v; }, [el('em', {}, [t('required')])]);
        fm.appendChild(consent.el);
      } else if (r.effective_enabled) {
        fm.appendChild(el('p', { class: 'note' }, [svg('info', 14, 2), t('call_may_record')]));
      }
      if (video) fm.appendChild(el('p', { class: 'permit' }, [el('span', { class: 'ics' }, [svg('video', 16, 1.8), svg('mic', 16, 1.8)]), t('permission_note')]));
      var consentErr = [t('err_recording_required'), t('err_recording_accept')];
      fm.appendChild(errSlot(ups, function (e, eid) {
        markInvalid(fields, e, eid);
        if (consent) {
          var bad = !!e && consentErr.indexOf(e) >= 0;
          toggle(consent.el, 'err', bad);
          attr(consent.sw, 'aria-invalid', bad ? 'true' : null);
          attr(consent.sw, 'aria-describedby', bad ? eid : null);
        }
      }));
      var form = el('form', {
        class: 'frm', novalidate: true,
        // The stage spreads out of the button that started the call.
        on: { submit: function (e) { e.preventDefault(); H.stageOrigin(form.querySelector('[data-action="submit"]')); C.submitCall(); } },
      }, [
        el('div', { class: 'bd' }, [fm]),
        acts([
          btn('gh', 'back', [t('back')], function () { C.reset(); }),
          btn('pri', 'submit', [svg(video ? 'video' : 'phone', 18, 2), t('start_call')], null, 'submit'),
        ]),
      ]);
      S = null;
      return frame(ctrl, [ctxBar(video ? 'video' : 'phone', t(video ? 'video_call' : 'voice_call'), function () { C.reset(); }), form], ups);
    }

    // ─── 13 rating · 14 thanks ─────────────────────────────────────────────
    function duration(ctrl) {
      return ctrl.endedDuration > 0 ? t('call_duration') + ' ' + H.fmtClock(ctrl.endedDuration * 1000) : '';
    }
    /** The operator: the person silhouette (.sil) once named, a headset before (D34); never a letter. */
    function opAvatar(cls) {
      return el('span', { class: 'av ' + cls + ' c1' + (opName() ? ' sil' : ''), 'aria-hidden': 'true' }, [opName() ? null : svg('headset', cls === 's52' ? 22 : 20, 1.8)]);
    }

    function rating(ctrl) {
      var ups = S = [];
      var name = opName();
      var dur = duration(ctrl);
      var submit = btn('pri', 'rate-submit', [t('rate_submit')], function () { if (C.ratingValue > 0) C.submitRating(); });
      var stars = radios(el('div', { class: 'stars' }), [1, 2, 3, 4, 5].map(function (n) {
        return { value: n, action: 'star', cls: 'star', label: dig(n), style: { '--i': String(n - 1) }, kids: [svg('star', 36, 1.6)] };
      }), t('rating'), function (v) { C.ratingValue = v; ready(); }, true, function () { return C.ratingValue || null; });
      function ready() {
        var v = C.ratingValue || 0;
        submit.disabled = !v;
      }
      sync(ready);
      ready();
      var ta = el('textarea', { class: 'ta', 'aria-label': t('rate_comment_ph'), placeholder: t('rate_comment_ph') });
      ta.value = ctrl.ratingComment || '';
      ta.addEventListener('input', function () { C.ratingComment = ta.value; });
      var bd = el('div', { class: 'bd' }, [
        el('div', { class: 'sumc' }, [
          el('span', { class: 'avw' }, [opAvatar('s52'), el('i', { class: 'ck' }, [svg('check', 12, 3)])]),
          el('span', { class: 'tx' }, [el('b', {}, [t('call_ended')]), el('small', {}, [[name || t('operator_label'), dur].filter(Boolean).join(' · ')])]),
        ]),
        el('div', { class: 'rate' }, [el('h3', {}, [t('rate_call_title')]), el('p', {}, [t('rate_call_sub')]), stars.el]),
        ta,
      ]);
      S = null;
      return frame(ctrl, [bd, acts([
        btn('gh', 'rate-skip', [t('rate_skip')], function () { if (typeof C.skipRating === 'function') C.skipRating(); else C.reset(); }),
        submit,
      ])], ups);
    }

    function thanks(ctrl) {
      var rated = !!ctrl.ratingSubmitted;
      var v = Math.max(0, Math.min(5, ctrl.ratingValue || 0));
      var dur = duration(ctrl);
      var mini = null;
      if (rated && v) {
        mini = el('span', { class: 'mini-stars', role: 'img', 'aria-label': dig(v + '/5') });
        for (var i = 1; i <= 5; i++) mini.appendChild(svg('star', 18, 1.6, i > v ? 'o' : null));
      }
      var name = opName();
      var ctr = el('div', { class: 'ctr' }, [
        el('span', { class: 'okc' }, [el('span', { class: 'in' }, [svg('check', 32, 2.6)])]),
        el('h3', {}, [t(rated ? 'rate_thanks' : 'call_ended')]),
        dur ? el('p', {}, [dur]) : null,
        el('div', { class: 'sumc wide' }, [
          opAvatar('s44'),
          el('span', { class: 'tx' }, [el('b', {}, [name || t('operator_label')]), name ? el('small', {}, [t('operator_label')]) : null]),
          mini,
        ]),
      ]);
      return frame(ctrl, [el('div', { class: 'bd' }, [ctr]), acts([btn('pri full', 'done', [t('done')], function () { C.reset(); })])], []);
    }

    // ─── 15 error · 16 offline ─────────────────────────────────────────────
    function error(ctrl) {
      var ups = [];
      var cb = !!caps().callback;
      var hint = cb ? el('p', { id: id('d') }, [t('error_callback_hint')]) : null;
      // Focus lands on the title (the error itself): it says what the visitor can do too.
      var h = el('h3', { 'data-error': '', 'aria-describedby': hint && hint.id });
      ups.push(function (c) { setText(h, c.error || t('unknown')); });
      var ctr = el('div', { class: 'ctr' }, [
        el('span', { class: 'ei' }, [svg('warn', 34, 1.8)]),
        h,
        hint,
        el('div', { class: 'vstack' }, [
          cb ? btn('pri full', 'callback', [svg('phone-in', 18, 2), t('request_callback')], function () { C.openCallback(); }) : null,
          btn('gh full', 'back', [t('back')], function () { C.reset(); }),
        ]),
      ]);
      return frame(ctrl, [el('div', { class: 'bd' }, [ctr]), el('div', { class: 'spc' })], ups);
    }

    function offline(ctrl) {
      var ups = [];
      var can = cfg().offline_behavior !== 'show_message' && !!caps().callback;
      // Without a callback to offer (show_message, or callbacks off) the
      // offline message, never the callback request's words.
      var ctr = el('div', { class: 'ctr' }, [
        el('span', { class: 'oi2' }, [svg('phone-in', 34, 1.7), el('span', { class: 'moon' }, [svg('moon', 16, 1.9)])]),
        el('h3', {}, [t(can ? 'leave_callback_request' : 'offline_title')]),
        el('p', {}, [t(can ? 'offline_copy' : 'offline_message')]),
        can ? el('div', { class: 'vstack' }, [btn('pri full', 'callback', [svg('phone-in', 18, 2), t('request_callback')], function () { C.openCallback(); })]) : null,
        errSlot(ups),
        can ? el('p', { class: 'inl' }, [svg('clock', 15, 1.9), t('reach_out', { when: t('asap') })]) : null,
      ]);
      return frame(ctrl, [el('div', { class: 'bd' }, [ctr]), el('div', { class: 'spc' })], ups);
    }

    // ─── 17 / 18 callback ──────────────────────────────────────────────────
    /** The server's slots grouped by the visitor-local day; the first four days that have one (D16). */
    function slotDays() {
      var raw = Array.isArray(pol().slots) ? pol().slots : [];
      var soon = Date.now() + 5 * 60000;
      var days = [];
      var byKey = {};
      raw.filter(function (s) { return s && typeof s.at === 'string' && !isNaN(Date.parse(s.at)); })
        .sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); })
        .forEach(function (s) {
          var key = H.dayKey(s.at);
          if (!byKey[key]) {
            if (days.length >= 4) return;
            byKey[key] = { key: key, at: s.at, slots: [] };
            days.push(byKey[key]);
          }
          byKey[key].slots.push({ at: s.at, ok: s.available !== false && Date.parse(s.at) >= soon });
        });
      return days;
    }

    function seg(label, items, get, onPick) {
      var g = radios(el('div', { class: 'seg' }), items, label, onPick, false, get);
      return el('div', {}, [el('span', { class: 'lb' }, [label]), g.el]);
    }

    function whenText(at) {
      return at ? H.fmtDay(at) + (fa() ? '، ' : ', ') + H.fmtTime(at) : t('asap_option');
    }
    function scheduledAt(f) {
      return f.callback_when === 'later' && f.callback_scheduled_for && !isNaN(Date.parse(f.callback_scheduled_for)) ? f.callback_scheduled_for : null;
    }

    /** Step 1: channel, when (days and slots, or the browser's picker), priority. */
    function stepOne(fm) {
      if (caps().video) {
        fm.appendChild(seg(t('callback_type'), [
          { value: 'audio', action: 'seg', field: 'callback_channel', kids: [svg('phone', 16, 2), t('phone')] },
          { value: 'video', action: 'seg', field: 'callback_channel', kids: [svg('video', 17, 2), t('video')] },
        ], function () { return fd().callback_channel === 'video' ? 'video' : 'audio'; }, function (v) { fd().callback_channel = v; }));
      }
      var later = el('div');
      function showLater() { later.hidden = fd().callback_when !== 'later'; }
      var when = seg(t('when_call'), [
        { value: 'now', action: 'seg', field: 'callback_when', kids: [svg('bolt', 16, 2), t('asap_option')] },
        { value: 'later', action: 'seg', field: 'callback_when', kids: [svg('cal', 16, 2), t('schedule')] },
      ], function () { return fd().callback_when === 'later' ? 'later' : 'now'; }, function (v) { fd().callback_when = v; showLater(); });
      showLater();
      sync(showLater);
      when.appendChild(later);
      var days = slotDays();
      if (days.length) {
        var slotBox = el('div');
        var shown = null;
        var slotGroup = null;
        var dayOf = function (at) {
          var k = null;
          days.forEach(function (d) { if (!k && d.slots.some(function (s) { return s.at === at; })) k = d.key; });
          return k;
        };
        var pickDay = function () {
          var sel = dayOf(fd().callback_scheduled_for) || ui.daySel;
          if (!sel || !days.some(function (d) { return d.key === sel; })) {
            sel = null;
            days.forEach(function (d) { if (!sel && d.slots.some(function (s) { return s.ok; })) sel = d.key; });
          }
          return sel || days[0].key;
        };
        var showSlots = function (key) {
          ui.daySel = shown = key;
          var day = days.filter(function (d) { return d.key === key; })[0];
          slotGroup = radios(el('div', { class: 'slots' }), day.slots.map(function (s) {
            return { value: s.at, action: 'slot', cls: 'chip' + (s.ok ? '' : ' dis'), disabled: !s.ok, kids: [H.fmtTime(s.at)] };
          }), t('time'), function (v) { fd().callback_scheduled_for = v; });
          slotGroup.set(fd().callback_scheduled_for);
          slotBox.replaceChildren(slotGroup.el);
        };
        var dayGroup = radios(el('div', { class: 'days' }), days.map(function (d) {
          return { value: d.key, action: 'day', cls: 'chip', kids: [H.fmtDay(d.at)] };
        }), t('when_call'), showSlots);
        var first = pickDay();
        dayGroup.set(first);
        showSlots(first);
        sync(function () {
          var at = fd().callback_scheduled_for;
          var d = dayOf(at);
          if (d && d !== shown) { dayGroup.set(d); showSlots(d); } else slotGroup.set(at);
        });
        later.appendChild(dayGroup.el);
        later.appendChild(slotBox);
      } else {
        // No slots offered: the browser's own picker, styled as a field.
        var dt = el('input', { class: 'v ltrv', id: id('d'), type: 'datetime-local', dir: 'ltr', 'aria-label': t('schedule') });
        var min = new Date(Date.now() + 5 * 60000);
        dt.min = new Date(min.getTime() - min.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        var pull = function () {
          var v = fd().callback_scheduled_for || '';
          v = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(v) ? v : '';
          if (dt.value !== v && !focused(dt)) dt.value = v;
        };
        pull();
        sync(pull);
        dt.addEventListener('input', function () { fd().callback_scheduled_for = dt.value; });
        later.appendChild(el('div', { class: 'inp dt' }, [dt]));
      }
      fm.appendChild(when);
      fm.appendChild(seg(t('priority'), [
        { value: 'normal', action: 'seg', field: 'callback_urgency', kids: [t('normal')] },
        { value: 'urgent', action: 'seg', field: 'callback_urgency', onCls: 'urg', kids: [svg('bolt', 16, 2), t('urgent')] },
      ], function () { return fd().callback_urgency === 'urgent' ? 'urgent' : 'normal'; }, function (v) { fd().callback_urgency = v; }));
    }

    /** Step 2: the summary, department, how to reach the visitor, the message. */
    function stepTwo(fm, fields, toStep) {
      var p = pol();
      var icon = el('span', { class: 'it' });
      var tx = el('span', { class: 'tx' });
      var shownIcon = null;
      sync(function () {
        var f = fd();
        var video = f.callback_channel === 'video';
        if (shownIcon !== video) { shownIcon = video; icon.replaceChildren(svg(video ? 'video' : 'phone', 17, 1.9)); }
        setText(tx, [t(video ? 'summary_video' : 'summary_phone'), whenText(scheduledAt(f)), t(f.callback_urgency === 'urgent' ? 'urgent' : 'normal')].join(' · '));
      });
      fm.appendChild(el('div', { class: 'sumchip' }, [icon, tx,
        el('button', { type: 'button', class: 'chg', 'data-action': 'change', on: { click: function () { toStep(1); } } }, [t('change')]),
      ]));
      var list = (boot().departments || {}).callback || [];
      if (list.length) fm.appendChild(deptChips(list));
      if (identified() && !ui.editingContact) fm.appendChild(knownCard());
      else {
        fm.appendChild(contactGroup(!!p.require_contact, fields));
        fields.slice(1).forEach(function (x) { x.match = function (e) { return e === t('err_contact_required'); }; });
        if (p.require_contact) fm.appendChild(el('p', { class: 'note' }, [svg('info', 14, 2), t('contact_required_note')]));
      }
      var min = p.min_message_length > 0 ? p.min_message_length : 0;
      var msg = field({ label: min ? t('message_min', { n: dig(min) }) : t('message_optional'), type: 'textarea', placeholder: t('message_placeholder') },
        function () { return fd().message; }, function (v) { fd().message = v; }, false);
      msg.match = function (e) { return !!min && (e === t('err_message_short', { n: min }) || e === t('err_message_short', { n: dig(min) })); };
      fields.push(msg);
      fm.appendChild(msg.el);
      if (p.honeypot_enabled !== false) {
        // Off screen, never display:none (bots skip hidden fields).
        var hp = el('input', { class: 'hp', type: 'text', name: 'company_website', autocomplete: 'off', tabindex: '-1', 'aria-hidden': 'true' });
        hp.value = fd().hp_company || '';
        hp.addEventListener('input', function () { fd().hp_company = hp.value; });
        fm.appendChild(hp);
      }
    }

    function callback(ctrl) {
      var ups = S = [];
      var step = ui.callbackStep === 2 ? 2 : 1;
      var fields = [];
      function toStep(n) { ui.callbackStep = n; H.requestRender(); }
      var stp = el('span', { class: 'stp' }, [t('step_of', { n: dig(step), total: dig(2) }),
        el('span', { class: 'bars' }, [el('i', { class: 'on' }), el('i', { class: step === 2 ? 'on' : null })])]);
      var fm = el('div', { class: 'fm' });
      if (step === 1) stepOne(fm);
      else stepTwo(fm, fields, toStep);
      fm.appendChild(errSlot(ups, function (e, eid) { markInvalid(fields, e, eid); }));
      var form = el('form', {
        class: 'frm', novalidate: true,
        on: { submit: function (e) { e.preventDefault(); if (ui.callbackStep === 2) C.submitCallback(); else toStep(2); } },
      }, [
        el('div', { class: 'bd' }, [fm]),
        acts(step === 1 ? [
          btn('gh', 'back', [t('back')], function () { C.reset(); }),
          btn('pri', 'continue', [t('continue'), svg('arrow-f', 18, 2.2, 'dirf')], function () { toStep(2); }),
        ] : [
          btn('gh', 'back', [t('back')], function () { toStep(1); }),
          btn('pri', 'submit', [svg('check', 18, 2.4), t('send_request')], null, 'submit'),
        ]),
      ]);
      S = null;
      return frame(ctrl, [ctxBar('phone-in', t('request_callback_title'), function () { if (step === 2) toStep(1); else C.reset(); }, stp), form], ups);
    }

    // ─── 19 scheduled ──────────────────────────────────────────────────────
    function booking(ctrl) {
      var bk = ui.bookingView && ctrl.callbackBooking;
      if (bk) return { id: bk.callbackId, at: bk.scheduled_for, channel: bk.channel, urgency: bk.urgency };
      var f = ctrl.formData || {};
      return { id: ctrl.callbackId, at: f.callback_when === 'later' ? f.callback_scheduled_for : null, channel: f.callback_channel, urgency: f.callback_urgency };
    }

    function scheduled(ctrl) {
      var b = booking(ctrl);
      var at = b.at && !isNaN(Date.parse(b.at)) ? b.at : null;
      var video = b.channel === 'video';
      var code = String(b.id || '').slice(0, 8).toUpperCase();
      var cpy = el('button', { class: 'cpy', type: 'button', 'data-action': 'copy-code', 'aria-label': t('copy_code') }, [svg('copy', 15, 1.9)]);
      cpy.addEventListener('click', function () {
        var clip = global.navigator && global.navigator.clipboard;
        var done = function () {
          cpy.replaceChildren(svg('check', 15, 2.4));
          toggle(cpy, 'ok', true);
          H.announce(t('copied'));
          clearTimeout(copyTimer);
          copyTimer = setTimeout(function () { cpy.replaceChildren(svg('copy', 15, 1.9)); toggle(cpy, 'ok', false); }, 1600);
        };
        try { if (clip && clip.writeText) clip.writeText(code).then(done, function () {}); } catch (_) { /* not allowed here */ }
      });
      function row(k, v) { return el('div', { class: 'r' }, [el('span', { class: 'k' }, [t(k)]), v]); }
      var ctr = el('div', { class: 'ctr' }, [
        el('span', { class: 'okc' }, [el('span', { class: 'in' }, [svg('check', 32, 2.6)]), el('span', { class: 'bdg' }, [svg('cal', 16, 2)])]),
        el('h3', {}, [t('callback_scheduled')]),
        el('p', {}, [t('reach_out', { when: at ? H.fmtWhen(at) : t('asap') })]),
        el('div', { class: 'kv' }, [
          row('type', el('span', { class: 'v' }, [svg(video ? 'video' : 'phone', 16, 1.9), t(video ? 'video_callback' : 'phone_callback')])),
          at ? row('time', el('span', { class: 'v' }, [whenText(at)])) : null,
          row('priority', b.urgency === 'urgent' ? el('span', { class: 'tagu' }, [svg('bolt', 13, 2.2), t('urgent')]) : el('span', { class: 'v' }, [t('normal')])),
          code ? row('reference', el('span', { class: 'v' }, [el('span', { class: 'code' }, [code]), cpy])) : null,
        ]),
      ]);
      return frame(ctrl, [el('div', { class: 'bd' }, [ctr]), acts([btn('pri full', 'done', [t('done')], function () {
        if (ui.bookingView) { ui.bookingView = false; C.toggleOpen(); } else C.reset();
      })])], []);
    }

    // ─── the call stage (04–12): dark screens, ticked in place ─────────────
    // Before the media is up nothing is muted and nobody has a face yet.
    var PRE_LIVE = { pending: 1, token_ready: 1, loading_media_client: 1, connecting_media: 1 };
    var STATUS_KEY = { loading_media_client: 'loading_media_client', connecting_media: 'connecting_av', waiting_for_operator: 'operator_joining' };
    var FAIL_KEY = { rtc_v1_unsupported: 'rtc_unsupported', provider_client_not_configured: 'provider_not_configured', provider_client_not_supported: 'provider_not_supported' };
    var QUALITY = { excellent: 4, good: 3, poor: 2, lost: 1 };
    var SAY = { connecting: 'connecting', voice: 'in_call', video: 'in_call', transfer: 'transferring_call', reconnect: 'reconnecting_media' };

    /** The engine's ring (Ringback) as the render context lends it; never throws. */
    function au() { return (H.audio && H.audio()) || {}; }
    function aq(name) { var a = au(); try { return typeof a[name] === 'function' && !!a[name](); } catch (_) { return false; } }
    function qx() { return boot().queue_experience || {}; }
    function since(at) { return H.fmtClock(at ? Date.now() - at : 0); }
    function noDots(s) { return String(s || '').replace(/\s*(…|\.\.\.)\s*$/, ''); }
    function preLive(c) { return !c.connectStatus || !!PRE_LIVE[c.connectStatus]; }
    function recording(c) { return !!(c.call && c.call.recording_state === 'recording'); }
    function micOff(c) { return c.micOn === false && !preLive(c); }
    function camOff(c) { return !c.camOn; }
    /** The operator's video, as the engine attached it (the first video track). */
    function remote(c) {
      var tr = c._attachedTracks || {};
      var keys = Object.keys(tr);
      for (var i = 0; i < keys.length; i++) {
        var m = tr[keys[i]];
        if (m && String(m.tagName || '').toLowerCase() === 'video') return { el: m, sid: keys[i] };
      }
      return null;
    }
    function failTitle(c) {
      // The room's failure names its error below the title, not in it.
      if (c.connectStatus === 'room_connect_failed') return t('room_failed', { error: '' }).replace(/[\s:،]+$/, '');
      return t(FAIL_KEY[c.connectStatus] || c.connectStatus);
    }
    function host() { try { return String(global.location.hostname || ''); } catch (_) { return ''; } }

    // Media (§2.5): each element marked once; the self-view mirrored, the
    // operator's picture never; moved with one appendChild, never cloned.
    function prep(m, local, sid) {
      var mark = local ? 'data-local-video' : 'data-remote-video';
      if (m.getAttribute(mark) !== 'true') {
        m.setAttribute(mark, 'true');
        if (local) { m.setAttribute('data-orientation-correction', 'scaleX(-1)'); m.style.transform = 'scaleX(-1)'; }
      }
      if (sid) attr(m, 'data-track-sid', sid);
      return m;
    }
    function hold(box, m) {
      if (m.parentNode !== box) box.insertBefore(m, box.firstChild);
      [].slice.call(box.querySelectorAll('video')).forEach(function (v) { if (v !== m && v.parentNode === box) box.removeChild(v); });
    }

    function sbox(kids, cls) { return el('div', { class: 'sb' + (cls ? ' ' + cls : '') }, kids); }
    function ldots() { return el('span', { class: 'ldots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]); }
    function orbOf(cls, kids) { return el('div', { class: 'orb ' + cls, 'aria-hidden': 'true' }, kids); }
    /**
     * An operator's face: the person silhouette (`.sil`, drawn by the
     * stylesheets) once a name is known, a headset before (D34); never a
     * letter (owner, 2026-10-24). Rebuilt only when that changes.
     */
    function faceOf(node, size) {
      var shown = null;
      return {
        set: function (name) {
          var k = !!name;
          if (k !== shown) {
            shown = k;
            toggle(node, 'sil', k);
            if (k) node.replaceChildren(); else node.replaceChildren(svg('headset', size, 1.7));
          }
        },
        clear: function () { shown = null; toggle(node, 'sil', false); },
      };
    }
    function endCall() { C.cancelCall(); }
    function minimize() { C.toggleOpen(); }
    function toggleMic() { if (typeof C.toggleMic === 'function') C.toggleMic(); }
    function toggleCam() { if (typeof C.toggleCam === 'function') C.toggleCam(); }
    /** The offer and the failures (E5): the callback form once the cancel has answered, never before. */
    function toCallback() {
      var go = function () { C.openCallback(); };
      var p = null;
      try { p = C.cancelCall(); } catch (_) { /* the engine's */ }
      if (p && typeof p.then === 'function') p.then(go, go); else go();
    }

    /** The ring's sound toggle (D7): its look, label and aria-pressed follow the ring. */
    function soundBtn(cls, size, ups) {
      var b = el('button', { class: cls, type: 'button', 'data-action': 'sound' });
      var shown = null;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var a = au();
        try {
          if (aq('isMuted') || aq('needsGesture')) {
            a.setMuted(false);
            // In the click: a gesture may start what autoplay refused.
            if (aq('needsGesture')) a.startFromGesture(qx());
          } else a.setMuted(true);
        } catch (_) { /* the ring is the engine's */ }
        H.requestRender();
      });
      ups.push(function () {
        var off = aq('isMuted') || aq('needsGesture');
        attr(b, 'aria-pressed', off ? 'true' : 'false');
        attr(b, 'aria-label', t(off ? 'unmute_sound' : 'mute_sound'));
        if (off !== shown) { shown = off; b.replaceChildren(svg(off ? 'vol-x' : 'vol', size, 1.9)); }
      });
      return b;
    }

    /** A call toggle (microphone, camera): look, label and aria-pressed follow the engine. */
    function callToggle(b, box, label, icons, keys, size, stroke, isOff) {
      var shown = null;
      return function (c) {
        var off = !!isOff(c);
        if (off === shown) return;
        shown = off;
        toggle(b, 'on', off);
        attr(b, 'aria-pressed', off ? 'true' : 'false');
        box.replaceChildren(svg(icons[off ? 1 : 0], size, stroke));
        if (label) setText(label, t(keys[off ? 1 : 0]));
        else attr(b, 'aria-label', t(keys[off ? 1 : 0]));
      };
    }
    function cbn(action, icon, size, stroke, key, onClick, cls) {
      var bt = el('span', { class: 'bt' }, [svg(icon, size, stroke)]);
      var tx = document.createTextNode(t(key));
      return { b: el('button', { class: 'cbn' + (cls ? ' ' + cls : ''), type: 'button', 'data-action': action, on: { click: onClick } }, [bt, tx]), bt: bt, tx: tx };
    }
    /** The call's dock: mute, end, minimise (+ the camera without a picture, D32). */
    function callDock(ups, cam) {
      var mic = cbn('mute', 'mic', 24, 1.9, 'mute', toggleMic);
      ups.push(callToggle(mic.b, mic.bt, mic.tx, ['mic', 'mic-off'], ['mute', 'unmute'], 24, 1.9, micOff));
      var kids = [mic.b];
      if (cam) {
        var c = cbn('cam', 'video', 22, 1.9, 'camera_off', toggleCam);
        ups.push(callToggle(c.b, c.bt, c.tx, ['video', 'video-off'], ['camera_off', 'camera_on'], 22, 1.9, camOff));
        kids.push(c.b);
      }
      var end = cbn('end', 'hangup', 28, 2, 'end', endCall, 'end');
      attr(end.b, 'aria-label', t('end_call'));
      kids.push(end.b, cbn('minimize', 'mini', 22, 1.9, 'minimize', minimize).b);
      return el('div', { class: 'dock' }, kids);
    }
    function queueDock(ups) {
      return el('div', { class: 'dock q' }, [
        soundBtn('gbtn', 22, ups),
        el('button', { class: 'xbtn', type: 'button', 'data-action': 'cancel', on: { click: endCall } }, [svg('hangup', 22, 2.1), t('cancel_call')]),
      ]);
    }
    /** The time chip's row: the chip, and the ring's toggle while the ring plays (D7). */
    function ctw(ups, ctm) {
      var sbt = soundBtn('sbt', 17, ups);
      ups.push(function () { sbt.hidden = !aq('isActive'); });
      return el('span', { class: 'ctw' }, [ctm, sbt]);
    }
    /** Name (hidden without one, D34), role and the time chip. */
    function who(ups, ctm) {
      var nm = el('span', { class: 'nm' });
      ups.push(function (c) { var n = c.operatorName; nm.hidden = !n; if (n) setText(nm, n); });
      return el('div', { class: 'who-c', 'data-focus': '' }, [nm, el('span', { class: 'rl' }, [t('operator_label')]), ctw(ups, ctm)]);
    }
    function rnote(ups) {
      var n = el('p', { class: 'rnote' }, [svg('info', 16, 1.8), t('recording_may_start')]);
      ups.push(function (c) { n.hidden = !(rec().effective_enabled && !recording(c)); });
      return n;
    }
    /** D23: the camera was refused; the call goes on with the microphone until the camera is on. */
    function camBanner(ups, cls) {
      var b = el('div', { class: 'bnr' + cls }, [svg('video-off', 16, 1.9), t('camera_denied')]);
      ups.push(function (c) { b.hidden = !(c.cameraDenied || c.connectStatus === 'camera_permission_denied') || !!c.camOn; });
      return b;
    }
    function pipBox(ups) {
      var node = el('div', { class: 'pip', role: 'img', 'aria-label': t('you') }, [el('span', { class: 'me-l' }, [t('you')])]);
      ups.push(function (c) {
        var m = c.camOn && c._localVideoEl;
        node.hidden = !m;
        if (m) hold(node, prep(m, true, c._localVideoTrack && c._localVideoTrack.sid));
      });
      return node;
    }

    // 04
    function connecting(ctrl) {
      var ups = [];
      var f = fd();
      var video = f.call_type === 'video';
      var dep = ((boot().departments || {})[video ? 'video' : 'voice'] || []).filter(function (d) { return d && String(d.id) === String(f.department_id); })[0];
      var sb = sbox([
        orbOf('spin', [el('span', { class: 'core' }, [svg('phone', 46, 1.7)])]),
        el('h2', { class: 'sh' }, [t('connecting'), ldots()]),
        el('p', { class: 'sp ctxl' }, [svg(video ? 'video' : 'mic', 15, 1.9), [t(video ? 'video_call' : 'voice_call'), dep && dep.name].filter(Boolean).join(' · ')]),
        el('div', { class: 'qc sk', 'aria-hidden': 'true' }, [el('i', { class: 'gsk' }), el('i', { class: 'gsk' })]),
      ], 'q');
      return frame(ctrl, [sb, queueDock(ups)], ups, 'stage');
    }

    // 05 / 06
    function stat(key) {
      var b = el('b');
      var node = el('span', {}, [el('small', {}, [t(key)]), b]);
      return { el: node, set: function (on, v) { node.hidden = !on; if (on) setText(b, v); } };
    }
    function queue(ctrl) {
      var ups = [];
      var eq = el('span', { class: 'eq', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i'), el('i')]);
      // The phone's full screen has room for the full orb (board 11, 22).
      var orb = orbOf(H.isMobile() ? 'ringing lvq' : 'ringing sm lvq', [el('i', { class: 'rg' }), el('i', { class: 'rg' }), el('i', { class: 'rg' }), el('span', { class: 'core' }, [svg('phone', 46, 1.7)])]);
      var sh = el('h2', { class: 'sh' });
      var sp = el('p', { class: 'sp' });
      var tm = document.createTextNode('');
      var hint = el('span', { class: 'hint' }, [svg('vol-x', 15, 1.9), t('tap_to_hear')]);
      // The line: you, the people ahead (two dots at most), the operator. Its
      // dots sit where a space-between row puts them; a passed one fades and
      // you move up (q2, q1).
      var line = el('div', { class: 'ql2', 'aria-hidden': 'true' }, [
        el('span', { class: 'op' }, [svg('headset', 17, 1.8)]),
        el('span', { class: 'tk' }, [el('i', { class: 'pp d1' }), el('i', { class: 'pp d2' })]),
        el('span', { class: 'me' }, [t('you')]),
      ]);
      var place = stat('queue_position');
      var wait = stat('eta');
      var qs = el('div', { class: 'qs' }, [place.el, wait.el]);
      var qc = el('div', { class: 'qc' }, [line, qs]);
      var ob = el('button', { class: 'btn', type: 'button', 'data-action': 'offer-callback' }, [t('request_callback')]);
      ob.addEventListener('click', function () { H.stageOrigin(ob); toCallback(); });
      var offer = el('div', { class: 'offer' }, [el('p', {}, [svg('phone-in', 18, 1.9), t('tired_waiting')]), ob]);
      ups.push(function (c) {
        var q = qx();
        var pos = typeof c.queuePosition === 'number' ? c.queuePosition : null;
        var first = pos === 1;
        var eta = typeof c.queueEta === 'number' ? c.queueEta : null;
        var th = q.offer_callback_after_seconds || 0;
        eq.hidden = !aq('isActive');
        toggle(orb, 'fast', first);
        setText(sh, t(first ? 'you_are_next' : 'holding_place'));
        setText(sp, t(first ? 'queue_copy_next' : 'queue_copy_many'));
        setText(tm, since(c.queueStartedAt));
        hint.hidden = !aq('needsGesture');
        offer.hidden = !(caps().callback && th > 0 && c.queueStartedAt && Date.now() - c.queueStartedAt >= th * 1000);
        // The offer takes the line card's room, as 06 draws it (both would grow over the dock).
        qc.hidden = first || !offer.hidden;
        place.set(q.show_position !== false && pos != null, dig(pos));
        wait.set(q.show_eta !== false && eta != null, eta < 60 ? t('eta_value_under_min') : t('eta_value_minutes', { n: dig(Math.max(1, Math.round(eta / 60))) }));
        qs.hidden = place.el.hidden && wait.el.hidden;
      });
      var sb = sbox([el('span', { class: 'pill' }, [eq, t('ringing_operator')]), orb, sh, sp,
        el('div', { class: 'tmr', role: 'timer' }, [el('span', { class: 'tl' }, [t('waiting_time')]), el('b', {}, [tm])]), hint, qc, offer], 'q');
      return frame(ctrl, [sb, queueDock(ups)], ups, 'stage');
    }

    // 07 (and the statuses before the media is up)
    function joining(ctrl) {
      var ups = [];
      var tx = document.createTextNode('');
      var core = el('span', { class: 'core' });
      var face = faceOf(core, 46);
      var orb = orbOf('', [core]);
      var st = document.createTextNode('');
      var spun = null;
      ups.push(function (c) {
        var waiting = c.connectStatus === 'waiting_for_operator';
        var spin = !c.operatorName && !waiting;
        setText(tx, t(waiting ? 'connected_waiting' : 'connecting'));
        if (spin !== spun) {
          spun = spin;
          orb.className = spin ? 'orb spin' : 'orb op breathe';
          face.clear();
          if (spin) core.replaceChildren(svg('phone', 46, 1.7));
        }
        if (!spin) face.set(c.operatorName);
        setText(st, noDots(t(STATUS_KEY[c.connectStatus] || 'call_accepted_connecting')));
      });
      var sb = sbox([el('span', { class: 'pill' }, [el('i', { class: 'gd' }), tx]), orb,
        who(ups, el('span', { class: 'ctm mut' }, [st, ldots()])), rnote(ups)]);
      return frame(ctrl, [sb, callDock(ups)], ups, 'stage');
    }

    // 08, and D32 (a video call with no picture: the camera in the dock, the self-view)
    function voice(ctrl, video) {
      var ups = [];
      var rd = el('i', { class: 'rd' });
      var gd = el('i', { class: 'gd' });
      var ptx = document.createTextNode('');
      var pill = el('span', { class: 'pill' }, [rd, gd, ptx]);
      var core = el('span', { class: 'core' });
      var face = faceOf(core, 46);
      var tm = document.createTextNode('');
      var bars = svg('signal', 15, 2.2);
      var net = el('span', { class: 'net' }, [bars]);
      ups.push(function (c) {
        var r = recording(c);
        var q = QUALITY[c.connectionQuality] || 0;
        toggle(pill, 'rec', r);
        rd.hidden = !r;
        gd.hidden = r;
        setText(ptx, t(r ? 'recording_progress' : 'in_call'));
        face.set(c.operatorName);
        setText(tm, since(c.callStartedAt));
        net.hidden = !q;
        if (q) {
          attr(net, 'title', t('quality_' + c.connectionQuality));
          [].forEach.call(bars.childNodes, function (p, i) { attr(p, 'opacity', i < q ? null : '.35'); });
        }
      });
      var sb = sbox([camBanner(ups, ''), pill, orbOf('op halo', [el('i', { class: 'halo' }), el('i', { class: 'halo' }), core]),
        who(ups, el('span', { class: 'ctm', role: 'timer' }, [el('i', { class: 'gd' }), tm, net])), rnote(ups)]);
      return frame(ctrl, [sb, video ? pipBox(ups) : null, callDock(ups, video)], ups, 'stage');
    }

    // 09: the operator's picture fills the panel
    function vbt(action, icon, size, stroke, key, onClick, cls) {
      return el('button', { class: 'bt' + (cls ? ' ' + cls : ''), type: 'button', 'data-action': action, 'aria-label': t(key), on: { click: onClick } }, [svg(icon, size, stroke)]);
    }
    function videoScr(ctrl) {
      var ups = [];
      var feed = el('div', { class: 'feed', 'aria-hidden': 'true' });
      var rd = el('i', { class: 'rd' });
      var rl = el('span', {}, [t('recording_short')]);
      var sep = el('i', { class: 'sep' });
      // Ticking values are text nodes: a tick changes their data, never a node.
      var nm = document.createTextNode('');
      var num = document.createTextNode('');
      var mic = vbt('mute', 'mic', 22, 1.9, 'mute', toggleMic);
      var cam = vbt('cam', 'video', 22, 1.9, 'camera_off', toggleCam);
      ups.push(callToggle(mic, mic, null, ['mic', 'mic-off'], ['mute', 'unmute'], 22, 1.9, micOff));
      ups.push(callToggle(cam, cam, null, ['video', 'video-off'], ['camera_off', 'camera_on'], 22, 1.9, camOff));
      ups.push(function (c) {
        rd.hidden = rl.hidden = sep.hidden = !recording(c);
        setText(nm, c.operatorName || t('operator_label'));
        setText(num, since(c.callStartedAt));
      });
      var s = frame(ctrl, [
        el('div', { class: 'vtop', 'data-focus': '' }, [rd, rl, sep, el('span', {}, [nm]), el('i', { class: 'sep' }), el('span', { class: 'num' }, [num])]),
        camBanner(ups, ' gl'),
        pipBox(ups),
        el('div', { class: 'vdock' }, [mic, cam, vbt('end', 'hangup', 26, 2, 'end_call', endCall, 'end'), vbt('minimize', 'mini', 20, 1.9, 'minimize', minimize)]),
      ], ups, 'stage vid');
      s.el.insertBefore(feed, s.el.firstChild);
      s.feed = feed;
      return s;
    }

    // 10
    function transfer(ctrl) {
      var ups = [];
      var av = el('span', { class: 'av c1' });
      var face = faceOf(av, 30);
      var tm = document.createTextNode('');
      ups.push(function (c) { face.set(ui.previousOperatorName); setText(tm, since(c.callStartedAt)); });
      var sb = sbox([
        el('span', { class: 'pill' }, [el('i', { class: 'gd' }), t('in_call')]),
        el('div', { class: 'xf', 'aria-hidden': 'true' }, [av,
          el('span', { class: 'ar' }, [0, 1, 2].map(function () { return svg('chevron-forward', 22, 2, 'ch dirf'); })),
          el('span', { class: 'to' }, [svg('headset', 30, 1.7)])]),
        el('h2', { class: 'sh' }, [t('transferring_call')]),
        el('p', { class: 'sp' }, [t('transfer_hold')]),
        ctw(ups, el('span', { class: 'ctm', role: 'timer' }, [el('i', { class: 'gd' }), tm])),
      ]);
      return frame(ctrl, [sb, callDock(ups)], ups, 'stage');
    }

    // 11
    function reconnect(ctrl) {
      var ups = [];
      var core = el('span', { class: 'core' });
      var face = faceOf(core, 46);
      var tm = document.createTextNode('');
      ups.push(function (c) { face.set(c.operatorName); setText(tm, since(c.callStartedAt)); });
      var sb = sbox([
        el('div', { class: 'bnr' }, [el('i', { class: 'spn' }), t('reconnecting_media')]),
        orbOf('op dim', [el('i', { class: 'dash' }), core]),
        who(ups, el('span', { class: 'ctm mut', role: 'timer' }, [svg('wifi-off', 15, 2), tm])),
      ]);
      return frame(ctrl, [sb, callDock(ups)], ups, 'stage');
    }

    // 12, and the failures (its layout, titled by the status, D22)
    function endBtn() { return el('button', { class: 'btn gl', type: 'button', 'data-action': 'end', on: { click: endCall } }, [t('end_call')]); }
    function micBlocked(ctrl) {
      var ups = [];
      var retry = el('button', {
        class: 'btn wh', type: 'button', 'data-action': 'retry-mic',
        on: { click: function () { if (typeof C.retryMicrophone === 'function') C.retryMicrophone(); } },
      }, [svg('retry', 18, 2), t('retry')]);
      ups.push(function (c) { retry.hidden = typeof c.retryMicrophone !== 'function'; });
      var body = el('p', { class: 'sp', id: id('d') }, [t('mic_denied_body')]);
      var how = el('p', { class: 'how', id: id('d') }, [t('mic_denied_how')]);
      var sb = sbox([
        el('span', { class: 'ei' }, [svg('mic-off', 34, 1.8)]),
        el('h2', { class: 'sh', 'aria-describedby': body.id + ' ' + how.id }, [t('mic_denied_title')]),
        body,
        el('div', { class: 'addr', 'aria-hidden': 'true' }, [
          el('div', { class: 'bar', dir: 'ltr' }, [el('span', { class: 'lk2' }, [svg('lock', 13, 2.2)]), host(), el('span', { class: 'dots' }, [el('i'), el('i'), el('i')])]),
          el('div', { class: 'pop' }, [svg('mic', 17, 1.9), t('microphone'), el('span', { class: 'sw on' })]),
        ]),
        how,
        el('div', { class: 'row2' }, [endBtn(), retry]),
      ], 'dn');
      return frame(ctrl, [sb, el('div', { class: 'spc' })], ups, 'stage');
    }
    function fail(ctrl) {
      var ups = [];
      var sp = el('p', { class: 'sp', id: id('d') });
      // Focus lands on the title: the reason the engine gives comes with it.
      var sh = el('h2', { class: 'sh', 'aria-describedby': sp.id });
      var cb = caps().callback ? el('button', { class: 'btn wh', type: 'button', 'data-action': 'callback' }, [svg('phone-in', 18, 2), t('request_callback')]) : null;
      if (cb) cb.addEventListener('click', function () { H.stageOrigin(cb); toCallback(); });
      ups.push(function (c) { setText(sh, failTitle(c)); sp.hidden = !c.error; setText(sp, c.error || ''); });
      var sb = sbox([el('span', { class: 'ei' }, [svg('warn', 34, 1.8)]), sh, sp, el('div', { class: 'row2' }, [endBtn(), cb])], 'dn');
      return frame(ctrl, [sb, el('div', { class: 'spc' })], ups, 'stage');
    }

    // ─── minimised (Se, Sf, Sg): the call goes on in the launcher ──────────
    var mini = null;
    var MINI = { loading: 1, queue_waiting: 1, in_call: 1 };
    function restore() {
      C.toggleOpen();
      // The bar's button left with the bar: focus goes to the panel's screen.
      var s = C.open && cur && screens[cur];
      if (s) focusHeading(s.el);
    }
    function mbtn(cls, action, key, icon, size, stroke, onClick) {
      return el('button', { class: cls, type: 'button', 'data-action': action, 'aria-label': t(key), on: { click: onClick } }, icon ? [svg(icon, size, stroke)] : []);
    }
    function buildMini() {
      // Se: the queue (and the request in flight, D10)
      var seT = el('b');
      var seW = document.createTextNode('');
      var seS = el('small', {}, [seW]);
      var se = el('div', { class: 'mc stage-bg', role: 'group' }, [
        el('span', { class: 'mo', 'aria-hidden': 'true' }, [svg('phone', 22, 1.9)]),
        el('span', { class: 'tx' }, [seT, seS]),
        mbtn('mbt', 'restore', 'restore_call', 'expand', 17, 2, restore),
        mbtn('mbt end', 'cancel', 'cancel_call', 'hangup', 20, 2.1, endCall),
      ]);
      // Sf: a call; the whole bar restores, but for its own buttons
      var av = el('span', { class: 'av c1', 'aria-hidden': 'true' });
      var face = faceOf(av, 20);
      var sfN = el('b');
      var sfW = document.createTextNode('');
      var sfT = el('small', {}, [sfW]);
      var wvs = el('span', { class: 'wvs', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i'), el('i'), el('i')]);
      var sfMic = mbtn('mbt', 'mute', 'mute', 'mic', 18, 2, toggleMic);
      var sf = el('div', { class: 'mc stage-bg', role: 'group', 'aria-label': t('in_call') }, [
        mbtn('mx', 'restore', 'restore_call', null, 0, 0, restore),
        av, el('span', { class: 'tx' }, [sfN, sfT]), wvs, sfMic,
        mbtn('mbt end', 'end', 'end_call', 'hangup', 20, 2.1, endCall),
      ]);
      // Sg: the operator's picture in a small window
      var feed = el('div', { class: 'feed', 'aria-hidden': 'true' });
      var rd = el('i', { class: 'rd', 'aria-hidden': 'true' });
      var sgW = document.createTextNode('');
      var sgT = el('span', { class: 't' }, [sgW]);
      var sgMic = mbtn(null, 'mute', 'mute', 'mic', 15, 2, toggleMic);
      var sg = el('div', { class: 'mvid', role: 'group', 'aria-label': t('video_minimized') }, [
        feed, rd, mbtn('exp', 'restore', 'restore_call', 'expand', 14, 2.2, restore),
        el('div', { class: 'bar3' }, [sgT, sgMic, mbtn('end', 'end', 'end_call', 'hangup', 17, 2.1, endCall)]),
      ]);
      var sfMicUp = callToggle(sfMic, sfMic, null, ['mic', 'mic-off'], ['mute', 'unmute'], 18, 2, micOff);
      var sgMicUp = callToggle(sgMic, sgMic, null, ['mic', 'mic-off'], ['mute', 'unmute'], 15, 2, micOff);
      return {
        se: {
          el: se,
          upd: function (c) {
            var pos = typeof c.queuePosition === 'number' ? c.queuePosition : null;
            var title = c.state === 'loading' ? t('connecting')
              : pos === 1 ? t('queue_next_short') : pos > 1 ? t('queue_place_short', { n: dig(pos) }) : t('holding_place');
            setText(seT, title);
            attr(se, 'aria-label', title);
            seS.hidden = c.state === 'loading';
            setText(seW, t('waiting_time') + ' ' + since(c.queueStartedAt));
          },
        },
        sf: {
          el: sf,
          bars: [].slice.call(wvs.children),
          upd: function (c) {
            face.set(c.operatorName);
            setText(sfN, c.operatorName ? String(c.operatorName).trim().split(/\s+/)[0] : t('operator_label'));
            setText(sfW, since(c.callStartedAt));
            sfMicUp(c);
            // CSS moves the bars until the engine's meter really runs (E20).
            toggle(wvs, 'live', !!c.audioMeterLive);
          },
        },
        sg: {
          el: sg,
          upd: function (c) {
            var r = remote(c);
            rd.hidden = !recording(c);
            setText(sgW, since(c.callStartedAt));
            sgMicUp(c);
            if (r) hold(feed, prep(r.el, false, r.sid));
          },
        },
      };
    }
    function launcherMini(ctrl) {
      C = ctrl;
      var b = baseSig(ctrl);
      if (!mini || mini.base !== b) { mini = buildMini(); mini.base = b; }
      track(ctrl, false);
      var st = ctrl.state;
      var m = !MINI[st] ? null : st !== 'in_call' ? mini.se : isVideo(ctrl) && remote(ctrl) ? mini.sg : mini.sf;
      // The engine draws its level meter on Sf's bars, handed over on every render (§2.5).
      ctrl._waveBars = m === mini.sf ? mini.sf.bars : null;
      var node = m ? m.el : null;
      // A bar taking another's place (the call answering the queue, the
      // picture arriving) takes the focus the old one held: the same control,
      // else its restore.
      if (node && node !== mini.shown) handOff(function (act) { return node.querySelector('[data-action="' + act + '"]') || node.querySelector('[data-action="restore"]'); });
      mini.shown = node;
      if (!m) return null;
      m.upd(ctrl);
      return node;
    }
    /**
     * The bar on show holds the focus and is going (the core swaps the
     * launcher's content once this render returns): `to(action)` names who
     * takes it, after the swap. Focus never drops to the page.
     */
    function handOff(to) {
      var was = mini && mini.shown;
      if (!was || !focusInside(was)) return;
      var act = was.getRootNode().activeElement.getAttribute('data-action');
      Promise.resolve().then(function () { focusOn(to(act)); });
    }

    // ─── what the stage says and does on its own ───────────────────────────
    var said = '';
    var outKey = '';
    /** An outcome D35 opens the panel for: the call ended, an error, a failure, the microphone refused. */
    function outcome(c) {
      if (c.state === 'ended' || c.state === 'error') return c.state;
      var sid = c.state === 'in_call' ? screenId(c) : '';
      return sid === 'fail' || sid === 'mic' ? sid + ':' + c.connectStatus : '';
    }
    function outcomeText(c) {
      if (c.state === 'ended') return t(c.callbackId ? 'callback_scheduled' : 'call_ended');
      if (c.state === 'error') return c.error || t('unknown');
      return screenId(c) === 'mic' ? t('mic_denied_title') : failTitle(c);
    }
    function statusText(c) {
      var sid = screenId(c);
      var p = c.queuePosition;
      if (sid === 'queue') return p === 1 ? t('you_are_next') : p > 1 ? t('queue_place_short', { n: dig(p) }) : t('holding_place');
      if (sid === 'joining') return t(c.connectStatus === 'waiting_for_operator' ? 'connected_waiting' : 'connecting');
      return SAY[sid] ? t(SAY[sid]) : '';
    }
    /**
     * Root classes of the call (incall: the queue hands over to the call;
     * q1/q2: the line moves), polite words for what changed (never the
     * timers; an outcome unless focus already went to its screen's heading,
     * `held`), and D35: an outcome reached while minimised opens the panel
     * once, without moving focus, unless the bar that goes held it.
     */
    function track(c, visible, held) {
      var pos = c.state === 'queue_waiting' ? c.queuePosition : null;
      H.rootToggle('incall', c.state === 'in_call');
      H.rootToggle('q1', pos === 1);
      H.rootToggle('q2', pos === 2);
      var o = outcome(c);
      var s = o ? (visible && held ? '' : outcomeText(c)) : statusText(c);
      if (s && s !== said) H.announce(s);
      said = s;
      if (o !== outKey) { outKey = o; ui.autoOpened = false; }
      if (!o || ui.autoOpened) return;
      ui.autoOpened = true;
      if (visible || c.open) return;
      Promise.resolve().then(function () { if (!c.open && outcome(c) === o) c.toggleOpen(); });
      // The bar goes with the open: when it held the focus, the outcome's heading takes it.
      handOff(function () { var s = c.open && cur && screens[cur]; return s && s.el.querySelector('[data-focus],h2,h3'); });
    }

    var SCREENS = {
      home: [home, function () { return ''; }],
      precall: [precall, function (c) {
        var x = cfg();
        return [c.formData && c.formData.call_type, identified(), ui.editingContact, JSON.stringify(x.pre_call_form_schema || []),
          JSON.stringify(boot().departments || {}), JSON.stringify(rec())].join('|');
      }],
      rating: [rating, function (c) { return [c.endedCallId, c.endedDuration, opName()].join('|'); }],
      thanks: [thanks, function (c) { return [c.ratingSubmitted, c.ratingValue, c.endedDuration, opName()].join('|'); }],
      error: [error, function () { return ''; }],
      offline: [offline, function () { return cfg().offline_behavior || ''; }],
      callback: [callback, function () {
        return [ui.callbackStep, ui.editingContact, identified(), JSON.stringify(pol()), JSON.stringify(boot().departments || {})].join('|');
      }],
      scheduled: [scheduled, function (c) { var b = booking(c); return [b.id, b.at, b.channel, b.urgency].join('|'); }],
      connecting: [connecting, function (c) { var f = c.formData || {}; return [f.call_type, f.department_id, JSON.stringify(boot().departments || {})].join('|'); }],
      queue: [queue, function () { return ''; }],
      joining: [joining, function () { return ''; }],
      voice: [function (c) { return voice(c, false); }, function () { return ''; }],
      // With the operator's picture (09), or the voice layout until it comes (D32).
      video: [function (c) { return remote(c) ? videoScr(c) : voice(c, true); }, function (c) { return remote(c) ? 'picture' : ''; }],
      transfer: [transfer, function () { return ''; }],
      reconnect: [reconnect, function () { return ''; }],
      mic: [micBlocked, function () { return ''; }],
      fail: [fail, function () { return ''; }],
    };
    var STAGE = { connecting: 1, queue: 1, joining: 1, voice: 1, video: 1, transfer: 1, reconnect: 1, mic: 1, fail: 1 };

    function baseSig(ctrl) {
      var c = cfg();
      var cp = caps();
      return [ctrl.locale, (ctrl.availableLocales || []).join(','), c.display_name, c.avatar_url, cp.voice, cp.video, cp.callback,
        pol().show_when_online, ctrl.t('powered_by'), JSON.stringify(ctrl.poweredByParts ? ctrl.poweredByParts() : null),
        ctrl.poweredByUrl ? ctrl.poweredByUrl() : '', H.isMobile()].join('|');
    }

    /** Focus onto a new screen's heading (a step, a language: its old node is gone). */
    function focusHeading(node, action) {
      focusOn((action && node.querySelector('[data-action="' + action + '"]')) || node.querySelector('[data-focus],h2,h3'));
    }
    function focusOn(target) {
      if (!target || !target.isConnected) return;
      if (!target.hasAttribute('tabindex') && !/^(BUTTON|SELECT|INPUT|TEXTAREA|A)$/.test(target.tagName)) target.setAttribute('tabindex', '-1');
      try { target.focus({ preventScroll: true }); } catch (_) { /* gone */ }
    }
    function activeAction() {
      var s = cur && screens[cur];
      if (!s || !focusInside(s.el)) return null;
      var a = s.el.getRootNode().activeElement;
      return (a && a.getAttribute('data-action')) || '';
    }

    /** A screen, built (or rebuilt when its structure changed) in its layer; not shown here. */
    function ensure(sid, ctrl, ctx) {
      var spec = SCREENS[sid];
      var sig = spec[1](ctrl);
      var s = screens[sid];
      if (s && s.sig === sig) return s;
      var built = spec[0](ctrl);
      built.sig = sig;
      built.el.setAttribute('data-screen', sid);
      if (s && s.el.parentNode) s.el.parentNode.replaceChild(built.el, s.el);
      else (STAGE[sid] ? ctx.dk : ctx.ly).appendChild(built.el);
      if (cur === sid) built.el.classList.add('on');
      else { attr(built.el, 'inert', ''); attr(built.el, 'aria-hidden', 'true'); built.fresh = 1; }
      return (screens[sid] = built);
    }

    /**
     * The operator's picture lives in the video screen's feed while the panel
     * shows (shown or not: a transfer's screen is on top of it), in Sg's
     * window while minimised (launcherMini): one element, moved, never left
     * out of the page.
     */
    function media(ctrl, ctx) {
      var r = remote(ctrl);
      if (!r || !ctx.open || ctrl.state !== 'in_call' || !isVideo(ctrl)) return;
      var v = ensure('video', ctrl, ctx);
      if (v.feed) hold(v.feed, prep(r.el, false, r.sid));
    }

    function render(ctrl, ctx) {
      C = ctrl;
      if (panelEl !== ctx.panel) { panelEl = ctx.panel; panelEl.addEventListener('keydown', trap); }
      // A time the server or the form refused sends step 2 back to the choice (E15).
      if (ctrl.error !== lastErr) {
        lastErr = ctrl.error;
        if (ctrl.state === 'callback_form' && ui.callbackStep === 2 && ctrl.error
          && (ctrl.errorKey === 'err_future_time' || ctrl.error === ctrl.t('err_future_time'))) ui.callbackStep = 1;
      }
      var b = baseSig(ctrl);
      var refocus = null;
      if (b !== base) {
        // A language (direction), a name or a channel changed: every screen again.
        refocus = activeAction();
        Object.keys(screens).forEach(function (k) { var s = screens[k]; if (s.el.parentNode) s.el.parentNode.removeChild(s.el); });
        screens = {};
        cur = null;
        base = b;
      }
      var sid = screenId(ctrl);
      var stage = !!STAGE[sid];
      var old = screens[sid];
      if (old && refocus == null && cur === sid && old.sig !== SCREENS[sid][1](ctrl)) refocus = activeAction();
      var s = ensure(sid, ctrl, ctx);
      if (s.upd) s.upd(ctrl);
      if (cur !== sid) {
        var prev = cur && screens[cur];
        // The new screen shows first (a screen still hidden cannot take
        // focus), then focus moves, then the others turn inert (that would
        // drop focus left in them to the page).
        // A screen drawn just now has had no style yet: resolve its hidden one, so it fades in as a cached one does.
        if (s.fresh) { s.fresh = 0; try { global.getComputedStyle(s.el).opacity; } catch (_) { /* no style: no fade */ } }
        toggle(s.el, 'on', true);
        attr(s.el, 'inert', null);
        attr(s.el, 'aria-hidden', null);
        H.rootToggle('dark', stage);
        if (prev && ctx.open) H.focusScreen(s.el);
        Object.keys(screens).forEach(function (k) {
          if (k === sid) return;
          toggle(screens[k].el, 'on', false);
          attr(screens[k].el, 'inert', '');
          attr(screens[k].el, 'aria-hidden', 'true');
        });
        cur = sid;
      }
      if (refocus != null) focusHeading(s.el, refocus === 'lang' ? 'lang' : null);
      H.rootToggle('dark', stage);
      // The call ended on the rating: the stage folds towards it.
      H.rootToggle('toRate', sid === 'rating' || sid === 'thanks');
      media(ctrl, ctx);
      // Sf is not in the page while the panel shows: the meter draws on nothing.
      if (ctx.open) ctrl._waveBars = null;
      track(ctrl, !!ctx.open, !!ctx.panel && focusInside(ctx.panel));
      if (!ctx.open && !MINI[ctrl.state] && mini) {
        // A cancel from the bar: the launcher that comes back takes the focus the bar held.
        var w = ctx.wrap;
        if (w && !outcome(ctrl)) handOff(function () { return !C.open && (w.querySelector('.ccw-launcher-btn') || w.querySelector('button')); });
        mini.shown = null;
      }
      phone(!!ctx.open && H.isMobile());
    }

    // ─── phones (D14): a modal panel that holds the page still ─────────────
    var lock = null;
    var panelEl = null;
    var vvOn = false;
    var vvTimer = 0;
    var watch = null;
    /**
     * The page behind stays put while a phone's panel is open (the chat widget's lock); the panel follows the
     * visual viewport. A page another widget holds (the chat's phone panel) stays its holder's, each restoring
     * only what it changed; it is watched, so that this panel holds it the moment that one lets go.
     */
    function phone(on) {
      var s = document.body.style, d = document.documentElement.style, k = lock;
      if (on && k && k.p == null && s.position !== 'fixed') holdPage(k, s, d);
      if (on === !!k) return;
      if (on) {
        clearTimeout(vvTimer);
        lock = { y: 0 };
        if (s.position !== 'fixed') holdPage(lock, s, d);
        else if (global.MutationObserver) {
          watch = new MutationObserver(function () { if (lock) phone(true); });
          watch.observe(document.body, { attributes: true, attributeFilter: ['style'] });
        }
        follow(true);
        fit();
        return;
      }
      lock = null;
      unwatch();
      if (k.p != null) {
        s.position = k.p;
        s.top = k.t;
        s.width = k.w;
        s.overflow = k.o;
        d.overscrollBehavior = k.b;
      }
      if (k.y) global.scrollTo(0, k.y);
      // The 260 ms fold starts where the panel stood (above a keyboard too) and follows it down; then the viewport goes.
      clearTimeout(vvTimer);
      vvTimer = setTimeout(unfollow, 300);
    }
    function holdPage(k, s, d) {
      unwatch();
      k.y = global.scrollY || global.pageYOffset || 0;
      k.p = s.position; k.t = s.top; k.w = s.width; k.o = s.overflow; k.b = d.overscrollBehavior;
      s.position = 'fixed';
      s.top = -k.y + 'px';
      s.width = '100%';
      s.overflow = 'hidden';
      d.overscrollBehavior = 'none';
    }
    function unwatch() { if (watch) { watch.disconnect(); watch = null; } }
    /** The visual viewport's resize and scroll, and the window's resize (a rotation; its height without a visual viewport). */
    function follow(on) {
      if (on === vvOn) return;
      vvOn = on;
      var vv = global.visualViewport, how = on ? 'addEventListener' : 'removeEventListener';
      if (vv) { vv[how]('resize', fit); vv[how]('scroll', fit); }
      global[how]('resize', fit);
    }
    function unfollow() {
      clearTimeout(vvTimer);
      follow(false);
      if (panelEl) ['--ccw-vvh', '--ccw-vvt', '--ccw-vvb'].forEach(function (n) { panelEl.style.removeProperty(n); });
    }
    /** The panel on the visual viewport (an on-screen keyboard); the field being typed in stays in view above it. */
    function fit() {
      var vv = global.visualViewport, ih = global.innerHeight, st = panelEl.style;
      var h = Math.round(vv ? vv.height : ih), top = Math.round(vv ? vv.offsetTop : 0);
      st.setProperty('--ccw-vvh', h + 'px');
      st.setProperty('--ccw-vvt', top + 'px');
      st.setProperty('--ccw-vvb', Math.max(0, Math.round(ih) - top - h) + 'px');
      var a = panelEl.getRootNode().activeElement;
      if (a && panelEl.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
    }
    /**
     * Tab stays inside a phone's open panel: past its last control it comes round to the first, before its first
     * to the last (screens not shown are inert). Anywhere else, a heading a screen change focused or the panel
     * itself included, the browser keeps the reading order.
     */
    function trap(e) {
      if (e.key !== 'Tab' || !lock) return;
      var list = [].filter.call(panelEl.querySelectorAll('button,a[href],input,select,textarea,[tabindex]'), function (x) {
        return x.tabIndex >= 0 && !x.disabled && !x.closest('[inert],[hidden]');
      });
      var a = panelEl.getRootNode().activeElement, first = list[0], last = list[list.length - 1];
      if (!a || !first) return;
      // compareDocumentPosition: 2 = `a` comes before (the panel holding them too), 4 = after.
      var to = e.shiftKey ? (a === first || first.compareDocumentPosition(a) & 2 ? last : null)
        : (a === last || last.compareDocumentPosition(a) & 4 ? first : null);
      if (to) { e.preventDefault(); focusOn(to); }
    }

    /** D26: closing an ended screen resets to home after the close. */
    function closed(ctrl) {
      phone(false);
      clearTimeout(closeTimer);
      if (ui.bookingView) { ui.bookingView = false; H.requestRender(); return; }
      var st = ctrl.state;
      if (st !== 'ended' && st !== 'error') return;
      closeTimer = setTimeout(function () {
        if (C.open || C.state !== st) return;
        if (screenId(C) === 'rating' && typeof C.skipRating === 'function') C.skipRating();
        else C.reset();
      }, 420);
    }

    return {
      render: render,
      launcherMini: launcherMini,
      closed: closed,
      destroy: function () {
        phone(false);
        unfollow();
        clearTimeout(closeTimer);
        clearTimeout(copyTimer);
        Object.keys(screens).forEach(function (k) { var s = screens[k]; if (s.el.parentNode) s.el.parentNode.removeChild(s.el); });
        screens = {};
        mini = null;
        if (C) C._waveBars = null;
      },
    };
  }

  global.__ccw_panel = { v: 1, create: create };
})(window);
