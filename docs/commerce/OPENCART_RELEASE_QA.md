# OpenCart 1.1.2 release QA — 2026-09-25

## Isolated real-store matrix

Tests ran in a disposable, memory-limited container with independent MariaDB data, three real OpenCart installations, two stores per installation, fixture customers, and throwaway update signing keys. The demo shop and its database were not used for destructive tests.

| OpenCart | PHP API scenarios | TypeScript live-store integration | Admin checks | Signed self-update | Upgrade |
| --- | --- | --- | --- | --- | --- |
| 3.0.5.1 | 69/69 | 17/17 | 19/19 | 23/23 | Passed |
| 4.1.0.0 | 69/69 | 17/17 | 19/19 | 24/24 | Passed |
| 4.1.0.4 | 69/69 | 17/17 | 19/19 | 24/24 | Passed |

The live-store integration exercises the actual PHP store, signed connector, gateway, customer identity bridge, contact merge logic and AI evidence stage. WebYar's database remains an instrumented in-memory client; this is not a full deployed browser-to-Postgres test.

Verified scenarios include anonymous-contact enrichment at login, no repeated contact writes for unchanged identity, contact retention after logout, rejection of account replacement on the old visitor, binding a new visitor for the second account, customer/store isolation, stale-session denial, actual prices and customer-group pricing, cache coalescing/bounds, deadlines and circuit breaking. Upgrades retained connection data and one event registration.

## Other gates

- Local commerce/widget/security tests: 446 passed.
- Previously PHP-dependent updater/icon tests: 24 passed in the isolated environment.
- OpenCart PHP unit suite: 93 passed, zero failures.
- Type checks passed. Four explicit-any lint findings in the shared contact module were corrected without disabling the lint gate.
- Earlier GitHub run passed 512 test files, production build, Widget Quality, invitations, PostgreSQL integration, financial tests and all three migration-chain jobs; its only blocking job failure was the four lint findings above. The follow-up commit must also pass GitHub checks.
- Rebuilt ZIP member contents matched signed packages exactly. The reproducibility warning was due to ZIP metadata differences (47 OC4 and 46 OC3 entries), not changed PHP code; signed release archives were preserved.

## Browser and deployment boundary

The original demo browser tests verified login, four orders, product prices/discounts, guest denial, nonexistent orders and merchant tracking codes. The standalone browser automation in the local harness was not run because this environment requires the supported browser runtime.

Final application deployment acceptance remains separate: verify the corrected exact store name and tracking wording, contact/profile refresh, logout/account-switch UI, and Super Admin controls against the deployed PR. Passing the isolated matrix does not claim that PR #129 has been merged or deployed.
