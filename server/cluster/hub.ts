/**
 * The cluster primary's side of the request-path state that assumes one
 * process (docs/operations/BACKEND_PROCESSES.md, "The hub"): one copy for the
 * whole container, on the primary's single thread, run with the same
 * functions the single process uses on its own module state.
 *
 *   H1  privacy re-auth token hashes       services/privacy/reauth.ts
 *   H2  privacy job limits                 services/privacy/jobRateLimit.ts
 *   H3  login brute-force tracker          middleware/loginAttempts.ts
 *   H4  the guess-or-send limiters         cluster/rateLimitHub.ts
 *   H5  desktop-app roster and broadcasts  services/desktopApp/live.ts
 *   H6  call-request and ring-quiet limits services/calls/callRequestLimiter.ts
 *   H7  a callee's ring share              services/calls/calleeRingLimit.ts
 *   H8  operator active/away (no Redis)    services/widget/operatorActivityIndex.ts
 *   H9  keyed chain locks                  cluster/keyedLock.ts
 *   H10 the transcript claim               cluster/claims.ts
 *
 * Only the operations of cluster/protocol.ts reach it. Locks and claims
 * carry their owner (the worker's id), set here from the message's sender,
 * never from the message, and are released when that worker exits.
 * Nothing here opens a database connection or loads Express
 * (src/test/cluster/primaryImports.test.ts).
 */
import { storeReauthHash, takeReauthHash } from '../services/privacy/reauth.js';
import { takeLocalPrivacyJobSlot } from '../services/privacy/jobRateLimit.js';
import { checkLoginKey, recordLoginKey } from '../middleware/loginAttempts.js';
import {
  addBroadcast,
  broadcastsAfter,
  goodbye,
  heartbeat,
  listBroadcasts,
  removeBroadcast,
  summary,
  type BroadcastSeverity,
  type DesktopPlatform,
} from '../services/desktopApp/live.js';
import { giveBackCallRequest, mayRingForVisitor, takeCallRequest } from '../services/calls/callRequestLimiter.js';
import { giveBackCalleeRing, takeCalleeRing } from '../services/calls/calleeRingLimit.js';
import {
  pruneOperatorActivity,
  readOperatorActivity,
  stampOperatorActivity,
} from '../services/widget/operatorActivityIndex.js';
import { KeyedChainLocks } from './keyedLock.js';
import { ClaimSet } from './claims.js';
import { RateLimitHub } from './rateLimitHub.js';
import { isHubOp, type HubOp } from './protocol.js';

/** An operation's arguments as they arrive over IPC: read field by field. */
type Args = unknown;

const field = (a: unknown, key: string): unknown =>
  a !== null && typeof a === 'object' ? (a as Record<string, unknown>)[key] : undefined;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const platformOrUndefined = (v: unknown): DesktopPlatform | undefined => (v === 'windows' || v === 'macos' ? v : undefined);
const SEVERITIES: readonly BroadcastSeverity[] = ['info', 'success', 'warning', 'critical'];
const severityOf = (v: unknown): BroadcastSeverity =>
  SEVERITIES.includes(v as BroadcastSeverity) ? (v as BroadcastSeverity) : 'info';
const platformsOf = (v: unknown): DesktopPlatform[] | undefined =>
  Array.isArray(v) ? v.map(platformOrUndefined).filter((p): p is DesktopPlatform => !!p) : undefined;

/** A lock's wait is never longer than this, whatever a worker asks. */
const MAX_LOCK_WAIT_MS = 10 * 60_000;
const GC_EVERY_MS = 60_000;

export interface Hub {
  /** Runs one operation for worker `owner`; rejects for an unknown one. */
  handle(owner: number, op: string, args: Args): Promise<unknown>;
  /** Releases everything a worker that exited held. */
  releaseOwner(owner: number): void;
  gc(now?: number): void;
  stop(): void;
  readonly locks: KeyedChainLocks;
  readonly claims: ClaimSet;
}

