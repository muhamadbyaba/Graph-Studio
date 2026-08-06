/**
 * Generic event-sourced history with undo/redo and an audit trail (Doc 02 §4).
 *
 * A cursor marks the active prefix of the event log; a new action after an undo truncates the redo
 * branch. `state()` folds the active events into a fresh model via the supplied fold function.
 *
 * Two properties matter for a server that folds on every request:
 *
 *   Memoised — `state()` folds once and caches until the log or the cursor changes. Reading the
 *   state N times costs one fold, so a request handler can pass the model around freely. If the
 *   fold function closes over external inputs (for example the active jurisdiction pack), call
 *   `invalidate()` when those change.
 *
 *   Transactional — an event whose fold throws is rolled back rather than left in the log. Without
 *   this a single malformed event (a pipe referencing a node that does not exist, say) would poison
 *   every subsequent fold and leave the document permanently unreadable.
 */
export class History<E, S> {
  private readonly foldFn: (events: readonly E[]) => S;
  private events: E[] = [];
  private cursor = 0;
  private cache: { value: S } | null = null;

  constructor(fold: (events: readonly E[]) => S) {
    this.foldFn = fold;
  }

  /** Append one event. Throws (leaving the log untouched) if the resulting state does not fold. */
  do(event: E): S {
    return this.commit(() => {
      if (this.cursor < this.events.length) this.events = this.events.slice(0, this.cursor);
      this.events.push(event);
      this.cursor = this.events.length;
    });
  }

  /**
   * Append several events as one transaction, folding once at the end. Each event is still its own
   * undo unit; if any of them makes the state unfoldable, none of them are kept.
   */
  doAll(events: readonly E[]): S {
    if (events.length === 0) return this.state();
    return this.commit(() => {
      if (this.cursor < this.events.length) this.events = this.events.slice(0, this.cursor);
      this.events.push(...events);
      this.cursor = this.events.length;
    });
  }

  undo(): S {
    if (this.cursor > 0) {
      this.cursor--;
      this.cache = null;
    }
    return this.state();
  }

  redo(): S {
    if (this.cursor < this.events.length) {
      this.cursor++;
      this.cache = null;
    }
    return this.state();
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.events.length;
  }

  /** The current model. Folded on first read after a change, then cached. */
  state(): S {
    if (this.cache === null) this.cache = { value: this.foldFn(this.events.slice(0, this.cursor)) };
    return this.cache.value;
  }

  /** The audit trail: every active event, in order. */
  log(): readonly E[] {
    return this.events.slice(0, this.cursor);
  }

  /** Replace the whole history, e.g. when opening a saved project. Rolls back if it does not fold. */
  replace(events: readonly E[]): S {
    return this.commit(() => {
      this.events = [...events];
      this.cursor = this.events.length;
    });
  }

  /**
   * Drop the memoised state. Needed only when something the fold function reads from outside the
   * event log has changed — switching the active jurisdiction pack, for instance.
   */
  invalidate(): void {
    this.cache = null;
  }

  /** Run a log mutation, fold it, and restore the previous log if the fold throws. */
  private commit(mutate: () => void): S {
    const events = [...this.events]; // a copy: `mutate` may push into the live array in place
    const cursor = this.cursor;
    const cache = this.cache;
    this.cache = null;
    try {
      mutate();
      return this.state();
    } catch (err) {
      this.events = events;
      this.cursor = cursor;
      this.cache = cache;
      throw err;
    }
  }
}
