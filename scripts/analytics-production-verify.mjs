#!/usr/bin/env node
/**
 * ANALYTICS PRODUCTION VERIFIER — Phase 3A, the parts only production can answer.
 *
 * ── Why this script exists ───────────────────────────────────────
 *
 * Phase 3A asks for proof against the real deployment: the real Analytics
 * Primary and its credentials, real workspaces with real traffic, the real
 * container image, the real replica. None of that is reachable from a
 * development sandbox, and a verification that runs against fakes would be
 * a verification of the fakes.
 *
 * So the checks that CAN be automated are automated here, and this script is
 * run where the answers actually live: inside the deployed backend container,
 * against the configured provider, by someone who can see the result.
 *
 * It is READ-MOSTLY and NON-DESTRUCTIVE:
 *   - the health probe writes ONE test object under `<prefix>_healthcheck/`
 *     and deletes it again;
 *   - parity, backfill and readiness are the same operations the admin panel
 *     performs;
 *   - it never enables s3_only, never changes readMode, never deletes a
 *     PostgreSQL row, and never alters the storage topology.
 *
 * ── Usage ────────────────────────────────────────────────────────
 *
 *   # inside the backend container (or anywhere with the admin API reachable)
 *   node scripts/analytics-production-verify.mjs \
 *     --base-url https://api.example.com \
 *     --token "$SUPER_ADMIN_ACCESS_TOKEN" \
 *     --workspace <uuid> [--workspace <uuid> ...] \
 *     [--backfill-from 2026-06-01 --backfill-to 2026-06-30] \
 *     [--json report.json]
 *
 * The token must belong to a Super Admin; every endpoint used is Super Admin
 * only and no credential is ever printed.
 *
 * Exit code is 0 when nothing is BLOCKED, 1 otherwise — so it can gate a
 * deployment pipeline.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ─── Arguments ───────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { workspaces: [], baseUrl: '', token: '', json: '', backfillFrom: '', backfillTo: '' };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--base-url': args.baseUrl = value; i++; break;
      case '--token': args.token = value; i++; break;
      case '--workspace': args.workspaces.push(value); i++; break;
      case '--json': args.json = value; i++; break;
      case '--backfill-from': args.backfillFrom = value; i++; break;
      case '--backfill-to': args.backfillTo = value; i++; break;
      case '--help': case '-h': args.help = true; break;
      default: break;
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.help || !args.baseUrl || !args.token) {
  console.log(`
Analytics production verifier (Phase 3A)

  --base-url <url>        Backend origin, e.g. https://api.example.com   (required)
  --token <jwt>           Super Admin access token                       (required)
  --workspace <uuid>      Workspace to run parity against (repeatable)
  --backfill-from <date>  Optional YYYY-MM-DD, rebuilds a range
  --backfill-to <date>    Optional YYYY-MM-DD
  --json <path>           Also write the full report as JSON

Non-destructive. Never enables s3_only, never deletes PostgreSQL rows.
`);
  process.exit(args.help ? 0 : 2);
}

const BASE = `${args.baseUrl.replace(/\/+$/, '')}/api/admin/analytics-storage`;

// ─── Reporting ───────────────────────────────────────────────────

const results = [];
let blocked = 0;

function record(section, state, detail, extra) {
  results.push({ section, state, detail, ...(extra ? { data: extra } : {}) });
  if (state === 'BLOCKED') blocked++;
  const mark = state === 'OK' ? '✅' : state === 'WARN' ? '⚠️ ' : '❌';
  console.log(`${mark} ${section.padEnd(34)} ${state.padEnd(8)} ${detail}`);
}

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 400) }; }
  return { ok: response.ok, status: response.status, body };
}

// ─── 1. Runtime and dependency, in THIS process ──────────────────

function checkRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 15);
  record(
    'Node runtime',
    supported ? 'OK' : 'BLOCKED',
    `${process.version} (requires >= 22.15)`,
    { version: process.version, platform: `${process.platform}/${process.arch}`, libc: os.version?.() ?? null },
  );

  const zstd = typeof zlib.zstdCompressSync === 'function';
  record('Parquet ZSTD codec', zstd ? 'OK' : 'BLOCKED', zstd ? 'zstdCompressSync available' : 'missing from node:zlib');

  let duck = null;
  try { duck = require.resolve('@duckdb/node-api'); } catch { duck = null; }
  record(
    '@duckdb/node-api installed',
    duck ? 'OK' : 'BLOCKED',
    duck ? 'resolved in this image' : 'NOT installed — S3 reads unavailable',
  );
}

// ─── 2. Status, readiness, durability ────────────────────────────

async function checkStatus() {
  const { ok, status, body } = await api('');
  if (!ok) {
    record('Admin API reachable', 'BLOCKED', `HTTP ${status}`);
    return null;
  }
  record('Admin API reachable', 'OK', `HTTP ${status}`);

  record(
    'Analytics Primary',
    body.primary ? 'OK' : 'BLOCKED',
    body.primary ? `${body.primary} (general primary: ${body.generalPrimary ?? 'none'})` : 'not configured',
    { primary: body.primary, replicas: body.replicas, generalPrimary: body.generalPrimary },
  );

  record(
    'Analytics Replicas',
    (body.replicas ?? []).length > 0 ? 'OK' : 'WARN',
    (body.replicas ?? []).length > 0 ? (body.replicas ?? []).join(', ') : 'none configured',
  );

  const engine = body.s3Read?.engineAvailable;
  record('Query engine (runtime)', engine ? 'OK' : 'BLOCKED',
    engine ? 'DuckDB loaded' : (body.s3Read?.engineReason ?? 'unavailable'));

  const durability = body.durability ?? {};
  record(
    'Durable spool',
    durability.ready ? (durability.enabled ? 'OK' : 'WARN') : 'BLOCKED',
    durability.ready
      ? `${durability.enabled ? 'active' : 'available but not enabled'}, segments=${durability.segments}, bytes=${durability.bytes}`
      : (durability.reason ?? 'not writable'),
    durability.capacity ?? null,
  );

  const instances = body.instances ?? {};
  record(
    'Backend instances',
    !instances.multiInstance ? 'OK' : instances.acknowledged ? 'WARN' : 'BLOCKED',
    instances.multiInstance
      ? `${instances.count} instances — per-instance durable volumes ${instances.acknowledged ? 'acknowledged' : 'NOT acknowledged'}`
      : 'single instance',
    instances,
  );

  // Write modes must still be locked in Phase 3A.
  record(
    'Phase lock intact',
    body.writeMode === 'dual_write' && body.readMode === 'postgres' ? 'OK' : 'BLOCKED',
    `writeMode=${body.writeMode} readMode=${body.readMode}`,
  );

  for (const check of body.readiness?.checks ?? []) {
    record(
      `Readiness: ${check.key}`,
      check.state === 'ready' ? 'OK' : check.state === 'warning' ? 'WARN' : 'BLOCKED',
      check.detail ?? '',
    );
  }

  return body;
}

// ─── 3. Real provider health round trip ──────────────────────────

async function checkProviderHealth(status) {
  const targets = [status?.primary, ...(status?.replicas ?? [])].filter(Boolean);
  for (const provider of targets) {
    const { ok, body } = await api(`/test/${encodeURIComponent(provider)}`, { method: 'POST' });
    const steps = body?.steps ?? {};
    const passed = ok && body?.success;
    record(
      `Provider round trip: ${provider}`,
      passed ? 'OK' : 'BLOCKED',
      passed
        ? `put/get/list/query/delete in ${body.latencyMs}ms`
        : (body?.error ?? 'failed') + ` steps=${JSON.stringify(steps)}`,
      { steps, latencyMs: body?.latencyMs, querySkippedReason: body?.querySkippedReason ?? null },
    );
  }
}

// ─── 4. Parity on real workspaces and real ranges ────────────────

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function checkParity() {
  if (args.workspaces.length === 0) {
    record('Production parity', 'WARN', 'no --workspace given; parity not run');
    return;
  }
  const windows = [
    { label: '1d', from: daysAgo(1), to: daysAgo(0) },
    { label: '7d', from: daysAgo(7), to: daysAgo(0) },
    { label: '30d', from: daysAgo(30), to: daysAgo(0) },
  ];

  for (const workspace of args.workspaces) {
    for (const window of windows) {
      const { ok, body } = await api('/parity', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: workspace,
          startDate: window.from,
          endDate: window.to,
          includeFunnels: true,
        }),
      });
      if (!ok) {
        record(`Parity ${workspace.slice(0, 8)} ${window.label}`, 'BLOCKED', body?.error ?? 'request failed');
        continue;
      }
      const summary = body.summary ?? {};
      const clean = (summary.mismatched ?? 0) === 0 && (summary.error ?? 0) === 0;
      // A run where EVERYTHING was skipped proves nothing and must not read as a pass.
      const provedSomething = (summary.matched ?? 0) > 0;
      record(
        `Parity ${workspace.slice(0, 8)} ${window.label}`,
        clean ? (provedSomething ? 'OK' : 'WARN') : 'BLOCKED',
        `matched=${summary.matched ?? 0} mismatched=${summary.mismatched ?? 0} `
        + `skipped=${summary.skipped ?? 0} error=${summary.error ?? 0} funnels=${body.funnelsCompared}`,
        {
          summary,
          // Digested field names only — no workspace dimension values.
          mismatches: (body.run?.reports ?? [])
            .filter((r) => r.status === 'mismatched' || r.status === 'error')
            .map((r) => ({ report: r.report, status: r.status, error: r.error, differences: r.differences })),
        },
      );
    }
  }
}

// ─── 5. Optional real backfill ───────────────────────────────────

async function checkBackfill() {
  if (!args.backfillFrom || !args.backfillTo || args.workspaces.length === 0) {
    record('Historical backfill', 'WARN', 'not requested (--backfill-from/--backfill-to)');
    return;
  }
  for (const workspace of args.workspaces) {
    let from = args.backfillFrom;
    const totals = { attempted: 0, verified: 0, failed: 0, sourceRows: 0, writtenRows: 0, objects: 0, bytes: 0 };
    // Resumable by contract: keep going while the server hands back a nextDay.
    for (let pass = 0; pass < 40 && from; pass++) {
      const { ok, body } = await api('/backfill/range', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: workspace, fromDay: from, toDay: args.backfillTo }),
      });
      if (!ok) {
        record(`Backfill ${workspace.slice(0, 8)}`, 'BLOCKED', body?.error ?? 'request failed');
        return;
      }
      const r = body.report;
      totals.attempted += r.attempted;
      totals.verified += r.verifiedDays;
      totals.failed += r.failedDays.length;
      totals.sourceRows += r.sourceRows;
      totals.writtenRows += r.writtenRows;
      totals.objects += r.objects;
      totals.bytes += r.bytes;
      from = r.nextDay;
    }
    const exact = totals.sourceRows === totals.writtenRows && totals.failed === 0;
    record(
      `Backfill ${workspace.slice(0, 8)}`,
      exact ? 'OK' : 'BLOCKED',
      `days=${totals.attempted} verified=${totals.verified} failed=${totals.failed} `
      + `sourceRows=${totals.sourceRows} writtenRows=${totals.writtenRows} `
      + `objects=${totals.objects} bytes=${totals.bytes}`,
      totals,
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────

console.log('\nAnalytics production verification — Phase 3A');
console.log('='.repeat(72));

checkRuntime();
const status = await checkStatus();
if (status) {
  await checkProviderHealth(status);
  await checkParity();
  await checkBackfill();
}

console.log('='.repeat(72));
const verdict = blocked === 0 ? 'READY FOR S3-ONLY CUTOVER' : 'NOT READY';
console.log(`\n${verdict}${blocked > 0 ? ` — ${blocked} blocker(s)` : ''}\n`);

if (blocked > 0) {
  console.log('Blockers:');
  for (const r of results.filter((x) => x.state === 'BLOCKED')) console.log(`  - ${r.section}: ${r.detail}`);
  console.log('');
}

if (args.json) {
  fs.writeFileSync(args.json, JSON.stringify({
    at: new Date().toISOString(),
    verdict,
    blocked,
    node: process.version,
    results,
  }, null, 2));
  console.log(`Full report written to ${args.json}\n`);
}

process.exit(blocked === 0 ? 0 : 1);