export function createHub(opts: { gcEveryMs?: number | null; status?: () => unknown } = {}): Hub {
  const locks = new KeyedChainLocks();
  const claims = new ClaimSet();
  const limiters = new RateLimitHub();

  const ops: Record<HubOp, (owner: number, a: Args) => unknown> = {
    'reauth.store': (_o, a) => storeReauthHash(str(field(a, 'hash')), str(field(a, 'userId')), num(field(a, 'expiresAt'))),
    'reauth.take': (_o, a) => !!field(a, 'hash') && takeReauthHash(str(field(a, 'hash')), str(field(a, 'userId'))),
    'privacy.slot': (_o, a) =>
      takeLocalPrivacyJobSlot(field(a, 'action') === 'delete' ? 'delete' : 'export', str(field(a, 'key'))),
    'login.check': (_o, a) => checkLoginKey(str(field(a, 'key'))),
    'login.record': (_o, a) => recordLoginKey(str(field(a, 'key')), field(a, 'success') === true),
    'rl.increment': (_o, a) => limiters.increment(str(field(a, 'name')), num(field(a, 'windowMs')), str(field(a, 'key'))),
    'rl.decrement': (_o, a) => limiters.decrement(str(field(a, 'name')), num(field(a, 'windowMs')), str(field(a, 'key'))),
    'rl.resetKey': (_o, a) => limiters.resetKey(str(field(a, 'name')), num(field(a, 'windowMs')), str(field(a, 'key'))),
    'rl.get': (_o, a) => limiters.get(str(field(a, 'name')), num(field(a, 'windowMs')), str(field(a, 'key'))),
    'desktop.heartbeat': (_o, a) => {
      const input = field(a, 'input');
      heartbeat({
        sessionId: str(field(input, 'sessionId')),
        userId: str(field(input, 'userId')),
        workspaceId: strOrNull(field(input, 'workspaceId')),
        version: strOrNull(field(input, 'version')),
        os: strOrNull(field(input, 'os')),
        platform: field(input, 'platform'),
      });
      return broadcastsAfter(num(field(a, 'afterSeq'), -1), platformOrUndefined(field(a, 'platform')) ?? 'windows');
    },
    'desktop.goodbye': (_o, a) => goodbye(str(field(a, 'sessionId')), str(field(a, 'userId'))),
    'desktop.summary': (_o, a) => summary(platformOrUndefined(field(a, 'platform'))),
    'desktop.list': (_o, a) => listBroadcasts(platformOrUndefined(field(a, 'platform'))),
    'desktop.add': (_o, a) => {
      const input = field(a, 'input');
      // The id is the worker's (liveShared.ts): a worker whose wait for this
      // answer timed out removes it again by that id.
      return addBroadcast({
        title: str(field(input, 'title')),
        body: str(field(input, 'body')),
        severity: severityOf(field(input, 'severity')),
        url: strOrNull(field(input, 'url')),
        platforms: platformsOf(field(input, 'platforms')),
        createdBy: str(field(input, 'createdBy')),
        id: strOrNull(field(a, 'id')) ?? undefined,
      });
    },
    'desktop.remove': (_o, a) => removeBroadcast(str(field(a, 'id'))),
    'call.take': (_o, a) => takeCallRequest(strOrNull(field(a, 'visitorKey')), strOrNull(field(a, 'ipKey'))),
    'call.giveBack': (_o, a) =>
      giveBackCallRequest({
        visitorKey: strOrNull(field(a, 'visitorKey')),
        ipKey: strOrNull(field(a, 'ipKey')),
        at: num(field(a, 'at')),
      }),
    'call.mayRing': (_o, a) => mayRingForVisitor(strOrNull(field(a, 'visitorKey'))),
    'callee.take': (_o, a) => takeCalleeRing(str(field(a, 'calleeId'))),
    'callee.giveBack': (_o, a) => giveBackCalleeRing({ calleeId: str(field(a, 'calleeId')), at: num(field(a, 'at')) }),
    'activity.stamp': (_o, a) => stampOperatorActivity(str(field(a, 'key')), num(field(a, 'at'), NaN)),
    'activity.get': (_o, a) => {
      const keys = field(a, 'keys');
      return readOperatorActivity(Array.isArray(keys) ? keys.map(str).slice(0, 1000) : []);
    },
    'lock.acquire': (owner, a) =>
      locks
        .acquire(
          str(field(a, 'key')),
          Math.min(MAX_LOCK_WAIT_MS, Math.max(0, num(field(a, 'maxWaitMs')))),
          str(field(a, 'token')),
          owner,
        )
        .then(() => true),
    'lock.release': (_o, a) => locks.release(str(field(a, 'token'))),
    'claim.take': (owner, a) =>
      claims.take(str(field(a, 'ns')), str(field(a, 'key')), owner, Date.now(), strOrNull(field(a, 'token'))),
    'claim.release': (owner, a) =>
      claims.release(str(field(a, 'ns')), str(field(a, 'key')), owner, strOrNull(field(a, 'token'))),
    'cluster.status': () => (opts.status ? opts.status() : null),
  };

  const gc = (now: number = Date.now()) => {
    locks.gc(now);
    claims.gc(now);
    pruneOperatorActivity(now);
  };
  const gcEvery = opts.gcEveryMs === undefined ? GC_EVERY_MS : opts.gcEveryMs;
  const timer = gcEvery ? setInterval(() => gc(), gcEvery) : null;
  timer?.unref?.();

  return {
    locks,
    claims,
    async handle(owner, op, args) {
      if (!isHubOp(op)) throw new Error(`unknown_hub_op:${String(op).slice(0, 40)}`);
      return ops[op](owner, args);
    },
    releaseOwner(owner) {
      locks.releaseOwner(owner);
      claims.releaseOwner(owner);
    },
    gc,
    stop() {
      if (timer) clearInterval(timer);
      limiters.shutdown();
    },
  };
}
