import { test } from 'node:test';
import { velocity, hazenWilliamsHeadloss, pprInnerDiameter } from '../src/plumbing/hydraulics.ts';
import { qty, lps, mm, meter, mps } from '../src/units/index.ts';
import { approx } from './helpers.ts';

// GOLDEN — independent hand calculation:
//   v = 4Q/(π d²) = 4(0.001)/(π·0.05²) = 0.50930 m/s
test('velocity: 1 L/s in 50 mm ≈ 0.509 m/s', () => {
  const v = velocity(qty(1, lps), qty(50, mm));
  approx(v.in(mps), 0.5093, 1e-3);
});

// GOLDEN — hand calc:
//   hf = 10.67·100·(0.001^1.852) / (150^1.852 · 0.05^4.87) ≈ 0.606 m
test('Hazen–Williams: 1 L/s, 50 mm, C=150, 100 m ≈ 0.606 m', () => {
  const hf = hazenWilliamsHeadloss(qty(1, lps), qty(50, mm), 150, qty(100, meter));
  approx(hf.in(meter), 0.606, 0.01);
});

// GOLDEN — id = od − 2·(od/SDR) = 25 − 2·(25/6) = 16.667 mm
test('PPR PN20 SDR6 OD25 inner diameter ≈ 16.667 mm', () => {
  const id = pprInnerDiameter(qty(25, mm), 6);
  approx(id.in(mm), 16.667, 1e-3);
});

// head loss must scale super-linearly with flow (Q^1.852) — doubling flow > doubles loss
test('head loss grows faster than linearly with flow', () => {
  const hf1 = hazenWilliamsHeadloss(qty(1, lps), qty(50, mm), 150, qty(100, meter)).in(meter);
  const hf2 = hazenWilliamsHeadloss(qty(2, lps), qty(50, mm), 150, qty(100, meter)).in(meter);
  approx(hf2 / hf1, Math.pow(2, 1.852), 1e-6);
});
