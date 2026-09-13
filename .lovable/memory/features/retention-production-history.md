---
name: Retention and SEO production history
description: Applied migration immutability and production audit safety requirements
type: constraint
---
Migrations 169, 170, 171 and 172 are already applied in production and immutable. Never modify, rename, rewrite, or re-run their historical contents. Use new forward-only corrective migrations numbered 173 or later. Never automatically roll back production. Do not delete/drop/truncate legacy seo_links or seo_pages or enable destructive cleanup. Complete only remaining SEO storage corrections. Readiness requires the actual crawler identical-crawl experiment, compatible reads, resumable payload-preserving backfill, workspace/site isolation and verified exact row deltas; the second identical crawl must avoid duplicated full observations. Keep retention cleanup fenced even after verification.