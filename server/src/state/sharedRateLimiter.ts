/**
 * Redis-backed sliding-window limiter (SCALE-1).
 *
 * The bucket keys and budgets are exactly those of utils/rateLimiter.ts. The
 * sorted set is scored by attempt time and pruned atomically by the Lua script
 * in sharedStore, so two workers admit no more than one budget between them.
 */
import { getSharedStore, newRateMember, type SharedStore } from './sharedStore';
import type { RateLimitVerdict } from '../utils/rateLimiter';

export class SharedRateLimiter {
  private readonly store: SharedStore;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(store: SharedStore, options: { max: number; windowMs: number }, now: () => number = () => Date.now()) {
    this.store = store;
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.now = now;
  }

  attempt(key: string, member: string = newRateMember()): Promise<RateLimitVerdict> {
    return this.store.rateAttempt(key, this.now(), this.windowMs, this.max, member);
  }

  revoke(key: string, member?: string): Promise<void> {
    return this.store.rateRevoke(key, member);
  }

  snapshot(): Promise<Array<{ key: string; count: number; limit: number; retryAfterMs: number }>> {
    return this.store.rateList(this.now(), this.windowMs, this.max);
  }

  clearMatching(match: (key: string) => boolean): Promise<string[]> {
    return this.store.rateClear(match);
  }
}

export function getSharedRateLimiter(options: { max: number; windowMs: number }): SharedRateLimiter {
  return new SharedRateLimiter(getSharedStore(), options);
}
