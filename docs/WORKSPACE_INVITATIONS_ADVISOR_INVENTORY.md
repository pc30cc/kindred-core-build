# Workspace Invitations v5.1 — Supabase advisor finding inventory (Section H)

Machine-readable baseline: `security/advisor-baseline.json`.
Generated from the hosted Supabase advisor plus a `pg_catalog` enumeration of the
same objects (`scripts/ci/advisor-fingerprints.sql`), so every finding has a
stable fingerprint that CI can diff.

## Totals

| Category | Count |
| --- | --- |
| RLS enabled, no policy (INFO) | 43 |
| Extension in public (WARN) | 2 |
| SECURITY DEFINER executable by `anon` (WARN) | 8 |
| SECURITY DEFINER executable by `authenticated` (WARN) | 22 |
| Leaked-password protection disabled (WARN) | 1 |
| **Baseline total** | **76** |

The hosted advisor UI reports **77**; the extra entry is a relation the advisor
counts under `rls_enabled_no_policy` that the `pg_catalog` enumeration does not
classify as a plain table. CI compares catalog fingerprints only, so both sides
stay deterministic.

## Invitation-specific conclusion

No `wi_*` invitation RPC is executable by `PUBLIC`, `anon` or `authenticated`
(proved by the ACL gate in `scripts/ci/advisor-fingerprints.sql` and by
`src/test/invitationSecurityGuards.test.ts`). The only invitation-related
function in the advisor list is the legacy `public.get_invitation_info(text)`,
which is not part of the v5.1 flow and returns no token, OTP or proof material.

## Findings, one by one

### 1. `0008_rls_enabled_no_policy:public.ai_billing_adjustments`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_billing_adjustments`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 2. `0008_rls_enabled_no_policy:public.ai_billing_audit_log`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_billing_audit_log`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 3. `0008_rls_enabled_no_policy:public.ai_billing_commands`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_billing_commands`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 4. `0008_rls_enabled_no_policy:public.ai_billing_recovery_lease`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_billing_recovery_lease`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 5. `0008_rls_enabled_no_policy:public.ai_exchange_rates`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_exchange_rates`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 6. `0008_rls_enabled_no_policy:public.ai_models`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_models`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 7. `0008_rls_enabled_no_policy:public.ai_rate_card_components`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_rate_card_components`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 8. `0008_rls_enabled_no_policy:public.ai_rate_cards`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_rate_cards`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 9. `0008_rls_enabled_no_policy:public.ai_run_settlements`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_run_settlements`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 10. `0008_rls_enabled_no_policy:public.ai_run_steps`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_run_steps`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 11. `0008_rls_enabled_no_policy:public.ai_runs`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_runs`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 12. `0008_rls_enabled_no_policy:public.ai_sell_policies`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_sell_policies`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 13. `0008_rls_enabled_no_policy:public.ai_usage_event_conflicts`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_usage_event_conflicts`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 14. `0008_rls_enabled_no_policy:public.ai_usage_events`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.ai_usage_events`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 15. `0008_rls_enabled_no_policy:public.channel_delivery_attempts`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.channel_delivery_attempts`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 16. `0008_rls_enabled_no_policy:public.channel_inbound_events`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.channel_inbound_events`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 17. `0008_rls_enabled_no_policy:public.channel_integrations`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.channel_integrations`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 18. `0008_rls_enabled_no_policy:public.channel_jobs`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.channel_jobs`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 19. `0008_rls_enabled_no_policy:public.channel_worker_heartbeats`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.channel_worker_heartbeats`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 20. `0008_rls_enabled_no_policy:public.legal_policy_versions`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.legal_policy_versions`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 21. `0008_rls_enabled_no_policy:public.plugin_platform_state`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.plugin_platform_state`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 22. `0008_rls_enabled_no_policy:public.plugin_secrets`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.plugin_secrets`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 23. `0008_rls_enabled_no_policy:public.workspace_ai_balance_alerts`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_ai_balance_alerts`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 24. `0008_rls_enabled_no_policy:public.workspace_ai_balance_lots`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_ai_balance_lots`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 25. `0008_rls_enabled_no_policy:public.workspace_ai_ledger`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_ai_ledger`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 26. `0008_rls_enabled_no_policy:public.workspace_ai_ledger_allocations`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_ai_ledger_allocations`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 27. `0008_rls_enabled_no_policy:public.workspace_ai_reservation_allocations`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_ai_reservation_allocations`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 28. `0008_rls_enabled_no_policy:public.workspace_ai_reservations`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_ai_reservations`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 29. `0008_rls_enabled_no_policy:public.workspace_ai_wallets`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_ai_wallets`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 30. `0008_rls_enabled_no_policy:public.workspace_invitation_consents`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitation_consents`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 31. `0008_rls_enabled_no_policy:public.workspace_invitation_contexts`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitation_contexts`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 32. `0008_rls_enabled_no_policy:public.workspace_invitation_deliveries`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitation_deliveries`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 33. `0008_rls_enabled_no_policy:public.workspace_invitation_departments`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitation_departments`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 34. `0008_rls_enabled_no_policy:public.workspace_invitation_idempotency`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitation_idempotency`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 35. `0008_rls_enabled_no_policy:public.workspace_invitation_jobs`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitation_jobs`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 36. `0008_rls_enabled_no_policy:public.workspace_invitation_otps`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitation_otps`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 37. `0008_rls_enabled_no_policy:public.workspace_invitation_proofs`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitation_proofs`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 38. `0008_rls_enabled_no_policy:public.workspace_invitation_tokens`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitation_tokens`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 39. `0008_rls_enabled_no_policy:public.workspace_invitations`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_invitations`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only invitation table: deny-by-default with no policy is the intended posture; any policy here would widen exposure.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 40. `0008_rls_enabled_no_policy:public.workspace_member_details`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_member_details`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 41. `0008_rls_enabled_no_policy:public.workspace_member_details_history`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_member_details_history`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 42. `0008_rls_enabled_no_policy:public.workspace_plugin_installations`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_plugin_installations`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 43. `0008_rls_enabled_no_policy:public.workspace_seat_entitlement_mode`

