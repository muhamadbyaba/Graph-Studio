import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumWsfu, hunterDemand } from '../src/plumbing/demand.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { lps } from '../src/units/index.ts';
import { approx } from './helpers.ts';

test('sumWsfu adds fixture units from the jurisdiction table', () => {
  // WC 2.2 + Lavatory 0.7 + Shower 1.4 = 4.3
  const total = sumWsfu(
    [
      { type: 'WaterCloset', count: 1 },
      { type: 'Lavatory', count: 1 },
      { type: 'Shower', count: 1 },
    ],
    GULF_V1,
  );
  approx(total, 4.3, 1e-9);
});

test('sumWsfu throws for an unknown fixture (no silent guessing)', () => {
  assert.throws(() => sumWsfu([{ type: 'Spaceship', count: 1 }], GULF_V1));
});

test('Hunter interpolation between anchors: 15 WSFU → 0.7 L/s', () => {
  // between (10, 0.5) and (20, 0.9): 0.5 + 0.5·(0.9−0.5) = 0.7
  approx(hunterDemand(15, GULF_V1).in(lps), 0.7, 1e-9);
});

test('Hunter demand is monotonic in WSFU', () => {
  assert.ok(hunterDemand(50, GULF_V1).in(lps) > hunterDemand(20, GULF_V1).in(lps));
});
