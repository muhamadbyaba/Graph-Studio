import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { sizeColumnRule } from '../src/structural/columns.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

const eff = (L: PlumbingLayout, id: string) => L.nodes.get(id)!.effectiveAxialKn!.get();
const section = (L: PlumbingLayout, id: string) => L.nodes.get(id)!.columnSizing!.get().value;

test('a lone column carries no load until beams or an override are added', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('c', 'support', 0, 0);
  assert.equal(eff(L, 'c'), 0);
  assert.equal(section(L, 'c'), 250); // minimum section at zero load
});

test('axial load auto-sums the simply-supported reactions of framing beams (w·L/2)', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('c', 'support', 0, 0);
  L.addNode('e1', 'support', 6, 0); // 6 m span east
  L.addNode('e2', 'support', 0, 4); // 4 m span north
  L.addPipe('b1', 'c', 'e1', 'beam'); // default 15 kN/m → reaction 15·6/2 = 45
  L.addPipe('b2', 'c', 'e2', 'beam'); // default 15 kN/m → reaction 15·4/2 = 30
  assert.equal(eff(L, 'c'), 45 + 30); // 75 kN into the column
  // the column sizes to exactly what the rule gives for that load
  assert.equal(section(L, 'c'), sizeColumnRule.evaluate({ axialLoadKn: 75 }, { jurisdiction: GULF_V1 }).value);
});

test('changing a beam load or moving a node re-flows into the column reactively', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('c', 'support', 0, 0);
  L.addNode('e1', 'support', 6, 0);
  L.addPipe('b1', 'c', 'e1', 'beam'); // 15·6/2 = 45
  assert.equal(eff(L, 'c'), 45);
  L.setBeamLoad('b1', 200); // 200·6/2 = 600
  assert.equal(eff(L, 'c'), 600);
  L.moveNode('e1', 10, 0); // span now 10 m → 200·10/2 = 1000
  assert.equal(eff(L, 'c'), 1000);
});

test('an engineer override wins, and clearing it (null) returns to the auto sum', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('c', 'support', 0, 0);
  L.addNode('e1', 'support', 6, 0);
  L.addPipe('b1', 'c', 'e1', 'beam'); // auto 45
  L.setAxialLoad('c', 2000); // override
  assert.equal(eff(L, 'c'), 2000);
  assert.equal(section(L, 'c'), sizeColumnRule.evaluate({ axialLoadKn: 2000 }, { jurisdiction: GULF_V1 }).value);
  L.setAxialLoad('c', null); // back to auto
  assert.equal(eff(L, 'c'), 45);
});

test('a multi-storey column stacks N typical floors of load and grows accordingly', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('c', 'support', 0, 0);
  L.setAxialLoad('c', 500); // 500 kN per typical floor
  assert.equal(eff(L, 'c'), 500);
  assert.equal(section(L, 'c'), 250); // one floor → smallest section
  L.setFloorsSupported('c', 8); // ground column carrying 8 floors
  assert.equal(eff(L, 'c'), 4000); // 500 × 8
  assert.equal(section(L, 'c'), sizeColumnRule.evaluate({ axialLoadKn: 4000 }, { jurisdiction: GULF_V1 }).value); // 450
  L.setFloorsSupported('c', 1); // back to a single storey
  assert.equal(eff(L, 'c'), 500);
});

test('floorsSupported clamps to ≥ 1 and multiplies the auto beam reactions too', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('c', 'support', 0, 0);
  L.addNode('e', 'support', 6, 0);
  L.addPipe('b', 'c', 'e', 'beam'); // default 15 kN/m over 6 m → 45 kN reaction per floor
  assert.equal(eff(L, 'c'), 45);
  L.setFloorsSupported('c', 10);
  assert.equal(eff(L, 'c'), 450); // 45 × 10
  L.setFloorsSupported('c', 0); // invalid → clamps to 1
  assert.equal(L.nodes.get('c')!.floorsSupported!.get(), 1);
});

test('removing a beam drops its reaction from the column', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('c', 'support', 0, 0);
  L.addNode('e1', 'support', 6, 0);
  L.addPipe('b1', 'c', 'e1', 'beam'); // 45
  assert.equal(eff(L, 'c'), 45);
  L.removePipe('b1');
  assert.equal(eff(L, 'c'), 0);
});
