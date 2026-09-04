import { describe, it, expect } from 'vitest';
import { selectNode, eligibleNodes, type NodeHealthMap } from './nodeRouter.js';
import { normalizeNodes, type CentrifugoNode } from './types.js';

const node = (over: Partial<CentrifugoNode> & { id: string }): CentrifugoNode =>
  normalizeNodes([
    {
      name: over.id,
      ws_url: `wss://${over.id}.example.com/connection/websocket`,
      api_url: `http://${over.id}:8000/api`,
      ...over,
    },
  ])[0];

const healthy = (connections?: number): NodeHealthMap[string] => ({
  status: 'healthy',
  checked_at: Date.now(),
  connections,
});

describe('eligibleNodes', () => {
  it('drops disabled, draining, non-accepting and zero-weight nodes', () => {
    const nodes = [
      node({ id: 'a' }),
      node({ id: 'b', enabled: false }),
      node({ id: 'c', draining: true }),
      node({ id: 'd', accepting_new_connections: false }),
      node({ id: 'e', weight: 0 }),
    ];
    expect(eligibleNodes(nodes).map((n) => n.id)).toEqual(['a']);
  });
});

describe('selectNode', () => {
  it('reports why nothing could be selected', () => {
    expect(selectNode([]).reason).toBe('no_nodes_configured');
    expect(selectNode([node({ id: 'a', enabled: false })]).reason).toBe('no_enabled_nodes');
    expect(selectNode([node({ id: 'a', draining: true })]).reason).toBe('no_accepting_nodes');
    expect(
      selectNode([node({ id: 'a' })], { a: { status: 'down', checked_at: Date.now() } }).reason,
    ).toBe('no_healthy_nodes');
  });

  it('never selects a draining node even when it is the healthiest', () => {
    const nodes = [node({ id: 'a', draining: true }), node({ id: 'b' })];
    const health: NodeHealthMap = { a: healthy(0), b: healthy(9999) };
    for (let i = 0; i < 50; i++) {
      expect(selectNode(nodes, health, () => i / 50).node?.id).toBe('b');
    }
  });

  it('prefers the node with fewer live connections (power of two choices)', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];
    const health: NodeHealthMap = { a: healthy(500), b: healthy(10) };
    const picks = new Set<string>();
    for (let i = 0; i < 100; i++) picks.add(selectNode(nodes, health, () => i / 100).node!.id);
    expect([...picks]).toEqual(['b']);
  });

  it('honours weight when connection counts are unknown', () => {
    const nodes = [node({ id: 'a', weight: 1 }), node({ id: 'b', weight: 100 })];
    const health: NodeHealthMap = { a: healthy(), b: healthy() };
    const counts: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 200; i++) counts[selectNode(nodes, health, () => (i % 100) / 100).node!.id]++;
    expect(counts.b).toBeGreaterThan(counts.a);
  });

  it('falls back to unprobed nodes only when nothing is proven usable', () => {
    const nodes = [node({ id: 'cold' })];
    expect(selectNode(nodes, {}).node?.id).toBe('cold');

    const mixed = [node({ id: 'cold' }), node({ id: 'warm' })];
    const health: NodeHealthMap = { warm: healthy(1) };
    for (let i = 0; i < 20; i++) {
      expect(selectNode(mixed, health, () => i / 20).node?.id).toBe('warm');
    }
  });

  it('spreads across nodes rather than herding onto one', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })];
    const health: NodeHealthMap = { a: healthy(), b: healthy(), c: healthy() };
    const seen = new Set<string>();
    let seed = 0;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 300; i++) seen.add(selectNode(nodes, health, rand).node!.id);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('is pure — selection performs no I/O and no persistence', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];
    const before = JSON.stringify(nodes);
    selectNode(nodes, { a: healthy(1), b: healthy(2) });
    expect(JSON.stringify(nodes)).toBe(before);
  });
});
