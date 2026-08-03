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
import { readFileSync, readdirSync } from 'node:fs';
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

  // ── Phase 6-S5-R7.4 ────────────────────────────────────────

  it('calls ai_kb_builder a FEATURE, never a module, in the customer surface', () => {
    for (const f of [
      'src/components/app/knowledge/AiKbBuilderTab.tsx',
      'src/lib/ai-kb-api.ts',
    ]) {
      const src = read(f);
      // A capability sold inside a plan is a feature; "module" is the
      // platform-level concept and reading it as one misleads support.
      expect(
        /ai_kb_builder\s+module|module\s+ai_kb_builder|AI Knowledge Builder module/i.test(src),
        `${f} describes ai_kb_builder as a module`,
      ).toBe(false);
    }
  });

  it('blocks the builder on ai_assistant AND ai_kb_builder together', () => {
    const ui = read('src/components/app/knowledge/AiKbBuilderTab.tsx');
    expect(ui).toMatch(/modules\.ai_assistant/);
    expect(ui).toMatch(/modules\.ai_kb_builder/);
  });

  it('loads the access state before any private job data', () => {
    const ui = read('src/components/app/knowledge/AiKbBuilderTab.tsx');
    const source = ui.indexOf('aiKbApi.getSource');
    const jobs = ui.indexOf('aiKbApi.listJobs');
    expect(source).toBeGreaterThanOrEqual(0);
    expect(jobs).toBeGreaterThan(source);
  });

  it('never leaves the surface in a permanent loading state on failure', () => {
    const ui = read('src/components/app/knowledge/AiKbBuilderTab.tsx');
    // An explicit state machine, not `src === null` doubling as loading.
    expect(ui).toMatch(/AiKbSurfaceState/);
    expect(ui).toMatch(/data-testid="aikb-retry"/);
  });

  it('preserves structured API error bodies on AiKbApiError', () => {
    const api = read('src/lib/ai-kb-api.ts');
    expect(api).toMatch(/class AiKbApiError/);
    expect(api).toMatch(/\bstatus\b/);
    expect(api).toMatch(/retryable/);
  });

  it('treats a malformed numeric entitlement limit as unavailable', () => {
    const parse = read('server/services/billing/entitlementParse.ts');
    expect(parse).toMatch(/parseNumericEntitlementResponse/);
    expect(parse).toMatch(/Number\.isFinite/);
  });

  it('returns outage semantics from every shared gating middleware', () => {
    const gating = read('server/middleware/featureGating.ts');
    for (const code of [
      'entitlement_status_unavailable',
      'module_status_unavailable',
      'ai_credit_status_unavailable',
    ]) {
      expect(gating).toContain(code);
    }
    expect(gating).toMatch(/503/);
  });

  it('ships a role-guarded ACL migration and its Supabase mirror', () => {
    const sql = read('database/migrations/012_ai_kb_acl_reassert_guarded.sql');
    expect(sql).toMatch(/FROM pg_roles WHERE rolname = 'service_role'/);
    expect(sql).toMatch(/to_regprocedure/);
    const mirror = readdirSync(resolve(process.cwd(), 'supabase/migrations')).find((f) =>
      f.endsWith('_ai_kb_acl_reassert_guarded.sql'),
    );
    expect(mirror, 'missing Supabase mirror for migration 012').toBeTruthy();
    expect(read(`supabase/migrations/${mirror}`)).toBe(sql);
  });

  it('bootstraps the self-host roles idempotently before 001', () => {
    const sql = read('database/migrations/000_selfhost_roles_bootstrap.sql');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(sql).toContain(`rolname = '${role}'`);
      expect(sql).toMatch(new RegExp(`CREATE ROLE ${role}\\b`));
    }
    expect(sql).not.toMatch(/\bALTER ROLE\b/);
  });

  it('enforces the lint baseline and the clean-install proof in CI', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/npm run lint:baseline/);
    expect(ci).toMatch(/cleanInstallMigrationChain\.pg\.test\.ts/);
    const baseline = JSON.parse(read('.lint-baseline.json'));
    expect(typeof baseline.totals.problems).toBe('number');
  });
});
