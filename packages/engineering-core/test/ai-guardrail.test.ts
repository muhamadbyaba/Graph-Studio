import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMepToolBus } from '../src/ai/mep-tools.ts';
import { guardNumericClaims } from '../src/ai/guardrail.ts';
import { extractNumbers } from '../src/ai/toolbus.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

test('a tool call produces the engineering numbers (not the AI)', () => {
  const bus = buildMepToolBus(GULF_V1);
  const res = bus.call<{ demandLps: number; medium: 'cold' }, { value: unknown }>('plumbing.sizePipe', {
    demandLps: 0.285,
    medium: 'cold',
  });
  assert.equal(res.value, 25); // OD25, computed by the rules engine
});

test('an answer whose numbers ALL come from tools passes the guardrail', () => {
  const bus = buildMepToolBus(GULF_V1);
  bus.call('plumbing.sizePipe', { demandLps: 0.285, medium: 'cold' });
  const grounded = bus.groundedNumbers();

  const answer = 'Recommend PPR OD25 PN20; velocity 1.306 m/s is within the 2 m/s limit.';
  const guard = guardNumericClaims(answer, grounded);
  assert.equal(guard.ok, true);
  assert.equal(guard.ungrounded.length, 0);
});

test('a HALLUCINATED number is caught and the answer fails closed', () => {
  const bus = buildMepToolBus(GULF_V1);
  bus.call('plumbing.sizePipe', { demandLps: 0.285, medium: 'cold' });
  const grounded = bus.groundedNumbers();

  // The tools never produced OD32 / PN16 — the AI invented them.
  const answer = 'Recommend PPR OD32 PN16 for extra safety margin.';
  const guard = guardNumericClaims(answer, grounded);
  assert.equal(guard.ok, false);
  assert.ok(guard.ungrounded.includes(32));
  assert.ok(guard.ungrounded.includes(16));
});

test('the guardrail spans disciplines on one bus (plumbing + electrical)', () => {
  const bus = buildMepToolBus(GULF_V1);
  bus.call('electrical.sizeCable', { currentA: 20, lengthM: 30 });
  const grounded = bus.groundedNumbers();

  assert.equal(guardNumericClaims('Use a 4 mm² cable.', grounded).ok, true); // 4 is grounded
  assert.equal(guardNumericClaims('Use a 70 mm² cable.', grounded).ok, false); // 70 invented
});

test('extractNumbers pulls numeric claims out of prose (integers and decimals)', () => {
  const nums = extractNumbers('OD25 PN20 at 1.306 m/s and 0.285 L/s');
  assert.deepEqual(nums, [25, 20, 1.306, 0.285]);
});
