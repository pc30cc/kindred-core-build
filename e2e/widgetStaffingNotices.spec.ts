/**
 * What the visitor is told when a conversation changes hands.
 *
 * A staffing notice the widget has no branch for falls through to a PLAIN
 * CHAT BUBBLE, so the visitor reads the server's internal English sentence as
 * if an operator had typed it. That is what a transfer looked like: "Ali
 * transferred this conversation to Sara", in English, in the middle of a
 * Persian conversation.
 *
 * Real browser because "it rendered as a system pill and not as a bubble" is
 * a rendering claim about the shipped runtime.
 */
import { test, expect, type Page } from '@playwright/test';
import { boot, resolveChromium, routeAll, thread, type Msg } from './harness/widgetHarness';

test.use({ launchOptions: { executablePath: resolveChromium() } });

const NOW = new Date().toISOString();

const systemMsg = (id: string, text: string, metadata: Record<string, unknown>) => ({
  id, role: 'system', sender_type: 'system', text, time: NOW, metadata,
}) as unknown as Msg;

async function openWith(page: Page, extra: Msg[]) {
  await routeAll(page, { threads: { c1: [...thread('c1').slice(0, 2), ...extra] } });
  await boot(page, { resumeCid: 'c1' });
  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { __inst: { __test: { chatState: () => { messages: unknown[] } } } })
      .__inst.__test.chatState().messages.length), { timeout: 15_000 }).toBeGreaterThan(1);
  await page.waitForTimeout(400);
}

/** Every rendered row, tagged by whether it is a system pill or a bubble. */
const rows = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('.msg-row')).map((el) => ({
    isSystem: el.classList.contains('system'),
    isBubble: !el.classList.contains('system'),
    text: (el.textContent || '').trim(),
  })));

test('a transfer reads as the next operator arriving', async ({ page }) => {
  await openWith(page, [systemMsg(
    'xfer', 'Ali transferred this conversation to Sara',
    { kind: 'conversation_transferred', actor_name: 'Ali', to_name: 'Sara' },
  )]);

  const all = await rows(page);
  const notice = all.find((r) => r.text.includes('Sara'));
  expect(notice, 'the transfer must be rendered').toBeTruthy();
  // A pill, not a bubble — and naming who is here now, not who moved it.
  expect(notice!.isSystem).toBe(true);
  expect(notice!.text).not.toContain('transferred');
  expect(notice!.text).not.toContain('Ali');
  // No row anywhere may show the server's raw English sentence.
  expect(all.some((r) => r.text.includes('transferred this conversation'))).toBe(false);
});

test('an auto-routed join reads the same way', async ({ page }) => {
  await openWith(page, [systemMsg(
    'join', 'Sara joined the conversation.',
    { kind: 'routing_agent_joined', agent_name: 'Sara' },
  )]);

  const notice = (await rows(page)).find((r) => r.text.includes('Sara'));
  expect(notice!.isSystem).toBe(true);
  expect(notice!.text).not.toContain('joined the conversation.');
});

test('both paths produce the identical sentence', async ({ page }) => {
  // A transfer and an auto-route are one event to the visitor, so they must
  // not be worded two different ways.
  await openWith(page, [
    systemMsg('join', 'Sara joined the conversation.',
      { kind: 'routing_agent_joined', agent_name: 'Sara' }),
    systemMsg('xfer', 'Ali transferred this conversation to Sara',
      { kind: 'conversation_transferred', actor_name: 'Ali', to_name: 'Sara' }),
  ]);

  const notices = (await rows(page)).filter((r) => r.isSystem && r.text.includes('Sara'));
  expect(notices).toHaveLength(2);
  expect(notices[0].text).toBe(notices[1].text);
});
