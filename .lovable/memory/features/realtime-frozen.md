---
name: realtime layer frozen baseline
description: Widget runtime + realtime providers are a frozen stable baseline; do not refactor without a reproducible bug
type: constraint
---
The widget runtime and realtime layer are frozen as a stable baseline.

Frozen files:
- public/widget/runtime.js
- public/widget/runtime-rt-centrifugo.js
- public/widget/runtime-rt-supabase.js
- public/widget/runtime-rt-resolver.js
- public/widget/loader.js
- src/realtime/providers/centrifugo.ts
- src/realtime/providers/supabase.ts
- src/realtime/providers/polling.ts
- src/realtime/index.ts
- server/services/realtime/**
- server/routes/realtime.ts

Do NOT refactor, restructure, or "improve" these files. Only touch them
when a new, reproducible bug is filed against the regression checklist
at `docs/REALTIME_REGRESSION_CHECKLIST.md`. Fix root cause in the
smallest diff possible.

Load-bearing invariants (see checklist for full list):
- onReconnect fires only on a real reconnect, never on first connect
- subscribing → connected requires a real subscribe ack with matching cid
- wake never reconnects a healthy `connected` socket
- resubscribeAll is generation-guarded against stale sockets
- Centrifugo code 105 (already subscribed) is benign on both sides
- socket_not_open during subscribe defers, never fatal
- No Edge Functions — Express backend only

Debug logs are gated:
- Widget: `Util.debug` via config.debugMode | localStorage `gs:debug=1` | window.__gs_debug
- Operator: `rtDebug`/`rtWarn` via localStorage `rt:debug=1` | VITE_RT_DEBUG=1
- Server: `RT_DEBUG=1`
