# Multi-Node Realtime on Coolify (Centrifugo + Redis)

This guide covers **Deployment Mode 2 (`app_routed_redis`)** and
**Deployment Mode 3 (`load_balanced_redis`)**. For the single-node setup
(Mode 1, `single_memory`) see `DEPLOY_CENTRIFUGO_COOLIFY.md` — that mode
stays fully supported and is still the default.

---

## 1. The three modes

| Mode | Path | When to use |
|---|---|---|
| `single_memory` | Client → one Centrifugo (memory engine) | Default. One node, no Redis. |
| `app_routed_redis` | Client → backend assignment → chosen Centrifugo node → Redis | Several nodes, no load balancer. The backend picks the node, the browser connects straight to it. |
| `load_balanced_redis` | Client → load balancer → Centrifugo nodes → Redis | Several nodes behind one public URL (Traefik, Coolify proxy, cloud LB). |

In **every** mode the contract is identical: the backend authorizes the
caller, mints a short-lived HS256 JWT and returns `ws_url`. The WebSocket
itself never passes through Express. Connection assignment performs **no
PostgreSQL write**.

```text
Mode 1   Browser ───────────────────────────► Centrifugo (memory)
Mode 2   Browser ──► Backend (authz + JWT + node choice)
                └──────────────────────────► Centrifugo node N ──► Redis
Mode 3   Browser ──► Backend (authz + JWT)
                └──► Load Balancer ────────► Centrifugo node N ──► Redis
```

PostgreSQL = business/durable state · Centrifugo = connections & presence ·
Redis = cross-node realtime coordination only.

---

## 2. Compose files in this repo

| File | Role |
|---|---|
| `docker-compose.centrifugo.yml` | Mode 1 — single node, memory engine. Unchanged. |
| `docker-compose.realtime-redis.yml` | Dedicated Redis for the realtime engine. |
| `docker-compose.centrifugo-redis.yml` | One reusable Centrifugo node with the Redis engine. Deploy once per node. |
| `docker-compose.realtime-cluster.yml` | Redis + two nodes on one host (staging / single-server). |

All of them are **env-driven**. There is no bind-mounted `config.json`.

---

## 3. Secrets

Create these once in Coolify (Environment Variables, marked secret) and
reuse the **same values on every node**:

| Variable | Used by | Notes |
|---|---|---|
| `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` | all nodes + backend | Cluster-wide. A JWT minted by the backend must validate on any node. |
| `CENTRIFUGO_API_KEY` | all nodes + backend | Cluster-wide server-to-server API key. |
| `REALTIME_REDIS_PASSWORD` | Redis + all nodes | Backend never needs it. |

Never sent to the browser: the API key, the HMAC secret, and the Redis
URL/password. The client only ever receives a `ws_url`, a short-lived
token and its expiry.

Generate strong values:

```bash
openssl rand -hex 32   # CENTRIFUGO_TOKEN_HMAC_SECRET_KEY
openssl rand -hex 32   # CENTRIFUGO_API_KEY
openssl rand -hex 24   # REALTIME_REDIS_PASSWORD
```

---

## 4. Same-server deployment (one host, several nodes)

1. Deploy `docker-compose.realtime-cluster.yml` as a Coolify resource and
   set the three secrets above.
2. It starts `realtime-redis`, `rt-node-01` (host port 8001) and
   `rt-node-02` (host port 8002).
3. Publish each node through the Coolify proxy with its own hostname, e.g.
   `rt1.example.com → 8001`, `rt2.example.com → 8002` (TLS on both).
4. Register the nodes in Super Admin (section 6 below) using
   `wss://rt1.example.com/connection/websocket` as the public WebSocket URL
   and `http://rt-node-01:8000/api` as the internal API URL.

---

## 5. Multi-server deployment (a host per node)

1. Deploy `docker-compose.realtime-redis.yml` on the host that will own the
   coordination Redis. Expose port 6379 **only** on the private network
   between your realtime hosts — never publicly.
2. On each Centrifugo host deploy `docker-compose.centrifugo-redis.yml` with:
   - `CENTRIFUGO_NODE_NAME=rt-node-01` (unique per host)
   - `REALTIME_REDIS_HOST=<private address of the Redis host>`
   - the three shared secrets
   No host port is published: the compose file only `expose`s port 8000 on the
   internal network and Coolify/Traefik routes the public domain to it. The
   node's `CENTRIFUGO_NODE_NAME` **must** equal the "Node name" of its row in
   Super Admin, otherwise per-node connection counts stay unknown and the
   preflight refuses activation.
3. Give every node a public HTTPS hostname with WebSocket upgrade allowed.
4. Register each node in Super Admin.

Mode 3 is the same deployment plus one public load balancer hostname in
front of all nodes; sticky sessions are **not** required, because Redis
carries cross-node publish, presence and history.

---

## 6. Super Admin configuration

**Super Admin → Providers → Realtime → Centrifugo → Deployment Architecture**

- **Mode 1** — only the existing fields (WebSocket URL, API URL, API key,
  HMAC secret, origins, timeouts, presence, typing, token TTL).
- **Mode 2** — the node table: name, public WebSocket URL, internal API URL,
  weight, enabled, accepting new connections, health, live connections, last
  health check, **Drain / Resume**, **Test node**, plus **Add node** and
  **Test all**.
