/**
 * W-08: the dashboard's live preview is the widget visitors get. The frame
 * paints with the production renderers AND the widget's own words (the
 * dictionary of public/widget/runtime.js, which it loads: no copy that
 * drifts), in the real states: the offline behaviour the workspace chose,
 * whether the team is online now, the chat switched off, the pre-chat form
 * the server asks, the welcome the server sends (none while the AI agent
 * greets), the owner's composer text, the button's pulse played twice.
 *
 * Each case runs the frame's own script in a page of its own with the real
 * runtime.js, renderer and extras evaluated into it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { WidgetLivePreview } from '@/components/app/widget/WidgetLivePreview';
import { previewOfflineMode, previewPrechatForm } from '@/components/app/widget/previewStates';

const flags = vi.hoisted(() => ({ edition: 'iran' as 'iran' | 'international' }));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: flags.edition, isInternational: flags.edition === 'international', ready: true }),
  useKnownEdition: () => flags.edition,
}));

afterEach(() => {
  cleanup();
  flags.edition = 'iran';
});

const read = (file: string) => readFileSync(resolve(process.cwd(), 'public/widget', file), 'utf8');
const RUNTIME = read('runtime.js');
const RENDERERS: Record<string, { key: string; files: string[] }> = {
  default: { key: '__gs_presentation_default', files: ['presentation-default.js'] },
  t1: { key: '__gs_presentation_t1', files: ['presentation-t1.js', 'presentation-t1-x.js'] },
  t2: { key: '__gs_presentation_t2', files: ['presentation-t2.js', 'presentation-t2-x.js'] },
};

type Props = Partial<Parameters<typeof WidgetLivePreview>[0]>;

/** The frame, painted by the real renderer with the runtime's words; and every word it asked for. */
function paint(templateId: 'default' | 't1' | 't2', props: Props) {
  const { container } = render(
    <WidgetLivePreview settings={{ widget_language: 'fa' }} brandName="نیلوفر" view="home" templateId={templateId} templateOptions={{}} {...props} />,
  );
  const doc = container.querySelector('iframe')!.getAttribute('srcdoc') || '';
  cleanup();
  const page = new JSDOM(doc, { runScripts: 'outside-only' });
  const w = page.window as unknown as Record<string, unknown> & { eval: (s: string) => void };
  w.eval(RUNTIME);
  // Every word the frame takes from the runtime, and what it got.
  const asked: Array<{ key: string; value: string }> = [];
  const rt = w.__gs_runtime as { t: (locale: string, key: string) => string };
  const real = rt.t;
  rt.t = (locale, key) => {
    const value = real(locale, key);
    asked.push({ key, value });
    return value;
  };
  w.eval(Array.from((page.window.document as Document).querySelectorAll('script:not([src])')).map((s) => s.textContent).join('\n'));
  for (const file of RENDERERS[templateId].files) w.eval(read(file));
  (w as unknown as { gsRenderPreview: (mod: unknown) => void }).gsRenderPreview(w[RENDERERS[templateId].key]);
  const panel = (page.window.document as Document).querySelector('.panel') as HTMLElement;
  return { doc: page.window.document as Document, panel, asked, words: (key: string) => real('fa', key), raw: doc };
}

const text = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

