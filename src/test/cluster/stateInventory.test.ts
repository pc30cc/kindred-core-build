// @vitest-environment node
/**
 * Every server module with state in a module-level Map or Set is classified
 * in server/cluster/stateInventory.ts (hub, bus, per-worker, lead-only or
 * constant), so state that would silently split across the workers of
 * BACKEND_PROCESSES fails CI until someone decides where it lives.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_INVENTORY } from '../../../server/cluster/stateInventory.js';

const DECL = /^(?:export )?(?:const|let|var) ([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:[^=\n]+)?\s*=\s*new (?:Map|Set)\b(?:<[^\n]*?>)?\((.?)/gm;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Modules with module-level Map/Set state; an ALL_CAPS one built from a literal is a constant. */
function stateful(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files('server')) {
    const names: string[] = [];
    for (const [, name, first] of readFileSync(file, 'utf8').matchAll(DECL)) {
      const constant = /^[A-Z][A-Z0-9_]*$/.test(name) && first !== ')' && first !== '';
      if (!constant) names.push(name);
    }
    if (names.length) found.set(file.split('\\').join('/'), names);
  }
  return found;
}

describe('module state in server/**', () => {
  const found = stateful();

  it('every module with Map/Set state is classified', () => {
    expect([...found.keys()].filter((f) => !STATE_INVENTORY[f]).map((f) => `${f}: ${found.get(f)!.join(', ')}`)).toEqual([]);
  });

  it('no entry is left over', () => {
    expect(Object.keys(STATE_INVENTORY).filter((f) => !found.has(f))).toEqual([]);
  });

  it('every hub module is one the primary holds or a facade of it', () => {
    const hub = Object.entries(STATE_INVENTORY).filter(([, v]) => v.placement === 'hub').map(([f]) => f);
    const primary = readFileSync('server/cluster/hub.ts', 'utf8');
    for (const f of hub) {
      const src = readFileSync(f, 'utf8');
      const viaHub = /cluster\/(client|hub)\.js'/.test(src) || primary.includes(f.replace('server/', '../').replace(/\.ts$/, '.js'));
      expect(viaHub, f).toBe(true);
    }
  });

  it('every bus module registers a cache-bus handler', () => {
    for (const [f, v] of Object.entries(STATE_INVENTORY)) {
      if (v.placement === 'bus') expect(readFileSync(f, 'utf8'), f).toMatch(/onInvalidate\('/);
    }
  });
});
