/**
 * Widget Presentation — the "t2" renderer's extras.
 *
 * Markup of the t2 renderer (presentation-t2.js) that no first paint needs,
 * in a file of its own so that a first open of a t2 panel never downloads
 * it: Core (runtime-ext.js) asks for it after the first paint, together
 * with its late module (runtime-late.js), and hands it to the renderer
 * (`extend()`), which draws these surfaces from then on. The same rules as
 * a renderer: pure functions (view-model in, HTML out), no network, no
 * storage, no host, and its own copy in fa, en and tr. The stylesheet of
 * these surfaces is the template's own (presentation-t2.css).
 *
 * CONTRACT (docs/operations/WIDGET_TEMPLATE_RULES.md §1)
 *   window.__gs_mod_extras = { id: 't2', v: 2, create: function (H) { return { <surface>: fn, … }; } }
 *   H = the renderer's helpers: esc, t, tf, L, digits, fmtNum, ico,
 *       avatarHtml, storeAvatarHtml, systemPillHtml, config, lang, fa.
 *   `id` is the RENDERER's (a skin over t2 wears this file too) and `v` the
 *   version of this contract: the renderer takes only its own id and
 *   version, so a file from another deploy or template (a canonical-name
 *   fallback) is refused. Change `v` here and in the renderer together
 *   whenever a surface's arguments or H change.
 *
 *   closedHtml(m, csat)   a `conversation_closed` row: the line «{name} closed
 *                         the conversation» (`metadata.agent_name`, else the
 *                         workspace), and under it the rating card when Core
 *                         passes one for this row (`csat.closedId === m.__id`):
 *                           csat = { closedId, name, avatar, rating (1..5 | 0),
 *                                    comment, state, transcript }
 *                           state: 'ask' | 'sending' | 'error' (a retry) |
 *                                  'done' (rated) | 'gone' (can no longer be rated)
 *                           transcript: null | { state, to }, state 'idle' |
 *                                  'sending' | 'sent' | 'failed' (a retry) | 'no'
 *                         Hooks: [data-csat] (the card), [data-csat-rate=1..5]
 *                         [aria-pressed], [data-csat-comment], [data-csat-submit],
 *                         [data-csat-transcript].
 *   chatMenuHtml(menu)    the chat bar's ⋯ and its menu: menu = { open, items },
 *                         item { action: 'transcript', state, to } | { action: 'sound', on }.
 *                         Hooks: [data-chat-menu-toggle][aria-expanded],
 *                         [data-chat-menu][role=menu], [data-chat-menu-action].
 *   reactHtml(m)          a message's reactions under its bubble (feature `reactions`;
 *                         display only): `m.metadata.reactions` = [{ emoji, count, mine }]
 *                         in display order; up to three kinds, then the total. Marker:
 *                         span.react[data-msg-id] (Core keeps a badge on screen from
 *                         popping in again).
 *   reactBtnHtml(m)       the visitor's heart among a team message's actions:
 *                         [data-msg-react="❤️"][data-msg-id][aria-pressed].
 *   awayReplyHtml(r)      the automated reply under the message left while the team is away
 *                         (feature `awayThread`): r = { status ('ask' | 'saving' | 'saved' |
 *                         'skipped'), email, value, error (a Core string key), skip (offer
 *                         "no thanks") }. Hooks: [data-fb=email], [data-fb-submit] (the
 *                         form's submit), [data-fb-status], [data-fb-skip], and
 *                         [data-ph-away] (the composer's placeholder meanwhile).
 *   orderCardHtml(o)      an AI answer's order card (`metadata.kind` 'order_status', drawn
 *                         under the answer's text): o = `metadata.order` = { v: 1, number,
 *                         summary, more, status ('pending' | 'on_hold' | 'processing' |
 *                         'shipped' | 'completed' | 'cancelled' | 'refunded' | 'failed' |
 *                         'unknown'), statusLabel (the store's own name, preferred),
 *                         step (0..3 | null: no progress), arrives ('YYYY-MM-DD' | null),
 *                         trackingUrl }. The item line, the delivery day and the tracking
 *                         link only when present; the link only to an http(s) address, in
 *                         a new tab. Hidden by the stylesheet while the answer types out.
 *   kbSuggestHtml(vm)     the help articles that answer a first message being written
 *                         (feature `instantAnswers`, put above the composer by Core):
 *                         vm = { results: [{ slug, title, matches (words), readingMinutes }] },
 *                         two at most; '' for none. Hooks: [data-kb-suggest] (the tray),
 *                         [data-kb-action="open"][data-kb-slug] (a row).
 */
