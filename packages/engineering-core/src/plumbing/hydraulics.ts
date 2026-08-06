import { Quantity, dimension, sameDimension, formatDimension, DimensionError } from '../units/quantity.ts';

/**
 * Pure hydraulic formulas. Exact — no [VERIFY] here (constants that vary by code live in the
 * jurisdiction pack). Inputs are dimension-checked; outputs are Quantities, so a caller can never
 * mistake m/s for L/s.
 */

const FLOW_DIM = dimension({ L: 3, T: -1 });
const LENGTH_DIM = dimension({ L: 1 });
const VELOCITY_DIM = dimension({ L: 1, T: -1 });

function requireDim(q: Quantity, dim: ReturnType<typeof dimension>, name: string): void {
  if (!sameDimension(q.dim, dim)) {
    throw new DimensionError(`'${name}' must be ${formatDimension(dim)}, got ${formatDimension(q.dim)}`);
  }
}

/** Full-bore velocity: v = 4Q / (π·d²). */
export function velocity(flow: Quantity, innerDiameter: Quantity): Quantity {
  requireDim(flow, FLOW_DIM, 'flow');
  requireDim(innerDiameter, LENGTH_DIM, 'innerDiameter');
  const Q = flow.si;
  const d = innerDiameter.si;
  return new Quantity((4 * Q) / (Math.PI * d * d), VELOCITY_DIM);
}

/**
 * Hazen–Williams head loss (SI form):
 *   hf = 10.67 · L · Q^1.852 / (C^1.852 · d^4.87)
 * hf [m], L [m], Q [m³/s], d [m], C dimensionless.
 */
export function hazenWilliamsHeadloss(
  flow: Quantity,
  innerDiameter: Quantity,
  hazenWilliamsC: number,
  length: Quantity,
): Quantity {
  requireDim(flow, FLOW_DIM, 'flow');
  requireDim(innerDiameter, LENGTH_DIM, 'innerDiameter');
  requireDim(length, LENGTH_DIM, 'length');
  const Q = flow.si;
  const d = innerDiameter.si;
  const L = length.si;
  const hf = (10.67 * L * Math.pow(Q, 1.852)) / (Math.pow(hazenWilliamsC, 1.852) * Math.pow(d, 4.87));
  return new Quantity(hf, LENGTH_DIM);
}

/** PPR inner diameter from outer diameter and SDR:  id = od − 2·(od/SDR). */
export function pprInnerDiameter(outerDiameter: Quantity, sdr: number): Quantity {
  requireDim(outerDiameter, LENGTH_DIM, 'outerDiameter');
  const od = outerDiameter.si;
  const wall = od / sdr;
  return new Quantity(od - 2 * wall, LENGTH_DIM);
}
