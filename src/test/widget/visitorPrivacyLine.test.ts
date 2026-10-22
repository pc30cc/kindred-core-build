/**
 * The workspace's privacy line in the visitor's forms (P-01), in the real
 * runtime and the real templates (default, t1, t2): Core puts it under the
 * pre-chat form's fields and above the leave-a-message form's button
 * (runtime.js identity.privacyInto), from /identity/me `prechat.privacy`:
 *
 *   - the owner's text, or the widget's own sentence in the visitor's
 *     language, and the policy link (a new tab, no opener; only https);
 *   - with `consent`, a box the visitor ticks: without it nothing is sent
 *     and the form says why under the box; with it the request says so
 *     (`privacy_consent: true`); the server's own refusal is said there too;
 *   - no privacy line from the server: nothing drawn, nothing sent.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, click, flush, resetWindow, typeInto, type ApiAnswer, type BootOptions } from './coreFeaturesHarness';

beforeEach(() => { resetWindow(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

type H = ReturnType<typeof boot>;
async function chat(opts: BootOptions = {}) {
  const h = boot({ renderer: 'default', ...opts });
  await flush(30);
  h.runtime.setTab('chat');
  await flush(30);
  h.runtime.__test.setConnectionState('online');
  await flush(10);
  return h;
}
const t = (h: H) => h.env().t as (k: string) => string;
const prechatPosts = (h: H) => h.posts.filter((p) => p.url.endsWith('/api/widget/identity/prechat'));
const offlinePosts = (h: H) => h.posts.filter((p) => p.url.endsWith('/api/widget/offline-messages'));
const POLICY = 'https://shop.test/privacy';
function identity(privacy: Record<string, unknown> | null, timing = 'always') {
  return {
    identity_state: 'anonymous', contact: null,
    prechat: {
      ask_name: false, ask_email: true, ask_phone: false, require_name: false, require_email: true, require_phone: false, timing,
      ...(privacy ? { privacy } : {}),
    },
  };
}

describe('the pre-chat form', () => {
  for (const renderer of ['default', 't1', 't2'] as const) {
    it(`${renderer}: the widget's own sentence, the policy link, and nothing sent until the box is ticked`, async () => {
      const h = await chat({ renderer, identity: identity({ text: null, url: POLICY, consent: true }) });
      const line = h.q('[data-prechat-privacy]');
      expect(line).not.toBeNull();
      expect(line!.querySelector('.prechat-privacy__text')!.textContent).toContain(t(h)('prechatPrivacy'));
      const link = line!.querySelector('a')!;
      expect(link.getAttribute('href')).toBe(POLICY);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.textContent).toBe(t(h)('privacyPolicyLink'));
      // Under the fields, above the button.
      const fields = h.q('.prechat-fields')!;
      expect(fields.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, 'sara@example.com');
      click(h.q('[data-prechat-submit]'));
      await flush(10);
      expect(prechatPosts(h)).toEqual([]);
      expect(h.q('[data-err="privacy"]')!.textContent).toBe(t(h)('privacyConsentRequired'));
      expect(h.q('[data-prechat-consent]')!.getAttribute('aria-invalid')).toBe('true');

      const box = h.q<HTMLInputElement>('[data-prechat-consent]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      expect(h.q('[data-err="privacy"]')!.textContent).toBe('');
      click(h.q('[data-prechat-submit]'));
      await flush(10);
      expect(prechatPosts(h).map((p) => p.body)).toEqual([expect.objectContaining({ email: 'sara@example.com', privacy_consent: true })]);
    });
  }

  it('the owner\'s own text, no box: the request says nothing of consent', async () => {
    const h = await chat({ identity: identity({ text: 'Your details go to Niloufar only.', url: null, consent: false }) });
    expect(h.q('.prechat-privacy__text')!.textContent).toBe('Your details go to Niloufar only.');
    expect(h.q('[data-prechat-privacy] a')).toBeNull();
    expect(h.q('[data-prechat-consent]')).toBeNull();
    typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, 'sara@example.com');
    click(h.q('[data-prechat-submit]'));
    await flush(10);
    expect(prechatPosts(h)).toHaveLength(1);
    expect(prechatPosts(h)[0].body).not.toHaveProperty('privacy_consent');
  });

  it('only an https link is drawn', async () => {
    const h = await chat({ identity: identity({ text: null, url: 'javascript:alert(1)', consent: false }) });
    expect(h.q('[data-prechat-privacy]')).not.toBeNull();
    expect(h.q('[data-prechat-privacy] a')).toBeNull();
  });

  it('without a privacy line from the server nothing is drawn', async () => {
    const h = await chat({ identity: identity(null) });
    expect(h.q('[data-prechat-submit]')).not.toBeNull();
    expect(h.q('[data-prechat-privacy]')).toBeNull();
  });

  it('the server\'s own refusal (an older form) is said under the box', async () => {
    const h = await chat({
      identity: identity({ text: null, url: null, consent: false }),
      api: (u) => (u.endsWith('/api/widget/identity/prechat') ? { status: 400, body: { error: 'privacy_consent_required', field: 'privacy' } } : undefined),
    });
    typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, 'sara@example.com');
    click(h.q('[data-prechat-submit]'));
    await flush(10);
    expect(h.q('[data-err="privacy"]')!.textContent).toBe(t(h)('privacyConsentRequired'));
  });
});

describe('the leave-a-message form', () => {
  const AWAY = { state: 'offline', offline_mode: 'capture_message', labels: {}, next_open_at: null };
  for (const renderer of ['default', 't1', 't2'] as const) {
    it(`${renderer}: the line above the button, and the box asked before sending`, async () => {
      const answers: ApiAnswer[] = [{ body: { ok: true, captured: true, conversation_id: 'c-off', transitioning: false } }];
      const h = await chat({
        renderer,
        config: { availability: AWAY },
        identity: identity({ text: null, url: POLICY, consent: true }, 'never'),
        api: (u) => (u.endsWith('/api/widget/offline-messages') ? answers.shift() : undefined),
      });
      const line = h.q('[data-prechat-privacy]');
      expect(line).not.toBeNull();
      const submit = h.q('[data-fb-submit]')!;
      expect(line!.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      typeInto(h.q<HTMLInputElement>('[data-fb="email"]')!, 'sara@example.com');
      typeInto(h.q<HTMLTextAreaElement>('[data-fb="message"]')!, 'سلام');
      click(h.q('[data-fb-submit]'));
      await flush(10);
      expect(offlinePosts(h)).toEqual([]);
      expect(h.q('[data-err="privacy"]')!.textContent).toBe(t(h)('privacyConsentRequired'));

      const box = h.q<HTMLInputElement>('[data-prechat-consent]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      click(h.q('[data-fb-submit]'));
      await flush(20);
      expect(offlinePosts(h).map((p) => p.body)).toEqual([expect.objectContaining({ email: 'sara@example.com', privacy_consent: true })]);
    });
  }
});
