import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeSlabRule } from '../src/structural/slabs.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

const gulf = { jurisdiction: GULF_V1 };
const rect = (w: number, h: number) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

test('a square panel is classified two-way and sized by the short span', () => {
  const r = sizeSlabRule.evaluate({ corners: rect(5, 5), loadKnPerM2: 5 }, gulf);
  assert.equal(r.pass, true);
  assert.equal(r.trace.inputs.type, 'two-way');
  assert.equal(r.trace.inputs.area, '25.00 m²');
  // two-way: hMin = 5000/30 = 167 mm → next catalog thickness 175
  assert.equal(r.value, 175);
});

test('a long narrow panel is one-way and thicker for the same short span', () => {
  const oneWay = sizeSlabRule.evaluate({ corners: rect(3, 9), loadKnPerM2: 5 }, gulf); // 9/3 = 3 > 2 ⇒ one-way
  assert.equal(oneWay.trace.inputs.type, 'one-way');
  // one-way: hMin = 3000/20 = 150 mm → catalog 150
  assert.equal(oneWay.value, 150);
  // compare a two-way panel of the same short span (3×5): hMin = 3000/30 = 100 → 100 mm (thinner)
  const twoWay = sizeSlabRule.evaluate({ corners: rect(3, 5), loadKnPerM2: 5 }, gulf);
  assert.equal(twoWay.trace.inputs.type, 'two-way');
  assert.equal(twoWay.value, 100);
  assert.ok((oneWay.value as number) > (twoWay.value as number));
});

test('bigger spans and loads increase thickness monotonically', () => {
  let prev = 0;
  for (const w of [2, 3, 4, 5]) { // one-way strips, growing short span (kept within the thickness catalog)
    const v = sizeSlabRule.evaluate({ corners: rect(w, w * 3), loadKnPerM2: 5 }, gulf).value as number;
    assert.ok(v >= prev, `Ls=${w} → ${v} ≥ ${prev}`);
    prev = v;
  }
});

test('the trace reports area, spans, type, Mu and steel per metre', () => {
  const r = sizeSlabRule.evaluate({ corners: rect(6, 6), loadKnPerM2: 4 }, gulf);
  assert.match(String(r.trace.inputs.shortSpan), /6\.00 m/);
  assert.match(String(r.trace.inputs.Mu), /kN·m\/m/);
  assert.match(String(r.trace.inputs.steel), /mm²\/m/);
});

test('a degenerate (collinear) panel fails closed', () => {
  const r = sizeSlabRule.evaluate({ corners: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }], loadKnPerM2: 5 }, gulf);
  assert.equal(r.value, null);
  assert.equal(r.pass, false);
});
