/**
 * A system row previews in the visitor's language on the home view (owner,
 * 2026-10-18: «پیام شما در صف پشتیبانی قرار گرفت» read right in the thread
 * but in English on t2's home "continue" row, Persian widget, iPhone).
 *
 * GET /api/widget/conversations says which system row a thread ends with
 * (`systemKind`, `systemMeta`; server/routes/widget.ts) next to the stored
 * English body (`preview`, for runtimes loaded before it); Core writes the
 * sentence (runtime.js systemRowText) and every template draws Core's text.
 *
 * Real browser, the template screenshot harness (e2e/harness/templateScreens.ts)
 * with this file's own states. Its list route answers a fixed set of fields,
 * so each state answers the list itself (a route registered later answers
 * first) and has Core read it again.
 *
 * SYSTEM_PREVIEW_OUT=<folder> keeps the PNGs there.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCREEN_STATES, renderTemplateScreens } from './harness/templateScreens';

type Row = Record<string, unknown> & { id: string; status: string; preview: string; unreadCount: number };

const RETURNING = { identity_state: 'identified', contact: { name: 'علی رضایی', email: 'ali@example.com' } };

/** The owner's case: the queue notice, the newest row of the open thread. */
const QUEUE: Row = {
  id: 'c-live', status: 'open', preview: 'Your message is in the support queue.',
  systemKind: 'routing_in_queue', systemMeta: {}, unreadCount: 1, operatorName: null,
};
/** A transfer: the visitor reads the next person arriving, never who moved it. */
const TRANSFER: Row = {
  id: 'c-live', status: 'open', preview: 'Ali transferred this conversation to Sara',
  systemKind: 'conversation_transferred', systemMeta: { to_name: 'Sara' }, unreadCount: 1, operatorName: null,
};

function listAnswer(row: Row) {
  const at = new Date(Date.now() - 3 * 60_000).toISOString();
  return {
    conversations: [{
      outbound: false, attachmentKind: null, operatorAvatar: null, operatorOnline: false,
      ...row, updatedAt: at, lastMessageAt: at,
    }],
  };
}

/** A home state whose thread list ends with `row`, exactly as the server sends it. */
function homeWith(name: string, row: Row) {
  SCREEN_STATES[name] = {
    home: true,
    setup: (f) => {
      f.identity = RETURNING;
      f.conversations = [{ ...row, lastMessageAt: new Date(Date.now() - 3 * 60_000).toISOString() }];
    },
    drive: async ({ page }) => {
      await page.route(
        (url) => url.pathname.endsWith('/api/widget/conversations'),
        (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listAnswer(row)) }),
      );
      await page.evaluate(() => {
        const w = window as unknown as { __inst: { __test: { retryConversations: () => void } } };
        w.__inst.__test.retryConversations();
      });
    },
  };
}

homeWith('l10n-home-queue', QUEUE);
homeWith('l10n-home-transfer', TRANSFER);

/** The "continue" row of t2's home, t1's recent card, default's recent row. */
const ROW_SELECTOR: Record<string, string> = {
  t2: '.wy-view [data-conversation-open="c-live"]',
  t1: '.cd.rc[data-conversation-open="c-live"]',
  default: '.conv-preview',
};

interface Case {
  templateId: 't2' | 't1' | 'default';
  locale: 'fa' | 'en' | 'tr';
  edition: 'iran' | 'international';
  state: string;
  has: string;
  hasNot: string[];
}

const CASES: Case[] = [
  // The reported case: t2, Persian, WebYar.
  { templateId: 't2', locale: 'fa', edition: 'iran', state: 'l10n-home-queue', has: 'پیام شما در صف پشتیبانی قرار گرفت.', hasNot: ['support queue'] },
  { templateId: 't2', locale: 'tr', edition: 'international', state: 'l10n-home-queue', has: 'Mesajınız destek kuyruğuna alındı.', hasNot: ['support queue'] },
  { templateId: 't2', locale: 'en', edition: 'international', state: 'l10n-home-transfer', has: 'Sara joined the conversation', hasNot: ['transferred', 'Ali'] },
  // Every template draws Core's text.
  { templateId: 'default', locale: 'fa', edition: 'iran', state: 'l10n-home-queue', has: 'پیام شما در صف پشتیبانی قرار گرفت.', hasNot: ['support queue'] },
  { templateId: 't1', locale: 'fa', edition: 'iran', state: 'l10n-home-queue', has: 'پیام شما در صف پشتیبانی قرار گرفت.', hasNot: ['support queue'] },
];

async function rowText(page: Page, templateId: string): Promise<string> {
  const row = page.locator(ROW_SELECTOR[templateId]).first();
  return (await row.textContent({ timeout: 1_000 }).catch(() => null)) || '';
}

for (const c of CASES) {
  test(`${c.templateId} · ${c.locale}: the home row reads «${c.has}»`, async () => {
    test.setTimeout(120_000);
    const keep = process.env.SYSTEM_PREVIEW_OUT;
    const out = keep ? path.resolve(keep, `${c.locale}-${c.edition}`) : mkdtempSync(path.join(os.tmpdir(), `system-preview-${c.templateId}-`));
    const seen: string[] = [];
    try {
      const files = await renderTemplateScreens({
        templateId: c.templateId,
        locale: c.locale,
        edition: c.edition,
        states: [c.state],
        outDir: out,
        beforeShot: async (page) => {
          await expect.poll(() => rowText(page, c.templateId), { timeout: 20_000 }).toContain(c.has);
          const text = await rowText(page, c.templateId);
          for (const word of c.hasNot) expect(text).not.toContain(word);
          seen.push(text);
        },
      });
      expect(files.map((f) => path.basename(f))).toEqual([`${c.templateId}--${c.state}.png`]);
      expect(seen).toHaveLength(1);
    } finally {
      if (!keep) rmSync(out, { recursive: true, force: true });
    }
  });
}
