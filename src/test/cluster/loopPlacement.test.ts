// @vitest-environment node
/**
 * Where each background loop runs when the backend runs several processes
 * (BACKEND_PROCESSES, docs/operations/BACKEND_PROCESSES.md). Every start call
 * in index.ts's listen callback is in exactly one of two lists:
 *
 *   LEAD_ONLY     runs once per container: in the single process, or in the
 *                 lead (worker 0). Each sits inside `if (runsLoops …)`.
 *   EVERY_WORKER  each process needs its own: never behind `runsLoops`.
 *
 * A new start call fails here until it is placed (and named in the runbook).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LEAD_ONLY = [
  'startAttachmentJanitor',
  'startDispatchLogJanitor',
  'startRecordingRetentionJanitor',
  'startVisitorDataRetention',
  'startPrivacyWorker',
  'startPrivacyExpirySweep',
  'startWorkspaceDeletionWorker',
  'startUserDeletionWorker',
  'startAiBillingRecovery',
  'startSimpleBillingJob',
  'startLockExportWorker',
  'startAlertingTicker',
  'startInProcessSourceWorker',
  'startAutoActionsTicker',
  'startFailoverTicker',
  'startReliabilityRollup',
  'startEnforcementTicker',
  'startCallQueueTicker',
  'startStaleConnectingSweep',
  'startStaleActiveSweep',
  'startMaxmindUpdateTicker',
  'startRankTrackingTicker',
  'startGmailWatchRenewalTicker',
  'startNotificationEmailTicker',
  'startChatRoutingTicker',
  'startConversationIdleCloseTicker',
  'startTeamCallTicker',
  'startAppReviewVisitorsTicker',
  'startDatabaseBackupScheduler',
  'startInvitationExpirySweeper',
  "import('../worker/intelligence/index.js')",
  "import('../worker/regression-runner/index.js')",
];

const EVERY_WORKER = [
  'startCacheBusListener',
  'syncSeatEntitlementMode',
  'startInvitationWorker',
  'startEmailOutboxWorker',
  'startPerfCollectors',
  'startAutoActionsCache',
  'startNodeHealthRefresher',
];

const index = readFileSync('server/index.ts', 'utf8');
const open = index.indexOf('const httpServer = app.listen(config.port, () => {');
const close = index.indexOf('\n});\n', open);
const callback = index.slice(open, close);

/** Each call in the callback, with whether `runsLoops` guards it. */
function calls(): Array<{ name: string; guarded: boolean }> {
  const out: Array<{ name: string; guarded: boolean }> = [];
  const stack: boolean[] = [];
  let header = '';
  const re = /\bstart[A-Z]\w*\(|\bsyncSeatEntitlementMode\(|import\('\.\.\/worker\/[^']+'\)/y;
  for (let i = 0; i < callback.length; i++) {
    re.lastIndex = i;
    const m = re.exec(callback);
    if (m) {
      const lineStart = callback.lastIndexOf('\n', i) + 1;
      const sameLine = callback.slice(lineStart, i).includes('if (runsLoops');
      const name = m[0].startsWith('import(') ? m[0] : m[0].slice(0, -1);
      out.push({ name, guarded: sameLine || stack.includes(true) });
      i += m[0].length - 1;
      continue;
    }
    const c = callback[i];
    if (c === '{') {
      stack.push(/\bif \(runsLoops\b/.test(header));
      header = '';
    } else if (c === '}') {
      stack.pop();
      header = '';
    } else if (c === ';') {
      header = '';
    } else {
      header += c;
    }
  }
  return out;
}

describe("index.ts's background loops", () => {
  const found = calls();

  it('every start call is placed in exactly one list', () => {
    const placed = new Set([...LEAD_ONLY, ...EVERY_WORKER]);
    expect(LEAD_ONLY.filter((n) => EVERY_WORKER.includes(n))).toEqual([]);
    expect(found.map((c) => c.name).filter((n) => !placed.has(n))).toEqual([]);
    // And every listed one is still there.
    expect([...placed].filter((n) => !found.some((c) => c.name === n))).toEqual([]);
  });

  it('the lead-only loops start only where runsLoops is true', () => {
    expect(found.filter((c) => LEAD_ONLY.includes(c.name) && !c.guarded).map((c) => c.name)).toEqual([]);
  });

  it("every worker's own loops are never behind runsLoops", () => {
    expect(found.filter((c) => EVERY_WORKER.includes(c.name) && c.guarded).map((c) => c.name)).toEqual([]);
  });

  it('runsLoops comes from the cluster role, at the top of the callback', () => {
    expect(callback).toMatch(/^\s*const runsLoops = runsBackgroundLoops\(\);$/m);
    expect(callback.indexOf('const runsLoops')).toBeLessThan(callback.indexOf('startCacheBusListener('));
  });

  it('the runbook names every loop where it runs', () => {
    const runbook = readFileSync('docs/operations/BACKEND_PROCESSES.md', 'utf8');
    for (const name of [...LEAD_ONLY, ...EVERY_WORKER]) {
      const bare = name.startsWith('import(') ? name.match(/worker\/([^/]+)\//)![1] : name;
      expect(runbook, name).toContain(bare);
    }
  });
});
