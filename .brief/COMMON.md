# Brief shared by every email-fix package

## What this is

On 2026-10-29 an audit found the problems in your package file. The owner asked
for every security problem to be fixed, and every other problem too. You
implement one package.
- Read `CONTRACT.md` (next to this file) first.
- Then read your package file.
- Fix every finding in it. If you decide a finding needs no code change (wrong
  claim, or already fixed by another package's contract), say so in your
  result, with the reason.

## Production facts (verified 2026-10-29; you cannot reach production)

**Brands and databases**
- Two brands, one codebase:
  - WebYar: webyar.ai, edition `iran`, Persian only.
  - RESPOK: respok.app, edition `international`.
- Each brand has its own Postgres. The backend runs `DATABASE_MODE=postgres-only`. `serviceClientFor(...)` is a supabase-js-shaped adapter over Postgres; read how it is used before writing queries.

**Email provider rows**
- `app_runtime_config.default_email_provider` on both brands:

  ```json
  {"provider_name":"smtp","config":{"smtp_host":"mail-relay","smtp_port":"587","smtp_user":"noreply@<domain>","smtp_pass":"<secret>","from_email":"noreply@<domain>","from_name":"Webyar"|"RESPOK"}}
  ```

  - Every key is in "config", nothing is in "secrets", and nothing is encrypted.
  - It was "resend" (api_key, from_email, from_name in config) until 2026-10-29 15:11 UTC.
- No `notification_email_provider` row exists.

**mail-relay**
- Postfix on the backend's Docker network.
- Port 587. No STARTTLS. SASL PLAIN required.
- Accepts only senders @webyar.ai and @respok.app.
- DKIM-signs.
- MX of both domains is iCloud, so our server never receives mail.

**Notification email settings** (`notification_email_settings`), both brands:
- `enabled = true`.
- On: transcripts, paid_invoices, product_updates.
- Off: unread_messages, weekly_summary.
- No `provider_override`.

**Plans**
- The email channel is on in `trial`, `enterprise` and `app-review`, off in `free` and `pro`.
- WebYar has 4 workspaces, RESPOK 1.
- `/api/email/send-channel` was never used (no email_logs row without a template).

**Volume and history**
- Volume is tiny: about 30 mails/month. The relay's IP is new (first mail today).
- RESPOK's 36 mails (invoices and receipts, 2026-10-09 to 10-15) failed under Resend with 403 and were never re-sent.

## Rules

- **CLAUDE.md** is in your context; follow it. In particular:
  - Never change `PLATFORM_SIGNING_SECRET` or `PLUGIN_SECRETS_MASTER_KEY`. Using them is fine.
  - Never put a secret in a log, a response to the browser, or the knowledge base.
  - Never drop or empty billing archives.
  - Persian text is the owner's tone: plain, short.
- **Style.** Write code that reads like the surrounding code: its comment density and voice (comments explain why, in full sentences, as in `server/services/email/index.ts`), naming and idiom. Keep every change minimal for what the finding needs, but complete. No TODO stubs.
- **Ownership.** Change only the files your package owns (listed in your task), plus the smallest wiring elsewhere when unavoidable: an import, a router mount in `server/index.ts`, an i18n key. Another package may change the same wiring file at the same time, so keep such edits small and local.
- **i18n.** Every user-visible string goes through the app's i18n with `en`, `fa` and `tr` (look at `src/i18n/locales`), unless the surrounding code does otherwise.
- **Tests.** Add focused tests for what you fix, next to the existing tests for that area (`src/test/...`; look at how neighbouring tests mock `serviceClientFor`). Where you write a migration, add or extend a `.pg.test.ts` that applies it.

## Validation, before you commit

1. Server code: `npx tsc --noEmit -p tsconfig.server.json`.
2. Only if you touched `src/`:
   `node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`.
   Other agents share the machine (4 CPUs, 15 GB), so run it once, at the end.
3. `npx eslint <the files you changed>`.
4. `npx vitest run <your test files and the existing tests of the area you changed>`.
5. Postgres tests: a local PostgreSQL 16 is running (pgvector installed). Make your OWN database (another agent may be using `app`), then run your pg tests against it:

   ```sh
   createdb -h localhost -U postgres <pkg>_test   # password: postgres
   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/<pkg>_test npx vitest run <your .pg.test.ts> --no-file-parallelism
   ```

6. `npx vitest run src/test/ci` (migration and ACL rules), if you added a migration.

## Commit

- Commit on the branch named in your task. Your git worktree may start on another branch: run `git checkout -b <branch>` first.
- Use one or more commits with clear English messages, no model names. End each message with these two lines:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011TWMP2wMUH9osWvoTLf4Up
  ```

- Do not push. Do not touch any server.
