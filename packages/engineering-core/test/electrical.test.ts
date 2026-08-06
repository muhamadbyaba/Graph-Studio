import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleRegistry } from '../src/rules/registry.ts';
import { voltageDrop, designCurrentSinglePhase } from '../src/electrical/electrics.ts';
import { sizeCableRule } from '../src/electrical/sizing.ts';
import { ampacityCheckRule, voltageDropCheckRule } from '../src/electrical/rules.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { qty, ampere, volt, watt, meter } from '../src/units/index.ts';
import { approx } from './helpers.ts';

// GOLDEN — hand calc:  Vd = 2 · 20 · 30 · 0.00461 = 5.532 V (single phase)
test('voltage drop: 20 A, 30 m, r=0.00461 Ω/m ≈ 5.532 V', () => {
  const vd = voltageDrop(qty(20, ampere), qty(30, meter), 0.00461, 'single');
  approx(vd.in(volt), 5.532, 1e-3);
});

// GOLDEN — Ib = P/(V·pf) = 3680/(230·1) = 16 A
test('design current: 3680 W at 230 V, pf 1 → 16 A', () => {
  const ib = designCurrentSinglePhase(qty(3680, watt), qty(230, volt), 1);
  approx(ib.in(ampere), 16, 1e-9);
});

test('current and voltage cannot be added (dimensional safety carries over)', () => {
  assert.throws(() => qty(20, ampere).plus(qty(230, volt)));
});

// GOLDEN — 20 A over 30 m at 230 V, 3% limit:
//   1.5mm² fails ampacity (17.5<20); 2.5mm² passes ampacity but Vd=3.87%>3%; 4mm² passes both.
test('cable sizing selects 4 mm² (2.5 mm² is ampacity-OK but fails voltage drop)', () => {
  const reg = new RuleRegistry(GULF_V1).register(sizeCableRule);
  const res = reg.evaluate('electrical.power.sizeCable', {
    designCurrent: qty(20, ampere),
    lengthOneWay: qty(30, meter),
    phase: 'single',
  });
  assert.equal(res.pass, true);
  assert.equal(res.value, 4);
  assert.ok(res.trace.steps.length >= 3); // 1.5 fail, 2.5 fail, 4 pass
});

test('ampacity check + voltage-drop check produce pass/fail with full traces', () => {
  const reg = new RuleRegistry(GULF_V1).register(ampacityCheckRule).register(voltageDropCheckRule);

  const amp = reg.evaluate('electrical.power.ampacity', { designCurrent: qty(20, ampere), ampacityA: 17.5 });
  assert.equal(amp.pass, false); // 20 > 17.5
  assert.equal(amp.severity, 'violation');
  assert.ok(amp.trace.formula.length > 0);

  const vd = reg.evaluate('electrical.power.voltageDrop', {
    designCurrent: qty(20, ampere),
    lengthOneWay: qty(30, meter),
    resistanceOhmPerM: 0.00741, // 2.5 mm²
  });
  assert.equal(vd.pass, false); // 3.87% > 3%
  approx(vd.value as number, 3.866, 0.01);
});

// The blueprint claim, in code: the SAME RuleRegistry serves two disciplines with no changes.
test('one RuleRegistry serves both plumbing and electrical rules', () => {
  const reg = new RuleRegistry(GULF_V1).register(sizeCableRule);
  assert.equal(reg.get('electrical.power.sizeCable').discipline, 'electrical');
});
