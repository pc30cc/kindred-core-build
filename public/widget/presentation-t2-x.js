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
 *   window.__gs_mod_extras = { id: 't2', v: 1, create: function (H) { return { <surface>: fn, … }; } }
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
 */
(function () {
  'use strict';

  // This file's copy: one '|'-separated string per language, in the order
  // of COPY_KEYS (the names of docs/chat-widget-handoff/shared/new-hooks-and-settings.md).
  var COPY_KEYS = ('convClosedBy csatTitle csatSub csat1 csat2 csat3 csat4 csat5 csatComment csatSend csatThanks ' +
    'csatRated csatGone csatFailed csatTranscript csatTranscriptSent csatTranscriptFailed moreOptions menuSound').split(' ');
  var DICT = {
    fa: '{name} گفتگو را بست|گفتگو با {name} چطور بود؟|نظرتان کمک می‌کند بهتر شویم.|خیلی بد|بد|معمولی|خوب|عالی|' +
      'چیز دیگری هم بگویید (اختیاری)|ارسال نظر|از نظرتان سپاسگزاریم!|امتیاز شما: {r}|' +
      'دیگر نمی‌شود به این گفتگو امتیاز داد.|ارسال نشد|ارسال متن گفتگو به ایمیل|متن گفتگو به {email} فرستاده شد|' +
      'ارسال متن گفتگو ممکن نشد|گزینه‌های بیشتر|صدای اعلان‌ها',
    en: '{name} closed the conversation|How was your chat with {name}?|Your answer helps the team get better.|' +
      'Very bad|Bad|Okay|Good|Great|Tell us more (optional)|Send feedback|Thanks for your feedback!|Your rating: {r}|' +
      'This chat can no longer be rated.|Not sent|Email me the transcript|We sent the transcript to {email}|' +
      'We could not send the transcript|More options|Notification sounds',
    tr: '{name} sohbeti kapattı|{name} ile sohbetiniz nasıldı?|Yanıtınız ekibin gelişmesine yardımcı olur.|' +
      'Çok kötü|Kötü|İdare eder|İyi|Harika|Eklemek istediğiniz bir şey var mı? (isteğe bağlı)|Geri bildirim gönder|' +
      'Geri bildiriminiz için teşekkürler!|Puanınız: {r}|Bu sohbet artık puanlanamaz.|Gönderilemedi|' +
      'Sohbet dökümünü e-postama gönder|Döküm {email} adresine gönderildi|Döküm gönderilemedi|Diğer seçenekler|Bildirim sesleri',
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
        '" data-csat role="group" aria-label="' + esc(title) + '">';
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

    return { closedHtml: closedHtml, chatMenuHtml: chatMenuHtml };
  }

  window.__gs_mod_extras = { id: 't2', v: 1, create: create };
})();
