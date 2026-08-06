import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qty, mm, meter, lps, m3s, DimensionError } from '../src/units/index.ts';
import { approx } from './helpers.ts';

test('mm and m convert losslessly both ways', () => {
  approx(qty(2500, mm).in(meter), 2.5);
  approx(qty(2.5, meter).in(mm), 2500);
});

test('adding quantities of the same dimension works', () => {
  const total = qty(1, meter).plus(qty(500, mm));
  approx(total.in(meter), 1.5);
});

test('adding incompatible dimensions throws (length + flow)', () => {
  assert.throws(() => qty(1, meter).plus(qty(1, lps)), DimensionError);
});

test('converting to an incompatible unit throws', () => {
  assert.throws(() => qty(1, meter).in(lps), DimensionError);
});

test('L/s and m³/s are the same dimension', () => {
  approx(qty(1, lps).in(m3s), 0.001);
});

test('multiplication combines dimensions (area from two lengths)', () => {
  const area = qty(2, meter).times(qty(3, meter));
  approx(area.si, 6); // 6 m² in SI
});
