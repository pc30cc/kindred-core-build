/**
 * The rules the browser banner obeys before it appears.
 *
 * The banner is new — Settings → Notifications asked for the browser's
 * permission from the day it shipped and nothing ever constructed a
 * `Notification`, so an operator who granted it and switched windows was
 * told nothing at all. These are the parts of it worth pinning: what counts
 * as inside quiet hours, which conversations a scope lets through, and what
 * a preview may say.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  assigneeFromCache,
  isWithinQuietHours,
  passesScope,
  previewText,
  resolveAssignee,
} from '../../features/notifications/operatorBrowserNotification';

const at = (hh: number, mm = 0) => new Date(2026, 8, 21, hh, mm, 0);

describe('quiet hours', () => {
  const window = { quiet_hours_enabled: true, quiet_hours_start: '22:00', quiet_hours_end: '08:00' };

  it('is nothing at all while it is switched off', () => {
    expect(isWithinQuietHours({ ...window, quiet_hours_enabled: false }, at(23))).toBe(false);
  });

  it('wraps past midnight, which is the only shape anybody uses', () => {
    expect(isWithinQuietHours(window, at(23))).toBe(true);
    expect(isWithinQuietHours(window, at(2))).toBe(true);
    expect(isWithinQuietHours(window, at(7, 59))).toBe(true);
    expect(isWithinQuietHours(window, at(8))).toBe(false);
    expect(isWithinQuietHours(window, at(12))).toBe(false);
    expect(isWithinQuietHours(window, at(21, 59))).toBe(false);
  });

  it('handles a window inside one day', () => {
    const lunch = { quiet_hours_enabled: true, quiet_hours_start: '12:00', quiet_hours_end: '13:00' };
    expect(isWithinQuietHours(lunch, at(12, 30))).toBe(true);
    expect(isWithinQuietHours(lunch, at(13))).toBe(false);
    expect(isWithinQuietHours(lunch, at(11, 59))).toBe(false);
  });

  it('never mutes on a window it cannot read', () => {
    // Half a window, or one with no width, is a settings bug — and muting an
    // operator over it is a worse answer than ignoring it.
    expect(isWithinQuietHours({ ...window, quiet_hours_end: null }, at(23))).toBe(false);
    expect(isWithinQuietHours({ ...window, quiet_hours_start: 'later' }, at(23))).toBe(false);
    expect(isWithinQuietHours({ ...window, quiet_hours_end: '22:00' }, at(23))).toBe(false);
  });
});

describe('scope', () => {
  const ME = 'me';

  // A colleague's conversation used to let every message through on "all"
  // (and the chime ignored the scope altogether), so the whole floor heard
  // every visitor of every operator. It is theirs now, as on the phone.
  it('on "all": mine and the unassigned, not a colleague\'s', () => {
    expect(passesScope('all', ME, ME)).toBe(true);
    expect(passesScope('all', null, ME)).toBe(true);
    expect(passesScope('all', 'somebody-else', ME)).toBe(false);
  });

  it('except for a supervisor watching every conversation', () => {
    expect(passesScope('all', 'somebody-else', ME, true)).toBe(true);
    // "Assigned to me, and unassigned" still means it.
    expect(passesScope('assigned', 'somebody-else', ME, true)).toBe(false);
  });

  it('means it on "none"', () => {
    expect(passesScope('none', ME, ME)).toBe(false);
  });

  it('leaves mentions to the phone, which is the surface that is told', () => {
    // This event carries no mention information, and a browser guessing
    // would either invent mentions or swallow them.
    expect(passesScope('mentions', ME, ME)).toBe(false);
  });

  it('on "assigned": mine, and the unassigned — what the setting says', () => {
    expect(passesScope('assigned', ME, ME)).toBe(true);
    expect(passesScope('assigned', null, ME)).toBe(true);
    expect(passesScope('assigned', 'somebody-else', ME)).toBe(false);
  });

  it('but a conversation whose owner cannot be read is not silently dropped', () => {
    // `undefined` is "could not find out", which is not the same as
    // unassigned — and one banner too many costs nothing beside a missed
    // customer.
    expect(passesScope('assigned', undefined, ME)).toBe(true);
  });
});

describe('the assignee, off the Inbox page', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is read once from the server when no list holds the conversation, then remembered', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(
      JSON.stringify({ conversation: { id: 'c-9', assigned_to: 'colleague' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient();
    expect(await resolveAssignee(qc, 'ws-1', 'c-9')).toBe('colleague');
    expect(await resolveAssignee(qc, 'ws-1', 'c-9')).toBe('colleague');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/conversations/c-9?workspace_id=ws-1');
  });

  it('prefers what a list already holds', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient();
    qc.setQueryData(['conversations', 'ws-1', 'main'], [{ id: 'c-1', assigned_to: null }]);
    expect(await resolveAssignee(qc, 'ws-1', 'c-1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says it does not know when the server cannot tell', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(await resolveAssignee(qc, 'ws-1', 'c-2')).toBeUndefined();
  });
});

describe('the assignee, from what the list already has', () => {
  it('finds a conversation in a plain array cache', () => {
    const qc = new QueryClient();
    qc.setQueryData(['conversations', 'ws-1', 'open'], [{ id: 'c-1', assigned_to: 'me' }]);
    expect(assigneeFromCache(qc, 'ws-1', 'c-1')).toBe('me');
  });

  it('and in a paged one', () => {
    const qc = new QueryClient();
    qc.setQueryData(['conversations', 'ws-1'], {
      pages: [{ conversations: [{ id: 'c-2', assigned_to: null }] }],
    });
    expect(assigneeFromCache(qc, 'ws-1', 'c-2')).toBeNull();
  });

  it('says it does not know rather than guessing', () => {
    const qc = new QueryClient();
    expect(assigneeFromCache(qc, 'ws-1', 'c-3')).toBeUndefined();
  });

  it('never reads another workspace\'s cache', () => {
    const qc = new QueryClient();
    qc.setQueryData(['conversations', 'ws-2'], [{ id: 'c-4', assigned_to: 'me' }]);
    expect(assigneeFromCache(qc, 'ws-1', 'c-4')).toBeUndefined();
  });
});

describe('the preview', () => {
  const detail = (text: string) => ({ payload: { text } });

  it('is the message, when previews are on', () => {
    expect(previewText(detail('Is my order shipped?'), true)).toBe('Is my order shipped?');
  });

  it('is nothing at all when they are off', () => {
    // Off has to mean the text never appears — on a screen other people can
    // see, that is the entire point of the switch.
    expect(previewText(detail('Is my order shipped?'), false)).toBeNull();
  });

  it('collapses the whitespace a pasted message arrives with', () => {
    expect(previewText(detail('  line one\n\n   line two  '), true)).toBe('line one line two');
  });

  it('truncates rather than filling the screen', () => {
    const long = 'x'.repeat(400);
    const out = previewText(detail(long), true) ?? '';
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back when the event carried no text', () => {
    expect(previewText({ payload: null }, true)).toBeNull();
    expect(previewText({ payload: { text: '   ' } }, true)).toBeNull();
  });
});

describe('which surface the shared bundle speaks for', () => {
  it('is the browser on the web, and the phone inside the app shell', async () => {
    // The SAME bundle is the browser console and the inside of the Capacitor
    // shell — and the shell is a phone: it registers in
    // `mobile_push_devices`, and the dispatcher reads the phone's row before
    // sending to it. Hardcoding 'web' here let an operator set preferences on
    // their phone that the thing sending to their phone never read.
    const { notificationPlatform } = await import('../../lib/notifications-api');

    const g = globalThis as unknown as { window?: { Capacitor?: unknown } };
    const original = g.window?.Capacitor;
    try {
      expect(notificationPlatform()).toBe('web');
      g.window = g.window ?? {};
      g.window.Capacitor = { isNativePlatform: () => true };
      expect(notificationPlatform()).toBe('mobile');
    } finally {
      if (g.window) g.window.Capacitor = original;
    }
  });
});
