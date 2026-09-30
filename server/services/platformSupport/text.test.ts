import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_LENGTH,
  MAX_RATING_COMMENT_LENGTH,
  attachmentKind,
  clientPlatformOf,
  normalizeBody,
  normalizeClientMessageId,
  normalizeRatingComment,
  normalizeScore,
  SlidingWindowLimiter,
  subjectFromBody,
  supportFileName,
} from './text.js';
import { normalizeSettings } from './settings.js';
import { businessHoursView } from './service.js';

describe('what an operator may send', () => {
  it('trims a message and refuses an empty or oversized one', () => {
    expect(normalizeBody('  hello\r\nthere  ')).toBe('hello\nthere');
    expect(normalizeBody('   ')).toBeNull();
    expect(normalizeBody(42)).toBeNull();
    expect(normalizeBody('x'.repeat(MAX_BODY_LENGTH + 1))).toBeNull();
  });

  it('accepts only an opaque client id', () => {
    expect(normalizeClientMessageId('3f2b9c1e-0000-4000-8000-000000000001')).toBe('3f2b9c1e-0000-4000-8000-000000000001');
    expect(normalizeClientMessageId('short')).toBeNull();
    expect(normalizeClientMessageId('has space in it')).toBeNull();
  });

  it('makes a conversation subject of the first line', () => {
    expect(subjectFromBody('\nFirst line\nsecond')).toBe('First line');
    expect(subjectFromBody('x'.repeat(100))).toHaveLength(80);
  });
});

describe('a rating', () => {
  it('is one to five whole stars', () => {
    expect(normalizeScore(1)).toBe(1);
    expect(normalizeScore(5)).toBe(5);
    expect(normalizeScore(0)).toBeNull();
    expect(normalizeScore(4.5)).toBeNull();
    expect(normalizeScore('5')).toBeNull();
  });

  it('takes an optional comment, trimmed, and refuses one that is too long', () => {
    expect(normalizeRatingComment(undefined)).toBeNull();
    expect(normalizeRatingComment('   ')).toBeNull();
    expect(normalizeRatingComment(' thanks ')).toBe('thanks');
    expect(normalizeRatingComment('x'.repeat(MAX_RATING_COMMENT_LENGTH + 1))).toBeUndefined();
    expect(normalizeRatingComment(7)).toBeUndefined();
  });
});

describe('a file', () => {
  it('is named without its path, with the extension its type says', () => {
    expect(supportFileName('../../etc/Screen Shot.PNG', 'image/png')).toBe('Screen Shot.png');
    expect(supportFileName('report', 'application/pdf')).toBe('report.pdf');
    expect(supportFileName('', 'text/plain')).toBe('file.txt');
    expect(supportFileName('a"b\u0001.jpg', 'image/jpeg')).toBe('ab.jpg');
  });

  it('is drawn by its kind', () => {
    expect(attachmentKind('image/webp')).toBe('image');
    expect(attachmentKind('application/pdf')).toBe('file');
  });
});

describe('the app a request came from', () => {
  it('is what the app says, and the web when nothing does', () => {
    expect(clientPlatformOf('android')).toBe('android');
    expect(clientPlatformOf('iOS')).toBe('ios');
    expect(clientPlatformOf(['macos'])).toBe('macos');
    expect(clientPlatformOf(undefined)).toBe('web');
    expect(clientPlatformOf('fridge')).toBe('web');
  });
});

describe('business hours', () => {
  it('are shown only while the workspace keeps them, and only well-formed', () => {
    expect(businessHoursView(null)).toBeNull();
    expect(businessHoursView({ business_hours: { enabled: false, weekly: { sat: [{ from: '09:00', to: '17:00' }] } } })).toBeNull();
    expect(
      businessHoursView({
        business_hours: {
          enabled: true,
          weekly: { sat: [{ from: '09:00', to: '17:00' }, { from: '9', to: '10' }], sun: 'closed', mon: [] },
        },
      }),
    ).toEqual({ timezone: 'UTC', weekly: { sat: [{ from: '09:00', to: '17:00' }] } });
  });
});

describe('the rate limit', () => {
  it('allows the limit in a window, then refuses until the window moves on', () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    expect(limiter.take('u', 0)).toBe(true);
    expect(limiter.take('u', 10)).toBe(true);
    expect(limiter.take('u', 20)).toBe(false);
    expect(limiter.take('other', 20)).toBe(true);
    expect(limiter.take('u', 1011)).toBe(true);
  });
});

describe('settings', () => {
  it('reads a missing row as off', () => {
    expect(normalizeSettings(null)).toEqual({ enabled: false, workspaceId: null, updatedAt: null });
  });
});
