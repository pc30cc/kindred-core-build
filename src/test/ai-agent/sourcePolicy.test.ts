/**
 * Follow-up 6B — shared source-eligibility policy, extracted from the
 * duplicated (and, per the prior audit, currently-aligned) logic in
 * retrievalHybrid.ts and sourceHealth.ts. Pure functions, no Supabase
 * mocking required.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveWebPageParentSourceId,
  isQnaSourceAllowed,
  isKbArticleSourceAllowed,
  isLearnedQnaSourceAllowed,
  isFileSourceAllowed,
  isWebsiteSourceAllowed,
} from '../../../server/services/ai-agent/sourcePolicy.js';

describe('deriveWebPageParentSourceId', () => {
  it('W1 — metadata.parent_source_id wins, trimmed', () => {
    expect(deriveWebPageParentSourceId(
      'source-1:https://example.com/a',
      { parent_source_id: ' parent-1 ' },
    )).toBe('parent-1');
  });

  it('W2 — metadata.source_id is the fallback when parent_source_id is absent, trimmed', () => {
    expect(deriveWebPageParentSourceId(
      'source-1:https://example.com/a',
      { source_id: ' parent-2 ' },
    )).toBe('parent-2');
  });

  it('W3 — a compound source id ("parent:rest") derives the substring before the first ":"', () => {
    expect(deriveWebPageParentSourceId('parent-3:https://example.com/page', {})).toBe('parent-3');
  });

  it('W4 — a simple (non-compound) source id is returned unchanged', () => {
    expect(deriveWebPageParentSourceId('parent-4', {})).toBe('parent-4');
  });

  it('W5a — null metadata falls through to compound-id / unchanged-id behavior', () => {
    expect(deriveWebPageParentSourceId('parent-5:rest', null)).toBe('parent-5');
    expect(deriveWebPageParentSourceId('parent-5', null)).toBe('parent-5');
  });

  it('W5b — undefined metadata falls through the same way', () => {
    expect(deriveWebPageParentSourceId('parent-6:rest', undefined)).toBe('parent-6');
  });

  it('W5c — string metadata (not an object) is ignored, same fallthrough', () => {
    expect(deriveWebPageParentSourceId('parent-7:rest', 'not-an-object')).toBe('parent-7');
  });

  it('W5d — array metadata is treated as an object with no parent_source_id/source_id keys, same fallthrough', () => {
    expect(deriveWebPageParentSourceId('parent-8:rest', ['unexpected', 'array'])).toBe('parent-8');
  });

  it('empty-string parent_source_id/source_id in metadata does not win over the compound-id fallback', () => {
    expect(deriveWebPageParentSourceId('parent-9:rest', { parent_source_id: '   ', source_id: '' })).toBe('parent-9');
  });
});

describe('isQnaSourceAllowed — Q1', () => {
  it('correct workspace + enabled=true -> allowed', () => {
    expect(isQnaSourceAllowed({ workspace_id: 'ws-a', enabled: true }, 'ws-a')).toBe(true);
  });
  it('correct workspace + enabled=false -> denied', () => {
    expect(isQnaSourceAllowed({ workspace_id: 'ws-a', enabled: false }, 'ws-a')).toBe(false);
  });
  it('wrong workspace + enabled=true -> denied', () => {
    expect(isQnaSourceAllowed({ workspace_id: 'ws-b', enabled: true }, 'ws-a')).toBe(false);
  });
});

describe('isKbArticleSourceAllowed — K1', () => {
  it('published + used_by_ai=true -> allowed', () => {
    expect(isKbArticleSourceAllowed({ workspace_id: 'ws-a', status: 'published', used_by_ai: true }, 'ws-a')).toBe(true);
  });
  it('published + used_by_ai=undefined -> allowed (current semantics: only strict false disqualifies)', () => {
    expect(isKbArticleSourceAllowed({ workspace_id: 'ws-a', status: 'published', used_by_ai: undefined }, 'ws-a')).toBe(true);
  });
  it('published + used_by_ai=null -> allowed (current semantics: only strict false disqualifies)', () => {
    expect(isKbArticleSourceAllowed({ workspace_id: 'ws-a', status: 'published', used_by_ai: null }, 'ws-a')).toBe(true);
  });
  it('published + used_by_ai=false -> denied', () => {
    expect(isKbArticleSourceAllowed({ workspace_id: 'ws-a', status: 'published', used_by_ai: false }, 'ws-a')).toBe(false);
  });
  it('draft + used_by_ai=true -> denied', () => {
    expect(isKbArticleSourceAllowed({ workspace_id: 'ws-a', status: 'draft', used_by_ai: true }, 'ws-a')).toBe(false);
  });
  it('wrong workspace -> denied', () => {
    expect(isKbArticleSourceAllowed({ workspace_id: 'ws-b', status: 'published', used_by_ai: true }, 'ws-a')).toBe(false);
  });
});

describe('isLearnedQnaSourceAllowed — L1', () => {
  it('approved -> allowed', () => {
    expect(isLearnedQnaSourceAllowed({ workspace_id: 'ws-a', status: 'approved' }, 'ws-a')).toBe(true);
  });
  it('pending -> denied', () => {
    expect(isLearnedQnaSourceAllowed({ workspace_id: 'ws-a', status: 'pending' }, 'ws-a')).toBe(false);
  });
  it('rejected -> denied', () => {
    expect(isLearnedQnaSourceAllowed({ workspace_id: 'ws-a', status: 'rejected' }, 'ws-a')).toBe(false);
  });
  it('wrong workspace -> denied', () => {
    expect(isLearnedQnaSourceAllowed({ workspace_id: 'ws-b', status: 'approved' }, 'ws-a')).toBe(false);
  });
});

describe('isFileSourceAllowed — F1', () => {
  it('active + source_type=file -> allowed', () => {
    expect(isFileSourceAllowed({ workspace_id: 'ws-a', status: 'active', source_type: 'file' }, 'ws-a')).toBe(true);
  });
  it('inactive -> denied', () => {
    expect(isFileSourceAllowed({ workspace_id: 'ws-a', status: 'paused', source_type: 'file' }, 'ws-a')).toBe(false);
  });
  it('wrong source_type (website) -> denied', () => {
    expect(isFileSourceAllowed({ workspace_id: 'ws-a', status: 'active', source_type: 'website' }, 'ws-a')).toBe(false);
  });
  it('wrong workspace -> denied', () => {
    expect(isFileSourceAllowed({ workspace_id: 'ws-b', status: 'active', source_type: 'file' }, 'ws-a')).toBe(false);
  });
});

describe('isWebsiteSourceAllowed — WEB1', () => {
  it('active + source_type=website -> allowed', () => {
    expect(isWebsiteSourceAllowed({ workspace_id: 'ws-a', status: 'active', source_type: 'website' }, 'ws-a')).toBe(true);
  });
  it('inactive -> denied', () => {
    expect(isWebsiteSourceAllowed({ workspace_id: 'ws-a', status: 'failed', source_type: 'website' }, 'ws-a')).toBe(false);
  });
  it('wrong source_type (file) -> denied', () => {
    expect(isWebsiteSourceAllowed({ workspace_id: 'ws-a', status: 'active', source_type: 'file' }, 'ws-a')).toBe(false);
  });
  it('wrong workspace -> denied', () => {
    expect(isWebsiteSourceAllowed({ workspace_id: 'ws-b', status: 'active', source_type: 'website' }, 'ws-a')).toBe(false);
  });
});
