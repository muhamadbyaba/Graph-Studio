import { test } from 'node:test';
import assert from 'node:assert/strict';
import { source, derived } from '../src/core/reactive.ts';

test('a derived reflects its source', () => {
  const a = source(1);
  const d = derived(() => a.get() + 10);
  assert.equal(d.get(), 11);
  a.set(5);
  assert.equal(d.get(), 15);
});

test('unrelated deriveds are NOT recomputed (incremental)', () => {
  const a = source(1);
  const b = source(100);
  const da = derived(() => a.get() + 1);
  const db = derived(() => b.get() + 1);
  assert.equal(da.get(), 2);
  assert.equal(db.get(), 101);
  assert.equal(da.computeCount, 1);
  assert.equal(db.computeCount, 1);

  a.set(5); // only affects da
  assert.equal(da.get(), 6);
  assert.equal(da.computeCount, 2);
  assert.equal(db.get(), 101);
  assert.equal(db.computeCount, 1); // db never recomputed — proof of incrementality
});

test('diamond dependency recomputes each node once and stays consistent (no glitch)', () => {
  const a = source(1);
  const b = derived(() => a.get() + 1);
  const c = derived(() => a.get() + 2);
  const d = derived(() => b.get() + c.get());
  assert.equal(d.get(), 1 + 1 + (1 + 2)); // 5
  assert.equal(d.computeCount, 1);

  a.set(10);
  assert.equal(d.get(), 10 + 1 + (10 + 2)); // 23
  assert.equal(b.computeCount, 2);
  assert.equal(c.computeCount, 2);
  assert.equal(d.computeCount, 2); // computed once for the change, not twice
});

test('dynamic dependencies: a branch not taken creates no dependency', () => {
  const flag = source(true);
  const x = source(10);
  const y = source(20);
  const d = derived(() => (flag.get() ? x.get() : y.get()));
  assert.equal(d.get(), 10);
  assert.equal(d.computeCount, 1);

  y.set(99); // d didn't read y → no recompute
  assert.equal(d.get(), 10);
  assert.equal(d.computeCount, 1);

  flag.set(false); // now d reads y instead of x
  assert.equal(d.get(), 99);
  assert.equal(d.computeCount, 2);

  x.set(50); // x is no longer a dependency → no recompute
  assert.equal(d.get(), 99);
  assert.equal(d.computeCount, 2);
});
