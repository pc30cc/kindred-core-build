/**
 * Size-first collections for zod 3 (GHSA-mrhx-c7xc-m3w5).
 *
 * In zod 3, `z.array(item).max(n)` records the too_big issue and then still
 * parses every element, adding one issue per bad element; `z.record` has no
 * size check at all. A request body of millions of invalid elements therefore
 * costs memory per element (and, where a route echoes `issues`/`flatten()`,
 * a response of the same size), whatever `.max()` says. The fix upstream is
 * zod 4.6.6+; until the repo moves there, untrusted collections use these:
 * the size is checked first, and the elements are parsed only when it fits
 * (a failed first stage of a pipeline never runs the second one).
 */
import { z } from 'zod';

export function boundedArray<T extends z.ZodTypeAny>(item: T, max: number, min = 0) {
  return z
    .custom<unknown[]>(
      (v) => Array.isArray(v) && v.length >= min && v.length <= max,
      { message: `Expected an array of ${min} to ${max} items` },
    )
    .pipe(z.array(item).min(min).max(max));
}

function hasAtMostKeys(v: unknown, maxKeys: number): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  let n = 0;
  for (const key in v) {
    if (Object.prototype.hasOwnProperty.call(v, key) && ++n > maxKeys) return false;
  }
  return true;
}

export function boundedRecord<V extends z.ZodTypeAny>(value: V, maxKeys: number) {
  return z
    .custom<Record<string, unknown>>(
      (v) => hasAtMostKeys(v, maxKeys),
      { message: `Expected an object of at most ${maxKeys} keys` },
    )
    .pipe(z.record(value));
}
