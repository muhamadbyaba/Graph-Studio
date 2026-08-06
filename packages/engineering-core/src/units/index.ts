import { Unit, dimension } from './quantity.ts';

export { Quantity, Unit, DimensionError, dimension, sameDimension, formatDimension, qty } from './quantity.ts';
export type { Dimension } from './quantity.ts';

// Length
export const meter = new Unit(1, dimension({ L: 1 }), 'm');
export const mm = new Unit(1e-3, dimension({ L: 1 }), 'mm');

// Time
export const second = new Unit(1, dimension({ T: 1 }), 's');

// Volumetric flow  (L³·T⁻¹)
export const m3s = new Unit(1, dimension({ L: 3, T: -1 }), 'm³/s');
export const lps = new Unit(1e-3, dimension({ L: 3, T: -1 }), 'L/s');

// Velocity  (L·T⁻¹)
export const mps = new Unit(1, dimension({ L: 1, T: -1 }), 'm/s');

// Pressure  (M·L⁻¹·T⁻²)
export const pascal = new Unit(1, dimension({ M: 1, L: -1, T: -2 }), 'Pa');
export const kPa = new Unit(1e3, dimension({ M: 1, L: -1, T: -2 }), 'kPa');
export const bar = new Unit(1e5, dimension({ M: 1, L: -1, T: -2 }), 'bar');

// Electrical
export const ampere = new Unit(1, dimension({ I: 1 }), 'A');
export const volt = new Unit(1, dimension({ M: 1, L: 2, T: -3, I: -1 }), 'V');
export const watt = new Unit(1, dimension({ M: 1, L: 2, T: -3 }), 'W');
export const mm2 = new Unit(1e-6, dimension({ L: 2 }), 'mm²');

// Dimensionless
export const one = new Unit(1, dimension({}), '');
