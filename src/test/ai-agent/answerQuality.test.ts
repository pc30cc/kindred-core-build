/**
 * Regression guards for the AI answer-quality fixes:
 *  - retrieval scoring can no longer be inflated by keyword repetition
 *  - "I don't know" detection works in Persian and Turkish
 *  - persisted run error messages are redacted
 */
import { describe, it, expect } from 'vitest';
import { postValidateAnswer } from '../../../server/services/ai-agent/policy.js';
import { redactErrorMessage } from '../../../server/services/ai-agent/logs.js';
import { __testables } from '../../../server/services/ai-agent/retrieval.js';

const { scoreText } = __testables;

describe('retrieval scoring', () => {
  it('never exceeds 1 even when a keyword is repeated', () => {
    expect(scoreText('pricing plans', 'pricing pricing pricing pricing')).toBeLessThanOrEqual(1);
  });

  it('ranks broader term coverage above repetition', () => {
    const stuffed = scoreText('pricing plans refund', 'pricing pricing pricing pricing pricing');
    const relevant = scoreText('pricing plans refund', 'our pricing plans include a refund window');
    expect(relevant).toBeGreaterThan(stuffed);
  });

  it('returns 0 with no overlap', () => {
    expect(scoreText('pricing', 'completely unrelated content here')).toBe(0);
  });
});

describe('postValidateAnswer', () => {
  it('accepts a real answer', () => {
    expect(postValidateAnswer('Our starter plan costs 10 USD per month.').ok).toBe(true);
  });

  it('rejects English uncertainty', () => {
    expect(postValidateAnswer("I don't know the answer.").ok).toBe(false);
  });

  it('rejects Persian uncertainty', () => {
    expect(postValidateAnswer('متاسفانه نمی‌دانم، اطلاعات کافی ندارم.').ok).toBe(false);
  });

  it('rejects Turkish uncertainty', () => {
    expect(postValidateAnswer('Maalesef bilmiyorum.').ok).toBe(false);
    expect(postValidateAnswer('Bu konuda bilgim yok.').ok).toBe(false);
  });
});

describe('redactErrorMessage', () => {
  it('redacts provider keys and tokens', () => {
    const out = redactErrorMessage('OpenAI error: invalid api_key sk-abcdef1234567890 for org');
    expect(out).not.toContain('sk-abcdef1234567890');
    expect(out).toContain('[redacted]');
  });

  it('redacts query-string credentials', () => {
    const out = redactErrorMessage('failed GET https://x.test/v1?key=AIzaSyVerySecret123');
    expect(out).not.toContain('AIzaSyVerySecret123');
  });
});