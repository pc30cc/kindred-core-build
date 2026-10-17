/**
 * Widget Presentation — the "t2" renderer.
 *
 * A template of the Iranian edition, offered next to `default` (the Super
 * Admin enables it and names it; the id is neutral and never shown).
 * Registered under `window.__gs_presentation_t2` and resolved through
 * `presentation-registry.js`.
 *
 * The look: a home with a tall gradient hero, an ask card overlapping it and
 * a card of quiet rows (no bottom menu); white views with a 68px bar; an
 * operator-side thread with avatars on every run; a two-row composer.
 *
 * CONTRACT (see docs/WIDGET_PRESENTATION_ARCHITECTURE.md)
 *   create(env) -> renderer
 *     env    = { t, escapeHtml, linkifyHtml, linkLabel, config, locale,
 *                primaryColor, capabilities }
 *     render = pure functions: (view-model) -> HTML string
 *
 * Rules for every presentation implementation:
 *   - NEVER touch transport, fetch, realtime, stores or the DOM.
 *   - NEVER read application state directly — everything arrives as a
 *     view-model argument produced by Widget Core.
 *   - Interaction is expressed with behaviour hooks (data-* attributes)
 *     that Core binds; visual classes carry no behavioural meaning.
 *
 * Every hook the `default` renderer emits is emitted here too (hidden where
 * this design draws no control for it). The Core behaviours this renderer
 * opts into are listed in `features` (runtime.js `feat()`); the ones whose
 * backend does not exist yet (`env.capabilities`: rating after a chat,
 * reactions, order card, instant answers, track order) draw nothing.
 */
