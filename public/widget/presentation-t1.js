/**
 * Widget Presentation — the "t1" renderer.
 *
 * A template of the Iranian edition, offered next to `default` (the Super
 * Admin enables it and names it; the id is neutral and never shown): a
 * brand-gradient hero with floating cards, a bottom menu (Home, Messages,
 * Help), a single-box composer and an operator-side pre-chat card.
 * Registered under `window.__gs_presentation_t1` and resolved through
 * `presentation-registry.js`.
 *
 * CONTRACT (see docs/WIDGET_PRESENTATION_ARCHITECTURE.md)
 *   create(env) -> renderer
 *     env    = { t, escapeHtml, linkifyHtml, linkLabel, config, locale,
 *                primaryColor, capabilities }
 *     render = pure functions: (view-model) -> HTML string
 *   The renderer declares the optional Core behaviours it draws
 *   (`features`); Core runs those code paths only for a renderer that
 *   declares them.
 *
 * Rules for every presentation implementation:
 *   - NEVER touch transport, fetch, realtime, stores or the DOM.
 *   - NEVER read application state directly — everything arrives as a
 *     view-model argument produced by Widget Core.
 *   - Interaction is expressed with behaviour hooks (data-* attributes)
 *     that Core binds; visual classes carry no behavioural meaning.
 *   - Every view-model string is escaped; a URL is printed only when it is
 *     an ordinary web address (or a same-origin path, a blob or an inline
 *     image), never a `javascript:` one.
 */
