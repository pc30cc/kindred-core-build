/**
 * WHO IS RUNNING THE DESKTOP APPS RIGHT NOW — and platform-wide broadcasts.
 *
 * Deliberately in memory, never in the database (Super Admin asked for a
 * live number, not a history): every running copy of the Windows and the Mac
 * app sends a
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

export const DESKTOP_PLATFORMS = ['windows', 'macos'] as const;
export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

/**
 * Which app a check-in came from: its own word when it gives one, else its
 * OS line (the Windows app, which predates the field, sends "Windows …").
 */
export function platformOf(platform: unknown, os: unknown): DesktopPlatform {
  if (platform === 'macos' || platform === 'windows') return platform;
  return /mac\s?os|os x|darwin/i.test(String(os ?? '')) ? 'macos' : 'windows';
}

export interface LiveSession {
  sessionId: string;
  userId: string;
  workspaceId: string | null;
  version: string | null;
  os: string | null;
  platform: DesktopPlatform;
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
  /// Which apps show it; empty means every desktop app.
  platforms: DesktopPlatform[];
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

export function heartbeat(
  input: Omit<LiveSession, 'firstSeen' | 'lastSeen' | 'platform'> & { platform?: unknown },
): void {
  const now = Date.now();
  const existing = sessions.get(input.sessionId);
  // A session id is only ever reused by the same signed-in user.
  if (existing && existing.userId !== input.userId) sessions.delete(input.sessionId);
  sessions.set(input.sessionId, {
    ...input,
    platform: platformOf(input.platform, input.os),
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
  /// Copies per app, whatever `platform` filter was asked for.
  platforms: Record<DesktopPlatform, number>;
  /// OS releases among the counted copies ("macOS Version 15.5 (Build …)").
  oses: Array<{ os: string; count: number }>;
  heartbeatSeconds: number;
  since: string;
}

const startedAt = new Date().toISOString();

export function summary(platform?: DesktopPlatform): LiveSummary {
  prune();
  const users = new Set<string>();
  const workspaces = new Set<string>();
  const versions = new Map<string, number>();
  const oses = new Map<string, number>();
  const platforms: Record<DesktopPlatform, number> = { windows: 0, macos: 0 };
  let online = 0;
  for (const s of sessions.values()) {
    platforms[s.platform] += 1;
    if (platform && s.platform !== platform) continue;
    online += 1;
    users.add(s.userId);
    if (s.workspaceId) workspaces.add(s.workspaceId);
    const v = s.version || 'unknown';
    versions.set(v, (versions.get(v) ?? 0) + 1);
    const o = s.os || 'unknown';
    oses.set(o, (oses.get(o) ?? 0) + 1);
  }
  const ranked = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  return {
    online,
    users: users.size,
    workspaces: workspaces.size,
    versions: ranked(versions).map(([version, count]) => ({ version, count })),
    platforms,
    oses: ranked(oses).map(([os, count]) => ({ os, count })),
    heartbeatSeconds: HEARTBEAT_SECONDS,
    since: startedAt,
  };
}

export function addBroadcast(input: {
  title: string;
  body: string;
  severity: BroadcastSeverity;
  url: string | null;
  platforms?: DesktopPlatform[];
  createdBy: string;
}): Broadcast {
  prune();
  const b: Broadcast = {
    ...input,
    platforms: [...new Set(input.platforms ?? [])],
    id: randomUUID(),
    seq: ++seq,
    createdAt: new Date().toISOString(),
  };
  broadcasts = [...broadcasts, b].slice(-MAX_BROADCASTS);
  return b;
}

export function removeBroadcast(id: string): boolean {
  const before = broadcasts.length;
  broadcasts = broadcasts.filter((b) => b.id !== id);
  return broadcasts.length !== before;
}

/** Newest first; with a platform, only what that app would show. */
export function listBroadcasts(platform?: DesktopPlatform): Broadcast[] {
  prune();
  return [...broadcasts].reverse().filter((b) => !platform || reaches(b, platform));
}

function reaches(b: Broadcast, platform: DesktopPlatform): boolean {
  return b.platforms.length === 0 || b.platforms.includes(platform);
}

/**
 * Broadcasts newer than `afterSeq`. A copy that has never seen any (first
 * heartbeat, afterSeq < 0) is only told the sequence number, not the backlog,
 * so opening the app does not replay a week of notices.
 */
export function broadcastsAfter(
  afterSeq: number,
  platform: DesktopPlatform = 'windows',
): { items: Broadcast[]; latest: number } {
  prune();
  if (afterSeq < 0) return { items: [], latest: seq };
  return { items: broadcasts.filter((b) => b.seq > afterSeq && reaches(b, platform)), latest: seq };
}

/** Test hook. */
export function __resetLive(): void {
  sessions.clear();
  broadcasts = [];
  seq = Date.now();
}
