/**
 * Every store link in an answer is a real product page, or it is not there.
 *
 * Repairing against the turn's own tool results was not enough. From the live
 * store, two turns apart:
 *
 *   «گوشی هوشمند دارید ؟»  → the assistant describes نوا ۱۲ correctly
 *   «لینکشو بده»           → https://p.webyar.ai/product/nova-12
 *
 * The second question carries no commerce intent, so no tool ran and nothing
 * was in the allowed set — and the model, asked for a link to the product it
 * had just described, invented an English slug for a Persian-named product.
 * Checked live: that URL answers 404 while the catalogue's own answers 200.
 *
 * So the catalogue is the authority, not the turn.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const CONN = 'a22e727a-c3e8-4ae9-b548-9cd8ec3f1b2a';
const STORE = 'https://p.webyar.ai';

/** Verbatim from commerce_products — both answer 200 on the live store. */
const NOVA = 'https://p.webyar.ai/product/%da%af%d9%88%d8%b4%db%8c-%d9%87%d9%88%d8%b4%d9%85%d9%86%d8%af-%d9%86%d9%88%d8%a7-%db%b1%db%b2/';
const POWERBANK = 'https://p.webyar.ai/product/%d9%be%d8%a7%d9%88%d8%b1%d8%a8%d8%a7%d9%86%da%a9-%db%b2%db%b0%db%b0%db%b0%db%b0-%d9%85%db%8c%d9%84%db%8c%d8%a2%d9%85%d9%be%d8%b1-%d9%88%d9%84%d8%aa%d9%85%da%a9%d8%b3/';

const ROWS = [
  { external_id: '11', canonical_url: NOVA },
  { external_id: '17', canonical_url: POWERBANK },
];

let connection: { id: string; workspace_id: string; store_id: string; provider_type: string } | null = { id: CONN, workspace_id: WS, store_id: STORE, provider_type: 'woocommerce' };
const seen = { exactLookups: 0, catalogueLoads: 0 };

function fakeClient() {
  type Result = { data: unknown; error: null };
  interface Builder {
    _in: string[] | null;
    select: () => Builder; eq: () => Builder; is: () => Builder; not: () => Builder; order: () => Builder; limit: () => Builder;
    in: (col: string, values: string[]) => Builder;
    then: (resolve: (r: Result) => unknown) => unknown;
  }
  const make = () => {
    const b: Builder = {
      _in: null as string[] | null,
      select: () => b,
      eq: () => b,
      is: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      in: (_col: string, values: string[]) => { b._in = values; return b; },
      then: (resolve) => {
        if (b._in) {
          seen.exactLookups += 1;
          return resolve({ data: ROWS.filter((r) => b._in!.includes(r.canonical_url)).map((r) => ({ canonical_url: r.canonical_url })), error: null });
        }
        seen.catalogueLoads += 1;
        return resolve({ data: ROWS, error: null });
      },
    };
    return b;
  };
  return { from: () => make() };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/commerce/gateway.js', () => ({
  getActiveConnectionForWorkspace: async () => connection,
  // The store connection of the turn (same selection the commerce stage uses).
  resolveConversationConnection: async () => connection,
}));

const { verifyStoreLinks } = await import('../../../server/services/ai-agent/commerce-tools/answerLinks.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as Parameters<typeof verifyStoreLinks>[0];
const verify = (text: string) => verifyStoreLinks(CONFIG, WS, text);

beforeEach(() => {
  connection = { id: CONN, workspace_id: WS, store_id: STORE, provider_type: 'woocommerce' };
  seen.exactLookups = 0;
  seen.catalogueLoads = 0;
});

describe('a link the model made up', () => {
  it('does not reach the visitor', async () => {
    const answer = 'این لینک خرید گوشی نووا ۱۲ است: https://p.webyar.ai/product/nova-12. اگر باز نشد بگویید.';

    const out = await verify(answer);

    expect(out).not.toContain('nova-12');
  });

  it('even though its turn ran no commerce tool at all', async () => {
    // «لینکشو بده» produces no intent, so the turn's allowed set is empty and
    // the first repair pass is a no-op. This pass answers to the catalogue.
    const out = await verify('لینکشو بده → https://p.webyar.ai/product/nova-12');

    expect(out).not.toContain('nova-12');
    expect(seen.catalogueLoads).toBe(1);
  });
});

describe('the `?p=<id>` form the model is given to copy', () => {
  it('becomes the canonical permalink the visitor opens', async () => {
    const out = await verify(`لینک خرید: ${STORE}/?p=17`);

    expect(out).toBe(`لینک خرید: ${POWERBANK}`);
  });

  it('resolves each product to its own page', async () => {
    const out = await verify(`نوا: ${STORE}/?p=11 و پاوربانک: ${STORE}/?p=17`);

    expect(out).toBe(`نوا: ${NOVA} و پاوربانک: ${POWERBANK}`);
  });

  it('and an id the catalogue does not have is not invented into one', async () => {
    const out = await verify(`لینک: ${STORE}/?p=99999`);

    expect(out).not.toContain('?p=99999');
    expect(out).not.toContain(NOVA);
    expect(out).not.toContain(POWERBANK);
  });
});

describe('what it costs', () => {
  it('nothing at all when the answer has no link', async () => {
    const answer = 'قیمت ۲۶٬۹۰۰٬۰۰۰ تومان است و ۱۳ عدد موجود است.';

    expect(await verify(answer)).toBe(answer);
    expect(seen.exactLookups + seen.catalogueLoads).toBe(0);
  });

  it('one indexed lookup when the links are already canonical', async () => {
    const answer = `لینک خرید: ${NOVA}`;

    expect(await verify(answer)).toBe(answer);
    expect(seen.exactLookups).toBe(1);
    expect(seen.catalogueLoads).toBe(0);
  });

  it('and nothing when the workspace has no store at all', async () => {
    connection = null;
    const answer = 'ببینید https://p.webyar.ai/product/nova-12';

    expect(await verify(answer)).toBe(answer);
    expect(seen.exactLookups + seen.catalogueLoads).toBe(0);
  });
});

describe('the shop’s own front page', () => {
  it('survives — it needs no product to vouch for it', async () => {
    // From the live store: «لینک صفحه فروشگاه وب‌یار همینه:» arrived with
    // nothing after the colon. The front page has no path to match a product
    // with, so it scored zero against every candidate and was dropped like an
    // invented link.
    const answer = `لینک صفحه فروشگاه وب‌یار همینه: ${STORE}`;

    expect(await verify(answer)).toBe(answer);
  });

  it('in either spelling', async () => {
    const answer = `فروشگاه: ${STORE}/ — ببینید`;
    expect(await verify(answer)).toBe(answer);
  });

  it('but a made-up path on the same host is still dropped', async () => {
    const out = await verify(`${STORE}/product/nova-12`);
    expect(out).not.toContain('nova-12');
  });
});

describe('links that are not the shop’s', () => {
  it('are left exactly as they are', async () => {
    const answer = 'راهنما: https://docs.example.com/guide و https://wordpress.org/plugins/';

    expect(await verify(answer)).toBe(answer);
    expect(seen.exactLookups + seen.catalogueLoads).toBe(0);
  });
});
