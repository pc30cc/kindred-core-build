---
name: KB unification (Articles + AI Knowledge merge)
description: 4-phase plan to unify main-menu Knowledge Base with AI Agent Knowledge into one hub
type: feature
---
Goal: merge main-menu "Knowledge Base" with AI Agent "Knowledge" into a single hub under AI Agent.

Phase 1 (DONE): Add new "Articles" tab inside AI Agent sidebar that renders existing KnowledgeBasePage. Rename existing "Knowledge" tab to "Knowledge Sources".
  - File: src/components/layout/AiAgentLayout.tsx (add articles nav item, rename knowledge label)
  - File: src/pages/app/ai-agent/ArticlesPage.tsx (new, re-renders KnowledgeBasePage)
  - Routes: /ai-agent/articles
  - i18n: aiAgent.nav.articles + rename aiAgent.nav.knowledge -> Knowledge Sources (fa/en/tr)

Phase 3 (DONE): Redirect old "Knowledge Base" entry points to new tab.
  - src/App.tsx: /settings/knowledge-base -> Navigate to /ai-agent/articles; /knowledge-base legacy redirect updated to /ai-agent/articles
  - src/components/layout/AppSidebar.tsx: knowledgeBase main nav path -> /ai-agent/articles
  - src/components/layout/SettingsLayout.tsx: remove "Articles" sub-item from Knowledge Base group (keep Translations)

Phase 2 (DONE): Added `visible_in_widget` and `used_by_ai` boolean columns (default true) + partial indexes on knowledge_base_articles. Editor exposes two switches; list shows "Hidden from widget" / "AI off" badges. Types + i18n (fa/en/tr) updated.

Phase 4 (DONE): Backend respects both flags as single source of truth:
  - server/routes/widget.ts (help-center + /kb endpoints): filter visible_in_widget = true
  - server/services/ai-agent/retrieval.ts + retrievalHybrid.ts: filter used_by_ai = true (both keyword and post-rerank eligibility checks)
  - server/services/ai-agent/knowledgeIndex/sync.ts: when used_by_ai=false, drop chunks; bulk sync skips disabled
  - server/services/ai-agent/sourceHealth.ts: new HealthReason 'kb_disabled_for_ai' (translated, rendered as "disabled" tone in Knowledge Sources page)

Constraint: Do NOT delete the existing KnowledgeBasePage component or its routes/data — only re-point navigation. Both AI Agent Knowledge (Sources) and Articles tabs coexist; Sources stays read-only summary.