# Legacy Identifier Migration Plan (Design Only)

Status: design artifact. No phase below is approved for execution. Execution
requires a separate explicit decision per ADR-002.

This plan is the operational blueprint that *would* be followed if a future
rename of a contract-bearing legacy identifier is ever justified. Items in
scope are listed in `docs/LEGACY_IDENTIFIER_INVENTORY.md` and classified in
`docs/LEGACY_NAMING_DECISION_MATRIX.md`.

Items marked **NEVER RENAME** in the matrix are out of scope of this plan
entirely.

---

## Phase 0 — Observe and Inventory

- Objective: confirm the inventory is current; baseline reality.
- Scope: re-run grep against the repo, compare with
  `docs/LEGACY_IDENTIFIER_INVENTORY.md`, reconcile drift.
- Allowed changes: documentation only.
- Forbidden: any code rename, any contract change.
- Safeguards: PR review by a maintainer familiar with widget contract.
- Tests: none (docs only).
- Telemetry: none required.
- Rollback: revert doc PR.
- Exit criteria: inventory matches the codebase verbatim.

## Phase 1 — Document and Instrument

- Objective: make legacy-identifier *usage* measurable before any change.
- Scope:
  - Add (server-side, optional) a low-cardinality counter when the loader is
    served, tagged with snippet shape detected (e.g. presence of
    `window.__gs` queue vs hypothetical successor).
  - Add a console-tagged debug line behind `window.__gs_debug` only.
  - Document operator-visible grep patterns explicitly.
- Allowed: new metrics, new debug-only logs, new docs.
- Forbidden: any rename; any change to public globals, DOM, asset paths.
- Safeguards: instrumentation must be additive and feature-flagged.
- Tests: existing widget regression suite must remain green.
- Telemetry: new counters baselined for ≥ 30 days.
- Rollback: disable feature flag; revert metric.
- Exit criteria: ≥ 30 days of clean baseline data on legacy-identifier usage.

## Phase 2 — Introduce Aliases / Dual-Read / Dual-Log

- Objective: stand up the *new* identifier next to the legacy one, read both,
  log both, change behavior of neither.
- Scope (per item, only if its matrix row allows aliasing):
  - Runtime globals: write to both `window.__gs_*` and the new name; read
    from either, prefer legacy first (no behavior change).
  - CSS hooks: emit both classes on the element (`gs-launcher` AND new).
  - Custom element: keep `<gs-widget>`. Optionally register a new tag that
    delegates to the same shadow root implementation. Default usage stays
    legacy.
  - Server package name: introduce a workspace-level alias / npm `name`
    field strategy *only if* tooling supports it without lockfile churn;
    otherwise defer to Phase 4.
  - Startup log: emit a single line containing both old and new wording
    (`"Growth Suite server running on port X (Kindred Core)"`) so existing
    grep keeps matching.
- Allowed: additive code paths only.
- Forbidden: removing or shortening any legacy emission. No change to
  `window.__gs` embed snippet contract. No asset URL change. No manifest
  field rename.
- Safeguards: feature flag per alias; A/B served from CDN with old as
  default.
- Tests:
  - Loader contract test: legacy snippet still bootstraps.
  - DOM test: both classes present on launcher.
  - Globals test: both names readable, value identical.
- Telemetry: track adoption of new name vs legacy name where measurable.
- Rollback: flip feature flag, redeploy bundle, CDN purge.
- Exit criteria: dual-emission stable for ≥ 60 days; no regression
  reported.

## Phase 3 — Migrate Internal-Only Identifiers

- Objective: rename the items classified as low-risk / internal-only.
  Candidates from the matrix: server package name (`growth-suite-server`),
  worker example image tag (`growth-suite-worker`), startup log primary
  wording, internal shadow-DOM-only classes (`.shell`, `.panel`).
- Allowed: PR-by-PR rename of internal-only items, each with its own
  CHANGELOG entry and `NAMING.md` update.
- Forbidden: touching any item classified NEVER RENAME or
  PHASED-ROLLOUT-ONLY in the matrix.
- Safeguards:
  - Server package rename ships with a meta-package or alias to absorb
    lockfile/Docker references for one release cycle.
  - Startup log keeps a parenthetical legacy phrase to preserve grep.
- Tests: full server boot + worker boot + widget regression.
- Telemetry: error budget watch for one release cycle.
- Rollback: per-PR revert; releases are independently revertible.
- Exit criteria: internal-only items renamed; legacy aliases retained where
  externally observable.

## Phase 4 — Deprecate Legacy Paths/Contracts (Telemetry-Gated)

- Objective: only after Phase 2 telemetry shows < 0.1% reliance on a given
  legacy identifier, mark it deprecated. No removal yet.
- Allowed: console deprecation warnings (debug-only), docs marking the
  legacy name as deprecated, changelog announcements with a sunset date no
  earlier than +90 days.
- Forbidden: removal; behavior change; warning visible to end users.
- Safeguards: deprecation warning gated behind `window.__gs_debug`.
- Tests: regression suite green; no new console noise on default config.
- Telemetry: continuous; if usage rises again, re-enter Phase 2.
- Rollback: drop the deprecation marker.
- Exit criteria: ≥ 90 days post-announcement, telemetry still under
  threshold.

## Phase 5 — Remove Legacy Layer (Hard Migration)

- Objective: remove the legacy alias entirely.
- Allowed: deletion of the dual-emission code path for the *specific*
  identifier whose Phase 4 sunset window has elapsed.
- Forbidden: bulk removal; touching items still in Phase 2/3/4.
- Safeguards:
  - Asset URL changes in particular require a new versioned path; the old
    path must continue to serve a *compatibility shim* that loads the new
    bundle, not a 404.
  - `window.__gs` embed queue (item 8 in inventory) is excluded from this
    phase entirely under ADR-002.
- Tests: full widget contract regression, including a fixture of an
  unmodified legacy customer snippet.
- Telemetry: post-removal monitoring for 14 days.
- Rollback: re-introduce the alias. The Phase 2 dual-emission code must
  remain in version control history with a clear restore path.
- Exit criteria: legacy identifier removed for the specific item with no
  regression.

---

## What is permanently excluded from this plan

Per ADR-002 and the decision matrix, the following are not subject to any
phase of this plan and remain frozen:

- `window.__gs` and `window.__gs_id` embed-snippet contract
- `/widget/loader.js` URL and the widget asset URL family
- The widget asset manifest field shape
- Env-var names already in operator `.env` files
- `SELF_HOST_GUIDE.md` filename

Any change to these requires a new ADR superseding ADR-002.