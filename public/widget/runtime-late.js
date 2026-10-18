/**
 * Widget Module: late Core features
 *
 * Core's code for what a template draws AFTER its first paint (the "late
 * pack", docs/operations/WIDGET_TEMPLATE_RULES.md §2): runtime-ext.js asks
 * for this file together with the renderer's extras
 * (`presentation-<renderer>-x.js`) once the first paint is done, or at once
 * when a control needs them, and only for a renderer whose descriptor names
 * extras (`default` and `intl` never download it). The two are applied
 * together or not at all, so a feature here never runs without its markup
 * and its markup is never drawn without it. Gated like runtime-ext.js: each
 * feature only for a renderer declaring it (`api.feat(name)`).
 *
 *   csat       under the "closed the conversation" row the thread ends with
 *              (only system rows after it; runtime.js keeps those rows only
 *              for a renderer declaring `closedNotice`)
 *              the rating card: `view.csat` for `messagesHtml`, from
 *              GET /api/widget/conversations/:id/csat (asked once per
 *              conversation, again when the panel reopens or the thread's
 *              history reloads), POST …/csat with the pick and the comment;
 *              its transcript link (POST …/transcript)
 *   chatMenu   the chat bar's ⋯ (`vm.menu` for `chatHeaderHtml`): the
 *              transcript by email, when the server offers it, and the
 *              notification sounds on/off (Core's `uiPrefsStore.soundEnabled`,
 *              remembered for this visitor in localStorage `gs:sound:<workspace>`)
 *
 * Public API (window.__gs_mod_late): `v`, the version of the contract with
 * runtime-ext.js (the `api` below; runtime-ext refuses another version, so
 * a canonical-name fallback from another deploy never half-applies), and
 * create(api) → this module's instance. `api` is runtime-ext's own surface:
 * the instance's parts as runtime-ext.js names them (P, ctx, panel, chatQ,
 * the stores, renderBody, ModuleLoader, …), its helpers (feat, each,
 * onClick, wrap, paintChatHeader) and `on(hook, fn)`, which registers `fn`
 * on one of the hooks runtime.js runs (`ext('<hook>', a, b)`). runtime-ext
 * runs its own handler first, then the ones registered here in order: each
 * gets `(a, b, answer so far)` and an answer of its own (anything but
 * undefined) replaces it, so a handler may consume a call (true) or
 * override a value. create() registers handlers and starts nothing else.
 *
 * Brand-neutral: it ships in every build as is.
 */
