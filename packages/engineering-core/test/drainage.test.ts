import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleRegistry } from '../src/rules/registry.ts';
import { sizeDrainOd, minSlopePct, manningVelocity, sizeDrainRule, drainSlopeRule, drainVelocityRule, sizeVentOd, stackBranchRule, maxBranchIntervalDfu } from '../src/plumbing/drainage.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { mps } from '../src/units/index.ts';
import { approx } from './helpers.ts';

test('drain size from cumulative DFU (table lookup)', () => {
  assert.equal(sizeDrainOd(1, GULF_V1), 40);
  assert.equal(sizeDrainOd(2, GULF_V1), 50);
  assert.equal(sizeDrainOd(7, GULF_V1), 75); // WC 4 + Lav 1 + Shower 2
  assert.equal(sizeDrainOd(9, GULF_V1), 110);
});

test('minimum slope depends on size', () => {
  assert.equal(minSlopePct(50, GULF_V1), 2); // < 75 mm → 2%
  assert.equal(minSlopePct(110, GULF_V1), 1); // ≥ 75 mm → 1%
});

// GOLDEN — Manning full-bore: v = (1/0.011)·(0.0125)^(2/3)·(0.02)^(1/2) ≈ 0.692 m/s
test('Manning self-cleansing velocity: Ø50 mm at 2% ≈ 0.692 m/s', () => {
  approx(manningVelocity(50, 2, 0.011).in(mps), 0.692, 1e-3);
});

test('drain sizing rule selects Ø75 for 7 DFU with a trace', () => {
  const reg = new RuleRegistry(GULF_V1).register(sizeDrainRule);
  const res = reg.evaluate('plumbing.drain.size', { dfu: 7 });
  assert.equal(res.value, 75);
  assert.ok(res.trace.steps.length >= 3);
});

test('slope rule flags an under-graded small drain', () => {
  const reg = new RuleRegistry(GULF_V1).register(drainSlopeRule);
  assert.equal(reg.evaluate('plumbing.drain.slope', { odMm: 50, slopePct: 1 }).pass, false); // needs 2%
  assert.equal(reg.evaluate('plumbing.drain.slope', { odMm: 50, slopePct: 2 }).pass, true);
  assert.equal(reg.evaluate('plumbing.drain.slope', { odMm: 110, slopePct: 1 }).pass, true); // 1% ok for ≥75
});

test('vent sizing by cumulative DFU', () => {
  assert.equal(sizeVentOd(8, GULF_V1), 40);
  assert.equal(sizeVentOd(20, GULF_V1), 50);
  assert.equal(sizeVentOd(100, GULF_V1), 110);
});

test('velocity rule warns when below self-cleansing', () => {
  const reg = new RuleRegistry(GULF_V1).register(drainVelocityRule);
  assert.equal(reg.evaluate('plumbing.drain.velocity', { odMm: 50, slopePct: 2 }).pass, true); // 0.69 ≥ 0.6
  const slow = reg.evaluate('plumbing.drain.velocity', { odMm: 50, slopePct: 0.5 });
  assert.equal(slow.pass, false);
  assert.equal(slow.severity, 'warn');
});

// A vertical stack uses the stack DFU table (more capacity per size) than a horizontal drain.
test('stack sizing: 6 DFU is Ø75 horizontal but Ø50 as a stack', () => {
  assert.equal(sizeDrainOd(6, GULF_V1, false), 75); // horizontal branch/drain
  assert.equal(sizeDrainOd(6, GULF_V1, true), 50);  // vertical stack (higher capacity)
  const horiz = sizeDrainRule.evaluate({ dfu: 6 }, { jurisdiction: GULF_V1 });
  const stack = sizeDrainRule.evaluate({ dfu: 6, isStack: true }, { jurisdiction: GULF_V1 });
  assert.equal(horiz.value, 75);
  assert.equal(stack.value, 50);
  assert.equal(String(stack.trace.inputs.kind), 'vertical stack');
});

// Branch-interval limit: a stack size caps the DFU permitted at any single storey connection.
test('stack branch interval: per-interval DFU limited by stack size', () => {
  assert.equal(maxBranchIntervalDfu(75, GULF_V1), 20);
  assert.equal(stackBranchRule.evaluate({ odMm: 75, perIntervalDfu: 20 }, { jurisdiction: GULF_V1 }).pass, true);
  assert.equal(stackBranchRule.evaluate({ odMm: 75, perIntervalDfu: 21 }, { jurisdiction: GULF_V1 }).pass, false);
});
