/**
 * Widget Module: renderer features
 *
 * The optional Core behaviours a renderer opts into: its `create()` returns
 * `features: { <name>: true }` (the names below), and only then does
 * runtime.js load this file (ModuleLoader name `ext`, `config.modules.ext`).
 * A renderer that declares none (`default`, `intl`) never downloads it, so
 * every visitor of those pays nothing for what is here.
 *
 * runtime.js keeps the hook points (`ext(name, …)`, a no-op without this
 * module) and hands create() what the features build on. This module adds
 * the view-model fields by wrapping the renderer's own surfaces (homeHtml,
 * conversationListHtml, emptyHtml, messagesHtml) and binds its controls
 * after Core painted a view. The loader fetches it with such a template's
 * files (/config names it for that template only: `coreFeatures` in
 * shared/widgetTemplates.ts); Core requests it (from the cache) as soon as
 * the renderer is mounted and paints the skeleton until it is in (at most
 * 1.5 s), so a first paint already has the features; data that arrived
 * first reaches create() as `earlyCalls`.
 *
 *   tabs                 badges `[data-tab-badge]`, `aria-current` on `[data-view]` tabs, unreadTotal
 *   kbSearch             search as you type in `[data-kb-search]`, `[data-kb-results]` repainted alone
 *   kbCategories         `[data-kb-category]` lists one category's articles
 *   kbArticleMeta        article updatedAt, categoryTitle, readingMinutes
 *   kbProgress           `--p` (0..1) on `[data-kb-progress]` while the article scrolls
 *   operatorTyping       a visible "{name} is typing" row (view.operatorTyping)
 *   chatHeader           `R.chatHeaderHtml(vm)` in `[data-chat-header]`, presence in it
 *   emptyQna, topics     Q&A and topic chips in the empty thread; topics on home
 *   homeAsk              `textarea[data-home-ask]` starts a conversation with its text
 *   prechatOperator      a locked composer under the pre-chat card, `[data-prechat-skip]`
 *   prechatSummary       `R.prechatSummaryHtml(contact)` after a submit, `[data-prechat-edit]`
 *   recSend, vnRate      stop-and-send `[data-rec-send]`, preview speed `[data-vn-rate]`
 *   clock                `R.format.clock(seconds)` for every timer Core writes
 *   emojiTabs            `[data-emoji-tab]` scrolls its `[data-emoji-group]` into view
 *   visitorName          home greets the visitor by name (waits for the identity)
 *   conversationOperator conversation rows carry the operator and who wrote last
 *
 * Public API (window.__gs_mod_ext): create(<the instance's parts>) → the
 * hooks runtime.js runs. Brand-neutral: it ships in every build as is.
 */
