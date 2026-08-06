import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleRegistry } from '../src/rules/registry.ts';
import { velocityCheckRule, headlossRule } from '../src/plumbing/rules.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { qty, mm, lps, meter } from '../src/units/index.ts';
import { approx } from './helpers.ts';

test('velocity check FAILS with a violation + populated trace (0.35 L/s in 13.3 mm)', () => {
  const reg = new RuleRegistry(GULF_V1).register(velocityCheckRule);
  const res = reg.evaluate('plumbing.supply.velocity', {
    flow: qty(0.35, lps),
    innerDiameter: qty(13.333, mm),
    medium: 'cold',
  });
  assert.equal(res.pass, false);
  assert.equal(res.severity, 'violation');
  // trace is the liability record — it must never be empty
  assert.ok(res.trace.formula.length > 0);
  assert.ok(Object.keys(res.trace.inputs).length > 0);
  assert.ok(res.trace.steps.length > 0);
  assert.ok(res.trace.clause.length > 0);
});

test('velocity check PASSES for an adequate pipe (0.35 L/s in 16.7 mm)', () => {
  const reg = new RuleRegistry(GULF_V1).register(velocityCheckRule);
  const res = reg.evaluate('plumbing.supply.velocity', {
    flow: qty(0.35, lps),
    innerDiameter: qty(16.667, mm),
    medium: 'cold',
  });
  assert.equal(res.pass, true);
  assert.equal(res.severity, undefined);
});

test('head loss rule uses the pack C=150 and matches the golden value', () => {
  const reg = new RuleRegistry(GULF_V1).register(headlossRule);
  const res = reg.evaluate('plumbing.supply.headloss', {
    flow: qty(1, lps),
    innerDiameter: qty(50, mm),
    length: qty(100, meter),
  });
  // value is a Quantity; read it back in metres
  const hf = (res.value as { in: (u: typeof meter) => number }).in(meter);
  approx(hf, 0.606, 0.01);
  assert.equal(res.trace.inputs.C, '150');
});

test('same rule + different jurisdiction constant = different result (data, not code)', () => {
  // Clone the Gulf pack but tighten the cold velocity limit → sizing/velocity behaviour shifts
  const strict = { ...GULF_V1, supply: { ...GULF_V1.supply, velocityLimitColdMps: 1.5 } };
  const relaxed = new RuleRegistry(GULF_V1).register(velocityCheckRule);
  const tight = new RuleRegistry(strict).register(velocityCheckRule);
  const input = { flow: qty(0.35, lps), innerDiameter: qty(16.667, mm), medium: 'cold' as const };
  assert.equal(relaxed.evaluate('plumbing.supply.velocity', input).pass, true); // 1.60 ≤ 2.0
  assert.equal(tight.evaluate('plumbing.supply.velocity', input).pass, false); // 1.60 > 1.5
});
