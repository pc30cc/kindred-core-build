/**
 * The primary's side of the shared rate limiters (the worker's side is
 * HubRateLimitStore in cluster/client.ts):
 * one express-rate-limit MemoryStore per limiter name, created on the first
 * message that names it, with that message's window. The counting is the
 * library's own, so a limiter counts across the container exactly as it
 * counts in one process.
 *
 * Answers are plain data for IPC: { totalHits, resetTime (ISO) }.
 */
import { MemoryStore, type Options } from 'express-rate-limit';

export interface SerializedHit {
  totalHits: number;
  resetTime: string | null;
}

/** More names than the backend has shared limiters means a bug, not traffic. */
const MAX_LIMITERS = 64;

function serialize(info: { totalHits: number; resetTime?: Date } | undefined): SerializedHit | null {
  if (!info) return null;
  return { totalHits: info.totalHits, resetTime: info.resetTime ? info.resetTime.toISOString() : null };
}

export class RateLimitHub {
  private readonly stores = new Map<string, MemoryStore>();

  private store(name: string, windowMs: number): MemoryStore | null {
    const existing = this.stores.get(name);
    if (existing) return existing;
    if (!name || !Number.isFinite(windowMs) || windowMs <= 0) return null;
    if (this.stores.size >= MAX_LIMITERS) return null;
    const store = new MemoryStore();
    store.init({ windowMs } as Options);
    this.stores.set(name, store);
    return store;
  }

  async increment(name: string, windowMs: number, key: string): Promise<SerializedHit> {
    const store = this.store(name, windowMs);
    if (!store) throw new Error('rate_limiter_unavailable');
    return serialize(await store.increment(key))!;
  }

  async decrement(name: string, windowMs: number, key: string): Promise<void> {
    await this.store(name, windowMs)?.decrement(key);
  }

  async resetKey(name: string, windowMs: number, key: string): Promise<void> {
    await this.store(name, windowMs)?.resetKey(key);
  }

  async get(name: string, windowMs: number, key: string): Promise<SerializedHit | null> {
    const store = this.store(name, windowMs);
    return store ? serialize(await store.get(key)) : null;
  }

  shutdown(): void {
    for (const store of this.stores.values()) store.shutdown();
    this.stores.clear();
  }
}