- Category: SECURITY / rls_enabled_no_policy
- Object: `public.workspace_seat_entitlement_mode`
- Severity: INFO
- Reason: RLS is enabled but no policy exists, so PostgREST returns zero rows for anon/authenticated.
- Actual exposure: None. The table carries no Data API grants; it is reached only by the Express server through service_role, which bypasses RLS.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Server-only/back-office table written exclusively by the Express backend or workers; deny-by-default is intended.
- Owner / follow-up: backend/platform — Re-evaluate only if this table is ever exposed directly to the browser.

### 44. `0014_extension_in_public:pg_trgm`

- Category: SECURITY / extension_in_public
- Object: `public.pg_trgm`
- Severity: WARN
- Reason: Extension installed in the public schema.
- Actual exposure: None for invitations; the extension exposes no project data.
- Intentional: yes
- Decision: **deferred**
- Justification: Relocating pg_trgm/vector requires rebuilding every dependent index and function signature; it is a separate, risky maintenance window.
- Owner / follow-up: backend/platform — Schedule an extension-relocation migration outside the invitations release.

### 45. `0014_extension_in_public:vector`

- Category: SECURITY / extension_in_public
- Object: `public.vector`
- Severity: WARN
- Reason: Extension installed in the public schema.
- Actual exposure: None for invitations; the extension exposes no project data.
- Intentional: yes
- Decision: **deferred**
- Justification: Relocating pg_trgm/vector requires rebuilding every dependent index and function signature; it is a separate, risky maintenance window.
- Owner / follow-up: backend/platform — Schedule an extension-relocation migration outside the invitations release.

### 46. `0028_anon_security_definer_function_executable:public.admin_delete_user`

- Category: SECURITY / secdef_executable_anon
- Object: `public.admin_delete_user()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by anon.
- Actual exposure: Elevated: the function performs privileged admin work and validates the caller internally (has_role / actor checks) before acting.
- Intentional: no (actionable)
- Decision: **actionable**
- Justification: Legacy hosted grant from the pre-Express era. The Express server calls it with service_role; the grant to anon should be revoked.
- Owner / follow-up: backend/platform — Revoke EXECUTE from anon in a dedicated hardening migration (out of scope for Workspace Invitations v5.1; tracked separately).

### 47. `0028_anon_security_definer_function_executable:public.get_account_role`

- Category: SECURITY / secdef_executable_anon
- Object: `public.get_account_role()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by anon.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 48. `0028_anon_security_definer_function_executable:public.get_invitation_info`

