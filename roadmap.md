# Roadmap

- [ ] Audit live SEO storage and publish concrete writer/reader inventory and baseline counts.
- [ ] Complete the three remaining SEO blockers: authoritative storage/read compatibility, safe production backfill, and A–E crawl verification; use migrations 174+ only and keep 169–173 immutable.
- [ ] Verify actual identical crawls, exact row deltas, isolation, history, summaries and retention eligibility; cleanup remains disabled and legacy data intact.

- [x] Fix all active preview typecheck errors in genericVerificationCore integration tests
- [ ] Complete hosted/self-host v5.1 migration chain and legal policy bootstrap
- [ ] Retire legacy invitation API and wire atomic offboarding
- [ ] Make invitation idempotency and acceptance retries transaction-safe
- [ ] Complete existing-user login/acceptance frontend flow
- [ ] Replace legacy invitation management UI with v5.1 API
- [ ] Harden mail relay, worker startup, templates, and secrets
- [ ] Add PostgreSQL/API/UI security and concurrency tests plus CI evidence
- [ ] Run verification and resolve diagnostics

## Backup and recovery acceptance
- [ ] Verify actual production host, off-site repository, encryption and object backup access (blocked: infrastructure access unavailable).
- [ ] Correct and validate disabled operational drafts before enabling any command.
- [ ] Complete FA/TR/EN admin diagnostics and monitoring.
- [ ] Execute isolated full restore and timestamp PITR with production backup evidence.
- [ ] Run focused and baseline regression tests; do not claim zero new failures without results.

