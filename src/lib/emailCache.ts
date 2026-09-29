/**
 * Email Inbox device cache — IndexedDB, coordinated across tabs.
 *
 * The server keeps no email content (docs/EMAIL_INBOX_ARCHITECTURE.md), so
 * this browser is the only place a mailbox page or an opened thread is kept,
 * and only to show it again instantly:
 *
 *   - scope: one cache per user + workspace + mailbox, never shared;
 *   - bounded: entries expire after MAX_AGE_MS and each scope keeps at most
 *     MAX_ENTRIES_PER_SCOPE, least recently used evicted first;
 *   - cleared on sign-out, on disconnect, and when the server says the
 *     mailbox is no longer connected (access revoked);
 *   - a thread body is reused while its Gmail `historyId` is unchanged, so an
 *     opened email is not downloaded again;
 *   - `coordinatedFetch` takes a Web Lock per request key, so N tabs asking
 *     for the same thing make one request: the first fetches and stores, the
 *     others find it fresh in IndexedDB once they get the lock;
 *   - a BroadcastChannel tells other tabs to refresh or drop entries.
 *
 * Every storage call is best effort: private windows, blocked storage or an
 * old browser just mean no cache, never a broken inbox.
 */

const DB_NAME = 'webyar-email-cache';
const DB_VERSION = 1;
const STORE = 'entries';
const CHANNEL = 'webyar-email-cache';

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ENTRIES_PER_SCOPE = 300;

export interface CacheEntry<T = unknown> {
  key: string;
  scope: string;
  value: T;
  /** Gmail thread historyId for thread entries; the cursor for list entries. */
  version: string | null;
  storedAt: number;
  accessedAt: number;
}

export type CacheMessage =
  | { type: 'stored'; scope: string; key: string }
  | { type: 'dropped'; scope: string; keys: string[] }
  | { type: 'cleared'; scope: string | null };

export function emailCacheScope(userId: string, workspaceId: string, account: string): string {
  return `${userId}|${workspaceId}|${account.toLowerCase()}`;
}

export function listKey(scope: string, filter: string): string {
  return `${scope}|list|${filter}`;
}

export function threadKey(scope: string, threadId: string): string {
  return `${scope}|thread|${threadId}`;
}

export function cursorKey(scope: string): string {
  return `${scope}|cursor`;
}

// ─── IndexedDB plumbing ────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('scope', 'scope', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

function request<T>(req: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

async function scopeEntries(db: IDBDatabase, scope: string): Promise<CacheEntry[]> {
  const tx = db.transaction(STORE, 'readonly');
  const all = await request(tx.objectStore(STORE).index('scope').getAll(IDBKeyRange.only(scope)));
  return (all as CacheEntry[] | undefined) ?? [];
}

// ─── Clear epoch ───────────────────────────────────────────────────────
//
// Bumped by every clear (here or in another tab). A fetch that started before
// a clear must not write its result back afterwards — that would re-store a
// signed-out or disconnected mailbox.

let epoch = 0;

export function cacheEpoch(): number {
  return epoch;
}

// ─── Cross-tab channel ─────────────────────────────────────────────────

let channel: BroadcastChannel | null = null;
const listeners = new Set<(msg: CacheMessage) => void>();

function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => {
      const msg = event.data as CacheMessage;
      if (msg?.type === 'cleared') epoch++;
      for (const listener of listeners) listener(msg);
    };
  } catch {
    channel = null;
  }
  return channel;
}

function broadcast(msg: CacheMessage): void {
  try {
    getChannel()?.postMessage(msg);
  } catch {
    /* best effort */
  }
}

/** Messages from OTHER tabs (BroadcastChannel never echoes to the sender). */
export function onEmailCacheMessage(listener: (msg: CacheMessage) => void): () => void {
  getChannel();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── Public API ────────────────────────────────────────────────────────

export async function readEntry<T>(key: string): Promise<CacheEntry<T> | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const entry = (await request(store.get(key))) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() - entry.storedAt > MAX_AGE_MS) {
      store.delete(key);
      await done(tx);
      return null;
    }
    store.put({ ...entry, accessedAt: Date.now() });
    await done(tx);
    return entry;
  } catch {
    return null;
  }
}

export async function writeEntry<T>(
  scope: string,
  key: string,
  value: T,
  version: string | null,
  startedAtEpoch: number = epoch,
): Promise<void> {
  try {
    if (startedAtEpoch !== epoch) return;
    const db = await openDb();
    if (!db || startedAtEpoch !== epoch) return;
    const now = Date.now();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, scope, value, version, storedAt: now, accessedAt: now } satisfies CacheEntry<T>);
    await done(tx);
    broadcast({ type: 'stored', scope, key });
    void prune(scope);
  } catch {
    /* best effort */
  }
}

