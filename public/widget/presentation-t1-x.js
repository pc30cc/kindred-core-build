/**
 * Widget Presentation — the "t1" renderer's extras.
 *
 * Markup of the t1 renderer (presentation-t1.js) that no first paint needs,
 * in a file of its own so that a first open of a t1 panel never downloads
 * it: Core (runtime-ext.js) asks for it after the first paint, together
 * with its late module (runtime-late.js), and hands it to the renderer
 * (`extend()`), which draws these surfaces from then on. The same rules as
 * a renderer: pure functions (view-model in, HTML out), no network, no
 * storage, no host, and its own copy in fa, en and tr. The stylesheet of
 * these surfaces is the template's own (presentation-t1.css).
 *
 * CONTRACT (docs/operations/WIDGET_TEMPLATE_RULES.md §1)
 *   window.__gs_mod_extras = { id: 't1', v: 2, create: function (H) { return { <surface>: fn, … }; } }
 *   H = the renderer's helpers: esc, t, tf, L, fill, svg, P, D, SEND, digits,
 *       fmtNum, avatarHtml, systemPillHtml, config, lang, fa.
 *   `id` is the RENDERER's (a skin over t1 wears this file too) and `v` the
 *   version of this contract: the renderer takes only its own id and
 *   version, so a file from another deploy or template (a canonical-name
 *   fallback) is refused. Change `v` here and in the renderer together
 *   whenever a surface's arguments or H change.
 *
 *   emojiPickerHtml()   the grouped emoji picker (feature `emojiTabs`): a tab per group, and
 *                       on top the search field (feature `emojiSearch`: [data-emoji-search],
 *                       its label hidden until Core, which hides what does not match, shows
 *                       it) with the "no emoji found" line under the groups ([data-emoji-none],
 *                       hidden)
 *   chatMenuHtml(menu)  the chat bar's ⋯ and its menu (feature `chatMenu`): menu = { open, items },
 *                       item { action: 'transcript', state ('idle' | 'sending' | 'sent' |
 *                       'failed' | 'no'), to } | { action: 'sound', on }. Hooks:
 *                       [data-chat-menu-toggle][aria-expanded], [data-chat-menu][role=menu],
 *                       [data-chat-menu-action].
 *   prechatStepsHtml(vm) the pre-chat asked one question at a time, as thread rows (feature
 *                       `prechatSteps`): vm = { key (the open step), log, firstName, intro,
 *                       introAnimate }, log = [{ key, value, ok, skip, why ('invalid' |
 *                       'required') }] in the order answered. A question once per key
 *                       (id `pq-<key>`), each answer a visitor bubble; a skipped step none.
 *   prechatStepBoxHtml(vm) the step in the composer's place: vm = { key, n, total, optional,
 *                       value, prefix (the edition's phone prefix, or ''), busy, error }.
 *                       Hooks: [data-prechat-step=<key>], [data-prechat-step-input],
 *                       [data-prechat-step-submit], [data-prechat-step-skip].
 *   queueRowHtml(q)     the queued row with the visitor's place (feature `queuePosition`):
 *                       q = { position, waitMinutes (null: unknown) }.
 *   awayReplyHtml(r)    the automated reply under the message left while the team is away
 *                       (feature `awayThread`): r = { status ('ask' | 'saving' | 'saved'),
 *                       email, value, error (a Core string key) }. Hooks: [data-fb=email],
 *                       [data-fb-submit] (the form's submit), [data-fb-status].
 */