(function () {
  'use strict';

  // Copy this template adds (Core's own keys are read through `t`): one
  // '|'-separated string per language, in the order of COPY_KEYS.
  var COPY_KEYS = 'msgs help nav unread all hi hiBack q team online reply away backAt note search searchAway recent newMsg type typing typingNow delivered retry b kb mb now teamOf cats connect introT introX priv privShort details locked saved edit skip phone awayEmail awayT helpQ count popular readT updated helpful yes no still talk'.split(' ');
  var DICT = {
    fa: 'پیام‌ها|راهنما|بخش‌های ویجت|{label}، {n} خوانده‌نشده|همه گفتگوها|سلام، خوش آمدید|سلام دوباره، {name}|چطور می‌توانیم کمکتان کنیم؟|گفتگو با تیم پشتیبانی|آنلاین|پاسخ در چند دقیقه|الان آفلاین هستیم|از ساعت {time} پاسخ می‌دهیم|پیامتان را بگذارید؛ پاسخ را به ایمیلتان می‌فرستیم و همین‌جا هم می‌بینید.|جستجو در راهنما|جوابتان شاید در راهنما باشد|پیام اخیر|ارسال پیام جدید|پیام خود را بنویسید…|{name} در حال نوشتن…|در حال نوشتن…|تحویل شد|تلاش دوباره|بایت|کیلوبایت|مگابایت|همین حالا|تیم پشتیبانی {name}|پرکاربرد,چهره‌ها,آدم‌ها و دست‌ها,قلب‌ها و نمادها,طبیعت,غذا و نوشیدنی|اتصال به پشتیبان|قبل از شروع، خودتان را معرفی کنید|اگر از سایت رفتید، پاسخ را برایتان می‌فرستیم.|اطلاعات شما فقط برای پاسخگویی استفاده می‌شود.|فقط برای پاسخگویی استفاده می‌شود|مشخصات شما|اول فرم بالا را تکمیل کنید|مشخصات شما ثبت شد|ویرایش|رد کردن|شماره موبایل|آفلاین · پاسخ از طریق ایمیل|تیم ما الان آفلاین است|سؤالتان را بنویسید…|{n} مقاله|پربازدیدترین‌ها|{n} دقیقه مطالعه|به‌روز شده {time}|این مقاله مفید بود؟|بله|نه|هنوز سؤال دارید؟|با تیم پشتیبانی گفتگو کنید',
    en: 'Messages|Help|Widget sections|{label}, {n} unread|All conversations|Hi, welcome|Welcome back, {name}|How can we help you?|Chat with our support team|Online|Replies in a few minutes|We are offline right now|We reply from {time}|Leave a message; we will email you the reply and you will see it here too.|Search help|Your answer may be in our help|Recent message|Send a new message|Write your message…|{name} is typing…|typing…|Delivered|Try again|B|KB|MB|Just now|{name} support team|Frequent,Faces,People and hands,Hearts and symbols,Nature,Food and drink|Connect to support|Before we start, introduce yourself|If you leave the site, we will send you the reply.|Your details are used only to reply to you.|Used only to reply to you|Your details|Fill in the form above first|Your details are saved|Edit|Skip|Mobile number|Offline · reply by email|Our team is offline right now|Type your question…|{n} articles|Most viewed|{n} min read|Updated {time}|Was this article helpful?|Yes|No|Still have a question?|Chat with our support team',
    tr: 'Mesajlar|Yardım|Widget bölümleri|{label}, {n} okunmamış|Tüm konuşmalar|Merhaba, hoş geldiniz|Tekrar merhaba, {name}|Size nasıl yardımcı olabiliriz?|Destek ekibiyle sohbet edin|Çevrimiçi|Birkaç dakika içinde yanıt|Şu an çevrimdışıyız|{time} itibarıyla yanıt veriyoruz|Mesajınızı bırakın; yanıtı e-postanıza göndeririz, burada da görürsünüz.|Yardımda ara|Yanıtınız yardımda olabilir|Son mesaj|Yeni mesaj gönder|Mesajınızı yazın…|{name} yazıyor…|yazıyor…|İletildi|Tekrar dene|B|KB|MB|Şimdi|{name} destek ekibi|Sık kullanılan,Yüzler,İnsanlar ve eller,Kalpler ve semboller,Doğa,Yiyecek ve içecek|Destekle bağlanın|Başlamadan önce kendinizi tanıtın|Siteden ayrılırsanız yanıtı size göndeririz.|Bilgileriniz yalnızca size yanıt vermek için kullanılır.|Yalnızca yanıt için kullanılır|Bilgileriniz|Önce yukarıdaki formu doldurun|Bilgileriniz kaydedildi|Düzenle|Atla|Cep telefonu|Çevrimdışı · e-postayla yanıt|Ekibimiz şu an çevrimdışı|Sorunuzu yazın…|{n} makale|En çok görüntülenen|{n} dk okuma|{time} güncellendi|Bu makale yardımcı oldu mu?|Evet|Hayır|Hâlâ sorunuz mu var?|Destek ekibimizle konuşun',
  };


  // Grouped emoji for the picker (renderer feature `emojiTabs`).
  var EMOJI = [
    '😍 🙏 👍 😊 😂 ❤️ 🌹 🎉',
    '😀 😁 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😎 🤩 🥳 😏',
    '👍 👎 👏 🙏 👋 🤝 ✌️ 👌 💪 🙌 🤲 👀 🙋 🤷 💁 🙆',
    '❤️ 🧡 💛 💚 💙 💜 🤍 🖤 💔 💕 💖 💯 ✨ 🔥 ⭐ ✅',
    '🌹 🌷 🌸 🌻 🍀 🌙 ☀️ 🌈 🐱 🐶 🦋 🐝 🌊 ❄️ 🌿 🍂',
    '☕ 🍰 🎂 🍫 🍕 🍔 🍎 🍉 🍓 🍇 🍩 🍪 🧁 🍦 🍵 🥤',
  ];

  // The platform's mark (hero watermark, footer). The Iran region's only:
  // the RESPOK build drops the block and keeps the empty string.
  var MARK = '';
  /* @iran-kit:begin */
  MARK = 'M42.28 27.95A12.4 12.4 0 0 0 21.7 17.01A12.4 12.4 0 0 0 30.43 38.62A7.75 7.75 0 0 0 22.95 46.14A0.43 0.43 0 0 1 22.56 46.56A21.7 21.7 0 0 0 42.28 27.95Z';
  /* @iran-kit:end */

  // ══════════════════════════════════════════════════════════════════
  // Colour: the accent, its brand default and the text colour on it. The
  // stylesheet derives every other shade from `--a` (OKLab color-mix, as
  // the design does, with an rgba fallback).
  // ══════════════════════════════════════════════════════════════════
  var BRAND = '#0b7d6c';
  function hexRgb(h) {
    var s = String(h || '').trim().toLowerCase().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/.test(s)) s = s.replace(/./g, '$&$&');
    return /^[0-9a-f]{6}$/.test(s) ? [0, 2, 4].map(function (i) { return parseInt(s.slice(i, i + 2), 16); }) : null;
  }
  function luminance(p) {
    return p.reduce(function (y, c, i) {
      c /= 255;
      return y + [0.2126, 0.7152, 0.0722][i] * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    }, 0);
  }
  /**
   * The accent tokens, as inline custom properties for each view root and
   * the close control. An uncustomised widget (no colour, or the product's
   * #3B82F6) wears the brand teal and its hand-tuned hero; `--on-a` is
   * white unless the dark ink (#16142B) reads better on the accent (WCAG
   * contrast); `--gs-primary` follows the accent so Core's focus ring does.
   */
  function accentTokens(primary) {
    var raw = String(primary || '').trim().toLowerCase();
    var rgb = hexRgb(raw);
    var p = !raw || raw === '#3b82f6' || !rgb ? hexRgb(BRAND) : rgb;
    var a = '#' + p.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('');
    var y = luminance(p);
    var dark = (y + 0.05) / (luminance([22, 20, 43]) + 0.05) > 1.05 / (y + 0.05);
    return {
      accent: a,
      dark: dark,
      css: '--a:' + a + ';--a-rgb:' + p.join(',') + ';--gs-primary:' + a +
        (dark ? ';--on-a:#16142B;--on-a-2:rgba(22,20,43,.78);--on-a-sf:rgba(22,20,43,.08)' : '') +
        (a === BRAND ? ';--hero:linear-gradient(155deg,#1DB99D 0%,#0F927D 46%,#0B7D6C 100%)' : ''),
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // Icons (24×24 strokes, round caps; the design's own paths)
  // ══════════════════════════════════════════════════════════════════
  function svg(body, size, sw, cls) {
    return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.8) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  function P(d) { return '<path d="' + d + '"/>'; }
  var D = {
    close: P('M6 6l12 12M18 6 6 18'),
    back: P('m10 6 6 6-6 6'),
    chev: P('m14 6-6 6 6 6'),
    search: '<circle cx="11" cy="11" r="6.5"/>' + P('m20 20-4.2-4.2'),
    emoji: '<circle cx="12" cy="12" r="8.5"/>' + P('M8.5 14.2c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8') +
      '<path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.6"/>',
    clip: P('M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.6 7.6a1.7 1.7 0 0 1-2.4-2.4l7-7'),
    trash: P('M4.5 7h15M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 1.8h6a2 2 0 0 0 2-1.8L18 7M9 7V4.5h6V7'),
    dl: P('M12 4v11M7 10l5 5 5-5M5 19.5h14'),
    err: '<circle cx="12" cy="12" r="8.5"/>' + P('M12 8v4.5M12 16h.01'),
    tick: P('m5 12.5 4 4 10-10'),
    ticks: P('m2.5 12.5 4 4 8-9M10.5 15.5l1 1 8-9'),
    person: '<circle cx="12" cy="8.5" r="3.8"/>' + P('M4.5 20c.9-3.6 3.9-5.5 7.5-5.5s6.6 1.9 7.5 5.5'),
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/>' + P('M8 10.5V8a4 4 0 0 1 8 0v2.5'),
    moon: P('M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'),
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/>' + P('m4 7 8 6 8-6'),
    okc: '<circle cx="12" cy="12" r="8.5"/>' + P('m8.5 12.2 2.4 2.4 4.6-4.8'),
    link: P('M8 16 16 8M9.5 8H16v6.5'),
    thumb: P('M7 10.5v9H4.5v-9zM7 10.5l4-7a2.2 2.2 0 0 1 2.5 2.6L13 9.5h5.3a2 2 0 0 1 2 2.4l-1.3 6a2 2 0 0 1-2 1.6H7'),
    img: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/>' + P('m20.5 16-5-5-8.5 8.5'),
    quote: P('M9 17l-5-5 5-5') + P('M4 12h10a5 5 0 0 1 5 5v2'),
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/>' + P('M5 15V5a2 2 0 0 1 2-2h8'),
    retry: P('M21 12a9 9 0 1 1-3.1-6.8') + P('M21 4v5h-5'),
    doc: P('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z') + P('M14 3v5h5'),
    book: P('M12 6.6C10.5 5.4 8.4 4.75 6 4.75c-.97 0-1.75.78-1.75 1.75v10.25c0 .97.78 1.75 1.75 1.75 2.4 0 4.5.65 6 1.85 1.5-1.2 3.6-1.85 6-1.85.97 0 1.75-.78 1.75-1.75V6.5c0-.97-.78-1.75-1.75-1.75-2.4 0-4.5.65-6 1.85Z') + P('M12 6.6v13.5'),
  };
  // KB category tiles: a category's `icon`, else the book.
  var CAT = {
    box: P('M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z') + P('M3.5 7.5 12 12l8.5-4.5M12 12v9'),
    card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/>' + P('M3 10h18M7 15h3'),
    tag: P('M20.5 13.5 13 21a1.4 1.4 0 0 1-2 0l-7.5-7.5V4.5a1 1 0 0 1 1-1h9z') + '<circle cx="8.5" cy="8.5" r="1.4"/>',
  };
  var SEND = '<svg class="pl" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4.1 3.2c-.8-.4-1.7.4-1.4 1.2l2.6 6.8c.1.3.4.5.7.5l7.5.3-7.5.3c-.3 0-.6.2-.7.5l-2.6 6.8c-.3.8.6 1.6 1.4 1.2l16.6-8c.8-.4.8-1.5 0-1.9z"/></svg>';
  var MIC = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="2.5" width="7" height="12.5" rx="3.5" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var PLAY = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.6v12.8a1.2 1.2 0 0 0 1.8 1l10.2-6.4a1.2 1.2 0 0 0 0-2L9.8 4.6A1.2 1.2 0 0 0 8 5.6z"/></svg>';
  var PAUSE = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
  var STOP = '<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="currentColor"/></svg>';
  // Bottom menu: one glyph per tab; the stylesheet fills the current one
  // (`.tb`) and turns its detail (`.td`) white.
  var TAB = {
    home: ['M3.75 11.3c0-.95.42-1.85 1.15-2.46l5.18-4.36a3 3 0 0 1 3.84 0l5.18 4.36c.73.61 1.15 1.51 1.15 2.46v6.2a3.25 3.25 0 0 1-3.25 3.25H7a3.25 3.25 0 0 1-3.25-3.25z',
      '<path class="td tf" d="M9.75 20.6v-3.6a2.25 2.25 0 0 1 4.5 0v3.6"/>'],
    list: ['M12 3.75c4.56 0 8.25 3.27 8.25 7.3s-3.69 7.3-8.25 7.3c-1.1 0-2.15-.19-3.11-.54l-3.63 1.38a.6.6 0 0 1-.79-.71l.83-3.05C4.36 14.15 3.75 12.66 3.75 11.05 3.75 7.02 7.44 3.75 12 3.75Z',
      '<path class="td tf" fill="currentColor" stroke="none" d="M8.5 9.9l1.2 1.2-1.2 1.2-1.2-1.2zM12 9.9l1.2 1.2-1.2 1.2-1.2-1.2zM15.5 9.9l1.2 1.2-1.2 1.2-1.2-1.2z"/>'],
    help: ['M12 6.6C10.5 5.4 8.4 4.75 6 4.75c-.97 0-1.75.78-1.75 1.75v10.25c0 .97.78 1.75 1.75 1.75 2.4 0 4.5.65 6 1.85 1.5-1.2 3.6-1.85 6-1.85.97 0 1.75-.78 1.75-1.75V6.5c0-.97-.78-1.75-1.75-1.75-2.4 0-4.5.65-6 1.85Z',
      '<path class="td" d="M12 6.6v13.5"/>'],
  };


  function create(env) {
    env = env || {};
    var t = env.t || function (k) { return k; };
    var config = env.config || {};
    var caps = env.capabilities || {};
    var workspaceName = String(config.workspaceName || config.brandName || '');
    var Util = {
      // Core always supplies this; the fallback still escapes (including
      // quotes, since output lands inside "…" attributes).
      escapeHtml: env.escapeHtml || function (v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      },
      // Linking is Core's (its scheme allow-list); without it, plain text.
      linkifyHtml: env.linkifyHtml || null,
    };
    var linkLabel = env.linkLabel || null;
    var ctx = { config: config, locale: env.locale, primaryColor: env.primaryColor };
    var lang = String(ctx.locale || 'en').toLowerCase().split('-')[0];
    var fa = lang === 'fa';
    var DIR = fa ? 'rtl' : 'ltr';
    var COPY = (DICT[lang] || DICT.en).split('|');
    var COPY_EN = DICT.en.split('|');
    var ACC = accentTokens(env.primaryColor);
    var TOK = ACC.css;
    var opts = (config.templateOptions && typeof config.templateOptions === 'object') ? config.templateOptions : {};
    var NAV_STYLE = /^v[a-d]$/.test(String(opts.navStyle)) ? String(opts.navStyle) : 'vb';
    var NAV_MODE = /^(both|active|icon|text|none)$/.test(String(opts.navMode)) ? String(opts.navMode) : 'active';
    var TEAM = Array.isArray(config.teamMembers) ? config.teamMembers : [];

    function esc(v) { return Util.escapeHtml(v); }
    // Core's anchors (scheme allow-listed, escaped); the stylesheet draws
    // them as link cards (the tile, the label, the address from `title`).
    function escLinked(v) {
      return Util.linkifyHtml ? Util.linkifyHtml(v, linkLabel || tf('msgOpenLink', 'Open link')) : esc(v);
    }
    function tf(key, fallback) {
      var v = t(key);
      return (v && v !== key) ? v : fallback;
    }
    /** This template's own copy (fa / en / tr; English otherwise). */
    function L(key) { var i = COPY_KEYS.indexOf(key); return i < 0 ? '' : COPY[i] || COPY_EN[i] || ''; }
    function fill(s, map) {
      return String(s).replace(/\{(\w+)\}/g, function (m, k) { return map[k] == null ? m : String(map[k]); });
    }
    function textFitsLocale(text) { return /[؀-ۿ]/.test(String(text)) === fa; }
    /** Persian digits in fa; every number this template prints goes through here. */
    function digits(s) {
      return fa ? String(s).replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'.charAt(+d); }) : String(s);
    }
    function fmtNum(n) { return digits(Number(n) || 0); }
    function fmtBadge(n) { n = Number(n) || 0; return n > 99 ? digits('99') + '+' : digits(n); }
    function fmtClock(sec) {
      var s = Math.max(0, Math.floor(Number(sec) || 0));
      return digits(Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60));
    }
    function fmtRate(r) { return digits(String(Number(r) || 1)).replace('.', fa ? '٫' : '.') + '×'; }
    function humanSize(bytes) {
      var n = Number(bytes) || 0;
      var u = n < 1024 ? 0 : n < 1048576 ? 1 : 2;
      var v = n / Math.pow(1024, u);
      return digits(v.toFixed(u && v < 10 ? 1 : 0)).replace('.', fa ? '٫' : '.') + ' ' + L(['b', 'kb', 'mb'][u]);
    }

    /** A URL that may be printed: web, protocol-relative, same-origin path, blob or inline image. */
    function safeUrl(u) {
      var s = String(u == null ? '' : u).trim();
      return !/["'<>\s\\]/.test(s) && /^(https?:\/\/|\/\/|\/[^/]|blob:|data:image\/(png|jpe?g|gif|webp);)/i.test(s) ? s : '';
    }
    function initialOf(name) {
      var s = String(name == null ? '' : name).trim();
      return (s ? Array.from(s)[0] : '').toUpperCase();
    }
    /** People keep one tile colour everywhere: their place in the team, else a hash of the name. */
    function tone(name) {
      var n = String(name || '');
      for (var i = 0; i < TEAM.length; i++) if (TEAM[i] && TEAM[i].name === n) return 'c' + (i % 3 + 1);
      var h = 0;
      for (var j = 0; j < n.length; j++) h = (h * 31 + n.charCodeAt(j)) >>> 0;
      return 'c' + (h % 3 + 1);
    }
    function dotHtml(online) {
      return online == null ? '' : '<span class="pr' + (online ? '' : ' off') + '"></span>';
    }
    /**
     * A person: their photo when one exists, else their initial on a soft
     * tile. Never an empty circle. `online` (true / false) adds the dot.
     */
    function avatarHtml(person, size, online) {
      person = person || {};
      var url = safeUrl(person.avatar_url || person.avatar);
      var name = String(person.name || '');
      if (!name && !url) return wsAvatar(size, online);
      return url
        ? '<span class="av ' + size + ' has-img"><img src="' + esc(url) + '" alt="" loading="lazy" decoding="async">' + dotHtml(online) + '</span>'
        : '<span class="av ' + size + ' ' + tone(name) + '" aria-hidden="true">' + esc(initialOf(name)) + dotHtml(online) + '</span>';
    }
    /** The workspace: its logo (when shown) or its initial on the reserved tile. */
    function wsAvatar(size, online) {
      var logo = config.showLogo === false ? '' : safeUrl(config.logoUrl);
      return logo
        ? '<span class="av ' + size + ' has-img ws"><img src="' + esc(logo) + '" alt="" loading="lazy" decoding="async">' + dotHtml(online) + '</span>'
        : '<span class="av ' + size + ' c4" aria-hidden="true">' + esc(initialOf(workspaceName) || 'W') + dotHtml(online) + '</span>';
    }
    function stackHtml(people, size, dim) {
      return people.length
        ? '<span class="avs' + (dim ? ' dim' : '') + '" aria-hidden="true">' +
            people.map(function (m) { return avatarHtml(m, size); }).join('') + '</span>'
        : '';
    }
    /** The team, those online first (the people a stack shows, who greets). */
    function teamPeople(members) {
      var team = (Array.isArray(members) ? members : TEAM).filter(function (m) { return m && m.name; });
      var on = team.filter(function (m) { return m.online; });
      return on.length ? on : team;
    }
    function lead() { return teamPeople()[0] || null; }
    function viewRoot(cls, extra) {
      return '<div class="wy-view ' + cls + (extra ? ' ' + extra : '') + '" dir="' + DIR + '" style="' + TOK + '">';
    }
    function replyText() {
      return typeof config.replyTimeText === 'string' && config.replyTimeText.trim() ? config.replyTimeText.trim() : L('reply');
    }
    function configOnline() {
      var av = config.availability || {};
      return av.state ? av.state === 'online' : true;
    }

    // ── Dates: Jalali in Tehran time for fa, unless the edition's hints
    // (config.calendar / timeZone) say Gregorian in the visitor's zone. ──
    var GREG = config.calendar === 'gregorian';
    var TZ = !GREG ? 'Asia/Tehran' : (typeof config.timeZone === 'string' && config.timeZone) || undefined;
    var DATE_TAG = fa ? (GREG ? 'fa-IR-u-ca-gregory' : 'fa-IR-u-ca-persian') : lang === 'tr' ? 'tr-TR' : 'en-US';
    function fmtDate(d, o, tag) {
      var x = d instanceof Date ? d : new Date(d);
      if (isNaN(x.getTime())) return '';
      try {
        if (fa && TZ) o.timeZone = TZ;
        return new Intl.DateTimeFormat(tag || DATE_TAG, o).format(x);
      } catch (_) { return ''; }
    }
    function dayKeyOf(d) { return fmtDate(d, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA'); }
    function rel(n, unit) {
      try { return new Intl.RelativeTimeFormat(fa ? 'fa' : lang, { numeric: 'auto' }).format(n, unit); } catch (_) { return ''; }
    }
    function dayLabelOf(d) {
      var key = dayKeyOf(d);
      var back = [0, 1].filter(function (i) { return key && key === dayKeyOf(Date.now() - i * 864e5); })[0];
      var r = back == null ? '' : rel(-back, 'day');
      return r ? r.charAt(0).toUpperCase() + r.slice(1) : key && fmtDate(d, { year: 'numeric', month: 'long', day: 'numeric' });
    }
    function dayDividerHtml(d) {
      var label = dayLabelOf(d);
      return label ? '<div class="msg-day"><span>' + esc(label) + '</span></div>' : '';
    }
    function formatMsgTime(d) {
      try {
        var date = (d instanceof Date) ? d : new Date(d);
        if (!date || isNaN(date.getTime())) return '';
        return date.toLocaleTimeString(ctx.locale || undefined, { hour: '2-digit', minute: '2-digit' });
      } catch (_) { return ''; }
    }
    /** When the team is back ("from 9:00"). */
    function awayLine(iso) {
      var time = iso ? fmtDate(iso, { hour: 'numeric', minute: '2-digit' }) : '';
      return time ? fill(L('backAt'), { time: time }) : tf('homeReplySlow', L('away'));
    }
    /** The "team is away" banner with when it is back. */
    function banHtml(cls, sub) {
      return '<div class="ban' + cls + '"><span class="lt">' + svg(D.moon, 18) + '</span><span><b>' + esc(L('awayT')) + '</b><small>' + esc(sub) + '</small></span></div>';
    }
    function relTime(iso) {
      var days = Math.round((Date.now() - new Date(iso).getTime()) / 864e5);
      return days >= 0 ? (days < 7 ? rel(-days, 'day') : days < 31 ? rel(-Math.round(days / 7), 'week') : rel(-Math.round(days / 30), 'month')) : '';
    }

    // ══════════════════════════════════════════════════════════════════
    // Shared pieces
    // ══════════════════════════════════════════════════════════════════
    function closeIcon(size) { return svg(D.close, size || 20, 1.9); }
    function backButtonHtml(target, extraAttrs) {
      return '<button type="button" class="ib bk wy-back" data-view-back="' + esc(target || 'home') + '"' + (extraAttrs || '') +
        ' aria-label="' + esc(tf('back', 'Back')) + '">' + svg(D.back, 20, 2, 'mir') + '</button>';
    }
    function markSvg(cls, fill) {
      return '<svg class="' + cls + '" viewBox="17 13.5 26 33.5" aria-hidden="true"><path fill="currentColor"' +
        (fill ? ' fill-rule="evenodd"' : '') + ' d="' + MARK + (fill ? 'M35.21 24.12L37.32 26.23L35.21 28.34L33.1 26.23ZM30 24.12L32.11 26.23L30 28.34L27.89 26.23ZM24.79 24.12L26.9 26.23L24.79 28.34L22.69 26.23Z' : '') +
        '"/></svg>';
    }
    function platformCredit() {
      if (config.showPoweredBy === false) return null;
      var pb = config.poweredBy || null;
      var platform = (pb && pb.brand) || config.platformName || '';
      return platform ? { pb: pb || {}, platform: platform } : null;
    }
    /**
     * Credits the PLATFORM, never the workspace (config.poweredBy, platform
     * admin owned; absent = not shown). The connection dot is a sibling of
     * the link, never part of it.
     */
    function footerHtml() {
      var c = platformCredit();
      if (!c) return '';
      var pb = c.pb;
      var label = (pb.text && textFitsLocale(pb.text)) ? pb.text : tf('poweredBy', 'Powered by');
      var url = /^https?:\/\//i.test(String(pb.url || '')) ? pb.url : '';
      var logo = typeof pb.logo === 'string' && /^https?:\/\//i.test(pb.logo) ? pb.logo : '';
      var inner = logo
        ? '<span>' + esc(label) + '</span><img class="wy-powered-logo" data-wy-brand-logo src="' + esc(logo) +
          '" alt="' + esc(c.platform) + '" decoding="async" draggable="false">'
        : (MARK ? markSvg('pw-mk', true) : '') + '<span>' + esc(label) + '</span> <b>' + esc(c.platform) + '</b>';
      return '<div class="wy-footer pw">' + connIndicatorHtml() + (url
        ? '<a class="wy-powered" href="' + esc(url) + '" target="_blank" rel="noopener nofollow" referrerpolicy="strict-origin-when-cross-origin">' + inner + '</a>'
        : '<span class="wy-powered">' + inner + '</span>') + '</div>';
    }
    function connIndicatorHtml() {
      return '<span class="wy-conn" data-conn-indicator aria-hidden="true"><span class="wy-conn-ring"></span><span class="wy-conn-dot"></span></span>';
    }
    /** Bottom menu (feature `tabs`): Core keeps `aria-current` and the badge. */
    function navHtml(active, unread) {
      if (NAV_MODE === 'none') return '';
      var n = Number(unread) || 0;
      function tab(view, key) {
        var g = TAB[view];
        var label = view === 'home' ? t('home') : L(key);
        var aria = view === 'list' && n ? fill(L('unread'), { label: label, n: fmtBadge(n) }) : label;
        return '<button type="button" class="wy-tab" data-view="' + view + '" aria-current="' + (active === view ? 'page' : 'false') +
          '" aria-label="' + esc(aria) + '"><span class="tic">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="tb" d="' + g[0] + '"/>' + g[1] + '</svg>' +
          (view === 'list' ? '<span class="nb" data-tab-badge' + (n ? '' : ' hidden') + '>' + (n ? fmtBadge(n) : '') + '</span>' : '') +
          '</span><span class="tl">' + esc(label) + '</span></button>';
      }
      return '<nav class="wy-tabs ' + NAV_STYLE + '" aria-label="' + esc(L('nav')) + '">' +
        tab('home', 'home') + tab('list', 'msgs') + tab('help', 'help') + '</nav>';
    }
    function liveHtml(on) { return '<span class="live' + (on ? '' : ' off') + '"></span>'; }
    function chevHtml() { return svg(D.chev, 18, 2, 'ch mir'); }
    /** A screen title row (Messages, Help); its back shows only without a menu. */
    function titleRowHtml(title, cls) {
      return '<div class="ttl wy-head ' + cls + '">' + backButtonHtml('home') + '<h2>' + esc(title) + '</h2></div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Chat surfaces
    // ══════════════════════════════════════════════════════════════════
    function qnaChipsHtml(qnaState) {
      qnaState = qnaState || {};
      var collapsed = qnaState.collapsedCount || 3;
      var all = qnaState.questions || [];
      var visible = qnaState.expanded ? all : all.slice(0, collapsed);
      var remaining = all.length - visible.length;
      return '<div class="qna-suggestions" data-qna><div class="qna-title sr-only">' + esc(t('qnaTitle')) + '</div><div class="qna-chips chips">' +
        visible.map(function (q) {
          var text = (q && q.question) ? String(q.question) : '';
          return text ? '<button type="button" class="chip qna-chip" data-qna-question="' + esc(text) + '">' + esc(text) + '</button>' : '';
        }).join('') +
        (!qnaState.expanded && remaining > 0
          ? '<button type="button" class="chip qna-more-btn" data-qna-more>' + esc(t('qnaMore')) +
              '<span class="qna-more-count">+' + esc(digits(remaining)) + '</span></button>'
          : '') +
      '</div></div>';
    }

    /**
     * The empty thread (features `emptyQna`, `topics`, `operatorTyping`,
     * `prechatSummary`): the team, the workspace's welcome (one bubble per
     * paragraph), its topics or Q&A, a typing row and the saved details.
     */
    function emptyHtml(vm) {
      vm = vm || {};
      var ai = config.aiAgent;
      if (ai && ai.suppressGreeting === true) {
        return '<div class="messages welcome-only">' + (vm.prechatSummaryHtml || '') + '</div>';
      }
      var welcome = (typeof config.welcomeMessage === 'string' && config.welcomeMessage.trim()) ? config.welcomeMessage : t('intro');
      var paras = String(welcome || '').split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
      var people = teamPeople().slice(0, 3);
      var who = people[0];
      var topics = (Array.isArray(vm.topics) ? vm.topics : []).filter(function (x) { return x && x.label; }).slice(0, 4);
      var chips = topics.length
        ? '<div class="chips topics">' + topics.map(function (x) {
            return '<button type="button" class="chip" data-topic="' + esc(x.label) + '">' + esc(x.label) + '</button>';
          }).join('') + '</div>'
        : (vm.qna && vm.qna.questions && vm.qna.questions.length ? qnaChipsHtml(vm.qna) : '');
      var online = configOnline();
      return '<div class="messages welcome-only">' +
        '<div class="wel">' + (people.length ? stackHtml(people, 's48') : wsAvatar('s48')) +
          '<h3>' + esc(fill(L('teamOf'), { name: workspaceName })) + '</h3>' +
          '<p>' + liveHtml(online) + esc(online ? replyWelcome() : awayLine((config.availability || {}).next_open_at)) + '</p>' +
        '</div><div class="sep"></div>' +
        (paras.length
          ? '<div class="msg-row operator is-first is-last welcome-row">' + (who ? avatarHtml(who, 's28') : wsAvatar('s28')) +
              '<div class="msg-col">' + paras.map(function (p) {
                return '<div class="msg-line"><div class="msg operator welcome-bubble">' + esc(p) + '</div></div>';
              }).join('') +
              '<div class="msg-footline"><div class="msg-meta"><span class="msg-time">' + esc(L('now')) + '</span></div></div>' +
            '</div></div>'
          : '') +
        chips + typingRowHtml(vm.operatorTyping) + (vm.prechatSummaryHtml || '') +
      '</div>';
    }
    function replyWelcome() {
      return typeof config.replyTimeText === 'string' ? config.replyTimeText.trim() : tf('homeReplyFast', L('reply'));
    }

    function fileKind(att) {
      var ext = (/\.([a-z0-9]{1,4})$/i.exec(String(att.file_name || '')) || [])[1] ||
        (/\/([a-z0-9]{1,4})$/i.exec(String(att.mime_type || '')) || [])[1] || '';
      return ext.toUpperCase();
    }

    // Real attachments — authenticated media is loaded by Core through the
    // data-att-media-src / data-att-download hooks.
    function renderMessageAttachment(att) {
      if (!att || !att.id) return '';
      var id = esc(att.id);
      var name = esc(att.file_name || 'file');
      var size = humanSize(att.size_bytes);
      var isImage = att.kind === 'image' || /^image\//.test(String(att.mime_type || ''));
      var isAudio = att.kind === 'audio' || /^audio\//.test(String(att.mime_type || ''));
      if (isImage) {
        return '<div class="msg-att msg-att-image">' +
          '<button type="button" class="msg-att-img-btn is-loading" data-att-preview="' + id + '" aria-label="' + esc(t('openFile')) + '">' +
            '<span class="msg-att-loading" aria-live="polite">' + svg(D.img, 30, 1.5) +
              '<span class="sr-only">' + esc(tf('receivingFile', 'Receiving…')) + '</span></span>' +
            '<img loading="lazy" decoding="async" data-att-media-src="' + id + '" alt="' + name + '">' +
            '<span class="msg-att-img-fallback">' + esc(t('imageUnavailable')) + '</span>' +
            '<span class="capn"><span dir="auto">' + name + '</span><span>' + esc(size) + '</span></span>' +
          '</button>' +
        '</div>';
      }
      if (isAudio) {
        // Play at the start of the line, the time at its end; the timeline
        // itself stays left→right (audio runs that way everywhere).
        return '<div class="msg-att msg-att-audio" data-audio-player>' +
          '<audio preload="metadata" data-att-media-src="' + id + '" data-audio-el></audio>' +
          '<button type="button" class="wy-ap-play" data-audio-toggle aria-label="' + esc(t('playAudio')) + '">' +
            '<span class="wy-ap-ico wy-ap-ico-play">' + PLAY + '</span><span class="wy-ap-ico wy-ap-ico-pause">' + PAUSE + '</span>' +
            '<span class="wy-ap-spinner" aria-hidden="true"></span></button>' +
          '<div class="wy-ap-body"><div class="wy-ap-track" data-audio-seek dir="ltr">' +
            '<div class="wy-ap-buffer" data-audio-buffer></div>' +
            '<div class="wy-ap-progress" data-audio-progress><span class="wy-ap-knob"></span></div></div></div>' +
          '<span class="wy-ap-time" data-audio-time>' + fmtClock(0) + '</span>' +
          '<button type="button" class="wy-ap-rate" data-audio-rate>' + fmtRate(1) + '</button>' +
          '<a class="wy-ap-dl" href="#" data-att-download="' + id + '" data-att-download-name="' + name +
            '" aria-label="' + esc(t('download')) + '">' + svg(D.dl, 15, 1.9) + '</a>' +
        '</div>';
      }
      var kind = fileKind(att);
      return '<div class="msg-att msg-att-file">' +
        '<span class="msg-att-icon ft' + (kind === 'PDF' ? ' pdf' : '') + '" aria-hidden="true">' + esc(kind || '•') + '</span>' +
        '<div class="msg-att-meta"><div class="msg-att-name" dir="auto" title="' + name + '">' + name + '</div>' +
          '<div class="msg-att-sub">' + esc(size) + '</div></div>' +
        '<a class="msg-att-action ib" href="#" data-att-download="' + id + '" data-att-download-name="' + name +
          '" aria-label="' + esc(tf('download', 'Download') + ' ' + (att.file_name || '')) + '">' + svg(D.dl, 16, 1.9) + '</a>' +
      '</div>';
    }

    // Call surfaces: Core's own copy (`t` always answers its keys).
    function fmtInvitationRemaining(expiresAtIso) {
      var ms = new Date(expiresAtIso).getTime() - Date.now();
      if (!isFinite(ms) || ms <= 0) return t('ciStateExpired');
      var total = Math.ceil(ms / 1000);
      var m = Math.floor(total / 60);
      var s = total % 60;
      return digits(t('ciTimeLeft').replace('{time}', total < 60 ? t('ciSeconds').replace('{s}', total)
        : (s ? t('ciMinutesSeconds') : t('ciMinutes')).replace('{m}', m).replace('{s}', s)));
    }

    function fmtCallDuration(seconds) {
      var s = Math.max(0, Math.floor(Number(seconds) || 0));
      function pad(n) { return (n < 10 ? '0' : '') + n; }
      return digits((s >= 3600 ? pad(Math.floor(s / 3600)) + ':' : '') + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60));
    }

    function systemPillHtml(icon, text) {
      return '<div class="msg-row system"><div class="msg-system-pill">' + icon + '<span>' + esc(text) + '</span></div></div>';
    }

    function renderCallEndedRow(msg) {
      var meta = msg.metadata || {};
      var dur = Number(meta.duration_seconds) || 0;
      var by = String(meta.ended_by || 'system');
      var key = meta.end_reason === 'failed' || dur <= 0 ? 'csEndedNotConnected'
        : by === 'operator' ? 'csEndedByOperator' : by === 'visitor' ? 'csEndedByVisitor' : 'csEndedBySystem';
      return systemPillHtml(svg(P('M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 8.63 18.5') + P('M23 1 1 23'), 12, 2),
        String(t(key)).replace('{duration}', fmtCallDuration(dur)));
    }

    function renderRoutingOutcomeRow(msg) {
      var meta = msg.metadata || {};
      var kind = meta.kind;
      // A transfer between operators reads, from here, as the next person arriving.
      var joined = kind === 'routing_agent_joined' || kind === 'conversation_transferred';
      var name = String(meta.agent_name || meta.to_name || '');
      var text = joined
        ? (name ? String(t('routingAgentJoined')).replace('{name}', name) : t('routingAgentJoinedGeneric'))
        : t(kind === 'routing_no_agent_available' ? 'routingNoAgentAvailable' : 'routingInQueue');
      return systemPillHtml(liveHtml(joined), text);
    }

    function renderCallInvitationCard(msg) {
      var meta = msg.metadata || {};
      var video = meta.channel === 'video';
      var channel = video ? 'video' : 'audio';
      var status = meta.status || 'pending';
      var inviteId = esc(meta.invitation_id || '');
      var headline = String(t('ciHeadline' + (video ? 'Video' : 'Audio') + (meta.operator_name ? 'From' : '')))
        .replace('{op}', meta.operator_name || '');
      var icon = video
        ? svg('<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>', 20, 2)
        : svg(P('M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z'), 20, 2);
      var body = '';
      if (status === 'pending') {
        var wait = typeof meta.wait_minutes === 'number' && meta.wait_minutes > 0 ? Math.round(meta.wait_minutes) : 0;
        if (!wait && meta.expires_at) {
          var delta = new Date(meta.expires_at).getTime() - new Date(msg.createdAt || Date.now()).getTime();
          if (delta > 0) wait = Math.max(1, Math.round(delta / 60000));
        }
        var waitLine = wait === 1 ? t('ciWaitOneMinute') : wait > 1 ? String(t('ciWaitMinutes')).replace('{m}', digits(wait)) : '';
        body = '<div class="ci-body"><div>' + esc(t(video ? 'ciBodyVideo' : 'ciBodyAudio')) + '</div>' +
            (waitLine ? '<div class="ci-wait">' + esc(waitLine) + '</div>' : '') + '</div>' +
          '<div class="ci-meta ci-countdown" aria-live="polite"><span class="ci-pulse" aria-hidden="true"></span>' +
            esc(fmtInvitationRemaining(meta.expires_at)) + '</div>';
      } else {
        var st = { joined: 'ciStateJoined', expired: 'ciStateExpired', cancelled: 'ciStateCancelled', declined: 'ciStateDeclined' }[status];
        body = '<div class="ci-meta ci-status ci-status-' + esc(status) + '">' + esc(st ? t(st) : '') + '</div>';
      }
      return '<div class="msg-row system">' +
        '<div class="ci-card ci-channel-' + channel + ' ci-status-' + esc(status) + '" data-ci-card="' + inviteId +
          '" role="group" aria-label="' + esc(t('ciAriaCard') + ' — ' + t(video ? 'videoCall' : 'voiceCall')) + '">' +
          '<div class="ci-row"><span class="ci-icon" aria-hidden="true">' + icon + '</span>' +
            '<div class="ci-text"><div class="ci-title">' + esc(headline) + '</div>' + body + '</div></div>' +
          (status === 'pending'
            ? '<div class="ci-actions">' +
                '<button type="button" class="ci-btn ci-btn-primary" data-ci-action="join" data-ci-id="' + inviteId +
                  '" data-ci-channel="' + channel + '" aria-label="' + esc(t(video ? 'ciAriaJoinVideo' : 'ciAriaJoinAudio')) + '">' +
                  esc(t(video ? 'ciJoinVideo' : 'ciJoinAudio')) + '</button>' +
                '<button type="button" class="ci-btn ci-btn-ghost" data-ci-action="decline" data-ci-id="' + inviteId +
                  '" aria-label="' + esc(t('ciAriaDecline')) + '">' + esc(t('ciDecline')) + '</button>' +
              '</div>'
            : '') +
        '</div>' +
      '</div>';
    }

    // Field visibility/required state is server-authoritative (identity).
    function fieldHtml(hook, key, type, value, req) {
      var id = (hook === 'fb' ? 'fb-' : 'prechat-') + key;
      var label = key === 'phone' ? L('phone') : t(key === 'message' ? 'fallbackMessageLabel' : key);
      var ph = key === 'message' ? L('type') : t('prechat' + key.charAt(0).toUpperCase() + key.slice(1) + 'Ph') || label;
      return '<div class="prechat-field fld" data-field="' + key + '">' +
          '<label class="prechat-label" for="' + id + '">' + esc(label) +
            (req ? '<span class="prechat-req-mark rq" aria-label="' + esc(t('required')) + '">*</span>' : ' <span class="op">(' + esc(t('prechatOptional')) + ')</span>') +
          '</label>' +
          '<div class="prechat-control">' + (key === 'message'
            ? '<textarea id="' + id + '" class="prechat-input prechat-textarea inp" data-fb="message" rows="3"'
            : '<input id="' + id + '" class="prechat-input inp" data-' + hook + '="' + key + '" type="' + type +
              '" autocomplete="' + (key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel') + '"' + (key !== 'name' ? ' dir="ltr"' : '') +
              ' value="' + esc(value || '') + '"') +
            ' placeholder="' + esc(ph) + '"' + (req ? ' aria-required="true"' : '') + ' aria-invalid="false" aria-describedby="' +
            (hook === 'fb' ? 'fb-err-' : 'prechat-err-') + key + '">' + (key === 'message' ? '</textarea>' : '') +
            (hook === 'fb' ? '' : '<span class="prechat-status" aria-hidden="true"></span>') +
          '</div>' +
          '<div class="prechat-error err" id="' + (hook === 'fb' ? 'fb-err-' : 'prechat-err-') + key + '" data-err="' + key + '" role="alert" aria-live="polite"></div>' +
        '</div>';
    }
    function renderPrechatFieldRow(identity, key, type, value) {
      return fieldHtml('prechat', key, type, value, identity.isRequired(key));
    }
    function askedFields(identity, contact) {
      return ['name', 'email', 'phone'].filter(function (k) { return identity.isAsked(k); }).map(function (k) {
        return renderPrechatFieldRow(identity, k, k === 'name' ? 'text' : k === 'email' ? 'email' : 'tel', contact[k]);
      }).join('');
    }

    /**
     * Splits a body with a leading quote block ("> quoted line(s)", a blank
     * line, then the reply) into { quote, rest } — the wire format of a
     * visitor's quoted reply.
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

    function botPerson() {
      var ai = config.aiAgent || {};
      return { name: ai.agentName || '', avatar: ai.agentLogoUrl || '' };
    }
    function pendingRow(cls, who, inner, meta) {
      return '<div class="msg-row operator is-last ' + cls + '">' + avatarHtml(who, 's28 msg-avatar') +
        '<div class="msg-col"><div class="msg-line"><div class="msg operator typing-bubble">' +
          '<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>' + inner + '</div></div>' +
          (meta ? '<div class="msg-footline"><div class="msg-meta">' + esc(meta) + '</div></div>' : '') + '</div></div>';
    }
    function renderAiThinkingRow() {
      return pendingRow('ai-thinking-row', botPerson(), '<span class="sr-only">' + esc(t('aiThinking')) + '</span>');
    }
    /** The visible "{name} is typing" row (feature `operatorTyping`); the sr-only announcer stays Core's. */
    function typingRowHtml(who) {
      return who ? pendingRow('typing-row" aria-hidden="true', who, '', who.name ? fill(L('typing'), { name: who.name }) : L('typingNow')) : '';
    }

    function tickHtml(status) {
      if (status === 'seen') return '<span class="msg-ticks is-seen" role="img" aria-label="' + esc(t('msgSeen')) + '">' + svg(D.ticks, 16, 2) + '</span>';
      if (status === 'delivered') return '<span class="msg-ticks" role="img" aria-label="' + esc(L('delivered')) + '">' + svg(D.ticks, 16, 2) + '</span>';
      return '<span class="msg-ticks" role="img" aria-label="' + esc(t('msgSent')) + '">' + svg(D.tick, 15, 2.2) + '</span>';
    }

    function isSystemRow(m) {
      var k = m.senderType === 'system' && m.metadata && m.metadata.kind;
      return k === 'call_invitation' || k === 'call_ended' || k === 'routing_agent_joined' ||
        k === 'conversation_transferred' || k === 'routing_no_agent_available' || k === 'routing_in_queue';
    }

    function messagesHtml(s, extraRowHtml, view) {
      view = view || {};
      var typewriter = view.typewriter || null;
      var qnaState = view.qna || { questions: [], expanded: false };
      var rrCfg = config.readReceipts;
      var receiptsEnabled = !rrCfg || rrCfg.enabled !== false;
      var msgs = s.messages || [];
      // Shown by the stylesheet only while the header says the team is away.
      var html = '<div class="messages">' + banHtml(' ban-row', awayLine((config.availability || {}).next_open_at));
      // A run = consecutive messages of one author on one day; system rows break runs.
      var keys = msgs.map(function (m, i) {
        if (isSystemRow(m)) return 's' + i;
        return (m.sender === 'visitor' ? 'v' : 'o:' + (m.senderName || '') + '|' + (m.senderAvatar || '') + '|' + (m.senderType === 'ai' ? 1 : 0)) +
          '@' + dayKeyOf(m.time);
      });
      var visitorHasReplied = msgs.some(function (m) { return m.sender === 'visitor'; });
      var lastDayKey = '';
      var lastLabel = '';

      msgs.forEach(function (m, idx) {
        var dk = dayKeyOf(m.time);
        if (dk && dk !== lastDayKey) { html += dayDividerHtml(m.time); lastDayKey = dk; }
        if (isSystemRow(m)) {
          var kind = m.metadata.kind;
          html += kind === 'call_invitation' ? renderCallInvitationCard(m)
            : kind === 'call_ended' ? renderCallEndedRow(m) : renderRoutingOutcomeRow(m);
          return;
        }
        var visitor = m.sender === 'visitor';
        var cls = visitor ? 'visitor' : 'operator';
        var isAi = m.senderType === 'ai';
        var hasText = m.body && String(m.body).trim().length > 0;
        var att = m.attachment;
        var attHtml = renderMessageAttachment(att);
        var attKind = !attHtml ? '' : (att.kind === 'image' || /^image\//.test(String(att.mime_type || ''))) ? 'img'
          : (att.kind === 'audio' || /^audio\//.test(String(att.mime_type || ''))) ? 'voice' : 'file';
        var isFirst = idx === 0 || keys[idx - 1] !== keys[idx];
        var isLast = idx === msgs.length - 1 || keys[idx + 1] !== keys[idx];
        var failed = visitor && m.status === 'failed';

        var statusHtml = '';
        if (visitor && isLast && failed) {
          // Shown whatever the receipts setting: an error the visitor can act on.
          statusHtml = '<span class="msg-ticks is-failed">' + svg(D.err, 14, 2.2) + '<b>' + esc(t('msgFailed')) + '</b></span>' +
            '<span aria-hidden="true">·</span><button type="button" class="msg-retry-btn" data-msg-retry="' + esc(m.localId || '') +
              '">' + esc(L('retry')) + '</button>';
        } else if (visitor && isLast && receiptsEnabled && m.status) {
          statusHtml = m.status === 'sending'
            ? '<span class="msg-ticks is-sending" aria-label="' + esc(t('msgSending')) + '"><span class="msg-status-spinner" aria-hidden="true"></span></span>'
            : tickHtml(m.status);
        }

        // Operator rows: the avatar beside the run's last bubble, a spacer
        // beside the others (photo, else the initial; automated = workspace).
        var avatar = '';
        if (!visitor) {
          avatar = !isLast ? '<span class="msg-avatar msg-avatar-spacer" aria-hidden="true"></span>'
            : isAi ? avatarHtml(botPerson(), 's28 msg-avatar')
            : avatarHtml({ name: m.senderName, avatar: m.senderAvatar }, 's28 msg-avatar');
        }
        // The sender's name over a run, when the person changes.
        var label = '';
        if (!visitor && isFirst && !isAi && m.senderName && m.senderName !== lastLabel) {
          label = '<span class="msg-sender-label">' + esc(m.senderName) + '</span>';
        }
        if (!visitor && isFirst) lastLabel = isAi ? '' : (m.senderName || '');

        var aiMeta = (isAi && isLast)
          ? '<span class="msg-ai-badge">' + esc(tf('wyAiShort', 'AI')) + '</span>' +
            (m.senderName ? '<span class="msg-sender">' + esc(m.senderName) + '</span>' : '')
          : '';
        var timeStr = formatMsgTime(m.time);
        var metaHtml = isLast && (timeStr || statusHtml || aiMeta)
          ? '<div class="msg-meta">' + aiMeta + (timeStr ? '<span class="msg-time">' + esc(timeStr) + '</span>' : '') + statusHtml + '</div>'
          : '';

        var parsed = splitQuotedBody(m.body);
        var quoteText = (m.replyTo && (m.replyTo.text || m.replyTo.body)) || parsed.quote || '';
        var bodyText = parsed.quote ? parsed.rest : m.body;
        var quoteAuthor = '';
        if (!m.replyTo && parsed.quote) {
          var qa = /^([^:\n]{1,40}):\s+([\s\S]+)$/.exec(parsed.quote);
          if (qa) { quoteAuthor = qa[1]; quoteText = qa[2]; }
        }

        var isTypingThis = !!(typewriter && typewriter.id === m.__id);
        var isRevealing = isTypingThis && typewriter.revealedCount < typewriter.tokens.length;
        var displayText = isRevealing ? typewriter.tokens.slice(0, Math.max(1, typewriter.revealedCount)).join('') : bodyText;
        var textHtml = (isRevealing || (displayText && String(displayText).length))
          ? '<span class="msg-text"' + (isRevealing ? ' data-typing-id="' + esc(m.__id) + '"' : '') + '>' +
              (isRevealing ? esc(displayText) : escLinked(displayText)) + '</span>'
          : '';
        var quoted = quoteText
          ? '<span class="msg-quote">' + (quoteAuthor ? '<b>' + esc(quoteAuthor) + '</b>' : '') + esc(String(quoteText)) + '</span>'
          : '';
        var actionsHtml = hasText
          ? '<span class="msg-actions">' +
              '<button type="button" class="msg-act" data-msg-reply="' + esc(m.__id || '') +
                '" data-msg-reply-text="' + esc(String(bodyText || m.body || '').slice(0, 200)) +
                '" data-msg-reply-author="' + esc(visitor ? tf('you', 'You') : (m.senderName || t('operator'))) +
                '" aria-label="' + esc(tf('reply', 'Reply')) + '">' + svg(D.quote, 13) + '</button>' +
              '<button type="button" class="msg-act" data-msg-copy="' + esc(String(bodyText || m.body || '')) +
                '" aria-label="' + esc(tf('copy', 'Copy')) + '">' + svg(D.copy, 13, 1.7) + '</button>' +
            '</span>'
          : '';

        html += '<div class="msg-row ' + cls + (isFirst ? ' is-first' : '') + (isLast ? ' is-last' : '') + (failed ? ' is-failed' : '') + '">' + avatar +
          '<div class="msg-col">' + label +
            '<div class="msg-line">' +
              '<div class="msg ' + cls + (attKind ? ' att-' + attKind : '') + (attHtml && !hasText ? ' has-att-only' : attHtml ? ' has-att' : '') +
                (isAi ? ' is-ai' : '') + (isLast ? ' has-tail' : '') + '"' +
                (isRevealing ? ' data-typing-host data-typing-active="1"' : '') + '>' + quoted + textHtml + attHtml +
              '</div>' + actionsHtml +
            '</div>' +
            (metaHtml ? '<div class="msg-footline">' + metaHtml + '</div>' : '') +
          '</div>' +
        '</div>';

        var isIntro = m.metadata && m.metadata.source === 'ai_agent_intro';
        if (isIntro && !visitorHasReplied && qnaState.questions && qnaState.questions.length) html += qnaChipsHtml(qnaState);
      });

      if (extraRowHtml) html += extraRowHtml;
      var lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      var waitingOnAi = !!lastMsg && (lastMsg.sender === 'visitor' || lastMsg.from === 'visitor' || lastMsg.author === 'visitor');
      if (s.aiThinking && waitingOnAi) html += renderAiThinkingRow();
      html += typingRowHtml(view.operatorTyping);
      return html + '</div>';
    }

    /**
     * The pre-chat card on the OPERATOR's side of the thread (feature
     * `prechatOperator`): the subtitle bubble joined to the form card; a
     * "skip" only when nothing is required.
     */
    function handoffPrechatCardHtml(identity, contact, locale, subtitle, animateSubtitle) {
      contact = contact || {};
      var fieldsHtml = askedFields(identity, contact);
      var any = ['name', 'email', 'phone'].some(function (k) { return identity.isAsked(k) && identity.isRequired(k); });
      var dir = String(locale || '').toLowerCase().split('-')[0] === 'fa' ? 'rtl' : 'ltr';
      var who = lead();
      return '<div class="msg-row operator is-first is-last hc-row">' + (who ? avatarHtml(who, 's28 msg-avatar') : wsAvatar('s28 msg-avatar')) +
        '<div class="msg-col">' +
          (animateSubtitle
            ? '<div class="msg operator hc-subtitle" data-typing-host data-typing-active="1" data-typing-id="hc-subtitle"></div>'
            : (subtitle ? '<div class="msg operator hc-subtitle">' + esc(subtitle) + '</div>' : '')) +
          '<div class="hc-card fcard" dir="' + dir + '" role="group" aria-label="' + esc(L('details')) + '">' +
            '<h4 class="hc-title"><span class="lt">' + svg(D.person, 15, 1.9) + '</span>' + esc(L('details')) + '</h4>' +
            '<div class="prechat-fields hc-fields">' + fieldsHtml + '</div>' +
            '<button type="button" class="btn btn-p sm hc-submit" data-prechat-submit>' + esc(tf('homeStartChat', t('continue'))) + SEND + '</button>' +
            (any ? '' : '<button type="button" class="hc-skip" data-prechat-skip>' + esc(L('skip')) + '</button>') +
            '<p class="priv">' + svg(D.lock, 12, 2) + esc(L('privShort')) + '</p>' +
          '</div>' +
          '<div class="msg-footline"><div class="msg-meta"><span class="msg-time">' + esc(L('now')) + '</span></div></div>' +
        '</div>' +
      '</div>';
    }

    /** The saved details, once, after a successful pre-chat submit (feature `prechatSummary`). */
    function prechatSummaryHtml(contact) {
      contact = contact || {};
      var rows = [['name', t('name')], ['email', t('email')], ['phone', L('phone')]].filter(function (r) {
        return contact[r[0]] && String(contact[r[0]]).trim();
      }).map(function (r) {
        return '<div class="rw"><span>' + esc(r[1]) + '</span><b' + (r[0] === 'name' ? '' : ' dir="ltr"') + '>' + esc(contact[r[0]]) + '</b></div>';
      }).join('');
      return rows && '<div class="msg-row system sum-row"><div class="sum" role="group" aria-label="' + esc(L('saved')) + '">' +
        '<div class="sh2">' + svg(D.okc, 16, 2.2) + '<span>' + esc(L('saved')) + '</span>' +
          '<button type="button" class="sum-edit" data-prechat-edit>' + esc(L('edit')) + '</button></div>' + rows +
      '</div></div>';
    }

    /** Who a screen is about: [avatar] title / subtitle. */
    function whoHtml(avatar, title, subtitle) {
      return '<div class="who">' + (avatar || '') + '<span class="who-x"><span class="hn">' + esc(title) + '</span>' +
        (subtitle ? '<span class="hs">' + esc(subtitle) + '</span>' : '') + '</span></div>';
    }
    /** A 68px screen header: back, who; the shell's close sits at its end. */
    function headHtml(cls, back, who) {
      return '<div class="hd wy-head' + cls + '">' + back + who + '</div>';
    }

    /** Full-screen pre-contact view. Fields and markers come from the server's identity contract. */
    function prechatFormHtml(identity, contact, locale) {
      contact = contact || {};
      var fieldsHtml = askedFields(identity, contact);
      return viewRoot('wy-view-precontact prechat') +
        headHtml('', backButtonHtml('home'), whoHtml('', L('connect'), workspaceName)) +
        '<div class="wy-scroll wy-body-pad fm">' +
          '<div class="intro prechat-subtitle"><span class="lt">' + svg(D.person, 18) + '</span><span><b>' + esc(L('introT')) + '</b>' +
            esc(L('introX')) + '</span></div>' +
          '<div class="prechat-fields">' + fieldsHtml + '</div>' +
          '<div class="prechat-spacer" aria-hidden="true"></div>' +
          '<div class="fm-end"><button type="button" class="btn btn-p prechat-submit" data-prechat-submit>' +
            esc(tf('homeStartChat', t('continue'))) + SEND + '</button>' +
            '<p class="priv">' + svg(D.lock, 13, 2) + esc(L('priv')) + '</p></div>' +
        '</div>' + footerHtml() +
      '</div>';
    }

    /** Leave-a-message form (the team is away, or chat cannot reach anyone). */
    function contactFallbackHtml(identity, contact, locale, presence) {
      contact = contact || {};
      var intro = (presence && presence.introLabel) ? presence.introLabel : t('fallbackIntro');
      var askPhone = identity.isAsked('phone');
      var fieldsHtml = fieldHtml('fb', 'name', 'text', contact.name, identity.isRequired('name')) +
        fieldHtml('fb', 'email', 'email', contact.email, !askPhone) +
        (askPhone ? fieldHtml('fb', 'phone', 'tel', contact.phone, identity.isRequired('phone')) : '') +
        fieldHtml('fb', 'message', '', '', true);
      var nextOpen = (config.availability || {}).next_open_at;
      return viewRoot('wy-view-fallback prechat fallback') +
        headHtml('', backButtonHtml('home'), whoHtml(wsAvatar('s40', false), workspaceName, L('awayEmail'))) +
        '<div class="wy-scroll wy-body-pad fm">' +
          banHtml('', nextOpen ? awayLine(nextOpen) : intro) +
          (nextOpen ? '<p class="prechat-intro">' + esc(intro) + '</p>' : '') +
          '<div class="prechat-fields">' + fieldsHtml + '</div>' +
          '<div class="fm-end"><button type="button" class="btn btn-p prechat-submit" data-fb-submit>' + esc(t('fallbackSubmit')) + SEND + '</button>' +
            '<div class="fallback-status" data-fb-status role="status" aria-live="polite"></div></div>' +
        '</div>' + footerHtml() +
      '</div>';
    }

    function smartSurfaceHtml(s) {
      return (s.dismissible === false
        ? ''
        : '<button type="button" class="smart-dismiss" data-smart-dismiss aria-label="' + esc(tf('close', 'Close')) + '">' + closeIcon(14) + '</button>') +
        (s.title ? '<div class="smart-title">' + esc(s.title) + '</div>' : '') +
        '<div class="smart-body">' + esc(s.body || '') + '</div>' +
        (s.ctaLabel ? '<button type="button" class="smart-cta" data-smart-cta>' + esc(s.ctaLabel) + '</button>' : '');
    }

    // ══════════════════════════════════════════════════════════════════
    // Shell — non-visual infrastructure: the close control (tokens on it
    // so its focus ring and hero look follow the accent), the view host,
    // the call host and the lightbox.
    // ══════════════════════════════════════════════════════════════════
    function shellHtml() {
      return '<button type="button" class="panel-close" data-panel-close style="' + TOK + '" aria-label="' + esc(tf('close', 'Close')) + '">' +
          closeIcon(20) + '</button>' +
        '<div class="body wy-scroll" data-body></div>' +
        '<div class="gs-call-host" data-call-host hidden></div>' +
        '<div class="att-lightbox" data-att-lightbox hidden role="dialog" aria-modal="true" aria-label="' + esc(t('openFile')) + '">' +
          '<button type="button" class="att-lightbox-close" data-att-lightbox-close aria-label="' + esc(t('closePreview')) + '">' + closeIcon(20) + '</button>' +
          '<img data-att-lightbox-img alt="">' +
        '</div>';
    }

    /**
     * The chat header (feature `chatHeader`; Core repaints it into
     * [data-chat-header] when what it shows changes): a new conversation
     * names itself; an assigned operator shows their face, presence and
     * "{operator} · {workspace}"; otherwise the workspace.
     */
    function chatHeaderHtml(vm) {
      vm = vm || {};
      var op = vm.operator && vm.operator.name ? vm.operator : null;
      var online = !!vm.online;
      var status = online ? L('online') + ' · ' + replyText() : L('awayEmail');
      return (online ? '' : '<i class="away" hidden></i>') + backButtonHtml('home') + (vm.isNew
        ? whoHtml('', tf('wyNewConversation', 'New conversation'), workspaceName)
        : whoHtml(op ? avatarHtml(op, 's40', op.online != null ? !!op.online && online : online) : wsAvatar('s40', online),
          op ? op.name + (workspaceName ? ' · ' + workspaceName : '') : workspaceName, status)) +
        '<div class="presence sr-only" data-presence aria-live="polite"><span class="presence-dot" data-presence-dot></span>' +
          '<span class="presence-label" data-presence-label></span></div>';
    }

    function emojiPickerHtml() {
      var cats = L('cats').split(',');
      var icons = [
        '<circle cx="12" cy="12" r="8.5"/>' + P('M12 7.5V12l3 2'), D.emoji,
        '<circle cx="12" cy="8.2" r="3.6"/>' + P('M5.2 19.5a6.8 6.8 0 0 1 13.6 0'),
        P('M12 19.6s-7-4.3-7-9.7a4 4 0 0 1 7-2.6 4 4 0 0 1 7 2.6c0 5.4-7 9.7-7 9.7Z'),
        P('M5.5 18.5C5.5 10.6 10.4 5.7 18.5 5c0 8.6-5 13.5-13 13.5Z') + P('m5.5 18.5 7-7'),
        P('M5 9.5h11v4.3a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z') + P('M16 10.5h1.2a2.4 2.4 0 0 1 0 4.8H16') + P('M9 3.8v2.4M12.4 3.8v2.4'),
      ];
      return '<div class="ep-cats" role="tablist" aria-label="' + esc(t('emojiPicker')) + '">' + cats.map(function (c, i) {
          return '<button type="button" class="ep-cat" role="tab" aria-selected="' + (i ? 'false' : 'true') + '" data-emoji-tab="' + i +
            '" aria-label="' + esc(c) + '">' + svg(icons[i], 19) + '</button>';
        }).join('') + '</div>' +
        '<div class="ep-grid">' + EMOJI.map(function (row, i) {
          return '<div class="ep-g" data-emoji-group="' + i + '"><p class="ep-h">' + esc(cats[i]) + '</p><div class="ep-row">' +
            row.split(' ').map(function (e) {
              return '<button type="button" class="ep-e" data-emoji="' + e + '">' + e + '</button>';
            }).join('') + '</div></div>';
        }).join('') + '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Chat view — built ONCE by Core and re-mounted: header → thread →
    // composer → footer. Core paints rows into [data-chat-messages] and
    // binds the composer to the nodes of this frame.
    // ══════════════════════════════════════════════════════════════════
    function chatFrameHtml(vm) {
      vm = vm || {};
      var cfg = vm.config || config;
      var chatEnabled = !!vm.chatEnabled;
      var attachCfg = cfg.attachments || { enabled: false };
      var composerCfg = cfg.composer || {};
      var micSupported = !!(typeof navigator !== 'undefined' && navigator.mediaDevices &&
        navigator.mediaDevices.getUserMedia && typeof window.MediaRecorder === 'function');
      var voice = attachCfg.voiceNotesEnabled === true && micSupported;
      var emojiEnabled = composerCfg.emojiEnabled !== false;
      var bars = '';
      for (var i = 0; i < 20; i++) bars += '<i style="height:' + (6 + i * 11 % 23) + 'px"></i>';

      var header = '<div class="header hd wy-head wy-head-chat" data-chat-header>' +
        chatHeaderHtml({ online: configOnline(), isNew: false }) + '</div>';

      var composer = !chatEnabled ? footerHtml() :
        '<div class="composer-zone cmp" data-composer-zone>' +
          '<div class="sr-only" data-typing-row hidden aria-live="polite"><span class="typing-label" data-typing-label></span></div>' +
          '<div class="reply-preview" data-reply-preview hidden>' +
            '<span class="reply-preview-icon" aria-hidden="true">' + svg(D.quote, 14) + '</span>' +
            '<span class="reply-preview-body"><span class="reply-preview-author" data-reply-preview-author></span>' +
              '<span class="reply-preview-text" data-reply-preview-text></span></span>' +
            '<button type="button" class="reply-preview-cancel" data-reply-cancel aria-label="' + esc(tf('cancel', 'Cancel')) + '">' + closeIcon(14) + '</button>' +
          '</div>' +
          '<div class="input-bar" data-input-bar>' +
            '<div class="input-wrap cbox" data-input-wrap>' +
              (emojiEnabled
                ? '<div class="emoji-picker epk" data-emoji-picker hidden role="dialog" aria-label="' + esc(t('emojiPicker')) + '">' + emojiPickerHtml() + '</div>'
                : '') +
              (attachCfg.enabled
                ? '<div class="att-preview pend" data-attach-preview hidden>' +
                    '<div class="att-preview-thumb" data-attach-thumb><img class="att-preview-img" data-attach-thumb-img alt="" hidden>' +
                      '<span class="att-preview-doc" data-attach-thumb-doc aria-hidden="true">' + svg(D.doc, 16, 1.7) + '</span></div>' +
                    '<div class="att-preview-meta"><div class="att-preview-name" data-attach-name dir="auto"></div>' +
                      '<div class="att-preview-sub" data-attach-sub></div>' +
                      '<div class="att-preview-track" data-attach-track hidden><div class="att-preview-bar" data-attach-bar></div></div></div>' +
                    '<button type="button" class="att-preview-btn att-preview-retry" data-attach-retry hidden aria-label="' + esc(t('retry')) + '">' + svg(D.retry, 14, 1.9) + '</button>' +
                    '<button type="button" class="att-preview-btn att-preview-remove" data-attach-remove aria-label="' + esc(t('remove')) + '">' + closeIcon(14) + '</button>' +
                  '</div>'
                : '') +
              '<div class="cmp-lock">' + svg(D.lock, 16, 1.9) + '<span>' + esc(L('locked')) + '</span></div>' +
              '<div class="input-row" data-input-row>' +
                (voice
                  ? '<button type="button" class="ra mic-btn" data-mic-btn aria-label="' + esc(t('recordVoice')) + '">' +
                      MIC + '<span class="mic-ring" aria-hidden="true"></span></button>'
                  : '') +
                '<textarea class="input" rows="1" data-msg-input placeholder="' + esc(L('type')) + '"></textarea>' +
                // Fixed membership (send → attach → emoji); the grid places
                // emoji and attach at the start, the one round action at the end.
                '<div class="composer-actions"><div class="composer-actions-start">' +
                  '<button type="button" class="ra send-btn' + (voice ? '' : ' solo') + '" data-send-btn aria-label="' + esc(tf('send', 'Send')) + '">' + SEND + '</button>' +
                  (attachCfg.enabled
                    ? '<button type="button" class="ib attach-btn" data-attach-btn aria-label="' + esc(t('attachFile')) + '">' + svg(D.clip, 20) + '</button>' +
                      '<input type="file" data-attach-input hidden accept="' + esc((attachCfg.allowedMimes || []).join(',')) + '">'
                    : '') +
                  (emojiEnabled
                    ? '<button type="button" class="ib emoji-btn" data-emoji-btn aria-expanded="false" aria-label="' + esc(t('emojiPicker')) + '">' + svg(D.emoji, 20) + '</button>'
                    : '') +
                '</div></div>' +
                (voice
                  ? '<div class="rec-bar" data-rec-bar hidden>' +
                      '<button type="button" class="ib rec-btn rec-cancel" data-rec-cancel aria-label="' + esc(t('cancelRecording')) + '">' + svg(D.trash, 19) + '</button>' +
                      '<span class="rec-live"><span class="rec-dot" aria-hidden="true"></span>' +
                        '<span class="rec-time" data-rec-timer role="timer" aria-live="off">' + fmtClock(0) + '</span></span>' +
                      '<span class="rec-wave" aria-hidden="true">' + bars + '</span>' +
                      '<span class="sr-only" data-rec-sr role="status" aria-live="polite">' + esc(t('recording')) + '</span>' +
                      '<button type="button" class="ra stop rec-btn rec-confirm" data-rec-stop aria-label="' + esc(t('stopRecording')) + '">' + STOP + '</button>' +
                      '<button type="button" class="ra rec-send" data-rec-send aria-label="' + esc(t('send')) + '">' + SEND + '</button>' +
                    '</div>' +
                    '<div class="vn-bar" data-vn-bar hidden>' +
                      '<button type="button" class="ib rec-btn vn-delete" data-vn-delete aria-label="' + esc(t('remove')) + '">' + svg(D.trash, 19) + '</button>' +
                      '<span class="pring"><button type="button" class="ra vn-play" data-vn-toggle aria-label="' + esc(t('playAudio')) + '">' +
                        '<span class="vn-ico vn-ico-play">' + PLAY + '</span><span class="vn-ico vn-ico-pause">' + PAUSE + '</span></button></span>' +
                      '<div class="vn-track" data-vn-seek dir="ltr"><div class="vn-progress" data-vn-progress></div></div>' +
                      '<span class="vn-time" data-vn-time>' + fmtClock(0) + '</span>' +
                      '<button type="button" class="spd vn-rate" data-vn-rate>' + fmtRate(1) + '</button>' +
                      '<audio data-vn-audio preload="metadata"></audio>' +
                      '<button type="button" class="ra vn-send" data-vn-send aria-label="' + esc(t('send')) + '">' + SEND + '</button>' +
                    '</div>'
                  : '') +
              '</div>' +
            '</div>' +
          '</div>' + footerHtml() +
        '</div>';

      // Jump-to-latest: Core owns its visibility (`hidden`, `has-new`).
      var jumpHtml = chatEnabled
        ? '<button type="button" class="wy-jump" data-chat-jump hidden aria-label="' + esc(tf('scrollToLatest', 'Scroll to latest message')) + '">' +
            '<span class="wy-jump-ico" aria-hidden="true">' + svg(P('M12 5v14') + P('M19 12l-7 7-7-7'), 16, 2) + '</span>' +
            '<span class="wy-jump-label" data-chat-jump-label></span></button>'
        : '';

      return viewRoot('wy-view-chat') + header +
        '<div class="wy-chat-scroll-host"><div class="wy-chat-scroll wy-scroll" data-chat-messages></div>' + jumpHtml + '</div>' +
        composer + '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Home: hero, floating cards, footer, bottom menu
    // ══════════════════════════════════════════════════════════════════
    function convName(c) {
      return c.operatorName ? c.operatorName + (workspaceName ? ' · ' + workspaceName : '') : (c.title || workspaceName);
    }
    function convAvatar(c, size) {
      return c.operatorName
        ? avatarHtml({ name: c.operatorName, avatar: c.operatorAvatar }, size, c.operatorOnline ? true : null)
        : wsAvatar(size);
    }
    function previewHtml(c) {
      var unread = Number(c.unreadCount) || 0;
      return '<span class="l2' + (unread ? ' u' : '') + '"><em>' + (c.lastFromVisitor ? esc(tf('you', 'You')) + ': ' : '') +
        esc(c.preview || tf('wyNoPreview', '…')) + '</em>' +
        (unread ? '<span class="nb conv-unread">' + esc(fmtBadge(unread)) + '</span>' : '') +
        '</span>';
    }
    /** One conversation (the compact flag of older callers draws the same row). */
    function conversationRowHtml(c) {
      c = c || {};
      var resolved = String(c.status || '') === 'resolved';
      return '<button type="button" class="li conv-row" data-conversation-open="' + esc(c.id) + '">' + convAvatar(c, 's44') +
        '<span class="lx"><span class="l1"><span class="nm conv-name">' + esc(convName(c)) + '</span>' +
          (c.timeLabel ? '<span class="tm-s conv-time">' + esc(c.timeLabel) + '</span>' : '') + '</span>' + previewHtml(c) +
          '<span class="tg conv-status ' + (resolved ? 'done is-resolved' : 'open') + '">' + (resolved ? '' : '<span class="live conv-status-dot"></span>') +
            esc(resolved ? tf('wyStatusResolved', 'Resolved') : tf('wyStatusOpen', 'Open')) + '</span>' +
        '</span></button>';
    }

    function homeHtml(vm) {
      vm = vm || {};
      var online = !!vm.isOnline;
      var convs = vm.conversations || [];
      var recent = convs[0] || null;
      var people = vm.showTeamAvatars !== false ? teamPeople(vm.teamMembers).slice(0, 3) : [];
      var credit = platformCredit();
      var nextOpen = (config.availability || {}).next_open_at;
      var logo = config.showLogo === false ? ''
        : safeUrl(config.logoUrl)
          ? '<span class="logo has-img"><img src="' + esc(safeUrl(config.logoUrl)) + '" alt="' + esc(workspaceName) + '" decoding="async"></span>'
          : '<span class="logo" aria-hidden="true">' + esc(initialOf(workspaceName) || 'W') + '</span>';

      var hero = '<div class="wy-head wy-head-home hx">' + (MARK && credit ? markSvg('hx-mk') : '') +
        '<div class="hx-top">' + logo + '</div>' +
        '<p class="hx-hi home-greeting">' + esc(vm.visitorName ? fill(L('hiBack'), { name: vm.visitorName }) : L('hi')) + '</p>' +
        '<h2 class="hx-q home-welcome">' + esc(L('q')) + '</h2>' +
      '</div>';

      var cards = '';
      if (recent) {
        cards += '<button type="button" class="cd rc" data-conversation-open="' + esc(recent.id) + '">' +
          '<span class="cap">' + esc(L('recent')) + '</span>' +
          '<span class="rrow">' + convAvatar(recent, 's40') + '<span class="lx">' +
            '<span class="l1"><span class="nm">' + esc(convName(recent)) + '</span>' +
              (recent.timeLabel ? '<span class="tm-s">' + esc(recent.timeLabel) + '</span>' : '') + '</span>' +
            previewHtml(recent) + '</span></span>' +
        '</button>';
        if (NAV_MODE === 'none') {
          cards += '<button type="button" class="more" data-view="list">' + esc(L('all')) + svg(D.chev, 16, 2.2, 'mir') + '</button>';
        }
        if (vm.chatEnabled) {
          cards += '<button type="button" class="cd cta" data-home-action="chat">' + stackHtml(people, 's28', !online) +
            '<span class="lx"><span class="ct">' + esc(online ? L('newMsg') : t('homeLeaveMessage')) + '</span>' +
              '<span class="cs">' + liveHtml(online) + esc(online ? replyText() : awayLine(nextOpen)) + '</span></span>' +
            '<span class="ra" aria-hidden="true">' + SEND + '</span></button>';
        }
      } else if (vm.chatEnabled) {
        cards += '<div class="cd team"><div class="tm">' + stackHtml(people, 's36', !online) +
            '<span class="lx"><span class="ct">' + esc(online ? L('team') : L('away')) + '</span>' +
            '<span class="cs">' + liveHtml(online) + esc(online ? L('online') + ' · ' + replyText() : awayLine(nextOpen)) + '</span></span></div>' +
          (online ? '' : '<p class="note">' + svg(D.mail, 18) + '<span>' + esc(L('note')) + '</span></p>') +
          '<button type="button" class="btn btn-p" data-home-action="chat">' + esc(online ? t('homeStartChat') : t('homeLeaveMessage')) + SEND + '</button>' +
        '</div>';
      }
      if (!convs.length && vm.conversationsError) {
        cards += '<div class="cd home-conv-error"><p>' + esc(tf('wyConversationsLoadError', t('convLoadError'))) + '</p>' +
          '<button type="button" class="more" data-home-action="conversations-retry">' + esc(tf('wyConversationsRetry', t('convRetry'))) + '</button></div>';
      }
      if (vm.smartSurface && vm.smartSurface.mode === 'home_card') {
        cards += '<section class="smart-home-card cd">' + smartSurfaceHtml(vm.smartSurface) + '</section>';
      }
      if (vm.kbEnabled) {
        var rows = (vm.articles || []).slice(0, !online ? 2 : recent ? 3 : 4);
        var ph = online ? L('search') : L('searchAway');
        cards += '<div class="cd hc">' +
          '<label class="sr">' + svg(D.search, 18, 1.9) +
            '<input class="kb-search" data-kb-search type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" aria-label="' +
              esc(ph) + '" placeholder="' + esc(ph) + '"></label>' +
          (rows.length ? '<div class="ls">' + rows.map(function (a) {
            return '<button type="button" class="li home-chip" data-home-article="' + esc(a.slug || '') + '"><span class="lx">' + esc(a.title || '') + '</span>' + chevHtml() + '</button>';
          }).join('') + '</div>' : '') +
        '</div>';
      }

      return viewRoot('wy-view-home home-root bgw', 'nv-' + NAV_MODE) +
        hero + '<div class="wy-scroll wy-home-scroll bd">' + cards + '</div>' + footerHtml() + navHtml('home', vm.unreadTotal) +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Messages (all conversations)
    // ══════════════════════════════════════════════════════════════════
    function conversationListHtml(vm) {
      vm = vm || {};
      var items = vm.conversations || [];
      var bodyHtml = (vm.error && !items.length)
        ? '<div class="wy-empty wy-conv-error"><p>' + esc(tf('wyConversationsLoadError', t('convLoadError'))) + '</p>' +
            '<button type="button" class="more" data-home-action="conversations-retry">' + esc(tf('wyConversationsRetry', t('convRetry'))) + '</button></div>'
        : vm.loading ? skeletonConvRowsHtml(3)
        : items.length ? '<div class="ls">' + items.map(function (c) { return conversationRowHtml(c); }).join('') + '</div>'
        : '<div class="wy-empty"><p>' + esc(tf('wyNoConversations', 'No conversations yet')) + '</p></div>';
      return viewRoot('wy-view-list', 'nv-' + NAV_MODE) +
        titleRowHtml(L('msgs'), 'wy-head-list') +
        '<div class="wy-scroll wy-list-scroll">' + bodyHtml + '</div>' +
        (vm.chatEnabled ? '<div class="cta-w"><button type="button" class="btn btn-p" data-home-action="chat">' + esc(L('newMsg')) + SEND + '</button></div>' : '') +
        footerHtml() + navHtml('list', vm.unreadTotal) +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Help: search, categories, popular, article
    // ══════════════════════════════════════════════════════════════════
    function rowsCard(list, title) {
      return '<div class="cd lc">' + (title ? '<p class="sh">' + esc(title) + '</p>' : '') + '<div class="ls kb-list">' +
        list.map(kbArticleItemHtml).join('') + '</div></div>';
    }
    function kbArticleItemHtml(a) {
      return '<button type="button" class="li kb-article" data-kb-action="open" data-kb-slug="' + esc(a.slug) + '">' +
        '<span class="lx kb-article-title">' + esc(a.title) + '</span>' + chevHtml() + '</button>';
    }
    function catIcon(icon) {
      var key = String(icon || '').toLowerCase();
      if (CAT[key]) return svg(CAT[key], 18);
      return svg(D.book, 18);
    }
    function kbSearchBarHtml(vm) {
      vm = vm || {};
      return '<div class="kb-search-wrap"><label class="sr">' + svg(D.search, 18, 1.9) +
        '<input class="kb-search" data-kb-search type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="' +
          esc(L('help')) + '" placeholder="' + esc(L('helpQ')) + '" value="' + esc(vm.query || '') + '"></label></div>';
    }
    function kbEmptyHtml(vm) {
      vm = vm || {};
      var isSearch = vm.state === 'results';
      return '<div class="kb-empty cd">' +
        '<p class="kb-empty-text">' + esc(vm.emptyText || (isSearch ? t('kbZeroResults') : t('noArticles'))) + '</p>' +
        (vm.hideChatCta ? '' : '<button type="button" class="btn btn-p sm" data-kb-action="switch-chat">' + esc(t('kbSwitchToChat')) + '</button>') +
      '</div>';
    }
    function kbLoadingHtml() { return skRows(4); }
    function kbSearchResultsHtml(vm) {
      vm = vm || {};
      var results = vm.results || [];
      return results.length ? rowsCard(results)
        : kbEmptyHtml({ state: 'results', emptyText: vm.emptyText, hideChatCta: vm.hideChatCta });
    }
    function kbHomeHtml(vm) {
      vm = vm || {};
      var cats = (vm.categories || []).filter(function (c) { return c && c.id != null && c.count; });
      var articles = vm.articles || [];
      if (!cats.length && !articles.length) return kbEmptyHtml({ state: 'list', emptyText: vm.emptyText, hideChatCta: vm.hideChatCta });
      // Categories (feature `kbCategories`, when the KB has them), then the
      // first articles; without categories every article is listed.
      return (cats.length
        ? '<div class="cd cats">' + cats.map(function (c) {
            return '<button type="button" class="li" data-kb-category="' + esc(c.id) + '"><span class="lt">' + catIcon(c.icon) + '</span>' +
              '<span class="lx"><span class="l1">' + esc(c.name) + '</span><span class="l3">' + esc(fill(L('count'), { n: fmtNum(c.count) })) + '</span></span>' +
              chevHtml() + '</button>';
          }).join('') + '</div>'
        : '') +
        (articles.length ? rowsCard(cats.length ? articles.slice(0, 3) : articles, cats.length ? L('popular') : '') : '');
    }

    /** Rated or not: the question, thumbs, and a thank-you once the vote is saved. */
    function kbArticleFeedbackHtml(fb) {
      if (!fb || !fb.enabled) return '';
      var rating = fb.rating || null;
      function btn(v, label, flip) {
        return '<button type="button" class="kb-rate' + (rating === v ? ' is-' + v : '') + '" data-kb-rate="' + v + '" aria-pressed="' + (rating === v) + '">' +
          svg(D.thumb, 16, 1.8, flip ? 'dn' : '') + esc(label) + '</button>';
      }
      return '<div class="kb-feedback fb" data-kb-feedback>' +
        '<span class="kb-feedback-q">' + esc(rating ? tf('wyFeedbackThanks', 'Thanks for your feedback!') : L('helpful')) + '</span>' +
        '<div class="kb-feedback-actions">' + btn('up', L('yes')) + btn('down', L('no'), true) + '</div>' +
      '</div>';
    }
    function askCardHtml(vm) {
      if (vm && vm.hideChatCta) return '';
      var online = configOnline();
      return '<button type="button" class="cd cta ask" data-kb-action="switch-chat">' + stackHtml(teamPeople().slice(0, 2), 's28', !online) +
        '<span class="lx"><span class="ct">' + esc(L('still')) + '</span><span class="cs">' + liveHtml(online) + esc(L('talk')) + '</span></span>' +
        '<span class="ra" aria-hidden="true">' + SEND + '</span></button>';
    }
    function kbArticleHtml(vm) {
      vm = vm || {};
      var a = vm.article || {};
      var meta = [];
      if (a.readingMinutes) meta.push(fill(L('readT'), { n: fmtNum(a.readingMinutes) }));
      if (a.updatedAt && relTime(a.updatedAt)) meta.push(fill(L('updated'), { time: relTime(a.updatedAt) }));
      return '<div class="kb-article-view art">' +
        '<h1>' + esc(a.title || '') + '</h1>' +
        (meta.length ? '<p class="am">' + meta.map(esc).join('<span class="dot" aria-hidden="true">·</span>') + '</p>' : '') +
        '<div class="kb-article-body">' + (a.contentHtml || '') + '</div>' +
      '</div>';
    }

    /** The help view: its own header + the state's body (features `kbSearch`, `kbCategories`, `kbArticleMeta`). */
    function kbHtml(vm) {
      vm = vm || {};
      var state = vm.state || 'list';
      var cats = vm.categories || [];
      if (state === 'article' || state === 'category') {
        var cat = state === 'category' ? (vm.category || {}) : null;
        var title = cat ? cat.name : ((vm.article && vm.article.categoryTitle) || tf('wyArticles', L('help')));
        var catRow = cats.filter(function (c) { return c && c.name === title; })[0];
        var count = cat ? cat.count : catRow ? catRow.count : 0;
        return viewRoot('wy-view-kb kb-root ' + (cat ? 'kb-cat bgw' : 'kb-art'), 'nv-' + NAV_MODE) +
          headHtml(' wy-head-article', backButtonHtml('back', ' data-view-back-fallback="home"'),
            whoHtml('', title || '', count ? fill(L('count'), { n: fmtNum(count) }) : '')) +
          (cat
            ? '<div class="wy-scroll wy-kb-scroll">' + ((vm.articles || []).length ? rowsCard(vm.articles) : kbEmptyHtml({ state: 'list', hideChatCta: vm.hideChatCta })) + '</div>' +
              footerHtml() + navHtml('help', vm.unreadTotal)
            : '<div class="wy-scroll wy-kb-scroll">' + kbArticleHtml(vm) + '</div>' +
              kbArticleFeedbackHtml(vm.feedback) + askCardHtml(vm) + footerHtml()) +
        '</div>';
      }
      var inner = state === 'searching' ? kbLoadingHtml(vm) : state === 'results' ? kbSearchResultsHtml(vm) : kbHomeHtml(vm);
      return viewRoot('wy-view-kb kb-root bgw', 'nv-' + NAV_MODE) +
        '<div class="kb-top">' + titleRowHtml(L('help'), 'wy-head-kb') + kbSearchBarHtml(vm) + '</div>' +
        '<div class="wy-scroll wy-kb-scroll"><div class="kb-res" data-kb-results data-state="' + esc(state) + '">' + inner + '</div></div>' +
        footerHtml() + navHtml('help', vm.unreadTotal) +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Loading skeletons: the real views' boxes (same header, hero, card,
    // composer and menu geometry) with placeholder bars. aria-hidden, no
    // fake names, times or counts.
    // ══════════════════════════════════════════════════════════════════
    function sk(cls, style) {
      return '<span class="wy-sk' + (cls ? ' ' + cls : '') + '"' + (style ? ' style="' + style + '"' : '') + '></span>';
    }
    function skLine(width, height) { return sk('wy-sk-line', 'width:' + width + ';height:' + (height || 10) + 'px'); }
    function skCircle(size) { return sk('wy-sk-circle', 'width:' + size + 'px;height:' + size + 'px'); }
    function skRoot(cls, inner) {
      return viewRoot(cls + ' wy-skeleton', 'nv-' + NAV_MODE).replace('<div', '<div aria-hidden="true"') + inner + '</div>';
    }
    function skRows(n) {
      var rows = '';
      for (var i = 0; i < n; i++) rows += '<div class="li wy-sk-row">' + skLine((50 + (i * 13) % 30) + '%', 12) + '</div>';
      return '<div class="cd lc wy-sk-group"><div class="ls">' + rows + '</div></div>';
    }
    function skeletonConvRowsHtml(n) {
      var out = '';
      for (var i = 0; i < n; i++) {
        out += '<div class="sk wy-sk-row"' + (i ? ' style="opacity:' + (i > 1 ? 0.35 : 0.55) + '"' : '') + '>' + skCircle(44) +
          '<span class="lx">' + skLine((45 - i * 10) + '%', 12) + skLine((80 - i * 10) + '%', 10) + '</span></div>';
      }
      return '<div class="wy-sk-group" aria-hidden="true">' + out + '</div>';
    }
    function skHead(avatar) {
      return headHtml('', '<span class="ib bk"></span>', '<div class="who">' + (avatar ? skCircle(40) : '') +
        '<span class="who-x"><span class="hn">' + skLine('120px', 13) + '</span><span class="hs">' + skLine('84px', 9) + '</span></span></div>');
    }
    /** A real view as its own skeleton: same boxes, nothing focusable or announced. */
    function inert(html) { return html.replace('<div class="wy-view ', '<div inert aria-hidden="true" class="wy-skeleton wy-view '); }
    // Most skeletons are the real view made inert (identical boxes, nothing
    // focusable or announced); the thread is drawn as placeholder bubbles.
    function skeletonHtml(view, vm) {
      vm = vm || {};
      var comp = vm.composer || {};
      var ico = '<span class="wy-sk" style="width:18px;height:18px;border-radius:6px"></span>';
      switch (String(view || '')) {
        case 'chat':
          return skRoot('wy-view-chat', skHead(true) +
            '<div class="wy-chat-scroll-host"><div class="wy-chat-scroll wy-scroll wy-sk-msgs">' +
              [[0, 64], [1, 48], [0, 78], [1, 38], [0, 56]].map(function (r) {
                return '<div class="wy-sk-msg' + (r[0] ? ' is-me' : '') + '">' + (r[0] ? '' : skCircle(28)) +
                  '<span class="wy-sk-bubble" style="width:' + r[1] + '%"></span></div>';
              }).join('') + '</div></div>' +
            (vm.chatEnabled === false ? footerHtml()
              : '<div class="composer-zone cmp"><div class="input-bar"><div class="input-wrap cbox"><div class="input-row">' +
                  '<span class="input wy-sk-input">' + skLine('54%', 12) + '</span>' +
                  '<span class="ra ' + (comp.voiceNotes ? 'mic-btn' : 'send-btn solo') + ' wy-sk-ico"></span>' +
                  (comp.attachments ? '<span class="ib attach-btn wy-sk-ico">' + ico + '</span>' : '') +
                  (comp.emoji ? '<span class="ib emoji-btn wy-sk-ico">' + ico + '</span>' : '') +
                '</div></div></div>' + footerHtml() + '</div>'));
        case 'list':
          return inert(conversationListHtml({ loading: true, chatEnabled: vm.chatEnabled !== false }));
        case 'prechat':
          var n = Math.max(1, Math.min(3, Number(vm.fields) || 2));
          return inert(prechatFormHtml({
            isAsked: function (k) { return ['name', 'email', 'phone'].indexOf(k) < n; },
            isRequired: function () { return false; },
          }, {}, ctx.locale));
        case 'help':
        case 'articles':
          return inert(kbHtml({ state: 'searching' }));
        case 'article':
          // The article view, its text drawn as placeholder lines.
          return inert(kbHtml({ state: 'article', article: {}, feedback: { enabled: true }, hideChatCta: true }));
        default:
          // Home as it will be, its article rows still empty bars.
          return inert(homeHtml({
            isOnline: configOnline(), chatEnabled: vm.chatEnabled !== false, teamMembers: TEAM,
            showTeamAvatars: config.showTeamAvatars !== false, kbEnabled: !!(config.features && config.features.knowledgeBase), articles: [{}, {}, {}, {}],
          }));
      }
    }

    // Features Core runs for this renderer (runtime.js `feat()`); nothing
    // is declared for a capability Core cannot serve (CSAT, reactions,
    // order card, step pre-chat, instant answers: `env.capabilities`).
    var features = {
      tabs: true, kbSearch: true, kbCategories: true, kbArticleMeta: true, operatorTyping: true, chatHeader: true,
      emptyQna: true, topics: true, prechatOperator: true, prechatSummary: true, recSend: true, vnRate: true,
      clock: true, emojiTabs: true, visitorName: true, conversationOperator: true,
    };
    void caps;

    return {
      id: 't1',
      features: features,
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
      conversationListHtml: conversationListHtml,
      conversationRowHtml: conversationRowHtml,
      kbHtml: kbHtml,
      kbSearchBarHtml: kbSearchBarHtml,
      kbHomeHtml: kbHomeHtml,
      kbSearchResultsHtml: kbSearchResultsHtml,
      kbArticleHtml: kbArticleHtml,
      kbEmptyHtml: kbEmptyHtml,
      kbLoadingHtml: kbLoadingHtml,
      kbArticleFeedbackHtml: kbArticleFeedbackHtml,
      skeletonHtml: skeletonHtml,
      connIndicatorHtml: connIndicatorHtml,
      format: {
        msgTime: formatMsgTime,
        callDuration: fmtCallDuration,
        invitationRemaining: fmtInvitationRemaining,
        humanSize: humanSize,
        clock: fmtClock,
        badge: fmtBadge,
        rate: fmtRate,
        num: fmtNum,
      },
    };
  }

  // The faces this locale's first paint draws with (waiting 500 ms at
  // most); every other face stays on demand through its unicode-range
  // (presentation-default-fonts.css): Persian IRANSans 400, 500 and 600
  // (= the 700 file); any other locale Inter. An older loader passes no
  // context: the Persian set.
  function prepare(context) {
    if (!document.fonts || typeof document.fonts.load !== 'function') return Promise.resolve();
    var persian = String((context || {}).locale || 'fa').toLowerCase().split('-')[0] === 'fa';
    var loads = (persian ? ['400', '500', '600'] : ['500']).map(function (w) {
      return document.fonts.load(w + (persian ? ' 16px IRANSans' : ' 16px InterWY'), persian ? 'سلام دنیا' : 'Aa').catch(function () {});
    });
    return Promise.race([
      Promise.all(loads).then(function () {}),
      new Promise(function (resolve) { setTimeout(resolve, 500); }),
    ]);
  }

  window.__gs_presentation_t1 = { id: 't1', create: create, prepare: prepare };
})();
