import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectHistory } from '../src/events/history.ts';
import type { PlumbingEvent } from '../src/events/events.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

function buildVillaBranch(h: ProjectHistory): void {
  const events: PlumbingEvent[] = [
    { type: 'SourceSet', id: 'tank' },
    { type: 'PipeAdded', id: 'p1', medium: 'cold', lengthM: 6 },
    { type: 'FixtureAdded', id: 'wc', fixtureType: 'WaterCloset' },
    { type: 'FixtureAdded', id: 'lav', fixtureType: 'Lavatory' },
    { type: 'FixtureAdded', id: 'sh', fixtureType: 'Shower' },
    { type: 'Connected', a: 'tank', b: 'p1' },
    { type: 'Connected', a: 'p1', b: 'wc' },
    { type: 'Connected', a: 'p1', b: 'lav' },
    { type: 'Connected', a: 'p1', b: 'sh' },
  ];
  for (const e of events) h.do(e);
}

test('event-sourced build → edit → undo → redo round-trips pipe size', () => {
  const h = new ProjectHistory(GULF_V1);
  buildVillaBranch(h);
  assert.equal(h.state().pipes.get('p1')!.sizing.get().value, 20);

  h.do({ type: 'FixtureAdded', id: 'ks', fixtureType: 'KitchenSink' });
  const resized = h.do({ type: 'Connected', a: 'p1', b: 'ks' });
  assert.equal(resized.pipes.get('p1')!.sizing.get().value, 25); // auto-resized

  h.undo(); // undo the connect
  const undone = h.undo(); // undo the fixture add
  assert.equal(undone.pipes.get('p1')!.sizing.get().value, 20); // back to OD20
  assert.ok(!undone.boq.get().some((l) => l.itemCode === 'FIX-KitchenSink'));

  h.redo();
  const redone = h.redo();
  assert.equal(redone.pipes.get('p1')!.sizing.get().value, 25); // redone
});

test('the audit log records every applied event, in order', () => {
  const h = new ProjectHistory(GULF_V1);
  h.do({ type: 'SourceSet', id: 'tank' });
  h.do({ type: 'PipeAdded', id: 'p1', medium: 'cold', lengthM: 4 });
  assert.equal(h.log().length, 2);
  assert.equal(h.log()[0].type, 'SourceSet');
  assert.equal(h.log()[1].type, 'PipeAdded');
});

test('a new action after undo truncates the redo branch', () => {
  const h = new ProjectHistory(GULF_V1);
  h.do({ type: 'SourceSet', id: 'tank' });
  h.do({ type: 'PipeAdded', id: 'p1', medium: 'cold', lengthM: 4 });
  h.undo();
  assert.equal(h.canRedo, true);
  h.do({ type: 'PipeAdded', id: 'p2', medium: 'cold', lengthM: 4 });
  assert.equal(h.canRedo, false); // redo tail dropped
  assert.equal(h.log().length, 2);
  assert.ok(h.state().pipes.has('p2'));
  assert.ok(!h.state().pipes.has('p1'));
});

test('folding the same events twice yields the same result (determinism)', () => {
  const h1 = new ProjectHistory(GULF_V1);
  const h2 = new ProjectHistory(GULF_V1);
  buildVillaBranch(h1);
  buildVillaBranch(h2);
  assert.equal(
    h1.state().pipes.get('p1')!.cumulativeWsfu.get(),
    h2.state().pipes.get('p1')!.cumulativeWsfu.get(),
  );
});