- Category: SECURITY / secdef_executable_anon
- Object: `public.get_invitation_info()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by anon.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 49. `0028_anon_security_definer_function_executable:public.get_widget_platform_settings`

- Category: SECURITY / secdef_executable_anon
- Object: `public.get_widget_platform_settings()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by anon.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 50. `0028_anon_security_definer_function_executable:public.get_workspace_role`

- Category: SECURITY / secdef_executable_anon
- Object: `public.get_workspace_role()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by anon.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 51. `0028_anon_security_definer_function_executable:public.has_role`

- Category: SECURITY / secdef_executable_anon
- Object: `public.has_role()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by anon.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 52. `0028_anon_security_definer_function_executable:public.is_workspace_member`

- Category: SECURITY / secdef_executable_anon
- Object: `public.is_workspace_member()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by anon.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 53. `0028_anon_security_definer_function_executable:public.knowledge_base_emit_change_event`

- Category: SECURITY / secdef_executable_anon
- Object: `public.knowledge_base_emit_change_event()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by anon.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 54. `0029_authenticated_security_definer_function_executable:public.admin_count_profiles`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.admin_count_profiles()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Elevated: the function performs privileged admin work and validates the caller internally (has_role / actor checks) before acting.
- Intentional: yes
- Decision: **actionable**
- Justification: Legacy hosted grant from the pre-Express era. The Express server calls it with service_role; the grant to authenticated should be revoked.
- Owner / follow-up: backend/platform — Revoke EXECUTE from authenticated in a dedicated hardening migration (out of scope for Workspace Invitations v5.1; tracked separately).

### 55. `0029_authenticated_security_definer_function_executable:public.admin_count_workspaces`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.admin_count_workspaces()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Elevated: the function performs privileged admin work and validates the caller internally (has_role / actor checks) before acting.
- Intentional: yes
- Decision: **actionable**
- Justification: Legacy hosted grant from the pre-Express era. The Express server calls it with service_role; the grant to authenticated should be revoked.
- Owner / follow-up: backend/platform — Revoke EXECUTE from authenticated in a dedicated hardening migration (out of scope for Workspace Invitations v5.1; tracked separately).

### 56. `0029_authenticated_security_definer_function_executable:public.admin_delete_user`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.admin_delete_user()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Elevated: the function performs privileged admin work and validates the caller internally (has_role / actor checks) before acting.
- Intentional: yes
- Decision: **actionable**
- Justification: Legacy hosted grant from the pre-Express era. The Express server calls it with service_role; the grant to authenticated should be revoked.
- Owner / follow-up: backend/platform — Revoke EXECUTE from authenticated in a dedicated hardening migration (out of scope for Workspace Invitations v5.1; tracked separately).

### 57. `0029_authenticated_security_definer_function_executable:public.admin_list_login_attempts`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.admin_list_login_attempts()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Elevated: the function performs privileged admin work and validates the caller internally (has_role / actor checks) before acting.
- Intentional: yes
- Decision: **actionable**
- Justification: Legacy hosted grant from the pre-Express era. The Express server calls it with service_role; the grant to authenticated should be revoked.
- Owner / follow-up: backend/platform — Revoke EXECUTE from authenticated in a dedicated hardening migration (out of scope for Workspace Invitations v5.1; tracked separately).

### 58. `0029_authenticated_security_definer_function_executable:public.admin_list_profiles`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.admin_list_profiles()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Elevated: the function performs privileged admin work and validates the caller internally (has_role / actor checks) before acting.
- Intentional: yes
- Decision: **actionable**
- Justification: Legacy hosted grant from the pre-Express era. The Express server calls it with service_role; the grant to authenticated should be revoked.
- Owner / follow-up: backend/platform — Revoke EXECUTE from authenticated in a dedicated hardening migration (out of scope for Workspace Invitations v5.1; tracked separately).

