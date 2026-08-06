import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDwv } from '../src/plumbing/dwv.ts';
import { PlumbingLayout } from '../src/model/layout.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

// A fully connected + vented system passes both checks and totals the DFU reaching the outlet.
test('dwv: connected + vented system passes; totals DFU', () => {
  const r = analyzeDwv({
    outletId: 'OUT', ventRootId: 'VENT',
    fixtures: [{ id: 'wc', type: 'WaterCloset', dfu: 4 }, { id: 'lav', type: 'Lavatory', dfu: 1 }],
    drainEdges: [{ id: 'd1', from: 'wc', to: 'OUT' }, { id: 'd2', from: 'lav', to: 'wc' }],
    ventEdges: [{ id: 'v1', from: 'wc', to: 'VENT' }, { id: 'v2', from: 'lav', to: 'wc' }],
  });
  assert.equal(r.active, true);
  assert.equal(r.allDrained, true);
  assert.equal(r.allVented, true);
  assert.equal(r.totalDfu, 5);
});

// An orphaned fixture (no drain path to the sewer) is caught and excluded from the DFU total.
test('dwv: orphaned drain is flagged and not counted', () => {
  const r = analyzeDwv({
    outletId: 'OUT', ventRootId: 'VENT',
    fixtures: [{ id: 'wc', type: 'WaterCloset', dfu: 4 }, { id: 'lav', type: 'Lavatory', dfu: 1 }],
    drainEdges: [{ id: 'd1', from: 'wc', to: 'OUT' }], // lav not connected
    ventEdges: [{ id: 'v1', from: 'wc', to: 'VENT' }, { id: 'v2', from: 'lav', to: 'VENT' }],
  });
  assert.equal(r.allDrained, false);
  assert.deepEqual([...r.unconnectedDrains], ['lav']);
  assert.equal(r.totalDfu, 4); // lav excluded
});

// A drained but unvented fixture is a code risk and is flagged.
test('dwv: unvented fixture is flagged', () => {
  const r = analyzeDwv({
    outletId: 'OUT', ventRootId: 'VENT',
    fixtures: [{ id: 'wc', type: 'WaterCloset', dfu: 4 }, { id: 'sh', type: 'Shower', dfu: 2 }],
    drainEdges: [{ id: 'd1', from: 'wc', to: 'OUT' }, { id: 'd2', from: 'sh', to: 'wc' }],
    ventEdges: [{ id: 'v1', from: 'wc', to: 'VENT' }], // shower unvented
  });
  assert.equal(r.allDrained, true);
  assert.equal(r.allVented, false);
  assert.deepEqual([...r.unventedFixtures], ['sh']);
});

// No vent system at all ⇒ hasVentSystem false and every fixture reads unvented.
test('dwv: no vent system flags all fixtures unvented', () => {
  const r = analyzeDwv({
    outletId: 'OUT', ventRootId: null,
    fixtures: [{ id: 'wc', type: 'WaterCloset', dfu: 4 }],
    drainEdges: [{ id: 'd1', from: 'wc', to: 'OUT' }],
    ventEdges: [],
  });
  assert.equal(r.hasVentSystem, false);
  assert.equal(r.allVented, false);
  assert.equal(r.unventedFixtures.length, 1);
});

test('dwv: no outlet ⇒ inactive', () => {
  const r = analyzeDwv({ outletId: null, ventRootId: null, fixtures: [{ id: 'wc', dfu: 4 }], drainEdges: [], ventEdges: [] });
  assert.equal(r.active, false);
});

// Integration through the reactive layout.
test('layout: dwv catches an orphaned fixture, clears once connected', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('OUT', 'outlet', 0, 0).addNode('WC', 'fixture', 5, 0, 'WaterCloset').addNode('LAV', 'fixture', 8, 0, 'Lavatory');
  L.addPipe('d1', 'WC', 'OUT', 'drainage');
  L.setOutlet('OUT');
  let d = L.dwv.get();
  assert.equal(d.active, true);
  assert.equal(d.allDrained, false); // LAV not connected yet
  assert.deepEqual([...d.unconnectedDrains], ['LAV']);

  L.addPipe('d2', 'LAV', 'WC', 'drainage');
  d = L.dwv.get();
  assert.equal(d.allDrained, true);
  assert.equal(d.totalDfu, (GULF_V1.drainage!.dfu.WaterCloset ?? 0) + (GULF_V1.drainage!.dfu.Lavatory ?? 0));
});