(function () {
  'use strict';

  // ═══ After a chat (`csat`, `chatMenu`) ═══
  function afterChat(api) {
    var ctx = api.ctx;
    var config = ctx.config || {};
    var chatStore = api.chatStore;
    var shellStore = api.shellStore;
    var uiPrefsStore = api.uiPrefsStore;
    var panel = api.panel;
    var root = panel.getRootNode();
    var csatOn = api.feat('csat');
    var menuOn = api.feat('chatMenu');
    function opts() { return config.templateOptions || {}; }
    function active() { return root.activeElement; }
    function focusOn(el) { if (el) { try { el.focus({ preventScroll: true }); } catch (_) {} } }

    // Per conversation, for this page: the server's answer (GET …/csat:
    // { closed_id, rateable, rating, operator, transcript: { available, to } }),
    // the visitor's pick and comment, and where the rating and the transcript
    // stand. `want`: the answer is (again) worth asking for.
    var convs = {};
    function convFor(cid) {
      return convs[cid] || (convs[cid] = { want: true, seq: 0, srv: null, at: null, rating: 0, comment: '', state: 'ask', tr: 'idle', to: '' });
    }
    /** `done(status, json)`; status 0 when the request itself failed. */
    function call(cid, path, body, done) {
      var url = ctx.apiBase + '/api/widget/conversations/' + encodeURIComponent(cid) + '/' + path;
      var init = body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ workspace_id: ctx.workspaceId }, body)) }
        : { method: 'GET' };
      if (!body) url += '?workspace_id=' + encodeURIComponent(ctx.workspaceId || '');
      try {
        ctx.fetchWith(url, init).then(function (r) {
          return r.json().then(function (j) { return [r.status, j]; }, function () { return [r.status, null]; });
        }).then(function (a) { done(a[0], a[1] || {}); }, function () { done(0, {}); });
      } catch (_) { done(0, {}); }
    }
    function ask(cid) {
      var c = convFor(cid);
      if (!c.want || c.busy) return;
      c.want = false;
      c.busy = true;
      var seq = ++c.seq;
      call(cid, 'csat', null, function (status, j) {
        c.busy = false;
        if (seq !== c.seq) return;
        if (status === 200) {
          c.srv = j;
          if (j.rating && j.closed_id === c.at) { c.state = 'done'; c.rating = +j.rating.score || c.rating; }
        }
        repaint(cid);
      });
    }
    /** The card's and the menu's transcript: null unless the server offers it (or it was asked for). */
    function transcriptVm(c) {
      var t = c.srv && c.srv.transcript;
      if (opts().transcriptEmail === false || (c.tr === 'idle' && !(t && t.available))) return null;
      return { state: c.tr, to: c.to || (t && t.to) || '' };
    }

    // The thread and the bar repainted for this conversation's new state.
    function threadShown() {
      var st = api.deriveChatTabState().name;
      return shellStore.get().activeTab === 'chat' && (st === 'AI_CHAT' || st === 'HUMAN_WELCOME' || st === 'ACTIVE_THREAD');
    }
    /**
     * The closed row the thread ends with (the card's place): the newest one
     * with only system rows after it (a join, a transfer); anything somebody
     * said after it reopened the thread. The server's rule
     * (conversationClosedNotice.ts latestClosedRow).
     */
    function lastClosed(s) {
      var msgs = s.messages || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        if (m.__id && m.metadata && m.metadata.kind === 'conversation_closed') return m;
        if (m.senderType !== 'system') break;
      }
      return null;
    }
    function repaint(cid) {
      var s = chatStore.get();
      if (String(s.conversationId) !== String(cid)) return;
      var a = active();
      // Only a thread with a card to draw is repainted (the menu's answers
      // change the bar alone). A pre-chat card's fields being filled in keep
      // their values: the card shows with the next paint.
      if (csatOn && lastClosed(s) && threadShown() && !(a && a.hasAttribute && a.hasAttribute('data-prechat'))) api.renderBody();
      api.paintChatHeader();
    }

    // ── The rating card (`csat`): under the closed row the thread ends with ──
    function csatVm(s) {
      var m = lastClosed(s);
      var cid = s.conversationId;
      if (!csatOn || opts().csat === false || !cid || !m) return null;
      var c = convFor(cid);
      // Another closure: a new card, asked about unless the answer in hand is about it.
      if (c.at !== m.__id) {
        c.at = m.__id;
        c.rating = 0;
        c.comment = '';
        c.state = 'ask';
        if (c.srv && c.srv.closed_id === m.__id) {
          if (c.srv.rating) { c.state = 'done'; c.rating = +c.srv.rating.score || 0; }
        } else c.want = true;
      }
      ask(cid);
      var srv = c.srv;
      if (!srv || srv.closed_id !== m.__id || (c.state !== 'done' && c.state !== 'gone' && !srv.rateable)) return null;
      var op = srv.operator || {};
      return {
        closedId: m.__id,
        name: op.name || m.metadata.operator_name || m.metadata.agent_name || '',
        avatar: op.avatar || null,
        rating: c.rating,
        comment: c.comment,
        state: c.state,
        transcript: transcriptVm(c),
      };
    }
    // A repaint keeps the card's focus (and the comment's caret).
    var keep = null;
    function noteFocus() {
      var el = active();
      keep = null;
      if (!el || !el.closest || !el.closest('[data-csat]')) return;
      var rate = el.getAttribute('data-csat-rate');
      keep = el.hasAttribute('data-csat-comment') ? { sel: '[data-csat-comment]', a: el.selectionStart, b: el.selectionEnd }
        : { sel: rate ? '[data-csat-rate="' + rate + '"]' : el.hasAttribute('data-csat-transcript') ? '[data-csat-transcript]'
          : el.hasAttribute('data-csat-submit') ? '[data-csat-submit]' : '[data-csat]' };
    }
    api.wrap('messagesHtml', function (orig, s, extra, view) {
      // A plain thread only (a pre-chat card passed in has none).
      if (extra === undefined && view) {
        view.csat = csatVm(s);
        noteFocus();
      }
      return orig(s, extra, view);
    });
    function submit(cid, c) {
      if (c.state === 'sending' || c.state === 'done' || !c.rating) return;
      if (api.transportStore.get().connectionState !== 'online') { c.state = 'error'; repaint(cid); return; }
      c.state = 'sending';
      repaint(cid);
      var at = c.at;
      call(cid, 'csat', { closed_id: at, rating: c.rating, comment: c.comment.trim() || null }, function (status, j) {
        // A newer closure has a card of its own.
        if (c.at !== at) return;
        var rated = status === 200 || (status === 409 && j.error === 'already_rated');
        if (rated) {
          c.state = 'done';
          c.rating = +(j.rating && j.rating.score) || c.rating;
        } else {
          // Not ratable any more (reopened, the window passed, the option
          // was turned off, the feature is unavailable): said, not offered.
          c.state = status === 409 || status === 403 || status === 503 ? 'gone' : 'error';
        }
        repaint(cid);
      });
    }
    function sendTranscript(cid, c) {
      if (c.tr === 'sending' || c.tr === 'sent' || c.tr === 'no') return;
      if (api.transportStore.get().connectionState !== 'online') { c.tr = 'failed'; repaint(cid); return; }
      c.tr = 'sending';
      repaint(cid);
      var tz = null;
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) {}
      call(cid, 'transcript', { locale: ctx.locale, tz: tz }, function (status, j) {
        if (status === 200) { c.tr = 'sent'; c.to = String(j.to || ''); }
        // A try later can work (the network, the mail provider, the pace);
        // the limits, a missing address or a switched-off option cannot.
        else c.tr = !status || status >= 500 && status !== 503 || status === 429 && j.error !== 'limit_reached' && j.error !== 'workspace_limit' ? 'failed' : 'no';
        repaint(cid);
      });
    }
    // The thread's controls, delegated on its host (bound once: it is
    // repainted, never replaced).
    function onThreadClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-csat-rate], [data-csat-submit], [data-csat-transcript]') : null;
      var cid = chatStore.get().conversationId;
      var c = el && cid && convs[cid];
      if (!c) return;
      if (el.hasAttribute('data-csat-submit')) { submit(cid, c); return; }
      if (el.hasAttribute('data-csat-transcript')) { sendTranscript(cid, c); return; }
      if (c.state === 'sending') return;
      // A pick changes the card in place: the visitor's focus stays.
      c.rating = +el.getAttribute('data-csat-rate');
      var card = el.closest('[data-csat]');
      api.each(card, '[data-csat-rate]', function (b) { b.setAttribute('aria-pressed', String(b === el)); });
      var send = card.querySelector('[data-csat-submit]');
      if (send) send.disabled = false;
    }
    function onThreadInput(ev) {
      var el = ev.target;
      var c = convs[chatStore.get().conversationId];
      if (c && el && el.hasAttribute && el.hasAttribute('data-csat-comment')) c.comment = String(el.value || '').slice(0, 1000);
    }
    api.on('wired', function (host) {
      if (!host.__gsLate) {
        host.__gsLate = 1;
        host.addEventListener('click', onThreadClick);
        host.addEventListener('input', onThreadInput);
      }
      var k = keep;
      keep = null;
      if (!k) return;
      var card = host.querySelector('[data-csat]');
      var el = card && card.querySelector(k.sel);
      // A control gone (sent, rated): the card itself, whose status is read out.
      if (!el || el.disabled) el = card;
      focusOn(el);
      if (k.a != null && el && el.setSelectionRange) { try { el.setSelectionRange(k.a, k.b); } catch (_) {} }
    });
    // A history (re)load is asked about again.
    api.on('history', function (cid) { if (convs[cid]) convs[cid].want = true; });

    // ── The chat bar's menu (`chatMenu`) ──
    var header = api.chatQ('[data-chat-header]');
    var soundKey = 'gs:sound:' + ctx.workspaceId;
    var soundAllowed = !(config.features && config.features.notificationSound === false);
    var menuOpen = false;
    var menuCid = null;
    var keepHead = null;
    // The visitor's own choice from an earlier visit.
    if (menuOn && soundAllowed) {
      try { if (window.localStorage.getItem(soundKey) === '0') uiPrefsStore.set({ soundEnabled: false }); } catch (_) {}
    }
    function menuVm(vm) {
      var cid = chatStore.get().conversationId;
      if (!menuOn || !header || !vm || vm.isNew || !cid) return null;
      var items = [];
      var c = convFor(cid);
      // Without the sound item only the transcript could fill the menu: ask now.
      if (!soundAllowed && opts().transcriptEmail !== false) ask(cid);
      var tr = transcriptVm(c);
      if (tr) items.push({ action: 'transcript', state: tr.state, to: tr.to });
      if (soundAllowed) items.push({ action: 'sound', on: !!uiPrefsStore.get().soundEnabled });
      return items.length ? { open: menuOpen && menuCid === cid, items: items } : null;
    }
    /** The behaviour hook that finds `el` again in a repainted bar (its first `data-*`), or null. */
    function hookOf(el) {
      for (var i = 0, at = (el && el.attributes) || []; i < at.length; i++) {
        var a = at[i];
        if (a.name.indexOf('data-') === 0 && !/["\\]/.test(a.value)) return '[' + a.name + (a.value ? '="' + a.value + '"' : '') + ']';
      }
      return null;
    }
    api.wrap('chatHeaderHtml', function (orig, vm) {
      vm = vm || {};
      vm.menu = menuVm(vm);
      if (!vm.menu) menuOpen = false;
      // The bar is rewritten whole: what had the focus in it (the back
      // button, the ⋯, an item) gets it back; an item gone, the ⋯.
      var el = active();
      keepHead = el && header && header.contains(el) ? hookOf(el) : null;
      if (keepHead) {
        Promise.resolve().then(function () {
          var sel = keepHead;
          keepHead = null;
          if (sel && header) focusOn(header.querySelector(sel) || (sel.indexOf('data-chat-menu') > 0 ? header.querySelector('[data-chat-menu-toggle]') : null));
        });
      }
      return orig(vm);
    });
    function setMenu(open, focusIt) {
      if (!open === !menuOpen) return;
      menuOpen = !!open;
      menuCid = chatStore.get().conversationId;
      if (open && menuCid && opts().transcriptEmail !== false) ask(menuCid);
      api.paintChatHeader();
      if (!focusIt) return;
      keepHead = null;
      focusOn(header.querySelector(open ? '[data-chat-menu-action]' : '[data-chat-menu-toggle]'));
    }
    if (menuOn && header) {
      header.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target : null;
        if (t && t.closest('[data-chat-menu-toggle]')) { setMenu(!menuOpen, true); return; }
        var item = t && t.closest('[data-chat-menu-action]');
        var cid = chatStore.get().conversationId;
        if (!item || !cid) return;
        if (item.getAttribute('data-chat-menu-action') === 'sound') {
          var on = !uiPrefsStore.get().soundEnabled;
          uiPrefsStore.set({ soundEnabled: on });
          try { if (on) window.localStorage.removeItem(soundKey); else window.localStorage.setItem(soundKey, '0'); } catch (_) {}
        } else if (item.getAttribute('aria-disabled') !== 'true') sendTranscript(cid, convFor(cid));
      });
      // Arrows move through the items (from the ⋯ too), Home and End to the ends.
      header.addEventListener('keydown', function (ev) {
        var items = header.querySelectorAll('[data-chat-menu-action]');
        var n = items.length;
        var k = ev.key;
        if (!menuOpen || !n || (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End')) return;
        var i = Array.prototype.indexOf.call(items, active());
        var up = k === 'ArrowUp' || k === 'End';
        var to = k === 'Home' ? 0 : k === 'End' ? n - 1 : i < 0 ? (up ? n - 1 : 0) : (i + (up ? n - 1 : 1)) % n;
        ev.preventDefault();
        focusOn(items[to]);
      });
      // Tab (or anything else) taking the focus out of the bar closes it.
      header.addEventListener('focusout', function () {
        if (!menuOpen) return;
        setTimeout(function () {
          var a = active();
          if (menuOpen && !keepHead && !(a && header.contains(a))) setMenu(false);
        }, 0);
      });
      // Escape closes it first (never the widget), and a press anywhere else.
      panel.addEventListener('keydown', function (ev) {
        if (!menuOpen || ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        setMenu(false, true);
      }, true);
      panel.addEventListener('click', function (ev) {
        var t = ev.target;
        if (menuOpen && !(t && t.closest && t.closest('[data-chat-menu], [data-chat-menu-toggle]'))) setMenu(false);
      }, true);
      // The sound item follows Core's preference, whoever changes it (the host page too).
      uiPrefsStore.subscribe(function () { if (menuOpen) api.paintChatHeader(); });
    }

    // Another thread, another view or a closed panel closes the menu; a
    // reopened panel asks the server again (a rating given elsewhere), as
    // does a new address on the contact (the transcript's recipient). A
    // thread that comes to exist (its first message answered) or another
    // one repaints the bar: the ⋯ is the conversation's, and the bar's own
    // signature does not know it.
    var barCid = chatStore.get().conversationId;
    chatStore.subscribe(function (s) {
      if (String(s.conversationId) === String(barCid)) return;
      barCid = s.conversationId;
      if (menuOpen) setMenu(false);
      else if (menuOn) api.paintChatHeader();
    });
    var wasOpen = !!shellStore.get().isOpen;
    shellStore.subscribe(function (s) {
      if (s.isOpen && !wasOpen) {
        for (var k in convs) if (Object.prototype.hasOwnProperty.call(convs, k)) convs[k].want = true;
        // The thread on screen is not repainted by a reopen: asked now.
        var cid = chatStore.get().conversationId;
        if (cid && convs[cid]) ask(cid);
      }
      wasOpen = !!s.isOpen;
      if (menuOpen && (!s.isOpen || s.activeTab !== 'chat')) setMenu(false);
    });
    var email = ((api.identityStore.get() || {}).contact || {}).email || '';
    api.identityStore.subscribe(function (s) {
      var next = ((s || {}).contact || {}).email || '';
      if (next === email) return;
      email = next;
      for (var k in convs) if (Object.prototype.hasOwnProperty.call(convs, k)) convs[k].want = true;
    });
  }

  function create(api) {
    if (api.feat('csat') || api.feat('chatMenu')) afterChat(api);
    return {};
  }

  window.__gs_mod_late = { v: 1, create: create };
})();
