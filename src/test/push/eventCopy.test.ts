/**
 * What the phone is told, and how the app finds its way from it.
 *
 * Three things pinned here were wrong. Templates are keyed by bare language
 * ("fa") while profiles store full tags ("fa-IR"), so every Persian operator
 * got the English template. `{{workspace}}` was offered to template authors
 * and never supplied. And a category list saved before an event type existed
 * gave that event no buttons at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  renderContent,
  renderHandoffContent,
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
  senderName: 'Ali',
  text: 'Hello',
};

describe('templates', () => {
  const policy = {
    ...PUSH_PLATFORM_DEFAULTS,
    templates: {
      ...DEFAULT_TEMPLATES,
      new_message: {
        ...DEFAULT_TEMPLATES.new_message,
        title: { default: '{{workspace}} · {{sender}}', en: '{{workspace}} · {{sender}}', fa: 'فارسی · {{sender}}' },
      },
    },
  };

  it('a full locale tag finds the Persian template', () => {
    expect(renderContent(base, 'new_message', true, policy, 'fa-IR').title).toContain('فارسی');
  });

  it('fills in the workspace name for a template that asks for it', () => {
    const out = renderContent({ ...base, workspaceName: 'Acme' }, 'new_message', true, policy, 'en');
    expect(out.title).toBe('Acme · Ali');
  });
});

describe('the AI letting go of a conversation', () => {
  it('names the customer and says what happened, in the recipient\'s language', () => {
    expect(renderHandoffContent({ customer: 'Ali' }, true, 'en')).toEqual({
      title: 'Needs a person',
      body: 'Ali · The AI handed this conversation to your team',
    });
    expect(renderHandoffContent({ customer: null }, true, 'fa').body).toContain('هوش مصنوعی');
  });

  it('keeps the customer off a locked screen when previews are off', () => {
    const out = renderHandoffContent({ customer: 'Ali' }, false, 'tr');
    expect(JSON.stringify(out)).not.toContain('Ali');
    expect(out.body).toBe('Bir görüşme bir temsilci bekliyor');
  });
});

describe('buttons on the banner', () => {
  it('each kind of event that can be answered from the banner has its category', () => {
    const byEvent = (event: string) => DEFAULT_CATEGORIES.find((c) => c.eventTypes.includes(event))?.id;
    expect(byEvent('new_message')).toBe('WEBYAR_MESSAGE');
    expect(byEvent('assignment')).toBe('WEBYAR_MESSAGE');
    expect(byEvent('handoff')).toBe('WEBYAR_MESSAGE');
    expect(byEvent('team_message')).toBe('WEBYAR_TEAM');
    expect(byEvent('email_message')).toBe('WEBYAR_EMAIL');
  });

  it('and every category is one the iOS app registers — or its banner has no buttons', () => {
    const swift = readFileSync('ios/Webyar/Sources/Core/Push/PushController.swift', 'utf8');
    for (const category of DEFAULT_CATEGORIES) {
      expect(swift, category.id).toContain(`identifier: "${category.id}"`);
      for (const action of category.actions) expect(swift, action.id).toContain(`identifier: "${action.id}"`);
    }
  });
});

describe('the payload the app routes on', () => {
  it('names each destination with the keys the iOS app reads', () => {
    const swift = readFileSync('ios/Webyar/Sources/Core/Push/PushTarget.swift', 'utf8');
    const server = readFileSync('server/services/push/dispatch.ts', 'utf8');
    for (const key of ['workspaceId', 'conversationId', 'peerId', 'threadId']) {
      expect(swift, key).toContain(`"${key}"`);
      expect(server, key).toContain(`${key}:`);
    }
    for (const type of ['team_message', 'email_message']) {
      expect(swift, type).toContain(`"${type}"`);
      expect(server, type).toContain(`'${type}'`);
    }
  });
});
