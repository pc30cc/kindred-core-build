/**
 * Generic Verification Core Super Admin management layer — static
 * no-secrets guard. The readiness/audit/preview surfaces are documented as
 * "never return pepper values, provider credentials, or service-role keys";
 * this asserts that promise at the source level for every new frontend file
 * (bundle-reachable code) and confirms none of it touches browser storage,
 * which the runtime/readiness spec never asked for and which would be an
 * unreviewed place for something sensitive to leak into.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const FRONTEND_FILES = [
  'src/hooks/useVerificationAdmin.ts',
  'src/pages/admin/VerificationPage.tsx',
];

// Deliberately scoped to concrete secret-shaped access, not the word
// "pepper" itself — the safe `pepperConfigured` boolean and the
// `PEPPER_RING_INVALID`/`PEPPER_MISSING` error codes are expected,
// documented, non-secret identifiers rendered by this page.
const FORBIDDEN_PATTERNS = [
  /process\.env/,
  /service[_-]?role[_-]?key/i,
  /SUPABASE_SERVICE_ROLE/,
  /pepper\s*[:=]\s*['"`]/i,
];

describe('Generic Verification Core admin UI — no secrets in frontend-bundle source', () => {
  for (const path of FRONTEND_FILES) {
    const src = readFileSync(path, 'utf8');

    it(`${path} never reads env vars or references service-role/pepper material by value`, () => {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(src).not.toMatch(pattern);
      }
    });

    it(`${path} never writes verification admin data to browser storage`, () => {
      expect(src).not.toMatch(/localStorage|sessionStorage/);
    });
  }
});
