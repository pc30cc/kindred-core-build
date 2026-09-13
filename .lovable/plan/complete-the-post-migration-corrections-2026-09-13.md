# Complete the post-migration corrections

## Verified audit outcome
- Migrations 169/170 remain byte-identical to the recorded checksums. Their top-level statements create schema/functions and seed policies; they do not execute destructive DELETE or DROP. Historical row changes cannot be reconstructed from current counts alone.
- Live inventory: five tables, 84 columns, 21 indexes and 29 constraints. All five tables have RLS and deny browser-role SELECT.
- Recorded live counts: 22 policies (13 permanent, nine disabled destructive policies); 201 legacy pages, 3,502 legacy links; zero canonical URLs, observations or memberships. Backfill is incomplete.
- Six maintenance functions were publicly executable. Forward-only migration 171 revoked browser/public execution, retained service-role execution and fenced both destructive cleanup functions. Subsequent privilege checks confirmed these ACLs.
- The corrective migration does not delete legacy data, run backfill or change policy settings. A matching migration 171 is now saved for self-host deployments.
- Existing regression suite: 77 tests passed across 11 files. This does not validate the requested new storage scenarios.

## Status and remaining blockers
**Retention: contained but incomplete.** Generic processing lacks workspace scope; archive storage is unavailable; permanent-mode checks are not a substitute for immutable protected-table enforcement. Cleanup remains blocked at the database boundary.

**SEO storage: incomplete dual-write implementation with legacy-authoritative reads.** Legacy `seo_links` inserts remain in the crawler. Reports, page lists, rule evaluation, link graphs and performance audits still use legacy tables. Backfill omits observation payloads, and removal finalization loads unbounded URL sets. No production storage cutover is approved.

Current empty new tables cannot prove correct backfill, cross-workspace isolation or absence of future orphans. Full workspace/site/crawl counts, historical mutation evidence and detailed trigger/FK inventory remain to be collected. Unrelated security-linter findings are not considered resolved.

## Corrective work
1. Complete read-only production inventory and save exact counts, constraints, triggers, function definitions, policy seeds, duplicate/orphan checks and legacy/backfill status in an audit report.
2. Add forward-only migrations numbered 172 or later for protected-table enforcement and workspace-scoped execution. Keep destructive cleanup disabled and fenced.
3. Consolidate canonical crawler writes, consistent normalization and hashing, transaction-safe observation/membership updates, and bounded removal finalization. Preserve legacy link data and existing report behavior.
4. Implement resumable, bounded, payload-preserving backfill with checkpoints and idempotency; validate on fixtures before proposing any production backfill.
5. Define one explicit compatibility layer for all SEO read paths, including reports, comparisons, exports and APIs; retain legacy authoritative reads until parity is demonstrated.
6. Implement safe latest-five eligibility while preserving observation references, canonical identities, aggregates and active reports/jobs. Do not enable deletion.
7. Add the requested tests: repeated identical crawls, changed/removed/restored pages, workspace/site isolation, backfill restart/idempotency, dry-run immutability, protected-policy rejection and latest-N calculation.
8. Publish the complete evidence report and readiness verdict. Do not claim readiness until remaining checks pass.

## Technical safeguards
- Never edit or re-run migrations 169/170; no automatic rollback.
- Never drop, truncate or destructively clean legacy SEO data.
- Database corrections use only new forward migrations; application changes preserve billing, workspaces and crawl/report behavior.
- Keep migration 171's safety fence until explicitly reviewed replacement protections pass integration tests.

NOT READY — CORRECTIVE WORK REQUIRED
