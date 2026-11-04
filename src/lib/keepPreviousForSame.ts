import type { QueryKey } from '@tanstack/react-query';

/**
 * `placeholderData` that keeps the previous result on screen while a new key
 * loads (a page, a filter, a tab), but only while the key still names the same
 * entity: the first `prefixLength` parts of the previous query's key must equal
 * the new key's. A key that moved to another workspace, thread or account
 * starts empty (and shows its loader) instead of drawing the old one's rows
 * under the new header, where clicking them acts on the wrong thing.
 */
export function keepPreviousForSame(currentKey: QueryKey, prefixLength: number) {
  return <T>(previousData: T | undefined, previousQuery?: { queryKey: QueryKey }): T | undefined => {
    if (previousData === undefined || !previousQuery) return undefined;
    const prevKey = previousQuery.queryKey;
    for (let i = 0; i < prefixLength; i += 1) {
      if (!Object.is(prevKey[i], currentKey[i])) return undefined;
    }
    return previousData;
  };
}
