#!/usr/bin/env node
/**
 * ANALYTICS PRODUCTION VERIFICATION
 *
 * ── Why this script exists ───────────────────────────────────────
 *
 * The remaining Phase 3A questions can only be answered by the real
 * deployment: the real Analytics Primary and its credentials, real
 * workspaces with real traffic, the real container image, the real
 * persistent volume. A verification run against fakes verifies the fakes.
 *
 * So it runs where the answers live — inside the deployed backend — and
 * reports nine lines.
 *
 * ── What it does NOT do ──────────────────────────────────────────
 *
 * It writes NOTHING to PostgreSQL. Not a status row, not a health record,
 * not a progress log, not a heartbeat. Every check is performed live and
 * its answer is printed and then forgotten, because analytics keeps no
 * history of itself.
 *
 * Concretely, the endpoints it calls:
 *   GET  /                  reads configuration
 *   GET  /connections       live round trip per provider, stores nothing
 *   POST /test/<provider>   live round trip, stores nothing
 *   POST /parity            compares both stores, returns the result
 *   POST /backfill/range    reads source tables, writes OBJECTS only —
 *                           it does not seal and writes no database row
 *
 * It never enables s3_only, never sets readMode to s3, never stops a
 * PostgreSQL write, never deletes a row, and never drops anything.
 *
 * ── Usage ────────────────────────────────────────────────────────
 *
 *   node scripts/analytics-production-verify.mjs \
 *     --base-url https://api.example.com \
 *     --token "$SUPER_ADMIN_ACCESS_TOKEN" \
 *     --workspace <uuid> \
 *     [--backfill-from 2026-09-01 --backfill-to 2026-09-03] \
 *     [--spool-dir /app/data/analytics-spool]
 *
 * The token must belong to a Super Admin. No credential is ever printed:
 * providers are named, never described.
 *
 * Exit code 0 = READY FOR PHASE 3B, 1 = NOT READY.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ─── Arguments ───────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    baseUrl: '', token: '', workspace: '',
    backfillFrom: '', backfillTo: '',
    spoolDir: process.env.ANALYTICS_SPOOL_DIR || '/app/data/analytics-spool',
  };
  for (let i = 2; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case '--base-url': args.baseUrl = value; i++; break;
      case '--token': args.token = value; i++; break;
      case '--workspace': args.workspace = value; i++; break;
      case '--backfill-from': args.backfillFrom = value; i++; break;
      case '--backfill-to': args.backfillTo = value; i++; break;
      case '--spool-dir': args.spoolDir = value; i++; break;
      default: break;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.baseUrl || !args.token) {
  console.error('usage: analytics-production-verify.mjs --base-url <url> --token <super-admin-token>'
    + ' [--workspace <uuid>] [--backfill-from <YYYY-MM-DD> --backfill-to <YYYY-MM-DD>] [--spool-dir <path>]');
  process.exit(2);
}

const BASE = `${args.baseUrl.replace(/\/$/, '')}/api/admin/providers/analytics-storage`;

async function api(pathname, init) {
  const response = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  return { ok: response.ok, status: response.status, body };
}

function line(label, value) {
  console.log(`  ${String(label).padEnd(26)} ${value}`);
}

/** Notes explaining any negative result, printed before the summary. */
const reasons = [];
function why(subject, detail) { reasons.push(`${subject}: ${detail}`); }

// ─── 1. Is this the real backend? ────────────────────────────────

function firstEnv(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  return null;
}

