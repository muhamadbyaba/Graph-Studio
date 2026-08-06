import { tooManyRequests } from './errors.ts';

/**
 * A fixed-window rate limiter, in memory.
 *
 * It exists to blunt credential stuffing against the sign-in route and to stop one client from
 * monopolising the expensive endpoints (the copilot, IFC section cuts). A single process holding
 * counters in a Map is the honest scope: behind more than one instance this needs to move to a
 * shared store, and that is called out in the deployment notes rather than pretended away.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly label: string;

  constructor(options: { limit: number; windowMs: number; label: string }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.label = options.label;
  }

  /** Records one hit for `key`; throws 429 once the window's allowance is spent. */
  check(key: string, now = Date.now()): void {
    this.sweep(now);
    const bucket = this.buckets.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    bucket.count++;
    if (bucket.count > this.limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw tooManyRequests(`Too many ${this.label} requests — try again in ${retryAfter}s`, retryAfter);
    }
  }

  /** Forget a key, e.g. after a successful sign-in so a typo does not cost the whole window. */
  clear(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now: number): void {
    if (this.buckets.size < 1024) return; // amortised: only walk the map when it has grown
    for (const [key, bucket] of this.buckets) if (now >= bucket.resetAt) this.buckets.delete(key);
  }
}