### 59. `0029_authenticated_security_definer_function_executable:public.admin_list_workspaces`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.admin_list_workspaces()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Elevated: the function performs privileged admin work and validates the caller internally (has_role / actor checks) before acting.
- Intentional: yes
- Decision: **actionable**
- Justification: Legacy hosted grant from the pre-Express era. The Express server calls it with service_role; the grant to authenticated should be revoked.
- Owner / follow-up: backend/platform — Revoke EXECUTE from authenticated in a dedicated hardening migration (out of scope for Workspace Invitations v5.1; tracked separately).

### 60. `0029_authenticated_security_definer_function_executable:public.admin_security_stats`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.admin_security_stats()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Elevated: the function performs privileged admin work and validates the caller internally (has_role / actor checks) before acting.
- Intentional: yes
- Decision: **actionable**
- Justification: Legacy hosted grant from the pre-Express era. The Express server calls it with service_role; the grant to authenticated should be revoked.
- Owner / follow-up: backend/platform — Revoke EXECUTE from authenticated in a dedicated hardening migration (out of scope for Workspace Invitations v5.1; tracked separately).

### 61. `0029_authenticated_security_definer_function_executable:public.bootstrap_admin`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.bootstrap_admin()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Elevated: the function performs privileged admin work and validates the caller internally (has_role / actor checks) before acting.
- Intentional: yes
- Decision: **actionable**
- Justification: Legacy hosted grant from the pre-Express era. The Express server calls it with service_role; the grant to authenticated should be revoked.
- Owner / follow-up: backend/platform — Revoke EXECUTE from authenticated in a dedicated hardening migration (out of scope for Workspace Invitations v5.1; tracked separately).

### 62. `0029_authenticated_security_definer_function_executable:public.check_module_access`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.check_module_access()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 63. `0029_authenticated_security_definer_function_executable:public.check_workspace_entitlement`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.check_workspace_entitlement()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 64. `0029_authenticated_security_definer_function_executable:public.get_account_role`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.get_account_role()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 65. `0029_authenticated_security_definer_function_executable:public.get_invitation_info`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.get_invitation_info()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 66. `0029_authenticated_security_definer_function_executable:public.get_widget_platform_settings`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.get_widget_platform_settings()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 67. `0029_authenticated_security_definer_function_executable:public.get_workspace_role`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.get_workspace_role()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 68. `0029_authenticated_security_definer_function_executable:public.has_role`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.has_role()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 69. `0029_authenticated_security_definer_function_executable:public.has_workspace_permission`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.has_workspace_permission()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 70. `0029_authenticated_security_definer_function_executable:public.is_account_member`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.is_account_member()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 71. `0029_authenticated_security_definer_function_executable:public.is_workspace_member`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.is_workspace_member()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 72. `0029_authenticated_security_definer_function_executable:public.knowledge_base_emit_change_event`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.knowledge_base_emit_change_event()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 73. `0029_authenticated_security_definer_function_executable:public.mark_conversation_seen`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.mark_conversation_seen()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 74. `0029_authenticated_security_definer_function_executable:public.user_phone_verified`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.user_phone_verified()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 75. `0029_authenticated_security_definer_function_executable:public.workspace_owner_phone_verified`

- Category: SECURITY / secdef_executable_authenticated
- Object: `public.workspace_owner_phone_verified()`
- Severity: WARN
- Reason: SECURITY DEFINER function is EXECUTE-able by authenticated.
- Actual exposure: Low: read-only helper that scopes its result to the calling user or to already-public platform settings.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: Required by legacy hosted RLS policies / public widget bootstrap; internally scoped, returns no secrets.
- Owner / follow-up: backend/platform — None.

### 76. `auth_leaked_password_protection_disabled:project`

- Category: SECURITY / auth configuration
- Object: `hosted Supabase Auth project settings`
- Severity: WARN
- Reason: HaveIBeenPwned leaked-password protection is disabled in hosted GoTrue.
- Actual exposure: None for this deployment: first-party auth (Argon2id + user_credentials + gs_session) is authoritative; hosted GoTrue is not used for password login.
- Intentional: yes
- Decision: **deferred-by-design**
- Justification: The hosted Auth password path is disabled in production; enabling the flag would not change any live login path.
- Owner / follow-up: security — Enable if hosted GoTrue password login is ever re-activated.