function gitFact(command) {
  try { return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
  catch { return null; }
}

function identify() {
  console.log('\n1. Environment identity');

  line('Target', args.baseUrl);
  line('Hostname / container', os.hostname());
  line('Node version', process.version);

  const branch = firstEnv('GIT_BRANCH', 'SOURCE_BRANCH', 'COOLIFY_BRANCH')
    ?? gitFact('git rev-parse --abbrev-ref HEAD') ?? 'unknown';
  const commit = firstEnv('GIT_COMMIT', 'SOURCE_COMMIT', 'COOLIFY_COMMIT_SHA', 'COMMIT_SHA')
    ?? gitFact('git rev-parse HEAD') ?? 'unknown';
  line('Branch', branch);
  line('Commit', commit === 'unknown' ? 'unknown' : commit.slice(0, 12));

  // Whether the deployed code IS this codebase, rather than something else
  // answering on the same hostname.
  const marker = fs.existsSync('/app/dist/server/index.js') || fs.existsSync('/app/server')
    || fs.existsSync(path.resolve('server'));
  line('Backend code present', marker ? 'yes' : 'NOT FOUND — is this the right container?');

  return { branch, commit, identified: marker };
}

// ─── 2. Configuration — names only, never credentials ────────────

async function readConfig() {
  console.log('\n2. Analytics Storage configuration');
  const { ok, status, body } = await api('');
  if (!ok) {
    why('Configuration', `GET returned ${status} ${body?.error ?? ''}`.trim());
    line('Primary Provider', 'UNREADABLE');
    return null;
  }
  line('Primary Provider', body.primary ?? 'none configured');
  line('Replica Providers', (body.replicas ?? []).length ? body.replicas.join(', ') : 'none');
  line('Enabled', String(body.enabled));
  line('Write mode', body.writeMode);
  line('Read mode', body.readMode);
  if ((body.missingCredentials ?? []).length) {
    // Names the vendors lacking credentials. Never the credentials.
    why('Configuration', `providers named but holding no credentials: ${body.missingCredentials.join(', ')}`);
  }
  return body;
}

// ─── 3 & 4. Live connection tests ────────────────────────────────

/**
 * One live round trip per provider, performed by the server:
 * PUT a tiny object, GET it back, query it, DELETE it.
 * The server stores no part of the answer.
 */
async function testConnections(config) {
  const out = { primary: null, replicas: [] };

  const { ok, status, body } = await api('/connections');
  if (!ok) {
    why('Connections', `GET /connections returned ${status} ${body?.error ?? ''}`.trim());
    return out;
  }

  console.log('\n3. Primary connection test');
  if (!config?.primary) {
    line('Primary', 'Not Connected');
    why('Primary', 'no analytics primary is configured');
  } else {
    out.primary = body.primary?.connected === true;
    line('Primary', out.primary ? 'Connected' : 'Not Connected');
    if (!out.primary) why('Primary', body.primary?.error ?? 'the live round trip did not succeed');
  }

  console.log('\n4. Replica connection tests');
  const replicas = config?.replicas ?? [];
  if (replicas.length === 0) {
    line('Replicas', 'none configured');
  } else {
    for (const name of replicas) {
      const found = (body.replicas ?? []).find((r) => r.provider === name);
      const connected = found?.connected === true;
      out.replicas.push({ name, connected });
      line(`Replica ${name}`, connected ? 'Connected' : 'Not Connected');
      if (!connected) why(`Replica ${name}`, found?.error ?? 'the live round trip did not succeed');
    }
  }
  return out;
}

// ─── 5. Spool on a persistent volume ─────────────────────────────

/**
 * Two questions, and the second is the one that matters: the directory must
 * be writable, AND it must survive the container. A spool on the container's
 * own writable layer is lost on every redeploy, which is exactly the outage
 * it exists to cover.
 */
function checkSpool() {
  console.log('\n5. Spool');
  const dir = args.spoolDir;
  line('Directory', dir);

  let writable = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.verify-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.fsyncSync(fs.openSync(probe, 'r'));
    fs.unlinkSync(probe);
    writable = true;
  } catch (err) {
    why('Spool', `not writable: ${err instanceof Error ? err.message : String(err)}`);
  }
  line('Writable', writable ? 'yes' : 'no');

  // A bind mount or volume shows up as its own mount point; the container's
  // own layer at / does not.
  let persistent = false;
  let mountInfo = 'unknown';
  try {
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
      .map((l) => l.split(' '))
      .filter((f) => f.length > 4)
      .map((f) => f[4]);
    // The longest mount point that is a prefix of the spool dir.
    const covering = mounts
      .filter((m) => dir === m || dir.startsWith(m.endsWith('/') ? m : `${m}/`))
      .sort((a, b) => b.length - a.length)[0] ?? '/';
    persistent = covering !== '/';
    mountInfo = covering;
    if (!persistent) {
      why('Spool', `${dir} sits on the container's own filesystem (mount point "/"), `
        + 'not a persistent volume — spooled events would be lost on redeploy');
    }
  } catch {
    why('Spool', 'could not read /proc/self/mountinfo to confirm the volume');
  }
  line('Mount point', mountInfo);
  line('Persistent volume', persistent ? 'yes' : 'no');

  const enabled = process.env.ANALYTICS_SPOOL_ENABLED === '1'
    || process.env.ANALYTICS_SPOOL_ENABLED === 'true';
  line('Spool enabled', enabled ? 'yes' : 'no (ANALYTICS_SPOOL_ENABLED is not set)');
  if (!enabled) why('Spool', 'ANALYTICS_SPOOL_ENABLED is not set, so durable ingestion is off');

  return writable && persistent && enabled;
}

