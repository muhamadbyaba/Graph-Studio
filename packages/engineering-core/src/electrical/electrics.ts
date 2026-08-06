import { Quantity, dimension, sameDimension, formatDimension, DimensionError } from '../units/quantity.ts';

/**
 * Pure electrical formulas — the Electrical module's equivalent of plumbing/hydraulics.ts. Note
 * how little is new: the SAME Quantity/dimension machinery carries amps and volts, so a caller
 * can never confuse current with voltage. This is the blueprint reused (Doc 08 §6).
 */

const CURRENT_DIM = dimension({ I: 1 });
const LENGTH_DIM = dimension({ L: 1 });
const VOLT_DIM = dimension({ M: 1, L: 2, T: -3, I: -1 });
const POWER_DIM = dimension({ M: 1, L: 2, T: -3 });

function requireDim(q: Quantity, dim: ReturnType<typeof dimension>, name: string): void {
  if (!sameDimension(q.dim, dim)) {
    throw new DimensionError(`'${name}' must be ${formatDimension(dim)}, got ${formatDimension(q.dim)}`);
  }
}

export type Phase = 'single' | 'three';

/**
 * Voltage drop along a conductor:
 *   single-phase: Vd = 2 · I · L · r
 *   three-phase:  Vd = √3 · I · L · r
 * where r is resistance per unit length (Ω/m). Returns volts.
 */
export function voltageDrop(
  current: Quantity,
  lengthOneWay: Quantity,
  resistanceOhmPerM: number,
  phase: Phase = 'single',
): Quantity {
  requireDim(current, CURRENT_DIM, 'current');
  requireDim(lengthOneWay, LENGTH_DIM, 'lengthOneWay');
  const factor = phase === 'single' ? 2 : Math.sqrt(3);
  const vd = factor * current.si * lengthOneWay.si * resistanceOhmPerM;
  return new Quantity(vd, VOLT_DIM);
}

/** Design current for a single-phase load: Ib = P / (V · pf). Returns amps. */
export function designCurrentSinglePhase(power: Quantity, voltage: Quantity, powerFactor: number): Quantity {
  requireDim(power, POWER_DIM, 'power');
  requireDim(voltage, VOLT_DIM, 'voltage');
  return new Quantity(power.si / (voltage.si * powerFactor), CURRENT_DIM);
}
