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
 *   reactions  a message's reactions (`metadata.reactions` for
 *              `messagesHtml`, `view.react`): GET …/conversations/:id/reactions
 *              when a thread shows (again after 60 s and after a reconnect),
 *              the live `message_reactions` event (hook `reaction`, the newest
 *              `at` wins), and the visitor's heart `[data-msg-react]` toggled
 *              at once and confirmed (or undone) by POST …/reactions
 *   prechatSteps  the pre-chat one question at a time (template option
 *              `prechatMode: 'steps'`): the questions and answers in the thread
 *              (`R.prechatStepsHtml` in the card's place), the step in the
 *              composer's place (`R.prechatStepBoxHtml`), one POST
 *              /api/widget/identity/prechat at the end; a conversation keeps
 *              the mode its pre-chat first showed in
 *   awayThread the message left while the team is away, in the thread: the
 *              first one goes to POST /api/widget/offline-messages (its
 *              `client_message_id` makes a retry safe), the automated reply
 *              under it (`view.awayReply`) asks for an email (POST
 *              /api/widget/identity/offline-email); later ones go as any message
 *   queuePosition  the visitor's place in the queue on the queued row
 *              (`view.queue`): GET /api/widget/queue every 30 s while that
 *              row is the thread's last word and the thread is on screen
 *   instantAnswers  help articles that answer the message being written, over
 *              the composer (`R.kbSuggestHtml`, its tray put in here), until the
 *              team (an operator or the AI, not its greeting) first answers:
 *              GET /api/widget/kb-suggest (runtime-kb.js) once the typing
 *              stopped for 400 ms (never inside an IME composition; the request
 *              before it aborted; answers kept per draft), a row opens its
 *              article and back returns to the chat and its draft; Escape
 *              closes the tray for that draft; a refusal (429) or a failure
 *              stops asking for 30 s
 *   dlProgress an attachment's bytes read as they come (runtime.js hook
 *              `media`): `.dl-on` and `--dl` (0..1) on its download control
 *              or voice note while they do; without a length, Core's own read
 *   emojiSearch the picker's search field (shown here): the keywords
 *              (runtime-emoji.js, ModuleLoader name `emoji`) loaded on its first
 *              use, what does not match hidden (a group with nothing left, and
 *              a repeat of an emoji already shown), Enter picks the first one,
 *              Escape empties the field before it closes the picker
 *   (any)      a search result's `snippet` and `matches` (the server's, with
 *              `match=words`) for `kbHtml`
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

  /**
   * A widget API request: `done(status, json)`, status 0 when the request
   * itself failed. `body` null: a GET (`path` carries its query).
   */
  function request(api, path, body, done) {
    var ctx = api.ctx;
    var init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'GET' };
    try {
      ctx.fetchWith(ctx.apiBase + path, init).then(function (r) {
        return r.json().then(function (j) { return [r.status, j]; }, function () { return [r.status, null]; });
      }).then(function (a) { done(a[0], a[1] || {}); }, function () { done(0, {}); });
    } catch (_) { done(0, {}); }
  }
  function enc(v) { return encodeURIComponent(v == null ? '' : v); }
  /** A plain thread is on screen (not a pre-chat, a form or another view). */
  function threadShown(api) {
    var st = api.deriveChatTabState().name;
    var sh = api.shellStore.get();
    return !!sh.isOpen && sh.activeTab === 'chat' && (st === 'AI_CHAT' || st === 'HUMAN_WELCOME' || st === 'ACTIVE_THREAD');
  }
  /** Repaints a plain thread on screen, unless pre-chat fields being filled in would be repainted. */
  function repaintThread(api) {
    var a = api.panel.getRootNode().activeElement;
    if (threadShown(api) && !(a && a.hasAttribute && a.hasAttribute('data-prechat'))) api.renderBody();
  }
  function focusOn(el) { if (el) { try { el.focus({ preventScroll: true }); } catch (_) {} } }
  // The server's rule (zod's `.email()`), as Core's Util.isValidEmail.
  var EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;

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
      // Not while the bar stands for the team after a pre-chat, nobody
      // assigned yet (`vm.prechat`, boards 08·a-c draw no ⋯).
      if (vm.prechat && !(vm.operator && vm.operator.name)) return null;
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

  // ═══ Reactions (`reactions`) ═══
  // Reactions live beside the messages, never in them: a map by message id
  // for the conversation on screen, handed to the renderer as
  // `metadata.reactions` only inside its messagesHtml, so the stores, the
  // histories and `default` never see them.
  function reactions(api) {
    var ctx = api.ctx;
    var chatStore = api.chatStore;
    var root = api.panel.getRootNode();
    var HEART = '❤️';
    var cid = null;     // the conversation the maps are about
    var lists = {};     // message id -> [{ emoji, count, mine }]
    var ats = {};       // message id -> `at` of the state in hand
    var busy = {};      // message id -> a toggle on its way
    var shown = {};     // badges already on screen (no second pop)
    var readAt = 0;     // when the conversation's reactions were last read (0: read again)
    var seq = 0;
    var refocus = null;
    function forConv(c) {
      c = c == null ? null : String(c);
      if (c === cid) return;
      cid = c;
      lists = {};
      ats = {};
      busy = {};
      readAt = 0;
    }
    /** Keeps the newest state: one older than the state in hand is ignored. */
    function setList(id, list, at) {
      if (at != null && ats[id] > at) return false;
      if (at != null) ats[id] = at;
      if (list && list.length) lists[id] = list; else delete lists[id];
      return true;
    }
    function norm(list, mineKey) {
      return (Array.isArray(list) ? list : []).map(function (r) {
        return { emoji: String(r && r.emoji || ''), count: Math.floor(Number(r && r.count)) || 0, mine: !!(r && r[mineKey]) };
      });
    }
    function read() {
      var c = cid;
      var my = ++seq;
      readAt = Date.now();
      request(api, '/api/widget/conversations/' + enc(c) + '/reactions?workspace_id=' + enc(ctx.workspaceId), null, function (status, j) {
        if (my !== seq || c !== cid || status !== 200) return;
        var got = j.reactions || {};
        var id;
        for (id in lists) if (!busy[id] && !Object.prototype.hasOwnProperty.call(got, id)) setList(id, [], j.at);
        for (id in got) if (Object.prototype.hasOwnProperty.call(got, id) && !busy[id]) setList(id, norm(got[id], 'mine'), j.at);
        paint();
      });
    }
    // Read when a thread is on screen: a new one, or one read over a minute ago.
    function maybeRead() {
      var c = chatStore.get().conversationId;
      if (!c || !threadShown(api)) return;
      forConv(c);
      if (!readAt || Date.now() - readAt > 60000) read();
    }
    api.wrap('messagesHtml', function (orig, s, extra, view) {
      if (view) {
        view.react = true;
        var mine = cid && String(chatStore.get().conversationId) === cid;
        if (mine && Object.keys(lists).length) {
          s = Object.assign({}, s, { messages: (s.messages || []).map(function (m) {
            var list = m && m.__id && lists[m.__id];
            return list ? Object.assign({}, m, { metadata: Object.assign({}, m.metadata, { reactions: list }) }) : m;
          }) });
        }
      }
      return orig(s, extra, view);
    });
    // The heart: on screen at once, then the server's answer (or the state before).
    function toggle(el) {
      var id = el.getAttribute('data-msg-id');
      var emoji = el.getAttribute('data-msg-react') || HEART;
      // The thread on screen (a heart above a pre-chat card is one too).
      forConv(chatStore.get().conversationId);
      var c = cid;
      if (!id || !c || busy[id]) return;
      var before = lists[id] || [];
      var atBefore = ats[id];
      var on = !before.some(function (r) { return r.emoji === emoji && r.mine; });
      var found = false;
      var next = before.map(function (r) {
        if (r.emoji !== emoji) return r;
        found = true;
        return { emoji: r.emoji, count: r.count + (on ? 1 : -1), mine: on };
      }).filter(function (r) { return r.count > 0; });
      if (!found && on) next.push({ emoji: emoji, count: 1, mine: true });
      busy[id] = 1;
      setList(id, next, null);
      paint(true);
      request(api, '/api/widget/conversations/' + enc(c) + '/reactions', { workspace_id: ctx.workspaceId, message_id: id, emoji: emoji, on: on }, function (status, j) {
        if (c !== cid) return;
        busy[id] = 0;
        if (status === 200 && Array.isArray(j.reactions)) setList(id, norm(j.reactions, 'mine'), j.at);
        // Not saved: the state before, unless a newer one came meanwhile.
        else if (ats[id] === atBefore) setList(id, before, null);
        paint();
      });
    }
    // A paint draws the hearts anew: the one with the keyboard focus gets it
    // back (`wired` below), whatever changed its row (the toggle, the
    // server's answer, a live event, a read). `all`: any chat view (a heart
    // above a pre-chat card too), else a plain thread only.
    function paint(all) {
      var a = root.activeElement;
      refocus = a && a.hasAttribute && a.hasAttribute('data-msg-react') ? a.getAttribute('data-msg-id') : null;
      if (all) api.renderBody(); else repaintThread(api);
      refocus = null;
    }
    api.panel.addEventListener('click', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-msg-react]') : null;
      if (el && api.panel.contains(el)) toggle(el);
    });
    // Another visitor tab or an operator reacted (the visitor's own reaction is `visitor`).
    api.on('reaction', function (p) {
      if (!p || cid == null || String(p.conversation_id) !== cid || !p.message_id) return;
      if (setList(String(p.message_id), norm(p.reactions, 'visitor'), Number(p.at) || 0)) paint();
    });
    api.on('wired', function (host) {
      // A badge already on screen does not pop in again.
      api.each(host, '.react[data-msg-id]', function (b) {
        var k = b.getAttribute('data-msg-id') + '|' + b.textContent;
        if (shown[k]) b.classList.add('no-enter');
        shown[k] = 1;
      });
      if (refocus) {
        focusOn(host.querySelector('[data-msg-react][data-msg-id="' + refocus.replace(/[^\w-]/g, '') + '"]'));
        refocus = null;
      }
    });
    // After every paint (a thread shown again repaints nothing when it did
    // not change) and when the panel opens again.
    api.on('body', maybeRead);
    api.shellStore.subscribe(function () { maybeRead(); });
    // A reconnect may have missed events: read again.
    var online = api.transportStore.get().connectionState === 'online';
    var wasOnline = online;
    api.transportStore.subscribe(function (t) {
      var now = t.connectionState === 'online';
      if (now && !online && wasOnline) { readAt = 0; maybeRead(); }
      if (now) wasOnline = true;
      online = now;
    });
    return maybeRead;
  }

  // ═══ The pre-chat one question at a time (`prechatSteps`) ═══
  function steps(api) {
    var ctx = api.ctx;
    var identity = api.identity;
    var P = api.P;
    var root = api.panel.getRootNode();
    var zone = api.chatQ('[data-composer-zone]');
    var inputBar = api.chatQ('[data-input-bar]');
    var prechatValues = api.chatUI.x[4];
    if (!zone || !inputBar || typeof P.prechatStepBoxHtml !== 'function') return;
    // The edition's prefix for a number typed without one (no workspace country exists).
    var PREFIX = ctx.config.edition === 'international' ? '' : '+98';
    var PRECHAT = { PRECHAT_FOR_HUMAN: 1, HANDOFF_PRECHAT: 1 };
    // The mode this conversation's pre-chat showed in first: a card (or the
    // form) already on screen when this module came keeps its mode.
    var mode = api.panel.querySelector('[data-prechat]') || api.chatQ('[data-prechat]') ? 'card' : null;
    var st = null;          // the steps in progress
    var done = null;        // Core's "submitted" for the pre-chat on screen
    var skipped = false;    // every step skipped: no pre-chat for this page
    var state = null;       // the chat tab's state, as the last paint saw it
    var painted = false;    // this paint drew the steps
    var box = null;
    var boxSig = null;
    function on() {
      return mode !== 'card' && (ctx.config.templateOptions || {}).prechatMode === 'steps';
    }
    function start(editing) {
      var v = prechatValues();
      st = {
        keys: ['name', 'email', 'phone'].filter(function (k) { return identity.isAsked(k); }),
        i: 0, log: [], answers: {}, drafts: { name: v.name, email: v.email, phone: v.phone },
        busy: false, error: false, editing: editing, focus: editing || state === 'PRECHAT_FOR_HUMAN',
      };
      api.paintChatHeader();
    }
    function stop() {
      st = null;
      api.paintChatHeader();
    }
    /** The answer as the server takes it, or null when it is not one. */
    function check(key, raw) {
      if (key === 'name') return raw.slice(0, 120);
      if (key === 'email') return EMAIL_RE.test(raw) ? raw : null;
      // Persian and Arabic digits, spaces and punctuation; 00 or + is a
      // country code, else the edition's prefix without the leading zeros.
      var d = raw.replace(/[۰-۹٠-٩]/g, function (c) { return String(c.charCodeAt(0) & 15); }).replace(/[\s\-().]/g, '');
      d = /^00/.test(d) ? '+' + d.slice(2) : d.charAt(0) === '+' || !PREFIX ? d : PREFIX + d.replace(/^0+/, '');
      return /^\+?\d{6,20}$/.test(d) ? d : null;
    }
    function firstName() {
      var n = String(st.answers.name || ((api.identityStore.get() || {}).contact || {}).name || '').trim();
      return n ? n.split(/\s+/)[0] : '';
    }
    function answer(skip) {
      if (!st || st.busy) return;
      var key = st.keys[st.i];
      var raw = String(st.drafts[key] || '').trim();
      if (skip) {
        if (identity.isRequired(key)) return;
        st.answers[key] = null;
        st.log.push({ key: key, skip: true });
      } else {
        if (!raw) return;
        var val = check(key, raw);
        st.log.push({ key: key, value: raw, ok: val != null, why: 'invalid' });
        if (val == null) { api.renderBody(); return; }
        st.answers[key] = val;
      }
      st.error = false;
      // The next step not answered yet (after a refusal from the server, the
      // later answers stand); none: the details go to the server.
      for (var i = 0; i < st.keys.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(st.answers, st.keys[i])) { st.i = i; st.focus = true; api.renderBody(); return; }
      }
      submit();
    }
    function submit() {
      var a = st.answers;
      if (!a.name && !a.email && !a.phone) {
        // Nothing given (every step was optional): the chat opens without;
        // the saved details being edited stay as they were.
        if (st.editing) api.showPrechatSummary(identity);
        else skipped = true;
        stop();
        api.renderBody();
        focusOn(api.chatQ('[data-msg-input]'));
        return;
      }
      st.busy = true;
      st.error = false;
      api.renderBody();
      var editing = st.editing;
      identity.submitPrechat({ name: a.name || '', email: a.email || '', phone: a.phone || '' }, function (ok, resp) {
        if (!st) return;
        st.busy = false;
        if (ok) {
          var cb = done;
          stop();
          if (editing) {
            api.showPrechatSummary(identity);
            api.renderBody();
            focusOn(api.chatQ('[data-msg-input]'));
          } else if (cb) cb();
          return;
        }
        // A field the server refused goes back to its step; anything else
        // is said under the step, to try again.
        resp = resp || {};
        var f = resp.field || st.keys.filter(function (k) { return resp.details && resp.details[k]; })[0];
        var at = f ? st.keys.indexOf(f) : -1;
        if (at < 0) st.error = true;
        else {
          st.i = at;
          delete st.answers[f];
          st.log.push({ key: f, value: String(st.drafts[f] || '').trim(), ok: false, why: /_required$/.test(resp.error || '') ? 'required' : 'invalid' });
          st.focus = true;
        }
        api.renderBody();
      });
    }
    // The card's place: the steps, for a pre-chat (or the saved details
    // being edited) whose conversation did not show a card first.
    api.wrap('handoffPrechatCardHtml', function (orig, idt, contact, locale, subtitle, anim) {
      if (!on()) {
        mode = mode || 'card';
        return orig(idt, contact, locale, subtitle, anim);
      }
      mode = 'steps';
      var editing = !PRECHAT[state];
      if (!st) start(editing);
      painted = true;
      var handoff = state === 'HANDOFF_PRECHAT';
      return P.prechatStepsHtml({
        key: st.keys[st.i], log: st.log, firstName: firstName(),
        intro: handoff ? subtitle : '', introAnimate: handoff && !!anim,
      });
    });
    // A pre-chat state paints the chat view with the steps (a first chat too)
    // and no composer.
    api.on('inline', function (cb) {
      done = cb;
      return on();
    });
    api.on('lock', function (name) {
      state = name;
      painted = false;
      if (PRECHAT[name] && on()) return false;
    });
    api.on('skip', function (a, b, out) { return out || skipped || undefined; });
    // While the steps show, the chat bar is the conversation's, not "new conversation".
    api.wrap('chatHeaderHtml', function (orig, vm) {
      if (st && vm) vm.isNew = false;
      return orig(vm);
    });
    function boxVm() {
      var key = st.keys[st.i];
      return {
        key: key, n: st.i + 1, total: st.keys.length, optional: !identity.isRequired(key),
        value: st.drafts[key] || '', prefix: key === 'phone' ? PREFIX : '', busy: st.busy, error: st.error,
      };
    }
    // After every paint of the chat tab: the step in the composer's place,
    // made again only when the step itself changed (typing in it, a new
    // message or a typing row repaint the thread, never the step).
    api.on('body', function () {
      if (api.shellStore.get().activeTab !== 'chat') return;
      var vm = painted && st ? boxVm() : null;
      // Editing the saved details: the steps take the composer's place too.
      if (vm && st.editing) inputBar.style.display = 'none';
      var sig = vm ? [vm.key, vm.n, vm.total, vm.busy, vm.error].join('|') : null;
      if (sig === boxSig) return;
      var had = box && box.contains(root.activeElement);
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
      boxSig = sig;
      if (!vm) return;
      inputBar.insertAdjacentHTML('beforebegin', P.prechatStepBoxHtml(vm));
      box = inputBar.previousElementSibling;
      var input = box && box.querySelector('[data-prechat-step-input]');
      if (input && (had || st.focus)) {
        focusOn(input);
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
      }
      st.focus = false;
    });
    // The step's controls, delegated on the composer zone (bound once).
    var composing = false;
    zone.addEventListener('input', function (ev) {
      var el = ev.target;
      if (!st || !el || !el.hasAttribute || !el.hasAttribute('data-prechat-step-input')) return;
      st.drafts[st.keys[st.i]] = el.value || '';
      var send = box && box.querySelector('[data-prechat-step-submit]');
      if (send) send.disabled = st.busy || !String(el.value || '').trim();
    });
    zone.addEventListener('compositionstart', function () { composing = true; });
    zone.addEventListener('compositionend', function () { composing = false; });
    zone.addEventListener('keydown', function (ev) {
      var el = ev.target;
      // An IME's Enter commits its word.
      if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229 || composing || !el || !el.hasAttribute || !el.hasAttribute('data-prechat-step-input')) return;
      ev.preventDefault();
      answer(false);
    });
    zone.addEventListener('click', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-prechat-step-submit], [data-prechat-step-skip]') : null;
      if (el) answer(el.hasAttribute('data-prechat-step-skip'));
    });
    // A new conversation (or another one) starts its pre-chat afresh.
    function reset() { mode = null; if (st) stop(); }
    var startNew = api.chatUI.startNewConversation;
    api.chatUI.startNewConversation = function () {
      var out = startNew.apply(this, arguments);
      reset();
      return out;
    };
    // Back in a conversation, its pre-chat's mode again.
    var modes = {};
    var shownCid = api.chatStore.get().conversationId;
    api.chatStore.subscribe(function (s) {
      var c = s.conversationId;
      if (c && shownCid && String(c) !== String(shownCid) && !(st && st.busy)) {
        modes[shownCid] = mode;
        reset();
        mode = modes[c] || null;
      }
      if (c) shownCid = c;
    });
  }

  // ═══ The message left while the team is away (`awayThread`) ═══
  function away(api) {
    var ctx = api.ctx;
    var config = ctx.config || {};
    var chatStore = api.chatStore;
    var presenceStore = api.presenceStore;
    var identityStore = api.identityStore;
    var root = api.panel.getRootNode();
    var msgInput = api.chatQ('[data-msg-input]');
    var placeholder = msgInput ? msgInput.getAttribute('placeholder') : null;
    var invited = false;    // the composer shows the renderer's "add more" text
    var captured = {};      // local ids of the messages sent as the message left away
    var card = { status: 'ask', value: '', error: '' };
    var keep = null;        // the e-mail field's focus and caret across a repaint
    // The leave-a-message form already on screen keeps the tab while it is.
    var formFirst = !!api.panel.querySelector('[data-fb="message"]');
    function awayOn() {
      if (formFirst && api.panel.querySelector('[data-fb="message"]')) return false;
      formFirst = false;
      var p = presenceStore.get();
      var av = config.availability || {};
      var ai = config.aiAgent;
      // The workspace's offline mode as createPresence publishes it (a
      // capture unless it hides the widget or only shows a message);
      // 'accept_messages' is the store's value until presence publishes.
      var m = p.offlineMode;
      return p.status === 'offline' && p.liveChatEnabled !== false
        && m !== 'accept_messages' && m !== 'hide_widget' && m !== 'show_offline_message'
        && !(ai && ai.suppressGreeting === true)
        && ctx.__quotaFull !== true && av.quota_full !== true;
    }
    function contact() { return (identityStore.get() || {}).contact || {}; }
    // Away, the chat tab stays the thread with the composer open; attaching
    // waits for the conversation (the message left away takes no file).
    api.on('away', function (kind) {
      if (!awayOn()) return;
      return kind === 'attach' ? !!chatStore.get().conversationId : true;
    });
    // A conversation's first message, away: the message left for the team.
    // What the visitor writes while it is on its way waits for it (each
    // capture would be a conversation of its own), then goes as any message
    // of that conversation: Core's retry, once marked as not sent.
    var later = null;
    api.on('send', function (req, cbs) {
      if (later && !req.conversationId) { later.push(req.clientMessageId, cbs); return true; }
      if (!awayOn() || req.conversationId || req.attachmentId) return;
      var c = contact();
      var body = { workspace_id: ctx.workspaceId, message: req.text, locale: ctx.locale || 'en', honeypot: '', client_message_id: req.clientMessageId };
      if (c.name) body.name = c.name;
      if (c.email) body.email = c.email;
      if (c.phone) body.phone = c.phone;
      captured[req.clientMessageId] = 1;
      later = [];
      // Core's transport rule: an answer for a conversation left meanwhile is dropped.
      var epoch = api.ConvEpoch.get();
      request(api, '/api/widget/offline-messages', body, function (status, j) {
        var next = later;
        later = null;
        if (!api.ConvEpoch.valid(epoch)) return;
        var ok = status === 200 && j.conversation_id;
        if (ok) {
          cbs.onConversation(j.conversation_id);
          cbs.onAccepted({ messageId: j.message_id || null });
        } else cbs.onError({ status: status, feature: j.feature || j.code });
        for (var i = 0; i < next.length; i += 2) {
          next[i + 1].onError({});
          if (ok) api.chatUI.resendMessage(next[i], api.renderBody);
        }
      });
      return true;
    });
    /** The automated reply's view-model: under the message left away (this page's, or a history's). */
    function replyVm(s) {
      var msgs = s.messages || [];
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (m.sender !== 'visitor' || !(captured[m.localId] || (m.metadata && m.metadata.source === 'offline_capture'))) continue;
        if (m.status === 'sending' || m.status === 'failed') return null;
        var email = String(contact().email || '');
        // The email step promises the reply by email: drawn only while
        // visitor email is switched on (config.visitorEmail,
        // shared/visitorEmail.ts); else the reply says it comes here.
        if (config.visitorEmail !== true) return { at: i, email: '', value: '', error: '', skip: true, status: 'skipped' };
        return {
          at: i, email: email, value: card.value, error: card.error, skip: !api.identity.isRequired('email'),
          status: email && card.status !== 'saving' ? 'saved' : card.status === 'saved' ? 'ask' : card.status,
        };
      }
      return null;
    }
    api.wrap('messagesHtml', function (orig, s, extra, view) {
      if (view) {
        view.away = awayOn();
        view.awayReply = replyVm(s);
        var a = root.activeElement;
        keep = a && a.hasAttribute && a.hasAttribute('data-fb') ? { a: a.selectionStart, b: a.selectionEnd } : null;
      }
      return orig(s, extra, view);
    });
    function saveEmail(input) {
      var c = chatStore.get().conversationId;
      var v = String(input.value || '').trim();
      card.value = v;
      if (card.status === 'saving' || !c) return;
      if (!EMAIL_RE.test(v)) {
        card.error = 'invalidEmail';
        api.renderBody();
        return;
      }
      card.status = 'saving';
      card.error = '';
      api.renderBody();
      request(api, '/api/widget/identity/offline-email', { workspace_id: ctx.workspaceId, conversation_id: c, email: v }, function (status, j) {
        if (status === 200) {
          var prev = contact();
          card.status = 'saved';
          identityStore.set({ identityState: 'identified', contact: Object.assign({}, prev, { id: j.contact_id || prev.id || null, email: v }) });
        } else {
          card.status = 'ask';
          card.error = status === 400 ? 'invalidEmail' : 'fallbackError';
        }
        repaintThread(api);
      });
    }
    // The card's controls, on the panel (bound once, before any card is drawn).
    api.panel.addEventListener('submit', function (ev) {
      var form = ev.target;
      if (!form || !form.closest || !form.closest('.away-reply')) return;
      ev.preventDefault();
      var input = form.querySelector('[data-fb="email"]');
      if (input) saveEmail(input);
    });
    api.panel.addEventListener('input', function (ev) {
      var el = ev.target;
      if (el && el.closest && el.closest('.away-reply') && el.hasAttribute('data-fb')) {
        card.value = el.value || '';
        if (card.error) { card.error = ''; el.setAttribute('aria-invalid', 'false'); }
      }
    });
    api.panel.addEventListener('click', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-fb-skip]') : null;
      if (!el || !el.closest('.away-reply')) return;
      card.status = 'skipped';
      api.renderBody();
      focusOn(msgInput);
    });
    api.on('wired', function (host) {
      var field = host.querySelector('.away-reply [data-fb="email"]');
      // The field the visitor was in, back with its caret (a status read out
      // stays where it is).
      if (keep && field && !root.activeElement) {
        focusOn(field);
        try { field.setSelectionRange(keep.a, keep.b); } catch (_) {}
      }
      keep = null;
      // Its card's error, said where the field is described.
      if (card.error && field) field.setAttribute('aria-invalid', 'true');
    });
    // While away, the composer invites more (a renderer naming that text in
    // the thread on screen); back to its own words otherwise.
    api.on('body', function () {
      var row = api.shellStore.get().activeTab === 'chat' && api.chatQ('[data-chat-messages] [data-ph-away]');
      var more = row && awayOn() ? row.getAttribute('data-ph-away') : null;
      if (msgInput && (more || invited)) msgInput.setAttribute('placeholder', more || placeholder || '');
      invited = !!more;
    });
    // The composer and the tab follow presence and the conversation.
    var wasAway = awayOn();
    function sync() {
      api.applyComposerState();
      api.syncAttachButton();
    }
    presenceStore.subscribe(function () {
      var now = awayOn();
      if (now === wasAway) return;
      wasAway = now;
      sync();
      if (api.shellStore.get().activeTab === 'chat') api.renderBody();
    });
    var hadConv = chatStore.get().conversationId;
    chatStore.subscribe(function (s) {
      var c = s.conversationId;
      if (String(c) === String(hadConv)) return;
      // Another conversation's reply starts over (the one just made keeps it).
      if (c && hadConv) card = { status: 'ask', value: '', error: '' };
      if (!c !== !hadConv) sync();
      hadConv = c;
    });
    var startNew = api.chatUI.startNewConversation;
    api.chatUI.startNewConversation = function () {
      var out = startNew.apply(this, arguments);
      card = { status: 'ask', value: '', error: '' };
      return out;
    };
    // This module comes after Core set the composer for the away team.
    sync();
  }

  // ═══ The place in the queue (`queuePosition`) ═══
  function queue(api) {
    var ctx = api.ctx;
    var chatStore = api.chatStore;
    var shellStore = api.shellStore;
    var q = null;        // { cid, row, position, waitMinutes }
    var timer = null;
    var asking = false;
    var over = {};       // queued rows the server said are not waiting any more
    /** Index of the queued row that is the thread's last word on routing, else -1. */
    function queuedRow(msgs) {
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        var k = m.metadata && m.metadata.kind;
        if (k === 'routing_in_queue') return i;
        if (k === 'routing_agent_joined' || k === 'conversation_transferred' || k === 'conversation_closed'
          || (m.sender !== 'visitor' && (m.senderType === 'agent' || m.senderType === 'operator' || m.senderType === 'human'))) return -1;
      }
      return -1;
    }
    /** The queued row worth asking about now: the thread on screen, the panel open, the page visible. */
    function wanted() {
      var s = chatStore.get();
      var sh = shellStore.get();
      var msgs = s.messages || [];
      var i = s.conversationId && sh.isOpen && sh.activeTab === 'chat' && document.visibilityState !== 'hidden' ? queuedRow(msgs) : -1;
      return i < 0 || over[msgs[i].__id || i] ? null : { cid: String(s.conversationId), row: msgs[i].__id || i };
    }
    function poll() {
      clearTimeout(timer);
      timer = null;
      var w = wanted();
      if (!w || asking) return;
      asking = true;
      request(api, '/api/widget/queue?workspace_id=' + enc(ctx.workspaceId) + '&conversation_id=' + enc(w.cid), null, function (status, j) {
        asking = false;
        var next = q;
        if (status === 200) {
          var n = Math.floor(Number(j.position)) || 0;
          next = n > 0 ? { cid: w.cid, row: w.row, position: n, waitMinutes: Math.floor(Number(j.wait_minutes)) || null } : null;
          if (!next) over[w.row] = 1;
        } else if (status > 399 && status < 500 && status !== 429) over[w.row] = 1; // refused: not asked again
        // The next ask is planned before the repaint (which would ask again).
        if (wanted()) timer = setTimeout(poll, 30000);
        if (JSON.stringify(next) !== JSON.stringify(q)) { q = next; repaintThread(api); }
      });
    }
    api.wrap('messagesHtml', function (orig, s, extra, view) {
      var i = view && q ? queuedRow(s.messages || []) : -1;
      if (i >= 0 && q.cid === String(chatStore.get().conversationId) && (s.messages[i].__id || i) === q.row) {
        view.queue = { at: i, position: q.position, waitMinutes: q.waitMinutes };
      }
      return orig(s, extra, view);
    });
    // Asked when such a row is shown, then every 30 s while it is wanted.
    api.on('body', function () { if (!timer && !asking) poll(); });
    document.addEventListener('visibilitychange', function () { if (!timer && !asking) poll(); });
    // A closed panel or another view pauses it; back, it asks at once.
    shellStore.subscribe(function () {
      if (!wanted()) { clearTimeout(timer); timer = null; } else if (!timer && !asking) poll();
    });
    return poll;
  }

  // ═══ Help articles while the first message is written (`instantAnswers`) ═══
  function suggest(api) {
    var ctx = api.ctx;
    var config = ctx.config || {};
    var chatStore = api.chatStore;
    var shellStore = api.shellStore;
    var kbUI = api.kbUI;
    var zone = api.chatQ('[data-composer-zone]');
    var input = api.chatQ('[data-msg-input]');
    var bar = api.chatQ('[data-input-bar]');
    if (!zone || !input || !bar || (config.features || {}).knowledgeBase === false) return;
    var cache = {};       // draft -> its articles, for this page
    var html = '';        // the tray on screen ('' none)
    var timer = null;
    var abort = null;     // the request on its way (to abort for a newer one)
    var asking = null;    // the draft it asks about
    var seq = 0;
    var composing = false;
    var dismissed = null; // the draft whose tray Escape closed
    var pausedUntil = 0;  // after a refusal or a failure
    var opening = false;  // a row's article is being opened
    var fromChat = false; // the article on screen came from the tray
    /** The draft as asked about: lower case, one space, at most 120 characters. */
    function draft() { return String(input.value || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120); }
    function teamAnswered() {
      return (chatStore.get().messages || []).some(function (m) {
        return m.sender !== 'visitor' && m.senderType !== 'system' && !(m.metadata && m.metadata.source === 'ai_agent_intro');
      });
    }
    /** The tray may show for draft `q`: the chat on screen, the composer open, the team silent so far. */
    function wanted(q) {
      var sh = shellStore.get();
      return !!sh.isOpen && sh.activeTab === 'chat' && !input.disabled && !bar.classList.contains('is-locked') && bar.style.display !== 'none'
        && q.replace(/[\s!-\/:-@[-`{-~،؛؟«»…]+/g, '').length >= 3 && q !== dismissed && !teamAnswered();
    }
    function paint(results) {
      var next = results && results.length ? api.P.kbSuggestHtml({ results: results }) || '' : '';
      if (next === html) return;
      var old = zone.querySelector('[data-kb-suggest]');
      if (old) old.parentNode.removeChild(old);
      html = next;
      if (next) zone.insertAdjacentHTML('afterbegin', next);
    }
    function hide() { paint(null); }
    function ask(q) {
      if (abort) { try { abort.abort(); } catch (_) {} }
      var ctl = null;
      try { ctl = new AbortController(); } catch (_) {}
      var my = ++seq;
      abort = ctl;
      asking = q;
      api.ModuleLoader.loadFor(ctx, 'kb', 'runtime-kb.js', function () {
        var mod = api.ModuleLoader.modules.kb;
        if (!mod || !mod.suggestArticles || my !== seq) { if (my === seq) asking = null; return; }
        mod.suggestArticles({
          apiBase: ctx.apiBase, workspaceId: ctx.workspaceId, locale: ctx.locale, fetchWith: ctx.fetchWith,
          query: q, limit: 2, signal: ctl ? ctl.signal : null,
          onResult: function (r) {
            if (my === seq) abort = asking = null;
            if (r.ok) cache[q] = r.results || [];
            // Refused (the pace) or failed: quietly nothing, for a while.
            else { pausedUntil = Date.now() + 30000; hide(); return; }
            onDraft();
          },
        });
      });
    }
    /** The draft changed (or what the tray depends on): its answer at once, else asked after a pause. */
    function onDraft() {
      clearTimeout(timer);
      timer = null;
      var q = draft();
      if (!wanted(q)) { hide(); return; }
      if (Object.prototype.hasOwnProperty.call(cache, q)) { paint(cache[q]); return; }
      // Its answer is on its way already.
      if (composing || Date.now() < pausedUntil || asking === q) return;
      timer = setTimeout(function () {
        timer = null;
        if (draft() === q && wanted(q)) ask(q);
      }, 400);
    }
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; onDraft(); });
    input.addEventListener('input', function (e) { if (!(composing || (e && e.isComposing))) onDraft(); });
    // Escape closes the tray (for this draft) before anything else it would close.
    zone.addEventListener('keydown', function (e) {
      var tray = zone.querySelector('[data-kb-suggest]');
      if (e.key !== 'Escape' || !tray || composing || e.isComposing || (e.target !== input && !tray.contains(e.target))) return;
      e.preventDefault();
      e.stopPropagation();
      dismissed = draft();
      hide();
      focusOn(input);
    });
    // A row opens its article in the help view; back from it returns here.
    zone.addEventListener('click', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('[data-kb-suggest] [data-kb-action="open"]') : null;
      var slug = row && row.getAttribute('data-kb-slug');
      if (!slug) return;
      hide();
      opening = true;
      api.switchTab('help');
      kbUI.openArticle(slug);
    });
    api.on('kbOpen', function () { fromChat = opening; opening = false; });
    // runtime-ext.js stepped back already (the article closed): the chat, not the list.
    api.on('kbBack', function () {
      if (!fromChat) return;
      fromChat = false;
      // An article still on its way is not painted over the chat.
      if (kbUI.x.loading) kbUI.resetToList();
      api.switchTab('chat');
      onDraft();
      return true;
    });
    // A message sent (the draft empties), the team's first answer, another
    // view or thread: the tray follows.
    chatStore.subscribe(function () { if (html || draft()) onDraft(); });
    shellStore.subscribe(function (sh) {
      if (sh.activeTab !== 'help') fromChat = false;
      if (html || draft()) onDraft();
    });
  }

  // ═══ A download's progress (`dlProgress`) ═══
  // Core hands over an attachment's response before reading it (hook
  // `media`): with a length (its header, else the size the message says)
  // and a readable body, its chunks are read here, `.dl-on` and `--dl`
  // (0..1, at most once a frame) on the attachment's controls meanwhile
  // (looked up each time: a repaint never keeps an old one), and the bytes
  // go back to Core as the blob it caches. The transfer itself is Core's
  // shared one (the thread's next paint uses it): never aborted halfway.
  function downloads(api) {
    function sizeOf(id) {
      var m = (api.chatStore.get().messages || []).filter(function (x) { return x.attachment && String(x.attachment.id) === id; })[0];
      return m ? Number(m.attachment.size_bytes) || 0 : 0;
    }
    /** The controls showing attachment `id`: its download link, its voice note. */
    function hosts(id) {
      var out = [];
      var root = api.chatQ('[data-chat-messages]');
      if (root) api.each(root, '[data-att-download], [data-att-media-src]', function (el) {
        if (el.getAttribute('data-att-download') !== id && el.getAttribute('data-att-media-src') !== id) return;
        var host = el.closest('[data-audio-player]') || (el.hasAttribute('data-att-download') ? el : null);
        if (host && out.indexOf(host) < 0) out.push(host);
      });
      return out;
    }
    function paint(id, f) {
      hosts(id).forEach(function (el) {
        el.classList.toggle('dl-on', f != null);
        if (f != null) { el.style.setProperty('--dl', f.toFixed(3)); el.setAttribute('aria-busy', 'true'); }
        else { el.style.removeProperty('--dl'); el.removeAttribute('aria-busy'); }
      });
    }
    api.on('media', function (r, id) {
      id = String(id);
      var total = (r && r.headers && Number(r.headers.get('content-length'))) || sizeOf(id);
      if (!total || !r.body || typeof r.body.getReader !== 'function' || typeof Blob === 'undefined') return;
      var reader = r.body.getReader();
      var type = r.headers.get('content-type') || '';
      var parts = [];
      var got = 0;
      var frame = 0;
      return new Promise(function (resolve, reject) {
        function pump() {
          reader.read().then(function (c) {
            if (c.done) {
              if (frame) cancelAnimationFrame(frame);
              paint(id, null);
              resolve(new Blob(parts, { type: type }));
              return;
            }
            parts.push(c.value);
            got += c.value.length;
            if (!frame) frame = requestAnimationFrame(function () { frame = 0; paint(id, Math.min(1, got / total)); });
            pump();
          }, function (e) {
            if (frame) cancelAnimationFrame(frame);
            paint(id, null);
            reject(e);
          });
        }
        pump();
      });
    });
  }

  // ═══ The emoji picker's search (`emojiSearch`) ═══
  /**
   * Search form of a text: lower case (Turkish I / İ / ı as one i, as a phone
   * capitalises them), one Persian ی / ک / ا, no ZWNJ or vowel marks, Latin digits.
   */
  function emojiNorm(s) {
    return String(s || '').toLowerCase().replace(/ı/g, 'i').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
      .replace(/[آأإ]/g, 'ا').replace(/ة/g, 'ه').replace(/ؤ/g, 'و')
      .replace(/[‌‍ـً-ٰٟ\u0307]/g, '')
      .replace(/[۰-۹٠-٩]/g, function (c) { return String(c.charCodeAt(0) & 15); });
  }
  function emojiFind(api) {
    var picker = api.chatQ('[data-emoji-picker]');
    var btn = api.chatQ('[data-emoji-btn]');
    if (!picker || !btn) return;
    var words = null;     // emoji -> its keywords, searchable (runtime-emoji.js)
    var asked = false;
    function field() { return picker.querySelector('[data-emoji-search]'); }
    /** Shows what matches the field (everything while the keywords load, or without them). */
    function filter() {
      var el = field();
      var q = el && words ? emojiNorm(el.value).split(/\s+/).filter(Boolean) : [];
      var seen = {};
      picker.classList.toggle('is-searching', !!q.length);
      api.each(picker, '[data-emoji-group]', function (g) {
        var any = false;
        api.each(g, '[data-emoji]', function (b) {
          var e = b.getAttribute('data-emoji');
          var kw = words && words[e];
          var ok = !q.length || (!seen[e] && !!kw && q.every(function (t) { return kw.some(function (w) { return w.indexOf(t) === 0; }); }));
          if (ok && q.length) seen[e] = 1;
          b.hidden = !ok;
          any = any || ok;
        });
        g.hidden = !any;
      });
      var none = picker.querySelector('[data-emoji-none]');
      if (none) none.hidden = !q.length || picker.querySelector('[data-emoji]:not([hidden])') != null;
    }
    function load() {
      if (asked) return;
      asked = true;
      api.ModuleLoader.loadFor(api.ctx, 'emoji', 'runtime-emoji.js', function (mod) {
        var el = field();
        if (!mod || mod.v !== 1 || typeof mod.list !== 'string' || !Array.isArray(mod.words)) {
          // No keywords: no search (never a field that finds nothing), the whole grid.
          if (el) { el.value = ''; el.parentNode.hidden = true; }
          filter();
          return;
        }
        // Each emoji's words in every language, as the search compares them.
        var langs = mod.words.map(function (w) { return String(w).split('|'); });
        words = {};
        mod.list.split(' ').forEach(function (e, i) {
          words[e] = emojiNorm(langs.map(function (l) { return l[i] || ''; }).join(' ')).split(/\s+/).filter(Boolean);
        });
        filter();
      });
    }
    // The field comes with the extras' grid (painted right after this module is in).
    Promise.resolve().then(function () {
      var el = field();
      if (el) el.parentNode.hidden = false;
    });
    picker.addEventListener('focusin', function (e) { if (e.target === field()) load(); });
    picker.addEventListener('input', function (e) {
      if (e.target !== field()) return;
      load();
      filter();
    });
    picker.addEventListener('keydown', function (e) {
      var el = field();
      if (e.target !== el || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        var first = el.value.trim() && picker.querySelector('[data-emoji]:not([hidden])');
        if (first && words) first.click();
      } else if (e.key === 'Escape' && el.value) {
        // A query first; an empty field lets the picker close.
        e.preventDefault();
        e.stopPropagation();
        el.value = '';
        filter();
      }
    });
    // Opened again: the whole grid.
    btn.addEventListener('click', function () {
      var el = field();
      if (picker.hidden || !el || !el.value) return;
      el.value = '';
      filter();
    });
  }

  function create(api) {
    var kicks = [];
    if (api.feat('csat') || api.feat('chatMenu')) afterChat(api);
    if (api.feat('reactions')) kicks.push(reactions(api));
    if (api.feat('prechatSteps')) steps(api);
    if (api.feat('awayThread')) away(api);
    if (api.feat('queuePosition')) kicks.push(queue(api));
    if (api.feat('instantAnswers')) suggest(api);
    if (api.feat('dlProgress')) downloads(api);
    if (api.feat('emojiSearch')) emojiFind(api);
    // A search's own words and its window of the summary, as the server cut them.
    api.on('kbVm', function (vm) {
      var got = api.kbStore.get().searchResults || [];
      (vm.results || []).forEach(function (r, i) {
        var a = got[i];
        if (a && a.slug === r.slug) { r.snippet = a.snippet || null; r.matches = Array.isArray(a.matches) ? a.matches : null; }
      });
    });
    // Once the pack is in (right after this), a thread already on screen
    // gets what it adds: its data asked for, and one repaint.
    Promise.resolve().then(function () {
      kicks.forEach(function (k) { k(); });
      repaintThread(api);
    });
    return {};
  }

  window.__gs_mod_late = { v: 2, create: create };
})();
