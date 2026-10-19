/**
 * Every system row in the inbox thread is a centred notice in the operator's
 * language, never an operator bubble with reply and copy.
 *
 * `routing_in_queue` had no branch of its own, so it fell through to the
 * bubble and printed the stored English body, "Your message is in the
 * support queue.", on the operator's side as if the operator had sent it —
 * in a Persian inbox too.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
}));

const { SystemNoticeRow } = await import('@/components/inbox/SystemNoticeRow');

const BUNDLES = { en, fa, tr } as unknown as Record<string, Record<string, Record<string, string>>>;
function translator(locale: 'en' | 'fa' | 'tr') {
  return (key: string) => BUNDLES[locale].inbox?.[key.replace(/^inbox\./, '')] ?? key;
}

function row(locale: 'en' | 'fa' | 'tr', body: string, meta: Record<string, unknown>) {
  return render(<SystemNoticeRow body={body} meta={meta} t={translator(locale)} />).container;
}

describe('a system row is a notice', () => {
  it('draws the queue row in the operator\'s language, not the stored English body', () => {
    const fa_ = row('fa', 'Your message is in the support queue.', { kind: 'routing_in_queue' });
    expect(fa_.querySelector('[data-inbox="system-notice"]')).not.toBeNull();
    expect(fa_.textContent).toBe('کاربر در صف پشتیبانی منتظر است');
    expect(fa_.textContent).not.toContain('support queue');
    expect(fa_.querySelector('[data-inbox="bubble"]')).toBeNull();

    const tr_ = row('tr', 'Your message is in the support queue.', { kind: 'routing_in_queue' });
    expect(tr_.textContent).toBe('Ziyaretçi destek kuyruğunda bekliyor');
  });

  it('draws a kind it does not know as a notice with the stored body', () => {
    const el = row('fa', 'Something new happened', { kind: 'something_new_next_quarter' });
    expect(el.querySelector('[data-inbox="system-notice"]')).not.toBeNull();
    expect(el.textContent).toBe('Something new happened');
    expect(el.querySelector('[data-inbox="bubble"], button')).toBeNull();
  });

  it('draws a system row without a kind as a notice too', () => {
    const el = row('en', 'Waiting in the queue for an available agent', {});
    expect(el.querySelector('[data-inbox="system-notice"]')).not.toBeNull();
    expect(el.textContent).toBe('Waiting in the queue for an available agent');
  });

  it('keeps the kinds it drew before: transfer, join, closed, call, rating', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'conversation_transferred', actor_name: 'Ali', to_name: 'Sara' }, 'Ali این گفتگو را به Sara منتقل کرد'],
      [{ kind: 'routing_agent_joined', agent_name: 'a colleague' }, 'یکی از همکاران به گفتگو پیوست'],
      [{ kind: 'conversation_closed', agent_name: 'Sara' }, 'Sara گفتگو را بست'],
      [{ kind: 'call_ended', ended_by: 'operator', duration_seconds: 72 }, 'تماس از طرف اپراتور پایان یافت · مدت مکالمه 01:12'],
      [{ kind: 'support_rating', score: 4 }, 'به این گفتگو 4 از ۵ امتیاز داد'],
    ];
    for (const [meta, text] of cases) {
      const el = row('fa', 'English body', meta);
      expect(el.querySelector('[data-inbox="system-notice"]'), String(meta.kind)).not.toBeNull();
      expect(el.textContent, String(meta.kind)).toBe(text);
    }
    const invite = row('en', 'You have been invited to a video call.', {
      kind: 'call_invitation', channel: 'video', operator_name: 'Ali', status: 'joined',
    });
    expect(invite.textContent).toBe('Ali invited the visitor to a video call· Joined');
  });
});

describe('the thread hands every system row to SystemNoticeRow', () => {
  const INBOX = readFileSync('src/pages/app/InboxPage.tsx', 'utf8');

  it('routes sender_type system to the notice before the bubble is drawn', () => {
    const guard = INBOX.indexOf("if (msg.sender_type === 'system') {");
    const notice = INBOX.indexOf('<SystemNoticeRow', guard);
    const bubble = INBOX.indexOf('data-inbox="bubble"');
    expect(guard, 'the thread has no catch-all for system rows').toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(guard);
    expect(bubble).toBeGreaterThan(notice);
    // No per-kind branch is left to forget a kind again.
    expect(INBOX).not.toMatch(/msg\.sender_type === 'system' && meta\.kind ===/);
  });
});
