/**
 * Skeleton ⇄ real-surface parity.
 *
 * A skeleton exists to hold the exact shape of the surface that replaces it.
 * When it drifts, the visitor watches the widget rearrange itself on every
 * load — most visibly the composer, which used to sit part-way up the panel
 * because the skeleton's `.wy-chat-body` wrapper had no stylesheet rule at
 * all and so collapsed to its content height inside a flex column.
 *
 * These tests compare what the shipped renderer actually emits for each
 * surface against what it emits for that surface's skeleton.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const REGISTRY_SRC = read('public/widget/presentation-registry.js');
const RENDERER_SRC = read('public/widget/presentation-web-yar.js');
const RUNTIME_JS = read('public/widget/runtime.js');
const CSS = read('public/widget/presentation-web-yar.css') + read('public/widget/runtime.css');

type Vm = Record<string, unknown>;
interface Renderer {
  chatFrameHtml: (vm: Vm) => string;
  homeHtml: (vm: Vm) => string;
  conversationListHtml: (vm: Vm) => string;
  kbHtml: (vm: Vm) => string;
  prechatFormHtml: (identity: Vm, contact: Vm, locale: string) => string;
  skeletonHtml: (view: string, vm: Vm) => string;
}

const DICT: Record<string, string> = {
  homeReplyFast: 'معمولاً چند دقیقه‌ای پاسخ می‌دهیم',
  homeReplySlow: 'به‌زودی پاسخ می‌دهیم',
  homeGreeting: 'سلام',
  homeWelcome: 'خوش آمدید',
  help: 'راهنما',
  continue: 'ادامه',
  searchKb: 'جستجو',
};

const CONFIG: Vm = {
  brandName: 'Acme',
  platformName: 'Web Yar',
  attachments: { enabled: true, voiceNotesEnabled: true },
  composer: { emojiEnabled: true },
};

function renderer(configExtra: Vm = {}): Renderer {
  const w = window as unknown as Record<string, unknown>;
  // jsdom has neither; the mic control is gated on real voice support.
  w.MediaRecorder = function () {};
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: () => {} }, configurable: true,
    });
  }
  new Function(REGISTRY_SRC).call(window);
  new Function(RENDERER_SRC).call(window);
  const factory = w.__gs_presentation_web_yar as { create: (env: Vm) => Renderer };
  return factory.create({
    t: (k: string) => DICT[k] ?? k,
    escapeHtml: (v: unknown) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string),
    config: { ...CONFIG, ...configExtra },
    locale: 'fa',
    primaryColor: '#1f93ff',
  });
}

/** Every class token the markup uses, in document order, de-duplicated. */
function classesOf(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Classes that decide where things sit, in order — the layout spine.
 *  `.header` is deliberately absent: it carries no stylesheet rule and
 *  exists only as a Core query hook on the real frame. */
const LAYOUT = /^(wy-view|wy-view-chat|wy-head|wy-head-chat|wy-head-text|wy-chat-scroll-host|wy-chat-scroll|wy-scroll|composer-zone|input-bar|input-wrap|input|mic-btn|composer-actions|composer-actions-start|composer-actions-end|attach-btn|emoji-btn|send-btn|wy-footer)$/;
const spineOf = (html: string) => classesOf(html).filter((c) => LAYOUT.test(c));

const hasRule = (cls: string) =>
  new RegExp('\\.' + cls.replace(/-/g, '\\-') + '(?![\\w-])').test(CSS);

const chatFrame = (vm: Vm = {}) => renderer().chatFrameHtml({
  config: CONFIG, chatEnabled: true, locale: 'fa', ...vm,
});
const chatSkeleton = (vm: Vm = {}) => renderer().skeletonHtml('chat', {
  rtl: true, chatEnabled: true,
  composer: { attachments: true, voiceNotes: true, emoji: true },
  ...vm,
});

describe('a skeleton class is either styled or shared with the real surface', () => {
  // `.wy-chat-body` was neither: invented for the skeleton alone and carrying
  // layout responsibility no stylesheet rule ever granted it.
  it('no skeleton-only class is left without a rule', () => {
    const R = renderer();
    const surfaces: Array<[string, string, string]> = [
      ['chat', R.skeletonHtml('chat', { rtl: true, chatEnabled: true, composer: { attachments: true, voiceNotes: true, emoji: true } }),
        R.chatFrameHtml({ config: CONFIG, chatEnabled: true, locale: 'fa' })],
      ['home', R.skeletonHtml('home', { rtl: true }),
        R.homeHtml({ rtl: true, chatEnabled: true, conversations: [], articles: [] })],
      ['list', R.skeletonHtml('list', { rtl: true, chatEnabled: true }),
        R.conversationListHtml({ rtl: true, chatEnabled: true, conversations: [], loading: false })],
      ['articles', R.skeletonHtml('articles', { rtl: true }),
        R.kbHtml({ rtl: true, state: 'list', articles: [{ slug: 'a', title: 't' }] })],
    ];
    for (const [name, skel, real] of surfaces) {
      const realClasses = classesOf(real);
      const orphans = classesOf(skel)
        .filter((c) => !hasRule(c) && !realClasses.includes(c));
      expect(orphans, `${name} skeleton emits unstyled, skeleton-only classes`).toEqual([]);
    }
  });
});

describe('the chat skeleton holds the real chat frame in place', () => {
  it('uses the same layout spine, in the same order', () => {
    expect(spineOf(chatSkeleton())).toEqual(spineOf(chatFrame()));
  });

  it('puts the composer where the real one goes — after the scroll host, not inside it', () => {
    const skel = chatSkeleton();
    expect(skel.indexOf('wy-chat-scroll-host')).toBeGreaterThan(-1);
    expect(skel.indexOf('wy-chat-scroll-host')).toBeLessThan(skel.indexOf('composer-zone'));
    // The wrapper that caused the drift is gone for good.
    expect(skel).not.toContain('wy-chat-body');
  });

  it('is decorative to assistive tech as a whole', () => {
    expect(chatSkeleton()).toMatch(/<div class="wy-view wy-view-chat wy-skeleton" aria-hidden="true"/);
  });
});

describe('the skeleton composer shows exactly the controls Core will mount', () => {
  const controls = (html: string) => ({
    mic: /class="mic-btn/.test(html),
    attach: /class="attach-btn/.test(html),
    emoji: /class="emoji-btn/.test(html),
    send: /class="send-btn/.test(html),
  });

  it('matches the real frame when everything is enabled', () => {
    expect(controls(chatSkeleton())).toEqual(controls(chatFrame()));
  });

  it('matches the real frame when attachments and voice are off', () => {
    const cfg = { attachments: { enabled: false, voiceNotesEnabled: false }, composer: { emojiEnabled: true } };
    const real = renderer(cfg).chatFrameHtml({ config: cfg, chatEnabled: true, locale: 'fa' });
    const skel = chatSkeleton({ composer: { attachments: false, voiceNotes: false, emoji: true } });
    expect(controls(skel)).toEqual(controls(real));
  });

  it('matches the real frame when the emoji picker is off too', () => {
    const cfg = { attachments: { enabled: false, voiceNotesEnabled: false }, composer: { emojiEnabled: false } };
    const real = renderer(cfg).chatFrameHtml({ config: cfg, chatEnabled: true, locale: 'fa' });
    const skel = chatSkeleton({ composer: { attachments: false, voiceNotes: false, emoji: false } });
    expect(controls(skel)).toEqual(controls(real));
    expect(skel).not.toContain('mic-btn');
  });

  it('draws no composer at all when chat is disabled, like the real frame', () => {
    const real = renderer().chatFrameHtml({ config: CONFIG, chatEnabled: false, locale: 'fa' });
    const skel = chatSkeleton({ chatEnabled: false });
    expect(real).not.toContain('composer-zone');
    expect(skel).not.toContain('composer-zone');
    // Both still carry the platform footer.
    expect(skel).toContain('wy-footer');
  });

  it('leaves the send control to the same CSS rule the real composer uses', () => {
    // The real frame always emits .send-btn and lets the stylesheet hide it
    // until there is a draft. The skeleton does the same rather than making
    // its own decision, so one rule keeps governing both.
    expect(chatFrame()).toContain('send-btn');
    expect(chatSkeleton()).toContain('send-btn');
    expect(CSS).toContain('.input-bar:not(.has-draft) .send-btn { display: none; }');
  });
});

describe('header lines match the header that replaces them', () => {
  it('reuses the real header text structure rather than a parallel one', () => {
    const skel = chatSkeleton();
    expect(skel).toContain('wy-head-text');
    expect(skel).toContain('wy-head-title');
    // The old skeleton-only wrappers are gone.
    expect(skel).not.toContain('wy-head-id');
    expect(skel).not.toContain('wy-head-line');
  });

  it('drops the subtitle line when the workspace cleared its reply-time text', () => {
    const R = renderer({ replyTimeText: '' });
    const real = R.chatFrameHtml({ config: { ...CONFIG, replyTimeText: '' }, chatEnabled: true, locale: 'fa' });
    const skel = R.skeletonHtml('chat', { rtl: true, chatEnabled: true, composer: {} });
    expect(real).not.toContain('wy-head-sub');
    expect(skel).not.toContain('wy-head-sub');
  });

  it('keeps the subtitle line when there is one', () => {
    expect(chatFrame()).toContain('wy-head-sub');
    expect(chatSkeleton()).toContain('wy-head-sub');
  });

  it('the list skeleton carries the title box and the new-conversation control', () => {
    const R = renderer();
    const real = R.conversationListHtml({ rtl: true, chatEnabled: true, conversations: [], loading: false });
    const skel = R.skeletonHtml('list', { rtl: true, chatEnabled: true });
    for (const cls of ['wy-head-plain', 'wy-fab']) {
      expect(real).toContain(cls);
      expect(skel).toContain(cls);
    }
    // …and drops the control when chat is off, like the real header.
    expect(R.skeletonHtml('list', { rtl: true, chatEnabled: false })).not.toContain('wy-fab');
  });
});

describe('Core hands the skeleton the same facts the real render uses', () => {
  it('derives RTL from the locale, not a config key that never existed', () => {
    expect(RUNTIME_JS).not.toContain('rtl: !!(ctx.config && ctx.config.rtl)');
    const idx = RUNTIME_JS.indexOf('function skeletonFor(view)');
    expect(idx).toBeGreaterThan(-1);
    const body = RUNTIME_JS.slice(idx, idx + 900);
    expect(body).toContain("rtl: (ctx.locale || 'en').toLowerCase().split('-')[0] === 'fa'");
  });

  it('passes the composer capability set and the chat toggle', () => {
    const idx = RUNTIME_JS.indexOf('function skeletonFor(view)');
    const body = RUNTIME_JS.slice(idx, idx + 900);
    expect(body).toContain('composer: composerSkeletonCaps()');
    expect(body).toContain('chatEnabled: chatEnabled');
  });

  it('gates those capabilities on the same config the real frame reads', () => {
    const idx = RUNTIME_JS.indexOf('function composerSkeletonCaps()');
    expect(idx).toBeGreaterThan(-1);
    const body = RUNTIME_JS.slice(idx, idx + 900);
    expect(body).toContain('attachCfg.enabled === true');
    expect(body).toContain('attachCfg.voiceNotesEnabled === true && micSupported');
    expect(body).toContain('composerCfg.emojiEnabled !== false');
  });
});
