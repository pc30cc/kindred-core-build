---
name: Retention and SEO production history
description: Applied migration immutability and production audit safety requirements
type: constraint
---
Migrations 169 and 170 are already applied in production. Never modify, rename, rewrite, or re-run their historical contents. Use new forward-only corrective migrations numbered 171 or later. Never automatically roll back production. Do not drop/truncate seo_links or enable destructive cleanup. Readiness requires live schema, crawler writes, compatible reads, backfill, protections, and tests to be verified, not merely successful migration execution.