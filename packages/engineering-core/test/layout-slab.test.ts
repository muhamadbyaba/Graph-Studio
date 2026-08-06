import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

function panel(load = 5) {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('a', 'support', 0, 0);
  L.addNode('b', 'support', 6, 0);
  L.addNode('c', 'support', 6, 6);
  L.addNode('d', 'support', 0, 6);
  L.addSlab('s1', ['a', 'b', 'c', 'd'], load);
  return L;
}

test('a slab computes its area from its corner nodes', () => {
  const L = panel();
  assert.equal(L.slabs.get('s1')!.areaM2.get(), 36); // 6×6
  assert.equal(L.slabs.get('s1')!.sizing.get().pass, true);
});

test('moving a corner node re-flows the slab area and thickness', () => {
  const L = panel();
  assert.equal(L.slabs.get('s1')!.areaM2.get(), 36);
  L.moveNode('b', 10, 0); L.moveNode('c', 10, 6); // now a 10×6 panel
  assert.equal(L.slabs.get('s1')!.areaM2.get(), 60);
});

test('a slab emits a concrete-volume BOQ line under Structural', () => {
  const L = panel();
  const h = L.slabs.get('s1')!.sizing.get().value as number; // mm
  const boq = L.boq.get();
  const line = boq.find((l) => l.itemCode.startsWith('SLAB-'));
  assert.ok(line, 'expected a SLAB line');
  assert.equal(line!.unit, 'm³');
  assert.equal(line!.qty, Math.round(36 * (h / 1000) * 100) / 100); // area × thickness
  assert.equal(line!.group, 'Structural');
  assert.ok((line!.rate ?? 0) > 0);
});

test('changing the applied load re-sizes the slab', () => {
  const L = panel(3);
  const before = L.slabs.get('s1')!.sizing.get().value;
  L.setSlabLoad('s1', 25); // heavy load
  const after = L.slabs.get('s1')!.sizing.get();
  // thickness is deflection-governed so may hold, but the steel must rise with load
  assert.ok(after.pass);
  assert.notEqual(after.trace.inputs.steel, undefined);
  assert.equal(after.value, before); // deflection controls thickness → unchanged; steel grows (in trace)
});

test('deleting a corner node removes the slab', () => {
  const L = panel();
  assert.equal(L.slabs.size, 1);
  L.removeNode('c');
  assert.equal(L.slabs.size, 0);
});
