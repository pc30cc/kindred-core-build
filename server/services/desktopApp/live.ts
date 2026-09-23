/**
 * WHO IS RUNNING THE WINDOWS APP RIGHT NOW — and platform-wide broadcasts.
 *
 * Deliberately in memory, never in the database (Super Admin asked for a
 * live number, not a history): every running copy of the Windows app sends a
 * heartbeat every `HEARTBEAT_SECONDS`, and a copy that has not been heard
 * from for `STALE_AFTER_MS` stops counting. Restarting the server forgets
 * everything, which is the point.
 *
 * Broadcasts ride the same heartbeat back: the reply carries every
 * broadcast newer than the one the app last saw, so a notice reaches every
 * open copy within one heartbeat without a new realtime channel. They also
 * live only in memory, for `BROADCAST_TTL_MS`.
 *
 * With several API nodes each node counts the copies that reach it; behind a
 * sticky load balancer that is still the full picture, otherwise the admin
 * page shows the node it asked.
 */
import { randomUUID } from 'node:crypto';

export const HEARTBEAT_SECONDS = 45;
const STALE_AFTER_MS = 3 * 60_000;
const BROADCAST_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_BROADCASTS = 50;

export interface LiveSession {
  sessionId: string;
  userId: string;
  workspaceId: string | null;
  version: string | null;
  os: string | null;
  firstSeen: number;
  lastSeen: number;
}

export type BroadcastSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface Broadcast {
  id: string;
  seq: number;
  title: string;
  body: string;
  severity: BroadcastSeverity;
  url: string | null;
  createdAt: string;
  createdBy: string;
}

const sessions = new Map<string, LiveSession>();
let broadcasts: Broadcast[] = [];
// Starts at the boot time so numbers keep rising across restarts: an app
// that last saw #N before a restart still gets everything sent after it.
let seq = Date.now();

function prune(now = Date.now()): void {
  for (const [id, s] of sessions) if (now - s.lastSeen > STALE_AFTER_MS) sessions.delete(id);
  broadcasts = broadcasts.filter((b) => now - Date.parse(b.createdAt) < BROADCAST_TTL_MS);
}

export function heartbeat(input: Omit<LiveSession, 'firstSeen' | 'lastSeen'>): void {
  const now = Date.now();
  const existing = sessions.get(input.sessionId);
  // A session id is only ever reused by the same signed-in user.
  if (existing && existing.userId !== input.userId) sessions.delete(input.sessionId);
  sessions.set(input.sessionId, {
    ...input,
    firstSeen: existing && existing.userId === input.userId ? existing.firstSeen : now,
    lastSeen: now,
  });
  if (sessions.size % 50 === 0) prune(now);
}

export function goodbye(sessionId: string, userId: string): void {
  const s = sessions.get(sessionId);
  if (s && s.userId === userId) sessions.delete(sessionId);
}

export interface LiveSummary {
  online: number;
  users: number;
  workspaces: number;
  versions: Array<{ version: string; count: number }>;
  heartbeatSeconds: number;
  since: string;
}

const startedAt = new Date().toISOString();

export function summary(): LiveSummary {
  prune();
  const users = new Set<string>();
  const workspaces = new Set<string>();
  const versions = new Map<string, number>();
  for (const s of sessions.values()) {
    users.add(s.userId);
    if (s.workspaceId) workspaces.add(s.workspaceId);
    const v = s.version || 'unknown';
    versions.set(v, (versions.get(v) ?? 0) + 1);
  }
  return {
    online: sessions.size,
    users: users.size,
    workspaces: workspaces.size,
    versions: [...versions.entries()]
      .map(([version, count]) => ({ version, count }))
      .sort((a, b) => b.count - a.count),
    heartbeatSeconds: HEARTBEAT_SECONDS,
    since: startedAt,
  };
}

export function addBroadcast(input: { title: string; body: string; severity: BroadcastSeverity; url: string | null; createdBy: string }): Broadcast {
  prune();
  const b: Broadcast = { ...input, id: randomUUID(), seq: ++seq, createdAt: new Date().toISOString() };
  broadcasts = [...broadcasts, b].slice(-MAX_BROADCASTS);
  return b;
}

export function removeBroadcast(id: string): boolean {
  const before = broadcasts.length;
  broadcasts = broadcasts.filter((b) => b.id !== id);
  return broadcasts.length !== before;
}

export function listBroadcasts(): Broadcast[] {
  prune();
  return [...broadcasts].reverse();
}

/**
 * Broadcasts newer than `afterSeq`. A copy that has never seen any (first
 * heartbeat, afterSeq < 0) is only told the sequence number, not the backlog,
 * so opening the app does not replay a week of notices.
 */
export function broadcastsAfter(afterSeq: number): { items: Broadcast[]; latest: number } {
  prune();
  if (afterSeq < 0) return { items: [], latest: seq };
  return { items: broadcasts.filter((b) => b.seq > afterSeq), latest: seq };
}

/** Test hook. */
export function __resetLive(): void {
  sessions.clear();
  broadcasts = [];
  seq = Date.now();
}
