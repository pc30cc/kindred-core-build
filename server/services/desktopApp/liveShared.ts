/**
 * The desktop apps' live roster and broadcasts (live.ts) as the routes use
 * them. In the single process each facade is live.ts's own function, on its
 * own state, as before. In a cluster worker (docs/operations/
 * BACKEND_PROCESSES.md) the primary runs live.ts for the whole container, so
 * there is one roster, one broadcast list and one sequence, whichever worker
 * a heartbeat lands on.
 *
 * Without an answer from the primary: a heartbeat answers with no new
 * broadcast (the app asks again in HEARTBEAT_SECONDS), the admin's views show
 * this worker's (empty) copy, and adding or removing a broadcast fails (the
 * route answers 503) rather than reaching only one worker's apps. An add
 * whose answer did not come in time is taken back by its id, so the 503 holds
 * even when the primary added it late.
 */
import { randomUUID } from 'node:crypto';
import { hubActive, sharedCall, sharedSend } from '../../cluster/client.js';
import {
  addBroadcast,
  broadcastsAfter,
  goodbye,
  heartbeat,
  listBroadcasts,
  removeBroadcast,
  summary,
  type Broadcast,
  type BroadcastSeverity,
  type DesktopPlatform,
  type LiveSession,
  type LiveSummary,
} from './live.js';

export type HeartbeatInput = Omit<LiveSession, 'firstSeen' | 'lastSeen' | 'platform'> & { platform?: unknown };

/** heartbeat() and broadcastsAfter() as one operation. */
export function heartbeatAndBroadcasts(
  input: HeartbeatInput,
  afterSeq: number,
  platform: DesktopPlatform,
): Promise<{ items: Broadcast[]; latest: number }> {
  return sharedCall(
    'desktop.heartbeat',
    { input, afterSeq, platform },
    () => {
      heartbeat(input);
      return broadcastsAfter(afterSeq, platform);
    },
    { fallback: () => ({ items: [], latest: afterSeq }) },
  );
}

export function goodbyeShared(sessionId: string, userId: string): void {
  if (hubActive()) sharedSend('desktop.goodbye', { sessionId, userId });
  else goodbye(sessionId, userId);
}

export function summaryShared(platform?: DesktopPlatform): Promise<LiveSummary> {
  return sharedCall('desktop.summary', { platform }, () => summary(platform));
}

export function listBroadcastsShared(platform?: DesktopPlatform): Promise<Broadcast[]> {
  return sharedCall('desktop.list', { platform }, () => listBroadcasts(platform));
}

export function addBroadcastShared(input: {
  title: string;
  body: string;
  severity: BroadcastSeverity;
  url: string | null;
  platforms?: DesktopPlatform[];
  createdBy: string;
}): Promise<Broadcast> {
  // The id is chosen here so that a wait that timed out can take the
  // broadcast back by it: the primary may have added it after all, and the
  // route answers 503 (not added), so the admin's retry must not make a second.
  const id = hubActive() ? randomUUID() : undefined;
  return sharedCall('desktop.add', { input, id }, () => addBroadcast(input), {
    fallback: () => {
      // Sent after the add on the same channel, so the primary runs it next.
      sharedSend('desktop.remove', { id });
      throw new Error('desktop_broadcasts_unavailable');
    },
  });
}

export function removeBroadcastShared(id: string): Promise<boolean> {
  return sharedCall('desktop.remove', { id }, () => removeBroadcast(id), {
    fallback: () => {
      throw new Error('desktop_broadcasts_unavailable');
    },
  });
}
