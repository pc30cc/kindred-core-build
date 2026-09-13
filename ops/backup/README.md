# WEBYAR backup agent

Host-side tooling. Runs next to PostgreSQL (it needs the data directory and the
WAL archive), **not** inside the application container.

| File | Purpose |
|---|---|
| `backup.env.example` | every variable the agent reads; copy to `backup.env`, never commit the filled copy |
| `docker-compose.backup.yml` | the `webyar-backup` sidecar (WAL-G + agent loop) |
| `lib.sh` | shared helpers: reporting to the app, checksums, logging with secrets stripped |
| `base-backup.sh` | physical base backup (WAL-G) → off-site object storage |
| `logical-backup.sh` | `pg_dump` custom-format dump, validated, encrypted, off-site |
| `verify-backup.sh` | verifies the newest base + logical backup without touching production |
| `object-backup.sh` | MinIO / Supabase Storage object mirror to the backup bucket |
| `restore-drill.sh` | full restore into a throwaway container (Test A) |
| `pitr-drill.sh` | marker A/B/C point-in-time restore proof (Test B) |
| `agent-loop.sh` | polls the app for safe operator commands and runs them |

Nothing here takes a production restore action. `restore-drill.sh` and
`pitr-drill.sh` refuse to run against the production data directory.
