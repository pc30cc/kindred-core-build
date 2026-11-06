// @vitest-environment node
/**
 * With BACKEND_PROCESSES unset the backend is one process, as before: every
 * facade of the cluster hub takes its local branch — today's function on
 * today's module state — and nothing is ever sent over IPC; each limiter's
 * options are exactly what they were (docs/operations/BACKEND_PROCESSES.md).
 */
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hubActive, hubLimiterStore } from '../../../server/cluster/client.js';
import { usesClusterHub } from '../../../server/cluster/role.js';
import { consumeReauth, consumeReauthToken, issueReauth, issueReauthToken } from '../../../server/services/privacy/reauth.js';
import { takePrivacyJobSlot, __resetPrivacyJobSlots } from '../../../server/services/privacy/jobRateLimit.js';
import { checkBruteForce, recordLoginAttempt } from '../../../server/middleware/security.js';
import { __resetLoginAttempts, checkLoginKey } from '../../../server/middleware/loginAttempts.js';
import { __resetLive, broadcastsAfter, summary } from '../../../server/services/desktopApp/live.js';
import { addBroadcastShared, heartbeatAndBroadcasts, summaryShared } from '../../../server/services/desktopApp/liveShared.js';
import { mayRingForVisitor, resetCallRequestLimiter, takeCallRequest } from '../../../server/services/calls/callRequestLimiter.js';
import {
  giveBackSharedCallRequest,
  mayRingSharedForVisitor,
  takeSharedCallRequest,
} from '../../../server/services/calls/callRequestShared.js';
import { takeCalleeRing, takeSharedCalleeRing, __resetCalleeRings } from '../../../server/services/calls/calleeRingLimit.js';
import { lockConversationReplies } from '../../../server/services/operatorReplyJoin.js';
import { getOperatorActivityMetrics } from '../../../server/services/widget/operatorActivity.js';
import { holdTeamCallRing } from '../../../server/services/push/teamCallRing.js';

const send = vi.fn();
const originalSend = process.send;
beforeAll(() => {
  process.send = send as unknown as typeof process.send;
});
afterAll(() => {
  process.send = originalSend;
  expect(send).not.toHaveBeenCalled();
});

describe('the single process', () => {
  it('uses no hub', () => {
    expect(usesClusterHub()).toBe(false);
    expect(hubActive()).toBe(false);
  });

  it("every limiter's options stay as they were: no store is added", () => {
    expect(hubLimiterStore('auth')).toEqual({});
  });

  it('re-auth: issued and taken on the one module store, both ways', async () => {
    const a = await issueReauth('u1');
    expect(consumeReauthToken('u1', a.token)).toBe(true);
    const b = issueReauthToken('u1');
    expect(await consumeReauth('u1', b.token)).toBe(true);
    expect(await consumeReauth('u1', b.token)).toBe(false);
  });

  it('privacy job slots: 5 exports an hour, counted here', async () => {
    __resetPrivacyJobSlots();
    const got = [];
    for (let i = 0; i < 6; i++) got.push(await takePrivacyJobSlot('export', 'ws'));
    expect(got).toEqual([true, true, true, true, true, false]);
  });

  it("login: today's tracker, on its own map", async () => {
    __resetLoginAttempts();
    const req = { ip: '203.0.113.7' } as Request;
    for (let i = 0; i < 5; i++) await recordLoginAttempt(req, 'a@b.c', false);
    expect((await checkBruteForce(req, 'a@b.c')).blocked).toBe(true);
    expect(checkLoginKey('203.0.113.7:a@b.c').blocked).toBe(true);
  });

  it('desktop apps: the roster and broadcasts of live.ts', async () => {
    __resetLive();
    const first = await heartbeatAndBroadcasts({ sessionId: 's-1', userId: 'u', workspaceId: null, version: null, os: null }, -1, 'windows');
    expect(summary().online).toBe(1);
    const b = await addBroadcastShared({ title: 't', body: '', severity: 'info', url: null, createdBy: 'a' });
    expect(broadcastsAfter(first.latest).items.map((x) => x.id)).toEqual([b.id]);
    expect((await summaryShared()).online).toBe(1);
  });

  it('call limits: the limiter module\'s own maps', async () => {
    resetCallRequestLimiter();
    const d = await takeSharedCallRequest('ws:v', null);
    expect(d.ok).toBe(true);
    expect(takeCallRequest('ws:v', null).ok).toBe(false);
    if (d.ok) giveBackSharedCallRequest(d.ticket);
    expect(await mayRingSharedForVisitor('ws:v')).toBe(true);
    expect(mayRingForVisitor('ws:v')).toBe(false);
    __resetCalleeRings();
    for (let i = 0; i < 5; i++) expect(await takeSharedCalleeRing('c')).not.toBeNull();
    expect(takeCalleeRing('c')).not.toBeNull();
    expect(await takeSharedCalleeRing('c')).toBeNull();
  });

  it('locks: the in-process reply chain; the ring hold is a no-op', async () => {
    const release = await lockConversationReplies('c1');
    let second = false;
    const p = lockConversationReplies('c1').then((r) => { second = true; r(); });
    await new Promise((r) => setTimeout(r, 10));
    expect(second).toBe(false);
    release();
    await p;
    await expect(holdTeamCallRing('call-1')).resolves.toBeUndefined();
  });

  it('operator activity reports its usual backend', () => {
    expect(getOperatorActivityMetrics().backend).toBe('process_local');
  });
});
