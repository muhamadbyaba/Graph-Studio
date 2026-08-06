import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeColumnRule } from '../src/structural/columns.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { US_V1 } from '../src/jurisdiction/us.ts';

const gulf = { jurisdiction: GULF_V1 };
const us = { jurisdiction: US_V1 };

test('a light load takes the smallest catalog column', () => {
  const r = sizeColumnRule.evaluate({ axialLoadKn: 500 }, gulf);
  assert.equal(r.pass, true);
  assert.equal(r.value, 250); // 250×250 carries 500 kN at minimum steel
});

test('a heavier load grows the column, staying within ρmax', () => {
  const r = sizeColumnRule.evaluate({ axialLoadKn: 4000 }, gulf);
  assert.equal(r.value, 450); // hand check: 400 needs ρ≈5.7% (>4%), 450 passes at ρ≈3.2%
  assert.equal(r.pass, true);
});

test('capacity is monotonic — more load never picks a smaller section', () => {
  let prev = 0;
  for (const Pu of [300, 800, 1500, 2500, 3500, 5000]) {
    const v = sizeColumnRule.evaluate({ axialLoadKn: Pu }, gulf).value as number;
    assert.ok(v >= prev, `Pu=${Pu} → ${v} should be ≥ ${prev}`);
    prev = v;
  }
});

test('jurisdiction is data: lower f′c (US 28 vs Gulf 30) upsizes at the margin', () => {
  // At Pu = 4300 kN a 450 column needs ρ≈3.89% under Gulf (f′c 30) — within 4% — but ρ>4% under
  // US (f′c 28), so the US design must step up to the next section. Same model, different code.
  assert.equal(sizeColumnRule.evaluate({ axialLoadKn: 4300 }, gulf).value, 450);
  assert.equal(sizeColumnRule.evaluate({ axialLoadKn: 4300 }, us).value, 500);
});

test('an impossibly large load exhausts the catalog and fails closed', () => {
  const r = sizeColumnRule.evaluate({ axialLoadKn: 50000 }, gulf);
  assert.equal(r.value, null);
  assert.equal(r.pass, false);
  assert.equal(r.severity, 'violation');
});

test('the trace carries the ACI formula, section, steel and utilisation', () => {
  const r = sizeColumnRule.evaluate({ axialLoadKn: 4000 }, gulf);
  assert.match(r.trace.formula, /φPn/);
  assert.equal(r.trace.inputs.section, '450×450 mm');
  assert.match(String(r.trace.inputs.reinforcement), /ρ=/);
  assert.match(String(r.trace.inputs.utilization), /%$/);
});
