/**
 * What the visitor sees of a system row (I-12), content kept as written in
 * the Persian panel (I-04), and the Inbox's last English labels (I-13).
 *
 * I-12 — internal notices (an unassign, a support rating) and the ones the
 * visitor also receives were drawn alike; a transfer reads «X گفتگو را به Y
 * منتقل کرد» for the team but «Y به گفتگو پیوست» for the visitor.
 *
 * I-04 — the Persian panel rewrote every Latin digit on the page into
 * Persian ones, message bodies too: an order code «A1234» read «A۱۲۳۴» and
 * copied that way into a shop's admin, where it matched nothing. What people
 * wrote stays as written; the conversion is for the interface only.
 *
 * I-13 — the audio player, image viewer and call controls had English
 * accessible names in every panel.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import { installPersianDigits, uninstallPersianDigits } from '@/lib/persian-digits';

function bundleT(bundle: unknown) {
  return (path: string): string => {
    const keys = path.split('.');
    let current: unknown = bundle;
    for (let i = 0; i < keys.length; i += 1) {
      if (!current || typeof current !== 'object') return path;
      const obj = current as Record<string, unknown>;
      let matched = false;
      for (let j = keys.length; j > i; j -= 1) {
        const candidate = keys.slice(i, j).join('.');
        if (Object.prototype.hasOwnProperty.call(obj, candidate)) {
          current = obj[candidate];
          i = j - 1;
          matched = true;
          break;
        }
      }
      if (!matched) return path;
    }
    return typeof current === 'string' ? current : path;
  };
}
const faT = bundleT(fa);
const enT = bundleT(en);

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: bundleT(fa), dir: 'rtl', locale: 'fa' }) }));
vi.mock('@/lib/mediaObjectUrl', () => ({
  useAuthedMediaSrc: () => ({ src: null, failed: false }),
  openAuthedAttachment: () => {},
}));

const { SystemNoticeRow } = await import('@/components/inbox/SystemNoticeRow');
const { NoteRow } = await import('@/components/inbox/NoteRow');
const { ChannelIdentityCard } = await import('@/components/inbox/ChannelBadge');
const { MessageAttachmentView } = await import('@/components/inbox/MessageAttachmentView');

afterEach(() => { cleanup(); uninstallPersianDigits(); });

describe('a system notice says who else reads it', () => {
  it('an internal one is marked for the team only', () => {
    const { container } = render(<SystemNoticeRow body="Ali unassigned this conversation" meta={{ kind: 'conversation_unassigned', internal: true, actor_name: 'Ali' }} t={faT} />);
    const mark = container.querySelector('[data-inbox="notice-visibility"]')!;
    expect(mark.getAttribute('data-visibility')).toBe('internal');
    expect(mark.textContent).toBe('فقط داخلی');
  });

  it('one the visitor receives is marked so, and a transfer says what the visitor reads instead', () => {
    const { container } = render(
      <SystemNoticeRow body="x" meta={{ kind: 'conversation_transferred', actor_name: 'Ali', to_name: 'Sara' }} t={faT} />,
    );
    const mark = container.querySelector('[data-inbox="notice-visibility"]')!;
    expect(mark.getAttribute('data-visibility')).toBe('visitor');
    expect(mark.getAttribute('aria-label')).toBe('بازدیدکننده می‌بیند: «Sara به گفتگو پیوست»');
    // The team's own sentence is unchanged.
    expect(container.textContent).toBe('Ali این گفتگو را به Sara منتقل کرد');
  });

  it('a join the visitor reads word for word just says the visitor sees it too', () => {
    const { container } = render(<SystemNoticeRow body="x" meta={{ kind: 'routing_agent_joined', agent_name: 'Sara' }} t={enT} />);
    expect(container.querySelector('[data-visibility="visitor"]')!.getAttribute('aria-label')).toBe('The visitor sees this too');
  });

  it('a department transfer, which the server keeps internal, is marked internal', () => {
    const { container } = render(<SystemNoticeRow body="x" meta={{ kind: 'conversation_transferred', internal: true, actor_name: 'Ali', to_name: 'Sales' }} t={enT} />);
    expect(container.querySelector('[data-inbox="notice-visibility"]')!.getAttribute('data-visibility')).toBe('internal');
  });
});

describe('the Persian panel keeps what people wrote as written', () => {
  it('a note\'s body keeps its Latin digits while the interface around it turns Persian', () => {
    const created = new Date(Date.now() - 5 * 60_000).toISOString();
    const { container } = render(
      <NoteRow
        note={{ id: 'n1', body: 'Order A1234, tracking 9876', created_at: created, updated_at: created, author: { full_name: 'Ali', email: null, avatar_url: null } } as never}
        canEdit={false} isDeleting={false} isUpdating={false} onUpdate={async () => {}} onDelete={() => {}} t={faT}
      />,
    );
    installPersianDigits();
    expect(container.textContent).toContain('Order A1234, tracking 9876');
    // The relative time beside it is interface: no Latin digit is left outside the body.
    const outside = container.textContent!.replace('Order A1234, tracking 9876', '');
    expect(outside).not.toMatch(/[0-9]/);
  });

  it('a channel handle or id is shown as the provider sent it', () => {
    const { container } = render(
      <ChannelIdentityCard metadata={{ channel: 'telegram', channel_username: 'shop2024', channel_user_id: 123456789 }} t={faT} dir="rtl" />,
    );
    installPersianDigits();
    expect(container.textContent).toContain('@shop2024');
    expect(container.textContent).toContain('123456789');
  });
});

describe('the attachment views speak the panel\'s language', () => {
  it('the voice player and the download button are named in Persian', () => {
    const { container } = render(
      <MessageAttachmentView att={{ id: 'a1', file_name: 'voice.webm', mime_type: 'audio/webm', size_bytes: 2048, kind: 'audio' } as never} t={faT} isAgent={false} />,
    );
    const labels = [...container.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual(expect.arrayContaining(['پخش', 'جابه‌جایی در فایل صوتی', 'دانلود']));
    expect(labels).not.toEqual(expect.arrayContaining(['Play', 'Seek', 'Download']));
  });
});
