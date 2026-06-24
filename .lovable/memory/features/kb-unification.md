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

Phase 2 (TODO): Add `visible_in_widget` and `used_by_ai` boolean flags to public.knowledge_base_articles via migration; expose toggles in editor UI; backend filters widget queries by visible_in_widget and AI sync by used_by_ai.

Phase 4 (TODO): Backend API integration so AI Agent Knowledge Sources view shows the unified articles (single source of truth across editor + AI sources panel).

Constraint: Do NOT delete the existing KnowledgeBasePage component or its routes/data — only re-point navigation. Both AI Agent Knowledge (Sources) and Articles tabs coexist; Sources stays read-only summary.