/**
 * What the new kinds of notification say, and how they reach the app.
 *
 * Three things the first version got wrong are pinned here. Templates are
 * keyed by bare language ("fa") while profiles store full tags ("fa-IR"), so
 * every Persian operator got the English template. `{{workspace}}` was offered
 * to template authors and never supplied. And a category list saved before an
 * event type existed gave that event no buttons at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  renderContent,
  emailSenderName,
  isFreshEmail,
  type InboundPushInput,
} from '../../../server/services/push/dispatch';
import {
  DEFAULT_CATEGORIES,
  DEFAULT_TEMPLATES,
  PUSH_PLATFORM_DEFAULTS,
} from '../../../server/services/push/platformSettings';

const base: InboundPushInput = {
  workspaceId: 'w-1',
  conversationId: 'c-1',
  messageId: 'm-1',
  senderName: 'سارا',
  text: 'سلام',
};

describe('templates in the recipient\'s language', () => {
  it('a full locale tag finds the Persian template', () => {
    const out = renderContent(base, 'handoff', true, PUSH_PLATFORM_DEFAULTS, 'fa-IR');
    expect(out.body).toBe('هوش مصنوعی این گفتگو را به تیم شما سپرد');
  });

  it('fills in the workspace name for a template that asks for it', () => {
    const policy = {
      ...PUSH_PLATFORM_DEFAULTS,
      templates: {
        ...DEFAULT_TEMPLATES,
        new_message: { ...DEFAULT_TEMPLATES.new_message, title: { default: '{{workspace}} · {{sender}}' } },
      },
    };
    const out = renderContent({ ...base, senderName: 'Ali', workspaceName: 'Acme' }, 'new_message', true, policy, 'en');
    expect(out.title).toBe('Acme · Ali');
  });
});

describe('an assignment', () => {
  it('says who gave it', () => {
    const out = renderContent({ ...base, senderName: 'Ali', actorName: 'Sara' }, 'assigned', true, PUSH_PLATFORM_DEFAULTS, 'en');
    expect(out).toEqual({ title: 'Ali', body: 'Assigned to you · Sara' });
  });

  it('or that routing did, when nobody did', () => {
    const out = renderContent({ ...base, senderName: 'Ali' }, 'assigned', true, null, 'fa');
    expect(out.body).toBe('به شما سپرده شد · تخصیص خودکار');
  });

  it('keeps the customer off a locked screen when previews are off', () => {
    const out = renderContent({ ...base, senderName: 'Ali' }, 'assigned', false, PUSH_PLATFORM_DEFAULTS, 'en');
    expect(out.title).toBe('Webyar');
    expect(JSON.stringify(out)).not.toContain('Ali');
  });
});

describe('a colleague\'s message and an email', () => {
  it('a colleague\'s message with no name says "colleague", not "customer"', () => {
    const out = renderContent({ ...base, senderName: null, text: 'ping' }, 'team_message', true, null, 'en');
    expect(out).toEqual({ title: 'Colleague', body: 'ping' });
  });

  it('private copy names the kind of thing without its words', () => {
    expect(renderContent(base, 'team_message', false, PUSH_PLATFORM_DEFAULTS, 'fa').body).toBe('پیام جدید از همکار');
    expect(renderContent(base, 'email', false, PUSH_PLATFORM_DEFAULTS, 'tr').body).toBe('Yeni e-posta');
  });

  it('an email is titled by who sent it', () => {
    expect(emailSenderName('"Sara Karimi" <sara@example.com>')).toBe('Sara Karimi');
    expect(emailSenderName('Sara Karimi <sara@example.com>')).toBe('Sara Karimi');
    expect(emailSenderName('<sara@example.com>')).toBe('sara@example.com');
    expect(emailSenderName('sara@example.com')).toBe('sara@example.com');
  });

  it('only fresh mail is news — a first sync imports days of it at once', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(isFreshEmail('2026-09-28T11:55:00Z', now)).toBe(true);
    expect(isFreshEmail('2026-09-25T09:00:00Z', now)).toBe(false);
    expect(isFreshEmail(null, now)).toBe(true);
    expect(isFreshEmail('not a date', now)).toBe(true);
  });
});

describe('buttons on the banner', () => {
  const EVENTS = ['new_message', 'internal_note', 'mention', 'assigned', 'handoff', 'team_message', 'email'];

  it('every event type has a category', () => {
    for (const event of EVENTS) {
      expect(DEFAULT_CATEGORIES.some((c) => c.eventTypes.includes(event)), event).toBe(true);
    }
  });

  it('and every category is one the iOS app registers — or its banner has no buttons', () => {
    const swift = readFileSync('ios/WebyarNative/Sources/Core/Push/PushController.swift', 'utf8');
    for (const category of DEFAULT_CATEGORIES) {
      expect(swift, category.id).toContain(`identifier: "${category.id}"`);
      for (const action of category.actions) expect(swift, action.id).toContain(`identifier: "${action.id}"`);
    }
  });

  it('a template exists for every event type, in every shipped language', () => {
    for (const event of EVENTS) {
      const template = DEFAULT_TEMPLATES[event];
      expect(template, event).toBeTruthy();
      for (const lang of ['en', 'fa', 'tr']) {
        expect(template.privateBody[lang], `${event}/${lang}`).toBeTruthy();
      }
    }
  });
});

describe('the payload the app routes on', () => {
  it('names the destination with the keys the iOS app reads', () => {
    const swift = readFileSync('ios/WebyarNative/Sources/Core/Push/PushTarget.swift', 'utf8');
    const server = readFileSync('server/services/push/dispatch.ts', 'utf8');
    for (const key of ['workspaceId', 'conversationId', 'teamPeerId', 'emailThreadId']) {
      expect(swift, key).toContain(`"${key}"`);
      expect(server, key).toContain(`${key}:`);
    }
  });
});