(function () {
  'use strict';

  // This file's copy: one '|'-separated string per language, in the order
  // of COPY_KEYS (as the renderer's own; the menu's keys are the names of
  // docs/chat-widget-handoff/shared/new-hooks-and-settings.md).
  var COPY_KEYS = 'cats emojiSearch emojiNoResults moreOptions menuSound csatTranscript csatTranscriptSent csatTranscriptFailed csatFailed prechatAskName prechatAskEmail prechatAskEmailNoName prechatAskPhone prechatStep prechatStepSaved prechatStepEmailInvalid prechatStepEmailExample prechatPhonePhLocal prechatPhoneHint prechatStepSubmit routingInQueue routingInQueuePosition awayAutoReply fallbackEmailLabel fallbackEmailFormLabel saveEmail msgAutomated awayRecorded awayReplyTo awayHere'.split(' ');
  var DICT = {
    fa: 'پرکاربرد,چهره‌ها,آدم‌ها و دست‌ها,قلب‌ها و نمادها,طبیعت,غذا و نوشیدنی|جستجوی شکلک|شکلکی پیدا نشد|گزینه‌های بیشتر|صدای اعلان‌ها|ارسال متن گفتگو به ایمیل|متن گفتگو به {email} فرستاده شد|ارسال متن گفتگو ممکن نشد|ارسال نشد|سلام! برای شروع، نامتان را بنویسید.|ممنون {name}. ایمیلتان را هم بنویسید.|ایمیلتان را بنویسید.|اگر مایلید، شماره موبایلتان را هم بنویسید.|مرحله {n} از {total}|ثبت شد|ایمیل کامل نیست|مثلاً name@example.com|۹۱۲ ۳۴۵ ۶۷۸۹|شمارهٔ موبایل|ثبت|نفر {n} در صف · حدود {min} دقیقه|نفر {n} در صف|پیامتان ثبت شد. اگر مایلید، ایمیلتان را هم بگذارید.|ایمیل شما|ایمیل شما|ثبت ایمیل|پیام خودکار|پیامتان ثبت شد.|ثبت شد: {email}|پیامتان ثبت شد. پاسخ همین‌جا در گفتگو نمایش داده می‌شود.',
    en: 'Frequent,Faces,People and hands,Hearts and symbols,Nature,Food and drink|Search emoji|No emoji found|More options|Notification sounds|Email me the transcript|We sent the transcript to {email}|We could not send the transcript|Not sent|Hi! To start, what’s your name?|Thanks, {name}. What’s your email?|What’s your email?|If you like, add your phone number too.|Step {n} of {total}|Saved|That email isn’t complete|e.g. name@example.com|415 555 0132|Mobile number|Submit|{n} in line · about {min} min|{n} in line|Got your message! If you like, leave your email too.|Your email|Your email|Save email|Automated message|Got your message!|Saved: {email}|Got your message! The reply will appear here, in this chat.',
    tr: 'Sık kullanılan,Yüzler,İnsanlar ve eller,Kalpler ve semboller,Doğa,Yiyecek ve içecek|Emoji ara|Emoji bulunamadı|Diğer seçenekler|Bildirim sesleri|Sohbet dökümünü e-postama gönder|Döküm {email} adresine gönderildi|Döküm gönderilemedi|Gönderilemedi|Merhaba! Başlamak için adınız nedir?|Teşekkürler {name}. E-postanız nedir?|E-postanız nedir?|İsterseniz telefon numaranızı da ekleyin.|Adım {n}/{total}|Kaydedildi|Bu e-posta eksik|ör. name@example.com|532 123 4567|Cep telefonu numarası|Gönder|Sırada {n}. · yaklaşık {min} dk|Sırada {n}.|Mesajınızı aldık! İsterseniz e-postanızı da bırakın.|E-postanız|E-postanız|E-postayı kaydet|Otomatik mesaj|Mesajınızı aldık!|Kaydedildi: {email}|Mesajınızı aldık! Yanıt burada, bu sohbette görünecek.',
  };

  // Grouped emoji for the picker, one group per name in `cats`.
  var EMOJI = [
    '😍 🙏 👍 😊 😂 ❤️ 🌹 🎉',
    '😀 😁 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😎 🤩 🥳 😏',
    '👍 👎 👏 🙏 👋 🤝 ✌️ 👌 💪 🙌 🤲 👀 🙋 🤷 💁 🙆',
    '❤️ 🧡 💛 💚 💙 💜 🤍 🖤 💔 💕 💖 💯 ✨ 🔥 ⭐ ✅',
    '🌹 🌷 🌸 🌻 🍀 🌙 ☀️ 🌈 🐱 🐶 🦋 🐝 🌊 ❄️ 🌿 🍂',
    '☕ 🍰 🎂 🍫 🍕 🍔 🍎 🍉 🍓 🍇 🍩 🍪 🧁 🍦 🍵 🥤',
  ];

  function create(H) {
    var esc = H.esc;
    var t = H.t;
    var svg = H.svg;
    var P = H.P;
    // A string or English: a locale 'constructor' must not reach Object.prototype.
    var COPY = (typeof DICT[H.lang] == 'string' ? DICT[H.lang] : DICT.en).split('|');
    var COPY_EN = DICT.en.split('|');
    /** This file's own copy (fa / en / tr; English otherwise), `{name}` placeholders filled with plain text. */
    function XL(key, vars) { var i = COPY_KEYS.indexOf(key); return H.fill(i < 0 ? '' : COPY[i] || COPY_EN[i] || '', vars || {}); }

    function emojiPickerHtml() {
      var cats = XL('cats').split(',');
      var icons = [
        '<circle cx="12" cy="12" r="8.5"/>' + P('M12 7.5V12l3 2'), H.D.emoji,
        '<circle cx="12" cy="8.2" r="3.6"/>' + P('M5.2 19.5a6.8 6.8 0 0 1 13.6 0'),
        P('M12 19.6s-7-4.3-7-9.7a4 4 0 0 1 7-2.6 4 4 0 0 1 7 2.6c0 5.4-7 9.7-7 9.7Z'),
        P('M5.5 18.5C5.5 10.6 10.4 5.7 18.5 5c0 8.6-5 13.5-13 13.5Z') + P('m5.5 18.5 7-7'),
        P('M5 9.5h11v4.3a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z') + P('M16 10.5h1.2a2.4 2.4 0 0 1 0 4.8H16') + P('M9 3.8v2.4M12.4 3.8v2.4'),
      ];
      // The search (feature `emojiSearch`): Core shows it, and loads the keywords on its first use.
      var find = esc(XL('emojiSearch'));
      return '<label class="ep-sr" hidden>' + svg(H.D.search, 16, 2) + '<input type="search" data-emoji-search enterkeyhint="search" autocomplete="off" spellcheck="false" aria-label="' +
          find + '" placeholder="' + find + '"></label>' +
        '<div class="ep-cats" role="tablist" aria-label="' + esc(t('emojiPicker')) + '">' + cats.map(function (c, i) {
          return '<button type="button" class="ep-cat" role="tab" aria-selected="' + (i ? 'false' : 'true') + '" data-emoji-tab="' + i +
            '" aria-label="' + esc(c) + '">' + svg(icons[i], 19) + '</button>';
        }).join('') + '</div>' +
        '<div class="ep-grid">' + EMOJI.map(function (row, i) {
          return '<div data-emoji-group="' + i + '"><p class="ep-h">' + esc(cats[i]) + '</p><div class="ep-row">' +
            row.split(' ').map(function (e) {
              return '<button type="button" class="ep-e" data-emoji="' + e + '">' + e + '</button>';
            }).join('') + '</div></div>';
        }).join('') + '<p class="ep-none" data-emoji-none role="status" hidden>' + esc(XL('emojiNoResults')) + '</p></div>';
    }

    // The chat bar's ⋯ (before the shell's close) and its menu.
    function chatMenuHtml(menu) {
      var items = (menu && menu.items) || [];
      if (!items.length) return '';
      var label = esc(XL('moreOptions'));
      return '<div class="cm"><button type="button" class="ib" data-chat-menu-toggle aria-haspopup="menu" aria-expanded="' +
          !!menu.open + '" aria-label="' + label + '">' + svg(P('M5 12h.01M12 12h.01M19 12h.01'), 20, 3) + '</button>' +
        '<div class="menu" role="menu" data-chat-menu aria-label="' + label + '"' + (menu.open ? '' : ' hidden') + '>' +
        items.map(function (it) {
          if (it.action === 'sound') {
            return '<button type="button" role="menuitemcheckbox" aria-checked="' + !!it.on + '" data-chat-menu-action="sound" tabindex="-1">' +
              svg(P('M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5h4') + (it.on ? '' : P('M4 4l16 16')), 18) +
              '<span>' + esc(XL('menuSound')) + '</span><i class="sw" aria-hidden="true"></i></button>';
          }
          var st = it.state;
          var text;
          if (st === 'sent') {
            // The server's masked address, an isolated left-to-right run.
            var parts = XL('csatTranscriptSent').split('{email}');
            text = esc(parts[0]) + '<b dir="ltr">' + esc(it.to || '') + '</b>' + esc(parts[1] || '');
          } else {
            text = esc(st === 'no' ? XL('csatTranscriptFailed') : st === 'failed' ? XL('csatFailed') + ' · ' + H.L('retry') : XL('csatTranscript'));
          }
          return '<button type="button" role="menuitem" data-chat-menu-action="transcript" tabindex="-1"' +
            (st === 'sending' || st === 'sent' || st === 'no' ? ' aria-disabled="true"' : '') + '>' +
            svg(st === 'sent' ? H.D.tick : H.D.mail, 18) + '<span>' + text + '</span></button>';
        }).join('') + '</div></div>';
    }

    // ── The pre-chat one question at a time (`prechatSteps`) ──
    /** A bubble on the team's side, beside the team's lead (the first one online). */
    function opRow(bubble) {
      var team = (H.config.teamMembers || []).filter(function (m) { return m && m.name; });
      var who = team.filter(function (m) { return m.online; })[0] || team[0];
      return '<div class="msg-row operator is-first is-last">' + H.avatarHtml(who, 's28 msg-avatar') +
        '<div class="msg-col"><div class="msg-line">' + bubble + '</div></div></div>';
    }
    function question(vm, key) {
      var text = key === 'name' ? XL('prechatAskName') : key === 'phone' ? XL('prechatAskPhone')
        : vm.firstName ? XL('prechatAskEmail', { name: vm.firstName }) : XL('prechatAskEmailNoName');
      return opRow('<div class="msg operator" id="pq-' + key + '">' + esc(text) + '</div>');
    }
    function prechatStepsHtml(vm) {
      var log = vm.log || [];
      var asked = {};
      // The reason (a handoff's subtitle, typed out on first show), as the card's.
      var html = vm.introAnimate ? opRow('<div class="msg operator" data-typing-host data-typing-active="1" data-typing-id="hc-subtitle"></div>')
        : vm.intro ? opRow('<div class="msg operator">' + esc(vm.intro) + '</div>') : '';
      // "Saved" under the newest answer taken (08·b); each refusal says why.
      var lastOk = -1;
      log.forEach(function (e, i) { if (e.ok) lastOk = i; });
      log.forEach(function (e, i) {
        if (!asked[e.key]) { asked[e.key] = 1; html += question(vm, e.key); }
        if (e.skip) return;
        // A refusal is read out when it is the newest answer.
        var meta = e.ok ? (i === lastOk ? '<span class="st-ok">' + svg(H.D.tick, 13, 2.2) + esc(XL('prechatStepSaved')) + '</span>' : '')
          : '<span class="st-err"' + (i === log.length - 1 ? ' role="alert"' : '') + '><b>' +
            esc(e.why === 'required' ? t('fieldRequired') : e.key === 'phone' ? t('invalidPhone') : XL('prechatStepEmailInvalid')) + '</b>' +
            (e.why !== 'required' && e.key === 'email' ? ' · ' + esc(XL('prechatStepEmailExample')) : '') + '</span>';
        html += '<div class="msg-row visitor is-first is-last"><div class="msg-col"><div class="msg-line"><div class="msg visitor' + (e.ok ? '' : ' fail') +
          '" dir="' + (e.key === 'name' ? 'auto' : 'ltr') + '">' + esc(e.value) + '</div></div>' +
          (meta ? '<div class="msg-footline"><div class="msg-meta">' + meta + '</div></div>' : '') + '</div></div>';
      });
      return asked[vm.key] ? html : html + question(vm, vm.key);
    }
    function prechatStepBoxHtml(vm) {
      var k = vm.key;
      var bars = '';
      for (var i = 1; i <= vm.total; i++) bars += '<i' + (i > vm.n ? '' : ' class="on"') + '></i>';
      var tel = k === 'phone';
      return '<div class="cbox steps" data-prechat-step="' + k + '"><div class="prog"><span>' +
          esc(XL('prechatStep', { n: H.digits(vm.n), total: H.digits(vm.total) }) + (vm.optional ? ' · ' + t('prechatOptional') : '')) + '</span>' +
          '<span class="bar" aria-hidden="true">' + bars + '</span>' +
          (vm.optional ? '<button type="button" class="skip" data-prechat-step-skip>' + esc(H.L('skip')) + '</button>' : '') + '</div>' +
        '<label class="ex">' + (tel && vm.prefix ? '<span class="pre" dir="ltr">' + esc(H.digits(vm.prefix)) + '</span>' : '') +
          '<input class="input" data-prechat-step-input type="' + (k === 'name' ? 'text' : k === 'email' ? 'email' : 'tel') + '"' +
            (k === 'name' ? ' autocomplete="name"' : ' dir="ltr" autocomplete="' + (tel ? (vm.prefix ? 'tel-national' : 'tel') : 'email') + '"') +
            ' enterkeyhint="' + (vm.n < vm.total ? 'next' : 'done') + '" placeholder="' +
            esc(k === 'name' ? t('prechatNamePh') : !tel ? 'name@example.com' : vm.prefix ? XL('prechatPhonePhLocal') : t('prechatPhonePh')) +
            '" aria-label="' + esc(tel ? H.L('phone') : t(k)) + '" aria-describedby="pq-' + k + '" value="' + esc(vm.value || '') + '"' +
            (vm.busy ? ' readonly' : '') + '></label>' +
        '<div class="tools">' + (tel ? '<span class="hint">' + esc(XL('prechatPhoneHint')) + '</span>' : '') +
          '<button type="button" class="ra' + (vm.busy ? ' is-loading' : '') + '" data-prechat-step-submit aria-label="' + esc(XL('prechatStepSubmit')) + '"' +
            (String(vm.value || '').trim() && !vm.busy ? '' : ' disabled') + '>' + H.SEND + '</button></div>' +
        (vm.error ? '<div class="hint err" role="alert">' + esc(t('fallbackError')) + '</div>' : '') +
      '</div>';
    }

    // ── The visitor's place in the queue (`queuePosition`) ──
    function queueRowHtml(q) {
      var n = q.position;
      var v = n % 100;
      var th = ['th', 'st', 'nd', 'rd'];
      return H.systemPillHtml('<span class="live"></span>', XL(q.waitMinutes > 0 ? 'routingInQueue' : 'routingInQueuePosition', {
        n: H.lang === 'en' ? n + (th[(v - 20) % 10] || th[v] || th[0]) : H.digits(n),
        min: H.digits(q.waitMinutes),
      }));
    }

    // ── The message left while the team is away (`awayThread`) ──
    function awayReplyHtml(r) {
      var busy = r.status === 'saving';
      var saved = r.status === 'saved';
      // No email step (skipped, or visitor email switched off): the reply comes here.
      var here = r.status === 'skipped';
      var parts = XL('awayReplyTo').split('{email}');
      return '<div class="msg-row operator is-first is-last away-reply">' + H.avatarHtml(null, 's28 msg-avatar') + '<div class="msg-col">' +
        '<div class="msg-line"><div class="msg operator joined">' + esc(XL(here ? 'awayHere' : saved ? 'awayRecorded' : 'awayAutoReply')) + '</div></div>' +
        (here ? '' : '<div class="msg-line">' + (saved
          ? '<div class="fcard ec done" role="status">' + svg(H.D.okc, 18, 2) + '<span>' + esc(parts[0]) + '<b dir="ltr">' + esc(r.email) + '</b>' + esc(parts[1] || '') + '</span></div>'
          : '<form class="fcard ec" novalidate aria-label="' + esc(XL('fallbackEmailFormLabel')) + '">' +
              '<label for="fb-email">' + esc(XL('fallbackEmailLabel')) + '</label><div class="rw">' +
              '<input id="fb-email" class="prechat-input inp" data-fb="email" type="email" dir="ltr" autocomplete="email" placeholder="name@example.com"' +
                ' aria-describedby="fb-status" aria-invalid="' + !!r.error + '" value="' + esc(r.value || '') + '"' + (busy ? ' readonly' : '') + '>' +
              '<button type="submit" class="go" data-fb-submit aria-label="' + esc(XL('saveEmail')) + '"' + (busy ? ' disabled' : '') + '>' + svg(H.D.tick, 18, 2.2) + '</button></div>' +
              '<div class="fallback-status" id="fb-status" data-fb-status role="status" aria-live="polite">' + (r.error ? esc(t(r.error)) : '') + '</div>' +
            '</form>') + '</div>') +
        '<div class="msg-footline"><div class="msg-meta"><span class="msg-time">' + esc(XL('msgAutomated')) + '</span></div></div>' +
      '</div></div>';
    }

    return {
      emojiPickerHtml: emojiPickerHtml, chatMenuHtml: chatMenuHtml, prechatStepsHtml: prechatStepsHtml,
      prechatStepBoxHtml: prechatStepBoxHtml, queueRowHtml: queueRowHtml, awayReplyHtml: awayReplyHtml,
    };
  }

  window.__gs_mod_extras = { id: 't1', v: 2, create: create };
})();
