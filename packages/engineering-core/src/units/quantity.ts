/**
 * Dimensionally-safe physical quantities.
 *
 * Core rule of the platform: a physical value never travels as a bare float. It carries its
 * dimension, arithmetic is checked, and unit conversion is explicit. This one primitive removes
 * the entire class of metric/imperial and mm-vs-m errors that sink engineering software.
 */

/** SI base dimensions: Length, Mass, Time, electric current (I), temperature (K), amount (N), luminous (J). */
export interface Dimension {
  L: number; M: number; T: number; I: number; K: number; N: number; J: number;
}

export function dimension(p: Partial<Dimension> = {}): Dimension {
  return { L: p.L ?? 0, M: p.M ?? 0, T: p.T ?? 0, I: p.I ?? 0, K: p.K ?? 0, N: p.N ?? 0, J: p.J ?? 0 };
}

export function sameDimension(a: Dimension, b: Dimension): boolean {
  return a.L === b.L && a.M === b.M && a.T === b.T && a.I === b.I && a.K === b.K && a.N === b.N && a.J === b.J;
}

function addDim(a: Dimension, b: Dimension): Dimension {
  return { L: a.L + b.L, M: a.M + b.M, T: a.T + b.T, I: a.I + b.I, K: a.K + b.K, N: a.N + b.N, J: a.J + b.J };
}

function scaleDim(a: Dimension, n: number): Dimension {
  return { L: a.L * n, M: a.M * n, T: a.T * n, I: a.I * n, K: a.K * n, N: a.N * n, J: a.J * n };
}

export function formatDimension(d: Dimension): string {
  const keys: (keyof Dimension)[] = ['L', 'M', 'T', 'I', 'K', 'N', 'J'];
  const parts = keys.filter((k) => d[k] !== 0).map((k) => (d[k] === 1 ? String(k) : `${k}^${d[k]}`));
  return parts.length ? parts.join('·') : 'dimensionless';
}

export class DimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DimensionError';
  }
}

/** A unit is "1 of something": an SI scale factor + a dimension + a display symbol. */
export class Unit {
  readonly si: number;
  readonly dim: Dimension;
  readonly symbol: string;
  constructor(si: number, dim: Dimension, symbol: string) {
    this.si = si;
    this.dim = dim;
    this.symbol = symbol;
  }
}

/** A physical quantity stored canonically in SI base units, tagged with its dimension. */
export class Quantity {
  /** Magnitude in SI base units (e.g. metres, seconds, m³/s). */
  readonly si: number;
  readonly dim: Dimension;
  constructor(si: number, dim: Dimension) {
    this.si = si;
    this.dim = dim;
  }

  plus(o: Quantity): Quantity {
    assertSame(this, o, 'add');
    return new Quantity(this.si + o.si, this.dim);
  }
  minus(o: Quantity): Quantity {
    assertSame(this, o, 'subtract');
    return new Quantity(this.si - o.si, this.dim);
  }
  times(o: Quantity | number): Quantity {
    if (typeof o === 'number') return new Quantity(this.si * o, this.dim);
    return new Quantity(this.si * o.si, addDim(this.dim, o.dim));
  }
  over(o: Quantity | number): Quantity {
    if (typeof o === 'number') return new Quantity(this.si / o, this.dim);
    return new Quantity(this.si / o.si, addDim(this.dim, scaleDim(o.dim, -1)));
  }
  pow(n: number): Quantity {
    return new Quantity(Math.pow(this.si, n), scaleDim(this.dim, n));
  }

  lt(o: Quantity): boolean { assertSame(this, o, 'compare'); return this.si < o.si; }
  lte(o: Quantity): boolean { assertSame(this, o, 'compare'); return this.si <= o.si; }
  gt(o: Quantity): boolean { assertSame(this, o, 'compare'); return this.si > o.si; }
  gte(o: Quantity): boolean { assertSame(this, o, 'compare'); return this.si >= o.si; }

  /** Convert to a number expressed in `unit`. Throws if the dimension does not match. */
  in(unit: Unit): number {
    if (!sameDimension(this.dim, unit.dim)) {
      throw new DimensionError(
        `Cannot express ${formatDimension(this.dim)} in unit '${unit.symbol}' (${formatDimension(unit.dim)})`,
      );
    }
    return this.si / unit.si;
  }

  toString(unit?: Unit): string {
    if (unit) return `${this.in(unit)} ${unit.symbol}`;
    return `${this.si} [SI ${formatDimension(this.dim)}]`;
  }
}

function assertSame(a: Quantity, b: Quantity, op: string): void {
  if (!sameDimension(a.dim, b.dim)) {
    throw new DimensionError(`Cannot ${op} ${formatDimension(a.dim)} and ${formatDimension(b.dim)}`);
  }
}

/** Build a Quantity of `value` in `unit`, e.g. qty(25, mm). */
export function qty(value: number, unit: Unit): Quantity {
  return new Quantity(value * unit.si, unit.dim);
}
