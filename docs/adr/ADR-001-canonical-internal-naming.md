# ADR-001: Canonical Internal Naming vs Compatibility-Preserved Legacy Identifiers

- Status: Accepted
- Date: 2026-06-19
- Owners: Platform / Kindred Core maintainers

## Context

The platform is a self-hosted, white-label, provider-driven SaaS product. The
internal documentation-level canonical name is **Kindred Core**. Customer-facing
branding is dynamic per deployment and resolved at runtime through
`useBrandingContext()` / `usePlatformBranding()`.

The repository carries legacy identifiers from earlier codenames (notably
"Growth Suite" and the `gs-` widget prefix family) that are now embedded in:

- the public widget embed snippet (`window.__gs`, `window.__gs_id`)
- the runtime DOM contract (`<gs-widget>`, `.gs-launcher`)
- runtime globals shared across loader/runtime/call modules (`window.__gs_*`)
- the server package name (`growth-suite-server`)
- the self-host guide title and example image tags
- ops-grep targets (startup log, devtools log prefixes)

See `docs/LEGACY_IDENTIFIER_INVENTORY.md` for the complete list with files,
visibility, and externalization classification.

## Problem

Two competing pressures:

1. Internal coherence: new contributors and docs benefit from a single
   canonical name (Kindred Core) and removing confusing legacy strings.
2. Compatibility: many of the legacy identifiers are *contract surfaces* —
   baked into customer HTML, browser caches, CDN-served assets, operator
   `.env` files, runbooks, and Docker image tags. Renaming them is a breaking
   change with a long tail of silent failures.

Past cleanup passes have already removed all source comments, source-only
brand strings, and the hardcoded "Growth Suite" UI literal in
`ProfilePage.tsx`. What remains is exclusively contract-bearing or
ops-bearing identifiers.

## Constraints

- The widget loader URL shape, manifest field names, and `window.__gs*`
  globals are public contract.
- The server package name is referenced by Dockerfiles, lockfiles, and
  potentially external CI.
- The self-host guide filename is linked externally.
- The platform is white-label: no customer-facing string may regress to a
  hardcoded brand.

## Decision

1. **Kindred Core** is the canonical *internal* name. It is used in
   documentation, ADRs, internal team communication, and new internal-only
   identifiers going forward.
2. **Legacy identifiers that cross a contract boundary are preserved as-is.**
   They are documented, not renamed. The contract boundary includes:
   browser-cached assets, customer HTML snippets, Docker tags, operator env
   files, and grep-bearing log lines.
3. **Customer-facing strings remain runtime-driven** through the branding
   context. No legacy brand string may appear in rendered UI.
4. Future rename work, if ever justified, follows ADR-002 (phased migration
   policy with aliasing and telemetry). No rename happens implicitly.

## Alternatives considered

- **Aggressive rename to `kc-` / `__kc_` family.** Rejected: silently breaks
  every deployed customer snippet on cache transition, and requires
  coordinated CDN invalidation, dual-bundle serving, and operator migration
  windows for zero user benefit.
- **Half rename (internal files only, leave public contract).** Rejected:
  produces the worst of both worlds — split brain between code and contract,
  more confusion not less.
- **Do nothing / no policy.** Rejected: leaves future contributors with no
  guidance and invites accidental renames.

## Risks

- Contributors may attempt cosmetic renames in PRs without understanding the
  contract surface. Mitigation: this ADR + `NAMING.md` callouts.
- The legacy prefix may continue to leak into customer support transcripts.
  Acceptable: it is a stable, greppable identifier.

## Operational implications

- New runtime globals, classes, and DOM hooks added from now on SHOULD use a
  neutral, internal-friendly prefix (e.g. `kc-` for new-only surfaces) **only
  when they are not part of the existing widget contract bundle**. Mixing
  prefixes inside the existing `gs-` widget bundle is forbidden until a
  coordinated migration (ADR-002) is approved.
- Docs and ADRs use "Kindred Core". Code comments referring to the platform
  should also use "Kindred Core" or remain neutral.