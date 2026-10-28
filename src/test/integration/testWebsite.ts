/**
 * The website an owner signs up with in these suites (required since the
 * owner's rule of 2026-10-28, server/services/ownerWebsite.ts). A verified
 * domain belongs to one workspace on the platform, and the suites share one
 * database, so each signup's email (unique there already) names its own.
 */
export function websiteFor(email: string): string {
  const label = email.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50).replace(/^-+|-+$/g, '');
  return `${label}.example`;
}
