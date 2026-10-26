/**
 * The owner's rule (2026-10-24): in the chat widget an operator or a team
 * member without a photo is the person silhouette, and the workspace without
 * a logo is its storefront, never a letter; the AI without a logo of its own
 * speaks under the workspace's storefront (never a person). The renderers
 * emit the avatar tile empty and the stylesheets draw the glyph as a mask of
 * the tile's ink (Core's runtime.css holds the two glyphs once).
 *
 *  1. Every copy of a glyph in a widget stylesheet is the platform's
 *     (shared/avatarGlyphs.ts), and every template draws both.
 *  2. The guard: every template, booted on the shipped runtime with a team
 *     without photos, a workspace without a logo, operators' and an AI's
 *     messages, the thread list, an article's author and Core's own smart
 *     row, draws no letter in any avatar.
 *
 * The call widget's side: src/test/callWidget/callWidgetAvatarGlyphs.test.ts.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PERSON_SILHOUETTE, WORKSPACE_MARK, glyphDataUri } from '../../../shared/avatarGlyphs';
import { LAUNCHER_AVATAR, LAUNCHER_GLYPHS } from '../../../shared/launcherStyles';
import { CHAT_WIDGET_TEMPLATES } from '../../../shared/widgetTemplates';
import { avatarFace } from './avatarFace';
import { boot, flush, resetWindow, type Harness } from './coreFeaturesHarness';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
/** A custom property's url() value in a stylesheet. */
const urlOf = (css: string, prop: string) => {
  const m = new RegExp(`${prop.replace(/-/g, '\\-')}:\\s*url\\("([^"]+)"\\)`).exec(css);
  return m ? m[1] : null;
};

