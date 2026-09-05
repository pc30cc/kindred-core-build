/**
 * Minimal, dependency-free Redis (RESP2) client.
 *
 * WHY NOT ioredis: the only Redis usage in this codebase is an ephemeral
 * discovery index (sorted-set ZADD / ZRANGEBYSCORE). Pulling a full client
 * library into a self-hosted deployment for four commands is not worth the
 * dependency surface, and Redis here is strictly a cache: every failure mode
 * degrades to "no index", never to wrong data.
 *
 * Properties that matter:
 *   • one lazily-opened socket per URL, commands pipelined FIFO
 *   • per-command timeout, so a hung Redis cannot hang an HTTP request
 *   • circuit breaker: after a failure the client refuses for COOLDOWN_MS
 *     instead of opening a socket per request
 *   • never throws asynchronously outside a command promise
 */
import net from 'node:net';
import tls from 'node:tls';

export type RespValue = string | number | null | RespValue[];

const COMMAND_TIMEOUT_MS = 1_500;
const CONNECT_TIMEOUT_MS = 1_500;
const COOLDOWN_MS = 5_000;

interface Pending {
  resolve: (v: RespValue) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function encode(args: Array<string | number>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const s = Buffer.from(String(arg));
    parts.push(Buffer.from(`$${s.length}\r\n`), s, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** Parse one RESP value. Returns null when the buffer holds a partial reply. */
function parse(buf: Buffer, start: number): { value: RespValue; next: number } | null {
  if (start >= buf.length) return null;
  const nl = buf.indexOf('\r\n', start);
  if (nl < 0) return null;
  const type = buf[start];
  const head = buf.toString('utf8', start + 1, nl);
  const after = nl + 2;

  switch (type) {
    case 0x2b: // +simple
      return { value: head, next: after };
    case 0x2d: // -error
      throw new Error(head);
    case 0x3a: // :integer
      return { value: Number(head), next: after };
    case 0x24: {
      // $bulk
      const len = Number(head);
      if (len < 0) return { value: null, next: after };
      if (buf.length < after + len + 2) return null;
      return { value: buf.toString('utf8', after, after + len), next: after + len + 2 };
    }
    case 0x2a: {
      // *array
      const count = Number(head);
      if (count < 0) return { value: null, next: after };
      const items: RespValue[] = [];
      let cursor = after;
      for (let i = 0; i < count; i += 1) {
        const item = parse(buf, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`Unsupported RESP type: ${String.fromCharCode(type)}`);
  }
}

export class MiniRedisClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private pending: Pending[] = [];
  private blockedUntil = 0;

  constructor(private readonly url: string) {}

  /** True when the client is in its post-failure cooldown. */
  isBlocked(now: number = Date.now()): boolean {
    return now < this.blockedUntil;
  }

  async command(...args: Array<string | number>): Promise<RespValue> {
    if (this.isBlocked()) throw new Error('redis unavailable (cooldown)');
    const socket = await this.connect();
    return await new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('redis command timeout'));
      }, COMMAND_TIMEOUT_MS);
      this.pending.push({ resolve, reject, timer });
      socket.write(encode(args));
    });
  }

  close(): void {
    this.fail(new Error('closed'));
  }

  /* ─────────────────────────── internals ─────────────────────────── */

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(this.url);
      } catch {
        reject(new Error('invalid redis url'));
        return;
      }
      const secure = parsed.protocol === 'rediss:';
      const port = Number(parsed.port || 6379);
      const host = parsed.hostname;
      const socket = secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });

      socket.setNoDelay(true);
      const onFail = (err: Error) => {
        socket.destroy();
        this.blockedUntil = Date.now() + COOLDOWN_MS;
        reject(err);
      };
      const timer = setTimeout(() => onFail(new Error('redis connect timeout')), CONNECT_TIMEOUT_MS);

      socket.once('error', onFail);
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', onFail);
        socket.on('error', (err: Error) => this.fail(err));
        socket.on('close', () => this.fail(new Error('redis connection closed')));
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        this.socket = socket;

        const auth: Array<string | number> | null = parsed.password
          ? parsed.username && parsed.username !== 'default'
            ? ['AUTH', decodeURIComponent(parsed.username), decodeURIComponent(parsed.password)]
            : ['AUTH', decodeURIComponent(parsed.password)]
          : null;
        const dbPath = parsed.pathname.replace(/^\//, '');
        const selectDb = dbPath && /^\d+$/.test(dbPath) ? Number(dbPath) : null;

        (async () => {
          try {
            if (auth) await this.command(...auth);
            if (selectDb !== null && selectDb > 0) await this.command('SELECT', selectDb);
            resolve(socket);
          } catch (err) {
            onFail(err as Error);
          }
        })();
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      let result: { value: RespValue; next: number } | null;
      try {
        result = parse(this.buf, 0);
      } catch (err) {
        // A `-ERR` reply belongs to the head command only; the connection
        // stays usable.
        const nl = this.buf.indexOf('\r\n');
        this.buf = nl >= 0 ? this.buf.subarray(nl + 2) : Buffer.alloc(0);
        const p = this.pending.shift();
        if (p) {
          clearTimeout(p.timer);
          p.reject(err as Error);
        }
        continue;
      }
      if (!result) return;
      this.buf = this.buf.subarray(result.next);
      const p = this.pending.shift();
      if (p) {
        clearTimeout(p.timer);
        p.resolve(result.value);
      }
      if (!this.buf.length) return;
    }
  }

  private fail(err: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.blockedUntil = Date.now() + COOLDOWN_MS;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}

const clients = new Map<string, MiniRedisClient>();

/** Process-wide pooled client for a URL (one socket per distinct URL). */
export function getRedisClient(url: string): MiniRedisClient {
  let client = clients.get(url);
  if (!client) {
    client = new MiniRedisClient(url);
    clients.set(url, client);
  }
  return client;
}

/** Test hook — drop every pooled client. */
export function resetRedisClients(): void {
  for (const c of clients.values()) c.close();
  clients.clear();
}
