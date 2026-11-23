/**
 * The call widget's engine (public/call-widget/runtime.js):
 *
 *  - a rating is sent once per call: a second tap while the first is on its
 *    way (or after it) sends nothing; the next call rates again;
 *  - a `{name}` placeholder takes its value as it is: a `$&` or `$1` in an
 *    operator's name or a workspace's text is no replacement pattern.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeCallWidgets, fakeApi, mountCallWidget, settle, type ApiAnswer, type Engine } from './mountCallWidget';

afterEach(() => { closeCallWidgets(); });

type Rating = Engine & { ratingValue: number; ratingComment: string; submitRating(): void };

function engine(answer?: () => Promise<ApiAnswer>, bootstrap: Record<string, unknown> = {}) {
  const api = fakeApi((req) => (answer && /\/rate$/.test(req.path) ? answer() : undefined));
  const m = mountCallWidget({ locale: 'en', fetch: api.fetch, bootstrap });
  return { api, c: m.ctrl as unknown as Rating };
}
const rates = (api: ReturnType<typeof fakeApi>) => api.requests.filter((r) => r.method === 'POST' && /\/calls\/[^/]+\/rate$/.test(r.path));

describe('a call\'s rating', () => {
  it('two taps while it is on its way send one rating', async () => {
    let release!: () => void;
    const held = new Promise<ApiAnswer>((r) => { release = () => r({ status: 200, body: { ok: true } }); });
    const { api, c } = engine(() => held);
    c.endedCallId = 'c1';
    c.ratingValue = 5;
    c.submitRating();
    c.submitRating();
    release();
    await settle();
    expect(rates(api)).toHaveLength(1);
    expect(rates(api)[0].body).toMatchObject({ rating: 5 });
    expect(c.ratingSubmitted).toBe(true);
    c.submitRating();
    await settle();
    expect(rates(api)).toHaveLength(1);
  });

  it('a failed rating still ends the card, and sends nothing more', async () => {
    const { api, c } = engine(() => Promise.resolve('network' as ApiAnswer));
    c.endedCallId = 'c1';
    c.ratingValue = 3;
    c.submitRating();
    await settle();
    expect(c.ratingSubmitted).toBe(true);
    c.submitRating();
    await settle();
    expect(rates(api)).toHaveLength(1);
  });
});

describe('a placeholder takes its value as it is', () => {
  it.each(['A$&B', '$1', "$'", '$`', '$$'])('%j', (value) => {
    const { c } = engine();
    expect(c.t('err_wait_seconds', { n: value })).toBe(`Please wait ${value}s before sending another request.`);
  });

  it('a workspace\'s own text too', () => {
    const { c } = engine(undefined, { config: { custom_texts: { en: { err_wait_seconds: 'Back in {n}' } } } });
    expect(c.t('err_wait_seconds', { n: '$&' })).toBe('Back in $&');
  });
});
