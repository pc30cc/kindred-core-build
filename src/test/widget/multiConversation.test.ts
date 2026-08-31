/**
 * P0-L — multi-conversation correctness.
 *
 * The bugs this locks down were all "one visitor, more than one thread"
 * bugs: starting a new conversation silently resurrected the old one, an
 * explicitly selected thread loaded whatever the server thought was the
 * latest, and the AI intro fired at most once per page load so a second
 * thread was never greeted. These are contract tests over the shipped
 * widget runtime source (the same files the browser loads) plus the
 * server-side intro reuse rules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const runtime = read('public/widget/runtime.js');
const chat = read('public/widget/runtime-chat.js');
const intro = read('server/services/ai-agent/intro.ts');

describe('P0-A — start new conversation detaches the previous thread', () => {
  it('unsubscribes the old conversation before resetting the store', () => {
    const idx = runtime.indexOf('startNewConversation: function ()');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 900);
    expect(body).toMatch(/transport\.unsubscribeConversation\(previous\)/);
    // Order matters: detach first, then reset, or in-flight frames for the
    // old thread land in the new one.
    expect(body.indexOf('unsubscribeConversation')).toBeLessThan(body.indexOf('freshIntent: true'));
  });

  it('resets every piece of per-conversation ephemeral state', () => {
    const idx = runtime.indexOf('startNewConversation: function ()');
    const body = runtime.slice(idx, idx + 900);
    for (const key of ['conversationId: null', 'messages: []', 'seenIds: {}', 'aiThinking: false']) {
      expect(body).toContain(key);
    }
    expect(body).toMatch(/stopTypewriter\(false\)/);
  });
});

describe('P0-B — a fresh intent can never resurrect the old conversation', () => {
  it('history load bails out entirely while the fresh intent is armed', () => {
    const idx = runtime.indexOf('function loadHistory(opts)');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 400);
    expect(body).toMatch(/if \(freshIntentArmed\(\)\)/);
  });

  it('polling refuses to adopt a server-resolved conversation id', () => {
    // The send path legitimately adopts the id it just created, so target
    // the POLLING callback specifically (the one paired with markPollSuccess).
    const pollIdx = runtime.indexOf('getConversationId: function () { return subscribedConversation; }');
    expect(pollIdx).toBeGreaterThan(-1);
    const idx = runtime.indexOf('onConversation: function (cid)', pollIdx);
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 600);
    expect(body).toMatch(/freshIntentArmed\(\) && !subscribedConversation/);
    // Same guard on the message channel, otherwise old messages stream in
    // even though the cid was refused.
    expect(body).toMatch(/onMessages: function \(msgs\)/);
  });

  it('bootstrapHistory re-checks the latch after the request resolves', () => {
    const idx = runtime.indexOf('function bootstrapHistory(onChange)');
    const body = runtime.slice(idx, idx + 900);
    const hits = body.match(/forcingNew\(\)/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('P0-C — explicit selection loads exactly that conversation', () => {
  it('the transport has a thread-scoped loader that never adopts another id', () => {
    expect(chat).toMatch(/loadConversationHistory: function \(opts\)/);
    const idx = chat.indexOf('loadConversationHistory: function (opts)');
    const body = chat.slice(idx, idx + 1600);
    // The requested id is authoritative in the callback, not data.conversation_id.
    expect(body).toMatch(/conversationId: conversationId,/);
    expect(body).not.toMatch(/data\.conversation_id/);
  });

  it('openConversation detaches the current thread and loads the selected one', () => {
    const idx = runtime.indexOf('function openConversation(conversationId)');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 1200);
    expect(body).toMatch(/unsubscribeConversation\(current\)/);
    expect(body).toMatch(/freshIntent: false/);
    expect(body).toMatch(/loadConversationHistory\(conversationId/);
  });
});

describe('P0-E/F — the AI intro is thread-scoped and understands force-new', () => {
  it('the client dedupe key is per-thread, not a page-load boolean', () => {
    expect(runtime).not.toMatch(/var __aiIntroRequested = false/);
    expect(runtime).toMatch(/var __aiIntroKeys = \{\}/);
    expect(runtime).toMatch(/function aiIntroKey\(\)/);
    // Two successive fresh intents must not collide on the same slot — the
    // canonical monotonic epoch is what keeps them apart (P0-1).
    expect(runtime).toMatch(/'fresh:' \+ ConvEpoch\.get\(\)/);
  });

  it('sends force_new_conversation and withholds the stale id when armed', () => {
    const idx = runtime.indexOf('function requestAiAgentIntro(source)');
    const body = runtime.slice(idx, idx + 1400);
    expect(body).toMatch(/var forceNew = ConvEpoch\.isFresh\(\) \|\| snap\.freshIntent === true/);
    expect(body).toMatch(/forceNew \? null :/);
    expect(body).toMatch(/force_new_conversation: forceNew \|\| undefined/);
  });


  it('a failed intro only frees its own thread slot', () => {
    const idx = runtime.indexOf('function requestAiAgentIntro(source)');
    const body = runtime.slice(idx, idx + 8000);
    expect(body).toMatch(/delete __aiIntroKeys\[key\]/);
  });

  it('server intro skips BOTH reuse lookups when force-new is requested', () => {
    expect(intro).toMatch(/forceNewConversation\?: boolean/);
    expect(intro).toMatch(/const forceNew = input\.forceNewConversation === true/);
    expect(intro).toMatch(/let conversationId = forceNew \? null : \(input\.conversationId \|\| null\)/);
    // session-id reuse and visitor-id reuse are both gated.
    const gated = intro.match(/if \(!forceNew && !conversationId && input\.(visitorSessionId|visitorId)\)/g) || [];
    expect(gated.length).toBe(2);
  });
});

describe('P0-G — one canonical visitor-facing AI gate', () => {
  const guards = read('server/services/ai-agent/platformGuards.ts');
  const widgetRoute = read('server/routes/widget.ts');

  it('the canonical gate owns the customer-visibility switch', () => {
    const idx = guards.indexOf('export async function isAutoAnswerAllowedForWorkspace');
    const body = guards.slice(idx, idx + 2000);
    expect(body).toMatch(/customer_ai_agent_visible === false/);
    expect(body).toMatch(/ai_agent_enabled/);
    expect(body).toMatch(/auto_answer_enabled/);
  });

  it('the widget message route delegates instead of re-reading platform flags', () => {
    const idx = widgetRoute.indexOf('let platformAiOff = false');
    expect(idx).toBeGreaterThan(-1);
    const body = widgetRoute.slice(idx, idx + 1200);
    expect(body).toMatch(/isAutoAnswerAllowedForWorkspace\(config, workspaceId\)/);
    // Fail-closed: an error must not leave the visitor talking to nobody.
    expect(body).toMatch(/platformAiOff = true;[\s\S]*auto_answer_guard_error/);
  });
});
