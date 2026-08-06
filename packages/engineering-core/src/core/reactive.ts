/**
 * Reactive propagation graph (Doc 02 §3.1) — the core primitive behind "every change updates
 * every connected system." It is a minimal, correct auto-tracking signal system:
 *
 *   - `Source<T>`  : a mutable input.
 *   - `Derived<T>` : a value computed from other signals; dependencies are discovered
 *                    automatically each time it recomputes (so dynamic graph structure works).
 *
 * Model: push the *staleness* eagerly on change (cheap mark phase), pull the *value* lazily on
 * read (recompute only what is actually observed). A `Derived` that nothing changed is never
 * recomputed — propagation stays incremental, never O(model). This is spreadsheet recalculation
 * for engineering objects.
 */

let currentObserver: Derived<unknown> | null = null;

export abstract class Signal<T> {
  /** Deriveds that read this signal during their last computation. */
  readonly observers = new Set<Derived<unknown>>();

  protected abstract read(): T;

  protected track(): void {
    if (currentObserver !== null) {
      this.observers.add(currentObserver);
      currentObserver.sources.add(this as Signal<unknown>);
    }
  }

  /** Read the current value, registering a dependency if read inside a Derived. */
  get(): T {
    this.track();
    return this.read();
  }
}

export class Source<T> extends Signal<T> {
  private current: T;

  constructor(initial: T) {
    super();
    this.current = initial;
  }

  protected read(): T {
    return this.current;
  }

  set(value: T): void {
    if (Object.is(value, this.current)) return; // no-op change: no propagation
    this.current = value;
    for (const o of this.observers) o.markStale();
  }

  update(fn: (v: T) => T): void {
    this.set(fn(this.current));
  }
}

export class Derived<T> extends Signal<T> {
  private compute: () => T;
  private cached: T | undefined = undefined;
  private stale = true;
  /** Signals read during the last computation (rebuilt each recompute → handles dynamic deps). */
  readonly sources = new Set<Signal<unknown>>();
  /** Number of times this cell actually recomputed — used by tests to prove incrementality. */
  computeCount = 0;

  constructor(compute: () => T) {
    super();
    this.compute = compute;
  }

  markStale(): void {
    if (this.stale) return; // already stale → its observers are already marked; stop (also breaks cycles)
    this.stale = true;
    for (const o of this.observers) o.markStale();
  }

  protected read(): T {
    if (this.stale) this.recompute();
    return this.cached as T;
  }

  private recompute(): void {
    // drop stale dependency edges, then rediscover them during compute()
    for (const s of this.sources) s.observers.delete(this);
    this.sources.clear();
    const prev = currentObserver;
    currentObserver = this as Derived<unknown>;
    try {
      this.cached = this.compute();
      this.computeCount++;
    } finally {
      currentObserver = prev;
    }
    this.stale = false;
  }
}

export function source<T>(initial: T): Source<T> {
  return new Source(initial);
}

export function derived<T>(compute: () => T): Derived<T> {
  return new Derived(compute);
}
