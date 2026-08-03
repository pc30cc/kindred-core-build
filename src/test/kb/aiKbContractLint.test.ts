/**
 * Phase 6-S5-R7.3 — NON-REGRESSION LINT.
 *
 * These are structural assertions, not behaviour tests. They fail the build if
 * a future change reintroduces a class of defect that R7.x closed:
 *   - unbounded row spreads / `select('*')` on customer-facing AI-KB reads
 *   - raw internal failure text reaching a response body
 *   - Help Center links built from the DRAFT slug instead of the published one
 *   - fail-open reads that turn an unreadable state into an empty state
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('AI-KB response contract lint', () => {
  it('never selects * in the AI-KB routes', () => {
    const src = read('server/routes/aiKb.ts');
    expect(src).not.toMatch(/\.select\(\s*['"`]\*/);
  });

  it('never returns raw error_message to a client', () => {
    const src = read('server/routes/aiKb.ts');
    // `error_message` may be READ (it feeds toPublicErrorCode) but must never
    // be placed into a JSON response literal.
    expect(src).not.toMatch(/error_message\s*:\s*[^,}]*error_message/);
    expect(src).not.toMatch(/res\.(status\(\d+\)\.)?json\([^)]*\berror_message\b/);
  });

  it('never spreads a database row into a response', () => {
    const src = read('server/routes/aiKb.ts');
    expect(src).not.toMatch(/json\(\{\s*\.\.\.(job|row|data|article|generated)\b/);
  });

  it('exposes public_path only from the resolved KB article', () => {
    const dto = read('server/services/ai-kb/dto.ts');
    // The canonical path must be derived from the linked article, never the
    // draft row, otherwise a de-duplicated slug produces a 404 link.
    expect(dto).toMatch(/function toPublicHelpPath\(/);
    expect(dto).toMatch(/public_path:\s*toPublicHelpPath\(linked\)/);
  });

  it('builds Help Center links in the UI from public_path only', () => {
    const ui = read('src/components/app/knowledge/AiKbBuilderTab.tsx');
    expect(ui).toMatch(/g\.public_path/);
    expect(ui).not.toMatch(/\/help\/\$\{/);
  });

  it('keeps every AI-KB read model fail-closed', () => {
    for (const f of [
      'server/services/ai-kb/sourceDomain.ts',
      'server/services/ai-kb/limits.ts',
      'server/services/ai-kb/credits.ts',
    ]) {
      expect(read(f)).toMatch(/readFailed\(/);
    }
  });

  it('never caches an unreadable entitlement response', () => {
    const gating = read('server/middleware/featureGating.ts');
    expect(gating).toMatch(/parseEntitlementResponse/);
  });
});