describe('the widget\'s own words', () => {
  it('every view of every template paints with the runtime\'s words and shows no raw key', () => {
    for (const id of ['default', 't1', 't2'] as const) {
      for (const view of ['home', 'chat', 'prechat', 'kb', 'list', 'offline'] as const) {
        const { asked } = paint(id, { view });
        expect(asked.length, `${id} ${view}`).toBeGreaterThan(0);
        // A word the runtime lacks comes back as its key; a renderer's own
        // fallback (tf) may ask for one it does not need, so only what it
        // painted counts: no key in the panel's text.
        const { panel } = paint(id, { view });
        const missing = asked.filter((a) => a.value === a.key).map((a) => a.key);
        for (const key of missing) expect(text(panel), `${id} ${view} shows ${key}`).not.toContain(key);
      }
    }
  });

  it('the pre-chat form says what the widget says: «اتصال به اپراتور», «شماره تلفن» (default)', () => {
    const { panel, words } = paint('default', { view: 'prechat', prechat: { ask_name: true, ask_email: true, ask_phone: true } as never });
    expect(text(panel.querySelector('[data-prechat-submit]'))).toBe(words('wyConnectOperator'));
    expect(words('wyConnectOperator')).toBe('اتصال به اپراتور');
    expect(text(panel)).toContain('شماره تلفن');
    expect(text(panel)).not.toContain('شماره تماس');
  });

  it('a message\'s states are the widget\'s: sent, sending, seen and failed each their own word', () => {
    const { words } = paint('default', { view: 'chat' });
    const states = ['msgSending', 'msgSent', 'msgSeen', 'msgFailed'].map(words);
    expect(new Set(states).size).toBe(4);
    expect(states).toEqual(['در حال ارسال…', 'ارسال شد', 'دیده شد', 'ارسال نشد']);
  });

  it('the dashboard file carries no dictionary of its own', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/app/widget/WidgetLivePreview.tsx'), 'utf8');
    expect(source).not.toMatch(/\bDICTS\b/);
    expect(source).not.toContain("prechatTitle: 'پیش از شروع'");
  });
});

