/**
 * The visitor's forms in the real runtime (default template), as a visitor
 * fills them:
 *
 *   - V-01: a field the form does not draw is never required, even when an
 *     older server still says "required" for it.
 *   - V-14: one email rule with the server (zod's), and every refusal is said:
 *     a field the server names under that field, anything else (too many
 *     attempts, no connection, a server error) under the fields.
 *   - V-08: a phone typed with Persian digits, as the placeholder shows it,
 *     is taken and sent as ASCII digits.
 *   - V-09 / V-16 / V-32 (the leave-a-message form): a phone alone is a way
 *     to reach the visitor; after the send the visitor is identified, the
 *     message and a "received, the reply appears here" line stay in the
 *     thread and no pre-chat asks again; a refusal says why; the message may
 *     be as long as a chat message.
 *   - W-06: the owner's composer text is the composer's placeholder.
 *   - V-33: a refused file says the limit and the kinds allowed, in the
 *     visitor's digits and words.
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
const err = (h: H, key: string) => h.q(`[data-err="${key}"]`)?.textContent || '';
const prechatPosts = (h: H) => h.posts.filter((p) => p.url.endsWith('/api/widget/identity/prechat'));
const prechat = (fields: Record<string, unknown>) => ({
  identity_state: 'anonymous', contact: null,
  prechat: { ask_name: false, ask_email: false, ask_phone: false, require_name: false, require_email: false, require_phone: false, timing: 'always', ...fields },
});

describe('the pre-chat form', () => {
  it('V-01: an older server\'s "required" for a field not asked never blocks the visitor', async () => {
    const h = await chat({ identity: prechat({ ask_name: false, require_name: true, ask_email: true, require_email: true }) });
    expect(h.q('[data-prechat="name"]')).toBeNull();
    typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, 'ali@example.com');
    click(h.q('[data-prechat-submit]'));
    await flush(10);
    expect(prechatPosts(h).map((p) => p.body)).toEqual([expect.objectContaining({ name: null, email: 'ali@example.com' })]);
  });

  it('V-14: the server\'s rule in the widget: an address it would refuse is refused in place, nothing sent', async () => {
    const h = await chat({ identity: prechat({ ask_email: true, require_email: true }) });
    for (const bad of ['ali@exa_mple.com', 'name@gmail.com.', 'علی@example.com', 'x@y.co,']) {
      typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, bad);
      click(h.q('[data-prechat-submit]'));
      await flush(5);
      expect(err(h, 'email')).toBe(t(h)('invalidEmail'));
    }
    expect(prechatPosts(h)).toEqual([]);
    // A required field left empty says so in a whole sentence.
    typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, '');
    click(h.q('[data-prechat-submit]'));
    await flush(5);
    expect(err(h, 'email')).toBe('لطفاً این فیلد را پر کنید.');
  });

  it('V-14: a refusal the server names goes under its field; too many attempts, no connection and a server error under the fields', async () => {
    const answers: Array<ApiAnswer | 'network'> = [
      { status: 400, body: { error: 'email_invalid', field: 'email', details: { email: ['Invalid email'] } } },
      { status: 400, body: { error: 'name_required', field: 'name' } },
      { status: 429, body: { error: 'rate_limited', retry_after: 30 } },
      'network',
      { status: 500, body: { error: 'merge_failed' } },
    ];
    const h = await chat({
      identity: prechat({ ask_name: true, ask_email: true }),
      api: (u) => {
        if (!u.endsWith('/api/widget/identity/prechat')) return undefined;
        const a = answers.shift()!;
        return a === 'network' ? Promise.reject(new TypeError('Failed to fetch')) as never : a;
      },
    });
    const submit = async () => { click(h.q('[data-prechat-submit]')); await flush(10); };
    typeInto(h.q<HTMLInputElement>('[data-prechat="name"]')!, 'علی');
    typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, 'ali@example.com');
    await submit();
    expect(err(h, 'email')).toBe(t(h)('invalidEmail'));
    await submit();
    expect(err(h, 'name')).toBe(t(h)('fieldRequired'));
    await submit();
    expect(err(h, 'form')).toBe(t(h)('formRate'));
    expect(h.q('[data-err="form"]')!.getAttribute('role')).toBe('alert');
    await submit();
    expect(err(h, 'form')).toBe(t(h)('formOffline'));
    await submit();
    expect(err(h, 'form')).toBe(t(h)('formError'));
    expect(prechatPosts(h)).toHaveLength(5);
    // Still the form: nothing was taken.
    expect(h.q('[data-prechat-submit]')).not.toBeNull();
  });

  it('V-08: a phone typed with Persian digits, as the placeholder shows it, is taken and sent in ASCII digits', async () => {
    const h = await chat({ identity: prechat({ ask_phone: true, require_phone: true }) });
    expect(h.q<HTMLInputElement>('[data-prechat="phone"]')!.getAttribute('placeholder')).toBe('۰۹۱۲ ۳۴۵ ۶۷۸۹');
    typeInto(h.q<HTMLInputElement>('[data-prechat="phone"]')!, '۰۹۱۲ ۳۴۵ ۶۷۸۹');
    click(h.q('[data-prechat-submit]'));
    await flush(10);
    expect(err(h, 'phone')).toBe('');
    expect(prechatPosts(h).map((p) => p.body.phone)).toEqual(['0912 345 6789']);
  });
});

describe('the leave-a-message form (the team away)', () => {
  const AWAY = { state: 'offline', offline_mode: 'capture_message', labels: {}, next_open_at: null };
  const asked = { identity_state: 'anonymous', contact: null, prechat: { ask_name: true, ask_email: true, ask_phone: true, require_name: false, require_email: false, require_phone: false, timing: 'never' } };
  const offlinePosts = (h: H) => h.posts.filter((p) => p.url.endsWith('/api/widget/offline-messages'));
  function fill(h: H, values: Record<string, string>) {
    for (const [k, v] of Object.entries(values)) typeInto(h.q<HTMLInputElement>(`[data-fb="${k}"]`)!, v);
  }

  it('V-09 / V-16: a name and a phone (Persian digits) are enough; the thread keeps the message and the confirmation, and nothing asks for the details again', async () => {
    const h = await chat({
      config: { availability: AWAY },
      identity: asked,
      api: (u) => (u.endsWith('/api/widget/offline-messages') ? { body: { ok: true, captured: true, conversation_id: 'c-off', transitioning: false } } : undefined),
    });
    expect(h.q<HTMLTextAreaElement>('[data-fb="message"]')!.maxLength).toBe(5000);
    fill(h, { name: 'علی', phone: '۰۹۱۲ ۳۴۵ ۶۷۸۹', message: 'لطفاً تماس بگیرید' });
    click(h.q('[data-fb-submit]'));
    await flush(20);
    expect(offlinePosts(h).map((p) => p.body)).toEqual([expect.objectContaining({ name: 'علی', phone: '0912 345 6789', message: 'لطفاً تماس بگیرید' })]);
    expect(offlinePosts(h)[0].body).not.toHaveProperty('email');
    // The thread: the message, then the confirmation that stays.
    const thread = h.q('[data-chat-messages]')!.textContent || '';
    expect(thread).toContain('لطفاً تماس بگیرید');
    expect(thread).toContain('پیام شما دریافت شد. پاسخ همین‌جا در گفتگو نمایش داده می‌شود.');
    expect(h.q('[data-fb="message"]')).toBeNull();
    expect(h.q('[data-prechat-submit]')).toBeNull();
    // Repaints keep it (the line is the thread's, not the form's status).
    h.runtime.setTab('home');
    await flush(10);
    h.runtime.setTab('chat');
    await flush(10);
    expect(h.q('[data-chat-messages]')!.textContent).toContain('پیام شما دریافت شد.');
    expect(h.q('[data-prechat-submit]')).toBeNull();
  });

  it('V-32: a way to reach the visitor is asked in words; the server\'s refusals say why', async () => {
    const answers: ApiAnswer[] = [
      { status: 400, body: { error: 'invalid_payload', details: { fieldErrors: { email: ['Invalid email'] }, formErrors: [] } } },
      { status: 429, body: { error: 'rate_limited' } },
    ];
    const h = await chat({
      config: { availability: AWAY },
      identity: asked,
      api: (u) => (u.endsWith('/api/widget/offline-messages') ? answers.shift() : undefined),
    });
    fill(h, { message: 'سلام' });
    click(h.q('[data-fb-submit]'));
    await flush(5);
    expect(err(h, 'email')).toBe(t(h)('fallbackContactNeeded'));
    expect(offlinePosts(h)).toEqual([]);
    fill(h, { email: 'ali@example.com' });
    click(h.q('[data-fb-submit]'));
    await flush(10);
    expect(err(h, 'email')).toBe(t(h)('invalidEmail'));
    click(h.q('[data-fb-submit]'));
    await flush(10);
    expect(h.q('[data-fb-status]')!.textContent).toBe(t(h)('formRate'));
  });
});

describe('the composer and attachments', () => {
  it('W-06: the owner\'s composer text is the placeholder (without one, the template\'s own)', async () => {
    const own = await chat({ config: { placeholderText: 'سؤالتان را بپرسید…' } });
    expect(own.q('[data-msg-input]')!.getAttribute('placeholder')).toBe('سؤالتان را بپرسید…');
    resetWindow();
    const none = await chat({ config: { placeholderText: '' } });
    expect(none.q('[data-msg-input]')!.getAttribute('placeholder')).toBe(t(none)('typeMsg'));
  });

  it('V-33: a refused file says the limit and the kinds allowed, in the visitor\'s digits and words', async () => {
    const h = await chat({ config: { attachments: { enabled: true, maxSizeMb: 2, allowedMimes: ['image/png', 'image/jpeg', 'application/pdf'] } } });
    const input = h.q<HTMLInputElement>('[data-attach-input]')!;
    const choose = async (file: File) => {
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      input.dispatchEvent(new Event('change'));
      await flush(5);
      return h.q('[data-attach-sub]')!.textContent;
    };
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 });
    expect(await choose(big)).toBe('حجم فایل بیش از حد مجاز است (حداکثر ۲ مگابایت)');
    expect(await choose(new File(['x'], 'a.zip', { type: 'application/zip' }))).toBe('این نوع فایل مجاز نیست. نوع‌های مجاز: PNG، JPG، PDF');
  });
});