(function () {
  'use strict';

  // This file's copy: one '|'-separated string per language, in the order
  // of COPY_KEYS (the names of docs/chat-widget-handoff/shared/new-hooks-and-settings.md).
  var COPY_KEYS = 'convClosedBy csatTitle csatSub csat1 csat2 csat3 csat4 csat5 csatComment csatSend csatThanks csatRated csatGone csatFailed csatTranscript csatTranscriptSent csatTranscriptFailed moreOptions menuSound simpleReact simpleReactions simpleMessageRecorded simpleAutoReply simpleAddMore orderTitle orderStepPlaced orderStepPreparing orderStepShipped orderStepDelivered orderArrives orderTrackPackage orderStatusPending orderStatusOnHold orderStatusProcessing orderStatusShipped orderStatusCompleted orderStatusCancelled orderStatusRefunded orderStatusFailed simpleInstantAnswers'.split(' ');
  var DICT = {
    fa: '{name} گفتگو را بست|گفتگو با {name} چطور بود؟|نظرتان کمک می‌کند بهتر شویم.|خیلی بد|بد|معمولی|خوب|عالی|چیز دیگری هم بگویید (اختیاری)|ارسال نظر|از نظرتان سپاسگزاریم!|امتیاز شما: {r}|دیگر نمی‌شود به این گفتگو امتیاز داد.|ارسال نشد|ارسال متن گفتگو به ایمیل|متن گفتگو به {email} فرستاده شد|ارسال متن گفتگو ممکن نشد|گزینه‌های بیشتر|صدای اعلان‌ها|پسندیدن|واکنش‌ها: {list}|پیامتان ثبت شد.|پاسخ خودکار|اگر چیزی اضافه دارید بنویسید…|سفارش {number}|ثبت|آماده‌سازی|ارسال|تحویل|تحویل: {day}|پیگیری مرسوله|در انتظار پرداخت|در انتظار بررسی|در حال آماده‌سازی|ارسال شد|تکمیل شد|لغو شد|مسترد شد|ناموفق|پاسخ‌های آماده از مرکز راهنما',
    en: '{name} closed the conversation|How was your chat with {name}?|Your answer helps the team get better.|Very bad|Bad|Okay|Good|Great|Tell us more (optional)|Send feedback|Thanks for your feedback!|Your rating: {r}|This chat can no longer be rated.|Not sent|Email me the transcript|We sent the transcript to {email}|We could not send the transcript|More options|Notification sounds|Like|Reactions: {list}|Your message is saved.|Automatic reply|Add anything else…|Order {number}|Placed|Packed|Shipped|Delivered|Arrives {day}|Track package|Awaiting payment|On hold|Processing|Shipped|Completed|Cancelled|Refunded|Failed|Answers from the help center',
    tr: '{name} sohbeti kapattı|{name} ile sohbetiniz nasıldı?|Yanıtınız ekibin gelişmesine yardımcı olur.|Çok kötü|Kötü|İdare eder|İyi|Harika|Eklemek istediğiniz bir şey var mı? (isteğe bağlı)|Geri bildirim gönder|Geri bildiriminiz için teşekkürler!|Puanınız: {r}|Bu sohbet artık puanlanamaz.|Gönderilemedi|Sohbet dökümünü e-postama gönder|Döküm {email} adresine gönderildi|Döküm gönderilemedi|Diğer seçenekler|Bildirim sesleri|Beğen|Tepkiler: {list}|Mesajınız kaydedildi.|Otomatik yanıt|Eklemek istediğiniz bir şey varsa yazın…|Sipariş {number}|Alındı|Hazırlanıyor|Kargoda|Teslim edildi|Teslimat: {day}|Kargoyu takip et|Ödeme bekleniyor|Beklemede|Hazırlanıyor|Kargoya verildi|Tamamlandı|İptal edildi|İade edildi|Başarısız|Yardım merkezinden yanıtlar',
  };

  // Icons this file adds (24px grid, as the renderer's ico()).
  function P(d) { return '<path d="' + d + '"/>'; }
  function svg(inner, size, sw) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="' + sw +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }
  // The five faces, very bad → great (the design's mouths on one face).
  var FACE = '<circle cx="12" cy="12" r="8.5"/><path d="M9 10h.01M15 10h.01" stroke-width="2.6"/>';
  var MOUTHS = [
    P('M8.5 16.4c1-1.1 2.2-1.7 3.5-1.7s2.5.6 3.5 1.7'),
    P('M9 15.8c.9-.6 1.9-.9 3-.9s2.1.3 3 .9'),
    P('M9 15.2h6'),
    P('M9 14.3c.8.8 1.8 1.3 3 1.3s2.2-.5 3-1.3'),
    '<path d="M8.4 13.6c.9 1.7 2.1 2.6 3.6 2.6s2.7-.9 3.6-2.6z" fill="currentColor"/>',
  ];
  var MORE = P('M5 12h.01M12 12h.01M19 12h.01');
  var BELL = P('M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5h4');
  // The design's heart (filled by the stylesheet where it is given).
  var HEART_ICON = P('M12 20.5s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1z');
  var HEART = '\u2764\uFE0F';
  // The instant answers' sparkle.
  var SPARK = P('M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5z') + P('M18.5 15.5v4M16.5 17.5h4');
  // An order's statuses: the copy key of each, and whether it is over (the quiet pill).
  var ORDER_STATUS = {
    pending: 'Pending', on_hold: 'OnHold', processing: 'Processing', shipped: 'Shipped',
    completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded', failed: 'Failed',
  };
  var ORDER_ACTIVE = { pending: 1, on_hold: 1, processing: 1, shipped: 1 };
  var ORDER_STEPS = ['Placed', 'Preparing', 'Shipped', 'Delivered'];
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function create(H) {
    var esc = H.esc;
    // A string or English: a locale 'constructor' must not reach Object.prototype.
    var COPY = (typeof DICT[H.lang] == 'string' ? DICT[H.lang] : DICT.en).split('|');
    var COPY_EN = DICT.en.split('|');
    var workspaceName = String(H.config.workspaceName || H.config.brandName || '');
    /** This file's own copy (fa / en / tr; English otherwise), `{name}` placeholders filled with plain text. */
    function XL(key, vars) {
      var i = COPY_KEYS.indexOf(key);
      var s = i < 0 ? '' : COPY[i] || COPY_EN[i] || '';
      for (var k in vars || {}) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) s = s.split('{' + k + '}').join(String(vars[k]));
      }
      return s;
    }
    function face(n, size) { return svg(FACE + MOUTHS[n - 1], size, 1.6); }

    /**
     * The transcript's words, as HTML: the address (the server's masked one)
     * is an isolated left-to-right run, put in by splitting the copy (never
     * HTML from the dictionary).
     */
    function transcriptText(tr) {
      if (tr.state === 'sent') {
        var parts = XL('csatTranscriptSent').split('{email}');
        return esc(parts[0]) + '<b dir="ltr">' + esc(tr.to || '') + '</b>' + esc(parts[1] || '');
      }
      if (tr.state === 'no') return esc(XL('csatTranscriptFailed'));
      return esc(tr.state === 'failed' ? XL('csatFailed') + ' · ' + H.L('retry') : XL('csatTranscript'));
    }
    /** The card's link: a button until it was sent (or can no longer be), then a status line. */
    function transcriptHtml(tr) {
      if (!tr) return '';
      if (tr.state === 'sent' || tr.state === 'no') {
        return '<p class="lnk2" role="status">' + (tr.state === 'sent' ? H.ico('tick', 16, 2) : '') + '<span>' + transcriptText(tr) + '</span></p>';
      }
      return '<button type="button" class="lnk2" data-csat-transcript' + (tr.state === 'sending' ? ' disabled' : '') + '>' +
        H.ico('mail', 16, 1.8) + transcriptText(tr) + '</button>';
    }

    function csatHtml(c) {
      var name = String(c.name || '');
      var title = XL('csatTitle', { name: name || workspaceName });
      var r = Math.round(+c.rating) || 0;
      if (r < 1 || r > 5) r = 0;
      var open = '<div class="msg-row system"><div class="csat' + (c.state === 'done' ? ' done' : '') +
        '" data-csat role="group" tabindex="-1" aria-label="' + esc(title) + '">';
      var close = transcriptHtml(c.transcript) + '</div></div>';
      // Rated: the chosen face and a thanks; no form.
      if (c.state === 'done') {
        return open + (r ? '<span class="cf" aria-hidden="true">' + face(r, 26) + '</span>' : '') +
          '<div role="status"><h3>' + esc(XL('csatThanks')) + '</h3>' +
          (r ? '<p>' + esc(XL('csatRated', { r: XL('csat' + r) })) + '</p>' : '') + '</div>' + close;
      }
      var head = open + (name ? H.avatarHtml(name, c.avatar, 44) : H.storeAvatarHtml(44)) + '<h3>' + esc(title) + '</h3>';
      if (c.state === 'gone') return head + '<p class="er" role="status">' + esc(XL('csatGone')) + '</p>' + close;
      var busy = c.state === 'sending';
      var faces = '';
      for (var i = 1; i <= 5; i++) {
        faces += '<button type="button" data-csat-rate="' + i + '" aria-pressed="' + (r === i) + '"' +
          (busy ? ' disabled' : '') + ' aria-label="' + esc(XL('csat' + i)) + '">' + face(i, 26) + '</button>';
      }
      return head + '<p>' + esc(XL('csatSub')) + '</p><div class="faces">' + faces + '</div>' +
        '<textarea class="ta" data-csat-comment rows="2" maxlength="1000" dir="auto" aria-label="' + esc(XL('csatComment')) +
          '" placeholder="' + esc(XL('csatComment')) + '"' + (busy ? ' readonly' : '') + '>' + esc(c.comment || '') + '</textarea>' +
        (c.state === 'error' ? '<p class="er" role="alert">' + esc(XL('csatFailed')) + '</p>' : '') +
        '<button type="button" class="btn" data-csat-submit' + (r && !busy ? '' : ' disabled') + (busy ? ' aria-busy="true"' : '') + '>' +
          esc(XL('csatSend')) + '</button>' + close;
    }

    function closedHtml(m, csat) {
      var md = (m && m.metadata) || {};
      return H.systemPillHtml('', XL('convClosedBy', { name: String(md.agent_name || '') || workspaceName })) +
        (csat && csat.closedId === m.__id ? csatHtml(csat) : '');
    }

    function chatMenuHtml(menu) {
      var items = (menu && menu.items) || [];
      if (!items.length) return '';
      var label = esc(XL('moreOptions'));
      return '<div class="cm"><button type="button" class="ib" data-chat-menu-toggle aria-haspopup="menu" aria-expanded="' +
          !!menu.open + '" aria-label="' + label + '">' + svg(MORE, 20, 3) + '</button>' +
        '<div class="menu" role="menu" data-chat-menu aria-label="' + label + '"' + (menu.open ? '' : ' hidden') + '>' +
        items.map(function (it) {
          if (it.action === 'sound') {
            return '<button type="button" role="menuitemcheckbox" aria-checked="' + !!it.on + '" data-chat-menu-action="sound" tabindex="-1">' +
              svg(BELL + (it.on ? '' : P('M4 4l16 16')), 18, 1.8) + '<span>' + esc(XL('menuSound')) + '</span><i class="sw" aria-hidden="true"></i></button>';
          }
          var st = it.state;
          return '<button type="button" role="menuitem" data-chat-menu-action="transcript" tabindex="-1"' +
            (st === 'sending' || st === 'sent' || st === 'no' ? ' aria-disabled="true"' : '') + '>' +
            H.ico(st === 'sent' ? 'tick' : 'mail', 18, 1.8) + '<span>' + transcriptText(it) + '</span></button>';
        }).join('') + '</div></div>';
    }

    // ── Reactions (`reactions`) ──
    function reactHtml(m) {
      var total = 0;
      var glyphs = '';
      var said = [];
      ((m.metadata && m.metadata.reactions) || []).forEach(function (r) {
        var c = Math.floor(Number(r && r.count)) || 0;
        if (c < 1) return;
        total += c;
        said.push(r.emoji + ' ' + H.digits(c));
        if (said.length < 4) glyphs += r.emoji === HEART ? svg(HEART_ICON, 12, 1.8) : '<i>' + esc(r.emoji) + '</i>';
      });
      return total ? '<span class="react" data-msg-id="' + esc(m.__id || '') + '" role="img" aria-label="' +
        esc(XL('simpleReactions', { list: said.join(H.L('sep')) })) + '">' + glyphs + H.digits(total) + '</span>' : '';
    }
    // A team message the server stores (a uuid; a local row never gets a dead control).
    function reactBtnHtml(m) {
      if (m.senderType === 'system' || !/^[0-9a-f-]{36}$/i.test(m.__id || '')) return '';
      var mine = ((m.metadata && m.metadata.reactions) || []).some(function (r) { return r && r.emoji === HEART && r.mine; });
      var label = esc(XL('simpleReact'));
      return '<button type="button" class="msg-act" data-msg-react="' + HEART + '" data-msg-id="' + esc(m.__id) +
        '" aria-pressed="' + mine + '" aria-label="' + label + '">' + svg(HEART_ICON, 14, 1.8) + '</button>';
    }

    // ── The message left while the team is away (`awayThread`) ──
    function bubble(text) { return '<div class="msg-line"><div class="msg operator">' + esc(text) + '</div></div>'; }
    function awayReplyHtml(r) {
      var st = r.status;
      var busy = st === 'saving';
      var parts = H.L('replyTo').split('{email}');
      var html = bubble(XL('simpleMessageRecorded'));
      if (st === 'saved') {
        html += '<div class="msg-line"><div class="fcard done" role="status"><span class="ck" aria-hidden="true">' + H.ico('tick', 16, 2.4) + '</span>' +
          '<span>' + esc(parts[0]) + '<b dir="ltr">' + esc(r.email) + '</b>' + esc(parts[1] || '') + '</span></div></div>';
      } else if (st !== 'skipped') {
        html += bubble(H.L('askEmail')) +
          '<div class="msg-line"><form class="fcard" novalidate aria-label="' + esc(H.L('askEmail')) + '"><div class="prechat-field">' +
            '<label class="prechat-label" for="fb-email">' + esc(H.t('email')) + '</label>' +
            '<div class="prechat-control fi" dir="ltr"><input id="fb-email" class="prechat-input" data-fb="email" type="email" dir="ltr" autocomplete="email"' +
              ' placeholder="name@example.com" aria-describedby="fb-status" aria-invalid="' + !!r.error + '" value="' + esc(r.value || '') + '"' + (busy ? ' readonly' : '') + '>' +
              '<button type="submit" class="hc-submit ok" data-fb-submit aria-label="' + esc(H.L('saveEmail')) + '"' + (busy ? ' disabled' : '') + '>' + H.ico('tick', 18, 2.4) + '</button></div>' +
            '<div class="fallback-status" id="fb-status" data-fb-status role="status" aria-live="polite">' + (r.error ? esc(H.t(r.error)) : '') + '</div></div>' +
            (r.skip ? '<button type="button" class="skip" data-fb-skip>' + esc(H.L('skip')) + '</button>' : '') +
          '</form></div>';
      }
      return '<div class="msg-row operator is-first is-last away-reply" data-ph-away="' + esc(XL('simpleAddMore')) + '">' +
        H.storeAvatarHtml(28, '', 'msg-avatar') + '<div class="msg-col">' + html +
          '<div class="msg-footline"><div class="msg-meta"><span class="msg-time">' + esc(XL('simpleAutoReply')) + '</span></div></div>' +
        '</div></div>';
    }

    // ── An AI answer's order card (`metadata.kind` 'order_status') ──
    /** The day an order arrives: its weekday within six days, else its day and month; '' when past or unreadable. */
    function dayLabel(iso) {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
      if (!m) return '';
      var d = new Date(+m[1], m[2] - 1, +m[3], 12);
      var now = new Date();
      var days = Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)) / 864e5);
      if (isNaN(days) || days < 0) return '';
      var tag = H.lang === 'fa' ? 'fa-IR-u-ca-' + (H.config.calendar === 'gregorian' ? 'gregory' : 'persian') : H.lang === 'tr' ? 'tr-TR' : 'en-US';
      try {
        return new Intl.DateTimeFormat(tag, days < 7 ? { weekday: 'long' } : { day: 'numeric', month: 'long' }).format(d);
      } catch (_) { return ''; }
    }
    /** Copy with one `{name}` filled by escaped bold text (the rest escaped too). */
    function boldIn(key, name, value) {
      var parts = XL(key).split('{' + name + '}');
      return esc(parts[0]) + '<b>' + esc(value) + '</b>' + esc(parts[1] || '');
    }
    function orderCardHtml(o) {
      var status = Object.prototype.hasOwnProperty.call(ORDER_STATUS, o.status) ? o.status : 'unknown';
      var label = String(o.statusLabel || '').trim() || (status === 'unknown' ? '' : XL('orderStatus' + ORDER_STATUS[status]));
      var title = XL('orderTitle', { number: H.digits(String(o.number)) });
      var summary = String(o.summary || '').trim();
      var more = Math.floor(Number(o.more)) || 0;
      var step = status === 'completed' ? 3 : o.step === 0 || o.step === 1 || o.step === 2 || o.step === 3 ? o.step : -1;
      var steps = '';
      if (step >= 0) {
        steps = '<ol class="steps" style="--f:' + (status === 'completed' ? 1 : (step / 3).toFixed(3)) + '">' + ORDER_STEPS.map(function (k, i) {
          var done = i < step || status === 'completed';
          var now = !done && i === step;
          return '<li' + (done ? ' class="ok"' : now ? ' class="now" aria-current="step"' : '') + '><i></i>' + esc(XL('orderStep' + k)) + '</li>';
        }).join('') + '</ol>';
      }
      var day = dayLabel(o.arrives);
      var url = String(o.trackingUrl || '').trim();
      var link = /^https?:\/\/[^\s"'<>\\]+$/i.test(url) && url.length <= 500
        ? '<a class="trk" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(XL('orderTrackPackage')) + '</a>' : '';
      return '<div class="msg-line"><div class="msg operator has-card"><div class="card" role="group" aria-label="' + esc(title) + '">' +
        '<div class="ch1"><span class="th" aria-hidden="true">' + H.ico('box', 26, 1.6) + '</span>' +
          '<span class="tt"><b>' + esc(title) + '</b>' + (summary ? '<small>' + esc(summary) + (more > 0 ? ' <bdi dir="ltr">+' + esc(H.fmtNum(more)) + '</bdi>' : '') + '</small>' : '') + '</span>' +
          (label ? '<span class="pill' + (ORDER_ACTIVE[status] ? '' : ' done') + '">' + esc(label) + '</span>' : '') + '</div>' +
        steps +
        (day || link ? '<div class="ft">' + (day ? H.ico('truck', 18, 1.7) + '<span>' + boldIn('orderArrives', 'day', day) + '</span>' : '') + link + '</div>' : '') +
      '</div></div></div>';
    }

    // ── Help articles while the first message is written (`instantAnswers`) ──
    /**
     * Escaped text with these words marked (escaped too). The words are the
     * server's, case folded as the database folds it («İade» is «iade»), which
     * a JavaScript /i alone does not undo: an «i» also marks an «İ».
     */
    function marked(text, words) {
      words = (Array.isArray(words) ? words : []).map(String).filter(function (w) { return w.length > 1; });
      text = String(text || '');
      if (!words.length) return esc(text);
      return text.split(new RegExp('(' + words.map(function (w) { return escRe(w).replace(/i/g, '[iİ]'); }).join('|') + ')', 'gi')).map(function (p, i) {
        return i % 2 ? '<mark>' + esc(p) + '</mark>' : esc(p);
      }).join('');
    }
    function kbSuggestHtml(vm) {
      var rows = ((vm && vm.results) || []).filter(function (a) { return a && a.slug && a.title; }).slice(0, 2);
      if (!rows.length) return '';
      return '<div class="tray" data-kb-suggest role="region" aria-labelledby="kbs-h"><h4 id="kbs-h">' + svg(SPARK, 16, 1.7) + esc(XL('simpleInstantAnswers')) + '</h4>' +
        rows.map(function (a) {
          var min = Math.floor(Number(a.readingMinutes)) || 0;
          return '<button type="button" class="ta" data-kb-action="open" data-kb-slug="' + esc(a.slug) + '">' +
            '<span class="it" aria-hidden="true">' + H.ico('book', 18, 1.7) + '</span>' +
            '<span class="tx"><span class="tt">' + marked(a.title, a.matches) + '</span>' +
              (min > 0 ? '<small>' + esc(H.L('read', { n: H.fmtNum(min) })) + '</small>' : '') + '</span>' +
            H.ico('fwd', 18, 2, 'ch dirf') + '</button>';
        }).join('') + '</div>';
    }

    return {
      closedHtml: closedHtml, chatMenuHtml: chatMenuHtml, reactHtml: reactHtml, reactBtnHtml: reactBtnHtml, awayReplyHtml: awayReplyHtml,
      orderCardHtml: orderCardHtml, kbSuggestHtml: kbSuggestHtml,
    };
  }

  window.__gs_mod_extras = { id: 't2', v: 2, create: create };
})();