describe('the real states', () => {
  it('the home follows who is online now: start a conversation, or leave a message', () => {
    const on = paint('default', { view: 'home', availabilityState: 'online' });
    expect(text(on.panel)).toContain(on.words('homeStartChat'));
    expect(text(on.panel)).toContain(on.words('homeReplyFast'));
    const away = paint('default', { view: 'home', availabilityState: 'offline' });
    expect(text(away.panel)).toContain(away.words('homeLeaveMessage'));
    expect(text(away.panel)).not.toContain(away.words('homeStartChat'));
    // The kit's button turns to its away look too (loader.js lk-kit-offline).
    expect(away.doc.getElementById('gs-launcher')!.className).toContain('lk-kit-offline');
    expect(on.doc.getElementById('gs-launcher')!.className).not.toContain('lk-kit-offline');
  });

  it('the offline view, "capture a message" (default): the leave-a-message form, the owner\'s offline message as its intro', () => {
    const { panel } = paint('default', {
      view: 'offline',
      settings: { widget_language: 'fa', offline_mode: 'capture_message', offline_message_localized: { fa: 'ساعت ۹ برمی‌گردیم.' } },
    });
    expect(panel.querySelector('[data-fb="message"]')).not.toBeNull();
    expect(text(panel.querySelector('.prechat-intro'))).toBe('ساعت ۹ برمی‌گردیم.');
  });

  it('the offline view, "show only the offline message" (default): that message, no form, no composer', () => {
    const { panel } = paint('default', {
      view: 'offline',
      settings: { widget_language: 'fa', offline_mode: 'show_offline_message', offline_message: 'فعلاً در دسترس نیستیم.' },
    });
    expect(panel.querySelector('[data-fb="message"]')).toBeNull();
    expect(text(panel.querySelector('[data-chat-messages]'))).toContain('فعلاً در دسترس نیستیم.');
    expect((panel.querySelector('[data-input-bar]') as HTMLElement).style.display).toBe('none');
  });

  it('the offline view, "hide the widget": nothing on the page but the note', () => {
    const { doc } = paint('default', { view: 'offline', hiddenNote: 'پنهان', settings: { widget_language: 'fa', offline_mode: 'hide_widget' } });
    expect(doc.querySelector('.shell')!.hasAttribute('hidden')).toBe(true);
    expect(text(doc.querySelector('.gs-hidden-note'))).toBe('پنهان');
  });

  it('an old offline mode, or none, is the form (as the server reads it)', () => {
    expect(previewOfflineMode('accept_messages')).toBe('capture_message');
    expect(previewOfflineMode(undefined)).toBe('capture_message');
    expect(previewOfflineMode('hide_widget')).toBe('hide_widget');
  });

  it('the chat switched off (Behavior): its views show the home, which offers no chat', () => {
    for (const view of ['chat', 'list', 'prechat', 'offline'] as const) {
      const { panel } = paint('default', { view, settings: { widget_language: 'fa', chat_enabled: false } });
      expect(panel.getAttribute('data-view'), view).toBe('home');
      expect(panel.querySelector('[data-chat-messages]'), view).toBeNull();
    }
  });

  it('the pre-chat form without a row is the server\'s: name and email, both required; a field is required only while asked', () => {
    expect(previewPrechatForm(null)).toEqual({
      asked: { name: true, email: true, phone: false },
      required: { name: true, email: true, phone: false },
    });
    expect(previewPrechatForm({ ask_name: false, require_name: true, ask_email: true, require_email: false, ask_phone: true, require_phone: true }))
      .toEqual({ asked: { name: false, email: true, phone: true }, required: { name: false, email: false, phone: true } });
    const { panel } = paint('default', { view: 'prechat', prechat: null });
    expect(panel.querySelector('[data-prechat="name"], #prechat-name, [data-field="name"]')).not.toBeNull();
    expect(panel.querySelectorAll('[aria-required="true"]').length).toBe(2);
  });

  it('the welcome: the owner\'s, else the one the server sends; none while the AI agent greets', () => {
    expect(paint('default', { view: 'list', settings: { widget_language: 'fa', welcome_message: 'خوش آمدید به فروشگاه' } }).raw)
      .toContain('"welcomeMessage":"خوش آمدید به فروشگاه"');
    // An English seed in a Persian widget is no welcome of the owner's: the built-in one.
    expect(paint('default', { view: 'list', settings: { widget_language: 'fa', welcome_message: 'Hello! How can we help you?' } }).raw)
      .toContain('"welcomeMessage":"سلام! چطور می‌توانیم کمکتان کنیم؟"');
    const seeded = paint('default', { view: 'chat', defaultWelcome: 'پیش‌فرض پلتفرم', settings: { widget_language: 'fa', welcome_message: 'Hello! How can we help you?' } });
    expect(seeded.raw).toContain('"welcomeMessage":"پیش‌فرض پلتفرم"');
    // The AI's greeting replaces the welcome bubble in every template.
    for (const id of ['default', 't1', 't2'] as const) {
      const greets = paint(id, { view: 'offline', aiGreets: true, settings: { widget_language: 'fa', welcome_message: 'خوش آمدید به فروشگاه', offline_mode: 'show_offline_message' } });
      expect(greets.raw, id).toContain('"aiAgent":{"suppressGreeting":true}');
      expect(text(greets.panel.querySelector('[data-chat-messages]')), id).toBe('');
      const plain = paint(id, { view: 'offline', settings: { widget_language: 'fa', welcome_message: 'خوش آمدید به فروشگاه', offline_mode: 'show_offline_message', offline_message: 'برمی‌گردیم' } });
      expect(text(plain.panel.querySelector('[data-chat-messages]')), id).toContain('برمی‌گردیم');
    }
  });

  it('the owner\'s composer text is the composer\'s placeholder (the template\'s otherwise)', () => {
    const own = paint('default', { view: 'chat', settings: { widget_language: 'fa', placeholder_text: 'سؤالتان را بنویسید' } });
    expect(own.panel.querySelector('[data-msg-input]')!.getAttribute('placeholder')).toBe('سؤالتان را بنویسید');
    const plain = paint('default', { view: 'chat' });
    expect(plain.panel.querySelector('[data-msg-input]')!.getAttribute('placeholder')).toBe(plain.words('typeMsg'));
  });

  it('the button pulses as the loader plays it: twice, unless switched off', () => {
    const on = paint('default', { view: 'home' });
    expect(on.doc.getElementById('gs-launcher')!.classList.contains('pulse')).toBe(true);
    expect(on.raw).toContain('animation:gs-fab-pulse 2.4s ease-in-out 2;');
    expect(on.raw).not.toContain('infinite}@keyframes gsp');
    const off = paint('default', { view: 'home', settings: { widget_language: 'fa', fab_animation: false } });
    expect(off.doc.getElementById('gs-launcher')!.classList.contains('pulse')).toBe(false);
  });
});
