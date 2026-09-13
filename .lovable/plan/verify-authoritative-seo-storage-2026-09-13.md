# Verify authoritative SEO storage

## Scope and verified baseline
Complete only authoritative storage, production backfill, and crawl verification. Keep migrations 169–173 immutable, legacy data intact, and cleanup disabled throughout.

Live baseline checked this turn: **201 legacy pages, 3,502 legacy links, 2 successful crawls, 0 canonical URLs, 0 observations, 0 memberships, 0 enabled destructive policies**.

## Implementation
1. Complete the writer/reader inventory, including issue-page references, worker finalization, performance selection, analytics, comparisons and exports. Establish compatibility before stopping legacy writes.
2. Route new crawls through one canonical repository. Use atomic, scoped writes and deterministic hashes; unchanged and unchanged-restored URLs reuse observations. Record removals only after a complete successful crawl. Maintain a direct current-observation reference and compact crawl summaries.
3. Preserve historical link reporting using versioned outgoing link sets, reused when unchanged. Keep per-crawl measurements separate from content identity. Move all detail readers behind one compatibility layer with explicit per-crawl migration status; errors must not silently fall back.
4. Implement bounded chronological backfill using the same normalization, hashing and write rules as live crawls. Reuse existing jobs where suitable; persist cursors, counters, errors and completion validation. Preserve legacy IDs needed by reports and issue references. Resume safely after interruption without duplicate rows or overwriting newer current state.
5. Apply only necessary forward migrations numbered 174+. Run controlled production backfill and rerun it to verify idempotency. Validate full payload/link parity before declaring each crawl migrated and preferring canonical reads.
6. Verify the actual crawler with deterministic crawls A–E: initial, identical, one changed URL, one removed URL, unchanged restoration. Capture exact URL/observation/membership/legacy-row deltas and state counts at every step. Add a regression guard preventing direct legacy writes outside the explicitly bounded compatibility layer.

## Technical verification
- Exercise atomicity, retry/concurrency, canonical and membership uniqueness, workspace/site isolation, current-state lookup, report compatibility, chronological backfill and interrupted resumption.
- Production validation: legacy counts, successful crawls, canonical URLs, observations, memberships, unchanged memberships, duplicate identities/memberships, orphan rows, missing URLs and missing crawl coverage.
- Test latest-five eligibility per workspace/site; protect current observations, canonical identities, timestamps, summaries and active references. Leave existing cleanup fences unchanged.
- Run targeted database, SEO, crawler, backfill and retention tests plus lint; inspect automated typecheck/build results. Use EXPLAIN for current-state and historical access.
- Distinguish real database experiments from in-memory tests. Report row counts and estimated bytes separately; do not invent unmeasured storage savings.

## Delivery gate
Report repository/write paths, remaining legacy dependencies, production backfill parity and rerun results, exact A–E deltas, read-path coverage, deduplication metrics, tests and cleanup status.

Declare **READY — AUTHORITATIVE SEO STORAGE VERIFIED** only after production backfill and compatible reads are verified, Crawl B adds no full observations or legacy duplicate rows, canonical duplicates/orphans are zero, and cleanup remains disabled. Otherwise report precise blockers and **NOT READY — AUTHORITATIVE SEO STORAGE STILL INCOMPLETE**.