/** Rewrites one entry in place (same version), e.g. a label change on a cached thread. */
export async function patchEntry<T>(scope: string, key: string, patch: (value: T) => T): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const entry = (await request(store.get(key))) as CacheEntry<T> | undefined;
    if (entry) store.put({ ...entry, value: patch(entry.value) });
    await done(tx);
    if (entry) broadcast({ type: 'stored', scope, key });
  } catch {
    /* best effort */
  }
}

export async function dropEntries(scope: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    for (const key of keys) tx.objectStore(STORE).delete(key);
    await done(tx);
    broadcast({ type: 'dropped', scope, keys });
  } catch {
    /* best effort */
  }
}

/** Drops every list page of a scope (thread bodies stay; they carry their own version). */
export async function dropLists(scope: string): Promise<void> {
  await dropByPrefix(scope, `${scope}|list|`);
}

/** Drops every cached thread body of a scope. */
export async function dropThreads(scope: string): Promise<void> {
  await dropByPrefix(scope, `${scope}|thread|`);
}

async function dropByPrefix(scope: string, prefix: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const keys = (await scopeEntries(db, scope)).map((e) => e.key).filter((k) => k.startsWith(prefix));
    await dropEntries(scope, keys);
  } catch {
    /* best effort */
  }
}

async function prune(scope: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const entries = await scopeEntries(db, scope);
    const now = Date.now();
    const expired = entries.filter((e) => now - e.storedAt > MAX_AGE_MS).map((e) => e.key);
    const live = entries.filter((e) => now - e.storedAt <= MAX_AGE_MS).sort((a, b) => b.accessedAt - a.accessedAt);
    const overflow = live.slice(MAX_ENTRIES_PER_SCOPE).map((e) => e.key);
    const remove = [...expired, ...overflow];
    if (!remove.length) return;
    const tx = db.transaction(STORE, 'readwrite');
    for (const key of remove) tx.objectStore(STORE).delete(key);
    await done(tx);
  } catch {
    /* best effort */
  }
}

/** Clears one mailbox scope, or every scope whose key starts with `prefix` (e.g. `${userId}|`). */
export async function clearEmailCache(prefix: string | null): Promise<void> {
  epoch++;
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    if (prefix === null) {
      store.clear();
    } else {
      const all = ((await request(store.getAll())) as CacheEntry[] | undefined) ?? [];
      for (const entry of all) if (entry.scope.startsWith(prefix)) store.delete(entry.key);
    }
    await done(tx);
    broadcast({ type: 'cleared', scope: prefix });
  } catch {
    /* best effort */
  }
}

/**
 * Clears this workspace's mailbox copies on this device (disconnect, access
 * revoked, or a different mailbox connected), except `keepScope`.
 */
export async function clearWorkspaceEmailCache(workspaceId: string, keepScope: string | null = null): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const all = ((await request(store.getAll())) as CacheEntry[] | undefined) ?? [];
    const scopes = new Set<string>();
    for (const entry of all) {
      if (entry.scope.split('|')[1] === workspaceId && entry.scope !== keepScope) {
        store.delete(entry.key);
        scopes.add(entry.scope);
      }
    }
    await done(tx);
    if (scopes.size) epoch++;
    for (const scope of scopes) broadcast({ type: 'cleared', scope });
  } catch {
    /* best effort */
  }
}

// ─── Cross-tab single flight ───────────────────────────────────────────

/**
 * Runs `fetcher` at most once across all tabs for `key` at a time. After
 * taking the lock, a tab first re-checks IndexedDB: if another tab stored the
 * entry within `freshMs` (and, when given, at `expectVersion`), that is used
 * and no request is made.
 */
export async function coordinatedFetch<T>(
  scope: string,
  key: string,
  fetcher: () => Promise<{ value: T; version: string | null }>,
  opts: { freshMs: number; expectVersion?: string | null },
): Promise<T> {
  const attempt = async (): Promise<T> => {
    const cached = await readEntry<T>(key);
    if (cached) {
      // A version match means the content is unchanged, however old; without
      // a version to compare, only a recent copy counts.
      if (opts.expectVersion ? cached.version === opts.expectVersion : Date.now() - cached.storedAt < opts.freshMs) {
        return cached.value;
      }
    }
    const startedAt = cacheEpoch();
    const { value, version } = await fetcher();
    await writeEntry(scope, key, value, version, startedAt);
    return value;
  };
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) return attempt();
  let ran = false;
  try {
    return (await locks.request(`email:${key}`, () => {
      ran = true;
      return attempt();
    })) as T;
  } catch (err) {
    // A failed fetch is the caller's error; only a broken Locks API falls
    // back to an uncoordinated attempt (so a failure is never sent twice).
    if (ran) throw err;
    return attempt();
  }
}

/** Runs `fn` only in the one tab currently holding `name`; others skip. */
export async function asLeader(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks?.request) {
      await locks.request(`email-leader:${name}`, { ifAvailable: true }, async (lock) => {
        if (lock) await fn();
      });
      return;
    }
  } catch {
    /* fall through */
  }
  await fn();
}
