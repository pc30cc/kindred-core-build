import { createHash, randomUUID } from 'node:crypto';
import type { Page, Locator } from '@playwright/test';
import type { BridgeIdentity, BridgeProvider, BridgeSelectors } from '../../shared/widgetBridge.js';

export interface RemoteMessage { key: string; body: string }
export interface BridgeAdapter {
  prepare(identity: BridgeIdentity): Promise<void>;
  send(body: string): Promise<boolean>;
  receive(): Promise<RemoteMessage[]>;
  acknowledge?(count: number): void;
}

export function messageKeys(messages: Array<{ id: string | null; body: string }>): RemoteMessage[] {
  const occurrences = new Map<string, number>();
  const result = messages.filter(m => m.body.trim()).map(m => {
    const body = m.body.trim().slice(0, 4000);
    const hash = createHash('sha256').update(body).digest('hex');
    const count = (occurrences.get(hash) || 0) + 1; occurrences.set(hash, count);
    // Prefer stable provider IDs. Repeated identical replies are distinct.
    return { key: m.id ? `id:${m.id.slice(0, 200)}` : `dom:${hash}:${count}`, body };
  });
  return [...new Map(result.map(message => [message.key, message])).values()];
}

const webyar: BridgeSelectors = {
  root: '.shell', launcher: '.launcher', start: '[data-home-action="chat"]',
  name: '[data-prechat="name"]', email: '[data-prechat="email"]', phone: '[data-prechat="phone"]',
  formSubmit: '[data-prechat-submit]', composer: '[data-msg-input]', send: '[data-send-btn]',
  inbound: '.msg-row.operator:not(.ai-thinking-row) .msg-text',
  outbound: '.msg-row.visitor .msg-text',
};

