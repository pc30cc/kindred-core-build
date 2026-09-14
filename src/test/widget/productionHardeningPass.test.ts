/**
 * Production-hardening pass — contract tests over the raw widget/server
 * source, following the established convention in this repo for code that
 * needs a live browser/Express+Supabase stack to execute for real
 * (designContract.test.ts, aiProactiveNudgeLoaderRecovery.test.ts,
 * sendMessageIdempotency.test.ts): assert the structural guarantees at the
 * exact places they must hold, on the actual shipped source text.
 *
 * Covers:
 *   1. Production console silence (debug gating) across widget/call-widget.
 *   2. Visitor message send idempotency + reply-to-message persistence
 *      (server/routes/widget.ts), mirroring the proven operator-side
 *      pattern in server/routes/conversations.ts.
 *   3. Failed-message retry/resend (client).
 *   4. Clipboard image/file paste into the composer.
 *   5. Public window.__gs API additions (show/hide/isOpen/identify/events).
 *   6. Hidden-tab polling backoff.
 *   7. Regression guard for the pre-existing `attachCfg` ReferenceError bug.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

const loader = read('public/widget/loader.js');
const runtime = read('public/widget/runtime.js');
const runtimeChat = read('public/widget/runtime-chat.js');
const runtimeCall = read('public/widget/runtime-call.js');
const presentation = read('public/widget/presentation-web-yar.js');
const presentationCss = read('public/widget/presentation-web-yar.css');
const callWidgetLoader = read('public/call-widget/l.js');
const widgetRoute = read('server/routes/widget.ts');
const widgetIdentityRoute = read('server/routes/widgetIdentity.ts');
const widgetAttachmentsSvc = read('server/routes/widgetAttachments.ts');
const publishSvc = read('server/services/realtime/publish.ts');
const conversationsRoute = read('server/routes/conversations.ts');
const replyMigrationSelfHost = read('database/migrations/176_widget_message_reply_to.sql');
const replyMigrationHosted = read('supabase/migrations/20260914120000_widget_message_reply_to.sql');

describe('production console silence — debug gating', () => {
  it('runtime.js has no bare console.* call outside the Util.log/Util.warn definitions', () => {
    const calls = [...runtime.matchAll(/console\.(log|info|warn|error|debug)\b/g)];
    // The only two allowed occurrences are console.info.apply/console.warn.apply
    // inside Util.log/Util.warn themselves.
    expect(calls.length).toBe(2);
  });

  it('runtime.js Util.log/Util.warn are gated on Util.debug, which honors all three opt-ins', () => {
    expect(runtime).toContain('log: function () {\n      if (!Util.debug) return;');
    expect(runtime).toContain('warn: function () {\n      if (!Util.debug) return;');
    expect(runtime).toContain("localStorage.getItem('gs:debug') === '1'");
    expect(runtime).toContain('window.__gs_debug');
  });

  it('the realtime driver ctx passed to centrifugo/supabase drivers wires _log to the gated Util.log (previously dead — ctx._log was never set)', () => {
    expect(runtime).toMatch(/_log:\s*Util\.log/);
  });

  it('runtime-call.js gates dlog/dwarn behind the same opt-in convention (previously unconditional)', () => {
    expect(runtimeCall).toContain('function isDebug() {');
    expect(runtimeCall).toMatch(/function dlog\(\) \{\s*if \(!isDebug\(\)\) return;/);
    expect(runtimeCall).toMatch(/function dwarn\(\) \{\s*if \(!isDebug\(\)\) return;/);
  });

  it('loader.js DEBUG honors localStorage gs:debug in addition to window.__gs_debug/data-debug/config.debugMode', () => {
    expect(loader).toContain("localStorage.getItem('gs:debug') === '1'");
    expect(loader).toContain('var DEBUG = window.__gs_debug === true || readLsDebug();');
  });

  it('call-widget/l.js gates its warnings (previously unconditional, including a raw bootstrap response body dump)', () => {
    expect(callWidgetLoader).toContain('function isDebug() {');
    expect(callWidgetLoader).toMatch(/function dwarn\(\) \{\s*if \(!isDebug\(\)\) return;/);
    expect(callWidgetLoader).not.toMatch(/^\s*console\.warn\(/m);
  });
});

describe('visitor message send idempotency (server/routes/widget.ts)', () => {
  it('accepts a client_message_id idempotency key on POST /message', () => {
    expect(widgetRoute).toContain('client_message_id: z.string().min(8).max(64).optional()');
  });

  it('looks up an existing message with the same key before inserting', () => {
    expect(widgetRoute).toMatch(/filter\('metadata->>client_message_id', 'eq', clientMessageId\)/);
  });

  it('recovers from a lost insert race via the unique index (23505) — reuses migration 070, no second index', () => {
    expect(widgetRoute).toMatch(/duplicate key\|23505/);
  });

  it('a duplicate replay skips AI trigger, realtime publish/push, attachment binding, and nudge attribution', () => {
    expect(widgetRoute).toContain('if (!duplicate && nudgeIdForAttribution && convId)');
    expect(widgetRoute).toContain('if (!duplicate && convId && insertedMsg?.id)');
    expect(widgetRoute).toContain('if (!duplicate && data.attachment_id && insertedMsg?.id)');
    expect(widgetRoute).toContain('if (insertedMsg && !duplicate)');
    expect(widgetRoute).toContain('if (!duplicate && insertedMsg?.id && convId && !platformAiOff)');
  });
});

describe('visitor reply-to-message — real persisted relationship', () => {
  it('accepts reply_to_message_id on POST /message', () => {
    expect(widgetRoute).toContain('reply_to_message_id: z.string().uuid().optional().nullable()');
  });

  it('validates the reply target belongs to the SAME conversation before ever storing it (no cross-conversation leak)', () => {
    expect(widgetRoute).toMatch(/\.eq\('id', data\.reply_to_message_id\)\s*\n\s*\.eq\('conversation_id', convId\)/);
  });

  it('a miss (invalid/foreign id) is dropped silently rather than failing the send', () => {
    expect(widgetRoute).toContain('let replyToMessageId: string | null = null;');
    expect(widgetRoute).toContain('if (parent) {');
    expect(widgetRoute).toContain('replyToMessageId = parent.id;');
  });

  it('stores the validated reply relationship on the insert', () => {
    expect(widgetRoute).toContain('reply_to_message_id: replyToMessageId,');
  });

  it('is backed by a real, forward-only migration adding the column + index, present in BOTH migration chains', () => {
    expect(replyMigrationSelfHost).toContain('ADD COLUMN IF NOT EXISTS reply_to_message_id uuid NULL');
    expect(replyMigrationSelfHost).toContain('REFERENCES public.conversation_messages(id) ON DELETE SET NULL');
    expect(replyMigrationHosted).toBe(replyMigrationSelfHost);
  });

  it('the client-side text-embedded quote convention is preserved unchanged (operator inbox / any bridge still sees the quote inline)', () => {
    expect(runtime).toContain("outText = '> ' + qLine + '\\n\\n' + text;");
  });

  it('the widget composer sends the structured reply target alongside the existing text-embedded quote', () => {
    expect(runtime).toContain('replyToId = pendingQuote.id || null;');
    expect(runtime).toContain('chatUI.sendMessage(outText, renderBody, attachmentId, optimisticAtt, replyToId);');
  });
});

describe('failed message — retry/resend', () => {
  it('the composer creates a visible failed bubble (not a silent no-op) when the transport is not online', () => {
    expect(runtime).toContain(
      "status: transportStore.get().connectionState === 'online' ? 'sending' : 'failed',",
    );
  });

  it('resendMessage() is exported on the chat UI and re-sends with the SAME localId as client_message_id', () => {
    expect(runtime).toContain('resendMessage: resendMessage,');
    expect(runtime).toContain('function resendMessage(localId, onChange) {');
    expect(runtime).toMatch(/attemptSend\(localId, msg\.body, msg\.attachmentId, msg\.departmentId, msg\.replyToMessageId, onChange\);/);
  });

  it('resend is a no-op unless the bubble is actually in the failed state (prevents duplicate resend from repeated clicks)', () => {
    expect(runtime).toContain("if (!msg || msg.status !== 'failed') return;");
  });

  it('the failed status renders a retry action independent of the receiptsEnabled workspace setting', () => {
    expect(presentation).toMatch(
      /m\.sender === 'visitor' && isLastInStreak && m\.status === 'failed'/,
    );
    expect(presentation).toContain('data-msg-retry="');
  });

  it('the retry button is wired through the same delegated click handler as reply/copy, calling chatUI.resendMessage', () => {
    expect(runtime).toContain("'[data-msg-reply],[data-msg-copy],[data-msg-retry]'");
    expect(runtime).toContain("if (el.hasAttribute('data-msg-retry')) {");
    expect(runtime).toContain('chatUI.resendMessage(retryLocalId, renderBody);');
  });

  it('retry styling uses logical (RTL-safe) properties, not hardcoded left/right', () => {
    const block = presentationCss.slice(presentationCss.indexOf('.msg-retry-btn'));
    expect(block).toContain('margin-inline-start');
    expect(block.slice(0, 400)).not.toMatch(/margin-left|margin-right/);
  });
});

describe('clipboard image/file paste', () => {
  it('reuses the existing startUpload() path — no parallel upload implementation', () => {
    const pasteHandlerIdx = runtime.indexOf("msgInput.addEventListener('paste'");
    expect(pasteHandlerIdx).toBeGreaterThan(-1);
    const handlerSrc = runtime.slice(pasteHandlerIdx, pasteHandlerIdx + 1200);
    expect(handlerSrc).toContain('startUpload(file)');
  });

  it('reads clipboardData.items/files only — never navigator.clipboard.read()', () => {
    const pasteHandlerIdx = runtime.indexOf("msgInput.addEventListener('paste'");
    const handlerSrc = runtime.slice(pasteHandlerIdx, pasteHandlerIdx + 1200);
    expect(handlerSrc).toContain('clipboardData');
    expect(handlerSrc).not.toContain('navigator.clipboard.read(');
  });

  it('never calls preventDefault unless an actual file was found (normal text paste is untouched)', () => {
    const pasteHandlerIdx = runtime.indexOf("msgInput.addEventListener('paste'");
    const handlerSrc = runtime.slice(pasteHandlerIdx, pasteHandlerIdx + 1200);
    const fileCheckIdx = handlerSrc.indexOf('if (!file) return;');
    const preventIdx = handlerSrc.indexOf('ev.preventDefault();');
    expect(fileCheckIdx).toBeGreaterThan(-1);
    expect(preventIdx).toBeGreaterThan(fileCheckIdx);
  });

  it('only attaches the paste listener when the attachment feature is actually available (matches the button/input DOM-presence gate)', () => {
    expect(runtime).toContain('if (msgInput && attachBtn && attachInput) {');
  });
});

describe('regression: attachCfg ReferenceError (startUpload previously threw on every call)', () => {
  it('startUpload declares attachCfg locally from the real config object before using it', () => {
    const idx = runtime.indexOf('function startUpload(file) {');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 600);
    expect(body).toContain('var attachCfg = (ctx.config && ctx.config.attachments) || {};');
  });
});

describe('public window.__gs API', () => {
  it('backward compatibility: open/close/toggle/setUnread are unchanged in both the placeholder and real widgetApi', () => {
    for (const cmd of ['open:', 'close:', 'toggle:', 'setUnread:']) {
      expect(loader.match(new RegExp(cmd.replace(':', '\\s*:'), 'g'))?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('new commands are present on BOTH the placeholder (pre-runtime) and real (post-mount) widgetApi', () => {
    const occurrences = (needle: string) => loader.split(needle).length - 1;
    for (const cmd of ['show:', 'hide:', 'isOpen:', 'getState:', 'identify:', 'onReady:', 'onOpen:', 'onClose:', 'onMessage:', 'onUnreadChange:']) {
      expect(occurrences(cmd)).toBeGreaterThanOrEqual(2);
    }
  });

  it('event registration goes through the SAME push()/queue mechanism as every other command — no second dispatch system', () => {
    expect(loader).toContain('function onPublicEvent(name) {');
    expect(loader).toMatch(/eventListeners\[name\]\.push\(cb\);/);
    // processQueue() and push() both dispatch by looking up widgetApi[cmd[0]] —
    // onOpen/onMessage/etc. are ordinary entries on that same object.
    expect(loader).toContain('widgetApi[cmd[0]]');
    expect(loader).toContain('widgetApi[args[i][0]]');
  });

  it('onReady fires immediately for a listener registered AFTER the widget is already ready (late registration is not lost)', () => {
    expect(loader).toContain('if (name === "ready" && readyFired)');
  });

  it('show/hide control launcher visibility, distinct from open/close (the panel)', () => {
    expect(loader).toContain('function setLauncherHidden(hidden) {');
    expect(loader).toContain('launcherEl.style.display = launcherHidden ? "none" : "";');
  });

  it('identify() reuses the EXISTING visitor_name/visitor_email/visitor_phone fields already accepted by POST /message — no new identity mechanism', () => {
    expect(loader).toContain('function setIdentifyData(data) {');
    expect(widgetRoute).toContain('visitor_email: z.string().email().optional().nullable()');
    expect(runtimeChat).toContain('window.__gs_identify_data');
    expect(runtimeChat).toContain('visitor_name: (identifyData && identifyData.name) || undefined,');
  });

  it('onMessage never exposes a message id, conversation id, or token — payload is text + senderType only', () => {
    const idx = runtime.indexOf("window.__gs_public_events.emit('message'");
    expect(idx).toBeGreaterThan(-1);
    const payload = runtime.slice(idx, idx + 250);
    expect(payload).toContain('text:');
    expect(payload).toContain('senderType:');
    expect(payload).not.toMatch(/\bid:|conversationId|messageId|token/);
  });

  it('never fires onMessage for the visitor\'s own outgoing message (only genuinely new inbound messages already excluded contact/visitor sender)', () => {
    // The emission sits inside the `newCount > 0 && lastIncoming` branch,
    // downstream of the loop that already does
    // `if (sender === 'visitor' || sender === 'contact') continue;`.
    const loopIdx = runtime.indexOf("if (sender === 'visitor' || sender === 'contact') continue;");
    const emitIdx = runtime.indexOf("window.__gs_public_events.emit('message'");
    expect(loopIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(loopIdx);
  });
});

describe('hidden-tab polling backoff', () => {
  it('runtime-chat.js startPolling supports a dynamic getInterval() re-evaluated every tick', () => {
    expect(runtimeChat).toContain("typeof opts.getInterval === 'function'");
    expect(runtimeChat).toContain('function scheduleNext() {');
  });

  it('runtime.js slows chat polling while the tab is hidden and restores full cadence when visible, without tearing down the loop', () => {
    expect(runtime).toContain('getInterval: function () {');
    expect(runtime).toMatch(/document\.hidden\)\s*\?\s*15000\s*:\s*4000/);
  });

  it('a call in progress is never affected by the chat-poll backoff (call-widget has its own independent timers)', () => {
    expect(read('public/call-widget/runtime.js')).not.toContain('document.hidden');
  });
});

describe('reply-to-message — every read path resolves the structured relation (not just the FK)', () => {
  it('enrichMessagesWithReplyTo exists as ONE shared, batch-query helper (no N+1, no duplicated logic)', () => {
    expect(widgetAttachmentsSvc).toContain('export async function enrichMessagesWithReplyTo(');
    expect(widgetAttachmentsSvc).toMatch(/\.in\('id', replyIds\)/);
  });

  it('GET /poll selects reply_to_message_id and runs it through enrichMessagesWithReplyTo', () => {
    const idx = widgetRoute.indexOf("widgetRouter.get('/poll'");
    const body = widgetRoute.slice(idx, idx + 5000);
    expect(body).toContain('reply_to_message_id');
    expect(body).toContain('enrichMessagesWithReplyTo(config, enriched)');
  });

  it('GET /history selects reply_to_message_id and runs it through enrichMessagesWithReplyTo', () => {
    const idx = widgetRoute.indexOf("widgetRouter.get('/history'");
    const body = widgetRoute.slice(idx, idx + 2500);
    expect(body).toContain('reply_to_message_id');
    expect(body).toContain('enrichMessagesWithReplyTo(config, enriched)');
  });

  it('GET /identity/history (smart continuation / page-reload path) also resolves it', () => {
    const idx = widgetIdentityRoute.indexOf("widgetIdentityRouter.get('/history'");
    const body = widgetIdentityRoute.slice(idx, idx + 3000);
    expect(body).toContain('reply_to_message_id');
    expect(body).toContain('enrichMessagesWithReplyTo(config, withAttachments)');
  });

  it('the realtime envelope builder (buildMessageEnvelope) carries reply_to_message_id/reply_to when the caller supplies them', () => {
    expect(publishSvc).toContain('reply_to_message_id?: string | null;');
    expect(publishSvc).toContain("...(row.reply_to_message_id ? { reply_to_message_id: row.reply_to_message_id } : {}),");
    expect(publishSvc).toContain('...(row.reply_to ? { reply_to: row.reply_to } : {}),');
  });

  it('POST /message resolves the parent preview with ZERO extra query (reuses the row already fetched to validate the reply target)', () => {
    const idx = widgetRoute.indexOf('Reply-to: only ever accept a target');
    const body = widgetRoute.slice(idx, idx + 1400);
    expect(body).toContain("select('id, body, sender_type')");
    expect(body).toContain('replyToPreview = { id: parent.id, text: parent.body ?? \'\', sender_type: parent.sender_type };');
  });

  it('operator inbox (GET /:id/messages) already returns the raw column via select(\'*\') — zero code change needed for the FK to reach the operator', () => {
    const idx = conversationsRoute.indexOf("conversationsRouter.get('/:id/messages'");
    const body = conversationsRoute.slice(idx, idx + 800);
    expect(body).toContain("select('*')");
  });

  it('the operator inbox already renders the reply/quote relationship — the preserved "> author: text" convention — independent of this change', () => {
    const inboxSrc = read('src/pages/app/InboxPage.tsx');
    expect(inboxSrc).toContain('Quoted replies arrive as leading "> author: text" lines');
    expect(inboxSrc).toMatch(/quoteLines\.push/);
  });
});

describe('fresh-conversation lost-response retry — creation-idempotency fix', () => {
  it('reuses the EXISTING p_match_thread_key mechanism (already proven for channel-bridge conversations) rather than inventing a new one', () => {
    expect(widgetRoute).toContain('const widgetThreadKey = clientMessageId ? `widget_cmid:${clientMessageId}` : null;');
    expect(widgetRoute).toContain('p_match_thread_key: widgetThreadKey,');
    expect(widgetRoute).toContain("p_metadata: widgetThreadKey ? { channel_thread_key: widgetThreadKey } : {},");
  });

  it('the namespaced key can never collide with a real external channel thread key', () => {
    expect(widgetRoute).toContain('widget_cmid:');
  });

  it('does not weaken "+ New conversation": a fresh compose always gets a fresh client_message_id, so the thread-key match only ever reunites retries of the SAME compose attempt', () => {
    // sendMessage() (runtime.js) mints a new localId/client_message_id on
    // every call — forcingNew() does not special-case or reuse a prior id.
    const runtimeSrc = read('public/widget/runtime.js');
    const idx = runtimeSrc.indexOf('function sendMessage(text, onChange');
    const body = runtimeSrc.slice(idx, idx + 800);
    expect(body).toContain("var localId = 'local_' + Date.now() + '_' + Math.random()");
  });

  it('the lock key also prefers client_message_id, so retries of the same compose serialize against each other instead of racing', () => {
    expect(widgetRoute).toContain('const lockKey = clientMessageId ||');
  });
});
