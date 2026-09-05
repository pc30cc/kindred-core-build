/**
 * MiniRedisClient — connection-handshake and failure-mode tests.
 *
 * Two layers:
 *   1. An in-process RESP2 server that ENFORCES AUTH (single- and two-arg),
 *      SELECT and NOAUTH errors — this runs everywhere, including CI.
 *   2. An opt-in integration suite against a REAL, password-protected Redis,
 *      enabled by setting REDIS_TEST_URL (e.g.
 *      `redis://:password@127.0.0.1:6379/0`, or a `rediss://` URL to also
 *      cover TLS). Skipped, never failed, when the variable is absent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';

import { MiniRedisClient, resetRedisClients } from './redisClient.js';

interface AuthFakeRedis {
  port: number;
  commands: string[][];
  close(): Promise<void>;
  dropConnections(): void;
}

/** RESP2 server requiring `password` (and optionally user `app`). */
async function startAuthRedis(opts: {
  password: string;
  username?: string;
}): Promise<AuthFakeRedis> {
  const commands: string[][] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* client-side teardown */ });
    let authed = false;
    let db = 0;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (!buf.startsWith('*')) return;
        const lines = buf.split('\r\n');
        const argc = Number(lines[0].slice(1));
        const needed = 1 + argc * 2;
        if (lines.length < needed + 1) return;
        const args: string[] = [];
        for (let i = 0; i < argc; i += 1) args.push(lines[2 + i * 2]);
        buf = lines.slice(needed).join('\r\n');
        commands.push(args);

        const cmd = args[0].toUpperCase();
        if (cmd === 'AUTH') {
          const user = args.length === 3 ? args[1] : 'default';
          const pass = args.length === 3 ? args[2] : args[1];
          const okUser = user === (opts.username ?? 'default');
          if (okUser && pass === opts.password) {
            authed = true;
            socket.write('+OK\r\n');
          } else {
            socket.write('-WRONGPASS invalid username-password pair\r\n');
          }
          continue;
        }
        if (!authed) {
          socket.write('-NOAUTH Authentication required.\r\n');
          continue;
        }
        if (cmd === 'SELECT') {
          db = Number(args[1]);
          socket.write('+OK\r\n');
          continue;
        }
        if (cmd === 'PING') {
          socket.write(`+PONG:${db}\r\n`);
          continue;
        }
        socket.write('+OK\r\n');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    commands,
    dropConnections: () => {
      for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

afterEach(() => {
  resetRedisClients();
});

describe('MiniRedisClient handshake', () => {
  it('sends single-arg AUTH and SELECT for redis://:password@host/2', async () => {
    const server = await startAuthRedis({ password: 's3cr3t' });
    const client = new MiniRedisClient(`redis://:s3cr3t@127.0.0.1:${server.port}/2`);
    try {
      await expect(client.command('PING')).resolves.toBe('PONG:2');
      expect(server.commands[0]).toEqual(['AUTH', 's3cr3t']);
      expect(server.commands[1]).toEqual(['SELECT', '2']);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('sends two-arg AUTH when a non-default username is present', async () => {
    const server = await startAuthRedis({ password: 'p@ss word', username: 'app' });
    const url = `redis://app:${encodeURIComponent('p@ss word')}@127.0.0.1:${server.port}/0`;
    const client = new MiniRedisClient(url);
    try {
      await expect(client.command('PING')).resolves.toBe('PONG:0');
      expect(server.commands[0]).toEqual(['AUTH', 'app', 'p@ss word']);
      // db 0 needs no SELECT
      expect(server.commands.some((c) => c[0].toUpperCase() === 'SELECT')).toBe(false);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('rejects on a wrong password and does not leak an authenticated socket', async () => {
    const server = await startAuthRedis({ password: 'right' });
    const client = new MiniRedisClient(`redis://:wrong@127.0.0.1:${server.port}`);
    try {
      await expect(client.command('PING')).rejects.toThrow(/WRONGPASS/);
      expect(client.isBlocked()).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('re-authenticates after the server drops the connection', async () => {
    const server = await startAuthRedis({ password: 's3cr3t' });
    const client = new MiniRedisClient(`redis://:s3cr3t@127.0.0.1:${server.port}/1`);
    try {
      await client.command('PING');
      server.dropConnections();
      await new Promise((r) => setTimeout(r, 20));
      // Cooldown is expected right after an unexpected close…
      await expect(client.command('PING')).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 5_100));
      // …and the next attempt performs a full AUTH + SELECT handshake again.
      await expect(client.command('PING')).resolves.toBe('PONG:1');
      const auths = server.commands.filter((c) => c[0].toUpperCase() === 'AUTH');
      expect(auths.length).toBe(2);
    } finally {
      client.close();
      await server.close();
    }
  }, 15_000);

  it('times out instead of hanging when the server never replies', async () => {
    const open = new Set<net.Socket>();
    const silent = net.createServer((sock) => {
      open.add(sock);
      sock.on('error', () => { /* teardown */ });
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as net.AddressInfo).port;
    const client = new MiniRedisClient(`redis://127.0.0.1:${port}`);
    try {
      await expect(client.command('PING')).rejects.toThrow(/timeout/i);
    } finally {
      client.close();
      for (const s of open) s.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  }, 10_000);

  it('rejects an unparseable url', async () => {
    const client = new MiniRedisClient('not-a-url');
    await expect(client.command('PING')).rejects.toThrow(/invalid redis url/);
  });
});

/* ───────────────── opt-in: real password-protected Redis ───────────────── */

const REAL_URL = process.env.REDIS_TEST_URL;

describe.skipIf(!REAL_URL)('MiniRedisClient against a real Redis', () => {
  it('authenticates, selects the db and round-trips a sorted set', async () => {
    const client = new MiniRedisClient(REAL_URL!);
    const key = `vp:index:test:${Date.now()}`;
    try {
      await expect(client.command('PING')).resolves.toBe('PONG');
      await client.command('ZADD', key, 1000, 'a');
      await client.command('ZADD', key, 5000, 'b');
      await client.command('ZREMRANGEBYSCORE', key, '-inf', '(2000');
      const members = await client.command('ZRANGEBYSCORE', key, '0', '+inf', 'LIMIT', 0, 10);
      expect(members).toEqual(['b']);
      await client.command('EXPIRE', key, 60);
    } finally {
      await client.command('DEL', key).catch(() => undefined);
      client.close();
    }
  });

  it('fails closed with a wrong password', async () => {
    const bad = new URL(REAL_URL!);
    bad.password = 'definitely-not-the-password';
    const client = new MiniRedisClient(bad.toString());
    await expect(client.command('PING')).rejects.toThrow();
    client.close();
  });
});