(function () {
  'use strict';

  // The platform's marks (the hero watermark and the footer glyph) belong to
  // the Iranian edition's build only: the RESPOK build deletes this block, so
  // both stay empty there and nothing is drawn.
  var MARK = '';
  var MARK_DOTS = '';
  /* @iran-kit:begin */
  MARK = 'M42.28 27.95A12.4 12.4 0 0 0 21.7 17.01A12.4 12.4 0 0 0 30.43 38.62A7.75 7.75 0 0 0 22.95 46.14A0.43 0.43 0 0 1 22.56 46.56A21.7 21.7 0 0 0 42.28 27.95Z';
  MARK_DOTS = MARK + 'M35.21 24.12L37.32 26.23L35.21 28.34L33.1 26.23ZM30 24.12L32.11 26.23L30 28.34L27.89 26.23ZM24.79 24.12L26.9 26.23L24.79 28.34L22.69 26.23Z';
  /* @iran-kit:end */

  // Strings this design adds (Core's own keys are read through `t`).
  // fa / en / tr; anything missing falls back to en.
  var DICT = {
    fa: {
      hiBack: 'سلام {name}، خوش برگشتی 👋',
      q: 'چطور می‌توانیم\nکمکتان کنیم؟',
      qAway: 'پیامتان را\nبگذارید',
      on: 'آنلاین هستیم',
      off: 'آفلاین هستیم',
      sep: '، ',
      semi: '؛ ',
      backAt: 'از ساعت {t} پاسخ می‌دهیم',
      am: ' صبح',
      ask: 'سؤالتان را بنویسید…',
      askAway: 'پیامتان را بنویسید…',
      eg: 'مثلاً: ',
      noteAm: 'پاسخ را صبح به ایمیلتان می‌فرستیم',
      note: 'پاسخ را به ایمیلتان می‌فرستیم',
      helpSub: '{n} مقاله درباره {c}',
      helpAway: 'بیشتر پاسخ‌ها همین‌جاست، همیشه در دسترس',
      and: ' و ',
      arts: '{n} مقاله',
      cont: 'ادامه گفتگو با {name}',
      convs: 'گفتگوهای شما',
      convsOne: '{n} گفتگو، یکی باز است',
      convsN: '{n} گفتگو',
      online: 'آنلاین',
      typing: 'در حال نوشتن',
      away: 'آفلاین؛ پاسخ با ایمیل',
      awayT: 'الان آفلاین هستیم',
      team: 'تیم پشتیبانی {w}',
      retry: 'تلاش دوباره',
      delRec: 'حذف ضبط',
      sendVoice: 'ارسال پیام صوتی',
      kb: 'کیلوبایت',
      mb: 'مگابایت',
      clear: 'پاک کردن',
      found: '{n} مقاله پیدا شد',
      topicsT: 'یا از یک موضوع شروع کنید',
      didHelp: 'این مقاله کمک کرد؟',
      no: 'نه',
      partly: 'تا حدی',
      yes: 'بله',
      still: 'هنوز سؤال دارید؟',
      chatTeam: 'با تیم گفتگو کنید',
      read: '{n} دقیقه مطالعه',
      askEmail: 'اگر از سایت رفتید، پاسخ را کجا بفرستیم؟',
      saveEmail: 'ثبت ایمیل',
      skip: 'نه ممنون، همین‌جا منتظر می‌مانم',
      replyTo: 'پاسخ را به {email} می‌فرستیم.',
    },
    en: {
      hiBack: 'Hi {name}, welcome back 👋',
      q: 'How can we\nhelp you?',
      qAway: 'Leave us\na message',
      on: "We're online",
      off: "We're offline",
      sep: ', ',
      semi: '; ',
      backAt: 'we reply from {t}',
      am: '',
      ask: 'Write your question…',
      askAway: 'Write your message…',
      eg: 'e.g. ',
      noteAm: "We'll email you the reply in the morning",
      note: "We'll email you the reply",
      helpSub: '{n} articles about {c}',
      helpAway: 'Most answers are right here, always available',
      and: ' and ',
      arts: '{n} articles',
      cont: 'Continue with {name}',
      convs: 'Your conversations',
      convsOne: '{n} conversations, one open',
      convsN: '{n} conversations',
      online: 'Online',
      typing: 'Typing',
      away: "Offline; we'll reply by email",
      awayT: "We're offline right now",
      team: '{w} support team',
      retry: 'Try again',
      delRec: 'Delete recording',
      sendVoice: 'Send voice message',
      kb: 'KB',
      mb: 'MB',
      clear: 'Clear',
      found: '{n} articles found',
      topicsT: 'Or start from a topic',
      didHelp: 'Did this article help?',
      no: 'No',
      partly: 'Partly',
      yes: 'Yes',
      still: 'Still have a question?',
      chatTeam: 'Chat with the team',
      read: '{n} min read',
      askEmail: 'If you leave the site, where should we send the reply?',
      saveEmail: 'Save email',
      skip: "No thanks, I'll wait here",
      replyTo: "We'll send the reply to {email}.",
    },
    tr: {
      hiBack: 'Merhaba {name}, tekrar hoş geldin 👋',
      q: 'Size nasıl\nyardımcı olabiliriz?',
      qAway: 'Bize bir\nmesaj bırakın',
      on: 'Çevrimiçiyiz',
      off: 'Çevrimdışıyız',
      backAt: '{t} itibarıyla yanıtlıyoruz',
      ask: 'Sorunuzu yazın…',
      askAway: 'Mesajınızı yazın…',
      eg: 'Örn. ',
      noteAm: 'Yanıtı sabah e-postanıza göndeririz',
      note: 'Yanıtı e-postanıza göndeririz',
      helpSub: '{c} hakkında {n} makale',
      helpAway: 'Çoğu yanıt burada, her zaman erişilebilir',
      and: ' ve ',
      arts: '{n} makale',
      cont: '{name} ile devam et',
      convs: 'Sohbetleriniz',
      convsOne: '{n} sohbet, biri açık',
      convsN: '{n} sohbet',
      online: 'Çevrimiçi',
      typing: 'Yazıyor',
      away: 'Çevrimdışı; e-postayla yanıtlarız',
      awayT: 'Şu anda çevrimdışıyız',
      team: '{w} destek ekibi',
      retry: 'Tekrar dene',
      delRec: 'Kaydı sil',
      sendVoice: 'Sesli mesajı gönder',
      clear: 'Temizle',
      found: '{n} makale bulundu',
      topicsT: 'Ya da bir konudan başlayın',
      didHelp: 'Bu makale yardımcı oldu mu?',
      no: 'Hayır',
      partly: 'Kısmen',
      yes: 'Evet',
      still: 'Hâlâ sorunuz mu var?',
      chatTeam: 'Ekiple sohbet edin',
      read: '{n} dk okuma',
      askEmail: 'Siteden ayrılırsanız yanıtı nereye gönderelim?',
      saveEmail: 'E-postayı kaydet',
      skip: 'Hayır teşekkürler, burada beklerim',
      replyTo: 'Yanıtı {email} adresine göndereceğiz.',
    },
  };

  // Icons: inner SVG markup on a 24px grid (see ico()). Chevrons are drawn
  // left-to-right and mirrored in RTL by the stylesheet (`.dirf`).
  function P(d) { return '<path d="' + d + '"/>'; }
  var EYES = '<path d="M9 10h.01M15 10h.01" stroke-width="2.6"/>';
  var CIRCLE = '<circle cx="12" cy="12" r="8.5"/>';
  var I = {
    x: P('M6 6l12 12M18 6 6 18'),
    back: P('m14 6-6 6 6 6'),
    fwd: P('m10 6 6 6-6 6'),
    send: P('M12 19V5M5.5 11.5L12 5l6.5 6.5'),
    mic: '<rect x="8.5" y="2.5" width="7" height="12.5" rx="3.5" fill="currentColor" stroke="none"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke-width="2"/>',
    emoji: CIRCLE + P('M8.5 14.2c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8') + '<path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.6"/>',
    clip: P('M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.6 7.6a1.7 1.7 0 0 1-2.4-2.4l7-7'),
    trash: P('M4.5 7h15M9.5 7V5.25c0-.7.55-1.25 1.25-1.25h2.5c.7 0 1.25.55 1.25 1.25V7M6.5 7l.9 12.2A1.9 1.9 0 0 0 9.3 21h5.4a1.9 1.9 0 0 0 1.9-1.8L17.5 7'),
    book: P('M12 6.6C10.5 5.4 8.4 4.75 6 4.75c-.97 0-1.75.78-1.75 1.75v10.25c0 .97.78 1.75 1.75 1.75 2.4 0 4.5.65 6 1.85 1.5-1.2 3.6-1.85 6-1.85.97 0 1.75-.78 1.75-1.75V6.5c0-.97-.78-1.75-1.75-1.75-2.4 0-4.5.65-6 1.85Z') + P('M12 6.6v13.5'),
    box: P('M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z') + P('M3.5 7.5 12 12l8.5-4.5M12 12v9'),
    chat: P('M14.5 9.5h3.25A2.75 2.75 0 0 1 20.5 12.25v3.5a2.75 2.75 0 0 1-2.1 2.67V20.5l-2.65-1.9H12.5a2.75 2.75 0 0 1-2.75-2.75v-.6') + P('M6.25 4.5h6.5A2.75 2.75 0 0 1 15.5 7.25v4.5a2.75 2.75 0 0 1-2.75 2.75H8.4L5.6 16.6v-2.2a2.75 2.75 0 0 1-2.1-2.67V7.25A2.75 2.75 0 0 1 6.25 4.5z'),
    truck: P('M2.75 6.75h11v9.5h-11zM13.75 10h4l3.5 3.5v2.75h-7.5') + '<circle cx="7" cy="17.75" r="1.75"/><circle cx="17.25" cy="17.75" r="1.75"/>',
    return: P('M9 14 4 9l5-5') + P('M4 9h10.5a5.5 5.5 0 0 1 0 11H11'),
    ruler: P('M3.5 16.5 16.5 3.5l4 4-13 13z') + P('M7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2'),
    card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/>' + P('M3 10h18M7 15h3'),
    clock: CIRCLE + P('M12 7.5V12l3 2'),
    help: CIRCLE + P('M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.7M12 17h.01'),
    gift: '<rect x="4" y="9.5" width="16" height="10.5" rx="1.5"/>' + P('M3 9.5h18M12 9.5V20M12 9.5C10.5 6 6.5 5.3 6.5 7.7s3.4 1.8 5.5 1.8c2.1 0 5.5.6 5.5-1.8S13.5 6 12 9.5'),
    tag: P('M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8a1.4 1.4 0 0 1 0 2l-7 7a1.4 1.4 0 0 1-2 0z') + '<circle cx="8" cy="8" r="1.5"/>',
    person: '<circle cx="12" cy="8.5" r="3.8"/>' + P('M4.5 20c.9-3.6 3.9-5.5 7.5-5.5s6.6 1.9 7.5 5.5'),
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/>' + P('m4.5 7.5 7.5 5.5 7.5-5.5'),
    search: '<circle cx="11" cy="11" r="6.5"/>' + P('m20 20-4.2-4.2'),
    tick: P('m5 12.5 4 4 10-10'),
    ticks: P('m2.5 12.5 4 4 8-9M10.5 15.5l1 1 8-9'),
    err: CIRCLE + P('M12 8v4.5M12 16h.01'),
    img: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/>' + P('m20.5 16-5-5-8.5 8.5'),
    dl: P('M12 4v11M7 10l5 5 5-5M5 19.5h14'),
    plus: P('M12 5v14M5 12h14'),
    moon: P('M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'),
    sad: CIRCLE + EYES + P('M8.5 16.4c1-1.1 2.2-1.7 3.5-1.7s2.5.6 3.5 1.7'),
    meh: CIRCLE + EYES + P('M9 15.2h6'),
    happy: CIRCLE + EYES + '<path d="M8.4 13.6c.9 1.7 2.1 2.6 3.6 2.6s2.7-.9 3.6-2.6z" fill="currentColor"/>',
    quote: P('M9 17l-5-5 5-5') + P('M4 12h10a5 5 0 0 1 5 5v2'),
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/>' + P('M5 15V5a2 2 0 0 1 2-2h8'),
    retry: P('M21 12a9 9 0 1 1-3.1-6.8') + P('M21 4v5h-5'),
    doc: P('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z') + P('M14 3v5h5'),
    play: '<path d="M8 5.2v13.6a1 1 0 0 0 1.53.85l10.6-6.8a1 1 0 0 0 0-1.7L9.53 4.35A1 1 0 0 0 8 5.2Z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
    down: P('M12 5v14M19 12l-7 7-7-7'),
    video: P('m23 7-7 5 7 5z') + '<rect x="1" y="5" width="15" height="14" rx="2"/>',
    phone: P('M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z'),
  };
  // The topic and category icons a workspace may pick (the settings'
  // allow-list); anything else draws the book.
  var TOPIC_ICONS = { truck: 1, return: 1, ruler: 1, card: 1, box: 1, chat: 1, help: 1, gift: 1, clock: 1, tag: 1, person: 1 };
  // A voice note's waveform (the design's fixed shape, in px).
  var WAVE = [8, 10, 10, 6, 20, 22, 12, 16, 18, 8, 14, 7, 16, 20, 10, 14, 18, 6, 12, 12, 12, 8, 9, 24];
  var INK = '#16142B';

  function ico(name, size, sw, cls) {
    return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      I[name] + '</svg>';
  }

  /** #rgb / #rrggbb -> [r, g, b], else null. */
  function rgbOf(hex) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var s = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return [0, 2, 4].map(function (i) { return parseInt(s.substr(i, 2), 16); });
  }
  /** WCAG relative luminance. */
  function lum(rgb) {
    var c = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  /**
   * The accent tokens as inline custom properties: `--a` (the workspace
   * colour), `--on-a` (white unless Ink reads better on it) and Core's
   * `--gs-primary` (its focus ring). An uncustomised colour (empty, the
   * seeded #3B82F6) or the brand's own #0B7D6C wears the brand look, with
   * its hand-tuned hero stops. Derived shades come from the stylesheet.
   */
  function accentTokens(primary) {
    var raw = String(primary || '').trim().toLowerCase();
    var rgb = rgbOf(raw);
    var brand = !rgb || raw === '#3b82f6' || raw === '#0b7d6c';
    if (brand) rgb = [11, 125, 108];
    var a = brand ? '#0B7D6C' : '#' + rgb.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('').toUpperCase();
    var l = lum(rgb);
    var onA = 1.05 / (l + 0.05) >= (l + 0.05) / (lum(rgbOf(INK)) + 0.05) ? '#FFFFFF' : INK;
    return '--a:' + a + ';--on-a:' + onA + ';--gs-primary:' + a +
      (brand ? ';--h1:#22C4A6;--h2:#0F927D;--h3:#08594E;--glow:#7CF5DF' : '');
  }

  function create(env) {
    env = env || {};
    var t = env.t || function (k) { return k; };
    var config = env.config || {};
    var caps = env.capabilities || {};
    var workspaceName = String(config.workspaceName || config.brandName || '');
    var Util = {
      // Core always supplies this; the fallback still escapes (including
      // quotes, since output lands inside "…" attributes) so a template
      // mounted without it can never emit raw markup.
      escapeHtml: env.escapeHtml || function (v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      },
      // Core supplies this; without it nothing is linked (the scheme
      // allow-list lives in exactly one place, Core).
      linkifyHtml: env.linkifyHtml || null,
    };
    var linkLabel = env.linkLabel || null;
    var ctx = {
      config: config,
      locale: env.locale,
      primaryColor: env.primaryColor,
    };
    var lang = String(ctx.locale || 'en').toLowerCase().split('-')[0];
    var D = DICT[lang] || DICT.en;
    var ACC = ' style="' + accentTokens(env.primaryColor) + '"';
    var team = (Array.isArray(config.teamMembers) ? config.teamMembers : []).filter(function (m) {
      return m && (m.name || m.full_name);
    });
    var showTeam = config.showTeamAvatars !== false;

    function esc(v) { return Util.escapeHtml(v); }
    /** Escaped message text, with ordinary web links made clickable. */
    function escLinked(v) {
      return Util.linkifyHtml
        ? Util.linkifyHtml(v, linkLabel || tf('msgOpenLink', 'Open link'))
        : Util.escapeHtml(v);
    }
    function isRtl() { return lang === 'fa'; }
    // Whether a platform-wide text is written in the widget's language:
    // Persian script for fa, no Persian script for the other languages.
    function textFitsLocale(text) {
      return /[؀-ۿ]/.test(String(text)) === isRtl();
    }
    function tf(key, fallback) {
      var v = t(key);
      return (v && v !== key) ? v : fallback;
    }
    /** This design's own copy, `{name}` placeholders filled with plain text. */
    function L(key, vars) {
      var s = D[key] != null ? D[key] : (DICT.en[key] || '');
      for (var k in vars || {}) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) s = s.split('{' + k + '}').join(String(vars[k]));
      }
      return s;
    }
    /** Persian digits in fa, as every number this design prints. */
    function digits(s) {
      s = String(s);
      return lang === 'fa' ? s.replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'.charAt(+d); }) : s;
    }
    function dirAttr(rtl) { return ' dir="' + (rtl ? 'rtl' : 'ltr') + '"'; }
    function viewOpen(cls, rtl, extra) {
      return '<div class="wy-view ' + cls + '"' + dirAttr(rtl) + ACC + (extra || '') + '>';
    }

    // ── People and the workspace ──────────────────────────────────────
    /** First letter of a name (a whole code point, never half a pair). */
    function initialOf(name) {
      var s = String(name || '').trim();
      return s ? Array.from(s)[0].toUpperCase() : '';
    }
    /** A person's tile colour (c1..c3), stable for a name on every surface. */
    function tone(name) {
      var h = 0;
      Array.from(String(name || '')).forEach(function (c) { h = (h * 19 + c.codePointAt(0)) % 9973; });
      return 'c' + ((h + 1) % 3 + 1);
    }
    /** An image address worth drawing: web, protocol-relative, same-origin or blob. */
    function safeSrc(u) {
      u = String(u || '').trim();
      return /^(https?:)?\/\/[^\s]/i.test(u) || /^\/[^/\\]/.test(u) || /^blob:/i.test(u) ? u : '';
    }
    function imgTag(src, alt) {
      return '<img src="' + esc(src) + '" alt="' + esc(alt || '') + '" loading="lazy" decoding="async">';
    }
    /**
     * One round person tile: the photo when there is one, else the initial
     * on the person's colour. `pr` adds the presence dot ('on' | 'off').
     */
    function avatarHtml(name, photo, size, opts) {
      opts = opts || {};
      var src = safeSrc(photo);
      return '<span class="av s' + size + ' ' + (opts.tone || tone(name)) + (opts.cls ? ' ' + opts.cls : '') +
        (src ? ' has-img' : '') + '" aria-hidden="true">' +
        (src ? imgTag(src) : esc(initialOf(name))) +
        (opts.pr ? '<span class="pr' + (opts.pr === 'off' ? ' off' : '') + '"></span>' : '') +
      '</span>';
    }
    function workspaceLogo() {
      return config.showLogo === false ? '' : safeSrc(config.logoUrl);
    }
    /** The workspace where it speaks in a round slot: its logo, else its initial on the reserved tile. */
    function storeAvatarHtml(size, pr, cls) {
      return avatarHtml(workspaceName, workspaceLogo(), size, { tone: 'c4', pr: pr, cls: cls });
    }
    /** Up to three team members, overlapping; neighbours never share a colour. */
    function stackHtml(size) {
      if (!showTeam) return '';
      var used = {};
      var html = team.slice(0, 3).map(function (m) {
        var name = m.name || m.full_name;
        var n = +tone(name).charAt(1);
        for (var k = 0; k < 3 && used[n]; k++) n = n % 3 + 1;
        used[n] = 1;
        return avatarHtml(name, m.avatar || m.avatar_url, size, { tone: 'c' + n });
      }).join('');
      return html ? '<span class="avs" aria-hidden="true">' + html + '</span>' : '';
    }
    function markSvg(cls, d) {
      return d ? '<svg class="' + cls + '" viewBox="17 13.5 26 33.5" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="' + d + '"/></svg>' : '';
    }

    // ── Shared chrome ─────────────────────────────────────────────────
    function backButtonHtml(target) {
      return '<button type="button" class="wy-back ib" data-view-back="' +
        (target === 'back' ? 'back" data-view-back-fallback="home' : esc(target || 'home')) +
        '" aria-label="' + esc(tf('back', 'Back')) + '">' + ico('back', 20, 2, 'dirf') + '</button>';
    }
    /** A view's top bar; the empty `.cs` slot is where the panel's close button lands. */
    function barHtml(inner, extra) {
      return '<div class="wy-head bar">' + inner + '<span class="cs" aria-hidden="true"></span>' + (extra || '') + '</div>';
    }
    function titleBarHtml(title, back) {
      return barHtml(backButtonHtml(back || 'home') + '<h2 class="ttl">' + esc(title) + '</h2>');
    }
    function whoHtml(avatar, name, status) {
      return '<span class="who">' + avatar + '<span class="wt"><span class="nm">' + esc(name) + '</span>' +
        (status || '') + '</span></span>';
    }

    function footerHtml() {
      // The footer credits the PLATFORM, never the workspace brand. Wording,
      // brand label and outbound link are platform-admin owned and arrive as
      // `config.poweredBy` ({ text, brand, url }); plans decide visibility, so
      // an absent payload means "do not render".
      var pb = config.poweredBy || null;
      if (config.showPoweredBy === false) return '';
      var platform = (pb && pb.brand) || config.platformName || '';
      if (!platform) return '';
      var label = (pb && pb.text && textFitsLocale(pb.text)) ? pb.text : tf('poweredBy', 'Powered by');
      var url = (pb && pb.url) || '';
      // A platform logo in the name's place (config.poweredBy.logo); Core
      // swaps it back to the name if it cannot load ([data-wy-brand-logo]).
      var logo = pb && typeof pb.logo === 'string' && /^https?:\/\//i.test(pb.logo) ? pb.logo : '';
      var inner = logo
        ? '<span>' + esc(label) + '</span><img class="wy-powered-logo" data-wy-brand-logo src="' + esc(logo) +
          '" alt="' + esc(platform) + '" decoding="async" draggable="false">'
        : markSvg('wm', MARK_DOTS) + '<span>' + esc(label) + '</span><b>' + esc(platform) + '</b>';
      // A native link (nofollow, noopener, strict-origin referrer) only with
      // a URL; the connection dot is a sibling, never part of the link.
      var body = url
        ? '<a class="wy-powered" href="' + esc(url) + '" target="_blank" rel="noopener nofollow" referrerpolicy="strict-origin-when-cross-origin">' + inner + '</a>'
        : '<span class="wy-powered">' + inner + '</span>';
      return '<div class="wy-footer pw">' + connIndicatorHtml() + body + '</div>';
    }

    /** The post-mount connection affordance; Core writes `data-conn-state` on the panel. */
    function connIndicatorHtml() {
      return '<span class="wy-conn" data-conn-indicator aria-hidden="true">' +
        '<span class="wy-conn-ring"></span>' +
        '<span class="wy-conn-dot"></span>' +
      '</span>';
    }

    /**
     * Reply-time note. Workspace-configurable (config.replyTimeText; an
     * explicit '' hides it), else the locale default for the availability.
     */
    function replyTimeText(online) {
      if (typeof config.replyTimeText === 'string') return config.replyTimeText.trim();
      return online === false ? tf('homeReplySlow', '') : tf('homeReplyFast', '');
    }
    function nextOpen() {
      var iso = config.availability && config.availability.next_open_at;
      var d = iso ? new Date(iso) : null;
      return d && !isNaN(d.getTime()) ? d : null;
    }
    /** "9 am"-style time the team is back, in the visitor's clock. */
    function backAtTime(d) {
      try {
        var tag = lang === 'fa' ? 'fa-IR' : lang === 'tr' ? 'tr-TR' : 'en-US';
        var opts = lang === 'tr' ? { hour: '2-digit', minute: '2-digit' } : { hour: 'numeric' };
        if (lang !== 'tr' && d.getMinutes()) opts.minute = '2-digit';
        return new Intl.DateTimeFormat(tag, opts).format(d) + (d.getHours() < 12 ? L('am') : '');
      } catch (_) { return ''; }
    }
    /** The away line: when the team is back, else the reply-time text. */
    function awayLine() {
      var d = nextOpen();
      var at = d ? backAtTime(d) : '';
      var rest = at ? L('backAt', { t: at }) : replyTimeText(false);
      return L('off') + (rest ? L('sep') + rest : '');
    }

    // ══════════════════════════════════════════════════════════════════
    // Chat surfaces
    // ══════════════════════════════════════════════════════════════════

    function teamOnline() {
      var av = config.availability;
      return !(av && av.state === 'offline');
    }

    function chipHtml(attr, value, icon, label) {
      return '<button type="button" class="chip" ' + attr + '="' + esc(value) + '">' +
        ico(TOPIC_ICONS[icon] ? icon : 'book', 16, 1.8) + '<span>' + esc(label) + '</span></button>';
    }
    /** The workspace's topics (templateOptions.topics), as chips. */
    function topicChipsHtml() {
      var opts = config.templateOptions || {};
      return (Array.isArray(opts.topics) ? opts.topics : []).slice(0, 4).map(function (tp) {
        var label = String((tp && tp.label) || '').trim();
        return label ? chipHtml('data-topic', label, tp.icon, label) : '';
      }).join('');
    }

    /**
     * An empty thread: the team's welcome block, the welcome bubble from the
     * first team member, and the topics (or the workspace's Q&A) as chips.
     */
    function emptyHtml(vm) {
      vm = vm || {};
      var tail = (vm.prechatSummaryHtml || '') + (vm.operatorTyping ? typingRowHtml(vm.operatorTyping) : '');
      var ai = config.aiAgent;
      if (ai && ai.suppressGreeting === true) {
        return '<div class="messages welcome-only">' + tail + '</div>';
      }
      var welcome = (typeof config.welcomeMessage === 'string' && config.welcomeMessage.trim().length > 0)
        ? config.welcomeMessage
        : t('intro');
      var lines = String(welcome).split(/\n+/).map(function (l) { return esc(l); }).join('<br>');
      var online = teamOnline();
      var first = team[0];
      var chips = topicChipsHtml();
      return '<div class="messages welcome-only">' +
        '<div class="welc">' + stackHtml(40) +
          (workspaceName ? '<h3>' + esc(L('team', { w: workspaceName })) + '</h3>' : '') +
          '<p' + (online ? '' : ' class="off"') + '><i></i>' + esc(online ? L('on') : L('away')) + '</p>' +
        '</div>' +
        '<div class="msg-row operator is-last is-first">' +
          (first ? avatarHtml(first.name || first.full_name, first.avatar || first.avatar_url, 28, { cls: 'msg-avatar' })
            : storeAvatarHtml(28, '', 'msg-avatar')) +
          '<div class="msg-col"><div class="msg-line"><div class="msg operator welcome-bubble">' + lines + '</div></div></div>' +
        '</div>' +
        (chips ? '<div class="qr">' + chips + '</div>'
          : (vm.qna && vm.qna.questions && vm.qna.questions.length ? qnaChipsHtml(vm.qna) : '')) +
        tail +
      '</div>';
    }

    function qnaChipsHtml(qnaState) {
      qnaState = qnaState || {};
      var collapsed = qnaState.collapsedCount || 3;
      var all = qnaState.questions || [];
      var visible = qnaState.expanded ? all : all.slice(0, collapsed);
      var remaining = all.length - visible.length;
      var chipsHtml = visible.map(function (q) {
        var text = (q && q.question) ? String(q.question) : '';
        return text ? '<button type="button" class="qna-chip chip" data-qna-question="' + esc(text) + '">' +
          ico('chat', 16, 1.8) + '<span>' + esc(text) + '</span></button>' : '';
      }).join('');
      var moreHtml = (!qnaState.expanded && remaining > 0)
        ? '<button type="button" class="qna-more-btn chip" data-qna-more aria-label="' + esc(t('qnaMore')) + '">' +
            '<span class="qna-more-count">+' + esc(fmtNum(remaining)) + '</span></button>'
        : '';
      return '<div class="qna-suggestions qr" data-qna>' +
        '<span class="qna-title sr-only">' + esc(t('qnaTitle')) + '</span>' + chipsHtml + moreHtml +
      '</div>';
    }

    /** File sizes in the visitor's digits and words (۲۴۰ کیلوبایت). */
    function humanSize(bytes) {
      var n = Number(bytes) || 0;
      var mb = n >= 1048576;
      var v = mb ? Math.round(n / 104857.6) / 10 : Math.max(1, Math.round(n / 1024));
      return fmtNum(v) + ' ' + L(mb ? 'mb' : 'kb');
    }
    /** m:ss in the visitor's digits (voice notes, the recorder). */
    function clock(sec) {
      sec = Math.max(0, Math.floor(Number(sec) || 0));
      var s = sec % 60;
      return digits(Math.floor(sec / 60) + ':' + (s < 10 ? '0' : '') + s);
    }
    function waveHtml() {
      return WAVE.map(function (h) { return '<i style="height:' + h + 'px"></i>'; }).join('');
    }

    // Real attachments — authenticated media is loaded by Core through the
    // data-att-media-src / data-att-download hooks. No demo placeholders.
    function renderMessageAttachment(att) {
      if (!att || !att.id) return '';
      var id = esc(att.id);
      var raw = String(att.file_name || 'file');
      var name = esc(raw);
      var isImage = att.kind === 'image' || (att.mime_type && /^image\//.test(att.mime_type));
      var isAudio = att.kind === 'audio' || (att.mime_type && /^audio\//.test(att.mime_type));
      if (isImage) {
        // `is-loading` shows a spinner + "Receiving…" until Core finishes the
        // authenticated fetch, so the bubble is never blank.
        return '<div class="msg-att msg-att-image">' +
          '<button type="button" class="msg-att-img-btn is-loading" data-att-preview="' + id + '" aria-label="' + esc(t('openFile')) + '">' +
            '<span class="msg-att-loading" aria-live="polite">' +
              '<span class="msg-att-spinner" aria-hidden="true"></span>' +
              '<span class="msg-att-loading-text">' + esc(tf('receivingFile', 'Receiving…')) + '</span>' +
            '</span>' +
            '<img loading="lazy" decoding="async" data-att-media-src="' + id + '" alt="' + name + '" />' +
            '<span class="msg-att-img-fallback">' + esc(t('imageUnavailable')) + '</span>' +
            '<span class="cap" aria-hidden="true">' + ico('img', 13, 2) + '<bdi>' + name + '</bdi></span>' +
          '</button>' +
        '</div>';
      }
      if (isAudio) {
        // Only the timeline runs left→right in every locale; the play button
        // sits at the start of the reading direction. The played share of the
        // wave is the progress layer Core sizes ([data-audio-progress]).
        return '<div class="msg-att msg-att-audio" data-audio-player>' +
          '<audio preload="metadata" data-att-media-src="' + id + '" data-audio-el></audio>' +
          '<button type="button" class="wy-ap-play" data-audio-toggle aria-label="' + esc(t('playAudio')) + '">' +
            '<span class="wy-ap-ico wy-ap-ico-play">' + ico('play', 15, 0) + '</span>' +
            '<span class="wy-ap-ico wy-ap-ico-pause">' + ico('pause', 15, 0) + '</span>' +
            '<span class="wy-ap-spinner" aria-hidden="true"></span>' +
          '</button>' +
          '<div class="wy-ap-track" data-audio-seek dir="ltr">' + waveHtml() +
            '<div class="wy-ap-buffer" data-audio-buffer></div>' +
            '<div class="wy-ap-progress" data-audio-progress><span class="wy-ap-played">' + waveHtml() + '</span><span class="wy-ap-knob"></span></div>' +
          '</div>' +
          '<span class="wy-ap-time" data-audio-time>' + clock(0) + '</span>' +
          '<button type="button" class="wy-ap-rate" data-audio-rate hidden>1×</button>' +
          '<a class="wy-ap-dl" href="#" data-att-download="' + id + '" data-att-download-name="' + name +
            '" aria-label="' + esc(t('download')) + '" hidden>' + ico('dl', 15, 1.9) + '</a>' +
        '</div>';
      }
      var dot = raw.lastIndexOf('.');
      var ext = dot > 0 ? raw.slice(dot + 1, dot + 5).toUpperCase() : '';
      return '<div class="msg-att msg-att-file">' +
        '<div class="msg-att-icon" aria-hidden="true">' + (ext ? esc(ext) : ico('doc', 18, 1.7)) + '</div>' +
        '<div class="msg-att-meta">' +
          '<div class="msg-att-name" title="' + name + '">' + name + '</div>' +
          '<div class="msg-att-sub">' + esc(humanSize(att.size_bytes)) + '</div>' +
        '</div>' +
        '<a class="msg-att-action" href="#" data-att-download="' + id + '" data-att-download-name="' + name +
          '" aria-label="' + esc(tf('download', 'Download') + ' ' + raw) + '">' + ico('dl', 16, 2) + '</a>' +
      '</div>';
    }

    // Call cards and system rows. Core supplies every key in every language.
    function fmtInvitationRemaining(expiresAtIso) {
      var ms = new Date(expiresAtIso).getTime() - Date.now();
      if (!isFinite(ms) || ms <= 0) return t('ciStateExpired');
      var total = Math.ceil(ms / 1000);
      var m = Math.floor(total / 60);
      var s = total % 60;
      var time = total < 60 ? t('ciSeconds').replace('{s}', total)
        : s ? t('ciMinutesSeconds').replace('{m}', m).replace('{s}', s)
        : t('ciMinutes').replace('{m}', m);
      return t('ciTimeLeft').replace('{time}', time);
    }

    function fmtCallDuration(seconds) {
      var s = Math.max(0, Math.floor(Number(seconds) || 0));
      var hh = Math.floor(s / 3600);
      function pad(n) { return n < 10 ? '0' + n : '' + n; }
      return (hh > 0 ? pad(hh) + ':' : '') + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
    }

    /** A system line (a call ended, someone joined): text between two rules. */
    function systemPillHtml(icon, text) {
      return '<div class="msg-row system"><div class="msg-system-pill">' + icon +
        '<span>' + esc(text) + '</span></div></div>';
    }

    function renderCallEndedRow(msg) {
      var meta = msg.metadata || {};
      var by = String(meta.ended_by || 'system');
      var dur = Number(meta.duration_seconds) || 0;
      var key = String(meta.end_reason || '') === 'failed' || dur <= 0 ? 'csEndedNotConnected'
        : by === 'operator' ? 'csEndedByOperator'
        : by === 'visitor' ? 'csEndedByVisitor'
        : 'csEndedBySystem';
      return systemPillHtml('', String(t(key)).replace('{duration}', fmtCallDuration(dur)));
    }

    function renderRoutingOutcomeRow(msg) {
      var meta = msg.metadata || {};
      var kind = meta.kind;
      var text;
      // A transfer between operators is, from here, simply the next person
      // arriving — so it reads as a join, naming whoever now holds it.
      if (kind === 'conversation_transferred' || kind === 'routing_agent_joined') {
        var name = String(meta.agent_name || meta.to_name || '');
        var raw = t('routingAgentJoined');
        text = name
          ? (raw && raw !== 'routingAgentJoined' ? String(raw).replace('{name}', name) : name + ' ' + t('routingAgentJoinedSuffix'))
          : t('routingAgentJoinedGeneric');
      } else {
        text = t(kind === 'routing_no_agent_available' ? 'routingNoAgentAvailable' : 'routingInQueue');
      }
      return systemPillHtml('', text);
    }

    function renderCallInvitationCard(msg) {
      var meta = msg.metadata || {};
      var video = meta.channel === 'video';
      var channel = video ? 'video' : 'audio';
      var status = meta.status || 'pending';
      var inviteId = esc(meta.invitation_id || '');
      var op = meta.operator_name ? String(meta.operator_name) : '';
      var headline = String(t('ciHeadline' + (video ? 'Video' : 'Audio') + (op ? 'From' : ''))).replace('{op}', op);
      var statusBlock;
      var actionBlock = '';
      var bodyBlock = '';
      if (status === 'pending') {
        var waitMinutes = (typeof meta.wait_minutes === 'number' && isFinite(meta.wait_minutes) && meta.wait_minutes > 0)
          ? Math.round(meta.wait_minutes) : 0;
        if (!waitMinutes && meta.expires_at) {
          var deltaMs = new Date(meta.expires_at).getTime() - new Date(msg.createdAt || Date.now()).getTime();
          if (isFinite(deltaMs) && deltaMs > 0) waitMinutes = Math.max(1, Math.round(deltaMs / 60000));
        }
        var waitLine = waitMinutes === 1 ? t('ciWaitOneMinute')
          : waitMinutes > 1 ? String(t('ciWaitMinutes')).replace('{m}', waitMinutes) : '';
        bodyBlock = '<div class="ci-body"><div>' + esc(t(video ? 'ciBodyVideo' : 'ciBodyAudio')) + '</div>' +
          (waitLine ? '<div class="ci-wait">' + esc(waitLine) + '</div>' : '') + '</div>';
        statusBlock = '<div class="ci-meta ci-countdown" aria-live="polite">' +
          '<span class="ci-pulse" aria-hidden="true"></span>' + esc(fmtInvitationRemaining(meta.expires_at)) + '</div>';
        actionBlock = '<div class="ci-actions">' +
          '<button type="button" class="ci-btn ci-btn-primary" data-ci-action="join" data-ci-id="' + inviteId +
            '" data-ci-channel="' + channel + '" aria-label="' + esc(t(video ? 'ciAriaJoinVideo' : 'ciAriaJoinAudio')) + '">' +
            esc(t(video ? 'ciJoinVideo' : 'ciJoinAudio')) + '</button>' +
          '<button type="button" class="ci-btn ci-btn-ghost" data-ci-action="decline" data-ci-id="' + inviteId +
            '" aria-label="' + esc(t('ciAriaDecline')) + '">' + esc(t('ciDecline')) + '</button>' +
        '</div>';
      } else {
        var stateKey = { joined: 'ciStateJoined', expired: 'ciStateExpired', cancelled: 'ciStateCancelled', declined: 'ciStateDeclined' }[status];
        statusBlock = '<div class="ci-meta ci-status ci-status-' + esc(status) + '">' + esc(stateKey ? t(stateKey) : '') + '</div>';
      }
      return '<div class="msg-row system">' +
        '<div class="ci-card ci-channel-' + channel + ' ci-status-' + esc(status) +
          '" data-ci-card="' + inviteId + '" role="group" aria-label="' +
          esc(t('ciAriaCard') + ' — ' + t(video ? 'videoCall' : 'voiceCall')) + '">' +
          '<div class="ci-row">' +
            '<span class="ci-icon" aria-hidden="true">' + ico(video ? 'video' : 'phone', 20, 2) + '</span>' +
            '<div class="ci-text">' +
              '<div class="ci-title">' + esc(headline) + '</div>' + bodyBlock + statusBlock +
            '</div>' +
          '</div>' + actionBlock +
        '</div>' +
      '</div>';
    }

    /** Locale-aware digits (Persian numerals for fa). */
    function fmtNum(n) {
      try {
        var tag = lang === 'fa' ? 'fa-IR' : lang === 'tr' ? 'tr-TR' : 'en-US';
        return new Intl.NumberFormat(tag).format(Number(n) || 0);
      } catch (_) { return digits(n); }
    }

    function formatMsgTime(d) {
      try {
        var date = (d instanceof Date) ? d : new Date(d);
        if (!date || isNaN(date.getTime())) return '';
        return date.toLocaleTimeString(ctx.locale || undefined, { hour: '2-digit', minute: '2-digit' });
      } catch (_) { return ''; }
    }

    // Day dividers: Persian is the Jalali calendar in Tehran time unless the
    // bootstrap says Gregorian (config.calendar / config.timeZone).
    function persianGregorian() {
      return config.calendar === 'gregorian';
    }
    function persianTimeZone() {
      if (!persianGregorian()) return 'Asia/Tehran';
      var tz = config.timeZone;
      return typeof tz === 'string' && tz ? tz : undefined;
    }
    function dateLocaleTag() {
      if (lang === 'fa') return persianGregorian() ? 'fa-IR-u-ca-gregory' : 'fa-IR-u-ca-persian';
      return lang === 'tr' ? 'tr-TR' : 'en-US';
    }
    function dayKeyOf(d) {
      var date = (d instanceof Date) ? d : new Date(d);
      if (!date || isNaN(date.getTime())) return '';
      try {
        return new Intl.DateTimeFormat('en-CA', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          timeZone: lang === 'fa' ? persianTimeZone() : undefined,
        }).format(date);
      } catch (_) { return date.toDateString(); }
    }
    function dayLabelOf(d) {
      var date = (d instanceof Date) ? d : new Date(d);
      if (!date || isNaN(date.getTime())) return '';
      var key = dayKeyOf(date);
      var now = new Date();
      if (key === dayKeyOf(now)) return lang === 'fa' ? 'امروز' : lang === 'tr' ? 'Bugün' : 'Today';
      if (key === dayKeyOf(new Date(now.getTime() - 86400000))) {
        return lang === 'fa' ? 'دیروز' : lang === 'tr' ? 'Dün' : 'Yesterday';
      }
      try {
        var opts = { year: 'numeric', month: 'long', day: 'numeric' };
        if (lang === 'fa' && persianTimeZone()) opts.timeZone = persianTimeZone();
        return new Intl.DateTimeFormat(dateLocaleTag(), opts).format(date);
      } catch (_) { return key; }
    }
    function dayDividerHtml(d) {
      var label = dayLabelOf(d);
      return label ? '<div class="msg-day"><span>' + esc(label) + '</span></div>' : '';
    }

    // Field visibility/required state is server-authoritative (identity).
    // `tail` sits inside the control (the in-thread card's submit).
    function renderPrechatFieldRow(identity, key, type, value, tail, prefix) {
      var label = t(key);
      var ph = t('prechat' + key.charAt(0).toUpperCase() + key.slice(1) + 'Ph') || label;
      var req = identity.isRequired(key);
      var badge = req
        ? '<span class="prechat-req-mark" aria-label="' + esc(t('required')) + '" title="' + esc(t('required')) + '">*</span>'
        : '';
      var ac = key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel';
      var ltr = key === 'email' || key === 'phone';
      var p = prefix || 'prechat';
      var hook = p === 'fb' ? 'data-fb' : 'data-prechat';
      return '<div class="prechat-field" data-field="' + key + '">' +
          '<label class="prechat-label" for="' + p + '-' + key + '">' + esc(label) + badge + '</label>' +
          '<div class="prechat-control fi"' + (ltr ? ' dir="ltr"' : '') + '>' +
            '<input id="' + p + '-' + key + '" class="prechat-input" ' + hook + '="' + key + '" type="' + type +
              '" autocomplete="' + ac + '"' + (ltr ? ' dir="ltr"' : '') +
              ' placeholder="' + esc(ph) + '"' + (req ? ' aria-required="true"' : '') +
              ' aria-invalid="false" aria-describedby="' + p + '-err-' + key + '"' +
              ' value="' + esc(value || '') + '" />' +
            (p === 'fb' ? '' : '<span class="prechat-status" aria-hidden="true"></span>') + (tail || '') +
          '</div>' +
          '<div class="prechat-error" id="' + p + '-err-' + key + '" data-err="' + key + '" role="alert" aria-live="polite"></div>' +
        '</div>';
    }

    /**
     * Splits a plain-text body that carries a leading quote block
     * ("> quoted line(s)" followed by a blank line) into { quote, rest }.
     */
    function splitQuotedBody(body) {
      var raw = body == null ? '' : String(body);
      if (raw.charAt(0) !== '>') return { quote: '', rest: raw };
      var lines = raw.split('\n');
      var quoteLines = [];
      var i = 0;
      for (; i < lines.length; i++) {
        if (lines[i].charAt(0) !== '>') break;
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
      }
      if (!quoteLines.length) return { quote: '', rest: raw };
      while (i < lines.length && !lines[i].trim()) i++;
      return { quote: quoteLines.join(' ').trim(), rest: lines.slice(i).join('\n') };
    }

    function dotsBubbleHtml(extra) {
      return '<div class="msg operator typing-bubble' + (extra || '') + '"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    }
    function renderAiThinkingRow() {
      return '<div class="msg-row operator is-last ai-thinking-row">' + storeAvatarHtml(28, '', 'msg-avatar') +
        '<div class="msg-col"><div class="msg-line">' + dotsBubbleHtml(' ai-thinking-bubble') +
          '<span class="sr-only">' + esc(t('aiThinking') || 'Thinking…') + '</span></div>' +
        '</div></div></div>';
    }
    /** The person typing, drawn as the thread's last row (feature `operatorTyping`). */
    function typingRowHtml(p) {
      p = p || {};
      return '<div class="msg-row operator is-last typing-row" aria-hidden="true">' +
        (p.name || p.avatar ? avatarHtml(p.name, p.avatar, 28, { cls: 'msg-avatar' }) : storeAvatarHtml(28, '', 'msg-avatar')) +
        '<div class="msg-col"><div class="msg-line">' + dotsBubbleHtml() + '</div></div></div>' +
      '</div>';
    }
    function msgAvatarHtml(m) {
      return (m.senderName || m.senderAvatar)
        ? avatarHtml(m.senderName || '', m.senderAvatar, 28, { cls: 'msg-avatar' })
        : storeAvatarHtml(28, '', 'msg-avatar');
    }

    function messagesHtml(s, extraRowHtml, view) {
      view = view || {};
      var typewriter = view.typewriter || null;
      var qnaState = view.qna || { questions: [], expanded: false };
      var rrCfg = config.readReceipts;
      var receiptsEnabled = !rrCfg || rrCfg.enabled !== false;
      var msgs = s.messages || [];
      var html = '<div class="messages">';

      // Runs: consecutive messages of one author on one day share one avatar
      // (beside the last bubble) and one meta line (under it).
      var groupKeys = msgs.map(function (m) {
        var author = m.sender === 'visitor' ? 'v' : ('op:' + (m.senderName || '') + '|' + (m.senderAvatar || ''));
        return author + '@' + dayKeyOf(m.time);
      });
      var visitorHasReplied = msgs.some(function (m) { return m.sender === 'visitor'; });
      var lastDayKey = '';

      msgs.forEach(function (m, idx) {
        var dk = dayKeyOf(m.time);
        if (dk && dk !== lastDayKey) { html += dayDividerHtml(m.time); lastDayKey = dk; }
        var kind = m.senderType === 'system' && m.metadata ? m.metadata.kind : '';
        if (kind === 'call_invitation') { html += renderCallInvitationCard(m); return; }
        if (kind === 'call_ended') { html += renderCallEndedRow(m); return; }
        if (kind === 'routing_agent_joined' || kind === 'conversation_transferred'
            || kind === 'routing_no_agent_available' || kind === 'routing_in_queue') {
          html += renderRoutingOutcomeRow(m); return;
        }
        var visitor = m.sender === 'visitor';
        var cls = visitor ? 'visitor' : 'operator';
        var isAi = m.senderType === 'ai';
        var isLast = idx === msgs.length - 1 || groupKeys[idx + 1] !== groupKeys[idx];
        var isFirst = idx === 0 || groupKeys[idx - 1] !== groupKeys[idx];
        var failed = visitor && isLast && m.status === 'failed';

        var statusHtml = '';
        if (failed) {
          // Error feedback, shown whatever the read-receipt setting, with a
          // retry the visitor can act on.
          statusHtml = ico('err', 14, 2.2, 'msg-err-ico') +
            '<span class="msg-ticks is-failed">' + esc(tf('msgFailed', 'Not sent')) + '</span>' +
            '<button type="button" class="msg-retry-btn" data-msg-retry="' + esc(m.localId || '') + '">' + esc(L('retry')) + '</button>';
        } else if (visitor && isLast && receiptsEnabled && m.status) {
          if (m.status === 'sending') {
            statusHtml = '<span class="msg-ticks is-sending" aria-label="' + esc(t('msgSending')) + '">' +
              '<span class="msg-status-spinner" aria-hidden="true"></span></span>';
          } else {
            var seen = m.status === 'seen';
            statusHtml = '<span class="msg-ticks' + (seen ? ' is-seen' : '') + '" aria-hidden="true">' +
              ico(seen || m.status === 'delivered' ? 'ticks' : 'tick', 16, 2) + '</span>';
          }
        }

        // Every operator run has its avatar beside its last bubble; earlier
        // rows keep the column with a spacer.
        var avatarHtml = visitor ? ''
          : isLast ? msgAvatarHtml(m) : '<span class="msg-avatar msg-avatar-spacer" aria-hidden="true"></span>';
        // A person's name above the first bubble of their run (people only).
        var label = (!visitor && isFirst && !isAi && m.senderType !== 'system' && m.senderName)
          ? '<span class="msg-sender-label">' + esc(m.senderName) + '</span>' : '';

        var aiMetaHtml = (isAi && isLast)
          ? '<span class="msg-ai-badge" title="' + esc(tf('wyAiAssistant', 'AI assistant')) + '">' +
              esc(tf('wyAiShort', 'AI')) + '</span>' +
            (m.senderName ? '<span class="msg-sender">' + esc(m.senderName) + '</span>' : '')
          : '';
        var timeStr = failed ? '' : formatMsgTime(m.time);
        var metaHtml = isLast && (timeStr || statusHtml || aiMetaHtml)
          ? '<div class="msg-footline"><div class="msg-meta">' + aiMetaHtml +
              (timeStr ? '<span class="msg-time">' + esc(timeStr) + '</span>' : '') + statusHtml +
            '</div></div>'
          : '';

        var parsed = splitQuotedBody(m.body);
        var quoteText = (m.replyTo && (m.replyTo.text || m.replyTo.body)) || parsed.quote || '';
        var bodyText = parsed.quote ? parsed.rest : m.body;
        var isTypingThis = !!(typewriter && typewriter.id === m.__id);
        var isRevealing = isTypingThis && typewriter.revealedCount < typewriter.tokens.length;
        var displayText = isRevealing
          ? typewriter.tokens.slice(0, Math.max(1, typewriter.revealedCount)).join('')
          : bodyText;
        // While revealing, the target span exists even at zero tokens, and
        // the text stays plain (half a URL is not a link yet).
        var textHtml = (isRevealing || (displayText && String(displayText).length))
          ? '<span class="msg-text"' + (isRevealing ? ' data-typing-id="' + esc(m.__id) + '"' : '') + '>' +
              (isRevealing ? esc(displayText) : escLinked(displayText)) + '</span>'
          : '';
        var quoted = quoteText ? '<span class="msg-quote">' + esc(String(quoteText)) + '</span>' : '';
        var hasText = !!(m.body && String(m.body).trim().length > 0);
        var actionsHtml = hasText
          ? '<span class="msg-actions">' +
              '<button type="button" class="msg-act" data-msg-reply="' + esc(m.__id || '') +
                '" data-msg-reply-text="' + esc(String(bodyText || m.body || '').slice(0, 200)) +
                '" data-msg-reply-author="' + esc(visitor ? tf('you', 'You') : (m.senderName || t('operator'))) +
                '" title="' + esc(tf('reply', 'Reply')) + '" aria-label="' + esc(tf('reply', 'Reply')) + '">' +
                ico('quote', 13, 1.8) + '</button>' +
              '<button type="button" class="msg-act" data-msg-copy="' + esc(String(bodyText || m.body || '')) +
                '" title="' + esc(tf('copy', 'Copy')) + '" aria-label="' + esc(tf('copy', 'Copy')) + '">' +
                ico('copy', 14, 1.7) + '</button>' +
            '</span>'
          : '';

        // An attachment is its own item above its caption, as the design draws them.
        var att = renderMessageAttachment(m.attachment);
        var items = att
          ? '<div class="msg-line"><div class="msg ' + cls + ' has-att-only">' + att + '</div></div>' : '';
        if (textHtml || quoted || !att) {
          items += '<div class="msg-line">' +
            '<div class="msg ' + cls + (isAi ? ' is-ai' : '') + (isLast ? ' has-tail' : '') + '"' +
              (isRevealing ? ' data-typing-host data-typing-active="1"' : '') + '>' + quoted + textHtml +
            '</div>' + actionsHtml +
          '</div>';
        }

        html += '<div class="msg-row ' + cls + (isLast ? ' is-last' : '') + (isFirst ? ' is-first' : '') +
          (failed ? ' is-failed' : '') + '">' + avatarHtml +
          '<div class="msg-col">' + label + items + metaHtml + '</div>' +
        '</div>';

        var isIntro = m.metadata && m.metadata.source === 'ai_agent_intro';
        if (isIntro && !visitorHasReplied && qnaState.questions.length) html += qnaChipsHtml(qnaState);
      });

      if (extraRowHtml) html += extraRowHtml;
      var lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      var waitingOnAi = !!lastMsg && (lastMsg.sender === 'visitor' || lastMsg.from === 'visitor' || lastMsg.author === 'visitor');
      if (s.aiThinking && waitingOnAi) html += renderAiThinkingRow();
      if (view.operatorTyping) html += typingRowHtml(view.operatorTyping);
      html += '</div>';
      return html;
    }

    /**
     * The in-thread pre-chat card, on the team's side: the reason (Core's
     * owner-configurable subtitle, typed out on first show), the question,
     * then the fields with the submit inside the last one, and "no thanks"
     * when nothing is required (feature `prechatOperator`).
     */
    function handoffPrechatCardHtml(identity, contact, locale, subtitle, animateSubtitle) {
      contact = contact || {};
      var keys = ['name', 'email', 'phone'].filter(function (k) { return identity.isAsked(k); });
      var required = keys.some(function (k) { return identity.isRequired(k); });
      var lastKey = keys[keys.length - 1];
      var types = { name: 'text', email: 'email', phone: 'tel' };
      var submit = '<button type="button" class="hc-submit ok" data-prechat-submit aria-label="' +
        esc(lastKey === 'email' ? L('saveEmail') : tf('continue', 'Continue')) + '">' + ico('tick', 18, 2.4) + '</button>';
      var fieldsHtml = keys.map(function (k) {
        return renderPrechatFieldRow(identity, k, types[k], contact[k], k === lastKey ? submit : '');
      }).join('');
      var title = (identity.isAsked('email') || identity.isAsked('phone')) ? L('askEmail') : t('prechatTitle');
      var dir = String(locale || '').toLowerCase().split('-')[0] === 'fa' ? 'rtl' : 'ltr';
      var subtitleHtml = animateSubtitle
        ? '<div class="msg operator hc-subtitle" data-typing-host data-typing-active="1" data-typing-id="hc-subtitle"></div>'
        : (subtitle ? '<div class="msg operator hc-subtitle">' + esc(subtitle) + '</div>' : '');
      return '<div class="msg-row operator is-last hc-row">' + storeAvatarHtml(28, '', 'msg-avatar') +
        '<div class="msg-col">' +
          (subtitleHtml ? '<div class="msg-line">' + subtitleHtml + '</div>' : '') +
          '<div class="msg-line"><div class="msg operator hc-title">' + esc(title) + '</div></div>' +
          '<div class="msg-line"><div class="hc-card fcard" dir="' + dir + '" role="group" aria-label="' + esc(title) + '">' +
            '<div class="prechat-fields hc-fields">' + (fieldsHtml || submit) + '</div>' +
            (required ? '' : '<button type="button" class="skip" data-prechat-skip>' + esc(L('skip')) + '</button>') +
          '</div></div>' +
        '</div>' +
      '</div>';
    }

    /** The details just saved, on the team's side (feature `prechatSummary`). */
    function prechatSummaryHtml(contact) {
      contact = contact || {};
      var to = String(contact.email || contact.phone || '').trim();
      if (!to) return '';
      var parts = L('replyTo').split('{email}');
      return '<div class="msg-row operator is-last">' + storeAvatarHtml(28, '', 'msg-avatar') +
        '<div class="msg-col"><div class="msg-line"><div class="fcard done" role="status">' +
          '<span class="ck" aria-hidden="true">' + ico('tick', 16, 2.4) + '</span>' +
          '<span>' + esc(parts[0]) + '<b dir="ltr">' + esc(to) + '</b>' + esc(parts[1] || '') + '</span>' +
        '</div></div></div>' +
      '</div>';
    }

    /** A form view (pre-contact, leave-a-message): bar, scrolling body, footer. */
    function formViewHtml(cls, locale, header, inner) {
      var rtl = String(locale || '').toLowerCase().split('-')[0] === 'fa';
      return viewOpen('wy-view-' + cls + ' prechat' + (cls === 'fallback' ? ' fallback' : ''), rtl) +
        barHtml(backButtonHtml('home') + header) +
        '<div class="wy-scroll wy-body-pad form-body">' + inner + '</div>' + footerHtml() +
      '</div>';
    }
    function teamHeaderHtml(online) {
      var stack = online ? stackHtml(28) : '';
      return whoHtml(stack || storeAvatarHtml(40, online ? '' : 'off'), workspaceName,
        '<span class="st">' + esc(online ? replyTimeText(true) : L('away')) + '</span>');
    }

    /**
     * Full-screen pre-contact view. Field set and required markers come from
     * the server-authoritative identity contract.
     */
    function prechatFormHtml(identity, contact, locale) {
      contact = contact || {};
      var fieldsHtml = '';
      if (identity.isAsked('name')) fieldsHtml += renderPrechatFieldRow(identity, 'name', 'text', contact.name);
      if (identity.isAsked('email')) fieldsHtml += renderPrechatFieldRow(identity, 'email', 'email', contact.email);
      if (identity.isAsked('phone')) fieldsHtml += renderPrechatFieldRow(identity, 'phone', 'tel', contact.phone);
      return formViewHtml('precontact', locale, teamHeaderHtml(true),
        '<p class="prechat-subtitle">' + esc(tf('wyPrecontactDesc', t('prechatSubtitle'))) + '</p>' +
        '<div class="prechat-fields">' + fieldsHtml + '</div>' +
        '<div class="prechat-spacer" aria-hidden="true"></div>' +
        '<button type="button" class="wy-btn wy-btn-primary wy-btn-block prechat-submit btn" data-prechat-submit>' +
          esc(tf('wyConnectOperator', t('continue'))) + '</button>');
    }

    /** Leave-a-message form (the team is away): the away notice, then the form. */
    function contactFallbackHtml(identity, contact, locale, presence) {
      contact = contact || {};
      var intro = (presence && presence.introLabel) ? presence.introLabel : t('fallbackIntro');
      var askPhone = identity.isAsked('phone');
      var req = { isRequired: function (k) { return k === 'email' ? !askPhone : identity.isRequired(k); } };
      var d = nextOpen();
      var at = d ? backAtTime(d) : '';
      var sub = at ? L('backAt', { t: at }) : replyTimeText(false);
      var fieldsHtml = renderPrechatFieldRow(req, 'name', 'text', contact.name, '', 'fb') +
        renderPrechatFieldRow(req, 'email', 'email', contact.email, '', 'fb') +
        (askPhone ? renderPrechatFieldRow(req, 'phone', 'tel', contact.phone, '', 'fb') : '');
      return formViewHtml('fallback', locale, teamHeaderHtml(false),
        '<div class="away"><span class="it">' + ico('moon', 18, 1.8) + '</span><span>' + esc(L('awayT')) +
          (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span></div>' +
        '<p class="prechat-intro">' + esc(intro) + '</p>' +
        '<div class="prechat-fields">' + fieldsHtml +
          '<div class="prechat-field" data-field="message">' +
            '<label class="prechat-label" for="fb-message">' + esc(t('fallbackMessageLabel')) +
              '<span class="prechat-req-mark">*</span></label>' +
            '<div class="prechat-control fi fi-ta">' +
              '<textarea id="fb-message" class="prechat-input prechat-textarea" data-fb="message" rows="3" placeholder="' +
                esc(t('typeMsg')) + '" aria-required="true" aria-invalid="false" aria-describedby="fb-err-message"></textarea>' +
            '</div>' +
            '<div class="prechat-error" id="fb-err-message" data-err="message" role="alert" aria-live="polite"></div>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="wy-btn wy-btn-primary wy-btn-block prechat-submit btn" data-fb-submit>' +
          esc(t('fallbackSubmit')) + '</button>' +
        '<div class="fallback-status" data-fb-status role="status" aria-live="polite"></div>');
    }

    function smartSurfaceHtml(s) {
      return (s.dismissible === false
        ? ''
        : '<button type="button" class="smart-dismiss" data-smart-dismiss aria-label="' +
            esc(tf('close', 'Close')) + '">' + ico('x', 15, 2.4) + '</button>') +
        (s.title ? '<div class="smart-title">' + esc(s.title) + '</div>' : '') +
        '<div class="smart-body">' + esc(s.body || '') + '</div>' +
        (s.ctaLabel ? '<button type="button" class="smart-cta" data-smart-cta>' + esc(s.ctaLabel) + '</button>' : '');
    }

    // ══════════════════════════════════════════════════════════════════
    // Shell — NON-VISUAL infrastructure only (single-view architecture)
    // ══════════════════════════════════════════════════════════════════
    // One view at a time inside the view host; the panel's only own control
    // is the close button, drawn per view by the stylesheet
    // (.panel[data-view]): glass on the home hero, plain on white bars.
    function shellHtml() {
      return '<button type="button" class="panel-close" data-panel-close' + ACC + ' aria-label="' +
          esc(tf('close', 'Close')) + '">' + ico('x', 20, 1.9) + '</button>' +
        '<div class="body wy-scroll" data-body></div>' +
        // The in-panel call surface is a PANEL-level overlay, so a minimized
        // call keeps its <video> while the chat stays usable underneath.
        '<div class="gs-call-host" data-call-host hidden></div>' +
        '<div class="att-lightbox" data-att-lightbox hidden role="dialog" aria-modal="true" aria-label="' +
          esc(t('openFile')) + '">' +
          '<button type="button" class="att-lightbox-close" data-att-lightbox-close aria-label="' +
            esc(t('closePreview')) + '">×</button>' +
          '<img data-att-lightbox-img alt="" />' +
        '</div>';
    }

    /**
     * The chat bar (feature `chatHeader`: Core writes this into
     * [data-chat-header] whenever what it shows changes). The person
     * answering when there is one, the team for a new conversation, else the
     * workspace; then typing, online, away or the reply time.
     */
    function chatHeaderHtml(vm) {
      vm = vm || {};
      var online = vm.online !== false;
      var op = vm.operator && vm.operator.name ? vm.operator : null;
      var stack = !op && vm.isNew && online ? stackHtml(28) : '';
      var avatar = op ? avatarHtml(op.name, op.avatar, 40, { pr: op.online ? 'on' : (online ? '' : 'off') })
        : stack || storeAvatarHtml(40, online ? '' : 'off');
      var name = op ? op.name : stack ? tf('wyNewConversation', 'New conversation') : workspaceName;
      var rt = replyTimeText(true);
      var st = vm.typing ? '<span class="st typ">' + esc(L('typing')) + '<i></i><i></i><i></i></span>'
        : !online ? '<span class="st">' + esc(L('away')) + '</span>'
        : op && op.online ? '<span class="st"><i class="ondot"></i>' + esc(L('online')) + '</span>'
        : rt ? '<span class="st">' + esc(rt) + '</span>' : '';
      return backButtonHtml('home') + whoHtml(avatar, name, st) + '<span class="cs" aria-hidden="true"></span>' +
        '<div class="presence sr-only" data-presence>' +
          '<span class="presence-dot" data-presence-dot></span>' +
          '<span class="presence-label" data-presence-label></span>' +
        '</div>';
    }

    // The ONE chat surface, built once by Core: bar, message scroll host,
    // composer, footer. Core renders the list into [data-chat-messages] and
    // binds the composer nodes of this frame (their DOM order is fixed; the
    // stylesheet lays them out as a two-row grid).
    function chatFrameHtml(vm) {
      vm = vm || {};
      var cfg = vm.config || {};
      var chatEnabled = !!vm.chatEnabled;
      var rtl = String(vm.locale || 'en').toLowerCase().split('-')[0] === 'fa';
      var attachCfg = cfg.attachments || { enabled: false };
      var composerCfg = cfg.composer || {};
      var micSupported = !!(typeof navigator !== 'undefined' && navigator.mediaDevices
        && navigator.mediaDevices.getUserMedia && typeof window.MediaRecorder === 'function');
      var voice = attachCfg.voiceNotesEnabled === true && micSupported;
      var emojiEnabled = composerCfg.emojiEnabled !== false;

      var inputHtml = chatEnabled
        ? '<div class="composer-zone cmp" data-composer-zone>' +
            // Typing is drawn in the thread; this row announces it.
            '<div class="sr-only" data-typing-row hidden aria-live="polite">' +
              '<span class="typing-label" data-typing-label></span>' +
            '</div>' +
            '<div class="reply-preview" data-reply-preview hidden>' +
              '<span class="reply-preview-bar" aria-hidden="true"></span>' +
              '<span class="reply-preview-icon" aria-hidden="true">' + ico('quote', 13, 1.8) + '</span>' +
              '<span class="reply-preview-body">' +
                '<span class="reply-preview-author" data-reply-preview-author></span>' +
                '<span class="reply-preview-text" data-reply-preview-text></span>' +
              '</span>' +
              '<button type="button" class="reply-preview-cancel" data-reply-cancel aria-label="' +
                esc(tf('cancel', 'Cancel')) + '">' + ico('x', 14, 2) + '</button>' +
            '</div>' +
            '<div class="emoji-picker" data-emoji-picker hidden></div>' +
            '<div class="input-bar" data-input-bar>' +
              '<div class="input-wrap" data-input-wrap>' +
                (attachCfg.enabled
                  ? '<div class="att-preview" data-attach-preview hidden>' +
                      '<div class="att-preview-thumb" data-attach-thumb>' +
                        '<img class="att-preview-img" data-attach-thumb-img alt="" hidden />' +
                        '<span class="att-preview-doc" data-attach-thumb-doc aria-hidden="true">' + ico('doc', 18, 1.7) + '</span>' +
                      '</div>' +
                      '<div class="att-preview-meta">' +
                        '<div class="att-preview-name" data-attach-name></div>' +
                        '<div class="att-preview-sub" data-attach-sub></div>' +
                        '<div class="att-preview-track" data-attach-track hidden>' +
                          '<div class="att-preview-bar" data-attach-bar></div>' +
                        '</div>' +
                      '</div>' +
                      '<button type="button" class="att-preview-btn att-preview-retry" data-attach-retry hidden' +
                        ' aria-label="' + esc(t('retry')) + '">' + ico('retry', 14, 1.9) + '</button>' +
                      '<button type="button" class="att-preview-btn att-preview-remove" data-attach-remove' +
                        ' aria-label="' + esc(t('remove')) + '">' + ico('x', 14, 2) + '</button>' +
                    '</div>'
                  : '') +
                '<div class="input-row" data-input-row>' +
                  (voice
                    ? '<button type="button" class="mic-btn" data-mic-btn aria-label="' + esc(t('recordVoice')) + '">' + ico('mic', 20, 2) + '</button>'
                    : '') +
                  '<textarea class="input" rows="1" data-msg-input placeholder="' + esc(t('typeMsg')) + '"></textarea>' +
                  '<div class="composer-actions">' +
                    '<div class="composer-actions-start">' +
                      '<button type="button" class="send-btn" data-send-btn aria-label="' + esc(tf('send', 'Send')) + '">' +
                        ico('send', 20, 2.2) + '</button>' +
                      (attachCfg.enabled
                        ? '<button type="button" class="attach-btn" data-attach-btn aria-label="' + esc(t('attachFile')) + '">' + ico('clip', 20, 1.8) + '</button>' +
                          '<input type="file" data-attach-input hidden accept="' + esc((attachCfg.allowedMimes || []).join(',')) + '" />'
                        : '') +
                      (emojiEnabled
                        ? '<button type="button" class="emoji-btn" data-emoji-btn aria-expanded="false" aria-label="' + esc(t('emojiPicker')) + '">' + ico('emoji', 20, 1.8) + '</button>'
                        : '') +
                    '</div>' +
                  '</div>' +
                  // Recording takes the box over (a class toggle; nothing is
                  // rebuilt). The red button sends the note at once (feature
                  // `recSend`); `data-rec-stop` (stop → preview) is kept for
                  // Core but this design draws no such control.
                  (voice
                    ? '<div class="rec-bar" data-rec-bar hidden>' +
                        '<button type="button" class="rec-btn rec-cancel" data-rec-cancel aria-label="' + esc(L('delRec')) + '">' + ico('trash', 20, 1.8) + '</button>' +
                        '<span class="rec-dot" aria-hidden="true"></span>' +
                        '<span class="rec-time" data-rec-timer role="timer" aria-live="off">' + clock(0) + '</span>' +
                        '<span class="rec-wave" aria-hidden="true">' + waveHtml() + '</span>' +
                        '<span class="sr-only" data-rec-sr role="status" aria-live="polite">' + esc(t('recording')) + '</span>' +
                        '<button type="button" class="rec-btn rec-confirm" data-rec-stop hidden aria-label="' +
                          esc(t('stopRecording')) + '"></button>' +
                        '<button type="button" class="rec-btn rec-send" data-rec-send aria-label="' + esc(L('sendVoice')) + '">' + ico('send', 20, 2.2) + '</button>' +
                      '</div>' +
                      // A finished note waiting (the fallback when its upload
                      // failed): hear it back, throw it away or send it.
                      '<div class="vn-bar" data-vn-bar hidden>' +
                        '<button type="button" class="rec-btn vn-delete" data-vn-delete aria-label="' + esc(t('remove')) + '">' + ico('trash', 20, 1.8) + '</button>' +
                        '<button type="button" class="vn-play" data-vn-toggle aria-label="' +
                          esc(t('playAudio')) + '">' +
                          '<span class="vn-ico vn-ico-play">' + ico('play', 15, 0) + '</span>' +
                          '<span class="vn-ico vn-ico-pause">' + ico('pause', 15, 0) + '</span>' +
                        '</button>' +
                        '<div class="vn-track" data-vn-seek dir="ltr">' +
                          '<div class="vn-progress" data-vn-progress></div>' +
                        '</div>' +
                        '<span class="vn-time" data-vn-time>' + clock(0) + '</span>' +
                        '<audio data-vn-audio preload="metadata"></audio>' +
                        '<button type="button" class="vn-send" data-vn-send aria-label="' +
                          esc(tf('send', 'Send')) + '">' + ico('send', 20, 2.2) + '</button>' +
                      '</div>'
                    : '') +
                '</div>' +
              '</div>' +
            '</div>' +
            footerHtml() +
          '</div>'
        : footerHtml();

      // Jump-to-latest, for a visitor who scrolled up while messages arrived
      // (Core owns `hidden` and `has-new`). Never inside the header Core rewrites.
      var jumpHtml = chatEnabled
        ? '<button type="button" class="wy-jump" data-chat-jump hidden' +
            ' aria-label="' + esc(tf('scrollToLatest', 'Scroll to latest message')) + '">' +
            '<span class="wy-jump-ico" aria-hidden="true">' + ico('down', 16, 2) + '</span>' +
            '<span class="wy-jump-label" data-chat-jump-label></span>' +
          '</button>'
        : '';

      return viewOpen('wy-view-chat', rtl) +
        '<div class="header wy-head bar" data-chat-header>' +
          chatHeaderHtml({ online: teamOnline(), typing: false, operator: null, isNew: true }) +
        '</div>' +
        '<div class="wy-chat-scroll-host">' +
          '<div class="wy-chat-scroll wy-scroll" data-chat-messages></div>' +
          jumpHtml +
        '</div>' +
        inputHtml +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Home
    // ══════════════════════════════════════════════════════════════════
    function openOf(list) {
      return (list || []).filter(function (c) {
        var st = String(c.status || '');
        return st !== 'resolved' && st !== 'closed';
      });
    }
    function unreadBadgeHtml(n) {
      return n > 0 ? '<span class="nb" aria-label="' + esc(tf('wyUnread', 'Unread messages')) + '">' +
        esc(n > 99 ? fmtNum(99) + '+' : fmtNum(n)) + '</span>' : '';
    }
    function convAvatarHtml(c, size) {
      return c.operatorName || c.operatorAvatar
        ? avatarHtml(c.operatorName || '', c.operatorAvatar, size, { pr: c.operatorOnline ? 'on' : '' })
        : storeAvatarHtml(size);
    }

    /** One conversation: the person answering, the latest line, its state. */
    function conversationRowHtml(c, compact) {
      var unread = Number(c.unreadCount) || 0;
      var preview = c.preview || tf('wyNoPreview', '…');
      if (c.lastFromVisitor && c.preview) preview = tf('you', 'You') + ': ' + preview;
      var timeHtml = c.timeLabel ? '<time>' + esc(c.timeLabel) + '</time>' : '';
      if (compact) {
        return '<button type="button" class="conv-row conv-row-compact" data-conversation-open="' + esc(c.id) + '">' +
          '<span class="conv-preview">' + esc(preview) + '</span>' + unreadBadgeHtml(unread) + timeHtml +
        '</button>';
      }
      var resolved = String(c.status || '') === 'resolved' || String(c.status || '') === 'closed';
      return '<button type="button" class="conv-row ci" data-conversation-open="' + esc(c.id) + '">' +
        convAvatarHtml(c, 44) +
        '<span class="tx">' +
          '<span class="l1"><span class="nm">' + esc(c.operatorName || c.title || workspaceName) + '</span>' + timeHtml + '</span>' +
          '<span class="l2' + (unread ? ' u' : '') + '"><em>' + esc(preview) + '</em>' + unreadBadgeHtml(unread) + '</span>' +
          '<span class="pl"><span class="pill' + (resolved ? ' done' : '') + '">' +
            esc(resolved ? tf('wyStatusResolved', 'Resolved') : tf('wyStatusOpen', 'Open')) + '</span></span>' +
        '</span>' +
      '</button>';
    }

    function rowHtml(attr, lead, title, sub, tail, unread) {
      return '<button type="button" class="r" ' + attr + '>' + lead +
        '<span class="tx"><span class="t1">' + esc(title) + '</span>' +
          (sub ? '<span class="t2x' + (unread ? ' u' : '') + '">' + esc(sub) + '</span>' : '') + '</span>' +
        (tail || ico('fwd', 18, 2, 'ch dirf')) +
      '</button>';
    }
    function tileHtml(name) { return '<span class="it" aria-hidden="true">' + ico(name, 20, 1.7) + '</span>'; }
    function listJoin(names) {
      if (names.length < 2) return names.join('');
      return names.slice(0, -1).join(L('sep')) + L('and') + names[names.length - 1];
    }

    function homeHtml(vm) {
      vm = vm || {};
      var online = !!vm.isOnline;
      var convs = vm.conversations || [];
      var open = openOf(convs);
      var articles = vm.articles || [];
      var opts = config.templateOptions || {};
      var examples = (Array.isArray(opts.askExamples) ? opts.askExamples : []).filter(function (e) {
        return typeof e === 'string' && e.trim();
      }).slice(0, 2);
      var name = String(vm.visitorName || '').trim();
      var rt = replyTimeText(true);
      var logoSrc = workspaceLogo();
      var logo = config.showLogo === false ? ''
        : '<span class="logo"' + (logoSrc ? '' : ' aria-hidden="true"') + '>' +
          (logoSrc ? imgTag(logoSrc, workspaceName) : esc(initialOf(workspaceName) || 'W')) + '</span>';

      var hero = '<div class="hero">' +
        '<div class="aur" aria-hidden="true"><i></i><i></i></div>' + markSvg('mk', MARK) +
        '<div class="top cas" style="--i:0">' + logo + '<span class="sp"></span><span class="cs" aria-hidden="true"></span></div>' +
        '<p class="hi cas" style="--i:1">' + esc(name ? L('hiBack', { name: name }) : tf('homeGreeting', 'Hello 👋')) + '</p>' +
        '<h2 class="hq cas" style="--i:2">' + L(online ? 'q' : 'qAway').split('\n').map(esc).join('<br>') + '</h2>' +
        '<div class="pres cas' + (online ? '' : ' off') + '" style="--i:3">' + stackHtml(28) +
          '<span><i class="dot"></i>' + esc(online ? L('on') + (rt ? L('sep') + rt : '') : awayLine()) + '</span>' +
        '</div>' +
      '</div>';

      // The one elevated thing: a question that starts a conversation
      // (feature `homeAsk`), with the workspace's examples rotating in its
      // placeholder and its topics as chips; away, a note instead.
      var ask = '';
      if (vm.chatEnabled) {
        var ph = online
          ? [L('ask')].concat(examples.length === 2 ? examples.map(function (e) { return L('eg') + e.trim(); }) : [])
          : [L('askAway')];
        var chips = topicChipsHtml();
        if (!chips && vm.kbEnabled) {
          chips = articles.slice(0, 3).map(function (a) {
            return chipHtml('data-home-article', a.slug || '', 'book', a.title || '');
          }).join('');
        }
        var d = nextOpen();
        ask = '<div class="ask cas" style="--i:4">' +
          '<div class="field' + (ph.length < 3 ? ' static' : '') + '">' +
            '<textarea class="ask-in" rows="1" data-home-ask placeholder=" " aria-label="' + esc(ph[0].replace(/…$/, '')) + '"></textarea>' +
            '<span class="ph" aria-hidden="true">' + ph.map(function (p) { return '<span>' + esc(p) + '</span>'; }).join('') + '</span>' +
            '<button type="button" class="send" data-home-action="chat" aria-label="' + esc(tf('send', 'Send')) + '">' + ico('send', 20, 2.2) + '</button>' +
          '</div>' +
          (online
            ? (chips ? '<div class="chips">' + chips + '</div>' : '')
            : '<p class="note">' + ico('mail', 16, 1.8) + esc(L(d && d.getHours() < 12 ? 'noteAm' : 'note')) + '</p>') +
        '</div>';
      }

      var smart = vm.smartSurface && vm.smartSurface.mode === 'home_card'
        ? '<section class="smart-home-card">' + smartSurfaceHtml(vm.smartSurface) + '</section>'
        : '';

      // Quiet rows, each only when it has something behind it (at most three):
      // continue the open conversation, all conversations, the help center.
      // (Track order needs a store context the widget does not have yet.)
      var rows = [];
      if (vm.chatEnabled) {
        var latest = open[0];
        if (latest) {
          var unread = Number(latest.unreadCount) || 0;
          rows.push(rowHtml('data-conversation-open="' + esc(latest.id) + '"', convAvatarHtml(latest, 40),
            latest.operatorName ? L('cont', { name: latest.operatorName }) : tf('wyContinueLast', 'Continue last conversation'),
            latest.preview || '',
            '<span class="end">' + (latest.timeLabel ? '<span>' + esc(latest.timeLabel) + '</span>' : '') + unreadBadgeHtml(unread) + '</span>',
            unread > 0));
        }
        if (convs.length) {
          var n = fmtNum(convs.length);
          rows.push(rowHtml('data-view="list"', tileHtml('chat'), L('convs'),
            open.length === 1 ? L('convsOne', { n: n }) : L('convsN', { n: n })));
        } else if (vm.conversationsError) {
          rows.push(rowHtml('data-home-action="conversations-retry"', tileHtml('chat'), L('convs'),
            tf('wyConversationsLoadError', t('convLoadError')), ico('retry', 18, 1.9, 'ch')));
        }
      }
      if (vm.kbEnabled) {
        var catNames = (vm.categories || []).map(function (c) { return String((c && c.name) || '').trim(); })
          .filter(Boolean).slice(0, 3);
        var helpSub = !online ? L('helpAway')
          : !articles.length ? ''
          : catNames.length ? L('helpSub', { n: fmtNum(articles.length), c: listJoin(catNames) })
          : L('arts', { n: fmtNum(articles.length) });
        rows.push(rowHtml('data-view="help"', tileHtml('book'), tf('help', 'Help center'), helpSub));
      }
      rows = rows.slice(0, 3);

      return viewOpen('wy-view-home home-root', !!vm.rtl) +
        '<div class="wy-scroll wy-home-scroll">' + hero + ask + smart +
          (rows.length ? '<div class="list cas' + (ask ? '' : ' lift') + '" style="--i:5">' + rows.join('') + '</div>' : '') +
        '</div>' +
        footerHtml() +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Conversation list
    // ══════════════════════════════════════════════════════════════════
    function conversationListHtml(vm) {
      vm = vm || {};
      var items = vm.conversations || [];
      // A real failure with nothing cached is its own, retryable state;
      // cached items stay on screen when only a refresh failed.
      var bodyHtml = (vm.error && !items.length)
        ? '<div class="wy-empty wy-conv-error">' +
            '<p>' + esc(tf('wyConversationsLoadError', t('convLoadError'))) + '</p>' +
            '<button type="button" class="wy-btn wy-btn-outline" data-home-action="conversations-retry">' +
              esc(tf('wyConversationsRetry', t('convRetry'))) +
            '</button>' +
          '</div>'
        : (vm.loading
            ? skeletonConvRowsHtml(5)
            : (items.length
                ? items.map(function (c) { return conversationRowHtml(c, false); }).join('')
                : '<div class="wy-empty"><p>' + esc(tf('wyNoConversations', 'No conversations yet')) + '</p></div>'));
      return viewOpen('wy-view-list', !!vm.rtl) +
        titleBarHtml(L('convs')) +
        '<div class="wy-scroll inbox wy-list-scroll">' + bodyHtml + '</div>' +
        (vm.chatEnabled
          ? '<button type="button" class="wy-fab fab" data-home-action="chat">' + ico('plus', 20, 2.2) +
              '<span>' + esc(tf('wyNewConversation', 'New conversation')) + '</span></button>'
          : '') +
        footerHtml() +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Knowledge Base (help center, a category, an article)
    // ══════════════════════════════════════════════════════════════════
    function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    /** Escaped text with the query's words highlighted (escaped too). */
    function markedHtml(text, query) {
      var words = String(query || '').trim().split(/\s+/).filter(function (w) { return w.length >= 2; });
      text = String(text || '');
      if (!words.length) return esc(text);
      var parts = text.split(new RegExp('(' + words.map(escRe).join('|') + ')', 'gi'));
      return parts.map(function (p, i) { return i % 2 ? '<mark>' + esc(p) + '</mark>' : esc(p); }).join('');
    }

    function kbArticleItemHtml(a, query) {
      return '<button type="button" class="kb-article" data-kb-action="open" data-kb-slug="' + esc(a.slug) + '">' +
        '<span class="it" aria-hidden="true">' + ico('book', 18, 1.7) + '</span>' +
        '<span class="tx"><span class="tt">' + markedHtml(a.title, query) + '</span>' +
          (a.excerpt ? '<small>' + markedHtml(a.excerpt, query) + '</small>' : '') +
        '</span>' +
      '</button>';
    }

    function kbSearchBarHtml(vm) {
      vm = vm || {};
      return '<div class="sfield kb-search-wrap">' + ico('search', 20, 1.9) +
        '<input class="kb-search" type="search" data-kb-search autocomplete="off" autocorrect="off" spellcheck="false" ' +
          'enterkeyhint="search" aria-label="' + esc(t('searchKb')) + '" placeholder="' + esc(t('searchKb')) +
          '" value="' + esc(vm.query || '') + '" />' +
        '<button type="button" class="x" data-kb-search-clear aria-label="' + esc(L('clear')) + '">' + ico('x', 14, 2.2) + '</button>' +
      '</div>';
    }

    function ctaHtml(vm) {
      if (vm && vm.hideChatCta) return '';
      var rt = replyTimeText(true);
      return '<button type="button" class="cta" data-kb-action="switch-chat">' + stackHtml(28) +
        '<span class="tx">' + esc(L('still')) + '<small>' + esc(L('chatTeam') + (rt ? L('semi') + rt : '')) + '</small></span>' +
        '<span class="go" aria-hidden="true">' + ico('fwd', 18, 2, 'dirf') + '</span>' +
      '</button>';
    }

    function kbEmptyHtml(vm) {
      vm = vm || {};
      var isSearch = vm.state === 'results';
      return '<div class="kb-empty">' +
        '<p class="cnt kb-empty-text" role="status">' + esc(vm.emptyText || (isSearch ? t('kbZeroResults') : t('noArticles'))) + '</p>' +
        ctaHtml(vm) +
      '</div>';
    }

    function kbLoadingHtml() {
      // The list's shape is the loading affordance; no visitor-visible copy.
      return skeletonArticleRowsHtml(3);
    }

    function kbSearchResultsHtml(vm) {
      vm = vm || {};
      var results = vm.results || [];
      if (!results.length) return kbEmptyHtml({ state: 'results', emptyText: vm.emptyText, hideChatCta: vm.hideChatCta });
      return '<p class="cnt" role="status">' + esc(L('found', { n: fmtNum(results.length) })) + '</p>' +
        '<div class="res kb-list">' + results.map(function (a) { return kbArticleItemHtml(a, vm.query); }).join('') + '</div>';
    }

    /** Category tiles (feature `kbCategories`: ids and counts from Core). */
    function kbCategoriesHtml(cats) {
      cats = (cats || []).filter(function (c) { return c && c.id != null && c.name; });
      if (!cats.length) return '';
      return '<p class="sec">' + esc(L('topicsT')) + '</p><div class="cats">' + cats.map(function (c) {
        return '<button type="button" class="cat" data-kb-category="' + esc(c.id) + '">' +
          '<span class="it" aria-hidden="true">' + ico(TOPIC_ICONS[c.icon] ? c.icon : 'book', 18, 1.7) + '</span>' +
          '<span class="tx"><b>' + esc(c.name) + '</b><small>' + esc(L('arts', { n: fmtNum(c.count || 0) })) + '</small></span>' +
        '</button>';
      }).join('') + '</div>';
    }

    function kbHomeHtml(vm) {
      vm = vm || {};
      var articles = vm.articles || [];
      var cats = kbCategoriesHtml(vm.categories);
      if (!articles.length && !cats) {
        return kbEmptyHtml({ state: 'list', emptyText: vm.emptyText, hideChatCta: vm.hideChatCta });
      }
      // With categories to browse, the list opens with the newest few.
      return (articles.length
        ? '<div class="res kb-list">' + articles.slice(0, cats ? 6 : articles.length).map(function (a) {
            return kbArticleItemHtml(a, '');
          }).join('') + '</div>'
        : '') + cats;
    }

    /**
     * Article feedback (rendered only when Core says it is enabled): sad,
     * neutral (only while the server stores it: `capabilities.kbNeutral`)
     * and happy faces.
     */
    function kbArticleFeedbackHtml(fb) {
      if (!fb || !fb.enabled) return '';
      var rating = fb.rating || null;
      var faces = [['down', 'sad', 'no']];
      if (caps.kbNeutral) faces.push(['neutral', 'meh', 'partly']);
      faces.push(['up', 'happy', 'yes']);
      return '<div class="kb-feedback fb" data-kb-feedback>' +
        '<span class="q">' + esc(L('didHelp')) + '</span><span class="sp"></span>' +
        faces.map(function (f) {
          var on = rating === f[0];
          return '<button type="button" class="kb-rate face' + (on ? ' is-' + f[0] : '') + '" data-kb-rate="' + f[0] +
            '" aria-pressed="' + on + '" aria-label="' + esc(L(f[2])) + '">' + ico(f[1], 22, 1.7) + '</button>';
        }).join('') +
        (rating ? '<span class="sr-only" role="status">' + esc(tf('wyFeedbackThanks', 'Thanks for your feedback!')) + '</span>' : '') +
      '</div>';
    }

    function kbArticleHtml(vm) {
      vm = vm || {};
      var a = vm.article || {};
      var mins = Number(a.readingMinutes) || 0;
      return '<div class="art wy-scroll kb-article-view">' +
          '<h1>' + esc(a.title || '') + '</h1>' +
          (mins ? '<div class="am"><span>' + ico('clock', 15, 1.8) + esc(L('read', { n: fmtNum(mins) })) + '</span></div>' : '') +
          '<div class="kb-article-body">' + (a.contentHtml || '') + '</div>' +
        '</div>' +
        kbArticleFeedbackHtml(vm.feedback) + ctaHtml(vm);
    }

    /** The help view: its bar, then the search field and a live results region, or the article. */
    function kbHtml(vm) {
      vm = vm || {};
      var state = vm.state || 'list';
      var a = vm.article || {};
      if (state === 'article') {
        return viewOpen('wy-view-kb kb-root kb-article-root', !!vm.rtl) +
          barHtml(backButtonHtml('back') + '<h2 class="ttl">' + esc(a.categoryTitle || a.title || '') + '</h2>',
            '<i class="prog" data-kb-progress aria-hidden="true"></i>') +
          kbArticleHtml(vm) + footerHtml() +
        '</div>';
      }
      var inCat = state === 'category' && vm.category;
      var inner = state === 'searching' ? kbLoadingHtml(vm)
        : state === 'results' ? kbSearchResultsHtml(vm) + kbCategoriesHtml(vm.categories)
        : inCat ? '<p class="cnt">' + esc(L('arts', { n: fmtNum((vm.articles || []).length) })) + '</p>' +
            '<div class="res kb-list">' + (vm.articles || []).map(function (x) { return kbArticleItemHtml(x, ''); }).join('') + '</div>'
        : kbHomeHtml(vm);
      // Search as you type (feature `kbSearch`): Core repaints only
      // [data-kb-results], so the field keeps its text, focus and caret.
      return viewOpen('wy-view-kb kb-root', !!vm.rtl) +
        barHtml(backButtonHtml('back') + '<h2 class="ttl">' + esc(inCat ? vm.category.name : tf('help', 'Help center')) + '</h2>') +
        kbSearchBarHtml(vm) +
        '<div class="wy-scroll kb-scroll" data-kb-results>' + inner + '</div>' +
        footerHtml() +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Loading skeletons
    // ══════════════════════════════════════════════════════════════════
    // Core asks for a skeleton by view key; each wears the REAL surface's
    // classes (bar, hero, ask card, composer box, footer) so the crossfade
    // to content moves nothing. aria-hidden, no fake names or numbers.
    function skl(w, h) {
      return '<i class="skl" style="width:' + w + (h ? ';height:' + h + 'px' : '') + '"></i>';
    }
    function skBarHtml(inner) {
      return '<div class="wy-head bar"><span class="wy-back ib"></span>' + inner + '<span class="cs"></span></div>';
    }
    function skWhoHtml() {
      return '<span class="who"><span class="av s40 skc"></span><span class="wt"><span class="nm">' + skl('96px', 12) +
        '</span><span class="st">' + skl('140px', 9) + '</span></span></span>';
    }
    function skViewOpen(cls, vm) {
      return viewOpen(cls + ' wy-skeleton', !!(vm && vm.rtl), ' aria-hidden="true"');
    }

    function skeletonConvRowsHtml(n) {
      var out = '';
      for (var i = 0; i < (n || 5); i++) {
        out += '<div class="sk" aria-hidden="true"><i class="skc" style="width:44px;height:44px"></i>' +
          '<span class="tx">' + skl('45%', 12) + skl((80 - (i % 3) * 12) + '%', 10) + '</span></div>';
      }
      return '<div class="wy-sk-group" aria-hidden="true">' + out + '</div>';
    }

    function skeletonArticleRowsHtml(n) {
      var out = '';
      var widths = ['72%', '58%', '81%', '64%', '76%', '52%'];
      for (var i = 0; i < (n || 6); i++) {
        out += '<div class="kb-article sk" aria-hidden="true"><span class="it skc"></span>' +
          '<span class="tx">' + skl(widths[i % 6], 12) + skl('88%', 9) + '</span></div>';
      }
      return '<div class="res kb-list wy-sk-group" aria-hidden="true">' + out + '</div>';
    }

    function skeletonHomeHtml(vm) {
      vm = vm || {};
      var row = '<div class="r"><span class="it skc"></span><span class="tx">' + skl('46%', 12) + skl('70%', 9) + '</span></div>';
      return skViewOpen('wy-view-home home-root', vm) +
        '<div class="wy-home-scroll">' +
          '<div class="hero">' +
            '<div class="top">' + (config.showLogo === false ? '' : '<span class="logo"></span>') + '<span class="sp"></span><span class="cs"></span></div>' +
            '<p class="hi">' + skl('30%', 12) + '</p>' +
            '<h2 class="hq">' + skl('62%', 22) + '<br>' + skl('44%', 22) + '</h2>' +
            '<div class="pres">' + skl('72%', 10) + '</div>' +
          '</div>' +
          (vm.chatEnabled === false ? '' :
            '<div class="ask"><div class="field static"></div>' +
              '<div class="chips">' + skl('88px', 34) + skl('104px', 34) + skl('92px', 34) + '</div></div>') +
          '<div class="list' + (vm.chatEnabled === false ? ' lift' : '') + '">' + row + row + '</div>' +
        '</div>' +
        footerHtml() +
      '</div>';
    }

    function skeletonChatHtml(vm) {
      vm = vm || {};
      var msgs = [['', '64%'], [' is-me', '48%'], ['', '78%'], [' is-me', '38%']].map(function (r) {
        return '<div class="wy-sk-msg' + r[0] + '">' + (r[0] ? '' : '<i class="skc" style="width:28px;height:28px"></i>') +
          '<i class="wy-sk-bubble" style="width:' + r[1] + '"></i></div>';
      }).join('');
      // The composer mirrors chatFrameHtml: the same box, grid and control
      // set (decided by the same flags), so the box the visitor is about to
      // type into does not move when the real one arrives.
      var comp = vm.composer || {};
      var ctl = function (cls) { return '<span class="' + cls + ' wy-sk-ico"><i class="skc"></i></span>'; };
      var composerHtml = vm.chatEnabled === false
        ? footerHtml()
        : '<div class="composer-zone cmp">' +
            '<div class="input-bar"><div class="input-wrap"><div class="input-row">' +
              '<span class="input wy-sk-input">' + skl('54%', 10) + '</span>' +
              '<div class="composer-actions"><div class="composer-actions-start">' +
                ctl(comp.voiceNotes ? 'mic-btn' : 'send-btn') +
                (comp.attachments ? ctl('attach-btn') : '') +
                (comp.emoji ? ctl('emoji-btn') : '') +
              '</div></div>' +
            '</div></div></div>' +
            footerHtml() +
          '</div>';
      return skViewOpen('wy-view-chat', vm) +
        skBarHtml(skWhoHtml()) +
        '<div class="wy-chat-scroll-host"><div class="wy-chat-scroll wy-sk-msgs">' + msgs + '</div></div>' +
        composerHtml +
      '</div>';
    }

    function skeletonListHtml(vm) {
      vm = vm || {};
      return skViewOpen('wy-view-list', vm) +
        skBarHtml('<span class="ttl">' + skl('110px', 14) + '</span>') +
        '<div class="wy-scroll inbox">' + skeletonConvRowsHtml(5) + '</div>' +
        footerHtml() +
      '</div>';
    }

    function skeletonPrechatHtml(vm) {
      vm = vm || {};
      var n = Math.max(1, Math.min(4, Number(vm.fields) || 2));
      var fields = '';
      for (var i = 0; i < n; i++) {
        fields += '<div class="prechat-field">' + skl('64px', 10) + '<span class="fi skc"></span></div>';
      }
      return skViewOpen('wy-view-precontact prechat', vm) +
        skBarHtml(skWhoHtml()) +
        '<div class="wy-scroll wy-body-pad form-body">' +
          '<div class="wy-sk-group">' + skl('86%', 11) + skl('58%', 11) + '</div>' +
          '<div class="prechat-fields">' + fields + '</div>' +
          '<div class="prechat-spacer"></div><span class="btn skc"></span>' +
        '</div>' + footerHtml() +
      '</div>';
    }

    function skeletonArticlesHtml(vm) {
      vm = vm || {};
      return skViewOpen('wy-view-kb kb-root', vm) +
        skBarHtml('<span class="ttl">' + skl('110px', 14) + '</span>') +
        '<div class="sfield kb-search-wrap">' + skl('60%', 12) + '</div>' +
        '<div class="wy-scroll kb-scroll">' + skeletonArticleRowsHtml(5) + '</div>' +
        footerHtml() +
      '</div>';
    }

    function skeletonArticleHtml(vm) {
      vm = vm || {};
      var lines = ['96%', '88%', '92%', '70%', '94%', '61%', '86%', '48%'].map(function (w) { return skl(w, 11); }).join('');
      return skViewOpen('wy-view-kb kb-root kb-article-root', vm) +
        skBarHtml('<span class="ttl">' + skl('120px', 14) + '</span>') +
        '<div class="art wy-scroll"><h1>' + skl('80%', 18) + '</h1><div class="kb-article-body wy-sk-group">' + lines + '</div></div>' +
        '<div class="kb-feedback fb">' + skl('40%', 11) + '<span class="sp"></span><span class="face skc"></span><span class="face skc"></span></div>' +
        '<span class="cta skc"></span>' +
        footerHtml() +
      '</div>';
    }

    /**
     * Generic entry point Core calls with a normalized view key. Unknown
     * views fall back to the home skeleton.
     */
    function skeletonHtml(view, vm) {
      switch (String(view || '')) {
        case 'home': return skeletonHomeHtml(vm);
        case 'chat': return skeletonChatHtml(vm);
        case 'list': return skeletonListHtml(vm);
        case 'prechat': return skeletonPrechatHtml(vm);
        case 'help':
        case 'articles': return skeletonArticlesHtml(vm);
        case 'article': return skeletonArticleHtml(vm);
        default: return skeletonHomeHtml(vm);
      }
    }

    return {

      id: 't2',
      // The Core behaviours this design draws (runtime.js `feat()`).
      features: {
        homeAsk: true,
        topics: true,
        visitorName: true,
        conversationOperator: true,
        chatHeader: true,
        operatorTyping: true,
        emptyQna: true,
        prechatOperator: true,
        prechatSummary: true,
        kbSearch: true,
        kbCategories: true,
        kbArticleMeta: true,
        kbProgress: true,
        recSend: true,
        clock: true,
      },
      shellHtml: shellHtml,
      chatFrameHtml: chatFrameHtml,
      chatHeaderHtml: chatHeaderHtml,
      homeHtml: homeHtml,
      emptyHtml: emptyHtml,
      messagesHtml: messagesHtml,
      aiThinkingRowHtml: renderAiThinkingRow,
      qnaChipsHtml: qnaChipsHtml,
      messageAttachmentHtml: renderMessageAttachment,
      callInvitationCardHtml: renderCallInvitationCard,
      callEndedRowHtml: renderCallEndedRow,
      routingOutcomeRowHtml: renderRoutingOutcomeRow,
      prechatFieldRowHtml: renderPrechatFieldRow,
      prechatFormHtml: prechatFormHtml,
      handoffPrechatCardHtml: handoffPrechatCardHtml,
      prechatSummaryHtml: prechatSummaryHtml,
      contactFallbackHtml: contactFallbackHtml,
      smartSurfaceHtml: smartSurfaceHtml,
      // Generic contract extensions (template-agnostic surfaces).
      conversationListHtml: conversationListHtml,
      conversationRowHtml: conversationRowHtml,
      // Knowledge Base surfaces
      kbHtml: kbHtml,
      kbSearchBarHtml: kbSearchBarHtml,
      kbHomeHtml: kbHomeHtml,
      kbSearchResultsHtml: kbSearchResultsHtml,
      kbArticleHtml: kbArticleHtml,
      kbEmptyHtml: kbEmptyHtml,
      kbLoadingHtml: kbLoadingHtml,
      kbArticleFeedbackHtml: kbArticleFeedbackHtml,

      // Loading UX (optional presentation contract).
      skeletonHtml: skeletonHtml,
      connIndicatorHtml: connIndicatorHtml,

      format: {
        msgTime: formatMsgTime,
        callDuration: fmtCallDuration,
        invitationRemaining: fmtInvitationRemaining,
        humanSize: humanSize,
        clock: clock,
      },
    };
  }

  // The faces this locale's first paint draws with, so the panel opens in its
  // own typeface (waiting 500 ms at most). Only these are requested; every
  // other face stays on demand through its unicode-range
  // (presentation-default-fonts.css):
  //   - Persian: IRANSans 400, 500 and 600 (= the 700 file);
  //   - any other locale: Inter, the one Latin file.
  // `context` is { locale, templateId } from the loader and the live preview.
  // An older loader passes none: the Persian set.
  function prepare(context) {
    if (!document.fonts || typeof document.fonts.load !== 'function') return Promise.resolve();
    var c = context || {};
    var persian = String(c.locale || 'fa').toLowerCase().split('-')[0] === 'fa';
    var loads = [];
    if (persian) {
      [400, 500, 600].forEach(function (weight) {
        loads.push(document.fonts.load(weight + ' 16px IRANSans', 'سلام دنیا'));
      });
    } else {
      loads.push(document.fonts.load('500 16px InterWY', 'Aa'));
    }
    return Promise.race([
      Promise.all(loads.map(function (p) { return p.catch(function () { return []; }); })).then(function () {}),
      new Promise(function (resolve) { setTimeout(resolve, 500); }),
    ]);
  }

  window.__gs_presentation_t2 = { id: 't2', create: create, prepare: prepare };
})();
