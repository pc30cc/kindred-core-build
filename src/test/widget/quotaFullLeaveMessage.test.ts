/**
 * Simple billing phase 4 — "when the monthly quota is full the widget shows
 * the leave-a-message form" (docs/billing/SIMPLE_BILLING.md), in the shipped
 * widget runtime (the files the browser loads; runtime.js has no module
 * system, so its pieces are read from source):
 *
 *   - /config's availability.quota_full (sent only while billing locks are
 *     on) puts the form in front of a visitor who has no thread yet, whatever
 *     offline_mode says; an existing thread keeps its composer;
 *   - a first message refused for max_conversations switches to the form
 *     (the typed text kept) — only when the server announced the field, so
 *     with locks off the old behaviour (a failed bubble) stays;
 *   - the form says why, in en/fa/tr.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const runtime = read('public/widget/runtime.js');
const chat = read('public/widget/runtime-chat.js');

/** The source of `function <name>(…) { … }` in runtime.js (balanced braces). */
function fnSource(name: string): string {
  const start = runtime.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = runtime.indexOf('{', start); i < runtime.length; i++) {
    if (runtime[i] === '{') depth++;
    else if (runtime[i] === '}' && --depth === 0) return runtime.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

type Msg = { localId?: string; body?: string };
function harness(opts: { availability?: Record<string, unknown>; conversationId?: string | null; messages?: Msg[] }) {
  const ctx: Record<string, unknown> = { config: { availability: opts.availability ?? {} } };
  let store = { conversationId: opts.conversationId ?? null, messages: opts.messages ?? [{ localId: 'l1', body: 'hi' }] };
  const chatStore = { get: () => store, set: (p: Partial<typeof store>) => { store = { ...store, ...p }; } };
  let renders = 0;
  const switchToQuotaForm = new Function('ctx', 'chatStore', `${fnSource('switchToQuotaForm')}; return switchToQuotaForm;`)(
    ctx, chatStore,
  ) as (err: unknown, localId: string, text: string, onChange: () => void) => boolean;
  const run = (err: unknown) => switchToQuotaForm(err, 'l1', 'hi', () => { renders++; });
  return { ctx, run, store: () => store, renders: () => renders };
}

const quotaErr = { status: 403, feature: 'max_conversations' };

describe('a first message refused for max_conversations', () => {
  it('switches to the form, keeps the text, and drops the failed bubble', () => {
    const h = harness({ availability: { quota_full: false } });
    expect(h.run(quotaErr)).toBe(true);
    expect(h.ctx.__quotaFull).toBe(true);
    expect(h.ctx.__quotaDraft).toBe('hi');
    expect(h.store().messages).toEqual([]);
    expect(h.renders()).toBe(1);
  });

  it('keeps the old failed bubble while billing locks are off (no quota_full field)', () => {
    const h = harness({ availability: {} });
    expect(h.run(quotaErr)).toBe(false);
    expect(h.ctx.__quotaFull).toBeUndefined();
    expect(h.store().messages).toHaveLength(1);
  });

  it('never takes over an existing thread or another error', () => {
    expect(harness({ availability: { quota_full: true }, conversationId: 'c1' }).run(quotaErr)).toBe(false);
    expect(harness({ availability: { quota_full: true }, messages: [{ localId: 'x' }, { localId: 'l1' }] }).run(quotaErr)).toBe(false);
    expect(harness({ availability: { quota_full: true } }).run({ status: 403, feature: 'max_visitors' })).toBe(false);
    expect(harness({ availability: { quota_full: true } }).run({ status: 500 })).toBe(false);
    expect(harness({ availability: { quota_full: true } }).run('module_unavailable')).toBe(false);
  });

  it('the send error carries the limit key from the 403 body', () => {
    expect(chat).toMatch(/e\.feature = \(body && typeof body\.feature === 'string'\) \? body\.feature : null;/);
    const idx = runtime.indexOf('function attemptSend(');
    const body = runtime.slice(idx, idx + 3000);
    expect(body).toMatch(/onError: function \(err\) \{[\s\S]*?if \(switchToQuotaForm\(err, localId, text, onChange\)\) \{ if \(done\) done\(\); return; \}/);
  });
});

describe('the entry flow while the quota is full', () => {
  const derive = fnSource('deriveChatTabState');

  it('picks OFFLINE_CONTACT for a visitor without a thread, before pre-chat and the AI', () => {
    const quota = derive.indexOf('quotaFull && !hasMsgs && !chatStore.get().conversationId');
    expect(quota).toBeGreaterThan(-1);
    expect(derive.slice(quota, quota + 200)).toContain('ENTRY_FLOW_STATE.OFFLINE_CONTACT');
    expect(quota).toBeLessThan(derive.indexOf('identity.shouldRequirePrechat(flow)'));
    expect(quota).toBeLessThan(derive.indexOf('if (aiOwnsThread)'));
    expect(derive).toMatch(/ctx\.__quotaFull === true\s*\|\| !!\(ctx\.config && ctx\.config\.availability && ctx\.config\.availability\.quota_full === true\)/);
  });

  it('the form says why and is prefilled with what the visitor typed', () => {
    const form = fnSource('renderContactFallback');
    expect(form).toMatch(/introLabel: t\('quotaFullIntro'\)/);
    expect(form).toMatch(/draftEl\.value = ctx\.__quotaDraft/);
  });

  it('has the text in en, fa and tr', () => {
    const hits = runtime.match(/quotaFullIntro: '[^']+'|quotaFullIntro: "[^"]+"/g) ?? [];
    expect(hits).toHaveLength(3);
    const fa = hits.find((h) => /[؀-ۿ]/.test(h))!;
    expect(fa).toBeTruthy();
    expect(fa).not.toMatch(/[يك]/);
  });
});