// ─── 6. DuckDB ───────────────────────────────────────────────────

function checkDuckDb(config) {
  console.log('\n6. DuckDB');
  let local = false;
  try { require.resolve('@duckdb/node-api'); local = true; } catch { local = false; }

  // What the SERVER reports is authoritative — this script may not be running
  // in the same image. Fall back to the local resolution when it is.
  const server = config?.duckdbAvailable;
  const available = server === undefined ? local : server === true;

  line('Resolvable here', local ? 'yes' : 'no');
  line('Reported by server', server === undefined ? 'n/a' : String(server));
  if (!available) why('DuckDB', 'the embedded query engine is not installed, so reports cannot be served from object storage');

  const zstd = typeof zlib.zstdCompressSync === 'function';
  line('ZSTD codec', zstd ? 'available' : 'MISSING from node:zlib');
  if (!zstd) why('Runtime', `${process.version} has no zstdCompressSync — Parquet cannot be written (needs Node >= 22.15)`);

  return available && zstd;
}

// ─── 7. Parity, once, on a real workspace ────────────────────────

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function checkParity() {
  console.log('\n7. Parity');
  if (!args.workspace) {
    line('Parity', 'not run');
    why('Parity', 'no --workspace given, so parity could not be run against real data');
    return null;
  }

  const from = daysAgo(7);
  const to = daysAgo(1);
  line('Workspace', `${args.workspace.slice(0, 8)}…`);
  line('Range', `${from} → ${to}`);

  const { ok, status, body } = await api('/parity', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: args.workspace, startDate: from, endDate: to, includeFunnels: true }),
  });
  if (!ok) {
    why('Parity', `POST /parity returned ${status} ${body?.error ?? ''}`.trim());
    return false;
  }

  const s = body.summary ?? {};
  line('Reports', `matched=${s.matched ?? 0} mismatched=${s.mismatched ?? 0} skipped=${s.skipped ?? 0} error=${s.error ?? 0}`);

  const clean = (s.mismatched ?? 0) === 0 && (s.error ?? 0) === 0;
  // A run where every report was skipped proves nothing, so it is not a pass.
  const proved = (s.matched ?? 0) > 0;

  if (!clean) {
    for (const r of (body.run?.reports ?? []).filter((x) => x.status === 'mismatched' || x.status === 'error')) {
      if (r.error) {
        why(`Parity/${r.report}`, r.error);
      } else {
        for (const d of (r.differences ?? []).filter((x) => !x.expected)) {
          why(`Parity/${r.report}`, `field "${d.field}" — PostgreSQL=${d.postgres} S3=${d.s3}`);
        }
      }
    }
  } else if (!proved) {
    why('Parity', `every report was skipped (skipped=${s.skipped ?? 0}) — `
      + 'the range holds no comparable data, so nothing was actually proven');
  }

  return clean && proved;
}

// ─── 8. Backfill, non-destructive, on a small real range ─────────

