/**
 * The notification an operator gets when the platform's support team
 * answers them: marked as support — never read as a customer or a
 * colleague — in their language, and silent about the text with previews off.
 */
import { describe, expect, it } from 'vitest';
import { renderSupportContent } from '../../../server/services/push/dispatch';

describe('renderSupportContent', () => {
  it('names the agent as support, in the operator\'s language', () => {
    expect(renderSupportContent({ senderName: 'Reza', text: 'Fixed.' }, true, 'en')).toEqual({
      title: 'Reza · Support',
      body: 'Fixed.',
    });
    expect(renderSupportContent({ senderName: 'رضا', text: 'درست شد' }, true, 'fa')).toEqual({
      title: 'رضا · پشتیبانی',
      body: 'درست شد',
    });
    expect(renderSupportContent({ senderName: 'Reza', text: 'Tamam' }, true, 'tr').title).toBe('Reza · Destek');
  });

  it('says only that support replied when previews are off', () => {
    expect(renderSupportContent({ senderName: 'Reza', text: 'secret' }, false, 'en')).toEqual({
      title: 'Support',
      body: 'New reply from support',
    });
    expect(renderSupportContent({ senderName: 'رضا', text: 'secret' }, false, 'fa')).toEqual({
      title: 'پشتیبانی',
      body: 'پاسخ جدید از پشتیبانی',
    });
  });

  it('still says something with no name and no text', () => {
    expect(renderSupportContent({ senderName: ' ', text: '' }, true, 'en')).toEqual({ title: 'Support', body: 'New message' });
  });
});