/** A scoped DOM adapter never clicks/fills unrelated forms on the site. */
export class DomAdapter implements BridgeAdapter {
  constructor(private readonly page: Page, private readonly selectors: BridgeSelectors) {}
  private async root(): Promise<Locator> {
    if (this.selectors.frame) {
      const root = this.page.frameLocator(this.selectors.frame).locator(this.selectors.root || 'body');
      await root.first().waitFor({ state: 'visible', timeout: 15000 });
      if (await root.count() !== 1) throw new Error('ambiguous_widget');
      return root;
    }
    // Locator CSS pierces open shadow DOM. A WebYar widget can also be
    // embedded in an iframe; do not assume it is in the top document.
    for (const frame of this.page.frames()) {
      const root = frame.locator(this.selectors.root!);
      if (await root.count() === 1 && await root.isVisible()) return root;
    }
    throw new Error('widget_not_found');
  }
  private async optionalClick(root: Locator, selector?: string) {
    if (!selector) return;
    const button = root.locator(selector);
    if (await button.count() === 1 && await button.isVisible()) await button.click({ timeout: 5000 });
  }
  async prepare(identity: BridgeIdentity) {
    const root = await this.root();
    if (!(await root.locator(this.selectors.composer!).isVisible().catch(() => false))) {
      await this.optionalClick(root, this.selectors.launcher);
      await this.optionalClick(root, this.selectors.start);
    }
    for (const key of ['name', 'email', 'phone'] as const) {
      const selector = this.selectors[key];
      if (!selector) continue;
      const field = root.locator(selector);
      if (await field.count() === 1 && await field.isVisible()) {
        if (!identity[key]) {
          if (await field.getAttribute('required') !== null || await field.getAttribute('aria-required') === 'true') {
            throw new Error('identity_required');
          }
          continue;
        }
        await field.fill(identity[key], { timeout: 5000 });
      }
    }
    await this.optionalClick(root, this.selectors.formSubmit);
    const composer = root.locator(this.selectors.composer!);
    try { await composer.waitFor({ state: 'visible', timeout: 15000 }); }
    catch { throw new Error('composer_unavailable'); }
    if (await composer.count() !== 1 || !await composer.isEditable()) throw new Error('composer_unavailable');
  }
  async send(body: string): Promise<boolean> {
    const root = await this.root();
    const composer = root.locator(this.selectors.composer!);
    const outbound = root.locator(this.selectors.outbound!);
    const before = await outbound.count();
    await composer.fill(body, { timeout: 5000 });
    if (this.selectors.send) {
      const send = root.locator(this.selectors.send);
      if (await send.count() !== 1 || !await send.isEnabled()) throw new Error('send_unavailable');
      await send.click({ timeout: 5000 });
    } else { await composer.press('Enter', { timeout: 5000 }); }
    // Require a new outgoing bubble; filling the composer alone is not a
    // successful send. Provider acknowledgement is stronger where available.
    for (let i = 0; i < 20; i++) {
      const texts = await outbound.allTextContents();
      if (texts.length > before && texts.slice(before).some(text => text.trim() === body)) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }
  async receive() {
    const root = await this.root();
    const messages = await root.locator(this.selectors.inbound!).evaluateAll((nodes, idAttr) => nodes.map(node => {
      const row = node.closest('.msg-row') || node;
      const id = idAttr ? row.getAttribute(idAttr) || node.getAttribute(idAttr)
        : row.getAttribute('data-message-id') || row.querySelector('[data-msg-reply]')?.getAttribute('data-msg-reply') || null;
      // WebYar's copy action holds the entire text while its typing animation
      // still displays only part. Do not save every animation frame as a reply.
      const body = row.querySelector('[data-msg-copy]')?.getAttribute('data-msg-copy') || node.textContent || '';
      return { id, body };
    }), this.selectors.messageIdAttribute || null);
    return messageKeys(messages);
  }
}

export class WebyarAdapter extends DomAdapter {
  constructor(private readonly widgetPage: Page, selectors: BridgeSelectors) { super(widgetPage, selectors); }
  override async send(body: string) {
    // WebYar paints optimistic bubbles BEFORE the HTTP result. Wait for its
    // actual message id so a failed network send is never labelled sent.
    const receipt = this.widgetPage.waitForResponse(response => {
      try {
        return new URL(response.url()).pathname === '/api/widget/message'
          && response.request().method() === 'POST'
          && response.request().postDataJSON()?.message === body;
      } catch { return false; }
    }, { timeout: 10000 }).then(async response => {
      if (!response.ok()) return false;
      const data = await response.json();
      return typeof data.message_id === 'string' && data.message_id.length > 0;
    }).catch(() => false);
    await super.send(body);
    return receipt;
  }
}

/** Crisp's published SDK gives visitor sends and operator reply events. */
export class CrispAdapter implements BridgeAdapter {
  private messages: RemoteMessage[] = [];
  private sent = new Map<string, number>();
  private installed = false;
  constructor(private readonly page: Page) {}
  async prepare(identity: BridgeIdentity) {
    await this.page.waitForFunction(() => Boolean((globalThis as unknown as { $crisp?: { get?: unknown } }).$crisp?.get), undefined, { timeout: 15000 });
    if (!this.installed) {
      await this.page.exposeFunction('__bridgeCrispEvent', (kind: string, data: Record<string, unknown>) => {
        if (data.type !== 'text' || typeof data.content !== 'string') return;
        if (kind === 'sent') this.sent.set(data.content, (this.sent.get(data.content) || 0) + 1);
        else {
          const id = data.fingerprint ?? data.timestamp;
          if (id === undefined) return; // never invent an id that duplicates after reconnect
          this.messages.push({ key: `crisp:${String(id).slice(0, 200)}`, body: data.content.trim().slice(0, 4000) });
        }
      });
      await this.page.evaluate(() => {
        const win = globalThis as unknown as { $crisp: { push(value: unknown[]): void }; __bridgeCrispEvent(kind: string, data: unknown): void };
        win.$crisp.push(['on', 'message:received', (data: unknown) => win.__bridgeCrispEvent('received', data)]);
        win.$crisp.push(['on', 'message:sent', (data: unknown) => win.__bridgeCrispEvent('sent', data)]);
      });
      this.installed = true;
    }
    await this.page.evaluate(identity => {
      const crisp = (globalThis as unknown as { $crisp: { push(value: unknown[]): void } }).$crisp;
      crisp.push(['set', 'user:nickname', [identity.name]]);
      if (identity.email) crisp.push(['set', 'user:email', [identity.email]]);
      if (identity.phone) crisp.push(['set', 'user:phone', [identity.phone]]);
      crisp.push(['do', 'chat:open']);
    }, identity);
  }
  async send(body: string) {
    const before = this.sent.get(body) || 0;
    await this.page.evaluate(body => {
      (globalThis as unknown as { $crisp: { push(value: unknown[]): void } }).$crisp.push(['do', 'message:send', ['text', body]]);
    }, body);
    for (let i = 0; i < 20; i++) {
      if ((this.sent.get(body) || 0) > before) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }
  async receive() { return this.messages.slice(0, 200); }
  acknowledge(count: number) { this.messages.splice(0, count); }
}

/** Current Raychat visitor SDK; never use its display-only offline method. */
export class RaychatAdapter implements BridgeAdapter {
  private messages: RemoteMessage[] = [];
  private sent = new Map<string, number>();
  private installed = false;
  constructor(private readonly page: Page) {}
  async prepare(identity: BridgeIdentity) {
    await this.page.waitForFunction(() => {
      const sdk = (globalThis as unknown as { Raychat?: { sendMessage?: unknown; on?: unknown } }).Raychat;
      return typeof sdk?.sendMessage === 'function' && typeof sdk?.on === 'function';
    }, undefined, { timeout: 15000 });
    if (!this.installed) {
      await this.page.exposeFunction('__bridgeRaychatEvent', (kind: string, data: Record<string, unknown>) => {
        if (data.type !== 'text' || typeof data.content !== 'string') return;
        if (kind === 'sent') this.sent.set(data.content, (this.sent.get(data.content) || 0) + 1);
        else {
          const id = data.id ?? data._id ?? data.messageId ?? data.timestamp ?? randomUUID();
          this.messages.push({ key: `raychat:${String(id).slice(0, 200)}`, body: data.content.trim().slice(0, 4000) });
        }
      });
      await this.page.evaluate(() => {
        const win = globalThis as unknown as { Raychat: { on(event: string, fn: (event: { detail: Record<string, unknown> }) => void): void }; __bridgeRaychatEvent(kind: string, data: unknown): void };
        win.Raychat.on('raychat_getMessage', event => win.__bridgeRaychatEvent('received', event.detail));
        win.Raychat.on('raychat_sendMessage', event => win.__bridgeRaychatEvent('sent', event.detail));
      });
      this.installed = true;
    }
    await this.page.evaluate(identity => {
      const sdk = (globalThis as unknown as { Raychat: { setUser(identity: unknown): void; openWidget(): void } }).Raychat;
      sdk.setUser({ ...identity, updateOnce: false }); sdk.openWidget();
    }, identity);
  }
  async send(body: string) {
    const before = this.sent.get(body) || 0;
    const accepted = await this.page.evaluate(body => {
      const sdk = (globalThis as unknown as { Raychat: { sendMessage(body: string): { success?: boolean } } }).Raychat;
      return sdk.sendMessage(body)?.success === true;
    }, body);
    if (!accepted) return false;
    for (let i = 0; i < 20; i++) {
      if ((this.sent.get(body) || 0) > before) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }
  async receive() { return this.messages.slice(0, 200); }
  acknowledge(count: number) { this.messages.splice(0, count); }
}

/** Goftino.sendMessage is display-only. Submit through its visitor form. */
export class GoftinoAdapter implements BridgeAdapter {
  private messages: RemoteMessage[] = [];
  private sent = new Map<string, number>();
  private installed = false;
  private readonly selectors: BridgeSelectors;
  constructor(private readonly page: Page, selectors: BridgeSelectors = {}) {
    this.selectors = {
      frame: '#goftino_w', root: 'body', launcher: '#box-widget-icon',
      composer: '#box-send textarea#m', send: '#box-send .fix-content .btn-send',
      ...selectors,
    };
  }
  async prepare(identity: BridgeIdentity) {
    await this.page.waitForFunction(() => {
      const sdk = (globalThis as unknown as { Goftino?: { open?: unknown; setUser?: unknown } }).Goftino;
      return typeof sdk?.open === 'function' && typeof sdk?.setUser === 'function';
    }, undefined, { timeout: 15000 });
    if (!this.installed) {
      await this.page.exposeFunction('__bridgeGoftinoEvent', (kind: string, data: Record<string, unknown>) => {
        if (data.type !== 'text' || typeof data.content !== 'string' || !data.content.trim()) return;
        if (kind === 'sent') this.sent.set(data.content, (this.sent.get(data.content) || 0) + 1);
        else {
          // Published events do not promise message IDs or offline history.
          const id = data.id ?? data.messageId ?? randomUUID();
          this.messages.push({ key: `goftino:${String(id).slice(0, 200)}`, body: data.content.trim().slice(0, 4000) });
        }
      });
      await this.page.evaluate(() => {
        const win = globalThis as unknown as {
          addEventListener(event: string, callback: (event: { detail: unknown }) => void): void;
          __bridgeGoftinoEvent(kind: string, data: unknown): void;
        };
        win.addEventListener('goftino_sendMessage', event => win.__bridgeGoftinoEvent('sent', event.detail));
        win.addEventListener('goftino_getMessage', event => win.__bridgeGoftinoEvent('received', event.detail));
      });
      this.installed = true;
    }
    await this.page.evaluate(identity => {
      const sdk = (globalThis as unknown as { Goftino: { setUser(value: unknown): void; open(): void } }).Goftino;
      sdk.setUser({ ...identity, forceUpdate: true }); sdk.open();
    }, identity);
    await new DomAdapter(this.page, this.selectors).prepare(identity);
  }
  async send(body: string) {
    const root = this.page.frameLocator(this.selectors.frame!).locator(this.selectors.root!);
    const composer = root.locator(this.selectors.composer!);
    if (await root.count() !== 1 || await composer.count() !== 1 || !await composer.isEditable()) throw new Error('composer_unavailable');
    const limit = Number(await composer.getAttribute('maxlength'));
    if (limit > 0 && body.length > limit) throw new Error('message_too_long');
    const before = this.sent.get(body) || 0;
    await composer.fill(body, { timeout: 5000 });
    if (this.selectors.send) {
      const send = root.locator(this.selectors.send);
      if (await send.count() !== 1 || !await send.isEnabled()) throw new Error('send_unavailable');
      await send.click({ timeout: 5000 });
    } else { await composer.press('Enter', { timeout: 5000 }); }
    // A bubble alone may be optimistic. Require the visitor-send event,
    // matching this message; incoming events never confirm an outbound send.
    for (let i = 0; i < 20; i++) {
      if ((this.sent.get(body) || 0) > before) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }
  async receive() { return this.messages.slice(0, 200); }
  acknowledge(count: number) { this.messages.splice(0, count); }
}

export async function makeAdapter(page: Page, provider: BridgeProvider, selectors: BridgeSelectors): Promise<BridgeAdapter> {
  if (provider === 'custom') return new DomAdapter(page, selectors);
  // Wait for lazy-loaded widgets instead of reporting unsupported while the
  // site's initial HTML is still being rendered.
  for (let i = 0; i < 30; i++) {
    if ((provider === 'auto' || provider === 'goftino') && await page.evaluate(() => {
      const sdk = (globalThis as unknown as { Goftino?: { open?: unknown } }).Goftino;
      return typeof sdk?.open === 'function';
    }) && await page.locator(selectors.frame || '#goftino_w').count() === 1) return new GoftinoAdapter(page, selectors);
    if ((provider === 'auto' || provider === 'raychat') && await page.evaluate(() => {
      const sdk = (globalThis as unknown as { Raychat?: { sendMessage?: unknown } }).Raychat;
      return typeof sdk?.sendMessage === 'function';
    })) return new RaychatAdapter(page);
    if ((provider === 'auto' || provider === 'crisp') && await page.evaluate(() => Boolean((globalThis as unknown as { $crisp?: unknown }).$crisp))) {
      return new CrispAdapter(page);
    }
    if (provider === 'auto' || provider === 'webyar') {
      for (const frame of page.frames()) {
        if (await frame.locator('.shell [data-home-action="chat"], .shell [data-msg-input], .shell .launcher').count()) {
          return new WebyarAdapter(page, { ...webyar, ...selectors });
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('unsupported_widget');
}
