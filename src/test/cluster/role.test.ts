// @vitest-environment node
/**
 * The cluster role counts only in a process node:cluster forked: a
 * BACKEND_CLUSTER_ROLE set by hand (a Coolify variable, a `docker exec`, a
 * test run) leaves the process single, running every loop, never waiting on
 * a hub (server/cluster/role.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  clusterRole,
  clusterSize,
  clusterWorkerIndex,
  clusterWorkerReady,
  runsBackgroundLoops,
  usesClusterHub,
} from '../../../server/cluster/role.js';

const inputs = (isWorker: boolean, env: Record<string, string>, hasChannel = true) => ({
  isWorker,
  env: env as NodeJS.ProcessEnv,
  hasChannel,
});

describe('cluster role', () => {
  it('this test process is single, even with the variables set by hand', () => {
    process.env.BACKEND_CLUSTER_ROLE = 'follower';
    try {
      expect(clusterRole()).toBe('single');
      expect(runsBackgroundLoops()).toBe(true);
      expect(usesClusterHub()).toBe(false);
      expect(clusterWorkerReady()).toBe(true);
    } finally {
      delete process.env.BACKEND_CLUSTER_ROLE;
    }
  });

  it('outside a cluster worker the role is single whatever BACKEND_CLUSTER_ROLE says', () => {
    const i = inputs(false, { BACKEND_CLUSTER_ROLE: 'follower', BACKEND_CLUSTER_INDEX: '1', BACKEND_CLUSTER_SIZE: '2' });
    expect(clusterRole(i)).toBe('single');
    expect(runsBackgroundLoops(i)).toBe(true);
    expect(usesClusterHub(i)).toBe(false);
    expect(clusterWorkerIndex(i)).toBeNull();
    expect(clusterSize(i)).toBe(1);
  });

  it('a cluster worker takes its role, index and size from the primary', () => {
    const lead = inputs(true, { BACKEND_CLUSTER_ROLE: 'lead', BACKEND_CLUSTER_INDEX: '0', BACKEND_CLUSTER_SIZE: '3' });
    const follower = inputs(true, { BACKEND_CLUSTER_ROLE: 'follower', BACKEND_CLUSTER_INDEX: '2', BACKEND_CLUSTER_SIZE: '3' });
    expect([clusterRole(lead), runsBackgroundLoops(lead), usesClusterHub(lead), clusterWorkerIndex(lead)]).toEqual(['lead', true, true, 0]);
    expect([clusterRole(follower), runsBackgroundLoops(follower), clusterWorkerIndex(follower), clusterSize(follower)]).toEqual([
      'follower',
      false,
      2,
      3,
    ]);
  });

  it('a worker without a role, or without its IPC channel, uses no hub', () => {
    expect(clusterRole(inputs(true, {}))).toBe('single');
    expect(usesClusterHub(inputs(true, { BACKEND_CLUSTER_ROLE: 'lead' }, false))).toBe(false);
  });

  it('a worker is ready once told, or from the start when respawned after the container was ready', () => {
    expect(clusterWorkerReady(inputs(true, { BACKEND_CLUSTER_ROLE: 'follower' }))).toBe(false);
    expect(clusterWorkerReady(inputs(true, { BACKEND_CLUSTER_ROLE: 'follower', BACKEND_CLUSTER_READY: '1' }))).toBe(true);
    expect(clusterWorkerReady(inputs(true, { BACKEND_CLUSTER_ROLE: 'follower', BACKEND_CLUSTER_READY: '0' }))).toBe(false);
  });
});
