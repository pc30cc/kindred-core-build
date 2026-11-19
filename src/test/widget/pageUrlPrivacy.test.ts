/**
 * What a visitor's page address keeps on its way to the server: no fragment
 * and no credential or contact detail in its query, whatever the case of a
 * parameter's name (`?Token=`, `?ACCESS_TOKEN=`), and any name ending in a
 * credential word (`reset_token`, `client-secret`).
 *
 * One rule, shared/pageUrlPrivacy.ts (the server: a chat's page context, a
 * call's or a callback's page, a nudge's path), and two copies the widgets
 * strip with before sending: public/widget/runtime-chat.js and
 * public/call-widget/runtime.js (`SENSITIVE_QS`, `SENSITIVE_QS_TAIL`). This
 * test keeps the three equal, and runs the chat widget's copy for real.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  SENSITIVE_URL_PARAMS,
  SENSITIVE_URL_PARAM_TAIL,
  isSensitiveUrlParam,
  stripSensitiveUrlParts,
} from '../../../shared/pageUrlPrivacy';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const CHAT_SRC = read('public/widget/runtime-chat.js');
const CALL_SRC = read('public/call-widget/runtime.js');

/** A widget's copy of the list and of the tail, read from its source. */
function widgetCopy(src: string, file: string) {
  const list = src.match(/var SENSITIVE_QS = (\[[^\]]*\]);/);
  const tail = src.match(/var SENSITIVE_QS_TAIL = \/(.+)\/;/);
  expect(list, `${file}: SENSITIVE_QS`).toBeTruthy();
  expect(tail, `${file}: SENSITIVE_QS_TAIL`).toBeTruthy();
  return { list: JSON.parse(list![1].replace(/'/g, '"')) as string[], tail: tail![1] };
}

describe('the shared rule', () => {
  it('matches a name whatever its case', () => {
    for (const name of ['token', 'Token', 'TOKEN', 'access_token', 'ACCESS_TOKEN', 'Email', 'PHONE', 'api_key', 'ApiKey']) {
      expect(isSensitiveUrlParam(name), name).toBe(true);
    }
  });

  it('matches a name ending in a credential word', () => {
    for (const name of ['reset_token', 'client-secret', 'user_password', 'new-pwd', 'x_jwt', 'Reset_Token']) {
      expect(isSensitiveUrlParam(name), name).toBe(true);
    }
  });

  it('keeps an ordinary parameter, and one that only contains a credential word', () => {
    for (const name of ['q', 'step', 'utm_source', 'page', 'tokens', 'tokenizer', 'keyword', 'codec', 'emailed', 'passwordless']) {
      expect(isSensitiveUrlParam(name), name).toBe(false);
    }
  });

  it('drops the fragment and every sensitive parameter, repeated or not, and keeps the rest', () => {
    const u = stripSensitiveUrlParts(new URL('https://shop.example/p?q=1&Token=a&token=b&reset_token=c&EMAIL=d%40e.f&step=2#access_token=z'));
    expect(u.href).toBe('https://shop.example/p?q=1&step=2');
  });

  it('leaves a query with nothing to drop as it was written', () => {
    expect(stripSensitiveUrlParts(new URL('https://shop.example/s?q=a+b&tags=x%2Cy')).href).toBe('https://shop.example/s?q=a+b&tags=x%2Cy');
  });
});

describe('the widgets carry the same rule', () => {
  for (const [file, src] of [['public/widget/runtime-chat.js', CHAT_SRC], ['public/call-widget/runtime.js', CALL_SRC]] as const) {
    it(`${file}: the same list and the same tail`, () => {
      const copy = widgetCopy(src, file);
      expect(copy.list).toEqual([...SENSITIVE_URL_PARAMS]);
      expect(copy.tail).toBe(SENSITIVE_URL_PARAM_TAIL.source);
    });
  }
});

describe('the chat widget strips before it sends (runtime-chat.js)', () => {
  const doms: JSDOM[] = [];
  afterEach(() => { while (doms.length) doms.pop()!.window.close(); });

  function pageContextSent(url: string, referrer?: string) {
    const dom = new JSDOM('<!doctype html><title>Reset</title><body></body>', { url, referrer, runScripts: 'outside-only' });
    doms.push(dom);
    const win = dom.window as unknown as { eval(src: string): void; __gs_mod_chat: { sendMessage(o: Record<string, unknown>): void } };
    win.eval(CHAT_SRC);
    let body: { page_context?: { currentPageUrl?: string; currentPagePath?: string; referrer?: string | null } } = {};
    win.__gs_mod_chat.sendMessage({
      apiBase: 'https://api.test',
      workspaceId: 'ws-test',
      text: 'سلام',
      fetchWith: (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return new Promise(() => {});
      },
    });
    return body.page_context;
  }

  it('the page: no fragment, no sensitive parameter whatever its case', () => {
    const ctx = pageContextSent(
      'https://shop.example/reset?Token=abc&q=1&client-secret=zz&EMAIL=a%40b.c&utm_source=g#access_token=t',
      'https://search.example/?q=shoes&API_KEY=k&Session=s',
    );
    expect(ctx?.currentPageUrl).toBe('https://shop.example/reset?q=1&utm_source=g');
    expect(ctx?.currentPagePath).toBe('/reset');
    expect(ctx?.referrer).toBe('https://search.example/?q=shoes');
  });

  it('a page with nothing to drop is sent as it is', () => {
    expect(pageContextSent('https://shop.example/cart?x=1')?.currentPageUrl).toBe('https://shop.example/cart?x=1');
  });
});