describe('the glyphs: one design, every copy the platform\'s', () => {
  it('the paths: one filled path each in a 24-unit box, no letter, no stroke, no reference', () => {
    for (const d of [PERSON_SILHOUETTE, WORKSPACE_MARK]) {
      expect(d).toMatch(/^M[0-9.\s,a-zA-Z-]+z$/);
      // Every coordinate inside the 24-unit box (absolute commands' numbers stay within 0..24).
      for (const n of d.match(/-?\d*\.?\d+/g)!.map(Number)) expect(Math.abs(n)).toBeLessThanOrEqual(24);
    }
    expect(glyphDataUri(PERSON_SILHOUETTE)).not.toMatch(/https?:\/\//);
    expect(glyphDataUri(WORKSPACE_MARK, '#57309A')).toContain("fill='%2357309A'");
  });

  it('Core\'s runtime.css holds both, as masks, for every chat template (and the operator preview\'s frame)', () => {
    const css = read('public/widget/runtime.css');
    expect(urlOf(css, '--wy-person')).toBe(glyphDataUri(PERSON_SILHOUETTE));
    expect(urlOf(css, '--wy-workspace')).toBe(glyphDataUri(WORKSPACE_MARK));
    expect(css).toMatch(/:host, :root \{\s*(?:\/\*[\s\S]*?\*\/\s*)?--wy-person:/);
  });

  it('the launcher\'s agent face is the silhouette in the disc\'s ink (runtime-fab.css, LAUNCHER_GLYPHS.face)', () => {
    const css = read('public/widget/runtime-fab.css');
    expect(LAUNCHER_GLYPHS.face).toBe(PERSON_SILHOUETTE);
    const face = /\.launcher\.fx-avatar::before \{([^}]+)\}/.exec(css)![1];
    const uri = /url\("([^"]+)"\)/.exec(face)![1];
    expect(decodeURIComponent(uri)).toContain(`fill='${LAUNCHER_AVATAR.ink}'`);
    expect(decodeURIComponent(uri)).toContain(`d='${PERSON_SILHOUETTE}'`);
    expect(face).not.toMatch(/attr\(/);
  });

  it('the call widget: the person in runtime.css, the storefront in the panel\'s stylesheet', () => {
    expect(urlOf(read('public/call-widget/runtime.css'), '--ccw-person')).toBe(glyphDataUri(PERSON_SILHOUETTE));
    expect(urlOf(read('public/call-widget/presentation-default-panel.css'), '--g')).toBe(glyphDataUri(WORKSPACE_MARK));
  });

  // Each template's stylesheet paints both glyphs from Core's variables, as a
  // mask with its -webkit- twin (Safari before 15.4, in-app WebViews).
  const styles = [...new Set(Object.values(CHAT_WIDGET_TEMPLATES).map((t) => t.style))];
  for (const style of styles) {
    it(`${style}: draws the silhouette and the storefront in the tile's ink, as masks`, () => {
      const css = read(`public/widget/${style}`);
      for (const v of ['--wy-person', '--wy-workspace']) {
        expect(css, v).toMatch(new RegExp(`-webkit-mask(?:-image)?: var\\(${v}\\)`));
        expect(css, v).toMatch(new RegExp(`(?<!-webkit-)mask(?:-image)?: var\\(${v}\\)`));
      }
      expect(css).toContain('background: currentColor;');
      // No letter left to size: the glyph replaced it.
      expect(css).not.toMatch(/\.wy-avatar \{[^}]*font-size/);
    });
  }
});

// ─── The guard ─────────────────────────────────────────────────────────────

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

const NOW = new Date().toISOString();
/** Every avatar tile a chat template draws (a run's spacer is no avatar). */
const AVATARS = '.av, .logo, .wy-avatar, .msg-avatar:not(.msg-avatar-spacer), .home-stack-item';
const ARTICLE = { id: 'a1', title: 'چطور سفارشم را پیگیری کنم؟', slug: 'track', content: '<p>یک دو سه</p>', updated_at: '2026-10-01T00:00:00Z', category_id: null, author_name: 'Sara Ahmadi' };
const HISTORY = [
  { id: 'v1', role: 'visitor', sender_type: 'contact', text: 'سلام', time: NOW, conversation_id: 'c1' },
  { id: 'o1', role: 'agent', sender_type: 'agent', sender_name: 'Sara Ahmadi', sender_avatar: null, text: 'سلام، بفرمایید', time: NOW, conversation_id: 'c1' },
  { id: 'o2', role: 'agent', sender_type: 'agent', sender_name: 'مهدی', sender_avatar: null, text: 'من هم هستم', time: NOW, conversation_id: 'c1' },
  {
    id: 'a1', role: 'agent', sender_type: 'ai', sender_name: 'Nilu', sender_avatar: null, text: 'پاسخ هوش مصنوعی', time: NOW, conversation_id: 'c1',
    metadata: { source: 'ai_agent', agent_name: 'Nilu' },
  },
];
const preload = (t: 't1' | 't2') => {
  new Function(read(`public/widget/presentation-${t}-x.js`)).call(window);
  new Function(read('public/widget/runtime-late.js')).call(window);
};

/** What each avatar on screen shows, with where it was seen. */
function faces(h: Harness, where: string) {
  return Array.from(h.shadow.querySelectorAll(AVATARS)).map((el) => ({ where, cls: el.className, face: avatarFace(el) }));
}

describe('the guard: no template ever draws a letter for a person or the workspace', () => {
  for (const renderer of ['default', 't1', 't2'] as const) {
    it(`${renderer}: home, the thread list, a thread (operators, the AI), an article's author and Core's smart row`, async () => {
      if (renderer !== 'default') preload(renderer);
      const config = {
        // Latin and Persian names, no photo, no logo; the AI named by the owner, no logo.
        teamMembers: [{ name: 'Sara Ahmadi', avatar: null, online: true }, { name: 'مهدی', avatar: null, online: true }, { name: 'Reza', avatar: null, online: false }],
        logoUrl: null,
        workspaceName: 'Nilufar Store',
        aiAgent: { visitorFacing: false, providerReady: false, introCapable: false, agentName: 'Nilu' },
      };
      const seen: Array<{ where: string; cls: string; face: string | null }> = [];
      const h = boot({
        renderer,
        config,
        conversations: [{ id: 'c1', operatorName: 'Sara Ahmadi', operatorOnline: true }, { id: 'c2', status: 'resolved' }],
        history: { c1: HISTORY, c2: [] },
        kb: { article: ARTICLE },
      });
      await flush(40);
      seen.push(...faces(h, 'home'));
      h.runtime.setTab('list');
      await flush(20);
      seen.push(...faces(h, 'list'));
      h.runtime.__test.openConversation('c1');
      await vi.waitFor(() => expect(h.shadow.querySelectorAll('[data-chat-messages] .msg-row.operator').length).toBeGreaterThan(1));
      await flush(10);
      seen.push(...faces(h, 'thread'));
      // The AI's run wears the workspace's tile (c4), never a person's.
      const ai = Array.from(h.shadow.querySelectorAll('[data-chat-messages] .msg-row.operator'))
        .find((row) => row.querySelector('.msg-ai-badge'));
      expect(ai, 'the AI run').toBeTruthy();
      const aiFace = avatarFace(ai!.querySelector('.msg-avatar:not(.msg-avatar-spacer)'));
      // `default` draws no avatar layer for a sender without a photo (as before).
      expect(aiFace).toBe(renderer === 'default' ? null : 'workspace');
      h.runtime.setTab('help', 'track');
      await flush(30);
      seen.push(...faces(h, 'article'));

      // Core's own row (a smart rule's message inside the chat), in a fresh panel.
      resetWindow();
      if (renderer !== 'default') preload(renderer);
      const s = boot({ renderer, config });
      await flush(40);
      s.runtime.__test.setConnectionState('online');
      (s.runtime as unknown as { showSmart: (x: unknown) => boolean }).showSmart({ id: 'r1', mode: 'chat_message', body: 'سلام!', dismissible: true, onDismiss() {}, onCta() {} });
      await flush(10);
      const smart = s.shadow.querySelector('.smart-msg-row .msg-avatar');
      expect(smart, 'the smart row draws its avatar').not.toBeNull();
      seen.push({ where: 'smart', cls: smart!.className, face: avatarFace(smart) });

      // Never a letter: each tile is a photo, the silhouette or the storefront.
      const letters = seen.filter((x) => !['person', 'workspace', 'photo'].includes(String(x.face)));
      expect(letters, JSON.stringify(letters)).toEqual([]);
      const kinds = new Set(seen.map((x) => x.face));
      expect(kinds.has('workspace'), `${renderer}: the workspace's storefront is drawn somewhere`).toBe(true);
      expect(kinds.has('person'), `${renderer}: a person's silhouette is drawn somewhere`).toBe(true);
      expect(smart!.classList.contains('c1')).toBe(true);
    });
  }

  // The rating card after a close (Core's `view.csat`): t1's and t2's ask
  // about a person (their photo or the silhouette) or, for a conversation
  // only the AI answered, about nobody (the workspace's storefront);
  // default's quiet card has no face at all.
  for (const renderer of ['default', 't1', 't2'] as const) {
    it(`${renderer}: the rating card's face is the silhouette for the operator, the storefront for the AI's chat, never a letter`, async () => {
      const line = {
        id: 'cl1', role: 'system', sender_type: 'system', text: 'The conversation was closed', time: NOW, conversation_id: 'c1',
        metadata: { kind: 'conversation_closed', by: 'system', closed_reason: 'inactivity', agent_name: null, operator_name: 'Sara Ahmadi', status: 'closed' },
      };
      const seen: Array<{ subject: string; face: string | null }> = [];
      for (const subject of ['operator', 'ai'] as const) {
        resetWindow();
        if (renderer !== 'default') preload(renderer);
        const h = boot({
          renderer,
          config: { logoUrl: null, workspaceName: 'Nilufar Store' },
          conversations: [{ id: 'c1', status: 'closed', unreadCount: 1, unreadReplies: 1 }],
          history: { c1: [HISTORY[0], HISTORY[1], line] },
          api: (u) => (u.includes('/csat') ? {
            body: { closed_id: 'cl1', rateable: true, rating: null, subject, operator: subject === 'ai' ? null : { name: 'Sara Ahmadi', avatar: null } },
          } : undefined),
        });
        await flush(40);
        h.runtime.__test.openConversation('c1');
        await vi.waitFor(() => expect(h.shadow.querySelector('[data-csat]')).not.toBeNull());
        const card = h.shadow.querySelector('[data-csat]')!;
        const tiles = Array.from(card.querySelectorAll(AVATARS));
        if (renderer === 'default') { expect(tiles).toEqual([]); continue; }
        expect(tiles).toHaveLength(1);
        expect(tiles[0].textContent).toBe('');
        seen.push({ subject, face: avatarFace(tiles[0]) });
      }
      if (renderer !== 'default') expect(seen).toEqual([{ subject: 'operator', face: 'person' }, { subject: 'ai', face: 'workspace' }]);
    });
  }

  it('Core\'s smart row with no team: the workspace\'s storefront', async () => {
    const s = boot({ renderer: 't2', config: { teamMembers: [], logoUrl: null } });
    await flush(40);
    s.runtime.__test.setConnectionState('online');
    (s.runtime as unknown as { showSmart: (x: unknown) => boolean }).showSmart({ id: 'r1', mode: 'chat_message', body: 'سلام!', dismissible: true, onDismiss() {}, onCta() {} });
    await flush(10);
    const smart = s.shadow.querySelector('.smart-msg-row .msg-avatar')!;
    expect(smart.className).toContain('c4');
    expect(avatarFace(smart)).toBe('workspace');
  });
});