async function checkBackfill() {
  console.log('\n8. Backfill');
  if (!args.workspace || !args.backfillFrom || !args.backfillTo) {
    line('Backfill', 'not run');
    why('Backfill', 'needs --workspace with --backfill-from and --backfill-to');
    return null;
  }
  line('Workspace', `${args.workspace.slice(0, 8)}…`);
  line('Range', `${args.backfillFrom} → ${args.backfillTo}`);

  const totals = { attempted: 0, verified: 0, failed: 0, sourceRows: 0, writtenRows: 0, objects: 0, bytes: 0 };
  let from = args.backfillFrom;

  // Resumable by contract: continue while the server hands back a nextDay.
  for (let pass = 0; pass < 40 && from; pass++) {
    const { ok, status, body } = await api('/backfill/range', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: args.workspace, fromDay: from, toDay: args.backfillTo }),
    });
    if (!ok) {
      why('Backfill', `POST /backfill/range returned ${status} ${body?.error ?? ''}`.trim());
      return false;
    }
    const r = body.report;
    totals.attempted += r.attempted;
    totals.verified += r.verifiedDays;
    totals.failed += r.failedDays.length;
    totals.sourceRows += r.sourceRows;
    totals.writtenRows += r.writtenRows;
    totals.objects += r.objects;
    totals.bytes += r.bytes;
    for (const d of r.failedDays) why('Backfill', `day ${d.day ?? d}: ${d.error ?? 'rebuild failed'}`);
    from = r.nextDay;
  }

  line('Days', `attempted=${totals.attempted} verified=${totals.verified} failed=${totals.failed}`);
  line('Rows', `source=${totals.sourceRows} written=${totals.writtenRows}`);
  line('Objects', `${totals.objects} (${totals.bytes} bytes)`);

  const exact = totals.sourceRows === totals.writtenRows && totals.failed === 0;
  if (!exact && totals.failed === 0) {
    why('Backfill', `row counts disagree: PostgreSQL held ${totals.sourceRows}, `
      + `the rebuild wrote ${totals.writtenRows}`);
  }
  return exact;
}

// ─── Main ────────────────────────────────────────────────────────

console.log('\nAnalytics Production Verification');
console.log('='.repeat(64));

const identity = identify();
const config = await readConfig();
const connections = config ? await testConnections(config) : { primary: null, replicas: [] };
const spoolOk = checkSpool();
const duckOk = checkDuckDb(config);
const parityOk = await checkParity();
const backfillOk = await checkBackfill();

if (!identity.identified) {
  why('Identity', 'the backend source tree was not found next to this process — '
    + 'the results below may describe a different deployment');
}

// ─── Final output ────────────────────────────────────────────────

function verdictWord(value, yes, no) {
  return value === true ? yes : no;
}

console.log(`\n${'='.repeat(64)}`);
if (reasons.length) {
  console.log('\nReasons:');
  for (const r of reasons) console.log(`  - ${r}`);
}

console.log('\nResult\n');
console.log(`Primary: ${verdictWord(connections.primary, 'Connected', 'Not Connected')}`);
if (connections.replicas.length === 0) {
  console.log('Replica(s): none configured');
} else {
  for (const r of connections.replicas) {
    console.log(`Replica ${r.name}: ${verdictWord(r.connected, 'Connected', 'Not Connected')}`);
  }
}
console.log(`DuckDB: ${verdictWord(duckOk, 'Available', 'Not Available')}`);
console.log(`Spool: ${verdictWord(spoolOk, 'Ready', 'Not Ready')}`);
console.log(`Parity: ${verdictWord(parityOk, 'Passed', 'Failed')}`);
console.log(`Backfill: ${verdictWord(backfillOk, 'Passed', 'Failed')}`);

const ready = identity.identified
  && connections.primary === true
  && connections.replicas.every((r) => r.connected === true)
  && duckOk === true
  && spoolOk === true
  && parityOk === true
  && backfillOk === true;

console.log(`\n${ready ? 'READY FOR PHASE 3B' : 'NOT READY FOR PHASE 3B'}\n`);
process.exit(ready ? 0 : 1);
