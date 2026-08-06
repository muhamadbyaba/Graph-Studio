import assert from 'node:assert/strict';

/** Assert two numbers are equal within an absolute tolerance (for floating-point results). */
export function approx(actual: number, expected: number, tol = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} ≈ ${expected} (±${tol}), diff ${Math.abs(actual - expected)}`,
  );
}
