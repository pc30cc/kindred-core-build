// @vitest-environment node
/**
 * The cluster's lifecycle, with real processes (docs/operations/
 * BACKEND_PROCESSES.md): server/cluster/primary.ts forks workers that run
 * the real cluster/worker.ts, hub client and processShutdown around a stub
 * HTTP server (fixtures/stubWorker.ts), under `node --import tsx` and once
 * under the tsx CLI, the chain production runs (`npx tsx start.ts`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const RUNNER = 'src/test/cluster/fixtures/primaryRunner.ts';

interface Primary {
  child: ChildProcess;
  port: number;
  output: () => string;
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const running: ChildProcess[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function startPrimary(env: Record<string, string> = {}, viaTsxCli = false): Promise<Primary> {
  const port = await freePort();
  const args = viaTsxCli ? ['node_modules/tsx/dist/cli.mjs', RUNNER] : ['--import', 'tsx', RUNNER];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let out = '';
  const waiters: Array<() => void> = [];
  const onData = (d: Buffer) => {
    out += d.toString();
    waiters.splice(0).forEach((w) => w());
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  const waitFor = (pattern: RegExp, timeoutMs = 20_000) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; output:\n${out}`)), timeoutMs);
      const check = () => {
        if (pattern.test(out)) {
          clearTimeout(timer);
          resolve();
        } else waiters.push(check);
      };
      check();
    });
  return { child, port, output: () => out, waitFor, exited };
}

/** One request on a fresh connection (so round-robin can pick another worker). */
function get(port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path, agent: false, headers: { connection: 'close' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (text: string, re: RegExp) => (text.match(new RegExp(re.source, 'g')) ?? []).length;

afterEach(() => {
  for (const child of running.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

describe('the cluster lifecycle', () => {
  it('(a, b) /health is 503 until every worker listens, then 200; fresh connections reach both workers', async () => {
    const p = await startPrimary({ FIXTURE_LISTEN_DELAY_INDEX: '1', FIXTURE_LISTEN_DELAY_MS: '1500' });
    await p.waitFor(/w0 listening/);
    const early = await get(p.port, '/health');
    expect(early.status).toBe(503);
    await p.waitFor(/all 2 listening/);
    await sleep(100);
    const pids = new Set<unknown>();
    for (let i = 0; i < 10; i++) {
      const res = await get(p.port, '/health');
      expect(res.status).toBe(200);
      pids.add(res.body.pid);
    }
    expect(pids.size).toBe(2);
    p.child.kill('SIGTERM');
    expect((await p.exited).code).toBe(0);
  }, 40_000);

  it('(c) SIGTERM: one drain per worker, answers during the lead\'s drain, no respawn, exit 0 after the last', async () => {
    const p = await startPrimary({ FIXTURE_DRAIN_MS: '2000' });
    await p.waitFor(/all 2 listening/);
    const lead = (await get(p.port, '/pid')).body.pid;
    p.child.kill('SIGTERM');
    await p.waitFor(/w1 exited \(code 0\)/);
    const during = await get(p.port, '/pid');
    expect(during.status).toBe(200);
    expect(during.body.pid === lead || during.body.index === 0).toBe(true);
    const { code } = await p.exited;
    expect(code).toBe(0);
    const out = p.output();
    expect(count(out, /\[w0\] \[shutdown\] SIGTERM received/)).toBe(1);
    expect(count(out, /\[w1\] \[shutdown\] SIGTERM received/)).toBe(1);
    expect(out).not.toMatch(/respawning/);
    expect(out.trim().split('\n').pop()).toBe('[cluster] all workers exited');
  }, 40_000);

  it('(c) the same under the tsx CLI, the chain production runs', async () => {
    const p = await startPrimary({ FIXTURE_DRAIN_MS: '500' }, true);
    await p.waitFor(/all 2 listening/);
    p.child.kill('SIGTERM');
    const { code } = await p.exited;
    expect(code).toBe(0);
    expect(count(p.output(), /\[shutdown\] SIGTERM received/)).toBe(2);
    expect(p.output()).toMatch(/all workers exited/);
  }, 40_000);

  it('(d) a killed worker is respawned with its role and share, and its locks are released', async () => {
    // 3 workers of DATABASE_POOL_MAX=15: shares 5+4+4, so the share tells them apart.
    const p = await startPrimary({ FIXTURE_N: '3' });
    await p.waitFor(/all 3 listening/);
    const before = new Map<unknown, Record<string, unknown>>();
    while (before.size < 3) {
      const w = (await get(p.port, '/pid')).body;
      before.set(w.pid, w);
    }
    expect([...before.values()].map((w) => `${w.index}:${w.role}:${w.pool}:${w.ready}`).sort()).toEqual([
      '0:lead:5:0',
      '1:follower:4:0',
      '2:follower:4:0',
    ]);
    // A worker takes lock x and never releases it; then that worker is killed.
    let holder = await get(p.port, '/hold');
    const victim = holder.body.pid as number;
    const was = before.get(victim)!;
    process.kill(victim, 'SIGKILL');
    await p.waitFor(/exited \(signal SIGKILL\).*respawning/);
    const started = Date.now();
    // The other worker gets the lock at once instead of after its 5 s bound.
    let lock = await get(p.port, '/lock?hold=10');
    while (lock.body.pid === victim) lock = await get(p.port, '/lock?hold=10');
    expect(Date.now() - started).toBeLessThan(4_000);
    await p.waitFor(new RegExp(`w${was.index} listening after[\\s\\S]*w${was.index} listening after`));
    const out = p.output();
    expect(out).toMatch(new RegExp(`w${was.index} \\(${was.role}\\) exited \\(signal SIGKILL\\)`));
    // The new worker has the dead one's index, role and pool share, and starts ready.
    holder = await get(p.port, '/pid');
    while (before.has(holder.body.pid)) holder = await get(p.port, '/pid');
    expect(holder.body).toMatchObject({ index: was.index, role: was.role, pool: was.pool, ready: '1' });
    p.child.kill('SIGTERM');
    expect((await p.exited).code).toBe(0);
  }, 40_000);

  it('(e) a crash loop (here 3 exits of one worker within the window; 5 by default): the primary exits 1', async () => {
    const p = await startPrimary({ FIXTURE_CRASH_INDEX: '1', FIXTURE_CRASH_LOOP: '3' });
    const { code } = await p.exited;
    expect(code).toBe(1);
    expect(p.output()).toMatch(/w1 exited 3 times within .*crash loop/);
  }, 40_000);

  it('(f) a worker that exits before it ever listened: the container did not start, exit 1', async () => {
    const p = await startPrimary({ FIXTURE_FAIL_BOOT_INDEX: '1' });
    const { code } = await p.exited;
    expect(code).toBe(1);
    expect(p.output()).toMatch(/w1 exited \(code 3\) before it listened/);
  }, 40_000);

  it('(g) a worker that ignores SIGTERM is SIGKILLed after the bound', async () => {
    const p = await startPrimary({ FIXTURE_IGNORE_SIGTERM_INDEX: '1', FIXTURE_STOP_MS: '1500' });
    await p.waitFor(/all 2 listening/);
    p.child.kill('SIGTERM');
    const { code } = await p.exited;
    expect(code).toBe(0);
    expect(p.output()).toMatch(/w1 still running after 1\.5 s: SIGKILL/);
    expect(p.output()).toMatch(/w1 exited \(signal SIGKILL\)/);
  }, 40_000);

  it('(h) a second SIGTERM ends the primary at once', async () => {
    const p = await startPrimary({ FIXTURE_DRAIN_MS: '10000' });
    await p.waitFor(/all 2 listening/);
    p.child.kill('SIGTERM');
    await p.waitFor(/stopping 2 worker/);
    const t0 = Date.now();
    p.child.kill('SIGTERM');
    await p.exited;
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 40_000);

  it('(j) a wedged lead is SIGKILLed by its watchdog and respawned, ready; the follower keeps answering', async () => {
    const p = await startPrimary({ FIXTURE_WEDGE_INDEX: '0', FIXTURE_WATCHDOG_MS: '6000' });
    await p.waitFor(/all 2 listening/);
    await p.waitFor(/w0 \(lead\) has not been heard from for [\d.]+ s: its loops have stopped; SIGKILL and respawn/, 20_000);
    await p.waitFor(/w0 \(lead\) exited \(signal SIGKILL\)/);
    await p.waitFor(/w0 listening after[\s\S]*w0 listening after/);
    let res = await get(p.port, '/pid');
    for (let i = 0; i < 20 && res.body.index !== 0; i++) res = await get(p.port, '/pid');
    expect(res.body).toMatchObject({ index: 0, role: 'lead', ready: '1' });
    p.child.kill('SIGTERM');
    expect((await p.exited).code).toBe(0);
    expect(count(p.output(), /\[w1\] \[shutdown\] SIGTERM received/)).toBe(1);
  }, 40_000);

  it('(k) a respawn whose fork cannot start a process is retried with the backoff', async () => {
    const p = await startPrimary({ FIXTURE_SPAWN_FAIL_MS: '500' });
    await p.waitFor(/all 2 listening/);
    let follower = await get(p.port, '/pid');
    while (follower.body.index !== 1) follower = await get(p.port, '/pid');
    process.kill(follower.body.pid as number, 'SIGKILL');
    await p.waitFor(/w1 \(follower\) exited \(could not be started: ENOENT[^)]*\) after .*; respawning/);
    await p.waitFor(/w1 listening after[\s\S]*w1 listening after/);
    const out = p.output();
    expect(out).not.toMatch(/primary uncaught exception/);
    expect(out).not.toMatch(/crash loop/);
    let res = await get(p.port, '/pid');
    for (let i = 0; i < 20 && res.body.index !== 1; i++) res = await get(p.port, '/pid');
    expect(res.body).toMatchObject({ index: 1, ready: '1' });
    p.child.kill('SIGTERM');
    expect((await p.exited).code).toBe(0);
    // Two processes, each stopped once.
    expect(count(p.output(), /\[shutdown\] SIGTERM received/)).toBe(2);
  }, 40_000);

  it('(i) over real IPC: re-auth across workers once, the auth limiter counts across them, lock x is serialised', async () => {
    const p = await startPrimary();
    await p.waitFor(/all 2 listening/);
    const issued = await get(p.port, '/reauth');
    const token = String(issued.body.token);
    let taken = await get(p.port, `/take?token=${token}&not=${issued.body.pid}`);
    while (taken.status === 409) taken = await get(p.port, `/take?token=${token}&not=${issued.body.pid}`);
    expect(taken.body.pid).not.toBe(issued.body.pid);
    expect(taken.body.ok).toBe(true);
    expect((await get(p.port, `/take?token=${token}`)).body.ok).toBe(false);

    const statuses: number[] = [];
    const pids = new Set<unknown>();
    for (let i = 0; i < 6; i++) {
      const res = await get(p.port, '/limited');
      statuses.push(res.status);
      if (res.status === 200) pids.add(res.body.pid);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(pids.size).toBe(2);

    for (let attempt = 0; attempt < 5; attempt++) {
      const [x, y] = await Promise.all([get(p.port, '/lock?hold=300'), get(p.port, '/lock?hold=300')]);
      if (x.body.pid === y.body.pid) continue;
      const [first, second] = [x.body, y.body].sort((m, n) => Number(m.start) - Number(n.start));
      expect(Number(second.start)).toBeGreaterThanOrEqual(Number(first.end));
      break;
    }
    p.child.kill('SIGTERM');
    expect((await p.exited).code).toBe(0);
  }, 40_000);
});
