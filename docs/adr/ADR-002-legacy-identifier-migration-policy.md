# ADR-002: If/When to Rename Compatibility-Sensitive Runtime Identifiers

- Status: Accepted (policy); migration itself NOT approved
- Date: 2026-06-19
- Depends on: ADR-001

## Context

ADR-001 establishes that legacy identifiers crossing a contract boundary are
preserved as-is. This ADR defines the *policy* under which a future rename
could be considered, and the mechanics it would require.

The contract surfaces in scope are enumerated in
`docs/LEGACY_IDENTIFIER_INVENTORY.md`. The most sensitive items are:

- `window.__gs`, `window.__gs_id` (public embed snippet)
- `<gs-widget>` custom element host
- `window.__gs_runtime` and the `window.__gs_*` global family
- `.gs-launcher` (CSS hook customers may override)
- `/widget/loader.js` and the asset path family
- The widget asset manifest field shape
- Env vars and the server package name

## Problem

A future rename (e.g. moving widget globals from `__gs_*` to `__kc_*`) is
technically possible but operationally hazardous. Without a documented
policy, any attempt risks:

- breaking deployed customer snippets at cache rollover
- desynchronizing loader / runtime / call modules served from CDN at
  different ages
- silently breaking customer CSS overrides on `.gs-launcher`
- invalidating ops grep patterns and alerting rules
- breaking Docker tags and CI references on `growth-suite-server`

## Decision

A rename of any contract-bearing legacy identifier is permitted **only**
under the following conditions, all of which must be satisfied:

1. **Justification.** A concrete, documented benefit exists beyond cosmetic
   coherence (e.g. legal, security, trademark, or a hard technical
   requirement). Cosmetic uniformity is *not* sufficient justification.
2. **Phased plan.** A plan exists matching `docs/LEGACY_MIGRATION_PLAN.md`
   (Phases 0–5) and is explicitly approved.
3. **Dual contract window.** Both old and new identifiers are served
   simultaneously for a sunset window of at least one full browser-cache
   horizon plus one full operator deploy cycle (recommended floor: 90 days).
4. **Telemetry.** Usage of the legacy identifier is measurable. Removal is
   gated on telemetry showing < 0.1% of traffic still depends on it.
5. **Rollback.** A documented one-step rollback exists for every phase.
6. **No silent renames.** Every rename ships with a `NAMING.md` /
   `LEGACY_IDENTIFIER_INVENTORY.md` update and a CHANGELOG entry.

## Why aggressive renaming is rejected today

- No customer benefit. Customers neither see nor type these identifiers.
- High blast radius. Every embedded customer snippet is a long-lived,
  unupdatable artifact in the wild.
- No telemetry today on legacy-identifier usage; preconditions are not met.
- The previous cleanup pass already removed every cosmetic occurrence; what
  remains is structurally load-bearing.

## Conditions that would justify revisiting

- Legal/trademark obligation to remove the legacy string.
- A security incident where the legacy global namespace is exploitable in a
  way the new one would not be.
- A concrete platform initiative (e.g. multi-runtime coexistence) that
  technically requires a new prefix.

## Alternatives considered

- **Permanent freeze, no policy.** Rejected: leaves future maintainers with
  no playbook if a real reason ever appears.
- **Open-ended “rename when convenient.”** Rejected: accumulates risk
  silently; no preconditions.

## Operational implications

- All new widget surfaces (new globals, new DOM hooks) added from now on
  SHOULD be neutral / Kindred-Core-friendly so future migration scope
  shrinks rather than grows.
- The decision matrix in `docs/LEGACY_NAMING_DECISION_MATRIX.md` is the
  source of truth for which items are subject to this policy.