// @vitest-environment node
/**
 * The vote counts the operators' article list carries
 * (GET /api/knowledge-base/articles → `feedback`): 'up' helpful, 'down' not
 * helpful, and 'neutral' (the middle face a template may draw; the CHECK
 * accepts it from migration 275) counted on its own, so a vote a visitor
 * moves from up to neutral is not simply lost.
 */
import { describe, expect, it } from 'vitest';
import { countArticleFeedback } from '../../../server/routes/knowledgeBase';

describe('countArticleFeedback', () => {
  it('counts up, neutral and down per article; an unknown rating counts nowhere', () => {
    expect(countArticleFeedback([
      { article_id: 'a', rating: 'up' },
      { article_id: 'a', rating: 'neutral' },
      { article_id: 'a', rating: 'down' },
      { article_id: 'a', rating: 'up' },
      { article_id: 'b', rating: 'neutral' },
      { article_id: 'b', rating: null },
      { article_id: 'c', rating: 'sideways' },
    ])).toEqual({
      a: { helpful: 2, neutral: 1, notHelpful: 1 },
      b: { helpful: 0, neutral: 1, notHelpful: 0 },
      c: { helpful: 0, neutral: 0, notHelpful: 0 },
    });
    expect(countArticleFeedback([])).toEqual({});
  });
});
