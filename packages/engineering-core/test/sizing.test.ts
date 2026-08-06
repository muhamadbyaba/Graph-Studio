import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleRegistry } from '../src/rules/registry.ts';
import { sizeSupplyPipeRule } from '../src/plumbing/sizing.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { qty, lps } from '../src/units/index.ts';

// 0.35 L/s cold: OD20 (id 13.3mm) → 2.51 m/s > 2.0 (fail); OD25 (id 16.7mm) → 1.60 m/s ≤ 2.0 (pass)
test('0.35 L/s cold selects OD25', () => {
  const reg = new RuleRegistry(GULF_V1).register(sizeSupplyPipeRule);
  const res = reg.evaluate('plumbing.supply.sizePipe', { flow: qty(0.35, lps), medium: 'cold' });
  assert.equal(res.pass, true);
  assert.equal(res.value, 25);
});

test('sizing trace shows the rejected smaller size then the accepted one', () => {
  const reg = new RuleRegistry(GULF_V1).register(sizeSupplyPipeRule);
  const res = reg.evaluate('plumbing.supply.sizePipe', { flow: qty(0.35, lps), medium: 'cold' });
  assert.ok(res.trace.steps.length >= 2);
  assert.match(res.trace.steps[0].result, />/); // first candidate exceeds the limit
  assert.match(res.trace.steps[res.trace.steps.length - 1].result, /≤/); // last one passes
  assert.ok(res.trace.assumptions.length > 0);
});

test('hot water (1.5 m/s limit) needs a larger pipe than cold for the same flow', () => {
  const reg = new RuleRegistry(GULF_V1).register(sizeSupplyPipeRule);
  const cold = reg.evaluate('plumbing.supply.sizePipe', { flow: qty(0.35, lps), medium: 'cold' }).value as number;
  const hot = reg.evaluate('plumbing.supply.sizePipe', { flow: qty(0.35, lps), medium: 'hot' }).value as number;
  assert.ok(hot >= cold);
});

test('unknown rule id throws a clear error', () => {
  const reg = new RuleRegistry(GULF_V1);
  assert.throws(() => reg.evaluate('plumbing.supply.doesNotExist', {}), /Rule not found/);
});
