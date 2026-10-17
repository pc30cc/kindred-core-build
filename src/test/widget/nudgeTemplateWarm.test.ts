/**
 * A launcher nudge (Smart Engagement's greeting bubble) is drawn by the
 * loader before any template file is on the page. A template newer than the
 * edition's first one (`t1`, `t2`) dresses that bubble in its own
 * stylesheet, so when the bubble shows the loader warms the template the way
 * an open intent does: files load, runtime.init() still waits for an open.
 * `default` and `intl` keep exactly today's behaviour: a nudge loads nothing.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function configFor(templateId: string | undefined) {
  return {
    enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId, locale: 'fa', edition: 'iran',
    styleUrl: 'https://cdn.test/widget/runtime.0123abcd.css',
    runtimeUrl: 'https://cdn.test/widget/runtime.0123abcd.js',
    presentationRegistryUrl: 'https://cdn.test/widget/presentation-registry.0123abcd.js',
    presentationUrl: `https://cdn.test/widget/presentation-${templateId || 'default'}.0123abcd.js`,
    presentationStyleUrl: `https://cdn.test/widget/presentation-${templateId || 'default'}.0123abcd.css`,
    presentationFontsUrl: 'https://cdn.test/widget/presentation-default-fonts.0123abcd.css',
    callRuntimeUrl: 'https://cdn.test/widget/runtime-call.0123abcd.js',
    smart: {
      enabled: true,
      engineUrl: 'https://cdn.test/widget/smart-engine.0123abcd.js',
      rules: [{ id: 'r1', version: 1, priority: 1, presentation_config: { mode: 'launcher_nudge' } }],
    },
  };
}

type Held = HTMLElement & { src?: string; href?: string; rel?: string };

describe('a launcher nudge and the template files', () => {
  const appended: Held[] = [];
  const w = window as unknown as Record<string, unknown>;
  let init: ReturnType<typeof vi.fn>;

  function watch(target: Node) {
    const real = target.appendChild.bind(target);
    vi.spyOn(target, 'appendChild').mockImplementation(((node: Held) => {
      appended.push(node);
      const url = node.src || node.href || '';
      if (node.tagName === 'SCRIPT' && /smart-engine/.test(url)) {
        // The engine registers itself; every rule matches.
        w.__gs_smart_engine = {
          evaluateSmartRule: () => ({ outcome: 'matched', reasons: [] }),
          resolveSmartContent: () => ({ title: '', body: 'سلام! سؤالی دارید؟', cta_label: '' }),
          renderSmartTemplate: (s: string) => s,
        };
      }
      if ((node.tagName === 'SCRIPT' || node.tagName === 'LINK') && node.rel !== 'preconnect') {
        setTimeout(() => {
          node.dispatchEvent(new Event('load'));
          const onload = (node as unknown as { onload?: () => void }).onload;
          if (typeof onload === 'function' && node.tagName === 'SCRIPT' && /smart-engine/.test(url)) onload();
        }, 0);
      }
      return real(node);
    }) as never);
  }

  async function bootWithNudge(templateId: string | undefined) {
    w.__gs_id = WS;
    w.__gs_api_base = 'https://api.test';
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), headers: { get: () => null } });
    w.fetch = vi.fn((url: string) => (String(url).includes('/api/widget/boot')
      ? json({ session_token: 't', workspace_id: WS, protocol: 3, availability: { state: 'online' }, config: configFor(templateId) })
      : json({})));
    watch(document.head);
    new Function(LOADER).call(window);
    await tick();
    const root = document.querySelector('gs-widget')!.shadowRoot!;
    watch(root);
    w.__gs_presentation_registry = { resolve: () => ({ globalKey: '__gs_presentation_x' }) };
    w.__gs_presentation_x = { prepare: () => Promise.resolve(), create: () => ({}) };
    init = vi.fn(() => ({ open() {}, close() {}, toggle() {}, isOpen: () => false }));
    w.__gs_runtime = { init };
    await tick(20);
    return root;
  }

  // Scripts go to the document's head (watched); the stylesheets go into the
  // widget's shadow root, which exists only once the loader ran, so they are
  // read from the DOM.
  const requested = (re: RegExp) => [
    ...appended.map((n) => n.src || n.href || ''),
    ...[...(document.querySelector('gs-widget')?.shadowRoot?.querySelectorAll('link') || [])].map((l) => (l as HTMLLinkElement).href),
  ].filter((u) => re.test(u));

  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    for (const key of Object.keys(window)) if (key.indexOf('__gs') === 0) delete w[key];
    try { sessionStorage.clear(); localStorage.clear(); } catch { /* jsdom */ }
    appended.length = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['t1', 't2'])('%s: the bubble shows and the template files load, without init()', async (templateId) => {
    const root = await bootWithNudge(templateId);
    expect(root.querySelector('.smart-nudge')).not.toBeNull();
    expect(requested(new RegExp(`presentation-${templateId}\\.0123abcd\\.css$`)).length).toBeGreaterThan(0);
    expect(requested(new RegExp(`presentation-${templateId}\\.0123abcd\\.js$`)).length).toBeGreaterThan(0);
    expect(requested(/runtime\.0123abcd\.js$/).length).toBeGreaterThan(0);
    await tick(20);
    expect(init).not.toHaveBeenCalled();
  });

  it.each([['default'], ['intl'], [undefined]])('%s: the bubble shows and nothing else loads (as before)', async (templateId) => {
    const root = await bootWithNudge(templateId);
    expect(root.querySelector('.smart-nudge')).not.toBeNull();
    expect(requested(/presentation-(default|intl)\.0123abcd\.(js|css)$/)).toEqual([]);
    expect(requested(/runtime\.0123abcd\.js$/)).toEqual([]);
  });
});