- **Mode 3** — one load balancer WebSocket URL (the node table stays visible
  for health monitoring).

Saving a topology runs a **preflight**. Activation is refused when it
cannot serve traffic — no healthy node, a cluster API key a node rejects,
duplicate node names, a node name absent from Centrifugo's cluster
discovery, nodes that cannot see each other over Redis, a rejected publish,
or a missing load balancer URL. On failure the previous configuration stays
active and the attempt is written to the realtime audit log.

What the preflight does **not** claim: a synchronous admin request has no
subscriber on another node, so it verifies publish *acceptance*, not
end-to-end cross-node *delivery*. That is proven separately by the real
two-node integration test:

```bash
npm run test:realtime:cross-node   # needs a centrifugo + redis-server binary
```

Latest run of that suite (real Centrifugo v5.4.5 + Redis, two nodes):
cross-node publish, cross-node presence, per-node connection counts, drain,
node failure, Redis outage and Redis recovery — 10/10 checks passed.

---

## 7. Upgrade path: Mode 1 → Mode 2 (no downtime)

1. Deploy Redis and the new Centrifugo nodes **with the same cluster
   secrets** as the existing single node. Leave Mode 1 active.
2. Add the new nodes in Super Admin and press **Test all** until they are
   healthy. Adding a node changes nothing for live clients.
3. Switch the mode to `app_routed_redis` and save. Preflight must pass.
4. New connections are routed to the nodes. Existing clients stay on the old
   socket until their natural reconnect — nothing is force-disconnected.
5. Drain the legacy node, wait for its connection count to fall, then retire
   it.

Rollback is the same switch in reverse: set the mode back to
`single_memory`. The legacy single-node fields are never deleted by the
topology change, so the rollback is immediate.

---

## 8. Draining a node

**Drain** stops new assignments to a node. Existing WebSocket connections
are deliberately left connected and move away on their own reconnect, so
there is no reconnect storm. **Resume** puts the node back in rotation.
Both actions are audited.

---

## 9. Redis failure behaviour

- Nodes keep serving the clients already connected to them; only cross-node
  delivery degrades.
- Health probes go to each node's own Centrifugo API, so a Redis outage does
  **not** mark operators or visitors falsely offline.
- Presence falls back to the database path (`operator_presence_live`,
  `visitor_touch_liveness`), which is retained precisely for this.
- Client reconnects use exponential backoff with jitter and a bounded retry
  count, and each retry re-asks the backend for a fresh assignment, so a
  recovered cluster is re-entered gradually rather than all at once.

---

## 10. Persistence and memory policy

Realtime coordination state is ephemeral by design: presence rebuilds from
live connections and history has a 300s TTL. Redis therefore runs with RDB
and AOF **off** and `maxmemory` bounded (512 MB default).

Eviction policy is **`noeviction`**, not `allkeys-lru`. Under memory pressure
LRU eviction would silently drop presence hashes and history streams, and the
visible symptom would be *wrong presence in the operator UI* and failed
history recovery — a correctness bug that looks like an application defect.
`noeviction` instead makes Centrifugo's own writes fail loudly, which surfaces
in node health and in the realtime alerts. Monitor `maxmemory` usage
(Centrifugo exposes Prometheus metrics); raise `REALTIME_REDIS_MAXMEMORY`
rather than switching the policy. `REALTIME_REDIS_MAXMEMORY_POLICY` exists as
an escape hatch and should only be changed with a load test that proves
presence/history correctness under eviction.

No business data lives in Redis; PostgreSQL remains the source of truth.
Losing Redis loses at most in-flight coordination.

### Per-node connection counts are eventually consistent

Verified against real Centrifugo v5.4.5: per-node client counts in the `info`
reply are gossiped over the engine roughly every 3 seconds, so the numbers in
the node table (and the least-connections router) lag reality by up to one
gossip window. They are a balancing hint, never admission control — drain,
disable and health status are the authoritative signals.

### No Docker healthcheck on Centrifugo

The `centrifugo/centrifugo:v5.4.5` image is built `FROM scratch`: no shell, no
`wget`/`curl`, and no `centrifugo healthcheck` subcommand. Any container-level
healthcheck therefore fails and marks a healthy node unhealthy. Health is
observed from outside the container instead: the Coolify/Traefik probe on the
public domain, the app's own node health service (Centrifugo HTTP `info`, cached
with a short TTL and refreshed by a background ticker), and **Test node / Test
all** in Super Admin. Redis keeps its healthcheck — that image ships
`redis-cli`.

---

## 11. Verification checklist

```bash
# each node answers its own health endpoint
curl -sf https://rt1.example.com/health && echo OK

# each node sees the whole cluster through Redis (num_nodes >= 2)
curl -s -X POST http://rt-node-01:8000/api \
  -H "Authorization: apikey $CENTRIFUGO_API_KEY" \
  -d '{"method":"info","params":{}}' | jq '.result.nodes | length'
```

Then, in the app: open the operator inbox on two browsers, confirm they are
assigned different nodes (the connect response carries `node_id`), and send
a message — it must appear on both. That is the cross-node proof.
