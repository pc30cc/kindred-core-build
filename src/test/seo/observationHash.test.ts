import { describe, expect, it } from 'vitest';
import { computeObservationHash, type ObservationFields } from '../../../server/services/seo/urlRepository';

const fields: ObservationFields = {
  statusCode: 200, title: 'Example', metaDescription: 'Description',
  canonicalStatus: 'self', isIndexable: true, internalLinksCount: 3, externalLinksCount: 1,
};

describe('SEO observation content identity', () => {
  it('reuses a hash for identical content despite timing changes', () => {
    expect(computeObservationHash(fields, { h1: 'Heading', response_time_ms: 12, crawled_at: '2026-01-01' }))
      .toBe(computeObservationHash(fields, { crawled_at: '2026-01-02', response_time_ms: 99, h1: 'Heading' }));
  });
  it.each([
    { title: 'Changed' }, { statusCode: 404 }, { canonicalStatus: 'points_elsewhere' }, { isIndexable: false },
  ])('detects changed SEO fields %j', (patch) => {
    expect(computeObservationHash({ ...fields, ...patch })).not.toBe(computeObservationHash(fields));
  });
  it.each(['canonical_url', 'h1', 'meta_robots', 'lang', 'fetch_error'])('detects report payload changes in %s', (key) => {
    expect(computeObservationHash(fields, { [key]: 'a' })).not.toBe(computeObservationHash(fields, { [key]: 'b' }));
  });
  it('sorts nested object keys deterministically', () => {
    expect(computeObservationHash(fields, { structured_data: { a: 1, b: { c: 2, d: 3 } } }))
      .toBe(computeObservationHash(fields, { structured_data: { b: { d: 3, c: 2 }, a: 1 } }));
  });
  it('does not erase array order from report content', () => {
    expect(computeObservationHash(fields, { redirect_chain: ['a', 'b'] }))
      .not.toBe(computeObservationHash(fields, { redirect_chain: ['b', 'a'] }));
  });
});