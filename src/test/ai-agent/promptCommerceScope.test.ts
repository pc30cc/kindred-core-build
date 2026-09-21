/**
 * When a shop is connected, its catalogue is what the business sells.
 *
 * A workspace's business description is written once, about the COMPANY. A
 * connected shop's catalogue is the live truth about what it STOCKS, and the
 * two drift apart. From the live store, asked «تلوزیون هم داری ؟»:
 *
 *   «در حال حاضر تلویزیون در каталг وب‌یار موجود نیست و وجهه اصلی ما روی
 *    ابزارها و محصولات مرتبط با حضور آنلاین است.»
 *
 * The second half came straight from `business_description`, which describes
 * Web Yar the AI company. The shop it was answering for sells phones,
 * speakers, smart lamps and five models of powerbank. Saying a television is
 * not stocked is correct; explaining it with a theory about the business is
 * not, and it tells a shopper the shop does not sell what it plainly does.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../server/services/ai-agent/prompt.js';
import { makeSettings } from './helpers/engineFixtures.js';

const ONLINE_PRESENCE = 'وب یار با تمرکز بر هوش مصنوعی، خدماتی برای بهبود حضور آنلاین کاربران ارائه می‌دهد.';

describe('a connected catalogue outranks the business description about what is sold', () => {
  const prompt = () => buildSystemPrompt(makeSettings({ business_description: ONLINE_PRESENCE }) as any, 'fa');

  it('tells the model the catalogue is what this business sells', () => {
    expect(prompt()).toContain('the store catalogue is what this business sells');
  });

  it('forbids explaining a missing product with the business description', () => {
    const p = prompt();
    expect(p).toMatch(/Do not describe the business's focus, market or product range from the business description/);
  });

  it('and says what to do instead of theorising', () => {
    expect(prompt()).toContain('say just that it is not available');
  });

  it('without dropping the description itself — it is still context', () => {
    // The description remains useful for everything that is not the catalogue:
    // who the company is, what it does, tone.
    expect(prompt()).toContain(`Business context: ${ONLINE_PRESENCE}`);
  });

  it('and the commerce data rules are still there', () => {
    expect(prompt()).toContain('a tool result named commerce.* is real store data');
  });
});