(function () {
  'use strict';

  // The parameters are the widget instance's own parts, named as in
  // runtime.js and passed in this order (src/test/widget/runtimeExt.test.ts
  // compares the two lists): the code below reads like the Core it extends.
  function create(
    P, ctx, panel, chatQ, identity, chatUI, kbUI, ModuleLoader, ConvEpoch,
    shellStore, chatStore, presenceStore, conversationsStore, notifyStore, identityStore, kbStore,
    attachmentStore, transportStore,
    renderBody, renderHome, switchTab, deriveChatTabState, setDraftFor, currentDraftKey, trySend,
    restoreDraftToInput, applyComposerState, syncAttachButton, showAiThinking, finishRecording,
    renderVoicePreview, earlyCalls
  ) {
    var config = ctx.config || {};
    var body = panel.querySelector('[data-body]');
    var shadowRoot = panel.getRootNode();
    var msgInput = chatQ('[data-msg-input]');
    var inputBar = chatQ('[data-input-bar]');
    var chatEnabled = config.features && config.features.chat !== false;
    var teamMembers = Array.isArray(config.teamMembers) ? config.teamMembers.slice(0, 4) : [];
    // The chat view's own parts (runtime.js createChatUI's `x`, same order).
    var qnaState = chatUI.x[0];
    var QNA_COLLAPSED_COUNT = chatUI.x[1];
    var loadQnaSuggestions = chatUI.x[2];
    var wireQnaChips = chatUI.x[3];
    var prechatValues = chatUI.x[4];
    var resolveHandoffPrechatSubtitle = chatUI.x[5];
    var wirePrechatForm = chatUI.x[6];
    var kb = kbUI.x;

    function feat(name) { return !!(P.features && P.features[name]); }
    function each(root, sel, fn) { Array.prototype.forEach.call(root.querySelectorAll(sel), fn); }
    function onClick(root, sel, fn) {
      each(root, sel, function (el) { el.addEventListener('click', function (ev) { fn(el, ev); }); });
    }
    /** Replaces renderer surface `name` with `fn(original, args…)`. */
    function wrap(name, fn) {
      var orig = P[name];
      if (typeof orig !== 'function') return;
      P[name] = function () {
        return fn.apply(null, [function () { return orig.apply(P, arguments); }].concat(Array.prototype.slice.call(arguments)));
      };
    }

    // ═══ Tab badges and the current tab (`tabs`) ═══
    // The unread total is the larger of the server's durable count and
    // this session's live count, per conversation.
    function unreadTotal() {
      var per = (notifyStore.get() || {}).perConversation || {};
      var listed = {};
      var total = 0;
      ((conversationsStore.get() || {}).items || []).forEach(function (c) {
        listed[c.id] = true;
        total += Math.max(Number(c.unreadCount) || 0, per[c.id] || 0);
      });
      for (var k in per) {
        if (Object.prototype.hasOwnProperty.call(per, k) && !listed[k]) total += per[k] || 0;
      }
      return total;
    }
    function paintTabBadges() {
      if (!feat('tabs')) return;
      var n = unreadTotal();
      var fmt = P.format && P.format.badge;
      each(panel, '[data-tab-badge]', function (el) {
        el.textContent = n ? (typeof fmt === 'function' ? fmt(n) : String(n)) : '';
        el.hidden = n === 0;
      });
    }
    function tabsFor(key) {
      return Array.prototype.filter.call(panel.querySelectorAll('[data-view][aria-current]'), function (el) {
        return key == null || el.getAttribute('data-view') === key;
      });
    }
    function markActiveTab() {
      if (!feat('tabs')) return;
      var key = shellStore.get().activeTab;
      tabsFor(null).forEach(function (el) {
        el.setAttribute('aria-current', el.getAttribute('data-view') === key ? 'page' : 'false');
      });
      paintTabBadges();
    }

    // ═══ Who is answering (`chatHeader`, `operatorTyping`) ═══
    // The thread's assigned operator (from its history, else from the
    // visitor's conversation list), else the last operator who wrote in it.
    var assigned = null; // { cid, op } from the thread's history
    function adoptHistory(cid, result) {
      if (feat('chatHeader') || feat('operatorTyping')) assigned = { cid: String(cid), op: (result && result.assignedOperator) || null };
    }
    // A conversation row's operator and who wrote last (the server's
    // `outbound`), for the rows, the header and the typing row.
    function mapConversation(vm, c) {
      if (feat('conversationOperator') || feat('chatHeader') || feat('operatorTyping')) {
        vm.lastFromVisitor = !!c.outbound;
        vm.operatorName = c.operatorName || null;
        vm.operatorAvatar = c.operatorAvatar || null;
        vm.operatorOnline = c.operatorOnline === true;
      }
    }
    function isHumanOperatorMessage(m) {
      return !!m && m.sender !== 'visitor'
        && (m.senderType === 'agent' || m.senderType === 'operator' || m.senderType === 'human');
    }
    function teamMemberOnline(name) {
      return teamMembers.some(function (m) { return m && m.online && m.name === name; });
    }
    function currentOperator() {
      var cs = chatStore.get();
      var cid = cs.conversationId;
      var op = assigned && cid != null && assigned.cid === String(cid) ? assigned.op : null;
      if (op && op.name) return op;
      var item = cid ? ((conversationsStore.get() || {}).items || []).filter(function (c) {
        return String(c.id) === String(cid);
      })[0] : null;
      if (item && item.operatorName) {
        return { name: item.operatorName, avatar: item.operatorAvatar || null, online: !!item.operatorOnline };
      }
      var msgs = cs.messages || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (isHumanOperatorMessage(msgs[i]) && msgs[i].senderName) {
          return { name: msgs[i].senderName, avatar: msgs[i].senderAvatar || null, online: teamMemberOnline(msgs[i].senderName) };
        }
      }
      return null;
    }
    // Typing events carry no name: the person drawn is the current operator,
    // else the first team member who is online.
    function typingPerson() {
      var op = currentOperator() || teamMembers.filter(function (m) { return m && m.online; })[0] || {};
      return { name: op.name || '', avatar: op.avatar || null };
    }
    var operatorTyping = null;
    var operatorTypingTimer = null;
    var replaying = false;
    /** The typing person a thread draws (feature `operatorTyping`), else null. */
    function rowTyping() { return feat('operatorTyping') ? operatorTyping : null; }
    function setOperatorTypingVm(vm) {
      if (!feat('operatorTyping') && !feat('chatHeader')) return;
      if (operatorTypingTimer) { clearTimeout(operatorTypingTimer); operatorTypingTimer = null; }
      if (vm) operatorTypingTimer = setTimeout(function () { setOperatorTypingVm(null); }, 3500);
      var changed = JSON.stringify(vm || null) !== JSON.stringify(operatorTyping);
      operatorTyping = vm || null;
      if (!changed) return;
      paintChatHeader();
      if (!feat('operatorTyping') || shellStore.get().activeTab !== 'chat') return;
      // Only a plain thread repaints; a pre-chat card or form keeps its fields.
      // Not while create() replays what came first: Core repaints once this
      // module is in, and a paint now would reach none of its hooks.
      var st = deriveChatTabState().name;
      if (!replaying && (st === 'AI_CHAT' || st === 'HUMAN_WELCOME' || st === 'ACTIVE_THREAD')) {
        // The saved details being edited keep their fields, too.
        if (!editingPrechat()) renderBody();
      }
    }

    // The renderer's chat header, repainted whenever what it shows changes.
    var chatHeaderSignature = null;
    function paintChatHeader() {
      if (!feat('chatHeader') || typeof P.chatHeaderHtml !== 'function') return;
      var header = chatQ('[data-chat-header]');
      if (!header) return;
      var p = presenceStore.get();
      var cs = chatStore.get();
      var vm = {
        online: p.status === 'online' && p.liveChatEnabled !== false,
        typing: !!operatorTyping,
        operator: currentOperator(),
        isNew: !(cs.messages || []).length,
        nextOpenAt: (ctx.config.availability && ctx.config.availability.next_open_at) || null,
      };
      var sig = JSON.stringify(vm);
      if (sig === chatHeaderSignature) return;
      chatHeaderSignature = sig;
      header.innerHTML = P.chatHeaderHtml(vm);
      renderHeaderPresence(presenceStore.get());
    }
    // The presence line the header may show is looked up in the chat frame
    // (built detached, so a panel query never finds it) after every header
    // paint, and only its `status-*` class changes, never the renderer's.
    function renderHeaderPresence(s) {
      var wrap = chatQ('[data-presence]');
      if (!wrap) return;
      Array.prototype.slice.call(wrap.classList).forEach(function (c) {
        if (c.indexOf('status-') === 0) wrap.classList.remove(c);
      });
      wrap.classList.add('status-' + (s.status || 'offline'));
      var label = chatQ('[data-presence-label]');
      if (label) label.textContent = s.label || '';
    }

    // ═══ The thread: chips, typing row, saved pre-chat details ═══
    // A chip's text sent as the visitor's message. With `emptyQna` chips
    // also show in a human-only thread, where a "thinking" row would wait
    // 25 s for an AI that never answers: it shows only while the AI owns
    // the thread.
    function sendChip(text) {
      if (!text || transportStore.get().connectionState !== 'online') return;
      chatUI.sendMessage(text, renderBody);
      try {
        if (!deriveChatTabState().aiOwnsThread) return;
        showAiThinking();
      } catch (_) {}
    }
    function bindTopics(root) {
      if (feat('topics')) onClick(root, '[data-topic]', function (el) { sendChip(el.getAttribute('data-topic')); });
    }

    // After a successful pre-chat submit the thread shows the renderer's
    // summary card once, as a local row (never a message), until the
    // visitor sends something; `[data-prechat-edit]` turns it back into the
    // pre-chat card with the saved values.
    var prechatSummary = null; // { contact, visitorCount, editing, identity, focused }
    function visitorMessageCount(s) {
      return (s.messages || []).filter(function (m) { return m.sender === 'visitor'; }).length;
    }
    function prechatSummaryRowHtml(s) {
      if (!prechatSummary || !feat('prechatSummary')) return '';
      if (visitorMessageCount(s) !== prechatSummary.visitorCount) { prechatSummary = null; return ''; }
      if (prechatSummary.editing) {
        return P.handoffPrechatCardHtml(
          prechatSummary.identity, prechatValues(), ctx.locale, resolveHandoffPrechatSubtitle(ctx.locale), false);
      }
      return typeof P.prechatSummaryHtml === 'function' ? (P.prechatSummaryHtml(prechatSummary.contact) || '') : '';
    }
    function wirePrechatSummary(root) {
      if (!prechatSummary) return;
      if (prechatSummary.editing) {
        var firstPaint = !prechatSummary.focused;
        prechatSummary.focused = true;
        wirePrechatForm(root, prechatSummary.identity, function () {
          showPrechatSummary(prechatSummary && prechatSummary.identity);
          renderBody();
        }, { autofocus: firstPaint });
        return;
      }
      onClick(root, '[data-prechat-edit]', function () {
        if (!prechatSummary) return;
        prechatSummary.editing = true;
        renderBody();
      });
    }
    // The saved details reopened as the pre-chat card (its fields in use).
    function editingPrechat() { return !!(prechatSummary && prechatSummary.editing); }
    function showPrechatSummary(identity) {
      if (!feat('prechatSummary')) return;
      prechatSummary = {
        contact: Object.assign({}, identityStore.get().contact || {}),
        visitorCount: visitorMessageCount(chatStore.get()),
        editing: false,
        identity: identity,
      };
    }
    var startNew = chatUI.startNewConversation;
    chatUI.startNewConversation = function () {
      var out = startNew.apply(chatUI, arguments);
      prechatSummary = null;
      return out;
    };

    // The empty thread's view-model: any of these features draws into it.
    var emptyVmGiven = false;
    wrap('emptyHtml', function (orig) {
      var emptyVm;
      if (feat('emptyQna') || feat('topics') || feat('operatorTyping') || feat('prechatSummary')) {
        // A new conversation can offer the workspace's Q&A and topics, and
        // show the operator typing, before anybody wrote a word.
        if (feat('emptyQna')) loadQnaSuggestions();
        var opts = (ctx.config && ctx.config.templateOptions) || {};
        emptyVm = {
          qna: { questions: qnaState.questions, expanded: qnaState.expanded, collapsedCount: QNA_COLLAPSED_COUNT },
          topics: Array.isArray(opts.topics) ? opts.topics : [],
          prechatSummaryHtml: prechatSummaryRowHtml(chatStore.get()),
        };
        emptyVm.operatorTyping = editingPrechat() ? null : rowTyping();
      }
      emptyVmGiven = !!emptyVm;
      return orig(emptyVm);
    });
    // `extra` is undefined only for a plain thread (Core's renderChat); a
    // pre-chat card passed in (the handoff) never shows typing under it,
    // since a card is not repainted for typing.
    var summaryPainted = false;
    wrap('messagesHtml', function (orig, s, extra, view) {
      var plain = extra === undefined;
      var row = plain ? prechatSummaryRowHtml(s) : '';
      summaryPainted = !!row;
      if (feat('operatorTyping') && plain && !editingPrechat()) view.operatorTyping = rowTyping();
      return orig(s, row || extra, view);
    });
    var typingRowShown = false;
    var lastThreadBody = null;

    // ═══ Home: ask, search, topics (`homeAsk`, `kbSearch`, `topics`) ═══
    // `textarea[data-home-ask]` (a question that starts a conversation) and
    // `input[data-kb-search]` (opens Help searching it). The drafts live
    // here, so a repaint gives back text, focus and caret, and nothing
    // repaints under an IME composition.
    var homeAskDraft = '';
    var homeSearchDraft = '';
    var homeComposing = false;
    var homeRepaintPending = false;
    var homeKeep = null;
    var painting = null; // the view whose markup a wrapper just produced
    function homeFieldFocus() {
      var el = shadowRoot.activeElement;
      if (!el || !body.contains(el)) return null;
      var which = el.hasAttribute('data-home-ask') ? 'ask' : (el.hasAttribute('data-kb-search') ? 'search' : null);
      return which ? { which: which, start: el.selectionStart, end: el.selectionEnd } : null;
    }
    function bindHomeFields(keepFocus) {
      [
        ['ask', feat('homeAsk') ? body.querySelector('textarea[data-home-ask]') : null],
        ['search', feat('kbSearch') ? body.querySelector('input[data-kb-search]') : null],
      ].forEach(function (pair) {
        var which = pair[0];
        var el = pair[1];
        if (!el) return;
        var keep = function () { if (which === 'ask') homeAskDraft = el.value || ''; else homeSearchDraft = el.value || ''; };
        el.value = which === 'ask' ? homeAskDraft : homeSearchDraft;
        el.addEventListener('input', keep);
        el.addEventListener('compositionstart', function () { homeComposing = true; });
        var settle = function () {
          homeComposing = false;
          keep();
          if (!homeRepaintPending) return;
          homeRepaintPending = false;
          setTimeout(function () { if (shellStore.get().activeTab === 'home') renderHome(); }, 0);
        };
        el.addEventListener('compositionend', settle);
        el.addEventListener('blur', function () { if (homeComposing) settle(); });
        el.addEventListener('keydown', function (e) {
          // Enter sends, Shift+Enter is a new line, and an IME's Enter only
          // commits its word.
          if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229 || homeComposing) return;
          e.preventDefault();
          keep();
          if (which === 'ask') { submitHomeAsk(); return; }
          var q = homeSearchDraft.trim();
          if (!q) return;
          homeSearchDraft = '';
          searchFor(q);
          switchTab('help');
        });
        if (keepFocus && keepFocus.which === which) {
          try { el.focus({ preventScroll: true }); } catch (_) {}
          try { el.setSelectionRange(keepFocus.start, keepFocus.end); } catch (_) {}
        }
      });
    }
    function submitHomeAsk() {
      var text = homeAskDraft.trim();
      if (!text) return;
      homeAskDraft = '';
      startConversationWith(text);
    }
    // A conversation the visitor opens with their own words (the home ask
    // field, a topic chip): a new thread, the text sent through the one send
    // path (identity, connection and pre-chat gates included; a gate keeps
    // it as the composer draft), and no AI greeting for that thread, which
    // would otherwise land ahead of the question it is answering. Away (the
    // leave-a-message form owns the tab), the text pre-fills that form.
    var introSuppressedEpoch = 0;
    function startConversationWith(text) {
      text = String(text || '').trim();
      if (!text || !chatEnabled) return;
      try { if (chatUI.startNewConversation) chatUI.startNewConversation(); } catch (_) {}
      try { ctx.__handoffRequested = false; } catch (_) {}
      introSuppressedEpoch = ConvEpoch.get();
      var away = deriveChatTabState().name === 'OFFLINE_CONTACT';
      if (away) ctx.__quotaDraft = text;
      else {
        setDraftFor(currentDraftKey(), text);
        if (msgInput) msgInput.value = text;
      }
      switchTab('chat');
      if (!away) trySend();
    }
    wrap('homeHtml', function (orig, vm) {
      if (feat('visitorName')) {
        var contactName = String(((identityStore.get() || {}).contact || {}).name || '').trim();
        vm.visitorName = contactName ? contactName.split(/\s+/)[0] : '';
      }
      if (feat('tabs')) vm.unreadTotal = unreadTotal();
      if (feat('kbSearch')) vm.hasSearch = true;
      painting = 'home';
      return orig(vm);
    });
    wrap('conversationListHtml', function (orig, vm) {
      if (feat('tabs')) vm.unreadTotal = unreadTotal();
      painting = 'list';
      return orig(vm);
    });

    // ═══ Help (`kbSearch`, `kbCategories`, `kbArticleMeta`, `kbProgress`) ═══
    // Core paints the help view into the panel body (kbUI.render(body)), so
    // `body` is its root; `kb` is the help view's own state (createKbUI `x`).
    // Search as you type: typing waits 300 ms and two characters, never
    // searches in the middle of an IME composition (its Enter commits a
    // word), keeps ONE request in flight (the latest query runs when it
    // lands or after 8 s without an answer; the help endpoints share a
    // per-process ceiling) and remembers answers for the session. With a
    // `[data-kb-results]` region only that region is repainted, so the field
    // keeps its text, focus and caret; without one the whole view is, and
    // the focus and caret are put back.
    var KB_SEARCH_MIN = 2;
    var KB_SEARCH_TIMEOUT = 8000;
    var searchCache = {};
    var searchDebounce = null;
    var searchInFlight = false;
    var searchComposing = false;
    var focusSearchOnPaint = false;
    var searchOnRender = false;
    var searchKeep = null;
    var currentCategory = null; // { id, name, description, icon }
    var articleFrom = 'list';   // the view the open article was opened from
    function helpActive() { return shellStore.get().activeTab === 'help'; }
    // Core's own search (the plain `.kb-search` field) never runs beside
    // this one, so its timer and request need no cancelling here.
    function cancelSearch() {
      if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
    }
    function searchField() {
      return body.querySelector('[data-kb-search], .kb-search');
    }
    function focusedSearch() {
      var field = searchField();
      var root = field && field.getRootNode ? field.getRootNode() : null;
      if (!field || !root || root.activeElement !== field) return null;
      return { start: field.selectionStart || 0 };
    }
    function bindSearch() {
      var field = searchField();
      if (!field) return;
      // A field just painted has no composition going on (one the old field
      // had ended with it).
      searchComposing = false;
      field.addEventListener('compositionstart', function () { searchComposing = true; });
      field.addEventListener('compositionend', function () {
        searchComposing = false;
        onSearchInput(field.value);
      });
      field.addEventListener('input', function (e) {
        if (searchComposing || (e && e.isComposing)) { kb.query = field.value || ''; return; }
        onSearchInput(field.value);
      });
      field.addEventListener('keydown', function (e) {
        // Enter searches now instead of after the pause (an IME's Enter
        // only commits its word).
        if (e.key === 'Enter') {
          if (searchComposing || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          kb.query = String(field.value || '');
          if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
          searchNow();
          return;
        }
        // Escape empties a filled field first; only an empty one lets the
        // panel's own Escape close the widget.
        if (e.key !== 'Escape' || !kb.query) return;
        e.preventDefault();
        e.stopPropagation();
        clearSearch();
      });
    }
    function clearSearch() {
      kb.query = '';
      cancelSearch();
      kb.view = 'list';
      var field = searchField();
      if (field) field.value = '';
      paintSearchState();
      field = searchField();
      if (field) { try { field.focus(); } catch (_) {} }
    }
    function onSearchInput(value) {
      kb.query = String(value || '');
      if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
      if (kb.query.trim().length < KB_SEARCH_MIN) {
        if (kb.view !== 'list') { kb.view = 'list'; paintSearchState(); }
        return;
      }
      searchDebounce = setTimeout(searchNow, 300);
    }
    function showResults(results) {
      kbStore.set({ searchResults: results });
      // An article opened meanwhile stays open; back shows these results.
      if (kb.article || kb.loading) return;
      kb.view = 'results';
      paintSearchState();
    }
    function searchNow() {
      searchDebounce = null;
      var q = kb.query.trim();
      if (q.length < KB_SEARCH_MIN) return;
      if (Object.prototype.hasOwnProperty.call(searchCache, q)) { showResults(searchCache[q]); return; }
      if (searchInFlight) return;
      searchInFlight = true;
      if (kb.view !== 'searching' && !kb.article) { kb.view = 'searching'; paintSearchState(); }
      // A request that never answers must not hold the one slot for the
      // rest of the session: after KB_SEARCH_TIMEOUT it is dropped (as a
      // failed search, never cached) and the latest query may run.
      var settled = false;
      var abort = null;
      try { abort = new AbortController(); } catch (_) { abort = null; }
      var guard = setTimeout(function () {
        if (abort) { try { abort.abort(); } catch (_) {} }
        done([], false);
      }, KB_SEARCH_TIMEOUT);
      function done(results, ok) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        searchInFlight = false;
        if (ok) searchCache[q] = results;
        var latest = kb.query.trim();
        if (latest === q) { showResults(results); return; }
        // The visitor kept typing: run the query they have now.
        if (latest.length >= KB_SEARCH_MIN && !searchDebounce) searchNow();
      }
      ModuleLoader.loadFor(ctx, 'kb', 'runtime-kb.js', function () {
        if (settled) return;
        var mod = ModuleLoader.modules.kb;
        if (!mod || !mod.searchArticles) { done([], false); return; }
        mod.searchArticles({
          apiBase: ctx.apiBase,
          workspaceId: ctx.workspaceId,
          sessionToken: ctx.sessionToken,
          locale: ctx.locale,
          query: q,
          limit: 8,
          // Word by word, ranked (the help center keeps its phrase search).
          match: 'words',
          signal: abort ? abort.signal : null,
          onResult: function (r) { done((r && r.results) || [], !!(r && r.ok)); },
        });
      });
    }
    function paintSearchState() {
      if (!helpActive()) return;
      var live = body.querySelector('[data-kb-results]');
      if (live && searchField()) {
        // Parsed inert (a <template> loads no image and runs nothing).
        var scratch = document.createElement('template');
        scratch.innerHTML = P.kbHtml(kb.vm());
        var fresh = scratch.content.querySelector('[data-kb-results]');
        if (fresh) {
          // The region's own attributes may carry the state for styling.
          Array.prototype.slice.call(live.attributes).forEach(function (a) {
            if (!fresh.hasAttribute(a.name)) live.removeAttribute(a.name);
          });
          Array.prototype.forEach.call(fresh.attributes, function (a) { live.setAttribute(a.name, a.value); });
          live.innerHTML = fresh.innerHTML;
          kb.bind(live);
          return;
        }
      }
      kb.paint();
    }
    /**
     * Shows the help view searching for `q` (a home search field's Enter):
     * the field arrives filled and focused, and the search runs once the
     * view is painted.
     */
    function searchFor(q) {
      kbUI.resetToList();
      currentCategory = null;
      cancelSearch();
      kb.query = String(q || '');
      var ready = kb.query.trim().length >= KB_SEARCH_MIN;
      kb.view = ready ? 'searching' : 'list';
      searchOnRender = ready;
      focusSearchOnPaint = true;
    }
    function openCategory(id) {
      var cat = (kbStore.get().categories || []).filter(function (c) { return String(c.id) === String(id); })[0];
      if (!cat) return;
      currentCategory = { id: cat.id, name: cat.name, description: cat.description || '', icon: cat.icon || null };
      kb.article = null;
      kb.view = 'category';
      kb.paint();
    }
    // One step back inside the help view: an article returns to the list it
    // was opened from (a category, search results or the list), a category
    // to the list. False when there is nothing to step back from.
    function stepBack() {
      var inCategories = feat('kbCategories');
      if (kb.article) {
        kb.article = null;
        // A category is returned to only when the article was opened from
        // it (a search started inside a category left it).
        if (inCategories && currentCategory && articleFrom === 'category') kb.view = 'category';
        else {
          currentCategory = null;
          kb.view = kb.query.trim() ? 'results' : 'list';
        }
        kb.paint();
        return true;
      }
      if (inCategories && kb.view === 'category') {
        currentCategory = null;
        kb.view = kb.query.trim() ? 'results' : 'list';
        kb.paint();
        return true;
      }
      return false;
    }
    // Reading progress: scroll does not bubble, but a capturing listener on
    // the view host sees the article's scroller; `--p` (0..1) is written
    // once a frame.
    function bindProgress() {
      if (body.__gsKbProgress) return;
      body.__gsKbProgress = true;
      var frame = 0;
      body.addEventListener('scroll', function (ev) {
        var scroller = ev && ev.target;
        // The view host is shared with the other tabs: their scrolling
        // (the chat thread) is not the article's.
        if (frame || kb.view !== 'article' || !helpActive() || !scroller || scroller.nodeType !== 1) return;
        frame = requestAnimationFrame(function () {
          frame = 0;
          var bar = body.querySelector('[data-kb-progress]');
          if (!bar) return;
          var max = scroller.scrollHeight - scroller.clientHeight;
          var p = max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0;
          bar.style.setProperty('--p', String(Math.round(p * 1000) / 1000));
        });
      }, { capture: true, passive: true });
    }

    // ═══ Pre-chat on the operator's side (`prechatOperator`) ═══
    // While the card waits in the thread the composer stays on screen,
    // locked; "No thanks" on a card that asks for nothing required
    // (`[data-prechat-skip]`) keeps the card away for this page session.
    var composerLocked = false;
    function setComposerLock(on) {
      if (composerLocked === !!on) return;
      composerLocked = !!on;
      if (inputBar) inputBar.classList.toggle('is-locked', composerLocked);
      applyComposerState();
      syncAttachButton();
    }
    var prechatSkipped = false;
    var prechatPainted = false; // this render paints the pre-chat card or form
    function prechatSkipApplies() {
      return prechatSkipped && feat('prechatOperator')
        && !identity.isRequired('name') && !identity.isRequired('email') && !identity.isRequired('phone');
    }
    function bindPrechatSkip(root) {
      if (!feat('prechatOperator')) return;
      each(root, '[data-prechat-skip]', function (el) {
        if (el.__gsSkip) return;
        el.__gsSkip = true;
        el.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (_) {}
          prechatSkipped = true;
          renderBody();
          if (prechatSkipApplies()) {
            restoreDraftToInput();
            if (msgInput) { try { msgInput.focus(); } catch (_) {} }
          }
        });
      });
    }

    // ═══ Voice and emoji (`recSend`, `vnRate`, `clock`, `emojiTabs`) ═══
    // Stop and send in one tap, no preview: the note goes through the one
    // send path once its upload is ready; a failed upload falls back to the
    // preview with its error.
    var recSendWhenReady = false;
    var recSendBtn = chatQ('[data-rec-send]');
    var micBtn = chatQ('[data-mic-btn]');
    // Core marks the microphone `.recording` exactly while it records.
    function isRecording() { return !!micBtn && micBtn.classList.contains('recording'); }
    if (recSendBtn && feat('recSend')) {
      recSendBtn.addEventListener('click', function () {
        if (!isRecording()) return;
        recSendWhenReady = true;
        finishRecording(true);
      });
      attachmentStore.subscribe(function (st) {
        if (!recSendWhenReady) return;
        if (st.status === 'error' || st.status === 'idle') { recSendWhenReady = false; renderVoicePreview(); return; }
        if (st.status !== 'ready' || !st.isVoice || !st.attachmentId) return;
        recSendWhenReady = false;
        trySend();
        renderVoicePreview();
      });
      // A new recording (a press on the microphone while none runs) starts
      // without a pending stop-and-send. Captured above the button, so it is
      // read before the press starts or stops anything.
      panel.addEventListener('click', function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest('[data-mic-btn]') && !isRecording()) recSendWhenReady = false;
      }, true);
    }
    // Playback speed of the preview, 1 → 1.5 → 2.
    var vnAudioEl = chatQ('[data-vn-audio]');
    var vnRateBtn = feat('vnRate') ? chatQ('[data-vn-rate]') : null;
    function setVnRate(r) {
      try { if (vnAudioEl) vnAudioEl.playbackRate = r; } catch (_) {}
      var fmt = P.format && P.format.rate;
      if (vnRateBtn) vnRateBtn.textContent = typeof fmt === 'function' ? fmt(r) : r + '×';
    }
    if (vnRateBtn && vnAudioEl) {
      vnRateBtn.addEventListener('click', function () {
        var r = vnAudioEl.playbackRate;
        setVnRate(r === 1 ? 1.5 : r === 1.5 ? 2 : 1);
      });
    }
    // A renderer with grouped emoji draws its own grid (Core keeps it); a
    // group tab scrolls its group into view inside the picker (never the
    // host page) and becomes the selected tab.
    var emojiPickerEl = chatQ('[data-emoji-picker]');
    if (feat('emojiTabs') && emojiPickerEl && chatQ('[data-emoji-btn]')) {
      emojiPickerEl.addEventListener('click', function (e) {
        var tab = e.target && e.target.closest ? e.target.closest('[data-emoji-tab]') : null;
        if (!tab) return;
        var g = tab.getAttribute('data-emoji-tab');
        each(emojiPickerEl, '[data-emoji-tab]', function (el) {
          el.setAttribute('aria-selected', el === tab ? 'true' : 'false');
        });
        var group = Array.prototype.filter.call(emojiPickerEl.querySelectorAll('[data-emoji-group]'), function (el) {
          return el.getAttribute('data-emoji-group') === g;
        })[0];
        for (var sc = group && group.parentElement; group && sc; sc = sc.parentElement) {
          if (sc.scrollHeight > sc.clientHeight) {
            sc.scrollTop += group.getBoundingClientRect().top - sc.getBoundingClientRect().top;
            break;
          }
          if (sc === emojiPickerEl) break;
        }
      });
    }

    // ═══ Wiring ═══
    // A bottom-menu tab is repainted with its view: focus moves to the new
    // view's own tab instead of falling to nowhere. The pressed tab is read
    // before Core's delegated navigation runs (capture: the repaint takes it
    // off the page), and focused after it switched the view.
    var tabPressed = null;
    panel.addEventListener('click', function (ev) {
      var target = ev.target;
      tabPressed = null;
      if (!feat('tabs') || !target || !target.closest) return;
      function trigger(sel) {
        var el = target.closest(sel);
        return el && el !== panel && panel.contains(el) ? el : null;
      }
      // The same order as Core's navigation: a back or a row wins.
      if (trigger('[data-view-back]') || trigger('[data-conversation-open]')) return;
      var view = trigger('[data-view]');
      if (view && view.hasAttribute('aria-current')) tabPressed = view.getAttribute('data-view');
    }, true);
    panel.addEventListener('click', function () {
      var key = tabPressed;
      tabPressed = null;
      var tab = key != null && tabsFor(key)[0];
      if (tab) { try { tab.focus({ preventScroll: true }); } catch (_) {} }
    });
    // A thread whose history starts loading has no assigned operator until
    // that history says so.
    var historyWasLoading = !!chatStore.get().historyLoading;
    chatStore.subscribe(function (st) {
      if (st.historyLoading && !historyWasLoading) assigned = null;
      historyWasLoading = !!st.historyLoading;
    });
    // What Core saw before this module was in (data can arrive first): the
    // thread list it mapped, a history it adopted, typing. A row Core copied
    // since (one marked read) gets the fields of the server row it came from.
    var earlyRows = {};
    replaying = true;
    (earlyCalls || []).forEach(function (call) {
      if (call[0] === 'conv') { mapConversation(call[1], call[2]); earlyRows[call[1].id] = call[2]; }
      else if (call[0] === 'history') adoptHistory(call[1], call[2]);
      else if (call[0] === 'typing') setOperatorTypingVm(call[1] ? typingPerson() : null);
    });
    replaying = false;
    ((conversationsStore.get() || {}).items || []).forEach(function (vm) {
      if (earlyRows[vm.id]) mapConversation(vm, earlyRows[vm.id]);
    });
    if (feat('chatHeader')) {
      presenceStore.subscribe(paintChatHeader);
      chatStore.subscribe(paintChatHeader);
      conversationsStore.subscribe(paintChatHeader);
      paintChatHeader();
    }
    if (feat('tabs')) {
      notifyStore.subscribe(paintTabBadges);
      conversationsStore.subscribe(paintTabBadges);
    }

    // The hooks runtime.js runs (`ext(name, …)`).
    return {
      // ── renderBody / home / list ──
      body: function () {
        markActiveTab();
        if (prechatPainted) bindPrechatSkip(panel);
        prechatPainted = false;
      },
      // Home waits for the visitor's identity to greet them by name.
      wait: function () { return feat('visitorName') && !identityStore.get().loaded; },
      // Before home repaints: hold it while a field is mid-composition (only
      // while that field is still the one in use: a field taken off screen
      // mid-composition never says it ended), else keep its focus and caret.
      hold: function () {
        var keepFields = feat('homeAsk') || feat('kbSearch');
        if (keepFields && homeComposing) {
          if (homeFieldFocus()) { homeRepaintPending = true; return true; }
          homeComposing = false;
        }
        homeKeep = keepFields ? homeFieldFocus() : null;
        return false;
      },
      // Home or the list was just painted, before Core binds its controls.
      view: function (root) {
        var which = painting;
        painting = null;
        markActiveTab();
        if (which !== 'home') return;
        // A written question starts its own conversation: this listener
        // runs before Core's "start a chat" and keeps it from running.
        if (feat('homeAsk')) {
          each(root, '[data-home-action="chat"]', function (el) {
            el.addEventListener('click', function (ev) {
              if (!homeAskDraft.trim()) return;
              ev.stopImmediatePropagation();
              submitHomeAsk();
            });
          });
        }
        if (feat('homeAsk') || feat('kbSearch')) bindHomeFields(homeKeep);
        if (feat('topics')) onClick(root, '[data-topic]', function (el) { startConversationWith(el.getAttribute('data-topic')); });
      },
      conv: mapConversation,
      noIntro: function () { return introSuppressedEpoch === ConvEpoch.get(); },

      // ── the thread ──
      chip: function (question) {
        if (!feat('emptyQna')) return false;
        sendChip(question);
        return true;
      },
      empty: function (root) {
        if (!emptyVmGiven) return;
        wireQnaChips(root);
        bindTopics(root);
        wirePrechatSummary(root);
      },
      wired: function (root) {
        bindTopics(root);
        if (feat('operatorTyping')) {
          // Once on screen a typing row does not replay its entrance.
          var row = root.querySelector('.typing-row');
          if (row && typingRowShown && root === lastThreadBody) row.classList.add('no-enter');
          typingRowShown = !!row;
        }
        lastThreadBody = root;
        if (summaryPainted) wirePrechatSummary(root);
      },
      history: adoptHistory,
      typing: function (on) { setOperatorTypingVm(on ? typingPerson() : null); },
      presence: function (s) {
        if (!feat('chatHeader')) return false;
        renderHeaderPresence(s);
        return true;
      },
      skip: prechatSkipApplies,
      // The chat tab's state, just before it paints: the pre-chat card keeps
      // a locked composer under it.
      lock: function (stateName) {
        prechatPainted = stateName === 'PRECHAT_FOR_HUMAN' || stateName === 'HANDOFF_PRECHAT';
        if (!feat('prechatOperator')) return false;
        var on = stateName === 'HANDOFF_PRECHAT';
        setComposerLock(on);
        return on;
      },
      locked: function () { return composerLocked; },
      // The renderer's "your details" card takes the form's place.
      prechat: showPrechatSummary,

      // ── voice ──
      clock: function (sec) {
        var clock = feat('clock') && P.format && P.format.clock;
        return typeof clock === 'function' ? clock(sec) : '';
      },
      // The voice preview: hidden while a stop-and-send waits for its
      // upload; a new note (`fresh`) starts at speed 1.
      vn: function (fresh) {
        if (recSendWhenReady) return true;
        if (fresh && vnRateBtn && vnAudioEl && attachmentStore.get().file) setVnRate(1);
        return false;
      },

      // ── help ──
      // The help view's view-model, built while the old view is still on
      // screen: a search field the visitor is in is noted, to get its focus
      // and caret back after the repaint (kbPaint).
      kbVm: function (vm) {
        searchKeep = feat('kbSearch') ? focusedSearch() : null;
        var s = kbStore.get();
        var withCategories = feat('kbCategories');
        var allArticles = s.articles || [];
        // Articles per category, counted from the list the widget already has.
        var countByCat = {};
        if (withCategories) {
          allArticles.forEach(function (a) {
            if (a && a.category_id) countByCat[a.category_id] = (countByCat[a.category_id] || 0) + 1;
          });
          (s.categories || []).forEach(function (c, i) {
            var row = vm.categories[i];
            row.id = c.id;
            row.icon = c.icon || null;
            row.count = countByCat[c.id] || 0;
          });
        }
        var inCategory = withCategories && kb.view === 'category' && currentCategory;
        if (inCategory) {
          vm.articles = allArticles.filter(function (a) { return a.category_id === currentCategory.id; })
            .map(function (a) { return { slug: a.slug, title: a.title, excerpt: a.excerpt }; });
          vm.category = Object.assign({ count: countByCat[currentCategory.id] || 0 }, currentCategory);
        }
        if (feat('kbSearch')) vm.hasSearch = true;
        if (feat('tabs')) vm.unreadTotal = unreadTotal();
        var article = kb.article;
        if (feat('kbArticleMeta') && vm.article && article) {
          var cat = (s.categories || []).filter(function (c) { return c.id === article.category_id; })[0];
          var words = String(article.content || '').replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
          vm.article.updatedAt = article.updated_at || null;
          vm.article.categoryTitle = cat ? cat.name : null;
          vm.article.readingMinutes = Math.max(1, Math.round(words / 200));
        }
      },
      kbPaint: function () {
        if (feat('kbSearch')) {
          var field = searchField();
          if (field && (searchKeep || focusSearchOnPaint)) {
            var end = String(field.value || '').length;
            try { field.focus({ preventScroll: true }); } catch (_) {}
            var pos = searchKeep ? Math.min(searchKeep.start, end) : end;
            try { field.setSelectionRange(pos, pos); } catch (_) {}
          }
          focusSearchOnPaint = false;
        }
        if (feat('kbProgress')) bindProgress();
        markActiveTab();
      },
      // Binds this module's help controls inside `scope` (the view, or the
      // results region repainted alone); true when it owns the search field.
      kbBind: function (scope) {
        if (scope === body && feat('kbSearch')) bindSearch();
        if (feat('kbSearch')) {
          onClick(scope, '[data-kb-search-clear]', function (el, ev) {
            try { ev.preventDefault(); } catch (_) {}
            clearSearch();
          });
        }
        if (feat('kbCategories')) {
          onClick(scope, '[data-kb-category]', function (el, ev) {
            try { ev.preventDefault(); } catch (_) {}
            openCategory(el.getAttribute('data-kb-category'));
          });
        }
        return feat('kbSearch');
      },
      kbBack: stepBack,
      kbOpen: function () { if (kb.view !== 'article') articleFrom = kb.view; },
      kbRender: function () { if (searchOnRender) { searchOnRender = false; searchNow(); } },
    };
  }

  window.__gs_mod_ext = { create: create };
})();
