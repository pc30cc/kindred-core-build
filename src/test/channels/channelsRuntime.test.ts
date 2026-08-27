/**
 * Channels runtime guardrails.
 *
 * These assertions encode the delivery contract we must not regress:
 *  - the Gateway acknowledges only PERMANENT failures (everything else must
 *    be retried by the provider, otherwise messages are silently lost);
 *  - the Channels Worker never writes canonical business tables.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyCoreResponse } from '../../../channels/delivery.js';

describe('gateway delivery classification', () => {
  it('acknowledges successful ingest', () => {
    expect(classifyCoreResponse(202, null)).toBe('ack');
    expect(classifyCoreResponse(200, null)).toBe('ack');
  });

  it('retries every server-side failure', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyCoreResponse(status, null)).toBe('retry');
    }
  });

  it('retries our own auth/config breakage instead of dropping the update', () => {
    expect(classifyCoreResponse(401, null)).toBe('retry');
    expect(classifyCoreResponse(403, null)).toBe('retry');
    expect(classifyCoreResponse(404, null)).toBe('retry');
    expect(classifyCoreResponse(400, 'some_new_unclassified_error')).toBe('retry');
  });

  it('acknowledges only explicitly permanent conditions', () => {
    expect(classifyCoreResponse(404, 'unknown_integration')).toBe('ack');
    expect(classifyCoreResponse(410, 'integration_disconnected')).toBe('ack');
    expect(classifyCoreResponse(400, 'invalid_payload')).toBe('ack');
  });
});

describe('worker boundary', () => {
  const workerSource = readFileSync(resolve(process.cwd(), 'worker/channels/index.ts'), 'utf8');

  it('never writes canonical business tables', () => {
    const canonicalTables = ['contacts', 'conversations', 'conversation_messages', 'contact_channels'];
    for (const table of canonicalTables) {
      expect(workerSource).not.toContain(`.from('${table}')`);
    }
  });

  it('only touches channel runtime tables directly', () => {
    const allowed = new Set(['channel_integrations', 'plugin_secrets', 'channel_worker_heartbeats']);
    const used = [...workerSource.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
    for (const table of used) expect(allowed).toContain(table);
  });

  it('reports delivery outcomes through Core, not by direct message updates', () => {
    expect(workerSource).toContain('/internal/channels/outbound-result');
  });
});
