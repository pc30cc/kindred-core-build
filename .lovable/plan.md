## Pass E3 — Q&A Polish + Learning Candidates

This is a large, cross-cutting pass (data model + 6 backend endpoints + candidate generator + 2 UI pages + observability). I'll do it in 4 sequential steps so each lands cleanly and you can verify before the next.

### Step 1 — Audit + migrations only (no code yet)

Inspect actual schemas of `ai_agent_qna`, `ai_agent_learning_candidates`, `ai_knowledge_chunks`, `ai_agent_runs`, `conversation_messages.sender_type` enum.

Add a single migration that — only if missing — adds:
- `ai_agent_learning_candidates`: `status` text + CHECK (`pending|approved|rejected|converted_to_qna|converted_to_kb`), `reason` text + CHECK, `suggested_answer` text, `locale` text, `confidence` numeric, `reviewed_by` uuid, `reviewed_at` timestamptz, `metadata` jsonb, unique index on (`workspace_id`, normalized question hash, `status='pending'`)
- `ai_knowledge_chunks`: confirm `source_type` accepts `qna`, `learned_qna`, `kb_article` (extend CHECK if needed)
- RLS: workspace-scoped read for members, write for owner/admin (matching existing pattern in `ai_agent_qna`)

Stop and wait for migration approval before Step 2.

### Step 2 — Q&A backend polish

In `server/routes/aiAgent.ts` + `server/services/ai-agent/knowledgeIndex/indexer.ts`:
- `GET /api/ai-agent/qna` — filters: enabled, locale, query; pagination cap 100
- `POST /api/ai-agent/qna` — owner/admin; dedupe by (workspace, locale, normalized question); index as `source_type='qna'`, `status='active'`
- `PATCH /api/ai-agent/qna/:id` — reindex on q/a/locale change; on `enabled=false` set chunks `status='inactive'`
- `DELETE /api/ai-agent/qna/:id` — soft-delete + deactivate chunks
- `POST /api/ai-agent/qna/bulk` — array input, max 200 rows, returns {created, skipped, errors}
- `POST /api/ai-agent/qna/:id/reindex`
- Helper functions in `src/lib/ai-agent-api.ts`

### Step 3 — Learning candidates: service + endpoints + safety

Extend `server/services/ai-agent/learning/candidates.ts` (already exists at 172 lines — extend, don't rewrite):
- `generateCandidates(workspaceId, sinceTs)` scans recent `ai_agent_runs` where `status in ('no_answer','handoff')` OR low confidence OR `intent_override='page_not_indexed'`
- Operator-answer detection: find AI-failed run → next non-AI message in same conversation using ACTUAL `sender_type` enum (will inspect first; likely `agent`/`user`/`contact` — not `operator`)
- Dedupe by `(workspace_id, sha256(normalized_question))`, skip greetings/short/secrets via existing `safety.ts`
- Store `metadata`: run_id, conversation_id, selected_sources, answer_strategy.reason, page_context, top_score

Endpoints in `server/routes/aiAgent.ts`:
- `GET /api/ai-agent/learning-candidates` (filters: status, reason, locale, query)
- `POST /api/ai-agent/learning-candidates/generate` (owner/admin)
- `PATCH /:id` (edit text/locale/metadata)
- `POST /:id/approve` — requires `final_answer`; creates `learned_qna` chunk active; status=approved
- `POST /:id/reject` — optional reason; deactivates any prior chunks
- `POST /:id/convert-to-qna` — creates ai_agent_qna row + indexes; status=converted_to_qna
- `POST /:id/convert-to-kb` — accepts `{publish: bool}`; creates KB article, indexes only if published; status=converted_to_kb

Strict invariant: pending/rejected/draft = never indexed with `status='active'`.

### Step 4 — UI + observability

- `QnaPage.tsx` polish: search, locale/enabled filter, create/edit modal, bulk paste textarea (one Q→A per line block), reindex button, disable toggle, empty-state copy explaining Q&A retrieval priority
- New `LearningCandidatesPage.tsx` under `src/pages/app/ai-agent/` mounted at `/app/w/:wsSlug/ai-agent/train/learning` from `TrainPage.tsx`:
  - Tabs: Pending / Approved / Rejected / Converted
  - Filters: reason, locale, confidence ≥
  - Card: question, suggested answer (editable), reason badge, confidence, conversation+run link, page URL, selected sources preview
  - Actions: Edit / Approve / Convert to Q&A / Convert to KB (draft|published) / Reject
  - Bulk approve/reject; "Generate candidates" button
- Overview counts in existing `OverviewPage.tsx`: qna_enabled/disabled, candidates_pending/approved/rejected/converted_*, learned_qna_chunks_active, last_*_at

### Out of scope (explicit)

- No changes to calls/LiveKit/widget-call runtime
- No MCP/webhook/external HTTP execution
- No auto-approval — every learned answer requires human review
- Runtime retrieval (`retrievalHybrid.ts`) only filters added if audit shows pending/draft leakage; otherwise untouched

### Approval gates

After **Step 1 migration approval** I'll proceed through Steps 2→4 in one continuous push, then deliver the A–K acceptance test report.

**Confirm to proceed with Step 1 (audit + migration drafting).** I'll inspect actual columns first, then post the migration for your approval.