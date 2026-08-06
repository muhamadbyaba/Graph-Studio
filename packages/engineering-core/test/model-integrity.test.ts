import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { foldLayoutEvents } from '../src/events/layout-events.ts';
import { History } from '../src/events/generic-history.ts';
import type { LayoutEvent } from '../src/events/layout-events.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

/**
 * The model boundary rejects structurally invalid edits, and the history rolls back any edit that
 * cannot be folded. Together these guarantee that a document which has been accepted is always
 * readable — a malformed edit can never leave a project permanently unopenable.
 */

const base = (): PlumbingLayout => new PlumbingLayout(GULF_V1)
  .addNode('tank', 'source', 0, 0)
  .addNode('wc', 'fixture', 5, 0, 'WaterCloset');

test('a pipe referencing a node that does not exist is rejected at the boundary', () => {
  assert.throws(() => base().addPipe('p', 'tank', 'ghost', 'cold'), /unknown node 'ghost'/);
  assert.throws(() => base().addPipe('p', 'ghost', 'wc', 'cold'), /unknown node 'ghost'/);
});

test('a pipe cannot connect a node to itself', () => {
  assert.throws(() => base().addPipe('p', 'tank', 'tank', 'cold'), /cannot connect/);
});

test('duplicate ids are rejected rather than silently overwriting', () => {
  assert.throws(() => base().addNode('tank', 'junction', 1, 1), /already exists/);
  assert.throws(() => base().addPipe('p', 'tank', 'wc', 'cold').addPipe('p', 'tank', 'wc', 'hot'), /already exists/);
});

test('non-finite coordinates are refused (NaN would poison every derived value)', () => {
  assert.throws(() => base().addNode('n', 'junction', Number.NaN, 2), /finite number/);
  assert.throws(() => base().addNode('n', 'junction', 2, Number.POSITIVE_INFINITY), /finite number/);
  assert.throws(() => base().moveNode('wc', 1, Number.NaN), /finite number/);
  assert.throws(() => base().setElevation('wc', Number.NaN), /finite number/);
});

test('a slab must reference existing, distinct corner nodes', () => {
  assert.throws(() => base().addSlab('s', ['tank', 'wc', 'ghost']), /unknown node 'ghost'/);
  assert.throws(() => base().addSlab('s', ['tank', 'wc', 'tank']), /repeats a corner/);
  assert.throws(() => base().addSlab('s', ['tank', 'wc']), /at least 3 corner nodes/);
});

test('a rejected event is rolled back, leaving the document readable', () => {
  const history = new History<LayoutEvent, PlumbingLayout>((evts) => foldLayoutEvents(GULF_V1, evts));
  history.doAll([
    { type: 'NodeAdded', id: 'tank', kind: 'source', x: 0, y: 0 },
    { type: 'NodeAdded', id: 'wc', kind: 'fixture', x: 5, y: 0, fixtureType: 'WaterCloset' },
    { type: 'PipeAdded', id: 'p', from: 'tank', to: 'wc', medium: 'cold' },
  ]);
  const before = history.log().length;

  assert.throws(() => history.do({ type: 'PipeAdded', id: 'bad', from: 'tank', to: 'ghost', medium: 'cold' }));

  assert.equal(history.log().length, before, 'the rejected event must not stay in the log');
  assert.equal(history.state().pipes.size, 1, 'the model still folds after a rejected edit');
  assert.equal(history.state().pipes.get('p')!.sizing.get().value, 20);
});

test('a batch is all-or-nothing: one bad event discards the whole batch', () => {
  const history = new History<LayoutEvent, PlumbingLayout>((evts) => foldLayoutEvents(GULF_V1, evts));
  history.do({ type: 'NodeAdded', id: 'tank', kind: 'source', x: 0, y: 0 });

  assert.throws(() => history.doAll([
    { type: 'NodeAdded', id: 'a', kind: 'junction', x: 1, y: 1 },
    { type: 'PipeAdded', id: 'p', from: 'a', to: 'ghost', medium: 'cold' },
  ]));

  assert.equal(history.state().nodes.size, 1, 'the valid half of the batch is discarded too');
  assert.equal(history.log().length, 1);
});

test('replacing the history with an unfoldable log keeps the previous document', () => {
  const history = new History<LayoutEvent, PlumbingLayout>((evts) => foldLayoutEvents(GULF_V1, evts));
  history.do({ type: 'NodeAdded', id: 'tank', kind: 'source', x: 0, y: 0 });

  assert.throws(() => history.replace([{ type: 'PipeAdded', id: 'p', from: 'nope', to: 'nope2', medium: 'cold' }]));

  assert.equal(history.state().nodes.size, 1);
  assert.equal(history.log().length, 1);
});

test('state() folds once and is cached until the log changes', () => {
  let folds = 0;
  const history = new History<LayoutEvent, PlumbingLayout>((evts) => { folds++; return foldLayoutEvents(GULF_V1, evts); });
  history.do({ type: 'NodeAdded', id: 'tank', kind: 'source', x: 0, y: 0 });
  const after = folds;

  history.state(); history.state(); history.state();
  assert.equal(folds, after, 'repeated reads must not re-fold');

  history.do({ type: 'NodeAdded', id: 'j', kind: 'junction', x: 1, y: 1 });
  assert.equal(folds, after + 1, 'a mutation invalidates the cache exactly once');

  history.invalidate();
  history.state();
  assert.equal(folds, after + 2, 'invalidate() forces the next read to re-fold');
});

test('a batch of N events folds once, not N times', () => {
  let folds = 0;
  const history = new History<LayoutEvent, PlumbingLayout>((evts) => { folds++; return foldLayoutEvents(GULF_V1, evts); });
  const batch: LayoutEvent[] = Array.from({ length: 25 }, (_, i) => ({ type: 'NodeAdded', id: `n${i}`, kind: 'junction', x: i, y: 0 }));

  history.doAll(batch);

  assert.equal(folds, 1);
  assert.equal(history.state().nodes.size, 25);
});
